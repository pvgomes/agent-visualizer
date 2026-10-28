// Tests for src/control/pty.ts: the node-pty backend and the python3 bridge behave the same
// (bytes, resize, Ctrl+C, exit codes, signals), and the loader picks, forces and falls back.
import nodeTest, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cleanup, load, scratch, sleep, until } from "./control.session-fakes.mjs";
import { CONTROL, skipAll } from "./platform.mjs";

const test = skipAll(nodeTest, CONTROL);

const { loadPty, pythonBackend, exitOf, clampSize } = await load("src/control/pty.ts");
after(cleanup);

const nodePty = await loadPty({ force: "node-pty" });
const python = await loadPty({ force: "python" });

// Every terminal a test starts is SIGKILLed (its whole group) when the test ends, passed or not:
// one left waiting on input keeps this file's process, and so `npm test`, from ever exiting.
const live = new Set();
afterEach(async () => {
  const exits = [...live].map((term) => new Promise((r) => term.onExit(r)));
  for (const term of live) term.kill("SIGKILL");
  live.clear();
  await Promise.race([Promise.all(exits), sleep(2000)]);
});

function collect(term) {
  live.add(term);
  term.onExit(() => live.delete(term));
  const chunks = [];
  term.onData((c) => chunks.push(Buffer.from(c)));
  const exit = new Promise((r) => term.onExit(r));
  return { text: () => Buffer.concat(chunks).toString("utf8"), exit };
}

for (const [label, backend] of [["node-pty", nodePty], ["python bridge", python]]) {
  test(`${label}: output, resize with SIGWINCH, input, exit code`, { skip: !backend && `${label} not available here` }, async () => {
    const cwd = scratch();
    // Wait for the resize in short sleeps, not in `read`: bash 5.2 (Linux) holds a WINCH trap while the
    // read builtin waits on a terminal and runs it only once a line comes in; bash 3.2 (macOS) runs it at once.
    const script = 'trap \'w=1; echo "WINCH:$(tput cols)x$(tput lines)"\' WINCH; printf "h\\303\\251llo\\n"; tput cols; while [ -z "$w" ]; do sleep 0.05; done; read line; echo "got:$line"; sleep 0.3; exit 7';
    const term = backend.spawn({ file: "/bin/bash", args: ["-c", script], cwd, env: { PATH: "/usr/bin:/bin", TERM: "xterm-256color" }, cols: 80, rows: 24 });
    assert.ok(term.pid > 0);
    const out = collect(term);
    await until(() => out.text().includes("80"), 5000, "first output");
    assert.ok(out.text().includes("héllo"), "UTF-8 bytes survive");
    term.resize(132, 40);
    await until(() => out.text().includes("WINCH:132x40"), 5000, "resize");
    term.write("hello world\r");
    const e = await out.exit;
    assert.ok(out.text().includes("got:hello world"));
    assert.equal(e.code, 7);
  });

  test(`${label}: Ctrl+C reaches the job, SIGHUP and SIGKILL end it as 128+n`, { skip: !backend && `${label} not available here` }, async () => {
    const cwd = scratch();
    const t1 = backend.spawn({ file: "/bin/sh", args: ["-c", "echo up; sleep 30"], cwd, env: { PATH: "/usr/bin:/bin" }, cols: 80, rows: 24 });
    const o1 = collect(t1);
    await until(() => o1.text().includes("up"), 5000, "start");
    t1.write("\x03");
    assert.equal((await o1.exit).code, 130);

    const t2 = backend.spawn({ file: "/bin/sh", args: ["-c", "echo up; sleep 30"], cwd, env: { PATH: "/usr/bin:/bin" }, cols: 80, rows: 24 });
    const o2 = collect(t2);
    await until(() => o2.text().includes("up"), 5000, "start");
    t2.kill();
    assert.equal((await o2.exit).code, 129, "SIGHUP by default");

    // A child that ignores SIGHUP still goes with SIGKILL, and so does what it started.
    const t3 = backend.spawn({ file: "/bin/sh", args: ["-c", "trap '' HUP; sleep 30 & echo kid:$!; wait"], cwd, env: { PATH: "/usr/bin:/bin" }, cols: 80, rows: 24 });
    const o3 = collect(t3);
    const kid = Number((await until(() => /kid:(\d+)/.exec(o3.text()), 5000, "kid"))[1]);
    t3.kill("SIGHUP");
    await sleep(300);
    t3.kill("SIGKILL");
    const e3 = await o3.exit;
    assert.ok(e3.code === 137 || e3.code === 129, `killed (${e3.code})`);
    await until(() => {
      try {
        process.kill(kid, 0);
        return false;
      } catch {
        return true;
      }
    }, 3000, "the background child to die too");
  });

  test(`${label}: a late onExit listener still hears the exit`, { skip: !backend && `${label} not available here` }, async () => {
    const term = backend.spawn({ file: "/bin/sh", args: ["-c", "exit 4"], cwd: scratch(), env: { PATH: "/usr/bin:/bin" }, cols: 80, rows: 24 });
    await sleep(500);
    const e = await new Promise((r) => term.onExit(r));
    assert.equal(e.code, 4);
  });
}

test("the python bridge reports a program it can't run as 127", { skip: !python && "no python bridge here" }, async () => {
  const term = python.spawn({ file: "/no/such/agent", args: [], cwd: scratch(), env: { PATH: "/usr/bin:/bin" }, cols: 80, rows: 24 });
  const o = collect(term);
  assert.equal((await o.exit).code, 127);
  assert.match(o.text(), /cannot run \/no\/such\/agent/);
});

test("loader: node-pty first, python when it won't load, none when forced or nothing works", async () => {
  if (nodePty) assert.equal((await loadPty()).kind, "node-pty");
  const broken = await loadPty({ importPty: async () => { throw new Error("no binary"); }, checkPython: async () => true, env: { PATH: "/usr/bin:/bin" } });
  if (existsSync("/usr/bin/python3") && process.platform === "linux") assert.equal(broken?.kind, "python");
  if (broken) assert.equal(broken.kind, "python");
  assert.equal(await loadPty({ force: "none" }), null);
  assert.equal(await loadPty({ force: "node-pty", importPty: async () => { throw new Error("x"); } }), null);
  assert.equal(await loadPty({ importPty: async () => { throw new Error("x"); }, env: { PATH: "/nowhere" } }), null, "no python on PATH");
  assert.equal(await loadPty({ importPty: async () => ({ default: {} }), checkPython: async () => false, env: { PATH: "/usr/bin:/bin" } }), null, "a module without spawn and a python that can't run the bridge");
  assert.equal(pythonBackend("/usr/bin/python3").kind, "python");
});

test("exit codes and sizes", () => {
  assert.deepEqual(exitOf(0, 0), { code: 0 });
  assert.deepEqual(exitOf(0, 9), { code: 137, signal: "SIGKILL" });
  assert.deepEqual(exitOf(null, "SIGHUP"), { code: 129, signal: "SIGHUP" });
  assert.deepEqual(exitOf(null, null), { code: null });
  assert.deepEqual(clampSize(1, 1), { cols: 10, rows: 4 });
  assert.deepEqual(clampSize(9999, 9999), { cols: 500, rows: 200 });
  assert.deepEqual(clampSize(NaN, 40.4), { cols: 120, rows: 40 });
});
