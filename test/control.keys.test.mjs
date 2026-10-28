// Tests for src/control/keys.ts, env.ts and auth.ts in temp folders: the key store's file (0600,
// atomic, re-read on change, never overwritten when damaged), previews, reveal and platformEnv,
// import from a fake login shell (allowlisted names only, a hanging shell times out), agentEnv
// and adoptLoginEnv, and the unlock code and cookie lifetimes on an injected clock. Dummy keys only.
import nodeTest, { after, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CONTROL, skipAll } from "./platform.mjs";

const test = skipAll(nodeTest, CONTROL);

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TMP = realpathSync(mkdtempSync(join(tmpdir(), "agent-visualizer-ctl-keys-")));
const DUMMY = "sk-ant-DUMMY-import-0000000000000000000000";
let M;

before(async () => {
  const outfile = join(TMP, "mod.mjs");
  const entries = ["src/control/keys.ts", "src/control/env.ts", "src/control/auth.ts", "src/control/types.ts"];
  await build({
    stdin: { contents: entries.map((e) => `export * from ${JSON.stringify(`./${e}`)};`).join("\n"), resolveDir: ROOT, loader: "ts" },
    bundle: true, platform: "node", format: "esm", target: "node18", outfile, logLevel: "error",
  });
  M = await import(pathToFileURL(outfile).href);
});
after(() => rmSync(TMP, { recursive: true, force: true }));

let n = 0;
const dir = () => join(TMP, `ao-${n++}`);

/** A login shell: prints noise, exports dummy keys in its "rc file", then runs -c with /bin/sh. */
function fakeShell(body = "") {
  const file = join(TMP, `shell-${n++}.sh`);
  writeFileSync(file, `#!/bin/sh
echo "Last login: today"
export ANTHROPIC_API_KEY='${DUMMY}'
export OPENAI_API_KEY='   '
export DAYTONA_API_KEY='dtn_DUMMY_platform_token_000000'
export UNRELATED_SECRET='never-read-this-0000000000'
export CLAUDECODE=1
${body}
while [ $# -gt 0 ]; do case "$1" in -c) shift; exec /bin/sh -c "$1";; *) shift;; esac; done
`);
  chmodSync(file, 0o755);
  return file;
}

test("previews show at most 6 + 4 characters, less for short values, none under 12", () => {
  assert.equal(M.preview("sk-ant-api03-abcdefghijklmnop-a1b2"), "sk-ant…a1b2");
  assert.equal(M.preview("abcdefghijkl"), "abc…kl");
  assert.equal(M.preview("short-key"), "•••");
  assert.deepEqual(M.defaultAgents("OPENAI_API_KEY"), ["codex", "opencode", "qwen"]);
  assert.deepEqual(M.defaultAgents("DAYTONA_API_KEY"), []);
  assert.ok(M.importableNames().includes("VERCEL_TOKEN"));
});

test("the store: 0600 file in a 0700 folder, atomic writes, values only through reveal and platformEnv", () => {
  const home = dir();
  const ks = M.createKeyStore(home, { now: () => Date.parse("2026-10-18T10:00:00Z") });
  const changes = [];
  ks.onChange(() => changes.push(ks.list().length));
  const info = ks.put({ name: "ANTHROPIC_API_KEY", value: DUMMY });
  assert.deepEqual(info, { name: "ANTHROPIC_API_KEY", agents: ["claude", "opencode"], preview: "sk-ant…0000", addedAt: "2026-10-18T10:00:00.000Z" });
  ks.put({ name: "VERCEL_TOKEN", value: "vercel_DUMMY_token_000000000", agents: [] });
  assert.equal(statSync(join(home, "keys.json")).mode & 0o777, 0o600);
  assert.equal(statSync(home).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(home), ["keys.json"], "no temp files left behind");
  assert.ok(!JSON.stringify(ks.list()).includes("DUMMY-import"), "list never has a value");
  assert.deepEqual(ks.reveal(["ANTHROPIC_API_KEY"]), { ANTHROPIC_API_KEY: DUMMY });
  assert.throws(() => ks.reveal(["MISSING_KEY"]), (e) => e.status === 400 && /MISSING_KEY/.test(e.message));
  assert.throws(() => ks.reveal(["bad name"]), (e) => e.status === 400 && !/bad name/.test(e.message));
  assert.deepEqual(ks.platformEnv(), { VERCEL_TOKEN: "vercel_DUMMY_token_000000000" });
  assert.deepEqual(changes, [1, 2]);
  for (const [k, re] of [
    [{ name: "lower", value: "x" }, /name/],
    [{ name: "OK_NAME", value: "" }, /value/],
    [{ name: "OK_NAME", value: "a\nb" }, /one line/],
    [{ name: "OK_NAME", value: "x".repeat(17 * 1024) }, /too long/],
    [{ name: "OK_NAME", value: "x", agents: ["nope"] }, /agent/],
  ]) {
    assert.throws(() => ks.put(k), (e) => e.status === 400 && re.test(e.message), JSON.stringify(k).slice(0, 40));
  }
  for (const k of [{ name: "lower", value: DUMMY }, { name: "OK_NAME", value: `${DUMMY}\n${DUMMY}` }]) {
    try {
      ks.put(k);
    } catch (e) {
      assert.ok(!e.message.includes("DUMMY"), "errors never carry the value");
    }
  }
  assert.equal(ks.remove("VERCEL_TOKEN"), true);
  assert.equal(ks.remove("VERCEL_TOKEN"), false);
});

test("the store re-reads keys.json when another process changes it, and refuses to overwrite a damaged one", () => {
  const home = dir();
  const ks = M.createKeyStore(home);
  ks.put({ name: "GEMINI_API_KEY", value: "AIza-DUMMY-000000000000000000" });
  const file = join(home, "keys.json");
  const j = JSON.parse(readFileSync(file, "utf8"));
  j.keys.push({ name: "CURSOR_API_KEY", value: "cur-DUMMY-0000000000000000", agents: ["cursor"], addedAt: "2026-01-01T00:00:00Z" });
  writeFileSync(file, JSON.stringify(j));
  utimesSync(file, new Date(), new Date(Date.now() + 5_000));
  assert.deepEqual(ks.list().map((k) => k.name), ["GEMINI_API_KEY", "CURSOR_API_KEY"]);
  writeFileSync(file, "{ damaged");
  utimesSync(file, new Date(), new Date(Date.now() + 10_000));
  assert.deepEqual(ks.list(), []);
  assert.throws(() => ks.put({ name: "OTHER_KEY", value: "v".repeat(20) }), (e) => e.status === 409);
  assert.equal(readFileSync(file, "utf8"), "{ damaged");
});

test("import reads only allowlisted names from a fresh login shell, skips blanks and unchanged values", async () => {
  const home = dir();
  const ks = M.createKeyStore(home, { shell: { shell: fakeShell(), env: { PATH: process.env.PATH, HOME: TMP } } });
  assert.deepEqual(await ks.importFromShell(), ["ANTHROPIC_API_KEY", "DAYTONA_API_KEY"]);
  const text = readFileSync(join(home, "keys.json"), "utf8");
  assert.ok(!text.includes("never-read-this"), "a name off the allowlist is never read");
  assert.ok(!text.includes("CLAUDECODE"));
  assert.deepEqual(ks.list().find((k) => k.name === "DAYTONA_API_KEY").agents, []);
  assert.deepEqual(await ks.importFromShell(), [], "unchanged values aren't stored again");
});

test("a login shell that hangs is killed and import says so", async () => {
  const ks = M.createKeyStore(dir(), { shell: { shell: fakeShell("sleep 30"), env: { PATH: process.env.PATH }, timeoutMs: 300 } });
  const t = Date.now();
  await assert.rejects(ks.importFromShell(), (e) => e.status === 502 && /login shell/.test(e.message));
  assert.ok(Date.now() - t < 3_000);
});

test("jobs the rc files leave running neither hold up the read nor outlive it", async () => {
  // One keeps the shell's stdout open, one doesn't; both are in the probe's process group.
  const pids = join(TMP, `pids-${n++}`);
  const sh = fakeShell(`sleep 30 & echo $! >> '${pids}'\nsleep 31 >/dev/null 2>&1 & echo $! >> '${pids}'`);
  const t = Date.now();
  const got = await M.loginShellVars(["ANTHROPIC_API_KEY"], { shell: sh, env: { PATH: process.env.PATH, HOME: TMP }, timeoutMs: 10_000 });
  assert.equal(got?.ANTHROPIC_API_KEY, DUMMY, "the answer, not the timeout");
  assert.ok(Date.now() - t < 5_000, "taken at the closing marker, not when stdout closes");
  const jobs = readFileSync(pids, "utf8").trim().split("\n").map(Number);
  assert.equal(jobs.length, 2);
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (const end = Date.now() + 2_000; jobs.some(alive) && Date.now() < end; ) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(jobs.filter(alive), [], "both jobs are gone");
});

test("loginShellEnv reads the whole environment (service only); adoptLoginEnv drops the nested-agent markers", async () => {
  const sh = fakeShell();
  const env = await M.loginShellEnv({ shell: sh, env: { PATH: process.env.PATH, HOME: TMP } });
  assert.equal(env.UNRELATED_SECRET, "never-read-this-0000000000");
  assert.deepEqual(M.parseMarked("noise\x1e{\"A\":\"1\",\"B\":2}\x1emore"), { A: "1" }, "strings only, between the markers");
  assert.equal(M.parseMarked("no markers"), null);
  const saved = { ...process.env };
  try {
    process.env.SHELL = sh;
    process.env.HOME = TMP;
    assert.equal(await M.adoptLoginEnv({ shell: sh }), true);
    assert.equal(process.env.ANTHROPIC_API_KEY, DUMMY);
    assert.equal(process.env.CLAUDECODE, undefined, "nested markers are never adopted");
    assert.equal(process.env.AO_NODE, undefined);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("agentEnv: a fresh copy without the nested-agent markers or the service flag", () => {
  const base = { PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1", CODEX_SANDBOX: "seatbelt", AGENT_VISUALIZER_SERVICE: "1", CLAUDE_CODE_OAUTH_TOKEN: "stays" };
  const env = M.agentEnv(base);
  assert.deepEqual(env, { PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "stays" });
  env.PATH = "changed";
  assert.equal(base.PATH, "/bin");
  assert.equal(M.loginShell({ SHELL: "/bin/fish" }), "/bin/fish");
  assert.ok(M.loginShell({ SHELL: "relative" }).startsWith("/"));
});

test("unlock codes expire after two minutes and are single use; cookies last 30 days and die with a rotation", () => {
  const clock = { t: Date.parse("2026-10-18T10:00:00Z") };
  const home = dir();
  const a = new M.ControlAuth(home, { now: () => clock.t });
  const code = a.mintCode();
  assert.match(code, /^[0-9a-z]+\.[0-9a-f]{12}\.[0-9a-f]{32}$/);
  assert.notEqual(a.mintCode(), code, "two codes in the same second differ");
  clock.t += 121_000;
  assert.equal(a.redeem(code), false, "expired");
  const c2 = a.mintCode();
  assert.equal(a.redeem(c2), true);
  assert.equal(a.redeem(c2), false, "used");
  const other = new M.ControlAuth(dir(), { now: () => clock.t });
  assert.equal(other.redeem(a.mintCode()), false, "another secret's code");
  const cookie = a.cookie().split(";")[0];
  assert.ok(a.cookieIat(cookie));
  assert.ok(a.cookieIat(`foo=bar; ${cookie}; x=y`), "among other cookies");
  assert.equal(a.cookieIat(cookie.replace(/.$/, (ch) => (ch === "0" ? "1" : "0"))), null, "tampered");
  assert.equal(a.cookieIat(cookie.replace(/v1\.(\d+)/, (_m, iat) => `v1.${Number(iat) + 1}`)), null, "iat is signed");
  // A second process (agent-visualizer open --rotate) rewrites control.json: this one notices within a second.
  clock.t += 2_000;
  new M.ControlAuth(home, { now: () => clock.t }).rotate();
  clock.t += 1_500;
  assert.equal(a.cookieIat(cookie), null, "rotated");
  const fresh = a.cookie().split(";")[0];
  clock.t += 29 * 86_400_000;
  assert.ok(a.cookieIat(fresh));
  clock.t += 2 * 86_400_000;
  assert.equal(a.cookieIat(fresh), null, "older than 30 days");
  assert.equal(statSync(join(home, "control.json")).mode & 0o777, 0o600);
});

test("a group-readable control.json is tightened, a damaged one replaced", () => {
  const home = dir();
  const a = new M.ControlAuth(home);
  a.ensure();
  const file = join(home, "control.json");
  chmodSync(file, 0o644);
  new M.ControlAuth(home).ensure();
  assert.equal(statSync(file).mode & 0o777, 0o600);
  writeFileSync(file, "garbage");
  const b = new M.ControlAuth(home);
  const code = b.mintCode();
  assert.equal(b.redeem(code), true);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});
