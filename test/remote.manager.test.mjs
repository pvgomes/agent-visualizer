// Tests for src/remote/index.ts (the remote manager) and src/remote/config.ts, with fake platforms
// and a fake clock: discovery adding and removing hosts (workers sent home), a failed listing
// keeping them, health (backoff, offline after two failures with a "remote offline" event per
// worker, back online), dormancy for sandboxes that polling would keep awake (refused polls,
// woken by provider activity or by a peek that finds a fresh transcript), auto-detection,
// explicit selectors, config.json, and one real ingest loop driven through the manager.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { fakeHome, load, tmp, until } from "./remote.fakes.mjs";

const M = await load("src/remote/index.ts", "src/remote/util.ts");

const MIN = 60_000;

function fakeProvider(kind, { keepsAwake = false, available = { ok: true }, autoDetect } = {}) {
  const p = {
    kind,
    label: kind[0].toUpperCase() + kind.slice(1),
    keepsAwake,
    ...(autoDetect === undefined ? {} : { autoDetect }),
    found: [],
    fail: null,
    lists: 0,
    scopes: [],
    available: () => available,
    async list(scope) {
      p.lists++;
      p.scopes.push(scope);
      if (p.fail) throw p.fail;
      return p.found;
    },
  };
  return p;
}

/** A target that answers `out` (or throws `t.err`), counting execs and closes. */
function fakeTarget(kind, id, name = id) {
  const t = {
    host: { kind, id: `${kind}:${id}`, name },
    execs: 0,
    closed: 0,
    err: null,
    async exec() {
      t.execs++;
      if (t.err) throw t.err;
      return "ok\n";
    },
    close() {
      t.closed++;
    },
  };
  return t;
}

/** A target that really runs sh here, under `home`. */
function shTarget(kind, id, home) {
  return {
    host: { kind, id: `${kind}:${id}`, name: id },
    exec: (script) =>
      new Promise((resolve, reject) =>
        execFile("sh", ["-c", script], { env: { PATH: process.env.PATH, HOME: home, LC_ALL: "C" }, maxBuffer: 64 << 20 }, (err, out) => (err ? reject(err) : resolve(out))),
      ),
  };
}

function harness(opts = {}) {
  let clock = Date.parse("2026-10-18T09:00:00Z");
  const events = [];
  const logs = [];
  const watches = [];
  const r = M.startRemotes({
    agents: ["claude", "codex"],
    timers: false,
    readyWaitMs: 50,
    now: () => clock,
    onEvent: (e) => events.push(e),
    log: (msg, level) => logs.push(`${level}: ${msg}`),
    watch: (target, agents, onEvent, log, wo) => {
      const w = { target, agents, onEvent, pollMs: wo?.pollMs, stopped: false, stop: () => (w.stopped = true) };
      watches.push(w);
      return w;
    },
    ...opts,
  });
  return { r, events, logs, watches, advance: (ms) => (clock += ms), now: () => clock };
}

const err = (code, message) => Object.assign(new Error(message), { code });

const ev = (host, workerId, kind = "tool_start", extra = {}) => ({ ts: "2026-10-18T09:00:00.000Z", agent: "claude", workerId: `${host.id}/${workerId}`, project: "api", host, kind, ...extra });

test("discovery: hosts come with their own watcher, leave with their workers sent home", async () => {
  const p = fakeProvider("daytona");
  const a = fakeTarget("daytona", "aaa", "swarm-01");
  const b = fakeTarget("daytona", "bbb", "swarm-02");
  p.found = [{ host: a.host, target: a }];
  const h = harness({ providers: [p] });
  await h.r.ready;
  assert.equal(h.watches.length, 1);
  assert.deepEqual(h.watches[0].target.host, a.host);
  assert.deepEqual(h.watches[0].agents, ["claude", "codex"]);
  assert.deepEqual(h.r.summary(), { watching: ["1 Daytona"], problems: [] });

  // Events pass through untouched; the manager remembers the host's top-level workers.
  h.watches[0].onEvent(ev(a.host, "s1", "session_start", { cwd: "/home/daytona/api", model: "claude-opus-5-5" }));
  h.watches[0].onEvent(ev(a.host, "intern", "subagent_start", { parentId: `${a.host.id}/s1` }));
  assert.equal(h.events.length, 2);

  p.found = [{ host: b.host, target: b }];
  await h.r.tick();
  assert.equal(h.watches.length, 2);
  assert.ok(h.watches[0].stopped && a.closed === 1, "the old watcher stopped, its target closed");
  const home = h.events.filter((e) => e.kind === "session_end");
  assert.deepEqual(home.map((e) => [e.workerId, e.host.id, e.cwd, e.model]), [[`${a.host.id}/s1`, a.host.id, "/home/daytona/api", "claude-opus-5-5"]]);
  assert.ok(h.logs.some((l) => /swarm-01 stopped; its workers went home/.test(l)));
  assert.ok(h.logs.some((l) => /swarm-02 is up/.test(l)));

  // A failed listing is not a stopped sandbox.
  p.fail = err("unreachable", "Daytona sandboxes: 503");
  await h.r.tick();
  assert.equal(h.watches.filter((w) => !w.stopped).length, 1);
  assert.deepEqual(h.r.summary().problems, ["Daytona sandboxes: 503"]);
  p.fail = null;
  await h.r.tick();
  assert.deepEqual(h.r.summary().problems, []);
  h.r.stop();
  assert.ok(h.watches[1].stopped && b.closed === 1);
});

test("health: backoff without exec, offline after two failures (remote offline per worker), then back", async () => {
  const p = fakeProvider("railway");
  const t = fakeTarget("railway", "r1", "api:r1");
  p.found = [{ host: t.host, target: t }];
  const h = harness({ providers: [p] });
  await h.r.ready;
  const g = h.watches[0].target;
  assert.equal(await g.exec("x"), "ok\n");
  assert.equal(h.r.hosts()[0].status, "online");
  h.watches[0].onEvent(ev(t.host, "s1", "session_start"));
  h.watches[0].onEvent(ev(t.host, "s2", "session_start", { agent: "codex" }));

  t.err = err("timeout", "Railway api:r1: timed out");
  await assert.rejects(g.exec("x"));
  assert.equal(h.r.hosts()[0].status, "online", "one blip is not offline");
  const execs = t.execs;
  await assert.rejects(g.exec("x"), /timed out/);
  assert.equal(t.execs, execs, "inside the backoff window nothing is sent");
  h.advance(3_000);
  await assert.rejects(g.exec("x"));
  const [st] = h.r.hosts();
  assert.equal(st.status, "offline");
  assert.equal(st.online, false);
  assert.match(st.error, /timed out/);
  const notes = h.events.filter((e) => e.kind === "error");
  assert.deepEqual(notes.map((e) => [e.workerId, e.summary, e.isError, e.agent]), [
    [`${t.host.id}/s1`, "remote offline", true, "claude"],
    [`${t.host.id}/s2`, "remote offline", true, "codex"],
  ]);
  assert.ok(h.logs.some((l) => /^warn: Railway api:r1 is offline/.test(l)));
  assert.match(h.r.summary().problems[0], /api:r1/);

  t.err = null;
  h.advance(60_000);
  assert.equal(await g.exec("x"), "ok\n");
  assert.equal(h.r.hosts()[0].status, "online");
  assert.ok(h.logs.some((l) => /api:r1 is back/.test(l)));
  assert.deepEqual(h.events.filter((e) => e.kind === "idle").map((e) => e.workerId), [`${t.host.id}/s1`, `${t.host.id}/s2`], "an idle pose lifts the offline look");
  assert.deepEqual(h.r.summary().problems, []);
  h.r.stop();
});

test("dormancy: a quiet sandbox that polling would keep awake is left alone, and woken by activity", async () => {
  const p = fakeProvider("daytona", { keepsAwake: true });
  const t = fakeTarget("daytona", "d1", "swarm");
  const d = { host: t.host, target: t, idleStopMin: 15, activityAt: 1000 };
  p.found = [d];
  const h = harness({ providers: [p] });
  await h.r.ready;
  const g = h.watches[0].target;
  await g.exec("x");
  h.advance(9 * MIN);
  await h.r.tick();
  assert.equal(h.r.hosts()[0].status, "online", "not yet: 15 min idle timeout -> quiet for 10 min");
  h.advance(2 * MIN);
  await h.r.tick();
  assert.equal(h.r.hosts()[0].status, "dormant");
  assert.equal(h.r.hosts()[0].online, true);
  assert.ok(h.logs.some((l) => /swarm is quiet: checking it every 20 min/.test(l)));
  const n = t.execs;
  await assert.rejects(g.exec("x"), /resting/);
  assert.equal(t.execs, n, "dormant polls never reach the sandbox");
  // Our own last polls may show up in lastActivityAt a round late: absorbed, no wake.
  d.activityAt = 2000;
  await h.r.tick();
  assert.equal(h.r.hosts()[0].status, "dormant");
  // Someone else touches the sandbox: wake straight away.
  d.activityAt = 3000;
  await h.r.tick();
  assert.equal(h.r.hosts()[0].status, "online");
  assert.ok(h.logs.some((l) => /swarm woke up \(activity\)/.test(l)));
  assert.equal(await g.exec("x"), "ok\n");
  h.r.stop();
});

test("dormancy: a peek every idle timeout + 5 min, waking on a fresh transcript", async () => {
  const p = fakeProvider("railway", { keepsAwake: true });
  const home = tmp();
  const t = shTarget("railway", "r1", home);
  p.found = [{ host: t.host, target: t, idleStopMin: 30 }];
  const h = harness({ providers: [p] });
  await h.r.ready;
  assert.equal(await h.watches[0].target.exec("exit 0\n"), "");
  h.advance(21 * MIN);
  await h.r.tick();
  assert.equal(h.r.hosts()[0].status, "dormant");
  // Nothing new on the first peek: stays dormant.
  h.advance(36 * MIN);
  await h.r.tick();
  assert.equal(h.r.hosts()[0].status, "dormant");
  // An agent starts writing a transcript; the next peek finds it.
  const dir = join(home, ".claude", "projects", "-root-api");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "11111111-2222-4333-8444-555555555555.jsonl"), "{}\n");
  h.advance(10 * MIN);
  await h.r.tick();
  assert.equal(h.r.hosts()[0].status, "dormant", "not peeked again yet");
  h.advance(26 * MIN);
  await h.r.tick();
  assert.equal(h.r.hosts()[0].status, "online");
  assert.ok(h.logs.some((l) => /woke up \(new transcripts\)/.test(l)));
  h.r.stop();
});

test("a platform with a tight API quota is listed at its own pace, and its watchers poll slower", async () => {
  const p = fakeProvider("railway");
  p.discoverMs = 120_000;
  const t = fakeTarget("railway", "r1");
  p.found = [{ host: t.host, target: t, pollMs: 9_730 }];
  const h = harness({ providers: [p] });
  await h.r.ready;
  assert.equal(p.lists, 1);
  assert.equal(h.watches[0].pollMs, 9_730);
  h.advance(30_000);
  await h.r.tick();
  assert.equal(p.lists, 1, "not yet");
  h.advance(91_000);
  await h.r.tick();
  assert.equal(p.lists, 2);
  h.r.stop();
});

test("never dormant: platforms whose sandboxes stop on a timer anyway, or with no idle timeout", async () => {
  const v = fakeProvider("vercel");
  const d = fakeProvider("daytona", { keepsAwake: true });
  const vt = fakeTarget("vercel", "v1");
  const dt = fakeTarget("daytona", "d1");
  v.found = [{ host: vt.host, target: vt }];
  d.found = [{ host: dt.host, target: dt, idleStopMin: 0 }];
  const h = harness({ providers: [v, d] });
  await h.r.ready;
  for (const w of h.watches) await w.target.exec("x");
  h.advance(3 * 60 * MIN);
  await h.r.tick();
  assert.deepEqual(h.r.hosts().map((x) => x.status), ["online", "online"]);
  h.r.stop();
});

test("auto-detect uses platforms with a login; explicit selectors pick sandboxes and report misses", async () => {
  const yes = fakeProvider("daytona");
  const no = fakeProvider("boat", { available: { ok: false, why: "not logged in" } });
  const t1 = fakeTarget("daytona", "abcd1234", "one");
  const t2 = fakeTarget("daytona", "efgh5678", "two");
  yes.found = [{ host: t1.host, target: t1 }, { host: t2.host, target: t2 }];
  const h = harness({ providers: [yes, no] });
  await h.r.ready;
  assert.equal(no.lists, 0, "no login, not even listed");
  assert.equal(h.watches.length, 2);
  h.r.stop();

  // --no-cloud: nothing auto; explicit ones still work, even for a platform without a detectable login.
  no.found = [];
  const h2 = harness({ providers: [yes, no], autoDetect: false, selectors: [{ kind: "daytona", id: "two" }, { kind: "boat", id: "bx_missing1" }] });
  await h2.r.ready;
  assert.deepEqual(h2.watches.map((w) => w.target.host.name), ["two"]);
  assert.deepEqual(h2.r.summary(), { watching: ["1 Daytona"], problems: ['Boat "bx_missing1": not found, or not running'] });
  h2.r.stop();

  // A platform that has nothing set up stays quiet when auto-detected, speaks up when asked for.
  const missing = fakeProvider("vercel");
  missing.fail = err("missing", "Vercel Sandbox: not logged in");
  const h3 = harness({ providers: [missing] });
  await h3.r.ready;
  assert.deepEqual(h3.r.summary().problems, []);
  const h4 = harness({ providers: [missing], selectors: [{ kind: "vercel", id: "all" }] });
  await h4.r.ready;
  assert.deepEqual(h4.r.summary().problems, ["Vercel Sandbox: not logged in"]);
});

test("auto-detection asks for the user's own scope; a selector asks for all; boat is never auto-detected", async () => {
  const v = fakeProvider("vercel");
  const boat = fakeProvider("boat", { autoDetect: false });
  const h = harness({ providers: [v, boat] });
  await h.r.ready;
  assert.deepEqual(v.scopes, ["auto"]);
  assert.equal(boat.lists, 0, "boat keeps every exec's output: only on request");
  h.r.stop();
  const v2 = fakeProvider("vercel");
  const boat2 = fakeProvider("boat", { autoDetect: false });
  const h2 = harness({ providers: [v2, boat2], selectors: [{ kind: "vercel", id: "all" }, { kind: "boat", id: "all" }] });
  await h2.r.ready;
  assert.deepEqual([v2.scopes, boat2.scopes], [["all"], ["all"]]);
  h2.r.stop();
});

test("a throttled exec (our own API budget) backs off without calling the sandbox offline", async () => {
  const p = fakeProvider("railway");
  const t = fakeTarget("railway", "r1", "api:r1");
  p.found = [{ host: t.host, target: t }];
  const h = harness({ providers: [p] });
  await h.r.ready;
  const g = h.watches[0].target;
  await g.exec("x");
  h.watches[0].onEvent(ev(t.host, "s1", "session_start"));
  t.err = err("throttled", "pausing to stay well inside Railway's API rate limit");
  for (let i = 0; i < 5; i++) await assert.rejects(g.exec("x"), (e) => e.code === "throttled");
  assert.equal(h.r.hosts()[0].status, "online");
  assert.ok(!h.events.some((e) => e.summary === "remote offline"));
  // A throttled listing is quiet too.
  p.fail = err("throttled", "budget");
  h.advance(60_000);
  await h.r.tick();
  assert.deepEqual(h.r.summary().problems, []);
  h.r.stop();
});

test("ssh selectors: one target each, its first answer in the summary", async () => {
  const good = fakeTarget("ssh", "me@box", "box");
  const bad = fakeTarget("ssh", "shubham", "shubham");
  bad.err = err("auth", "ssh shubham: host key changed or unknown (check it, then fix ~/.ssh/known_hosts)");
  const h = harness({
    providers: [],
    selectors: [{ kind: "ssh", id: "me@box" }, { kind: "ssh", id: "shubham" }, { kind: "ssh", id: "-oProxyCommand=x" }],
    sshTarget: (sel) => {
      if (sel.id.startsWith("-")) throw new Error("doesn't look like an ssh host");
      return sel.id === "shubham" ? bad : good;
    },
  });
  await Promise.all(h.watches.map((w) => w.target.exec("x").catch(() => {})));
  await h.r.ready;
  const s = h.r.summary();
  assert.deepEqual(s.watching, ["ssh box", "ssh shubham"]);
  assert.ok(s.problems.some((p) => /^ssh -oProxyCommand=x: /.test(p)));
  assert.ok(s.problems.some((p) => /ssh shubham: host key changed/.test(p)));
  assert.deepEqual(h.r.hosts().map((x) => x.status), ["online", "offline"]);
  assert.equal(h.logs.length, 0, "before the banner, problems go in the summary, not the log");
  h.r.stop();
});

test("config.json: remotes, cloud: false, and what's wrong with bad entries", () => {
  const home = tmp();
  const env = { HOME: home, AGENT_VISUALIZER_HOME: join(home, ".ao") };
  assert.deepEqual(M.readRemoteConfig(env), { selectors: [], problems: [] });
  mkdirSync(join(home, ".ao"));
  writeFileSync(join(home, ".ao", "config.json"), JSON.stringify({
    cloud: false,
    theme: "dark",
    remotes: [
      { ssh: "me@box" },
      { ssh: "gpu", env: { CLAUDE_CONFIG_DIR: "/data/claude", N: 1 } },
      { daytona: "all" },
      { boat: true },
      { vercel: "preview-bot" },
      { railway: "" },
      { ssh: "all" },
      { daytona: "a", vercel: "b" },
      "box",
    ],
  }));
  const c = M.readRemoteConfig(env);
  assert.equal(c.cloud, false);
  assert.deepEqual(c.selectors, [
    { kind: "ssh", id: "me@box" },
    { kind: "ssh", id: "gpu", env: { CLAUDE_CONFIG_DIR: "/data/claude" } },
    { kind: "daytona", id: "all" },
    { kind: "boat", id: "all" },
    { kind: "vercel", id: "preview-bot" },
  ]);
  assert.equal(c.problems.length, 4);
  writeFileSync(join(home, ".ao", "config.json"), "{ not json");
  assert.deepEqual(M.readRemoteConfig(env).selectors, []);
  assert.deepEqual(M.mergeSelectors([{ kind: "ssh", id: "a" }], [{ kind: "ssh", id: "a" }, { kind: "boat", id: "all" }]), [{ kind: "ssh", id: "a" }, { kind: "boat", id: "all" }]);
  assert.deepEqual(Object.keys(M.REMOTE_FACTORIES).sort(), ["boat", "daytona", "railway", "ssh", "vercel"]);
});

test("through the manager with the real ingest watcher: a sandbox's workers walk in", async () => {
  const p = fakeProvider("vercel");
  const t = shTarget("vercel", "agent-visualizer-test", fakeHome());
  p.found = [{ host: t.host, target: t }];
  const events = [];
  const r = M.startRemotes({ agents: ["claude", "codex"], providers: [p], timers: false, onEvent: (e) => events.push(e) });
  await r.ready;
  await until(() => events.filter((e) => e.kind === "session_start").length >= 2, 10_000, "remote session_starts");
  r.stop();
  assert.ok(events.every((e) => e.host.id === "vercel:agent-visualizer-test" && e.workerId.startsWith("vercel:agent-visualizer-test/")));
  assert.deepEqual(r.hosts(), []);
});

test("a CLI that is a .cmd on Windows: npm's shim runs its script with node, any other goes through cmd.exe quoted", async () => {
  assert.deepEqual(M.spawnLine("/usr/bin/railway", ["list", "--json"], "linux"), { file: "/usr/bin/railway", args: ["list", "--json"], cmd: false });
  assert.deepEqual(M.spawnLine("C:\\bin\\railway.exe", ["a b"], "win32"), { file: "C:\\bin\\railway.exe", args: ["a b"], cmd: false });
  assert.deepEqual(M.spawnLine("C:\\Program Files (x86)\\npm\\railway.cmd", ["sandbox", "list", "--json", "-p", "a b&c", ""], "win32", { SystemRoot: "C:\\WINDOWS", ComSpec: "cmd.exe" }), {
    file: "C:\\WINDOWS\\System32\\cmd.exe",
    args: ["/d", "/s", "/c", '""C:\\Program Files (x86)\\npm\\railway.cmd" sandbox list --json -p "a b&c" """'],
    cmd: true,
  });
  for (const bad of ['say "hi"', "%PATH%", "line\nbreak", "C:\\my dir\\", "!x!"]) {
    assert.throws(() => M.spawnLine("C:\\npm\\boat.cmd", ["exec", bad], "win32"), /can't pass .* to a \.cmd on Windows/, JSON.stringify(bad));
  }
  // npm's shim (cmd-shim's own text): its script, with node, so even a multi-line sh script arrives intact.
  const dir = tmp();
  writeFileSync(join(dir, "argv.js"), "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
  const npmShim = join(dir, "railway.cmd");
  writeFileSync(npmShim, '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\argv.js" %*\r\n');
  const script = ["sandbox", "exec", "--", "sh", "-c", 'printf "%s" "$HOME"\nexit 0\n'];
  assert.deepEqual(M.spawnLine(npmShim, script, "win32"), { file: process.execPath, args: [join(dir, "argv.js"), ...script], cmd: false });
  if (process.platform !== "win32") return;
  // The real thing, both ways, started the way the railway and boat providers start their CLIs.
  const r = await M.run(npmShim, script, { timeoutMs: 20_000 });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), script);
  writeFileSync(join(dir, "other cli.cmd"), `@"${process.execPath}" "${join(dir, "argv.js")}" %*\r\n`);
  const args = ["list", "--json", "-p", "a b", "x&y|z", "(paren)", "^caret", "<in>", ""];
  const r2 = await M.run(join(dir, "other cli.cmd"), args, { timeoutMs: 20_000 });
  assert.equal(r2.code, 0, r2.stderr);
  assert.deepEqual(JSON.parse(r2.stdout), args);
});

test("Windows' own programs go by full path, and a bare name is looked up on PATH, never in the current folder", async () => {
  // By bare name Windows tries the current folder first: a taskkill.exe or cmd.exe in a cloned repo would run.
  assert.equal(M.windowsSystemBinary("taskkill.exe", { SystemRoot: "D:\\Win" }), "D:\\Win\\System32\\taskkill.exe");
  assert.equal(M.windowsSystemBinary("cmd.exe", {}), "C:\\Windows\\System32\\cmd.exe");
  assert.equal(M.windowsSystemBinary("cmd.exe", { SystemRoot: ".\\evil", windir: "C:\\WINDOWS" }), "C:\\WINDOWS\\System32\\cmd.exe", "a relative SystemRoot is ignored");
  for (const env of [{}, { SystemRoot: "relative" }, { SystemRoot: "D:\\Windows" }]) assert.ok(win32.isAbsolute(M.windowsSystemBinary("taskkill.exe", env)));
  assert.throws(() => M.spawnLine("railway", ["list"], "win32", { PATH: ".;bin", PATHEXT: ".EXE;.CMD" }), (e) => e.code === "missing", "relative PATH entries are skipped");
  if (process.platform !== "win32") return;
  // The real thing: an .exe named like the CLI in the current folder, which a bare-name spawn would have run.
  const dir = tmp();
  copyFileSync(M.windowsSystemBinary("whoami.exe"), join(dir, "agent-visualizer-evil.exe"));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await assert.rejects(M.run("agent-visualizer-evil", [], { timeoutMs: 10_000 }), (e) => e.code === "missing" && /not installed/.test(e.message));
    const ok = await M.run("whoami", [], { timeoutMs: 10_000 });
    assert.equal(ok.code, 0, "a program on PATH still runs by name");
  } finally {
    process.chdir(cwd);
  }
});

test("on Windows a CLI that times out goes with everything it started, so stdout closes", { skip: process.platform !== "win32" && "Windows only", timeout: 30_000 }, async () => {
  // A CLI that starts a long-lived child sharing its stdout, like the railway CLI's node wrapper and its native binary.
  const dir = tmp();
  writeFileSync(join(dir, "hang.js"), 'require("child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "inherit" }); setTimeout(() => {}, 60000);');
  writeFileSync(join(dir, "npm-style.cmd"), '@"%~dp0\\node.exe" "%~dp0\\hang.js" %*\r\n');
  writeFileSync(join(dir, "plain.cmd"), `@"${process.execPath}" "${join(dir, "hang.js")}" %*\r\n`);
  for (const cli of ["npm-style.cmd", "plain.cmd"]) {
    const t0 = Date.now();
    const r = await M.run(join(dir, cli), ["list"], { timeoutMs: 1_000 });
    assert.equal(r.timedOut, true, cli);
    assert.ok(Date.now() - t0 < 15_000, `${cli} came back after ${Date.now() - t0} ms`);
  }
});
