// Tests for MCP signals (src/ingest/signals.ts and the outbox tailing in src/ingest/index.ts): validation,
// attribution to the most recently active worker with the same agent + cwd, redaction, the startup replay
// rule (only the latest status per agent+cwd), waiting for a worker that hasn't appeared yet, and remotes.
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { execFile } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FX = join(ROOT, "test", "fixtures");

async function load(...entries) {
  const dir = mkdtempSync(join(tmpdir(), "agent-visualizer-test-"));
  const outfile = join(dir, "mod.mjs");
  await build({
    stdin: { contents: entries.map((e) => `export * from ${JSON.stringify(`./${e}`)};`).join("\n"), resolveDir: ROOT, loader: "ts" },
    bundle: true, platform: "node", format: "esm", target: "node18", outfile, logLevel: "error",
  });
  try {
    return await import(pathToFileURL(outfile).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const I = await load("src/ingest/index.ts", "src/ingest/signals.ts", "src/ingest/common.ts", "src/shared/events.ts");

const SID = "11111111-2222-4333-8444-555555555555";
const sig = (o) => JSON.stringify({ v: 1, ts: new Date().toISOString(), agent: "claude", cwd: "/tmp/demo-app", kind: "status", ...o });

function ctx(id, o = {}) {
  const c = I.newCtx(o.agent ?? "claude", id, { cwd: o.cwd ?? "/tmp/demo-app", ...o });
  c.announced = o.announced ?? true;
  c.lastActivityMs = o.at ?? 0;
  return c;
}

/* ------------------------------------------------------------------- unit */

test("parseSignal keeps only well-formed v1 signals", () => {
  assert.equal(I.parseSignal(sig({})).kind, "status");
  assert.equal(I.parseSignal(sig({ v: 2 })), null);
  assert.equal(I.parseSignal(sig({ kind: "explode" })), null);
  assert.equal(I.parseSignal(sig({ cwd: "" })), null);
  assert.equal(I.parseSignal("not json"), null);
  assert.equal(I.parseSignal(sig({ agent: "aider" })).agent, undefined, "unknown agents become 'any agent'");
});

test("attribution: same agent and cwd, most recent first; then same cwd; else nobody", () => {
  const old = ctx("old", { at: 1_000 });
  const recent = ctx("recent", { at: 5_000 });
  const codex = ctx("cx", { agent: "codex", at: 9_000 });
  const elsewhere = ctx("far", { cwd: "/tmp/other", at: 10_000 });
  const asleep = ctx("gone", { at: 20_000, announced: false });
  const all = [old, recent, codex, elsewhere, asleep];
  assert.equal(I.pickWorker(all, I.parseSignal(sig({}))).workerId, "recent");
  assert.equal(I.pickWorker(all, I.parseSignal(sig({ agent: "codex" }))).workerId, "cx");
  // No qwen here: the most recent worker in that cwd, whatever it is.
  assert.equal(I.pickWorker(all, I.parseSignal(sig({ agent: "qwen" }))).workerId, "cx");
  assert.equal(I.pickWorker(all, I.parseSignal(sig({ agent: undefined }))).workerId, "cx");
  assert.equal(I.pickWorker(all, I.parseSignal(sig({ cwd: "/nowhere" }))), undefined);
  // Trailing slashes, macOS /private and ~ are the same directory.
  assert.equal(I.pickWorker(all, I.parseSignal(sig({ cwd: "/tmp/demo-app/" }))).workerId, "recent");
  assert.equal(I.pickWorker(all, I.parseSignal(sig({ cwd: "/private/tmp/demo-app" }))).workerId, "recent");
  assert.equal(I.pickWorker([ctx("h", { cwd: "/home/me/app" })], I.parseSignal(sig({ cwd: "~/app" })), "/home/me").workerId, "h");
});

test("signal events are re-redacted, capped, and carry only a clean emoji as mood", () => {
  const c = ctx("w", { model: "m", project: "demo-app" });
  const now = Date.parse("2026-10-18T10:00:00Z");
  const e = I.signalEvent(I.parseSignal(sig({ text: "deploying with token=hunter2hunter2 ‮" + "x".repeat(200), mood: "🚀" })), c, now);
  assert.equal(e.kind, "status");
  assert.equal(e.workerId, "w");
  assert.equal(e.tool, "🚀");
  assert.ok([...e.summary].length <= 64);
  assert.ok(!e.summary.includes("hunter2") && !e.summary.includes("‮"));
  for (const bad of ["abc", "<img>", "🚀🚀🚀🚀🚀🚀🚀🚀🚀", 7]) assert.equal(I.cleanMood(bad), undefined, String(bad));
  // A timestamp from the future is clamped to now.
  assert.equal(I.signalEvent(I.parseSignal(sig({ ts: "2099-01-01T00:00:00Z", kind: "flip" })), c, now).ts, new Date(now).toISOString());
  assert.equal(I.signalEvent(I.parseSignal(sig({ kind: "celebrate" })), c, now).tool, undefined);
});

/* ------------------------------------------------------------ end to end */

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "agent-visualizer-signals-"));
  cpSync(join(FX, "claude"), join(dir, "claude"), { recursive: true });
  for (const f of walk(dir)) utimesSync(f, Date.now() / 1000, Date.now() / 1000);
  const outbox = join(dir, "agent-visualizer", "outbox");
  mkdirSync(outbox, { recursive: true });
  let clock = Date.now();
  const events = [];
  const ingest = I.createIngest({
    agents: ["claude"],
    onEvent: (e) => events.push(e),
    watch: false,
    now: () => clock,
    env: { AGENT_VISUALIZER_CLAUDE_DIR: join(dir, "claude"), AGENT_VISUALIZER_HOME: join(dir, "agent-visualizer") },
  });
  const tick = async () => {
    await ingest.tick();
    return events.splice(0);
  };
  return { dir, outbox, ingest, tick, advance: (ms) => (clock += ms) };
}

test("outbox: at startup only the latest status replays; live signals go to the matching worker", async () => {
  const o = setup();
  const f = join(o.outbox, "4242.jsonl");
  writeFileSync(f, [sig({ text: "old mood" }), sig({ kind: "shout", text: "old news" }), sig({ text: "current mood", mood: "🧪" }), sig({ kind: "flip" })].join("\n") + "\n");
  // A file older than GONE_MS is history.
  const stale = join(o.outbox, "1.jsonl");
  writeFileSync(stale, sig({ text: "ancient" }) + "\n");
  utimesSync(stale, (Date.now() - I.GONE_MS - 60_000) / 1000, (Date.now() - I.GONE_MS - 60_000) / 1000);

  const first = (await o.tick()).filter((e) => ["status", "shout", "celebrate", "flip"].includes(e.kind));
  assert.equal(first.length, 1);
  assert.equal(first[0].kind, "status");
  assert.equal(first[0].summary, "current mood");
  assert.equal(first[0].tool, "🧪");
  assert.equal(first[0].workerId, SID);

  appendFileSync(f, sig({ kind: "shout", text: "tests are green" }) + "\n" + sig({ kind: "celebrate" }) + "\n");
  const live = await o.tick();
  assert.deepEqual(live.map((e) => e.kind), ["shout", "celebrate"]);
  assert.ok(live.every((e) => e.workerId === SID && e.agent === "claude" && e.project === "demo-app"));

  // A new MCP server process (new file after startup) is read from the start, minus anything stale.
  const old = new Date(Date.now() - 10 * 60_000).toISOString();
  writeFileSync(join(o.outbox, "5000.jsonl"), sig({ kind: "shout", text: "from long ago", ts: old }) + "\n" + sig({ kind: "flip", agent: "codex" }) + "\n");
  const flips = await o.tick();
  assert.deepEqual(flips.map((e) => [e.kind, e.workerId]), [["flip", SID]]);
  o.ingest.stop();
  rmSync(o.dir, { recursive: true, force: true });
});

test("outbox: a signal waits briefly for its worker to show up, then is dropped", async () => {
  const o = setup();
  await o.tick();
  const f = join(o.outbox, "77.jsonl");
  writeFileSync(f, sig({ cwd: "/tmp/late-app", kind: "shout", text: "hello from the future" }) + "\n" + sig({ cwd: "/tmp/never", kind: "shout", text: "lost" }) + "\n");
  assert.deepEqual((await o.tick()).filter((e) => e.kind === "shout"), []);
  // The late worker's transcript appears.
  const late = join(o.dir, "claude", "projects", "-tmp-late-app");
  mkdirSync(late, { recursive: true });
  writeFileSync(join(late, "22222222-2222-4333-8444-555555555555.jsonl"),
    JSON.stringify({ type: "user", sessionId: "22222222-2222-4333-8444-555555555555", cwd: "/tmp/late-app", timestamp: new Date().toISOString(), message: { role: "user", content: "hi" } }) + "\n");
  o.advance(1_000);
  const got = (await o.tick()).filter((e) => e.kind === "shout");
  assert.deepEqual(got.map((e) => [e.workerId, e.summary]), [["22222222-2222-4333-8444-555555555555", "hello from the future"]]);
  o.advance(I.SIGNAL_WAIT_MS + 1_000);
  assert.deepEqual((await o.tick()).filter((e) => e.kind === "shout"), [], "the unmatched one is gone, not replayed");
  o.ingest.stop();
  rmSync(o.dir, { recursive: true, force: true });
});

test("outbox on a remote: signals reach that machine's workers, host-tagged", async () => {
  const home = mkdtempSync(join(tmpdir(), "agent-visualizer-sigremote-"));
  cpSync(join(FX, "claude"), join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".agent-visualizer", "outbox"), { recursive: true });
  for (const f of walk(home)) utimesSync(f, Date.now() / 1000, Date.now() / 1000);
  const target = {
    host: { kind: "boat", id: "boat:vm-1", name: "vm-1" },
    exec: (script) => new Promise((res, rej) => execFile("sh", ["-c", script], { env: { PATH: process.env.PATH, HOME: home }, maxBuffer: 16 << 20 }, (e, out) => (e ? rej(e) : res(out)))),
  };
  const events = [];
  const r = I.createIngest({ agents: ["claude"], local: false, remotes: [target], onEvent: (e) => events.push(e), watch: false });
  await r.tick();
  appendFileSync(join(home, ".agent-visualizer", "outbox", "9.jsonl"), sig({ kind: "celebrate" }) + "\n");
  events.length = 0;
  await r.tick();
  assert.deepEqual(events.map((e) => [e.kind, e.workerId, e.host?.kind]), [["celebrate", `boat:vm-1/${SID}`, "boat"]]);
  r.stop();
  rmSync(home, { recursive: true, force: true });
});

/* ----------------------------------------------- who called the tool */

test("attribution: the twin that is calling the office tool gets the signal, not the busier one", () => {
  const now = 50_000;
  const a = ctx("A", { at: 1_000 });
  const b = ctx("B", { at: 9_000 });
  // A's transcript shows the call still open; B just ran `ls`.
  a.pending.set("t1", { tool: "mcp__agent-visualizer__office_status", category: "mcp", test: false });
  let hit = I.pickSignalWorker([a, b], I.parseSignal(sig({})), undefined, now);
  assert.equal(hit.ctx.workerId, "A");
  assert.equal(hit.sure, true);
  // The call already returned: a recent office call still says who it was (Codex and opencode spell it differently).
  a.pending.clear();
  a.officeCall = { tool: "agent-visualizer__office_shout", at: now - 3_000 };
  assert.equal(I.pickSignalWorker([a, b], I.parseSignal(sig({ kind: "shout" })), undefined, now).ctx.workerId, "A");
  a.officeCall = { tool: "agent-visualizer_office_flip", at: now - 3_000 };
  b.officeCall = { tool: "mcp__agent-visualizer__office_shout", at: now - 1_000 };
  assert.equal(I.pickSignalWorker([a, b], I.parseSignal(sig({ kind: "flip" })), undefined, now).ctx.workerId, "A", "the exact tool beats another office tool");
  // Nothing says who: the most recent, but not sure (the loop waits a moment for a transcript to tell).
  a.officeCall = b.officeCall = undefined;
  hit = I.pickSignalWorker([a, b], I.parseSignal(sig({})), undefined, now);
  assert.equal(hit.ctx.workerId, "B");
  assert.equal(hit.sure, false);
  assert.equal(I.pickSignalWorker([a], I.parseSignal(sig({})), undefined, now).sure, true, "a lone worker is sure");
});

test("attribution: a worker started in a parent folder still gets its signals; home and / never match everything", () => {
  const app = ctx("app", { cwd: "/home/me/app" });
  const home = ctx("home", { cwd: "/home/me", at: 99_000 });
  assert.equal(I.pickWorker([app, home], I.parseSignal(sig({ cwd: "/home/me/app/packages/web" })), "/home/me").workerId, "app");
  assert.equal(I.pickWorker([home], I.parseSignal(sig({ cwd: "/home/me/elsewhere" })), "/home/me"), undefined);
  assert.equal(I.nestedCwd("/", "/tmp/x"), false);
  assert.equal(I.nestedCwd("/tmp/x", "/tmp/xy"), false);
  assert.equal(I.nestedCwd("/tmp/x/", "/private/tmp/x/y"), true);
});

test("attribution on Windows: drive letters and names without case, either slash, ~\\ for home", () => {
  const app = ctx("app", { cwd: "C:\\Users\\me\\app" });
  const home = ctx("home", { cwd: "C:\\Users\\me", at: 99_000 });
  // The MCP server's folder as the agent launched it, against the transcript's.
  assert.equal(I.pickWorker([app, home], I.parseSignal(sig({ cwd: "c:\\users\\me\\App" })), "C:\\Users\\me").workerId, "app");
  assert.equal(I.pickWorker([app, home], I.parseSignal(sig({ cwd: "C:/Users/me/app/packages/web" })), "C:\\Users\\me").workerId, "app");
  assert.equal(I.pickWorker([home], I.parseSignal(sig({ cwd: "C:\\Users\\me\\elsewhere" })), "C:\\Users\\me"), undefined);
  assert.equal(I.sameCwd("~\\app", "C:\\Users\\me\\app\\", "C:\\Users\\me"), true);
  assert.equal(I.nestedCwd("C:\\", "C:\\Users\\me\\app"), false, "a drive's root contains everything");
  assert.equal(I.nestedCwd("C:\\Users\\me\\app", "C:\\Users\\me\\app2"), false);
  assert.equal(I.nestedCwd("/tmp/x", "/tmp/x\\y"), false, "POSIX paths keep their one separator");
});

test("signal text is scrubbed like the MCP server's: no paths, emails or URLs, whoever wrote the line", () => {
  const c = ctx("w", { project: "demo-app" });
  const e = I.signalEvent(I.parseSignal(sig({ kind: "shout", text: "shipped /Users/alice/Clients/AcmeCorp/merger-plan.md to bob.smith@acme-corp.com via https://internal.acme.corp/deploy?id=42" })), c, Date.now());
  assert.equal(e.summary, "shipped merger-plan.md to ••• via internal.acme.corp");
});

test("outbox: twins in one repo; the signal follows the office_status call, even when the other twin is busier", async () => {
  const o = setup();
  const proj = join(o.dir, "claude", "projects", "-tmp-twins");
  mkdirSync(proj, { recursive: true });
  const A = "aaaaaaaa-2222-4333-8444-555555555555", B = "bbbbbbbb-2222-4333-8444-555555555555";
  const line = (id, o2) => JSON.stringify({ sessionId: id, cwd: "/tmp/twins", timestamp: new Date().toISOString(), ...o2 }) + "\n";
  const prompt = (id) => line(id, { type: "user", message: { role: "user", content: "go" } });
  writeFileSync(join(proj, `${A}.jsonl`), prompt(A));
  writeFileSync(join(proj, `${B}.jsonl`), prompt(B));
  await o.tick();
  appendFileSync(join(proj, `${A}.jsonl`), line(A, { type: "assistant", message: { id: "m1", role: "assistant", model: "claude-x", content: [{ type: "tool_use", id: "tu1", name: "mcp__agent-visualizer__office_status", input: { text: "x" } }] } }));
  o.advance(1_500);
  await o.tick();
  // The MCP server's line lands; B is the one that just did something.
  writeFileSync(join(o.outbox, "31.jsonl"), sig({ cwd: "/tmp/twins", text: "Refactoring auth", mood: "🔧" }) + "\n");
  appendFileSync(join(proj, `${B}.jsonl`), line(B, { type: "assistant", message: { id: "m2", role: "assistant", model: "claude-x", content: [{ type: "tool_use", id: "tu2", name: "Bash", input: { command: "ls" } }] } }));
  o.advance(1_500);
  const got = (await o.tick()).filter((e) => e.kind === "status");
  assert.deepEqual(got.map((e) => [e.workerId, e.summary, e.tool]), [[A, "Refactoring auth", "🔧"]]);
  o.ingest.stop();
  rmSync(o.dir, { recursive: true, force: true });
});

test("claude: the worker keeps the folder it started in when the agent cd's, so its project and signals stay put", async () => {
  const o = setup();
  const proj = join(o.dir, "claude", "projects", "-tmp-proj");
  mkdirSync(proj, { recursive: true });
  const S = "cccccccc-2222-4333-8444-555555555555";
  const line = (cwd, o2) => JSON.stringify({ sessionId: S, cwd, timestamp: new Date().toISOString(), ...o2 }) + "\n";
  writeFileSync(join(proj, `${S}.jsonl`), line("/tmp/proj", { type: "user", message: { role: "user", content: "go" } }));
  await o.tick();
  appendFileSync(join(proj, `${S}.jsonl`), line("/tmp/proj/packages/web", { type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm run dev" } }] } }));
  o.advance(1_500);
  const evs = await o.tick();
  assert.ok(evs.length && evs.every((e) => e.project === "proj" && e.cwd === "/tmp/proj"), JSON.stringify(evs.map((e) => [e.project, e.cwd])));
  writeFileSync(join(o.outbox, "32.jsonl"), sig({ cwd: "/tmp/proj", kind: "celebrate" }) + "\n");
  o.advance(1_500);
  assert.deepEqual((await o.tick()).filter((e) => e.kind === "celebrate").map((e) => e.workerId), [S]);
  o.ingest.stop();
  rmSync(o.dir, { recursive: true, force: true });
});
