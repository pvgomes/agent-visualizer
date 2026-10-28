// Tests for src/control/cloud/railway.ts (through createPlaces) against a fake Railway GraphQL API,
// a fake exec bridge WebSocket and a fake `railway` CLI. A "sandbox" is a scratch HOME. Covers
// where a new sandbox goes (config.json, or a note naming the key), the create mutation and the
// local record (Railway has no labels), status from that record (a destroyed one is dropped), the
// env file over the bridge (the key in init_exec.env, never in the command), the terminal through
// `railway sandbox ssh` under a local PTY, chat over the bridge with no file at all, the CLI-only
// fallback when the stored login has expired, and delete. Keys are dummies.
import nodeTest, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { load, tmp, until, writeBin } from "./remote.fakes.mjs";
import { AGENT_SCRIPT, collect, fakeContext, fakePty, wsServe } from "./control.cloud.fakes.mjs";
import { CONTROL, skipAll } from "./platform.mjs";

const test = skipAll(nodeTest, CONTROL);

const M = await load("src/control/cloud/index.ts", "src/control/fs.ts");

const KEY = "sk-ant-dummy-railway-0004";
const made = [];
const ptys = [];
const servers = [];
after(async () => {
  for (const p of ptys) p.killAll();
  for (const s of servers) await s.close();
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

let n = 0;
const APP = { id: "p1", name: "app", envs: [["e1", "production"], ["e2", "staging"]] };
/** projects: [{id, name, envs: [[id, name]]}], one workspace; the CLI's `list --json` prints them and refreshes the stored login. */
async function fakeRailway({ projects = [APP] } = {}) {
  const bin = tmp();
  writeBin(bin, "claude", AGENT_SCRIPT);
  made.push(bin);
  const homesFile = join(bin, "homes.json");
  const boxes = [];
  const save = () => writeFileSync(homesFile, JSON.stringify(Object.fromEntries(boxes.map((b) => [b.id, b.home]))));
  const seen = { creates: [], tokens: [], inits: [], destroys: [], queries: [] };
  const srv = await wsServe({
    reject: (req) => (!String(req.headers["sec-websocket-protocol"]).includes("jwt-dummy") ? 401 : 0),
    protocol: (offered) => (offered.includes("railway-shell") ? "railway-shell" : undefined),
    async http(req, body) {
      if (req.headers.authorization !== "Bearer rtok") return { json: { errors: [{ message: "Not Authorized" }] } };
      const q = body?.query ?? "";
      const v = body?.variables ?? {};
      seen.queries.push(q.slice(0, 40));
      if (q.includes("me { workspaces")) return { json: { data: { me: { workspaces: [{ id: "w1", name: "Kira" }] } } } };
      if (q.includes("projects(workspaceId")) {
        const edges = projects.map((p) => ({ node: { id: p.id, name: p.name, environments: { edges: p.envs.map(([id, name]) => ({ node: { id, name } })) } } }));
        return { json: { data: { projects: { edges, pageInfo: { hasNextPage: false } } } } };
      }
      if (q.includes("sandboxes(environmentId")) return { json: { data: {} } };
      if (q.includes("sandboxCreate")) {
        seen.creates.push(v.input);
        const b = { id: `sbx-${++n}-0000-4000-8000-000000000000`, env: v.input.environmentId, status: "CREATING", home: tmp(), polls: 0 };
        made.push(b.home);
        boxes.push(b);
        save();
        return { json: { data: { sandboxCreate: { id: b.id, status: b.status, environmentId: b.env, createdAt: "2026-10-18T00:00:00.000Z", idleTimeoutMinutes: v.input.idleTimeoutMinutes } } } };
      }
      if (q.includes("sandbox(environmentId")) {
        const b = boxes.find((x) => x.id === v.id && x.env === v.e);
        if (!b) return { json: { data: { sandbox: null } } };
        if (b.status === "CREATING" && ++b.polls >= 1) b.status = "RUNNING";
        return { json: { data: { sandbox: { id: b.id, status: b.status, createdAt: "2026-10-18T00:00:00.000Z" } } } };
      }
      if (q.includes("generateShellToken")) {
        seen.tokens.push(v.input);
        return { json: { data: { generateShellToken: "jwt-dummy" } } };
      }
      if (q.includes("sandboxDestroy")) {
        seen.destroys.push(v);
        const b = boxes.find((x) => x.id === v.id);
        if (b) boxes.splice(boxes.indexOf(b), 1);
        return { json: { data: { sandboxDestroy: { id: v.id, status: "DESTROYING" } } } };
      }
      return { json: { errors: [{ message: `unknown query ${q.slice(0, 30)}` }] } };
    },
    ws(conn) {
      let child;
      conn.onMessage((msg) => {
        if (msg.op === 2) {
          if (msg.data[0] === 2) child?.stdin.write(msg.data.subarray(1));
          return;
        }
        const j = JSON.parse(msg.data);
        if (j.type === "init_exec") {
          seen.inits.push(j.data);
          const b = boxes[boxes.length - 1];
          child = spawn("sh", ["-c", j.data.command], { cwd: b.home, env: { PATH: `${bin}:${process.env.PATH}`, HOME: b.home, ...(j.data.env ?? {}) } });
          child.stdout.on("data", (d) => conn.binary(Buffer.concat([Buffer.from([1]), d])));
          child.stderr.on("data", (d) => conn.binary(Buffer.concat([Buffer.from([3]), d])));
          child.on("exit", (code) => {
            conn.text(JSON.stringify({ type: "exit", data: { exit_code: code ?? 137 } }));
            setTimeout(() => conn.close(1000), 10);
          });
        } else if (j.type === "stdin_close") child?.stdin.end();
        else if (j.type === "signal") child?.kill(`SIG${j.data.signal}`);
      });
    },
  });
  servers.push(srv);
  const cliDir = tmp();
  made.push(cliDir);
  const cli = writeBin(cliDir, "railway", `const fs = require("fs"); const { spawn } = require("child_process");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(cliDir, "argv.log"))}, JSON.stringify({ a, token: !!process.env.RAILWAY_API_TOKEN }) + "\\n");
if (a[0] === "list" && a[1] === "--json") {
  // As the real CLI does: an expired login is refreshed on the way.
  const cfg = process.env.HOME + "/.railway/config.json";
  if (fs.existsSync(cfg) && !process.env.FAKE_NO_REFRESH) {
    const j = JSON.parse(fs.readFileSync(cfg, "utf8"));
    j.user = { ...j.user, accessToken: "rtok", tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600 };
    fs.writeFileSync(cfg, JSON.stringify(j));
  }
  const ps = ${JSON.stringify(projects)};
  process.stdout.write(JSON.stringify([...ps.map((p) => ({ id: p.id, name: p.name, deletedAt: null, workspace: { name: "Kira" }, environments: { edges: p.envs.map(([id, name]) => ({ node: { id, name, canAccess: true } })) } })),
    { id: "p-gone", name: "old", deletedAt: "2026-01-01T00:00:00Z", workspace: { name: "Kira" }, environments: { edges: [{ node: { id: "e-gone", name: "production", canAccess: true } }] } }]));
  process.exit(0);
}
if (a[0] !== "sandbox" || (a[1] !== "ssh" && a[1] !== "exec")) process.exit(2);
const id = a[a.indexOf("--id") + 1]; const home = JSON.parse(fs.readFileSync(${JSON.stringify(homesFile)}, "utf8"))[id];
const rest = a.slice(a.indexOf("--") + 1);
// ssh: one word, the remote shell line; exec: an argv.
const argv = a[1] === "ssh" ? ["sh", "-c", rest[0]] : rest;
const c = spawn(argv[0], argv.slice(1), { stdio: "inherit", cwd: home, env: { PATH: ${JSON.stringify(bin)} + ":" + process.env.PATH, HOME: home } });
c.on("exit", (code) => process.exit(code ?? 1));`);
  const cliLog = () => (existsSync(join(cliDir, "argv.log")) ? readFileSync(join(cliDir, "argv.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  return { srv, seen, boxes, cli, cliLog, save };
}

function places(r, { config = true, token = true, home = tmp(), env: extra = {} } = {}) {
  made.push(home);
  if (config) writeFileSync(join(home, "config.json"), JSON.stringify({ remotes: [], control: { railway: config === true ? { project: "p1", environment: "e1" } : config } }));
  const pty = fakePty();
  ptys.push(pty);
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    AGENT_VISUALIZER_HOME: home,
    RAILWAY_GRAPHQL_ENDPOINT: `${r.srv.url}/graphql`,
    RAILWAY_TCP_PROXY_WS_ENDPOINT: `${r.srv.wsUrl}/ws/exec`,
    ...(token ? { RAILWAY_API_TOKEN: "rtok" } : {}),
    ...extra,
  };
  const ctx = fakeContext({ home, pty, env });
  return { ctx, pty, home, env, places: M.createPlaces(ctx, { pollMs: 10, bins: { railway: r.cli } }) };
}

const WEB = { id: "p2", name: "web", envs: [["e3", "production"]] };
const railwayRow = async (p) => (await p.status({ fresh: true })).find((x) => x.kind === "railway");
const hire = (p, sandbox = {}) => p.open({ kind: "railway", target: "new" }, { agent: "claude", sandbox, progress: () => {} });

test("several projects, no link, nothing to go by: the page gets them all, a hire without a pick is a plain 409, a pick is remembered", async () => {
  const r = await fakeRailway({ projects: [APP, WEB] });
  const { places: p, home } = places(r, { config: false });
  writeFileSync(join(home, "control-state.json"), JSON.stringify({ v: 1, recentFolders: ["/tmp/x"] }));
  const row = await railwayRow(p);
  assert.equal(row.canCreate, true, "the hire form lets you pick");
  assert.equal(row.dest, undefined, "no guessing between two projects");
  assert.deepEqual(row.projects, [
    { id: "p1", name: "app", environments: [{ id: "e1", name: "production" }, { id: "e2", name: "staging" }] },
    { id: "p2", name: "web", environments: [{ id: "e3", name: "production" }] },
  ]);
  await assert.rejects(hire(p), (e) => e.status === 409 && /^Pick the Railway project for the new sandbox: your account has 2 \(app, web\)$/.test(e.message));
  assert.equal(r.seen.creates.length, 0);

  const place = await hire(p, { project: "p2", environment: "e3" });
  assert.deepEqual(r.seen.creates.map((c) => c.environmentId), ["e3"]);
  assert.deepEqual(JSON.parse(readFileSync(join(home, "sandboxes.json"), "utf8")).sandboxes.map((x) => [x.environmentId, x.projectId]), [["e3", "p2"]]);
  const st = JSON.parse(readFileSync(join(home, "control-state.json"), "utf8"));
  assert.deepEqual(st.railway, { projectId: "p2", environmentId: "e3" });
  assert.deepEqual(st.recentFolders, ["/tmp/x"], "the rest of the file is kept");
  // A hire on this Mac adds a recent folder and keeps the pick.
  new M.HiredFolders(home).add("/tmp/y");
  assert.deepEqual(JSON.parse(readFileSync(join(home, "control-state.json"), "utf8")), { v: 1, recentFolders: ["/tmp/y", "/tmp/x"], railway: { projectId: "p2", environmentId: "e3" } });
  await p.deleteSandbox("railway", place.host.id.slice("railway:".length));
  // Next time it starts there.
  assert.deepEqual((await railwayRow(p)).dest, { project: "p2", environment: "e3", why: "last used" });
  await hire(p);
  assert.deepEqual(r.seen.creates.map((c) => c.environmentId), ["e3", "e3"]);
});

test("names become ids: config.json and the hire may name a project and an environment, Railway and the CLI only ever get ids", async () => {
  const r = await fakeRailway({ projects: [APP, WEB] });
  const { places: p, pty } = places(r, { config: { project: "web", environment: "production" } });
  assert.deepEqual((await railwayRow(p)).dest, { project: "p2", environment: "e3", why: "config.json" });
  const place = await hire(p, { project: "app", environment: "Staging" });
  assert.deepEqual(r.seen.creates.map((c) => c.environmentId), ["e2"]);
  await place.ensureAgent("claude", () => {});
  const term = await place.attach({ argv: ["claude"], cwd: place.cwd, env: {}, secret: [] }, { cols: 80, rows: 24 });
  const out = collect(term);
  await until(() => out.text().includes("\n"), 5000, "agent output");
  term.write("quit\n");
  await out.done;
  assert.deepEqual(pty.spawns[0].args.slice(4, 8), ["-p", "p1", "-e", "e2"], "ids on the CLI's command line, never names");

  await assert.rejects(hire(p, { project: "nope" }), (e) => e.status === 409 && /No project "nope" in your Railway account \(it has app, web\)/.test(e.message));
  await assert.rejects(hire(p, { project: "app", environment: "qa" }), (e) => e.status === 409 && /project "app" has no environment "qa" \(it has production, staging\)/.test(e.message));
  // A config.json entry that matches nothing is said, not used.
  const bad = places(r, { config: { project: "agent-visualizer-test", environment: "production" } });
  const row = await railwayRow(bad.places);
  assert.equal(row.dest, undefined);
  assert.match(row.note, /config\.json's control\.railway doesn't match: No project "agent-visualizer-test"/);
});

test("a railway link to a project that's gone is skipped, never passed on; a live link is the default", async () => {
  const r = await fakeRailway({ projects: [WEB] });
  const home = tmp();
  mkdirSync(join(home, ".railway"), { recursive: true });
  writeFileSync(join(home, ".railway/config.json"), JSON.stringify({ projects: { [process.cwd()]: { project: "p-deleted", environment: "e-deleted" } } }));
  const { places: p } = places(r, { config: false, home });
  assert.deepEqual((await railwayRow(p)).dest, { project: "p2", environment: "e3", why: "your only project" });
  await hire(p);
  assert.deepEqual(r.seen.creates.map((c) => c.environmentId), ["e3"], 'not the linked e-deleted ("Project not found")');

  const r2 = await fakeRailway({ projects: [APP, WEB] });
  const home2 = tmp();
  mkdirSync(join(home2, ".railway"), { recursive: true });
  writeFileSync(join(home2, ".railway/config.json"), JSON.stringify({ projects: { [process.cwd()]: { project: "p1", environment: "e2" } } }));
  const { places: p2 } = places(r2, { config: false, home: home2 });
  assert.deepEqual((await railwayRow(p2)).dest, { project: "p1", environment: "e2", why: "linked to the office's folder" });
});

test("no projects at all: nothing can be created, and the note says what to do", async () => {
  const r = await fakeRailway({ projects: [] });
  const { places: p } = places(r, { config: false });
  const row = await railwayRow(p);
  assert.equal(row.ready, true);
  assert.equal(row.canCreate, false);
  assert.deepEqual(row.projects, []);
  assert.match(row.note, /^Your Railway account has no project to put a sandbox in\. Create an empty one \(railway\.com\/new, or `railway init` in any folder\), then hire again$/);
  await assert.rejects(hire(p), (e) => e.status === 409 && /has no project to put a sandbox in/.test(e.message));
});

test("an expired CLI login: one `railway list --json` refreshes it, and the hire goes on over the API", async () => {
  const r = await fakeRailway({ projects: [APP, WEB] });
  const home = tmp();
  mkdirSync(join(home, ".railway"), { recursive: true });
  writeFileSync(join(home, ".railway/config.json"), JSON.stringify({ projects: {}, user: { accessToken: "stale", tokenExpiresAt: 1 } }));
  const { places: p } = places(r, { config: false, token: false, home });
  const row = await railwayRow(p);
  assert.equal(row.via, "railway CLI login");
  assert.equal(row.canCreate, true);
  assert.deepEqual(row.projects.map((x) => x.id), ["p1", "p2"], "a deleted project in the CLI's list is left out");
  assert.deepEqual(r.cliLog().map((c) => c.a), [["list", "--json"]]);
  await hire(p, { project: "p1" });
  assert.deepEqual(r.seen.creates.map((c) => c.environmentId), ["e1"], "production, when the pick names no environment");
});

test("create, record, open a terminal through the railway CLI: the key went over the bridge's env, not the command", async () => {
  const r = await fakeRailway();
  const { places: p, pty, home } = places(r);
  const place = await p.open({ kind: "railway", target: "new" }, { agent: "claude", sandbox: { timeoutMin: 500 }, progress: () => {} });
  assert.deepEqual(r.seen.creates[0], { environmentId: "e1", idleTimeoutMinutes: 120, networkIsolation: "ISOLATED" });
  const id = r.boxes[0].id;
  assert.equal(place.host.id, `railway:${id}`);
  assert.equal(place.ours, true);
  const reg = JSON.parse(readFileSync(join(home, "sandboxes.json"), "utf8")).sandboxes;
  assert.deepEqual(reg.map((x) => [x.provider, x.id, x.environmentId, x.projectId]), [["railway", id, "e1", "p1"]]);
  assert.match(reg[0].name, /^agent-visualizer-/);

  await place.ensureAgent("claude", () => {});
  const term = await place.attach({ argv: ["claude", { env: "AO_PROMPT" }], cwd: place.cwd, env: { ANTHROPIC_API_KEY: KEY, AO_PROMPT: "go" }, secret: ["ANTHROPIC_API_KEY"] }, { cols: 80, rows: 24 });
  const out = collect(term);
  await until(() => out.text().includes("\n"), 5000, "agent output");
  const hello = JSON.parse(out.text().split("\n")[0]);
  assert.equal(hello.keys.ANTHROPIC_API_KEY, KEY);
  assert.deepEqual(hello.argv, ["go"]);
  assert.deepEqual(hello.files.filter((f) => f.endsWith(".env")), []);
  term.write("quit\n");
  assert.equal((await out.done).code, 3);

  const spawn0 = pty.spawns[0];
  assert.equal(spawn0.file, r.cli);
  assert.deepEqual(spawn0.args.slice(0, 8), ["sandbox", "ssh", "--id", id, "-p", "p1", "-e", "e1"]);
  assert.equal(spawn0.args[8], "--");
  assert.match(spawn0.args[9], /^sh -c ' /);
  assert.ok(!JSON.stringify(spawn0.args).includes(KEY) && !JSON.stringify(spawn0.args).includes('"go"'));
  const envInit = r.seen.inits.find((i) => i.env?.AO_ENV);
  assert.ok(envInit.env.AO_ENV.includes(KEY), "the env file came from that command's own env");
  assert.ok(r.seen.inits.every((i) => !i.command.includes(KEY)), "never in a bridge command");
  assert.ok(r.seen.inits.every((i) => i.ephemeral === true), "ephemeral: no durable session keeps the output");
  assert.deepEqual(r.seen.tokens[0], { environmentId: "e1", instanceId: id, kind: "sandbox", scope: "shell" });
  assert.equal(r.srv.requests.find((x) => x.method === "UPGRADE").headers["sec-websocket-protocol"], "railway-shell, jwt-dummy");

  const row = (await p.status({ fresh: true })).find((x) => x.kind === "railway");
  assert.equal(row.canCreate, true);
  assert.deepEqual(row.sandboxes.map((s) => [s.id, s.ours, s.status]), [[id, true, "running"]]);
});

test("chat over the bridge: the keys are the command's env (no file), stdin and stdout frames, exit", async () => {
  const r = await fakeRailway();
  const { places: p } = places(r);
  const place = await p.open({ kind: "railway", target: "new" }, { agent: "codex", progress: () => {} });
  writeBin(join(r.boxes[0].home, "bin"), "codex", AGENT_SCRIPT);
  const pipe = await place.pipe({ argv: ["codex", "app-server"], cwd: place.cwd, env: { OPENAI_API_KEY: "sk-dummy-openai-rw" }, secret: ["OPENAI_API_KEY"], path: ["~/bin"] });
  const chunks = [];
  pipe.onStdout((c) => chunks.push(Buffer.from(c).toString()));
  await until(() => chunks.join("").includes("\n"), 5000, "first line");
  const hello = JSON.parse(chunks.join("").split("\n")[0]);
  assert.equal(hello.keys.OPENAI_API_KEY, "sk-dummy-openai-rw");
  assert.deepEqual(hello.argv.slice(0, 2), ["-c", "model_provider=agent-visualizer"]);
  assert.deepEqual(hello.files, [], "no env file at all");
  pipe.write("ping\n");
  await until(() => chunks.join("").includes("got:ping"), 5000, "echo");
  const exited = new Promise((res) => pipe.onExit(res));
  pipe.end();
  assert.equal((await exited).code, 0);
  const init = r.seen.inits[r.seen.inits.length - 1];
  assert.equal(init.env.OPENAI_API_KEY, "sk-dummy-openai-rw");
  assert.ok(!init.command.includes("sk-dummy-openai-rw"));
});

test("with only the CLI (the stored login expired), the env file goes over `railway sandbox ssh` stdin", async () => {
  const r = await fakeRailway();
  const first = places(r);
  const place0 = await first.places.open({ kind: "railway", target: "new" }, { agent: "claude", progress: () => {} });
  const id = place0.host.id.slice("railway:".length);
  // Same office home (the record), no API token, an expired CLI login.
  const home = first.home;
  mkdirSync(join(home, ".railway"), { recursive: true });
  writeFileSync(join(home, ".railway/config.json"), JSON.stringify({ user: { accessToken: "old", tokenExpiresAt: 1 } }));
  const second = places(r, { token: false, home, env: { FAKE_NO_REFRESH: "1" } });
  const row = (await second.places.status()).find((x) => x.kind === "railway");
  assert.equal(row.ready, true);
  assert.equal(row.via, "railway CLI");
  const place = await second.places.open({ kind: "railway", target: id }, { agent: "claude", progress: () => {} });
  assert.equal(place.ours, true, "from the record");
  const term = await place.attach({ argv: ["claude"], cwd: place.cwd, env: { ANTHROPIC_API_KEY: KEY }, secret: ["ANTHROPIC_API_KEY"] }, { cols: 80, rows: 24 });
  const out = collect(term);
  await until(() => out.text().includes("\n"), 5000, "agent output");
  assert.equal(JSON.parse(out.text().split("\n")[0]).keys.ANTHROPIC_API_KEY, KEY);
  const calls = r.cliLog();
  assert.ok(calls.every((c) => !JSON.stringify(c.a).includes(KEY)), "no key on the CLI's argv");
  assert.match(calls.find((c) => c.a.at(-1).includes("cat >")).a.at(-1), /^sh -c 'umask 077;/);
  term.write("quit\n");
  await out.done;
  assert.deepEqual(readdirSync(join(r.boxes[0].home, ".agent-visualizer/run")).filter((f) => f.endsWith(".env")), []);
});

test("status drops a recorded sandbox Railway no longer has; delete destroys only the office's own", async () => {
  const r = await fakeRailway();
  const { places: p, home } = places(r);
  const a = await p.open({ kind: "railway", target: "new" }, { agent: "claude", progress: () => {} });
  const b = await p.open({ kind: "railway", target: "new" }, { agent: "claude", progress: () => {} });
  r.boxes.splice(0, 1); // a was destroyed by its idle timeout
  const row = (await p.status({ fresh: true })).find((x) => x.kind === "railway");
  assert.deepEqual(row.sandboxes.map((s) => s.id), [b.host.id.slice(8)]);
  assert.deepEqual(JSON.parse(readFileSync(join(home, "sandboxes.json"), "utf8")).sandboxes.map((s) => s.id), [b.host.id.slice(8)]);
  await p.deleteSandbox("railway", b.host.id.slice(8));
  assert.deepEqual(r.seen.destroys, [{ id: b.host.id.slice(8), e: "e1" }]);
  await assert.rejects(p.deleteSandbox("railway", "someone-elses"), (e) => e.status === 409);
  assert.ok(a);
});

test("a RAILWAY_API_TOKEN replaced while the office runs is the one used from then on", async () => {
  const r = await fakeRailway({ projects: [APP] });
  const { places: p, env } = places(r, { env: { RAILWAY_API_TOKEN: "revoked" } });
  const before = await railwayRow(p);
  assert.equal(before.ready, false, "the revoked token is refused");
  assert.match(before.note, /Not Authorized/);
  // Settings, Keys: the new token replaces the old one (keys.platformEnv() is part of providerEnv())
  env.RAILWAY_API_TOKEN = "rtok";
  const after = await railwayRow(p);
  assert.equal(after.ready, true, after.note);
  assert.equal(after.canCreate, true);
  assert.deepEqual(after.projects.map((x) => x.id), ["p1"]);
  await hire(p);
  assert.deepEqual(r.seen.creates.map((c) => c.environmentId), ["e1"]);
});
