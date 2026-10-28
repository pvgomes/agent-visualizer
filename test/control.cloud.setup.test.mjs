// "Bring my setup" through each platform's own transport (src/control/cloud/{daytona,vercel,railway,ssh}.ts
// and cloud/setup.ts), against fakes: Daytona's toolbox (execute with per-command envs, upload-v2),
// Vercel's API (cmd with env, the fs/write tar.gz extracted at "/"), Railway's exec bridge (env and a
// tar on stdin) and a fake `ssh` (the archive on stdin). A "sandbox" is a scratch HOME on this machine.
// Every platform: the files land 0600 under its HOME, ~/.claude.json carries the servers and the key's
// approval, the project is in the working folder, and no secret is in any command, argv or script.
import nodeTest, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { load, tmp, writeBin } from "./remote.fakes.mjs";
import { fakeContext, fakePty, wsServe } from "./control.cloud.fakes.mjs";
import { CONTROL, skipAll } from "./platform.mjs";

const test = skipAll(nodeTest, CONTROL);

const M = await load("src/control/cloud/index.ts", "src/control/setup.ts");

const SECRET = "mcp-env-secret-cloud-0101";
const HEADER = "Bearer header-secret-cloud-0202";
const KEY = "sk-ant-api03-dummy-cloud-setup-key-000000-ABCDEFGHIJKLMNOPQRST";
const made = [];
const servers = [];
const ptys = [];
after(async () => {
  for (const p of ptys) p.killAll();
  for (const s of servers) await s.close();
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const mk = () => {
  const d = tmp();
  made.push(d);
  return d;
};
const mode = (p) => statSync(p).mode & 0o777;

/** What a hire would take along from a small fake HOME. */
async function bundle() {
  const home = mk();
  const project = join(home, "Codes", "shop");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { docs: { type: "http", url: "https://example.com/mcp", headers: { Authorization: HEADER } }, tool: { command: "npx", args: ["-y", "@acme/tool"], env: { TOOL_TOKEN: SECRET } } } }));
  writeFileSync(join(home, ".claude", "CLAUDE.md"), "be brief\n");
  writeFileSync(join(project, "src", "app.js"), "1\n");
  writeFileSync(join(project, "README.md"), "# shop\n");
  return M.collect("claude", { login: "key", mcp: ["docs", "tool"], instructions: ["CLAUDE.md"], project: { folder: project, git: false } }, { home, env: { HOME: home }, keys: [], shellKeys: [] });
}

/** The sandbox's side after bring(): the same checks for every platform. */
function checkBox(home, cwd) {
  assert.equal(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8"), "be brief\n");
  assert.equal(mode(join(home, ".claude", "CLAUDE.md")), 0o600);
  const cj = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
  assert.equal(mode(join(home, ".claude.json")), 0o600);
  assert.equal(cj.mcpServers.tool.env.TOOL_TOKEN, SECRET);
  assert.equal(cj.mcpServers.docs.headers.Authorization, HEADER);
  assert.deepEqual(cj.customApiKeyResponses.approved, [KEY.slice(-20)]);
  assert.equal(cj.hasCompletedOnboarding, true);
  assert.equal(readFileSync(join(cwd, "src", "app.js"), "utf8"), "1\n");
  assert.equal(mode(join(cwd, "README.md")), 0o600);
  const run = join(home, ".agent-visualizer", "run");
  assert.deepEqual(existsSync(run) ? readdirSync(run) : [], [], "no archive or staging left behind");
}

const noSecret = (what, text) => {
  for (const s of [SECRET, HEADER, KEY, KEY.slice(-20)]) assert.ok(!String(text).includes(s), `${what} carries ${s.slice(0, 14)}`);
};

const sh = (home, command, env = {}, input) =>
  new Promise((resolve) => {
    const c = spawn("sh", ["-c", command], { cwd: home, env: { PATH: process.env.PATH, HOME: home, ...env } });
    let out = "";
    let err = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    c.on("close", (code) => resolve({ code, out, err }));
    if (input) c.stdin.end(input);
    else c.stdin.end();
  });

test("Daytona: execute with per-command envs, upload-v2 into the run folder, then tar", async () => {
  const boxes = [];
  const seen = { executes: [], uploads: [] };
  const srv = await wsServe({
    async http(req, body, url, bytes) {
      const p = url.pathname;
      const view = (b) => ({ id: b.id, name: b.name, state: "started", labels: { "agent-visualizer": "1" }, toolboxProxyUrl: `${srv.url}/toolbox` });
      if (p === "/api/sandbox" && req.method === "POST") {
        const b = { id: `box-${boxes.length + 1}`, name: body.name, home: mk() };
        boxes.push(b);
        return { json: view(b) };
      }
      if (p === "/api/sandbox") return { json: { items: boxes.map(view) } };
      let m = p.match(/^\/api\/sandbox\/([^/]+)$/);
      if (m) return { json: view(boxes.find((b) => b.id === m[1])) };
      if ((m = p.match(/^\/toolbox\/([^/]+)\/process\/execute$/))) {
        const b = boxes.find((x) => x.id === m[1]);
        seen.executes.push(body);
        const r = await sh(b.home, body.command, body.envs);
        return { json: { exitCode: r.code, result: r.out + r.err } };
      }
      if ((m = p.match(/^\/toolbox\/([^/]+)\/files\/upload-v2$/))) {
        const b = boxes.find((x) => x.id === m[1]);
        const path = url.searchParams.get("path");
        assert.ok(path.startsWith(b.home + "/"), "uploads stay in the sandbox's home");
        seen.uploads.push({ path, type: req.headers["content-type"], size: bytes.length });
        writeFileSync(path, bytes);
        return { json: { path } };
      }
      return { status: 404, json: { message: `no route ${p}` } };
    },
  });
  servers.push(srv);
  const home = mk();
  const ctx = fakeContext({ home, env: { PATH: process.env.PATH, HOME: home, DAYTONA_API_URL: `${srv.url}/api`, DAYTONA_API_KEY: "dtn-dummy" } });
  const places = M.createPlaces(ctx, { pollMs: 5 });
  const place = await places.open({ kind: "daytona", target: "new", cwd: "~/shop" }, { agent: "claude", progress: () => {}, createCwd: true });
  const steps = [];
  const r = await place.bring(await bundle(), { ANTHROPIC_API_KEY: KEY }, (d) => steps.push(d));
  assert.deepEqual(r.skipped, []);
  assert.ok(steps.some((s) => /Uploading ~\/Codes\/shop/.test(s)), steps.join(" | "));
  checkBox(boxes[0].home, place.cwd);
  assert.equal(seen.uploads.length, 2, "instructions and the project");
  assert.ok(seen.uploads.every((u) => u.type === "application/octet-stream" && u.path.includes("/.agent-visualizer/run/")));
  const secretRun = seen.executes.filter((e) => e.envs && Object.keys(e.envs).some((k) => k.startsWith("AO_SETUP_")));
  assert.equal(secretRun.length, 1, "one command carries the values, in its envs");
  for (const e of seen.executes) noSecret("a Daytona command", e.command);
  places.shutdown();
});

test("Vercel: the values ride one command's env; files go through fs/write as a tar.gz at /", async () => {
  const boxes = [];
  const seen = { cmds: [], writes: [] };
  const srv = await wsServe({
    async http(req, body, url, bytes) {
      const p = url.pathname;
      const view = (b) => ({ name: b.name, status: "running", currentSessionId: b.session, tags: { "agent-visualizer": "1" }, createdAt: Date.now() });
      if (p === "/v2/user") return { json: { user: { id: "u1", defaultTeamId: "team_1" } } };
      if (p.startsWith("/v2/projects/")) return { json: { id: "prj_1" } };
      if (p === "/v3/sandboxes" && req.method === "POST") {
        // Resolved: macOS's /var is a link, and tar won't extract through one.
        const b = { name: body.name, session: `sess_${boxes.length + 1}`, home: realpathSync(mk()) };
        boxes.push(b);
        return { json: { sandbox: view(b) } };
      }
      if (p === "/v2/sandboxes") return { json: { sandboxes: boxes.map(view), pagination: { next: null } } };
      let m = p.match(/^\/v2\/sandboxes\/([^/]+)$/);
      if (m) return { json: { sandbox: view(boxes.find((b) => b.name === decodeURIComponent(m[1]))) } };
      if ((m = p.match(/^\/v2\/sandboxes\/sessions\/([^/]+)\/cmd$/))) {
        const b = boxes.find((x) => x.session === m[1]);
        seen.cmds.push(body);
        const r = await sh(b.home, body.args[1], body.env);
        const lines = [{ stream: "stdout", data: r.out }, { stream: "stderr", data: r.err }, { command: { id: "c", exitCode: r.code } }];
        return { type: "application/x-ndjson", text: lines.map((l) => JSON.stringify(l)).join("\n") + "\n" };
      }
      if ((m = p.match(/^\/v2\/sandboxes\/sessions\/([^/]+)\/fs\/write$/))) {
        const b = boxes.find((x) => x.session === m[1]);
        seen.writes.push({ type: req.headers["content-type"], cwd: req.headers["x-cwd"], size: bytes.length });
        // Every name must land inside the sandbox's home before anything is extracted at "/".
        const names = spawnSync("tar", ["tzf", "-"], { input: bytes }).stdout.toString().split("\n").filter(Boolean);
        const prefix = b.home.replace(/^\//, "") + "/";
        assert.ok(names.every((n) => n.startsWith(prefix)), "fs/write names are absolute paths in the home");
        const x = spawnSync("tar", ["xzf", "-", "-C", "/"], { input: bytes });
        assert.equal(x.status, 0, String(x.stderr));
        return { json: {} };
      }
      return { status: 404, json: { error: { message: `no route ${p}` } } };
    },
  });
  servers.push(srv);
  const home = mk();
  const ctx = fakeContext({ home, env: { PATH: process.env.PATH, HOME: home, VERCEL_TOKEN: "vtok", AGENT_VISUALIZER_VERCEL_API: srv.url } });
  const places = M.createPlaces(ctx, { pollMs: 5 });
  const place = await places.open({ kind: "vercel", target: "new", cwd: "~/shop" }, { agent: "claude", progress: () => {}, createCwd: true });
  const r = await place.bring(await bundle(), { ANTHROPIC_API_KEY: KEY }, () => {});
  assert.deepEqual(r.skipped, []);
  checkBox(boxes[0].home, place.cwd);
  assert.equal(seen.writes.length, 2);
  assert.ok(seen.writes.every((w) => w.type === "application/gzip" && w.cwd === "/"));
  assert.equal(seen.cmds.filter((c) => c.env && Object.keys(c.env).some((k) => k.startsWith("AO_SETUP_"))).length, 1);
  for (const c of seen.cmds) noSecret("a Vercel command's args", JSON.stringify(c.args));
  places.shutdown();
});

test("Railway: the exec bridge carries the values in init_exec.env and the archives on stdin", async () => {
  const boxes = [];
  const seen = { inits: [] };
  const srv = await wsServe({
    protocol: (offered) => (offered.includes("railway-shell") ? "railway-shell" : undefined),
    async http(req, body) {
      const q = body?.query ?? "";
      const v = body?.variables ?? {};
      if (q.includes("sandboxCreate")) {
        const b = { id: `sbx-${boxes.length + 1}`, env: v.input.environmentId, home: mk() };
        boxes.push(b);
        return { json: { data: { sandboxCreate: { id: b.id, status: "RUNNING", environmentId: b.env, createdAt: new Date().toISOString() } } } };
      }
      if (q.includes("sandbox(environmentId")) return { json: { data: { sandbox: { id: v.id, status: "RUNNING" } } } };
      if (q.includes("generateShellToken")) return { json: { data: { generateShellToken: "jwt-dummy" } } };
      if (q.includes("projectToken")) return { json: { data: { projectToken: null } } };
      // config.json's ids are looked up in the account's projects before anything uses them.
      if (q.includes("me { workspaces")) return { json: { data: { me: { workspaces: [{ id: "w1", name: "me" }] } } } };
      if (q.includes("projects(workspaceId")) return { json: { data: { projects: { edges: [{ node: { id: "p1", name: "shop", environments: { edges: [{ node: { id: "e1", name: "production" } }] } } }], pageInfo: { hasNextPage: false } } } } };
      return { json: { data: {} } };
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
          child = spawn("sh", ["-c", j.data.command], { cwd: b.home, env: { PATH: process.env.PATH, HOME: b.home, ...(j.data.env ?? {}) } });
          child.stdout.on("data", (d) => conn.binary(Buffer.concat([Buffer.from([1]), d])));
          child.stderr.on("data", (d) => conn.binary(Buffer.concat([Buffer.from([3]), d])));
          child.on("exit", (code) => {
            conn.text(JSON.stringify({ type: "exit", data: { exit_code: code ?? 137 } }));
            setTimeout(() => conn.close(1000), 10);
          });
        } else if (j.type === "stdin_close") child?.stdin.end();
      });
    },
  });
  servers.push(srv);
  const home = mk();
  const cliDir = mk();
  writeBin(cliDir, "railway", "process.exit(0)");
  writeFileSync(join(home, "config.json"), JSON.stringify({ control: { railway: { project: "p1", environment: "e1" } } }));
  const ctx = fakeContext({ home, env: { PATH: process.env.PATH, HOME: home, AGENT_VISUALIZER_HOME: home, RAILWAY_API_TOKEN: "rtok", RAILWAY_GRAPHQL_ENDPOINT: srv.url, RAILWAY_TCP_PROXY_WS_ENDPOINT: srv.wsUrl } });
  const places = M.createPlaces(ctx, { pollMs: 5, bins: { railway: join(cliDir, "railway") } });
  const place = await places.open({ kind: "railway", target: "new", cwd: "~/shop" }, { agent: "claude", progress: () => {}, createCwd: true });
  const r = await place.bring(await bundle(), { ANTHROPIC_API_KEY: KEY }, () => {});
  assert.deepEqual(r.skipped, []);
  checkBox(boxes[0].home, place.cwd);
  assert.equal(seen.inits.filter((i) => i.env && Object.keys(i.env).some((k) => k.startsWith("AO_SETUP_"))).length, 1);
  assert.equal(seen.inits.filter((i) => /tar xzf -/.test(i.command)).length, 2);
  for (const i of seen.inits) noSecret("a Railway command", i.command);
  places.shutdown();
});

test("ssh: values as assignments on ssh's stdin, archives into tar on stdin; an existing file is kept", async () => {
  const dir = mk();
  const remoteHome = mk();
  const log = join(dir, "ssh.log");
  writeBin(join(dir, "bin"), "ssh", `
const fs = require("fs");
const { spawnSync } = require("child_process");
const args = process.argv.slice(2);
if (args.includes("-O")) process.exit(0);
const i = args.indexOf("--");
const cmd = args[i + 2];
const input = fs.readFileSync(0);
fs.appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify({ args, stdin: cmd === "sh -s" ? input.toString("utf8") : "<" + input.length + " bytes>" }) + "\\n");
const env = { PATH: process.env.PATH, HOME: process.env.FAKE_REMOTE_HOME, LC_ALL: "C" };
const r = cmd === "sh -s" ? spawnSync("sh", ["-s"], { input, env, cwd: env.HOME }) : spawnSync("sh", ["-c", cmd], { input, env, cwd: env.HOME });
process.stdout.write(r.stdout); process.stderr.write(r.stderr);
process.exit(r.status === null ? 1 : r.status);
`);
  mkdirSync(join(remoteHome, ".claude"), { recursive: true });
  writeFileSync(join(remoteHome, ".claude", "CLAUDE.md"), "theirs\n");
  const ao = join("/tmp", `ao-s-${process.pid}-${Math.random().toString(36).slice(2, 6)}`);
  made.push(ao);
  const pty = fakePty();
  ptys.push(pty);
  const ctx = fakeContext({ home: ao, userHome: dir, pty, env: { PATH: process.env.PATH, HOME: dir, FAKE_SSH_LOG: log, FAKE_REMOTE_HOME: remoteHome, AGENT_VISUALIZER_HOME: ao } });
  const places = M.createPlaces(ctx, { bins: { ssh: join(dir, "bin", "ssh") } });
  const place = await places.open({ kind: "ssh", target: "box", cwd: "~/shop" }, { agent: "claude", progress: () => {}, createCwd: true });
  assert.equal(place.ours, false);
  const r = await place.bring(await bundle(), { ANTHROPIC_API_KEY: KEY }, () => {});
  assert.deepEqual(r.skipped, ["1 instruction file was already there and kept"]);
  assert.equal(readFileSync(join(remoteHome, ".claude", "CLAUDE.md"), "utf8"), "theirs\n");
  const cj = JSON.parse(readFileSync(join(remoteHome, ".claude.json"), "utf8"));
  assert.equal(cj.mcpServers.tool.env.TOOL_TOKEN, SECRET);
  assert.equal(mode(join(remoteHome, ".claude.json")), 0o600);
  assert.equal(readFileSync(join(place.cwd, "src", "app.js"), "utf8"), "1\n");
  const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  for (const c of calls) noSecret("an ssh argv", JSON.stringify(c.args));
  assert.ok(calls.some((c) => c.stdin.includes("AO_SETUP_0=")), "the values travel on stdin");
  assert.equal(calls.filter((c) => c.args.some((a) => /tar xzf -/.test(a))).length, 2);
  places.shutdown();
});
