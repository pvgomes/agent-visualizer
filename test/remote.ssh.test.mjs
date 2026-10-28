// Tests for src/remote/ssh.ts against a fake `ssh` (a node script) that runs the remote command
// with sh on this machine under a fake HOME and logs its argv. Proves the script travels on stdin
// (never on the command line), the multiplexing and BatchMode options, env exports, error codes
// and hints, timeouts, tearing the master down, and a whole ingest loop over the transport.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, rmdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fakeHome, load, tmp, writeBin } from "./remote.fakes.mjs";
import { POSIX } from "./platform.mjs";

const M = await load("src/remote/ssh.ts", "src/remote/util.ts", "src/ingest/index.ts");

const FAKE_SSH = `
const fs = require("fs");
const { spawnSync } = require("child_process");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify(args) + "\\n");
if (args.includes("-O")) process.exit(0);
const i = args.indexOf("--");
const dest = args[i + 1];
const cmd = args[i + 2];
if (dest === "down") { process.stderr.write("ssh: connect to host down port 22: Connection refused\\n"); process.exit(255); }
if (dest === "badkey") { process.stderr.write("@@@@@\\nHost key verification failed.\\n"); process.exit(255); }
if (dest === "slow") { setTimeout(() => {}, 60000); return; }
const r = spawnSync("sh", ["-c", cmd], { stdio: "inherit", env: { PATH: process.env.PATH, HOME: process.env.FAKE_REMOTE_HOME, LC_ALL: "C" }, cwd: process.env.FAKE_REMOTE_HOME });
process.exit(r.status === null ? 1 : r.status);
`;

const made = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
  try {
    rmdirSync(`/tmp/agent-visualizer-ssh-${process.getuid()}`); // the short-socket fallback, if this run made it and left it empty
  } catch {
    // Not there, or in use.
  }
});

function setup(home = tmp()) {
  const dir = tmp();
  const bin = writeBin(join(dir, "bin"), "ssh", FAKE_SSH);
  const log = join(dir, "argv.log");
  const aoHome = join("/tmp", `ao-t-${process.pid}-${Math.random().toString(36).slice(2, 7)}`);
  made.push(aoHome, dir, home);
  const processEnv = { PATH: process.env.PATH, FAKE_SSH_LOG: log, FAKE_REMOTE_HOME: home, AGENT_VISUALIZER_HOME: aoHome };
  const argv = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { bin, log, home, processEnv, argv, aoHome };
}

test("destinations: aliases, user@host, ssh:// URLs; anything flag-like is refused", () => {
  assert.deepEqual(M.parseSshDest("shubham"), { dest: "shubham", port: undefined, name: "shubham" });
  assert.deepEqual(M.parseSshDest("me@gpu.corp.example"), { dest: "me@gpu.corp.example", port: undefined, name: "gpu" });
  assert.deepEqual(M.parseSshDest("ssh://me@box:2222"), { dest: "me@box", port: 2222, name: "box" });
  assert.deepEqual(M.parseSshDest("ssh://[::1]:22"), { dest: "::1", port: 22, name: "localhost" });
  // Safe to screen-record: no full IP address on screen.
  assert.equal(M.parseSshDest("root@45.140.142.148").name, "45.140.•.•");
  assert.equal(M.parseSshDest("me@2001:db8::42").name, "2001:•••");
  for (const bad of ["-oProxyCommand=touch x", "a b", "box;rm -rf /", "$(id)", "", "ssh://box:99999", "`x`"]) {
    assert.throws(() => M.parseSshDest(bad), /doesn't look like an ssh host|bad port/, bad);
  }
});

test("the script goes on stdin; the command line is fixed, batch-mode and multiplexed", { skip: POSIX }, async () => {
  const s = setup();
  const t = M.createSshTarget("me@box", { bin: s.bin, processEnv: s.processEnv });
  assert.deepEqual(t.host, { kind: "ssh", id: "ssh:me@box", name: "box" });
  const script = `x='it'"'"'s $(touch PWNED) \`touch PWNED2\`'\nprintf '%s|%s\\n' "$HOME" "$x"\nexit 0\n`;
  const out = await t.exec(script);
  assert.equal(out, `${s.home}|it's $(touch PWNED) \`touch PWNED2\`\n`);
  assert.ok(!existsSync(join(s.home, "PWNED")) && !existsSync(join(s.home, "PWNED2")));
  const [args] = s.argv();
  assert.ok(!args.some((a) => a.includes("printf") || a.includes("PWNED")), "nothing from the script is on the command line");
  assert.deepEqual(args.slice(-3), ["--", "me@box", "sh -s"]);
  const opts = args.filter((_, i) => args[i - 1] === "-o");
  for (const want of ["BatchMode=yes", "ConnectTimeout=5", "ControlMaster=auto", "ControlPersist=120"]) assert.ok(opts.includes(want), want);
  const cp = opts.find((o) => o.startsWith("ControlPath="));
  assert.equal(cp, `ControlPath=${join(s.aoHome, "ssh", "%C")}`);
  assert.equal(statSync(join(s.aoHome, "ssh")).mode & 0o777, 0o700, "socket folder is private");
  assert.ok(args.includes("-T"));
});

test("env overrides are exported before the script, safely quoted", { skip: POSIX }, async () => {
  const s = setup();
  const t = M.createSshTarget("box", { bin: s.bin, processEnv: s.processEnv, env: { CLAUDE_CONFIG_DIR: "/data/x y'z", "BAD NAME": "no" } });
  assert.equal(await t.exec(`printf '%s' "$CLAUDE_CONFIG_DIR"\n`), "/data/x y'z");
});

test("ssh -p for ssh:// ports; a long AGENT_VISUALIZER_HOME falls back to a short socket folder", { skip: POSIX }, async () => {
  const s = setup();
  const t = M.createSshTarget("ssh://me@box:2201", { bin: s.bin, processEnv: { ...s.processEnv, AGENT_VISUALIZER_HOME: "/tmp/" + "x".repeat(80) } });
  assert.equal(t.host.id, "ssh:me@box:2201");
  await t.exec("exit 0\n");
  const [args] = s.argv();
  assert.equal(args[args.indexOf("-p") + 1], "2201");
  assert.match(args.find((a) => a.startsWith("ControlPath=")), /^ControlPath=\/tmp\/agent-visualizer-ssh-[\w]+\/%C$/);
  const off = M.createSshTarget("box", { bin: s.bin, processEnv: s.processEnv, controlDir: null });
  await off.exec("exit 0\n");
  assert.ok(!s.argv()[1].some((a) => a.startsWith("Control")), "controlDir: null turns multiplexing off");
});

test("connection failures carry a code and a hint, and tear the master down", { skip: POSIX }, async () => {
  const s = setup();
  const down = M.createSshTarget("down", { bin: s.bin, processEnv: s.processEnv });
  // A fixed phrase: ssh's own line names the address it dialled.
  await assert.rejects(down.exec("exit 0\n"), (e) => e.code === "unreachable" && /: connection refused$/.test(e.message));
  const key = M.createSshTarget("badkey", { bin: s.bin, processEnv: s.processEnv });
  await assert.rejects(key.exec("exit 0\n"), (e) => e.code === "auth" && /host key changed or unknown/.test(e.message));
  const failing = M.createSshTarget("box", { bin: s.bin, processEnv: s.processEnv });
  await assert.rejects(failing.exec("echo nope >&2; exit 3\n"), (e) => e.code === "failed" && /exit 3: nope/.test(e.message));
  await new Promise((r) => setTimeout(r, 300));
  // Anything unrecognised keeps its words but loses its addresses.
  assert.equal(M.hint("ssh: connect to host 203.0.113.77 port 2222: Broken pipe"), "connect to host 203.0.•.• port •: Broken pipe");
  assert.equal(M.hint("kex_exchange_identification: read from build.internal.acme.corp"), "kex_exchange_identification: read from build");
  assert.equal(M.hint("ssh: connect to host 2001:db8::7 port 22: Connection refused"), "connection refused");
  const exits = s.argv().filter((a) => a.includes("-O") && a[a.indexOf("-O") + 1] === "exit");
  assert.deepEqual(exits.map((a) => a[a.length - 1]).sort(), ["badkey", "down"], "-O exit after each connection error, not after a script error");
});

test("a hung connection times out, is killed, and resets the master", { skip: POSIX }, async () => {
  const s = setup();
  const t = M.createSshTarget("slow", { bin: s.bin, processEnv: s.processEnv });
  const t0 = Date.now();
  await assert.rejects(t.exec("exit 0\n", { timeoutMs: 300 }), (e) => e.code === "timeout");
  assert.ok(Date.now() - t0 < 3_000, "killed promptly");
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(s.argv().some((a) => a.includes("-O")));
});

test("close() asks the control master to exit", { skip: POSIX }, async () => {
  const s = setup();
  const t = M.createSshTarget("box", { bin: s.bin, processEnv: s.processEnv });
  t.close();
  await new Promise((r) => setTimeout(r, 400));
  const [args] = s.argv();
  assert.ok(args && args.includes("-O") && args.includes("exit") && args[args.length - 1] === "box");
});

test("a whole ingest loop over ssh: host-tagged, prefixed workers from the remote's transcripts", { skip: POSIX }, async () => {
  const s = setup(fakeHome());
  const t = M.createSshTarget("me@gpu-box", { bin: s.bin, processEnv: s.processEnv });
  const events = [];
  const ing = M.createIngest({ agents: ["claude", "codex"], local: false, remotes: [t], onEvent: (e) => events.push(e), watch: false });
  await ing.tick();
  ing.stop();
  assert.ok(events.length >= 3, `${events.length} events`);
  assert.ok(events.every((e) => e.host?.id === "ssh:me@gpu-box" && e.workerId.startsWith("ssh:me@gpu-box/")));
  const agents = new Set(events.filter((e) => e.kind === "session_start").map((e) => e.agent));
  assert.deepEqual([...agents].sort(), ["claude", "codex"]);
});
