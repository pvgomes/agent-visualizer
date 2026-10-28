// Tests for src/remote/vercel.ts against a fake Vercel API: the token from the env, from an OIDC
// JWT (its team/project), or from the sandbox CLI's auth.json (expired -> a hint, never a
// refresh); team discovery (default team first, every team, the CLI's default project, a
// project that doesn't exist in a team); running-only listing with session ids; exec through
// POST /v2/sandboxes/sessions/{sid}/cmd as an ndjson stream, run with sh here. Ends with a whole
// ingest loop over a "sandbox".
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeHome, load, runIn, serve, tmp } from "./remote.fakes.mjs";
import { POSIX } from "./platform.mjs";

const M = await load("src/remote/vercel.ts", "src/ingest/index.ts");

/** sandboxes: [{team, project, name, status, session, home}] */
async function fakeVercel(sandboxes, { teams = ["team_a", "team_b"], defaultTeam = "team_b" } = {}) {
  return serve(async (req, body, url) => {
    if (req.headers.authorization !== "Bearer vtok") return { status: 403, json: { error: { code: "forbidden", message: "Not authorized" } } };
    if (url.pathname === "/api/v2/user") return { json: { user: { id: "user_1", username: "me", defaultTeamId: defaultTeam } } };
    if (url.pathname === "/api/v2/teams") return { json: { teams: teams.map((id) => ({ id, slug: id })), pagination: { count: teams.length, next: null } } };
    if (url.pathname === "/api/v2/sandboxes" && req.method === "GET") {
      const team = url.searchParams.get("teamId");
      const project = url.searchParams.get("project");
      if (!project) return { status: 400, json: { error: { code: "bad_request", message: "missing required property `project`" } } };
      const rows = sandboxes.filter((s) => s.team === team && s.project === project);
      if (!rows.length && !sandboxes.some((s) => s.project === project)) return { status: 404, json: { error: { code: "not_found", message: "Project not found" } } };
      return { json: { sandboxes: rows.map((s) => ({ name: s.name, status: s.status, currentSessionId: s.session, persistent: true })), pagination: { count: rows.length, next: null } } };
    }
    const cmd = url.pathname.match(/^\/api\/v2\/sandboxes\/sessions\/([^/]+)\/cmd$/);
    if (cmd && req.method === "POST") {
      const s = sandboxes.find((x) => x.session === cmd[1] && x.status === "running");
      if (!s) return { status: 410, json: { error: { code: "sandbox_stopped", message: "Session is stopped" } } };
      const r = await runIn(s.home, body.command, body.args);
      const c = { id: "cmd_1", name: body.command, args: body.args, cwd: "/vercel", sessionId: s.session, startedAt: 1 };
      const lines = [{ command: { ...c, exitCode: null } }];
      // Output arrives as several log frames, stderr interleaved.
      for (let i = 0; i < r.stdout.length; i += 1000) lines.push({ stream: "stdout", data: r.stdout.slice(i, i + 1000) });
      if (r.stderr) lines.push({ stream: "stderr", data: r.stderr });
      lines.push({ command: { ...c, exitCode: r.code, durationMs: 5 } });
      return { type: "application/x-ndjson", text: lines.map((l) => JSON.stringify(l)).join("\n") + "\n" };
    }
    return { status: 404, json: { error: { code: "not_found", message: "no route" } } };
  });
}

const DEF = "vercel-sandbox-default-project";

test("with VERCEL_TOKEN: every team, default project, running sandboxes only, default team first", async () => {
  const sbx = [
    { team: "team_a", project: DEF, name: "agent-visualizer-test", status: "running", session: "sbx_s1", home: tmp() },
    { team: "team_a", project: DEF, name: "old-one", status: "stopped", session: "sbx_s0", home: tmp() },
    { team: "team_b", project: DEF, name: "preview-bot", status: "running", session: "sbx_s2", home: tmp() },
  ];
  const srv = await fakeVercel(sbx);
  const p = M.createVercelProvider({ env: { HOME: tmp(), VERCEL_TOKEN: "vtok", AGENT_VISUALIZER_VERCEL_API: `${srv.url}/api` }, cwd: tmp() });
  assert.deepEqual(p.available(), { ok: true, via: "VERCEL_TOKEN" });
  const found = await p.list();
  assert.deepEqual(found.map((d) => d.host), [
    { kind: "vercel", id: "vercel:preview-bot", name: "preview-bot" },
    { kind: "vercel", id: "vercel:agent-visualizer-test", name: "agent-visualizer-test" },
  ]);
  const lists = srv.requests.filter((r) => r.path === "/api/v2/sandboxes");
  assert.deepEqual(lists.map((r) => [r.query.teamId, r.query.project]), [["team_b", DEF], ["team_a", DEF]]);
  assert.equal(p.keepsAwake, false, "a Vercel Sandbox stops at its own timeout");
  await srv.close();
});

test("auto-detection (scope auto) stays in the default team: a teammate's sandbox elsewhere is never listed or exec'd", async () => {
  const sbx = [
    { team: "team_mine", project: DEF, name: "my-box", status: "running", session: "sbx_m", home: tmp() },
    { team: "team_coworkers", project: DEF, name: "alice-private-sbx", status: "running", session: "s_alice", home: tmp() },
  ];
  const srv = await fakeVercel(sbx, { teams: ["team_mine", "team_coworkers"], defaultTeam: "team_mine" });
  const p = M.createVercelProvider({ env: { HOME: tmp(), VERCEL_TOKEN: "vtok", AGENT_VISUALIZER_VERCEL_API: `${srv.url}/api` }, cwd: tmp() });
  assert.deepEqual((await p.list("auto")).map((d) => d.host.name), ["my-box"]);
  assert.ok(!srv.requests.some((r) => r.query.teamId === "team_coworkers" || r.path === "/api/v2/teams"), "the other team is never asked");
  // `--vercel all` widens it on purpose.
  assert.deepEqual((await p.list("all")).map((d) => d.host.name).sort(), ["alice-private-sbx", "my-box"]);
  assert.match(p.autoScope, /default team/);
  await srv.close();
});

test("exec streams stdout from the ndjson frames, ignores stderr, rejects exits and stopped sessions", { skip: POSIX }, async () => {
  const home = tmp();
  const sbx = [{ team: "team_a", project: DEF, name: "box", status: "running", session: "sbx_s1", home }];
  const srv = await fakeVercel(sbx);
  const [d] = await M.createVercelProvider({ env: { HOME: tmp(), VERCEL_TOKEN: "vtok", VERCEL_TEAM_ID: "team_a", AGENT_VISUALIZER_VERCEL_API: `${srv.url}/api` }, cwd: tmp() }).list();
  const big = "x".repeat(5000);
  assert.equal(await d.target.exec(`printf '%s\\n' "$HOME"; echo warn >&2; printf '${big}'\nexit 0\n`), `${home}\n${big}`);
  const call = srv.requests.find((r) => r.path.endsWith("/cmd"));
  assert.equal(call.query.teamId, "team_a");
  assert.equal(call.body.command, "sh");
  assert.equal(call.body.args[0], "-c");
  assert.equal(call.body.wait, true);
  await assert.rejects(d.target.exec("exit 4\n"), (e) => e.code === "failed" && /exit 4/.test(e.message));
  sbx[0].status = "stopped";
  await assert.rejects(d.target.exec("exit 0\n"), (e) => e.code === "gone");
  await srv.close();
});

test("parseCommandStream: stream errors and early ends are errors", () => {
  assert.throws(() => M.parseCommandStream('{"command":{"exitCode":null}}\n{"stream":"error","data":{"code":"oops","message":"boom"}}\n', "x"), /oops boom/);
  assert.throws(() => M.parseCommandStream('{"command":{"exitCode":null}}\n{"stream":"stdout","data":"half"}\n', "x"), (e) => e.code === "unreachable");
  assert.equal(M.parseCommandStream('{"command":{"exitCode":null}}\n{"stream":"stdout","data":"a"}\n{"stream":"stdout","data":"b"}\n{"command":{"exitCode":0}}\n', "x"), "ab");
});

test("the sandbox CLI's stored login, an expired one, and an OIDC token's own scope", async () => {
  const sbx = [{ team: "team_x", project: "prj_1", name: "ci-box", status: "running", session: "sbx_9", home: tmp() }];
  const srv = await fakeVercel(sbx, { teams: ["team_x"], defaultTeam: "team_x" });
  const authDir = tmp();
  const base = { HOME: tmp(), VERCEL_AUTH_CONFIG_DIR: authDir, AGENT_VISUALIZER_VERCEL_API: `${srv.url}/api`, VERCEL_PROJECT_ID: "prj_1" };
  writeFileSync(join(authDir, "auth.json"), JSON.stringify({ token: "vtok", expiresAt: Math.floor(Date.now() / 1000) + 3600, refreshToken: "r" }));
  const p = M.createVercelProvider({ env: base, cwd: tmp() });
  assert.equal(p.available().via, "sandbox CLI login");
  assert.deepEqual((await p.list()).map((d) => d.host.name), ["ci-box"]);

  writeFileSync(join(authDir, "auth.json"), JSON.stringify({ token: "vtok", expiresAt: Math.floor(Date.now() / 1000) - 10, refreshToken: "r" }));
  const expired = M.createVercelProvider({ env: base, cwd: tmp() });
  assert.match(expired.available().why, /login expired.*npx sandbox@latest list/);
  await assert.rejects(expired.list(), (e) => e.code === "auth");

  // An OIDC token names its team and project; no team discovery calls.
  const claims = Buffer.from(JSON.stringify({ owner_id: "team_x", project_id: "prj_1" })).toString("base64url");
  const n = srv.requests.length;
  const oidc = M.createVercelProvider({ env: { HOME: tmp(), VERCEL_OIDC_TOKEN: `h.${claims}.s`, AGENT_VISUALIZER_VERCEL_API: `${srv.url}/api` }, cwd: tmp() });
  await assert.rejects(oidc.list(), (e) => e.code === "auth", "the fake only takes vtok");
  assert.deepEqual(srv.requests.slice(n).map((r) => [r.path, r.query.teamId, r.query.project]), [["/api/v2/sandboxes", "team_x", "prj_1"]]);

  // The default XDG location on Linux.
  const home = tmp();
  mkdirSync(join(home, ".local", "share", "com.vercel.cli"), { recursive: true });
  writeFileSync(join(home, ".local", "share", "com.vercel.cli", "auth.json"), JSON.stringify({ token: "vtok" }));
  assert.equal(M.vercelLogin({ env: { HOME: home }, platform: "linux" }).via, "sandbox CLI login");
  assert.equal(M.vercelLogin({ env: { HOME: tmp() }, platform: "linux" }).code, "missing");
  await srv.close();
});

test("names that collide across projects get the project in their id; a linked project is searched", async () => {
  const cwd = tmp();
  mkdirSync(join(cwd, ".vercel"));
  writeFileSync(join(cwd, ".vercel", "project.json"), JSON.stringify({ orgId: "team_a", projectId: "prj_web" }));
  const sbx = [
    { team: "team_a", project: DEF, name: "dev", status: "running", session: "s1", home: tmp() },
    { team: "team_a", project: "prj_web", name: "dev", status: "running", session: "s2", home: tmp() },
  ];
  const srv = await fakeVercel(sbx, { teams: ["team_a"], defaultTeam: "team_a" });
  const found = await M.createVercelProvider({ env: { HOME: tmp(), VERCEL_TOKEN: "vtok", AGENT_VISUALIZER_VERCEL_API: `${srv.url}/api` }, cwd }).list();
  assert.deepEqual(found.map((d) => d.host.id).sort(), ["vercel:prj_web/dev", `vercel:${DEF}/dev`]);
  await srv.close();
});

test("a whole ingest loop over a Vercel Sandbox", async () => {
  const sbx = [{ team: "team_a", project: DEF, name: "agent-visualizer-test", status: "running", session: "sbx_s1", home: fakeHome() }];
  const srv = await fakeVercel(sbx, { teams: ["team_a"], defaultTeam: "team_a" });
  const targets = await M.createVercelTargets("agent-visualizer-test", { env: { HOME: tmp(), VERCEL_TOKEN: "vtok", AGENT_VISUALIZER_VERCEL_API: `${srv.url}/api` }, cwd: tmp() });
  assert.equal(targets.length, 1);
  const events = [];
  const ing = M.createIngest({ agents: ["claude", "codex"], local: false, remotes: targets, onEvent: (e) => events.push(e), watch: false });
  await ing.tick();
  ing.stop();
  assert.ok(events.length >= 3);
  assert.ok(events.every((e) => e.host.kind === "vercel" && e.workerId.startsWith("vercel:agent-visualizer-test/")));
  await srv.close();
});
