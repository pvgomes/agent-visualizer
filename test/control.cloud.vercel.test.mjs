// Tests for src/control/cloud/vercel.ts (through createPlaces) against a fake Vercel API and its
// interactive WebSocket. A "sandbox" is a scratch HOME here: /cmd runs `sh -c` there, the
// interactive socket spawns the start frame's command with its env. Covers the default project
// (a note first, created only on a create), the v3 create body, the 45-minute retry, tags-based
// "ours", attach (keys only in the start frame's env, never in any command's args), resize and
// exit frames, the npx CLI fallback with its env file, and delete. Keys are dummies.
import nodeTest, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { load, tmp, until, writeBin } from "./remote.fakes.mjs";
import { AGENT_SCRIPT, CHAT_SCRIPT, collect, fakeContext, fakePty, wsServe } from "./control.cloud.fakes.mjs";
import { CONTROL, skipAll } from "./platform.mjs";

const test = skipAll(nodeTest, CONTROL);

const M = await load("src/control/cloud/index.ts");

const TOKEN = "vercel-dummy-token";
const KEY = "sk-ant-dummy-vercel-0003";
const made = [];
const ptys = [];
const servers = [];
const children = [];
after(async () => {
  for (const p of ptys) p.killAll();
  for (const c of children) c.kill("SIGKILL");
  for (const s of servers) await s.close();
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

let n = 0;
async function fakeVercel({ project = false, hobby = false, noInteractive = false, dropStdin = 0, cutLogs = 0, dropOnInput, endOnInput } = {}) {
  const bin = tmp();
  writeBin(bin, "claude", AGENT_SCRIPT);
  writeBin(bin, "chat-agent", CHAT_SCRIPT);
  made.push(bin);
  const boxes = [];
  const seen = { projects: [], creates: [], cmds: [], deletes: [], starts: [], resizes: [], stdin: [], kills: [], logOpens: 0 };
  // Detached commands (chat): the child, everything it printed as {stream, data}, live log readers.
  const detached = new Map();
  let cmdN = 0;
  const cmdView = (c) => ({ id: c.id, name: "sh", args: c.args, cwd: c.cwd, sessionId: c.session, exitCode: c.exitCode, startedAt: 1760745600000 });
  let projectExists = project;
  const runSh = (b, script, env = {}) =>
    new Promise((resolve) => {
      const c = spawn("sh", ["-c", script], { cwd: b.home, env: { PATH: `${bin}:${process.env.PATH}`, HOME: b.home, ...env } });
      let out = "";
      let err = "";
      c.stdout.on("data", (d) => (out += d));
      c.stderr.on("data", (d) => (err += d));
      c.on("close", (code) => resolve({ code, out, err }));
    });
  const view = (b) => ({ name: b.name, status: b.status, currentSessionId: b.session, tags: b.tags, createdAt: 1760745600000, expiresAt: 1760747400000, persistent: false });
  const srv = await wsServe({
    reject: (req, url) => (url.searchParams.get("token") !== "itok" ? 401 : 0),
    // A detached command's logs: everything so far (a replay from the start), then live until it exits.
    stream(req, res, url) {
      const m = url.pathname.match(/^\/v2\/sandboxes\/sessions\/([^/]+)\/cmd\/([^/]+)\/logs$/);
      if (!m) return false;
      const c = detached.get(m[2]);
      if (req.headers.authorization !== `Bearer ${TOKEN}` || !c) {
        res.writeHead(c ? 403 : 404, { "content-type": "application/json" });
        res.end("{}");
        return true;
      }
      seen.logOpens++;
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      for (const e of c.log) res.write(JSON.stringify(e) + "\n");
      if (c.exitCode !== null) res.end();
      else {
        c.readers.add(res);
        res.on("close", () => c.readers.delete(res));
      }
      return true;
    },
    async http(req, body, url) {
      const p = url.pathname;
      if (p === "/health") return { json: { ok: true } };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return { status: 403, json: { error: { message: "forbidden" } } };
      if (p === "/v2/user") return { json: { user: { id: "u1", defaultTeamId: "team_1" } } };
      if (p === "/v2/projects/vercel-sandbox-default-project") return projectExists ? { json: { id: "prj_1" } } : { status: 404, json: { error: { message: "not found" } } };
      if (p === "/v11/projects" && req.method === "POST") {
        seen.projects.push({ body, teamId: url.searchParams.get("teamId") });
        projectExists = true;
        return { json: { id: "prj_1" } };
      }
      if (p === "/v3/sandboxes" && req.method === "POST") {
        seen.creates.push({ body, teamId: url.searchParams.get("teamId") });
        if (hobby && body.timeout > 45 * 60000) return { status: 400, json: { error: { message: "timeout exceeds the maximum duration for your plan" } } };
        const b = { name: body.name, status: "pending", session: `sess_${++n}`, tags: body.tags, home: tmp(), polls: 0 };
        made.push(b.home);
        boxes.push(b);
        return { json: { sandbox: view(b), session: { id: b.session, status: "pending" } } };
      }
      if (p === "/v2/sandboxes" && req.method === "GET") {
        const tag = url.searchParams.get("tags");
        const rows = boxes.filter((b) => !tag || `agent-visualizer:${b.tags?.["agent-visualizer"]}` === tag);
        return { json: { sandboxes: rows.map(view), pagination: { next: null } } };
      }
      let m = p.match(/^\/v2\/sandboxes\/([^/]+)$/);
      if (m) {
        const b = boxes.find((x) => x.name === decodeURIComponent(m[1]));
        if (!b) return { status: 404, json: { error: { message: "not found" } } };
        if (req.method === "DELETE") {
          seen.deletes.push({ name: b.name, query: Object.fromEntries(url.searchParams) });
          boxes.splice(boxes.indexOf(b), 1);
          return { json: { sandbox: view(b) } };
        }
        if (b.status === "pending" && ++b.polls >= 1) b.status = "running";
        return { json: { sandbox: view(b) } };
      }
      if ((m = p.match(/^\/v2\/sandboxes\/sessions\/([^/]+)\/cmd$/))) {
        const b = boxes.find((x) => x.session === m[1]);
        seen.cmds.push(body);
        if (body.attachStdin) {
          const c = { id: `cmd_d${++cmdN}`, session: m[1], args: body.args, cwd: body.cwd ?? b.home, exitCode: null, written: 0, log: [], readers: new Set() };
          c.child = spawn("sh", ["-c", body.args[1]], { cwd: c.cwd, env: { PATH: `${bin}:${process.env.PATH}`, HOME: b.home, ...(body.env ?? {}) } });
          children.push(c.child);
          const push = (stream, d) => {
            const e = { stream, data: String(d) };
            c.log.push(e);
            for (const r of c.readers) {
              r.write(JSON.stringify(e) + "\n");
              // Cut once it has said something, while the command runs (what a proxy may do to a long stream).
              if (cutLogs > 0) {
                cutLogs--;
                c.readers.delete(r);
                r.end();
              }
            }
          };
          c.child.stdout.on("data", (d) => push("stdout", d));
          c.child.stderr.on("data", (d) => push("stderr", d));
          c.child.stdin.on("error", () => {});
          c.done = new Promise((resolve) =>
            c.child.on("close", (code, sig) => {
              c.exitCode = code ?? 128 + ({ SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 }[sig] ?? 0);
              for (const r of c.readers) r.end();
              resolve();
            }),
          );
          detached.set(c.id, c);
          return { json: { command: cmdView(c) } };
        }
        const r = await runSh(b, body.args[1], body.env);
        const lines = [{ command: { id: "cmd_1" } }, { stream: "stdout", data: r.out }, { stream: "stderr", data: r.err }, { command: { id: "cmd_1", exitCode: r.code } }];
        return { type: "application/x-ndjson", text: lines.map((l) => JSON.stringify(l)).join("\n") + "\n" };
      }
      if ((m = p.match(/^\/v2\/sandboxes\/sessions\/([^/]+)\/cmd\/([^/]+)\/stdin$/))) {
        const c = detached.get(m[2]);
        if (!c || c.exitCode !== null) return { status: 404, json: { error: { code: "command_not_found_or_exited", message: "Not found: command not found or has exited" } } };
        seen.stdin.push(body);
        let data = body.data ? Buffer.from(body.data, "base64") : Buffer.alloc(0);
        if (dropOnInput && data.toString().startsWith(dropOnInput)) {
          // The log stream breaks first: what the agent prints next lands only in the log.
          for (const r of c.readers) r.destroy();
          c.readers.clear();
        }
        if (endOnInput && data.toString().startsWith(endOnInput)) {
          // Ended whole, as a command's own end looks, just before the agent's last words.
          for (const r of c.readers) r.end();
          c.readers.clear();
        }
        // What it already has is skipped: a resend at the same offset writes nothing twice.
        if (typeof body.offset === "number" && body.offset < c.written) data = data.subarray(Math.min(data.length, c.written - body.offset));
        if (data.length) {
          c.child.stdin.write(data);
          c.written += data.length;
        }
        if (body.close) c.child.stdin.end();
        if (dropStdin > 0 && data.length) {
          // Applied, then the connection drops before the answer.
          dropStdin--;
          req.socket.destroy();
          return new Promise(() => {});
        }
        return { json: { command: cmdView(c), bytesWritten: c.written } };
      }
      if ((m = p.match(/^\/v2\/sandboxes\/sessions\/([^/]+)\/cmd\/([^/]+)\/kill$/))) {
        const c = detached.get(m[2]);
        seen.kills.push(body.signal);
        c.child.kill({ 1: "SIGHUP", 2: "SIGINT", 9: "SIGKILL", 15: "SIGTERM" }[body.signal]);
        return { json: { command: cmdView(c) } };
      }
      if ((m = p.match(/^\/v2\/sandboxes\/sessions\/([^/]+)\/cmd\/([^/]+)$/))) {
        const c = detached.get(m[2]);
        if (!c) return { status: 404, json: { error: { message: "not found" } } };
        if (url.searchParams.get("wait") === "true") await c.done;
        return { json: { command: cmdView(c) } };
      }
      if ((m = p.match(/^\/v2\/sandboxes\/sessions\/([^/]+)\/interactive$/))) {
        if (noInteractive) return { status: 404, json: { error: { message: "not found" } } };
        return { json: { url: `${srv.wsUrl}/interactive/${m[1]}`, token: "itok" } };
      }
      return { status: 404, json: { error: { message: `no route ${p}` } } };
    },
    ws(conn, req, url) {
      const b = boxes.find((x) => x.session === url.pathname.split("/").pop());
      let child;
      conn.onMessage((msg) => {
        if (!child && msg.op === 1) {
          const start = JSON.parse(msg.data);
          seen.starts.push(start);
          const env = Object.fromEntries(start.env.map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
          child = spawn(start.command, start.args, { cwd: start.cwd, env: { PATH: `${bin}:${process.env.PATH}`, HOME: b.home, ...env } });
          child.stdout.on("data", (d) => conn.binary(d));
          child.stderr.on("data", (d) => conn.binary(d));
          child.on("exit", (code) => {
            conn.text(JSON.stringify({ type: "exit", code }));
            setTimeout(() => conn.close(1000), 20);
          });
          return;
        }
        if (msg.op === 1) {
          const j = JSON.parse(msg.data);
          if (j.type === "resize") seen.resizes.push(j);
          return;
        }
        child?.stdin.write(msg.data);
      });
    },
  });
  servers.push(srv);
  return { srv, seen, boxes, bin };
}

function places(v, extra = {}) {
  const home = tmp();
  made.push(home);
  const pty = fakePty();
  ptys.push(pty);
  const ctx = fakeContext({ home, pty, env: { PATH: process.env.PATH, HOME: home, VERCEL_TOKEN: TOKEN, AGENT_VISUALIZER_VERCEL_API: v.srv.url, ...extra.env } });
  return { ctx, pty, home, places: M.createPlaces(ctx, { pollMs: 10, ...extra.opts }) };
}

const LAUNCH = { argv: ["claude", "--permission-mode", "plan", { env: "AO_PROMPT" }], cwd: "~", env: { ANTHROPIC_API_KEY: KEY, AO_PROMPT: "add a test" }, secret: ["ANTHROPIC_API_KEY"] };

test("the default project: a note before, created on the first create, then a v3 sandbox that isn't persistent", async () => {
  const v = await fakeVercel();
  const { places: p, home } = places(v);
  const row = (await p.status()).find((x) => x.kind === "vercel");
  assert.equal(row.ready, true);
  assert.equal(row.canCreate, true);
  assert.equal(row.note, "Creating a sandbox first creates the project vercel-sandbox-default-project in your default team");
  assert.equal(v.seen.projects.length, 0, "status never creates anything");
  const steps = [];
  const place = await p.open({ kind: "vercel", target: "new" }, { agent: "claude", progress: (s, d) => steps.push(d) });
  assert.deepEqual(v.seen.projects, [{ body: { name: "vercel-sandbox-default-project" }, teamId: "team_1" }]);
  assert.ok(steps.includes("Creating Vercel project vercel-sandbox-default-project…"));
  const { body, teamId } = v.seen.creates[0];
  assert.equal(teamId, "team_1");
  assert.match(body.name, /^agent-visualizer-[0-9a-f]{6}$/);
  assert.deepEqual({ ...body, name: "x" }, { projectId: "vercel-sandbox-default-project", name: "x", tags: { "agent-visualizer": "1" }, persistent: false, timeout: 30 * 60000 });
  assert.equal("runtime" in body, false, "no runtime: the universal image");
  assert.equal(place.host.id, `vercel:${body.name}`);
  assert.equal(place.ours, true);
  const reg = JSON.parse(readFileSync(join(home, "sandboxes.json"), "utf8")).sandboxes;
  assert.deepEqual(reg.map((r) => [r.provider, r.id, r.projectId, r.teamId]), [["vercel", body.name, "vercel-sandbox-default-project", "team_1"]]);
  const row2 = (await p.status({ fresh: true })).find((x) => x.kind === "vercel");
  assert.equal(row2.note, undefined);
  assert.deepEqual(row2.sandboxes.map((s) => [s.id, s.ours, s.status]), [[body.name, true, "running"]]);
  assert.equal(row2.sandboxes[0].expiresAt, new Date(1760747400000).toISOString());
});

test("a plan that caps the timeout gets one retry at 45 minutes", async () => {
  const v = await fakeVercel({ project: true, hobby: true });
  const { places: p } = places(v);
  const steps = [];
  await p.open({ kind: "vercel", target: "new" }, { agent: "claude", sandbox: { timeoutMin: 120 }, progress: (s, d) => steps.push(d) });
  assert.deepEqual(v.seen.creates.map((c) => c.body.timeout), [120 * 60000, 45 * 60000]);
  assert.ok(steps.some((d) => /allows 45 minutes/.test(d)));
});

test("attach: the keys and the prompt ride the start frame's env only; resize and exit frames", async () => {
  const v = await fakeVercel({ project: true });
  const { places: p } = places(v);
  const place = await p.open({ kind: "vercel", target: "new" }, { agent: "claude", progress: () => {} });
  assert.equal((await place.target.exec("echo polled")).trim(), "polled");
  await assert.rejects(place.run("echo why >&2; exit 4", { timeoutMs: 5000 }), /exit 4: why/);
  await place.ensureAgent("claude", () => {});
  const term = await place.attach({ ...LAUNCH, cwd: place.cwd }, { cols: 100, rows: 30 });
  const out = collect(term);
  await until(() => out.text().includes("\n"), 5000, "agent output");
  const hello = JSON.parse(out.text().split("\n")[0]);
  assert.equal(hello.keys.ANTHROPIC_API_KEY, KEY);
  assert.deepEqual(hello.argv, ["--permission-mode", "plan", "add a test"]);
  assert.deepEqual(hello.files.filter((f) => f.endsWith(".env")), [], "no env file on this transport");
  assert.ok(hello.files.some((f) => f.endsWith(".pid")), "the pid file, for stop");
  term.resize(120, 33);
  await until(() => v.seen.resizes.length, 3000, "resize frame");
  assert.deepEqual(v.seen.resizes[0], { type: "resize", cols: 120, rows: 33 });
  term.write("hi\n");
  await until(() => out.text().includes("got:hi"), 5000, "echo");
  term.write("quit\n");
  assert.equal((await out.done).code, 3);

  const start = v.seen.starts[0];
  assert.equal(start.command, "sh");
  assert.equal(start.cols, 100);
  assert.ok(start.env.includes(`ANTHROPIC_API_KEY=${KEY}`) && start.env.includes("AO_PROMPT=add a test") && start.env.includes("TERM=xterm-256color"));
  assert.ok(!JSON.stringify(start.args).includes(KEY) && !JSON.stringify(start.args).includes("add a test"), "Vercel keeps args: nothing secret there");
  assert.ok(v.seen.cmds.every((c) => !JSON.stringify(c.args).includes(KEY) && !c.env), "no command carried a key");
  assert.equal(v.srv.requests.find((r) => r.method === "UPGRADE").query.token, "itok");
  assert.ok(v.srv.requests.some((r) => r.path === "/health"), "health checked before connecting");
});

test("no interactive endpoint: the pinned sandbox CLI under a local PTY, with the env file and the token in its env", async () => {
  const v = await fakeVercel({ project: true, noInteractive: true });
  const cliDir = tmp();
  made.push(cliDir);
  const npx = writeBin(cliDir, "npx", `const fs = require("fs"); const { spawn } = require("child_process");
const a = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(join(cliDir, "argv.json"))}, JSON.stringify({ a, token: process.env.VERCEL_AUTH_TOKEN ?? null }));
const i = a.indexOf("--"); const home = process.env.FAKE_HOME;
const c = spawn(a[i + 2], a.slice(i + 3), { stdio: "inherit", cwd: home, env: { PATH: process.env.FAKE_BIN + ":" + process.env.PATH, HOME: home } });
c.on("exit", (code) => process.exit(code ?? 1));`);
  const { places: p, pty } = places(v, { opts: { bins: { npx } } });
  const place = await p.open({ kind: "vercel", target: "new" }, { agent: "claude", progress: () => {} });
  pty.spawnEnvExtra = { FAKE_HOME: v.boxes[0].home, FAKE_BIN: v.bin };
  const origSpawn = pty.spawn.bind(pty);
  pty.spawn = (spec) => origSpawn({ ...spec, env: { ...spec.env, ...pty.spawnEnvExtra } });
  const term = await place.attach({ ...LAUNCH, cwd: place.cwd }, { cols: 80, rows: 24 });
  const out = collect(term);
  await until(() => out.text().includes("\n"), 5000, "agent output");
  assert.equal(JSON.parse(out.text().split("\n")[0]).keys.ANTHROPIC_API_KEY, KEY);
  const rec = JSON.parse(readFileSync(join(cliDir, "argv.json"), "utf8"));
  assert.deepEqual(rec.a.slice(0, 5), ["--yes", "sandbox@4.8.1", "exec", "--interactive", "--no-extend-timeout"]);
  assert.equal(rec.a[rec.a.indexOf("--") + 1], v.boxes[0].name);
  assert.equal(rec.token, TOKEN, "the CLI's login travels in its environment");
  assert.ok(!JSON.stringify(rec.a).includes(TOKEN) && !JSON.stringify(rec.a).includes(KEY), "no token or key on its argv");
  const envCmd = v.seen.cmds.find((c) => c.env?.AO_ENV);
  assert.ok(envCmd.env.AO_ENV.includes(KEY) && !JSON.stringify(envCmd.args).includes(KEY), "env file from a per-command env, not args");
  term.write("quit\n");
  assert.equal((await out.done).code, 3);
});

test("delete asks for orphan snapshots to go too; someone else's sandbox needs force", async () => {
  const v = await fakeVercel({ project: true });
  const { places: p } = places(v);
  const place = await p.open({ kind: "vercel", target: "new" }, { agent: "claude", progress: () => {} });
  const name = place.host.id.slice("vercel:".length);
  await p.deleteSandbox("vercel", name);
  assert.deepEqual(v.seen.deletes[0].query, { projectId: "vercel-sandbox-default-project", teamId: "team_1", deleteOrphanSnapshots: "true" });
  v.boxes.push({ name: "users-own", status: "running", session: "sess_u", tags: {}, home: tmp() });
  await assert.rejects(p.deleteSandbox("vercel", "users-own"), (e) => e.status === 409);
  const other = await p.open({ kind: "vercel", target: "users-own" }, { agent: "claude", progress: () => {} });
  assert.equal(other.ours, false);
});

/** A PipeProc's stdout and stderr as text, and its exit. */
function piped(p) {
  const out = [];
  const err = [];
  p.onStdout((c) => out.push(Buffer.from(c)));
  p.onStderr((c) => err.push(Buffer.from(c)));
  const done = new Promise((resolve) => p.onExit(resolve));
  return { out: () => Buffer.concat(out).toString("utf8"), err: () => Buffer.concat(err).toString("utf8"), done };
}

const CHAT = (cwd) => ({ argv: ["chat-agent", "-p"], cwd, env: { ANTHROPIC_API_KEY: KEY }, secret: ["ANTHROPIC_API_KEY"] });

test("chat: a detached command with stdin attached; the key in its env only; stdout and stderr apart; EOF ends it", async () => {
  const v = await fakeVercel({ project: true });
  const { places: p } = places(v);
  const place = await p.open({ kind: "vercel", target: "new" }, { agent: "claude", progress: () => {} });
  const pipe = await place.pipe(CHAT(place.cwd));
  const io = piped(pipe);
  await until(() => io.out().includes("\n"), 5000, "first line");
  const hello = JSON.parse(io.out().split("\n")[0]);
  assert.equal(hello.keys.ANTHROPIC_API_KEY, KEY);
  assert.deepEqual(hello.argv, ["-p"]);
  assert.deepEqual(hello.files, [], "no env file or pid file: the API signals the command itself");
  pipe.write("pi");
  pipe.write(new TextEncoder().encode("ng\n"));
  pipe.write("ünï ✓\n");
  await until(() => io.out().includes("got:ünï ✓"), 5000, "both lines back");
  assert.ok(io.out().indexOf("got:ping") < io.out().indexOf("got:ünï ✓"), "in order");
  assert.match(io.err(), /err:ping\nerr:ünï ✓\n/);
  assert.ok(!io.out().includes("err:"), "stderr stays apart");
  pipe.end();
  assert.equal((await io.done).code, 0, "stdin closed: the agent read EOF");

  const cmd = v.seen.cmds.find((c) => c.attachStdin);
  assert.equal(cmd.command, "sh");
  assert.equal(cmd.env.ANTHROPIC_API_KEY, KEY);
  assert.ok(!JSON.stringify(cmd.args).includes(KEY), "Vercel keeps args: no key there");
  const offsets = v.seen.stdin.map((s) => s.offset);
  assert.deepEqual(offsets, [...offsets].sort((a, b) => a - b), "offsets only grow");
  assert.equal(v.seen.stdin.at(-1).close, true);
  assert.equal(v.seen.logOpens, 2, "the log read once more after the exit, for anything a cut stream missed");
});

test("chat: a stdin request that drops after it was applied is resent at its offset and written once", async () => {
  const v = await fakeVercel({ project: true, dropStdin: 1 });
  const { places: p } = places(v);
  const place = await p.open({ kind: "vercel", target: "new" }, { agent: "claude", progress: () => {} });
  const pipe = await place.pipe(CHAT(place.cwd));
  const io = piped(pipe);
  await until(() => io.out().includes("\n"), 5000, "first line");
  pipe.write("once\n");
  pipe.write("twice\n");
  await until(() => io.out().includes("got:twice"), 8000, "after the resend");
  assert.equal(io.out().split("got:once").length - 1, 1, "the resent line wasn't written twice");
  const once = v.seen.stdin.filter((s) => s.data === Buffer.from("once\n").toString("base64"));
  assert.equal(once.length, 2, "sent again after the drop");
  assert.equal(once[0].offset, once[1].offset, "at the same offset");
  pipe.write("quit\n");
  assert.equal((await io.done).code, 3);
});

test("chat: a log stream cut while the agent runs is opened again, and nothing comes twice", async () => {
  const v = await fakeVercel({ project: true, cutLogs: 1 });
  const { places: p } = places(v);
  const place = await p.open({ kind: "vercel", target: "new" }, { agent: "claude", progress: () => {} });
  const pipe = await place.pipe(CHAT(place.cwd));
  const io = piped(pipe);
  await until(() => v.seen.logOpens >= 2, 8000, "the stream reopened");
  pipe.write("after\n");
  await until(() => io.out().includes("got:after"), 5000, "output after the reopen");
  assert.equal(io.out().split('"argv"').length - 1, 1, "the replayed first line was skipped");
  pipe.kill("SIGTERM");
  assert.equal((await io.done).code, 143);
  assert.deepEqual(v.seen.kills, [15]);
});

test("chat: an agent that finishes while its log stream is down still gets its last words through, then its exit", async () => {
  const v = await fakeVercel({ project: true, dropOnInput: "last" });
  const { places: p } = places(v);
  const place = await p.open({ kind: "vercel", target: "new" }, { agent: "claude", progress: () => {} });
  const pipe = await place.pipe(CHAT(place.cwd));
  const io = piped(pipe);
  await until(() => io.out().includes("\n"), 5000, "first line");
  pipe.write("last\nbye\n");
  assert.equal((await io.done).code, 4);
  assert.match(io.out(), /got:last\nbye!\n/, "printed while the stream was down, read from the replay");
  assert.equal(io.out().split('"argv"').length - 1, 1, "and nothing twice");
  assert.ok(v.seen.logOpens >= 2);
});

test("chat: a stream that ends whole just before the agent's last words (a clean cut) still gets them through", async () => {
  const v = await fakeVercel({ project: true, endOnInput: "last" });
  const { places: p } = places(v);
  const place = await p.open({ kind: "vercel", target: "new" }, { agent: "claude", progress: () => {} });
  const pipe = await place.pipe(CHAT(place.cwd));
  const io = piped(pipe);
  await until(() => io.out().includes("\n"), 5000, "first line");
  pipe.write("last\nbye\n");
  assert.equal((await io.done).code, 4);
  assert.match(io.out(), /got:last\nbye!\n/);
  assert.equal(io.out().split('"argv"').length - 1, 1, "nothing twice");
});

test("a name used again right after its sandbox was deleted is listed: it's a new sandbox, not the deleted one", async () => {
  const v = await fakeVercel({ project: true });
  const { places: p } = places(v);
  const first = await p.open({ kind: "vercel", target: "new" }, { agent: "claude", sandbox: { name: "again" }, progress: () => {} });
  assert.equal(first.host.id, "vercel:agent-visualizer-again");
  await p.deleteSandbox("vercel", "agent-visualizer-again");
  assert.deepEqual((await p.status({ fresh: true })).find((x) => x.kind === "vercel").sandboxes.map((s) => s.id), []);
  await p.open({ kind: "vercel", target: "new" }, { agent: "claude", sandbox: { name: "again" }, progress: () => {} });
  const row = (await p.status({ fresh: true })).find((x) => x.kind === "vercel");
  assert.deepEqual(row.sandboxes.map((s) => [s.id, s.ours]), [["agent-visualizer-again", true]], "shown in Settings, so it can be deleted there");
});
