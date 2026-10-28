// Tests for src/control/cloud/ssh.ts against a fake `ssh` (a node script that runs the remote
// command with sh under a scratch HOME and logs its argv and stdin) and a pipe-backed stand-in for
// the PTY backend. Opening checks the folder; the agent is installed when missing; attach writes
// the env file through a heredoc on ssh's stdin, then runs `ssh -tt … sh -c '<line>'` on the shared
// ControlMaster; the agent gets its keys and the file is gone; chat mode gets plain pipes. No key
// ever appears in an argv.
import nodeTest, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { load, tmp, writeBin, until } from "./remote.fakes.mjs";
import { collect, fakeContext, fakePty } from "./control.cloud.fakes.mjs";
import { CONTROL, skipAll } from "./platform.mjs";

const test = skipAll(nodeTest, CONTROL);

const M = await load("src/control/cloud/ssh.ts", "src/control/cloud/index.ts");

const KEY = "sk-ant-dummy-ssh-0001";

const FAKE_SSH = `
const fs = require("fs");
const { spawnSync, spawn } = require("child_process");
const args = process.argv.slice(2);
const log = (o) => fs.appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify(o) + "\\n");
if (args.includes("-O")) { log({ args }); process.exit(0); }
const i = args.indexOf("--");
const dest = args[i + 1];
const cmd = args[i + 2];
const env = { PATH: process.env.FAKE_REMOTE_BIN + ":" + process.env.PATH, HOME: process.env.FAKE_REMOTE_HOME, LC_ALL: "C" };
if (dest === "down") { process.stderr.write("ssh: connect to host down port 22: Connection refused\\n"); process.exit(255); }
if (cmd === "sh -s") {
  const input = fs.readFileSync(0, "utf8");
  log({ args, stdin: input });
  const r = spawnSync("sh", ["-s"], { input, env, cwd: env.HOME });
  process.stdout.write(r.stdout); process.stderr.write(r.stderr);
  process.exit(r.status === null ? 1 : r.status);
}
log({ args });
const c = spawn("sh", ["-c", cmd], { stdio: "inherit", env, cwd: env.HOME });
c.on("exit", (code, sig) => process.exit(code === null ? 1 : code));
process.on("SIGHUP", () => c.kill("SIGHUP"));
`;

const AGENT = `
const fs = require("fs");
const run = process.env.HOME + "/.agent-visualizer/run";
process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), key: process.env.ANTHROPIC_API_KEY ?? null, prompt: process.env.AO_PROMPT ?? null, files: fs.existsSync(run) ? fs.readdirSync(run) : [] }) + "\\n");
let buf = "";
process.stdin.on("data", (d) => { buf += d; let n; while ((n = buf.indexOf("\\n")) >= 0) { const l = buf.slice(0, n); buf = buf.slice(n + 1); if (l === "quit") process.exit(3); process.stdout.write("got:" + l + "\\n"); } });
process.stdin.on("end", () => process.exit(0));
`;

const made = [];
const ptys = [];
after(() => {
  for (const p of ptys) p.killAll();
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const dir = tmp();
  const remoteHome = tmp();
  mkdirSync(join(remoteHome, "proj"), { recursive: true });
  const ssh = writeBin(join(dir, "bin"), "ssh", FAKE_SSH);
  const remoteBin = join(dir, "remote-bin");
  mkdirSync(remoteBin, { recursive: true });
  const log = join(dir, "ssh.log");
  // A short AGENT_VISUALIZER_HOME keeps the ControlMaster socket path short.
  const ao = join("/tmp", `ao-c-${process.pid}-${Math.random().toString(36).slice(2, 7)}`);
  made.push(dir, remoteHome, ao);
  const pty = fakePty();
  ptys.push(pty);
  const ctx = fakeContext({ home: ao, userHome: dir, pty, env: { PATH: process.env.PATH, FAKE_SSH_LOG: log, FAKE_REMOTE_HOME: remoteHome, FAKE_REMOTE_BIN: remoteBin, AGENT_VISUALIZER_HOME: ao, HOME: dir, DAYTONA_API_KEY: "dtn-dummy-platform" } });
  const entries = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { dir, remoteHome, remoteBin, ssh, ctx, pty, entries };
}

const progress = () => {
  const steps = [];
  return { steps, fn: (s, d) => steps.push([s, d]) };
};

test("open resolves the folder over the watcher's exec; a missing folder or a dead host is a clear error", async () => {
  const s = setup();
  const p = await M.openSsh(s.ctx, { kind: "ssh", target: "me@box", cwd: "~/proj" }, { agent: "claude", progress: () => {} }, { bin: s.ssh });
  assert.equal(p.host.id, "ssh:me@box");
  assert.equal(p.ours, false);
  assert.equal(p.cwd, realpathSync(join(s.remoteHome, "proj")));
  const first = s.entries()[0];
  assert.ok(first.args.includes("BatchMode=yes"), "the check uses the watcher's BatchMode exec");
  await assert.rejects(M.openSsh(s.ctx, { kind: "ssh", target: "me@box", cwd: "~/nope" }, { agent: "claude", progress: () => {} }, { bin: s.ssh }), (e) => e.status === 400 && /No folder ~\/nope/.test(e.message));
  await assert.rejects(M.openSsh(s.ctx, { kind: "ssh", target: "down" }, { agent: "claude", progress: () => {} }, { bin: s.ssh }), (e) => e.status === 502 && /connection refused/.test(e.message));
  await assert.rejects(M.openSsh(s.ctx, { kind: "ssh", target: "-oProxyCommand=x" }, { agent: "claude", progress: () => {} }, { bin: s.ssh }), (e) => e.status === 400);
});

test("attach: keys reach the agent through a heredoc on stdin, ssh -tt shares the master, nothing secret on argv", async () => {
  const s = setup();
  writeBin(s.remoteBin, "claude", AGENT);
  const pr = progress();
  const p = await M.openSsh(s.ctx, { kind: "ssh", target: "me@box", cwd: "~/proj" }, { agent: "claude", progress: pr.fn }, { bin: s.ssh });
  const got = await p.ensureAgent("claude", pr.fn);
  assert.equal(got.bin, "claude");
  await p.firstRun("claude", p.cwd);
  assert.equal(existsSync(join(s.remoteHome, ".claude.json")), false, "no seeding on an ssh box");
  const launch = { argv: ["claude", "--session-id", "abc", { env: "AO_PROMPT" }], cwd: p.cwd, env: { ANTHROPIC_API_KEY: KEY, AO_PROMPT: "fix the 'tests' $now" }, secret: ["ANTHROPIC_API_KEY"] };
  const term = await p.attach(launch, { cols: 100, rows: 30 });
  const out = collect(term);
  await until(() => out.text().includes("\n"), 5000, "agent output");
  const hello = JSON.parse(out.text().split("\n")[0]);
  assert.equal(hello.key, KEY);
  assert.equal(hello.prompt, "fix the 'tests' $now");
  assert.deepEqual(hello.argv, ["--session-id", "abc", "fix the 'tests' $now"]);
  assert.deepEqual(hello.files.filter((f) => f.endsWith(".env")), [], "the env file is gone once the agent runs");
  term.write("hello\n");
  await until(() => out.text().includes("got:hello"), 5000, "echo");
  term.write("quit\n");
  const exit = await out.done;
  assert.equal(exit.code, 3);

  const spawn = s.pty.spawns[0];
  assert.equal(spawn.file, s.ssh);
  assert.equal(spawn.args[0], "-tt");
  assert.ok(spawn.args.some((a) => a.startsWith("ControlPath=")), "same ControlMaster socket as the watcher");
  assert.ok(!spawn.args.includes("BatchMode=yes"), "a passphrase prompt may show in the panel");
  const dd = spawn.args.indexOf("--");
  assert.equal(spawn.args[dd + 1], "me@box");
  assert.match(spawn.args[dd + 2], /^sh -c ' /);
  assert.equal(spawn.cols, 100);
  assert.equal(spawn.env.TERM, "xterm-256color");
  assert.equal(spawn.env.DAYTONA_API_KEY, undefined, "platform tokens stay out of ssh's environment");
  // The value only ever travelled on ssh's stdin.
  const all = s.entries();
  assert.ok(all.every((e) => !JSON.stringify(e.args).includes(KEY)), "no key on any ssh argv");
  assert.ok(!JSON.stringify(spawn.args).includes(KEY) && !JSON.stringify(spawn.args).includes("fix the"), "no key or prompt on the PTY argv");
  assert.ok(all.some((e) => e.stdin?.includes(`ANTHROPIC_API_KEY='${KEY}'`)), "the heredoc carried it");
  await until(() => !readdirSync(join(s.remoteHome, ".agent-visualizer/run")).some((f) => f.endsWith(".env")), 3000, "cleanup");
});

test("no PTY library: terminal mode is a 503; chat mode runs over ssh -T pipes with the same env file", async () => {
  const s = setup();
  writeBin(s.remoteBin, "codex", AGENT.replace("ANTHROPIC_API_KEY", "OPENAI_API_KEY"));
  const ctx = { ...s.ctx, pty: async () => null };
  const p = await M.openSsh(ctx, { kind: "ssh", target: "me@box" }, { agent: "codex", progress: () => {} }, { bin: s.ssh });
  const launch = { argv: ["codex", "app-server"], cwd: p.cwd, env: { OPENAI_API_KEY: "sk-dummy-openai" }, secret: ["OPENAI_API_KEY"] };
  await assert.rejects(p.attach(launch, { cols: 80, rows: 24 }), (e) => e.status === 503);
  const pipe = await p.pipe(launch);
  const chunks = [];
  pipe.onStdout((c) => chunks.push(Buffer.from(c).toString()));
  await until(() => chunks.join("").includes("\n"), 5000, "first line");
  const hello = JSON.parse(chunks.join("").split("\n")[0]);
  assert.equal(hello.key, "sk-dummy-openai");
  // Codex with an OpenAI key gets the provider flags (remote launches only).
  assert.deepEqual(hello.argv.slice(0, 2), ["-c", "model_provider=agent-visualizer"]);
  pipe.write("ping\n");
  await until(() => chunks.join("").includes("got:ping"), 5000, "echo");
  const exited = new Promise((r) => pipe.onExit(r));
  pipe.end();
  assert.equal((await exited).code, 0);
  const pipeArgs = s.entries().find((e) => e.args[0] === "-T" && !e.stdin);
  assert.ok(pipeArgs && !JSON.stringify(pipeArgs.args).includes("sk-dummy-openai"));
});

test("ssh status lists config hosts without patterns, plus ssh remotes from config.json", async () => {
  assert.deepEqual(M.sshConfigHosts("Host *\n  User x\nHost gpu box2 *.corp !bad\nhost   shubham # mine\nHost=eq\nMatch all\n"), ["gpu", "box2", "shubham", "eq"]);
});
