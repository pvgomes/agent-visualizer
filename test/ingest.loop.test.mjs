// Tests for src/ingest/tail.ts and the ingest loop (src/ingest/index.ts): backfill, live tailing,
// partial lines, truncation, subagent lifecycle and parent lookup, on a temp copy of test/fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
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

const I = await load("src/ingest/index.ts", "src/ingest/tail.ts", "src/shared/events.ts");

const SID = "11111111-2222-4333-8444-555555555555";
const CLAUDE_DIR = (d) => join(d, "claude", "projects", "-tmp-demo-app");
const CLAUDE_MAIN = (d) => join(CLAUDE_DIR(d), `${SID}.jsonl`);
const SUBAGENTS = (d) => join(CLAUDE_DIR(d), SID, "subagents");
const CC_DIR = (d) => join(d, "commandcode", "projects", "tmp-demo-app");
const CC_V3 = (d) => join(CC_DIR(d), "aB3dE5gH7jK9mN1pQ3sT5.jsonl");
const CODEX_DAY = (d) => join(d, "codex", "sessions", "2026", "01", "15");
const CX = "019a0000-1111-7222-8333-444455556666";
const CX_SUB = "019a0000-9999-7aaa-8bbb-ccccddddeeee";

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function touch(path, ms = Date.now()) {
  utimesSync(path, ms / 1000, ms / 1000);
}

/** A temp copy of the fixtures, every file freshly modified. */
function fixtureDir(...only) {
  const dir = mkdtempSync(join(tmpdir(), "agent-visualizer-ingest-"));
  for (const a of only.length ? only : ["claude", "commandcode", "codex"]) cpSync(join(FX, a), join(dir, a), { recursive: true });
  for (const f of walk(dir)) touch(f);
  return dir;
}

function office(dir, agents = ["claude", "commandcode", "codex"]) {
  const events = [];
  let clock = Date.now();
  const ingest = I.createIngest({
    agents,
    onEvent: (e) => events.push(e),
    watch: false,
    now: () => clock,
    env: {
      AGENT_VISUALIZER_CLAUDE_DIR: join(dir, "claude"),
      AGENT_VISUALIZER_COMMANDCODE_DIR: join(dir, "commandcode"),
      AGENT_VISUALIZER_CODEX_DIR: join(dir, "codex"),
      // Keep the real MCP outbox out of the tests.
      AGENT_VISUALIZER_HOME: join(dir, "agent-visualizer"),
    },
  });
  return {
    ingest,
    advance: (ms) => (clock += ms),
    now: () => clock,
    /** Run one poll and return what it emitted. */
    tick: async () => {
      await ingest.tick();
      return events.splice(0);
    },
  };
}

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const claudeLine = (o) => JSON.stringify({ sessionId: SID, cwd: "/tmp/demo-app", timestamp: iso(), ...o }) + "\n";
const byWorker = (evs) => evs.reduce((m, e) => (m.get(e.workerId) ?? m.set(e.workerId, []).get(e.workerId)).push(e) && m, new Map());
const kinds = (evs) => evs.map((e) => e.kind);

/* ---------------------------------------------------------------- tail */

test("LineTail: partial lines, split UTF-8, mid-line seek, oversized lines", () => {
  const t = new I.LineTail("/nonexistent");
  const out = [];
  t.feed(Buffer.from('{"a":1}\n{"b":'), out);
  assert.deepEqual(out, ['{"a":1}']);
  const e = Buffer.from('2,"s":"é"}\n', "utf8");
  const cut = e.indexOf(0xc3) + 1; // split inside the two-byte é
  t.feed(e.subarray(0, cut), out);
  assert.equal(out.length, 1);
  t.feed(e.subarray(cut), out);
  assert.deepEqual(out, ['{"a":1}', '{"b":2,"s":"é"}']);
  t.feed(Buffer.from("\r\n\n  \nlast\r\n"), out);
  assert.deepEqual(out.slice(2), ["last"]);

  const mid = new I.LineTail("/nonexistent");
  mid.seek(100, true);
  const got = [];
  mid.feed(Buffer.from('l":"fragment"}\n{"whole":1}\n'), got);
  assert.deepEqual(got, ['{"whole":1}']);

  const small = new I.LineTail("/nonexistent", 16);
  const s = [];
  small.feed(Buffer.from("x".repeat(40)), s);
  small.feed(Buffer.from("still the same huge line\nok\n"), s);
  assert.deepEqual(s, ["ok"]);
});

test("LineTail.pull reads appended bytes and holds an unterminated line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-visualizer-tail-"));
  const f = join(dir, "x.jsonl");
  writeFileSync(f, "one\ntw");
  const t = new I.LineTail(f);
  assert.deepEqual(await t.pull(statSync(f).size), ["one"]);
  appendFileSync(f, "o\nthree\n");
  assert.deepEqual(await t.pull(statSync(f).size), ["two", "three"]);
  assert.equal(t.offset, statSync(f).size);
  assert.equal(await I.readFirstLine(f), "one");
  rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------- backfill */

test("backfill sends one announcement and one pose per live worker, nothing else", async () => {
  const dir = fixtureDir();
  const o = office(dir);
  const evs = await o.tick();
  const w = byWorker(evs);
  // Claude main: ends on an API error. Its Explore intern said end_turn: gone. Same for the CC intern.
  // The Codex subagent's turn is over, but its thread stays open: it sits at its desk, done, for a minute.
  assert.deepEqual([...w.keys()].sort(), [CX, CX_SUB, SID, "aB3dE5gH7jK9mN1pQ3sT5", "legacy-0001"].sort());
  assert.deepEqual(kinds(w.get(CX_SUB)), ["subagent_start", "idle"]);
  assert.deepEqual(kinds(w.get(SID)), ["session_start", "error"]);
  assert.deepEqual(kinds(w.get("aB3dE5gH7jK9mN1pQ3sT5")), ["session_start", "error"]);
  assert.deepEqual(kinds(w.get("legacy-0001")), ["session_start", "waiting"]);
  assert.deepEqual(kinds(w.get(CX)), ["session_start", "error"]);
  // Tokens ride on the announcement; the pose carries none.
  assert.equal(w.get(CX)[0].tokens, 1200);
  assert.equal(w.get(CX)[1].tokens, undefined);
  assert.ok(w.get(SID)[0].tokens > 0);
  // Legacy Command Code has no cwd of its own; a v3 sibling's header provides it.
  assert.equal(w.get("legacy-0001")[0].project, "demo-app");
  assert.equal(w.get("legacy-0001")[0].cwd, "/tmp/demo-app");
  assert.equal(w.get(SID)[0].model, "claude-opus-5-5");
  assert.equal(w.get(CX)[0].model, "gpt-6-codex");
  // A second poll with nothing new is silent.
  assert.deepEqual(await o.tick(), []);
  // A minute of quiet after its last turn, and the Codex intern leaves.
  o.advance(61_000);
  assert.deepEqual((await o.tick()).map((e) => [e.workerId, e.kind]), [[CX_SUB, "subagent_end"]]);
  o.ingest.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("files older than the active window are not backfilled, but are picked up when they grow", async () => {
  const dir = fixtureDir("claude");
  for (const f of walk(dir)) touch(f, Date.now() - 2 * 60 * 60_000);
  const o = office(dir, ["claude"]);
  assert.deepEqual(await o.tick(), []);
  appendFileSync(CLAUDE_MAIN(dir), claudeLine({ type: "user", message: { role: "user", content: "hello again" } }));
  o.advance(16_000); // next full scan stats files it already knows
  const evs = await o.tick();
  assert.deepEqual(kinds(evs), ["session_start", "prompt"]);
  assert.equal(evs[1].summary, "New prompt");
  o.ingest.stop();
  rmSync(dir, { recursive: true, force: true });
});

/* ----------------------------------------------------------------- live */

test("live tail: appended lines, a line split across polls, junk, a failing test", async () => {
  const dir = fixtureDir("claude");
  const o = office(dir, ["claude"]);
  await o.tick();
  const f = CLAUDE_MAIN(dir);
  const call = claudeLine({ type: "assistant", message: { id: "live_1", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "lt1", name: "Bash", input: { command: "pnpm test" } }], stop_reason: "tool_use" } });
  appendFileSync(f, claudeLine({ type: "user", message: { role: "user", content: "run the tests" } }) + call.slice(0, 40));
  assert.deepEqual(kinds(await o.tick()), ["prompt"]);
  appendFileSync(f, call.slice(40));
  const started = await o.tick();
  assert.deepEqual(kinds(started), ["tool_start"]);
  assert.equal(started[0].summary, "$ pnpm test");
  appendFileSync(f, "{not json at all\n" + claudeLine({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "lt1", is_error: true, content: "Exit code 1\nFAIL a.test.ts" }] } }));
  const done = await o.tick();
  assert.deepEqual(kinds(done), ["tool_end", "test_fail"]);
  assert.equal(done[1].isError, true);
  o.ingest.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("truncation: a file that shrinks is re-read from its new tail", async () => {
  const dir = fixtureDir("commandcode");
  const o = office(dir, ["commandcode"]);
  await o.tick();
  const head = { type: "session", version: 3, id: "aB3dE5gH7jK9mN1pQ3sT5", timestamp: iso(), cwd: "/tmp/demo-app" };
  const msg = (role, content) => ({ type: "message", id: "r" + Math.random(), timestamp: iso(), message: { role, content, meta: { source: role === "user" ? "user" : "model" } } });
  writeFileSync(CC_V3(dir), [head, msg("user", [{ type: "text", text: "x" }]), msg("assistant", [{ type: "text", text: "y" }])].map((x) => JSON.stringify(x)).join("\n") + "\n");
  const evs = await o.tick();
  assert.deepEqual(kinds(evs), ["session_start", "waiting"]);
  appendFileSync(CC_V3(dir), JSON.stringify(msg("user", [{ type: "text", text: "again" }])) + "\n");
  assert.deepEqual(kinds(await o.tick()), ["prompt"]);
  o.ingest.stop();
  rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------ subagents */

test("claude subagents: walk in, leave on end_turn, on meta finished, or when quiet", async () => {
  const dir = fixtureDir("claude");
  const o = office(dir, ["claude"]);
  await o.tick();
  const sub = (id, lines, meta) => {
    writeFileSync(join(SUBAGENTS(dir), `agent-${id}.meta.json`), JSON.stringify(meta));
    writeFileSync(join(SUBAGENTS(dir), `agent-${id}.jsonl`), lines.map((l) => claudeLine({ isSidechain: true, agentId: id, ...l })).join(""));
  };
  const prompt = { type: "user", message: { role: "user", content: "do the thing" } };
  const pendingTool = { type: "assistant", message: { id: "s1", model: "claude-haiku-5", content: [{ type: "tool_use", id: "x1", name: "Read", input: { file_path: "/tmp/demo-app/a.ts" } }], stop_reason: "tool_use" } };

  // 1. Arrives mid-tool: announced with its parent, posed on its open call.
  sub("p1", [prompt, pendingTool], { agentType: "Plan" });
  let evs = (await o.tick()).filter((e) => e.workerId === "agent-p1");
  assert.deepEqual(kinds(evs), ["subagent_start", "tool_start"]);
  assert.equal(evs[0].parentId, SID);
  assert.equal(evs[0].role, "Plan");
  // ...and leaves when it says end_turn.
  appendFileSync(join(SUBAGENTS(dir), "agent-p1.jsonl"),
    claudeLine({ isSidechain: true, agentId: "p1", type: "user", message: { content: [{ type: "tool_result", tool_use_id: "x1", content: "ok" }] } }) +
    claudeLine({ isSidechain: true, agentId: "p1", type: "assistant", message: { id: "s2", content: [{ type: "text", text: "done" }], stop_reason: "end_turn" } }));
  evs = (await o.tick()).filter((e) => e.workerId === "agent-p1");
  assert.deepEqual(kinds(evs), ["tool_end", "reply", "subagent_end"]);

  // 2. Leaves when its .meta.json says finished.
  sub("p2", [prompt, pendingTool], { agentType: "Explore" });
  assert.deepEqual(kinds((await o.tick()).filter((e) => e.workerId === "agent-p2")), ["subagent_start", "tool_start"]);
  const meta2 = join(SUBAGENTS(dir), "agent-p2.meta.json");
  writeFileSync(meta2, JSON.stringify({ agentType: "Explore", finished: true }));
  touch(meta2, Date.now() + 5_000);
  assert.deepEqual(kinds((await o.tick()).filter((e) => e.workerId === "agent-p2")), ["subagent_end"]);

  // 3. Leaves when its transcript goes quiet (no open tool call: 3 minutes).
  sub("p3", [prompt], { agentType: "general-purpose" });
  assert.deepEqual(kinds((await o.tick()).filter((e) => e.workerId === "agent-p3")), ["subagent_start", "prompt"]);
  o.advance(I.SUBAGENT_QUIET_MS + 1_000);
  assert.deepEqual(kinds((await o.tick()).filter((e) => e.workerId === "agent-p3")), ["subagent_end"]);

  // A finished intern is never backfilled by a fresh office.
  const fresh = office(dir, ["claude"]);
  const all = await fresh.tick();
  assert.equal(all.filter((e) => e.workerId === "agent-p2" || e.workerId === "agent-p1").length, 0);
  o.ingest.stop();
  fresh.ingest.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("claude subagents: one resumed after it finished (a message to it) walks back in", async () => {
  const dir = fixtureDir("claude");
  const o = office(dir, ["claude"]);
  await o.tick();
  const file = join(SUBAGENTS(dir), "agent-r1.jsonl");
  const meta = join(SUBAGENTS(dir), "agent-r1.meta.json");
  const L = (l) => claudeLine({ isSidechain: true, agentId: "r1", ...l });
  const call = (id) => L({ type: "assistant", message: { id: `m-${id}`, content: [{ type: "tool_use", id, name: "Bash", input: { command: "git status" } }], stop_reason: "tool_use" } });
  const result = (id) => L({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
  const done = L({ type: "assistant", message: { id: "m-done", content: [{ type: "text", text: "report" }], stop_reason: "end_turn" } });
  let metaAt = Date.now();
  const writeMeta = (m) => {
    writeFileSync(meta, JSON.stringify({ agentType: "general-purpose", ...m }));
    touch(meta, (metaAt += 5_000));
  };
  const mine = (evs) => evs.filter((e) => e.workerId === "agent-r1");

  writeMeta({});
  writeFileSync(file, L({ type: "user", message: { role: "user", content: "do the thing" } }) + call("c1"));
  assert.deepEqual(kinds(mine(await o.tick())), ["subagent_start", "tool_start"]);

  // It finishes: its turn ends, and Claude Code marks the meta finished (read first: it just leaves).
  appendFileSync(file, result("c1") + done);
  writeMeta({ finished: true });
  assert.deepEqual(kinds(mine(await o.tick())), ["subagent_end"]);
  assert.deepEqual(mine(await o.tick()), []);

  // A message resumes it: the meta is rewritten without "finished" and it gets to work again.
  writeMeta({});
  appendFileSync(file, L({ type: "user", message: { role: "user", content: "<made-up>message</made-up>" }, origin: { kind: "peer" } }) + call("c2"));
  let evs = mine(await o.tick());
  assert.deepEqual(kinds(evs), ["subagent_start", "tool_start"]);
  assert.equal(evs[0].parentId, SID);
  assert.equal(evs[0].role, "general-purpose");
  appendFileSync(file, result("c2") + call("c3"));
  assert.deepEqual(kinds(mine(await o.tick())), ["tool_end", "tool_start"]);

  // ...and finishes again.
  appendFileSync(file, result("c3") + done);
  writeMeta({ finished: true });
  evs = mine(await o.tick());
  assert.equal(evs.at(-1).kind, "subagent_end");
  appendFileSync(file, call("c4"));
  assert.deepEqual(mine(await o.tick()), [], "a finished agent's stray lines stay hidden");
  o.ingest.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("a busy intern keeps its quiet parent in the office", async () => {
  const dir = fixtureDir("claude");
  const o = office(dir, ["claude"]);
  await o.tick(); // the parent's last line is from the fixture, long ago
  writeFileSync(join(SUBAGENTS(dir), "agent-k1.jsonl"), claudeLine({ isSidechain: true, agentId: "k1", type: "user", message: { role: "user", content: "go" } }));
  const evs = await o.tick();
  const parentSightings = evs.filter((e) => e.workerId === SID && e.kind === "session_start");
  assert.equal(parentSightings.length, 1, "re-sighted with the intern's timestamp");
  assert.ok(Date.parse(parentSightings[0].ts) > Date.parse("2026-01-15T11:00:00Z"));
  o.ingest.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("codex: an active subagent pulls in its parent even when the parent is old; an orphan stands alone", async () => {
  const dir = fixtureDir("codex");
  rmSync(join(CODEX_DAY(dir), `rollout-2026-01-15T10-00-12-${CX_SUB}.jsonl`));
  touch(join(CODEX_DAY(dir), `rollout-2026-01-15T10-00-00-${CX}.jsonl`), Date.now() - 3 * 60 * 60_000);
  const L = (type, payload) => JSON.stringify({ timestamp: iso(), type, payload });
  const child = (id, parent) =>
    writeFileSync(join(CODEX_DAY(dir), `rollout-2026-01-15T11-00-00-${id}.jsonl`), [
      L("session_meta", { id, cwd: "/tmp/demo-app", source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_nickname: "Ada" } } } }),
      L("event_msg", { type: "user_message", message: "task" }),
      L("response_item", { type: "function_call", name: "exec_command", arguments: '{"cmd":"go test ./..."}', call_id: "k1" }),
    ].join("\n") + "\n");
  const KID = "019a0000-aaaa-7bbb-8ccc-ddddeeeeffff";
  const ORPHAN = "019a0000-bbbb-7ccc-8ddd-eeeeffff0000";
  child(KID, CX);
  child(ORPHAN, "019a0000-0000-7000-8000-000000000000");
  const o = office(dir, ["codex"]);
  const evs = await o.tick();
  const parentIdx = evs.findIndex((e) => e.workerId === CX && e.kind === "session_start");
  const kidIdx = evs.findIndex((e) => e.workerId === KID && e.kind === "subagent_start");
  assert.ok(parentIdx >= 0 && kidIdx > parentIdx, "parent announced before its intern");
  // The parent's own lines are months old; it is announced as active so the server doesn't send it home.
  assert.ok(Date.parse(evs[parentIdx].ts) > Date.now() - 60_000);
  assert.equal(evs[kidIdx].parentId, CX);
  assert.equal(evs[kidIdx].role, "Ada");
  const kidPose = evs.filter((e) => e.workerId === KID).at(-1);
  assert.equal(kidPose.kind, "tool_start");
  assert.equal(kidPose.summary, "$ go test");
  const orphan = evs.filter((e) => e.workerId === ORPHAN);
  assert.equal(orphan[0].kind, "session_start");
  assert.equal(orphan[0].parentId, undefined);
  o.ingest.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("missing folders are fine and ignored files stay ignored", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-visualizer-empty-"));
  const o = office(dir);
  assert.deepEqual(await o.tick(), []);
  // Command Code checkpoint and audit logs are never treated as sessions.
  const cc = join(dir, "commandcode", "projects", "x");
  mkdirSync(cc, { recursive: true });
  writeFileSync(join(cc, "abc.checkpoints.jsonl"), JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "x" }] } }) + "\n");
  writeFileSync(join(cc, "hooks-audit-1.jsonl"), JSON.stringify({ role: "user", content: "x" }) + "\n");
  assert.deepEqual(await o.tick(), []);
  o.ingest.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("startIngest starts polling and stop() ends it", async () => {
  const dir = fixtureDir("claude");
  const got = [];
  const prev = process.env.AGENT_VISUALIZER_CLAUDE_DIR;
  const prevHome = process.env.AGENT_VISUALIZER_HOME;
  process.env.AGENT_VISUALIZER_CLAUDE_DIR = join(dir, "claude");
  process.env.AGENT_VISUALIZER_HOME = join(dir, "agent-visualizer");
  try {
    const h = I.startIngest({ agents: ["claude"], onEvent: (e) => got.push(e) });
    for (let i = 0; i < 50 && !got.length; i++) await new Promise((r) => setTimeout(r, 20));
    h.stop();
    assert.deepEqual(kinds(got), ["session_start", "error"]);
  } finally {
    if (prev === undefined) delete process.env.AGENT_VISUALIZER_CLAUDE_DIR;
    else process.env.AGENT_VISUALIZER_CLAUDE_DIR = prev;
    if (prevHome === undefined) delete process.env.AGENT_VISUALIZER_HOME;
    else process.env.AGENT_VISUALIZER_HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gemini: a reply followed by a few seconds of quiet is the end of the turn: the worker waits on its human", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-visualizer-gemini-"));
  const chats = join(dir, "tmp", "demo-app", "chats");
  mkdirSync(chats, { recursive: true });
  const f = join(chats, "session-2026-10-18T10-00-abcd1234.jsonl");
  const t0 = Date.now();
  const at = (ms) => new Date(t0 + ms).toISOString();
  writeFileSync(f, JSON.stringify({ sessionId: "abcd1234-0000-4000-8000-000000000001", projectHash: "0f", startTime: at(0), lastUpdated: at(0), kind: "main" }) + "\n" +
    JSON.stringify({ id: "m1", timestamp: at(1), type: "user", content: [{ text: "hi" }] }) + "\n");
  let clock = t0;
  const events = [];
  const ingest = I.createIngest({ agents: ["gemini"], onEvent: (e) => events.push(e), watch: false, now: () => clock, env: { AGENT_VISUALIZER_GEMINI_DIR: dir, AGENT_VISUALIZER_HOME: join(dir, "ao") } });
  await ingest.tick();
  appendFileSync(f, JSON.stringify({ id: "m2", timestamp: at(2), type: "gemini", content: "Done, the build is green.", model: "gemini-3-pro" }) + "\n");
  clock += 1_500;
  await ingest.tick();
  assert.ok(events.some((e) => e.kind === "reply"));
  assert.ok(!events.some((e) => e.kind === "waiting"), "not yet: tool calls can still be appended to that message");
  clock += 6_000;
  await ingest.tick();
  assert.deepEqual(events.filter((e) => e.kind === "waiting").map((e) => e.summary), ["Waiting"]);
  clock += 6_000;
  await ingest.tick();
  assert.equal(events.filter((e) => e.kind === "waiting").length, 1, "once");
  ingest.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("gemini: a hashed project folder takes its cwd from .project_root, a Windows path included", async () => {
  for (const root of ["/tmp/demo-app", "C:\\Users\\me\\demo-app"]) {
    const dir = mkdtempSync(join(tmpdir(), "agent-visualizer-gemini-"));
    const proj = join(dir, "tmp", "0f".repeat(32));
    mkdirSync(join(proj, "chats"), { recursive: true });
    writeFileSync(join(proj, ".project_root"), root);
    const at = new Date().toISOString();
    writeFileSync(join(proj, "chats", "session-2026-10-18T10-00-abcd1234.jsonl"), JSON.stringify({ sessionId: "abcd1234-0000-4000-8000-000000000001", startTime: at, lastUpdated: at, kind: "main" }) + "\n" +
      JSON.stringify({ id: "m1", timestamp: at, type: "user", content: [{ text: "hi" }] }) + "\n");
    const events = [];
    const ingest = I.createIngest({ agents: ["gemini"], onEvent: (e) => events.push(e), watch: false, env: { AGENT_VISUALIZER_GEMINI_DIR: dir, AGENT_VISUALIZER_HOME: join(dir, "ao") } });
    await ingest.tick();
    ingest.stop();
    assert.equal(events.find((e) => e.kind === "session_start")?.cwd, root);
    rmSync(dir, { recursive: true, force: true });
  }
});
