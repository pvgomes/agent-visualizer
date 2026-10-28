// Tests for src/control/cloud/daytona.ts (through createPlaces) against a fake Daytona API, toolbox
// and PTY WebSocket. A "sandbox" here is a scratch HOME on this machine: /process/execute runs its
// command with sh there (with the per-command envs), and the PTY is a plain sh that the typed
// launch line is written into. Covers create (name, labels, auto-delete, TTL, the registry), the
// office's own listing, the cost guard, attach (the env file from execute envs, no key in the PTY's
// envs or the typed line, resize, exit code, PTY cleanup), heartbeats, delete rules, and the
// `daytona ssh` fallback. No real Daytona call is made; keys are dummies.
import nodeTest, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { load, tmp, until, writeBin } from "./remote.fakes.mjs";
import { AGENT_SCRIPT, CHAT_SCRIPT, collect, fakeContext, fakePty, sandboxShell, wsServe } from "./control.cloud.fakes.mjs";
import { CONTROL, skipAll } from "./platform.mjs";

const test = skipAll(nodeTest, CONTROL);

const M = await load("src/control/cloud/index.ts");
const { LogDemux } = await load("src/control/cloud/daytona.ts");

const KEY = "sk-ant-dummy-daytona-0002";
const API_KEY = "dtn-dummy-key";
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
async function fakeDaytona({ boxes = [], wsReject, dropLogs = 0, dropOnInput, closeOnInput, execWaits = false } = {}) {
  const bin = tmp();
  writeBin(bin, "claude", AGENT_SCRIPT);
  writeBin(bin, "claude-version", "console.log('2.1.302')");
  writeBin(bin, "chat-agent", CHAT_SCRIPT);
  made.push(bin);
  const shells = new Map();
  const seen = { creates: [], executes: [], ptys: [], resizes: [], deletes: [], beats: 0, ptyDeletes: [], sessions: [], sessionExecs: [], inputs: [], sessionDeletes: [], logOpens: [] };
  // Session commands (chat): the child, its log as tagged chunks (01 01 01 stdout, 02 02 02 stderr), live log sockets.
  const commands = new Map();
  let cmdN = 0;
  const box = (b) => ({ id: b.id, name: b.name, state: b.state, labels: b.labels ?? {}, createdAt: "2026-10-18T00:00:00.000Z", autoDestroyAt: b.ttl ? "2026-10-18T00:30:00.000Z" : undefined, toolboxProxyUrl: `${srv.url}/toolbox` });
  const srv = await wsServe({
    reject: (req, url) => (req.headers.authorization !== `Bearer ${API_KEY}` ? 401 : wsReject?.(url) ?? 0),
    async http(req, body, url) {
      if (req.headers.authorization !== `Bearer ${API_KEY}`) return { status: 401, json: { message: "Unauthorized" } };
      const p = url.pathname;
      if (p === "/api/organizations") return { status: 403, json: { message: "api key" } };
      if (p === "/api/sandbox" && req.method === "POST") {
        const id = `0000000${++n}-aaaa-4000-8000-00000000000${n}`;
        seen.creates.push(body);
        const b = { id, name: body.name, state: "creating", labels: body.labels, ttl: body.ttlMinutes, home: tmp(), polls: 0 };
        made.push(b.home);
        boxes.push(b);
        return { json: box(b) };
      }
      if (p === "/api/sandbox" && req.method === "GET") {
        const labels = url.searchParams.get("labels");
        const states = url.searchParams.get("states");
        let items = boxes;
        if (labels) {
          const want = JSON.parse(labels);
          items = items.filter((b) => Object.entries(want).every(([k, v]) => b.labels?.[k] === v));
        }
        if (states) items = items.filter((b) => b.state === states);
        return { json: { items: items.map(box), nextCursor: null } };
      }
      let m = p.match(/^\/api\/sandbox\/([^/]+)$/);
      if (m) {
        const b = boxes.find((x) => x.id === decodeURIComponent(m[1]));
        if (!b) return { status: 404, json: { message: "not found" } };
        if (req.method === "DELETE") {
          seen.deletes.push(b.id);
          boxes.splice(boxes.indexOf(b), 1);
          return { json: box(b) };
        }
        if (b.state === "creating" && ++b.polls >= 1) b.state = "started";
        return { json: box(b) };
      }
      if ((m = p.match(/^\/api\/sandbox\/([^/]+)\/last-activity$/))) {
        seen.beats++;
        return { status: 201, json: {} };
      }
      if ((m = p.match(/^\/toolbox\/([^/]+)\/process\/execute$/))) {
        const b = boxes.find((x) => x.id === decodeURIComponent(m[1]));
        seen.executes.push(body);
        const r = await new Promise((resolve) => {
          const c = spawn("sh", ["-c", body.command], { cwd: b.home, env: { PATH: `${bin}:${process.env.PATH}`, HOME: b.home, ...(body.envs ?? {}) } });
          let out = "";
          c.stdout.on("data", (d) => (out += d));
          c.stderr.on("data", (d) => (out += d));
          c.on("close", (code) => resolve({ exitCode: code, result: out }));
        });
        return { json: r };
      }
      if ((m = p.match(/^\/toolbox\/([^/]+)\/process\/pty$/)) && req.method === "POST") {
        seen.ptys.push(body);
        return { status: 201, json: { sessionId: body.id } };
      }
      if ((m = p.match(/^\/toolbox\/([^/]+)\/process\/pty\/([^/]+)\/resize$/))) {
        seen.resizes.push(body);
        return { json: {} };
      }
      if ((m = p.match(/^\/toolbox\/([^/]+)\/process\/pty\/([^/]+)$/)) && req.method === "DELETE") {
        seen.ptyDeletes.push(m[2]);
        shells.get(m[2])?.kill("SIGHUP");
        return { json: {} };
      }
      if ((m = p.match(/^\/toolbox\/([^/]+)\/process\/session$/)) && req.method === "POST") {
        seen.sessions.push(body.sessionId);
        return { status: 201, text: "" };
      }
      if ((m = p.match(/^\/toolbox\/([^/]+)\/process\/session\/([^/]+)\/exec$/))) {
        const b = boxes.find((x) => x.id === decodeURIComponent(m[1]));
        seen.sessionExecs.push(body);
        const c = { id: `cmd-${++cmdN}`, session: decodeURIComponent(m[2]), command: body.command, log: [], socks: new Set(), exitCode: undefined };
        // As the daemon does: the command's stdin is a pipe that /input writes to.
        c.child = spawn("sh", ["-c", body.command], { cwd: b.home, env: { PATH: `${bin}:${process.env.PATH}`, HOME: b.home } });
        children.push(c.child);
        const push = (tag, d) => {
          const chunk = Buffer.concat([Buffer.from([tag, tag, tag]), d]);
          c.log.push(chunk);
          // Live chunks cut inside the marker, as a frame boundary may.
          for (const s of c.socks) {
            s.binary(chunk.subarray(0, 2));
            s.binary(chunk.subarray(2));
            // Dropped once it has said something, while the command runs.
            if (dropLogs > 0) {
              dropLogs--;
              c.socks.delete(s);
              setTimeout(() => s.socket.destroy(), 50);
            }
          }
        };
        c.child.stdout.on("data", (d) => push(1, d));
        c.child.stderr.on("data", (d) => push(2, d));
        c.child.stdin.on("error", () => {});
        c.child.on("close", (code, sig) => {
          c.exitCode = code ?? 128 + ({ SIGHUP: 1, SIGKILL: 9, SIGTERM: 15 }[sig] ?? 0);
          for (const s of c.socks) s.close(1000);
        });
        commands.set(c.id, c);
        // An agent that dies at once: done before its log socket opens, which then brings it all with the upgrade.
        if (execWaits) await new Promise((r) => c.child.on("close", () => setTimeout(r, 20)));
        return { status: 202, json: { cmdId: c.id, output: null, stdout: null, stderr: null, exitCode: null } };
      }
      if ((m = p.match(/^\/toolbox\/([^/]+)\/process\/session\/([^/]+)\/command\/([^/]+)\/input$/))) {
        const c = commands.get(decodeURIComponent(m[3]));
        if (c.exitCode !== undefined) return { status: 410, json: { statusCode: 410, message: `command has already completed with exit code ${c.exitCode}` } };
        seen.inputs.push(body.data);
        if (dropOnInput && body.data.startsWith(dropOnInput)) {
          // The log socket goes down first: what the agent prints next lands only in the log.
          for (const s of c.socks) s.socket.destroy();
          c.socks.clear();
        }
        if (closeOnInput && body.data.startsWith(closeOnInput)) {
          // Closed with 1000, as the command's own end looks, just before the agent's last words.
          for (const s of c.socks) s.close(1000);
          c.socks.clear();
        }
        // The daemon ends a write that lacks one with a newline.
        c.child.stdin.write(body.data.endsWith("\n") ? body.data : `${body.data}\n`);
        return { status: 204, text: "" };
      }
      if ((m = p.match(/^\/toolbox\/([^/]+)\/process\/session\/([^/]+)\/command\/([^/]+)$/))) {
        const c = commands.get(decodeURIComponent(m[3]));
        return { json: { id: c.id, command: c.command, ...(c.exitCode !== undefined ? { exitCode: c.exitCode } : {}) } };
      }
      if ((m = p.match(/^\/toolbox\/([^/]+)\/process\/session\/([^/]+)$/)) && req.method === "DELETE") {
        const s = decodeURIComponent(m[2]);
        seen.sessionDeletes.push(s);
        for (const c of commands.values()) if (c.session === s && c.exitCode === undefined) c.child.kill("SIGKILL");
        return { status: 204, text: "" };
      }
      return { status: 404, json: { message: `no route ${p}` } };
    },
    ws(conn, req, url) {
      const logs = url.pathname.match(/^\/toolbox\/([^/]+)\/process\/session\/([^/]+)\/command\/([^/]+)\/logs$/);
      if (logs) {
        const c = commands.get(decodeURIComponent(logs[3]));
        seen.logOpens.push({ follow: url.searchParams.get("follow"), version: req.headers["x-daytona-sdk-version"] });
        // A replay of the whole log first, then live chunks until the command ends.
        for (const chunk of c.log) conn.binary(chunk);
        if (c.exitCode !== undefined) return conn.close(1000);
        c.socks.add(conn);
        conn.onClose(() => c.socks.delete(conn));
        return;
      }
      const m = url.pathname.match(/^\/toolbox\/([^/]+)\/process\/pty\/([^/]+)\/connect$/);
      const b = boxes.find((x) => x.id === m?.[1]);
      const sh = sandboxShell(b.home, bin, { TERM: "xterm-256color" });
      shells.set(m[2], sh);
      sh.stdout.on("data", (d) => conn.binary(d));
      sh.stderr.on("data", (d) => conn.binary(d));
      sh.on("exit", (code, sig) => {
        const exitCode = code ?? 128 + 1;
        conn.text(JSON.stringify({ type: "control", status: "exited", exitCode }));
        conn.close(exitCode === 0 ? 1000 : 1011, JSON.stringify({ exitCode }));
      });
      conn.onMessage((msg) => sh.stdin.write(typeof msg.data === "string" ? msg.data.replace(/\r/g, "\n") : msg.data));
      conn.text(JSON.stringify({ type: "control", status: "connected" }));
    },
  });
  servers.push(srv);
  return { srv, seen, boxes, bin };
}

function places(d, extra = {}) {
  const home = tmp();
  made.push(home);
  const pty = fakePty();
  ptys.push(pty);
  // What this office created before (sandboxes.json): the only thing that makes a sandbox "ours".
  if (extra.recorded) writeFileSync(join(home, "sandboxes.json"), JSON.stringify({ v: 1, sandboxes: extra.recorded.map((id) => ({ provider: "daytona", id, name: id, createdAt: new Date().toISOString() })) }));
  const ctx = fakeContext({ home, pty, env: { PATH: process.env.PATH, HOME: home, DAYTONA_API_URL: `${d.srv.url}/api`, DAYTONA_API_KEY: API_KEY, ...extra.env } });
  return { ctx, pty, home, places: M.createPlaces(ctx, { pollMs: 10, unwatchAfterMs: 50, ...extra.opts }) };
}

test("status: no login is a note; with a key, the office's own sandboxes and the user's running ones", async () => {
  const d = await fakeDaytona({
    boxes: [
      { id: "user-box-1", name: "mine", state: "started" },
      { id: "office-1", name: "agent-visualizer-old", state: "stopped", labels: { "agent-visualizer": "1" } },
      // Another office's (a teammate's): the label alone makes nothing ours.
      { id: "teammate-1", name: "agent-visualizer-alice-1", state: "started", labels: { "agent-visualizer": "1" } },
      { id: "teammate-2", name: "agent-visualizer-alice-2", state: "stopped", labels: { "agent-visualizer": "1" } },
    ],
  });
  const none = M.createPlaces(fakeContext({ home: tmp(), env: { HOME: tmp() } }));
  const row0 = (await none.status()).find((p) => p.kind === "daytona");
  assert.equal(row0.ready, false);
  assert.match(row0.note, /not logged in/);
  const { places: p } = places(d, { recorded: ["office-1"] });
  const row = (await p.status()).find((x) => x.kind === "daytona");
  assert.equal(row.ready, true);
  assert.equal(row.canCreate, true);
  assert.equal(row.via, "DAYTONA_API_KEY");
  const byId = Object.fromEntries(row.sandboxes.map((s) => [s.id, s]));
  assert.deepEqual([byId["office-1"].ours, byId["office-1"].status], [true, "stopped"]);
  assert.deepEqual([byId["user-box-1"].ours, byId["user-box-1"].status], [false, "running"]);
  assert.deepEqual([byId["teammate-1"].ours, byId["teammate-1"].status], [false, "running"]);
  assert.equal(byId["teammate-2"], undefined, "someone else's stopped sandbox isn't listed");
  await assert.rejects(p.deleteSandbox("daytona", "teammate-1"), (e) => e.status === 409);
  assert.equal(d.seen.deletes.length, 0);
});

test("create: agent-visualizer- name, label, delete-on-stop, TTL; recorded before it's up; watched; attach hands keys over by env file", async () => {
  const d = await fakeDaytona();
  const { places: p, ctx, home } = places(d);
  const steps = [];
  const changes = [];
  p.onChange((rows) => changes.push(rows));
  const place = await p.open({ kind: "daytona", target: "new" }, { agent: "claude", sandbox: { name: "Demo" }, progress: (s, x) => steps.push([s, x]) });
  assert.deepEqual(d.seen.creates[0], { name: "agent-visualizer-demo", labels: { "agent-visualizer": "1" }, autoStopInterval: 15, autoDeleteInterval: 0, ttlMinutes: 30 });
  assert.equal(steps[0][1], "Creating Daytona sandbox…");
  assert.equal(place.ours, true);
  assert.equal(place.host.id, `daytona:${d.boxes[0].id}`);
  const reg = JSON.parse(readFileSync(join(home, "sandboxes.json"), "utf8"));
  assert.deepEqual(reg.sandboxes.map((r) => [r.provider, r.id, r.name]), [["daytona", d.boxes[0].id, "agent-visualizer-demo"]]);
  assert.equal(statSync(join(home, "sandboxes.json")).mode & 0o777, 0o600);
  assert.equal(ctx.watched.length, 1);
  assert.equal(ctx.watched[0].target.host.id, place.host.id);
  await until(() => changes.length > 0, 3000, "onChange after create");

  assert.equal((await place.target.exec("echo polled; echo noise >&2")).trim(), "polled", "the watcher's exec drops stderr");
  const got = await place.ensureAgent("claude", () => {});
  assert.equal(got.bin, "claude");
  await place.firstRun("claude", place.cwd);
  assert.ok(existsSync(join(d.boxes[0].home, ".claude.json")), "office sandboxes get first-run seeding");

  const launch = { argv: ["claude", "--permission-mode", "default", { env: "AO_PROMPT" }], cwd: place.cwd, env: { ANTHROPIC_API_KEY: KEY, AO_PROMPT: "hello there" }, secret: ["ANTHROPIC_API_KEY"] };
  const term = await place.attach(launch, { cols: 90, rows: 25 });
  const out = collect(term);
  await until(() => out.text().includes("{"), 5000, "agent output");
  const line = out.text().slice(out.text().indexOf("{"));
  const hello = JSON.parse(line.split("\n")[0]);
  assert.equal(hello.keys.ANTHROPIC_API_KEY, KEY);
  assert.equal(hello.prompt, "hello there");
  assert.deepEqual(hello.argv, ["--permission-mode", "default", "hello there"]);
  assert.equal(hello.term, "xterm-256color");
  assert.deepEqual(hello.files.filter((f) => f.endsWith(".env")), []);
  term.resize(132, 40);
  await until(() => d.seen.resizes.length, 3000, "resize");
  assert.deepEqual(d.seen.resizes[0], { cols: 132, rows: 40 });
  term.write("ping\r");
  await until(() => out.text().includes("got:ping"), 5000, "echo");
  term.write("quit\r");
  const exit = await out.done;
  assert.equal(exit.code, 3);
  await until(() => d.seen.ptyDeletes.length, 3000, "PTY session deleted after exit");

  // Where the key went, and where it didn't.
  const envExec = d.seen.executes.find((e) => e.envs?.AO_ENV);
  assert.ok(envExec.envs.AO_ENV.includes(KEY), "the key rode one execute's per-command envs");
  assert.ok(d.seen.executes.every((e) => !e.command.includes(KEY)), "never in an execute command");
  assert.deepEqual(d.seen.ptys[0].envs, { TERM: "xterm-256color" }, "PTY envs are echoed by GET: no key there");
  assert.ok(!JSON.stringify(d.seen.ptys).includes(KEY));
  const typed = d.srv.conns[0].received.map((m) => String(m.data)).join("");
  assert.ok(typed.startsWith(" exec sh -c '"), "typed into the login shell, with a leading space");
  assert.ok(!typed.includes(KEY) && !typed.includes("hello there"), "no key or prompt in the typed line");
  assert.equal(d.srv.requests.find((r) => r.method === "UPGRADE").headers["sec-websocket-protocol"], "X-Daytona-Pty-Exit-Control");

  const alive = place.keepAlive();
  await until(() => d.seen.beats >= 1, 3000, "heartbeat");
  alive.dispose();
  place.close();
  await until(() => ctx.watched[0].disposed, 3000, "watch released after close");
});

test("the cost guard: a fourth office sandbox is a 409 naming the three", async () => {
  const d = await fakeDaytona({
    boxes: [
      ...[1, 2, 3].map((i) => ({ id: `ours-${i}`, name: `agent-visualizer-${i}`, state: "started", labels: { "agent-visualizer": "1" } })),
      ...[1, 2, 3].map((i) => ({ id: `theirs-${i}`, name: `agent-visualizer-alice-${i}`, state: "started", labels: { "agent-visualizer": "1" } })),
    ],
  });
  const { places: p } = places(d, { recorded: ["ours-1", "ours-2", "ours-3"] });
  await assert.rejects(
    p.open({ kind: "daytona", target: "new" }, { agent: "claude", progress: () => {} }),
    (e) => e.status === 409 && /already runs 3 sandboxes it created \(agent-visualizer-1, agent-visualizer-2, agent-visualizer-3\)/.test(e.message),
  );
  assert.equal(d.seen.creates.length, 0);
});

test("delete: the office's own without force, anyone else's only with force; timeouts are clamped", async () => {
  const d = await fakeDaytona({ boxes: [{ id: "user-box", name: "mine", state: "started" }] });
  const { places: p } = places(d);
  await assert.rejects(p.deleteSandbox("daytona", "user-box"), (e) => e.status === 409);
  assert.equal(d.seen.deletes.length, 0);
  await p.deleteSandbox("daytona", "user-box", true);
  assert.deepEqual(d.seen.deletes, ["user-box"]);
  const place = await p.open({ kind: "daytona", target: "new" }, { agent: "claude", sandbox: { timeoutMin: 9999 }, progress: () => {} });
  assert.equal(d.seen.creates[0].ttlMinutes, 240);
  await p.deleteSandbox("daytona", place.host.id.slice("daytona:".length));
  assert.equal(d.seen.deletes.length, 2);
  // An existing sandbox that isn't running can't be opened.
  d.boxes.push({ id: "stopped-1", name: "zzz", state: "stopped" });
  await assert.rejects(p.open({ kind: "daytona", target: "stopped-1" }, { agent: "claude", progress: () => {} }), (e) => e.status === 409 && /is stopped/.test(e.message));
  await assert.rejects(p.open({ kind: "daytona", target: "missing" }, { agent: "claude", progress: () => {} }), (e) => e.status === 404);
});

test("when the toolbox PTY won't connect, `daytona ssh` under a local PTY gets the same typed line", async () => {
  const d = await fakeDaytona({ boxes: [{ id: "user-box", name: "mine", state: "started" }], wsReject: () => 404 });
  const cliDir = tmp();
  made.push(cliDir);
  const box = d.boxes[0];
  box.home = tmp();
  made.push(box.home);
  // The fake CLI is a login shell in the sandbox's home.
  const cli = writeBin(cliDir, "daytona", `const { spawn } = require("child_process");
require("fs").writeFileSync(${JSON.stringify(join(cliDir, "argv.json"))}, JSON.stringify(process.argv.slice(2)));
const sh = spawn("sh", [], { stdio: ["pipe", "inherit", "inherit"], cwd: ${JSON.stringify(box.home)}, env: { PATH: ${JSON.stringify(d.bin)} + ":" + process.env.PATH, HOME: ${JSON.stringify(box.home)} } });
process.stdin.on("data", (c) => sh.stdin.write(String(c).replace(/\\r/g, "\\n")));
sh.on("exit", (c) => process.exit(c ?? 1));`);
  const { places: p, pty } = places(d, { opts: { bins: { daytona: cli } } });
  const place = await p.open({ kind: "daytona", target: "user-box" }, { agent: "claude", progress: () => {} });
  assert.equal(place.ours, false);
  await place.firstRun("claude", place.cwd);
  assert.equal(existsSync(join(box.home, ".claude.json")), false, "no seeding in the user's own sandbox");
  const term = await place.attach({ argv: ["claude"], cwd: place.cwd, env: { ANTHROPIC_API_KEY: KEY }, secret: ["ANTHROPIC_API_KEY"] }, { cols: 80, rows: 24 });
  const out = collect(term);
  await until(() => out.text().includes("{"), 5000, "agent output via the CLI");
  assert.equal(JSON.parse(out.text().slice(out.text().indexOf("{")).split("\n")[0]).keys.ANTHROPIC_API_KEY, KEY);
  assert.deepEqual(JSON.parse(readFileSync(join(cliDir, "argv.json"), "utf8")), ["ssh", "user-box"]);
  assert.ok(!JSON.stringify(pty.spawns[0].args).includes(KEY));
  assert.ok(!pty.spawns[0].writes.join("").includes(KEY), "the typed line has no key");
  assert.ok(d.seen.ptys.length === 1 && d.seen.ptyDeletes.length === 1, "the unused toolbox PTY was cleaned up");
  term.write("quit\r");
  assert.equal((await out.done).code, 3);
  assert.deepEqual(readdirSync(join(box.home, ".agent-visualizer/run")).filter((f) => f.endsWith(".env")), []);
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

test("chat: a toolbox session command of its own; the key by env file; whole lines in order; stdout and stderr apart; exit code; the session goes", async () => {
  const d = await fakeDaytona();
  const { places: p } = places(d);
  const place = await p.open({ kind: "daytona", target: "new" }, { agent: "claude", progress: () => {} });
  const pipe = await place.pipe(CHAT(place.cwd));
  const io = piped(pipe);
  await until(() => io.out().includes("\n"), 5000, "first line");
  const hello = JSON.parse(io.out().split("\n")[0]);
  assert.equal(hello.keys.ANTHROPIC_API_KEY, KEY);
  assert.deepEqual(hello.argv, ["-p"]);
  assert.ok(!hello.files.some((f) => f.endsWith(".env")), "the env file was read and deleted before the agent started");
  assert.ok(hello.files.some((f) => f.endsWith(".pid")), "the pid file, for SIGTERM");
  pipe.write("pi");
  pipe.write(new TextEncoder().encode("ng\nhalf"));
  pipe.write("-line\nünï ✓\n");
  await until(() => io.out().includes("got:ünï ✓"), 5000, "the lines back");
  assert.match(io.out(), /got:ping\ngot:half-line\ngot:ünï ✓\n/, "in order, none cut where a write ended");
  assert.deepEqual(d.seen.inputs, ["ping\n", "half-line\nünï ✓\n"], "only whole lines go to /input");
  assert.match(io.err(), /err:ping\nerr:half-line\nerr:ünï ✓\n/);
  assert.ok(!io.out().includes("err:"), "stderr stays apart");
  pipe.write("quit\n");
  assert.equal((await io.done).code, 3);

  const session = d.seen.sessions[0];
  assert.match(session, /^ao-[0-9a-f]{12}$/);
  const exec = d.seen.sessionExecs[0];
  assert.equal(exec.runAsync, true);
  assert.equal(exec.suppressInputEcho, true);
  assert.ok(exec.command.startsWith("sh -c '"));
  assert.ok(!exec.command.includes(KEY), "no key in the session command");
  assert.ok(d.seen.executes.find((e) => e.envs?.AO_ENV)?.envs.AO_ENV.includes(KEY), "the key rode one execute's per-command envs");
  assert.deepEqual(d.seen.logOpens[0], { follow: "true", version: "0.167.0" }, "stdout and stderr tagged apart");
  assert.equal(d.seen.logOpens.length, 2, "the log read once more after the exit, before the session goes");
  await until(() => d.seen.sessionDeletes.includes(session), 3000, "the session (and its log) deleted after the exit");
  await until(() => readdirSync(join(d.boxes[0].home, ".agent-visualizer/run")).length === 0, 3000, "pid file cleaned up");
});

test("chat: a log socket that drops while the agent runs is opened again, and nothing comes twice", async () => {
  const d = await fakeDaytona({ dropLogs: 1 });
  const { places: p } = places(d);
  const place = await p.open({ kind: "daytona", target: "new" }, { agent: "claude", progress: () => {} });
  const pipe = await place.pipe(CHAT(place.cwd));
  const io = piped(pipe);
  await until(() => io.out().includes("\n"), 5000, "first line");
  pipe.write("one\n");
  await until(() => io.out().includes("got:one"), 5000, "echo");
  await until(() => d.seen.logOpens.length >= 2, 8000, "the socket reopened");
  pipe.write("two\n");
  await until(() => io.out().includes("got:two"), 5000, "echo after the reopen");
  assert.equal(io.out().split('"argv"').length - 1, 1, "the replayed first line was skipped");
  assert.equal(io.out().split("got:one").length - 1, 1);
  assert.equal(io.err().split("err:one").length - 1, 1);
  pipe.kill("SIGKILL");
  const e = await io.done;
  assert.notEqual(e.code, 0);
  assert.ok(d.seen.sessionDeletes.length >= 1, "SIGKILL deletes the session");
});

test("chat: end() is SIGTERM through the pid file (a session command's stdin can't be closed)", async () => {
  const d = await fakeDaytona();
  const { places: p } = places(d);
  const place = await p.open({ kind: "daytona", target: "new" }, { agent: "claude", progress: () => {} });
  const pipe = await place.pipe({ ...CHAT(place.cwd), env: {} });
  const io = piped(pipe);
  await until(() => io.out().includes("\n"), 5000, "first line");
  assert.equal(d.seen.executes.filter((e) => e.envs?.AO_ENV).length, 0, "no env file without keys");
  pipe.end();
  assert.equal((await io.done).code, 143);
  assert.ok(d.seen.executes.some((e) => /kill -TERM/.test(e.command)), "signalled by its pid");
});

test("the log demuxer: markers cut across frames, and a replay skips what was delivered", () => {
  const got = [];
  const dm = new LogDemux((s, b) => got.push([s, Buffer.from(b).toString()]));
  const f = (...parts) => Buffer.concat(parts.map((p) => (typeof p === "number" ? Buffer.from([p]) : Buffer.from(p))));
  dm.feed(f(1, 1, 1, "out-a\n", 2, 2));
  dm.feed(f(2, "err-a\n", 1));
  dm.feed(f(1, 1, "out-b\n"));
  assert.deepEqual(got, [[1, "out-a\n"], [2, "err-a\n"], [1, "out-b\n"]]);
  got.length = 0;
  dm.replay();
  dm.feed(f(1, 1, 1, "out-a\n", 2, 2, 2, "err-a\n", 1, 1, 1, "out-b\nout-c\n"));
  assert.deepEqual(got, [[1, "out-c\n"]], "only what's new after the replay");
});

test("chat: an agent that finishes while its log socket is down still gets its last words through, then its exit", async () => {
  const d = await fakeDaytona({ dropOnInput: "last" });
  const { places: p } = places(d);
  const place = await p.open({ kind: "daytona", target: "new" }, { agent: "claude", progress: () => {} });
  const pipe = await place.pipe(CHAT(place.cwd));
  const io = piped(pipe);
  await until(() => io.out().includes("\n"), 5000, "first line");
  pipe.write("last\nbye\n");
  assert.equal((await io.done).code, 4);
  assert.match(io.out(), /got:last\nbye!\n/, "printed while the socket was down, read from the replay");
  assert.match(io.err(), /err:last\n/);
  assert.equal(io.out().split('"argv"').length - 1, 1, "and nothing twice");
  assert.ok(d.seen.logOpens.length >= 2);
});

test("chat: what the replay brings with the upgrade, before anyone has subscribed, still arrives", async () => {
  const d = await fakeDaytona({ execWaits: true });
  const { places: p } = places(d);
  const place = await p.open({ kind: "daytona", target: "new" }, { agent: "claude", progress: () => {} });
  // Fails at once: by the time the log socket opens, all there is comes as its replay.
  const pipe = await place.pipe({ argv: ["no-such-agent"], cwd: place.cwd, env: {}, secret: [] });
  const io = piped(pipe);
  assert.equal((await io.done).code, 127);
  assert.match(io.err(), /no-such-agent/, "the shell's reason reached stderr's listener");
});

test("chat: a socket closed with 1000 just before the agent's last words (a clean cut) still gets them through", async () => {
  const d = await fakeDaytona({ closeOnInput: "last" });
  const { places: p } = places(d);
  const place = await p.open({ kind: "daytona", target: "new" }, { agent: "claude", progress: () => {} });
  const pipe = await place.pipe(CHAT(place.cwd));
  const io = piped(pipe);
  await until(() => io.out().includes("\n"), 5000, "first line");
  pipe.write("last\nbye\n");
  assert.equal((await io.done).code, 4);
  assert.match(io.out(), /got:last\nbye!\n/);
  assert.equal(io.out().split('"argv"').length - 1, 1, "nothing twice");
});
