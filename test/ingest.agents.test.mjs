// Tests for the parsers of the newer agents (src/ingest/droid.ts, qwen.ts, cursor.ts, gemini.ts, opencode.ts, copilot.ts)
// on the synthetic fixtures in test/fixtures/{droid,qwen,cursor,gemini,copilot} and hand-built opencode rows.
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

const P = await load(
  "src/ingest/droid.ts", "src/ingest/qwen.ts", "src/ingest/cursor.ts", "src/ingest/gemini.ts", "src/ingest/opencode.ts", "src/ingest/copilot.ts",
  "src/ingest/discover.ts", "src/shared/events.ts",
);

const lines = (rel) => readFileSync(join(FX, rel), "utf8").split("\n").filter(Boolean);
const run = (parse, rel) => lines(rel).flatMap((l) => parse(l));
const kinds = (evs) => evs.map((e) => e.kind);
const of = (evs, kind) => evs.filter((e) => e.kind === kind);
const SUMMARY_OK = (evs) => evs.every((e) => !e.summary || [...e.summary].length <= P.SUMMARY_MAX);

/* ------------------------------------------------------------------ droid */

const DID = "d0000000-1111-4222-8333-444444444444";
const DROID = `droid/sessions/-tmp-demo-app/${DID}.jsonl`;

test("droid: prompt, tools, a failing then a piped passing test, a Task intern, reply", () => {
  const st = P.createDroidState({ sessionId: DID });
  P.applyDroidSettings(st, JSON.parse(readFileSync(join(FX, DROID.replace(".jsonl", ".settings.json")), "utf8")));
  const evs = run((l) => P.parseDroidLine(st, l), DROID);
  // The system reminder is not a prompt; the real one is.
  assert.equal(of(evs, "prompt").length, 1);
  assert.equal(st.main.cwd, "/tmp/demo-app");
  assert.equal(st.main.project, "demo-app");
  assert.equal(st.main.model, "claude-opus-5-5");
  // Settings tokens (1000 + 200 + 300) ride on the first event after the announcement.
  assert.equal(evs.reduce((n, e) => n + (e.tokens ?? 0), 0), 1500);
  const starts = of(evs, "tool_start").filter((e) => !e.parentId);
  assert.deepEqual(starts.map((e) => e.summary), ["Read app.ts", "$ npm test", "Spawn worker", "Edit app.ts", "$ npm test"]);
  assert.deepEqual(starts.map((e) => e.category), ["read", "bash", "agent", "edit", "bash"]);
  // "Exit code: 1" fails the first run; the piped second run has no failure markers.
  assert.deepEqual(kinds(evs).filter((k) => k.startsWith("test_")), ["test_fail", "test_pass"]);
  // The Task call is a synthetic intern for exactly as long as the call.
  const intern = evs.filter((e) => e.parentId === DID);
  assert.deepEqual(kinds(intern), ["subagent_start", "thinking", "subagent_end"]);
  assert.equal(intern[0].role, "worker");
  assert.deepEqual(kinds(evs).slice(-2), ["reply", "waiting"]);
  assert.ok(SUMMARY_OK(evs));
});

test("droid: settings growth adds only the difference; interrupts are errors", () => {
  const st = P.createDroidState({ sessionId: "x" });
  P.applyDroidSettings(st, { tokenUsage: { inputTokens: 100, outputTokens: 10 } });
  P.applyDroidSettings(st, { tokenUsage: { inputTokens: 150, outputTokens: 10 } });
  assert.equal(st.main.pendingTokens, 160);
  const evs = P.parseDroidLine(st, JSON.stringify({ type: "message", timestamp: "2026-01-15T10:00:00Z", message: { role: "user", content: [{ type: "text", text: "Request interrupted by user" }] } }));
  assert.deepEqual(kinds(evs), ["session_start", "error"]);
  assert.equal(evs[1].summary, "Interrupted");
});

/* ---------------------------------------------------------------- copilot */

const CPID = "c0000000-1111-4222-8333-666666666666";
const COPILOT = `copilot/session-state/${CPID}/events.jsonl`;

test("copilot: tools, exit codes, a subagent intern, MCP, reply and waiting, ask_user, error, shutdown", () => {
  const st = P.createCopilotState({ sessionId: CPID });
  const evs = run((l) => P.parseCopilotLine(st, l), COPILOT);
  // Nothing from a prompt, a reply, a file, a pattern or a tool argument leaks into an event.
  assert.doesNotMatch(JSON.stringify(evs), /SECRET_NEEDLE|hunter2|ghp_/);
  assert.ok(SUMMARY_OK(evs));
  const main = evs.filter((e) => !e.parentId);
  for (const e of main) assert.equal(e.workerId, CPID);
  assert.equal(main[0].kind, "session_start");
  assert.equal(main[0].cwd, "/tmp/demo-app");
  assert.equal(main[0].project, "demo-app");
  assert.equal(main[0].model, "claude-sonnet-5.5", "auto mode resolves to the model it picked");
  // Only the human's prompts, never a subagent's brief or the system prompt.
  assert.equal(of(evs, "prompt").length, 2);
  const starts = of(main, "tool_start");
  // report_intent is bookkeeping, not work.
  assert.deepEqual(starts.map((e) => e.summary), ["$ npm test", "Read login.ts", "Edit login.ts", "Spawn explore", "github · get_issue", "$ npm test", "Question for you"]);
  assert.deepEqual(starts.map((e) => e.category), ["bash", "read", "edit", "agent", "mcp", "bash", "other"]);
  // Exit code 1 fails the first run even though the tool call itself succeeded; the second passes.
  assert.deepEqual(kinds(evs).filter((k) => k.startsWith("test_")), ["test_fail", "test_pass"]);
  // The failed edit is an error on its tool_end.
  assert.equal(of(main, "tool_end").find((e) => e.summary === starts[2].summary).isError, true);
  // The subagent is an intern for as long as it runs, doing its own tool calls.
  const intern = evs.filter((e) => e.parentId === CPID);
  assert.equal(intern[0].kind, "subagent_start");
  assert.equal(intern[0].role, "Explore Agent");
  assert.ok(intern.some((e) => e.kind === "tool_start" && e.category === "search"));
  assert.equal(intern.at(-1).kind, "subagent_end");
  // A reply with no tool calls, then its turn_end: the human's turn. ask_user also waits on them.
  const k = kinds(main);
  assert.deepEqual(k.slice(k.indexOf("reply"), k.indexOf("reply") + 2), ["reply", "waiting"]);
  assert.ok(main.some((e) => e.kind === "waiting" && e.summary === "Needs you"));
  assert.equal(of(main, "error").length, 1);
  assert.equal(main.at(-1).kind, "session_end", "a clean shutdown sends it home");
  assert.equal(evs.reduce((n, e) => n + (e.tokens ?? 0), 0), 1200);
});

test("copilot: a resumed session comes back after its shutdown", () => {
  const st = P.createCopilotState({ sessionId: "s" });
  const line = (type, data) => JSON.stringify({ type, data, timestamp: "2026-01-15T10:00:00Z" });
  P.parseCopilotLine(st, line("session.start", { context: { cwd: "/w/app" } }));
  assert.deepEqual(kinds(P.parseCopilotLine(st, line("user.message", { content: "hi" }))), ["session_start", "prompt"]);
  assert.deepEqual(kinds(P.parseCopilotLine(st, line("session.shutdown", {}))), ["session_end"]);
  P.parseCopilotLine(st, line("session.resume", { context: { cwd: "/w/app" } }));
  assert.deepEqual(kinds(P.parseCopilotLine(st, line("assistant.turn_start", {}))), ["session_start", "thinking"]);
});

test("copilot: discovery finds <id>/events.jsonl under session-state and nothing else", () => {
  const roots = P.agentRoots("copilot", { home: "/h", vars: {} });
  assert.deepEqual(roots, ["/h/.copilot/session-state"]);
  assert.deepEqual(P.agentRoots("copilot", { home: "/h", vars: { COPILOT_HOME: "/c" } }), ["/c/session-state"]);
  const d = P.DRIVERS.copilot;
  const f = (p) => d.classify("/r", { path: p, size: 1, mtimeMs: 1, ino: 1 });
  assert.equal(f(`/r/${CPID}/events.jsonl`)?.agent, "copilot");
  assert.equal(f(`/r/${CPID}/checkpoints/events.jsonl`), null);
  assert.equal(f("/r/not-a-session/events.jsonl"), null);
  assert.equal(f(`/r/${CPID}/other.jsonl`), null);
});

/* ------------------------------------------------------------------- qwen */

const QID = "q0000000-1111-4222-8333-555555555555";
const QWEN = `qwen/projects/-tmp-demo-app/chats/${QID}.jsonl`;

test("qwen: Gemini-style parts, exit code from the output, a task intern, a failed edit; telemetry ignored", () => {
  const st = P.createQwenState({ sessionId: QID });
  const evs = run((l) => P.parseQwenLine(st, l), QWEN);
  assert.equal(st.main.cwd, "/tmp/demo-app");
  assert.equal(st.main.model, "qwen3-coder-plus");
  assert.equal(of(evs, "prompt").length, 1, "telemetry and slash-command lines are not prompts");
  const starts = of(evs, "tool_start").filter((e) => !e.parentId);
  assert.deepEqual(starts.map((e) => e.summary), ["Read server.ts", "$ pnpm test", "Spawn reviewer", "Edit server.ts"]);
  // toolCallResult says success, but the shell output says "Exit Code: 1".
  const fail = of(evs, "test_fail");
  assert.equal(fail.length, 1);
  assert.equal(fail[0].summary, "$ pnpm test");
  assert.equal(of(evs, "tool_end").find((e) => e.tool === "edit").isError, true);
  const intern = evs.filter((e) => e.parentId === QID);
  assert.deepEqual(kinds(intern), ["subagent_start", "thinking", "subagent_end"]);
  assert.equal(intern[0].role, "reviewer");
  assert.equal(evs.reduce((n, e) => n + (e.tokens ?? 0), 0), 2500);
  assert.deepEqual(kinds(evs).slice(-2), ["reply", "waiting"]);
  // Nothing from the telemetry payload (which echoes model output) reaches a label.
  assert.ok(evs.every((e) => !/ECHOES/.test(e.summary ?? "")));
});

/* ----------------------------------------------------------------- cursor */

const CID = "c0000000-1111-4222-8333-666666666666";
const SUB = "c0000000-9999-4aaa-8bbb-777777777777";
const CURSOR = `cursor/projects/tmp-demo-app/agent-transcripts/${CID}/${CID}.jsonl`;
const CURSOR_SUB = `cursor/projects/tmp-demo-app/agent-transcripts/${CID}/subagents/${SUB}.jsonl`;

test("cursor: no timestamps or results; calls close when the model speaks again, the turn end closes the rest", () => {
  const st = P.createCursorState({ sessionId: CID, slug: "tmp-demo-app" });
  st.clock = "2026-01-15T10:00:00.000Z";
  const evs = run((l) => P.parseCursorLine(st, l), CURSOR);
  assert.ok(evs.every((e) => e.ts === "2026-01-15T10:00:00.000Z"), "the loop's clock stamps every event");
  assert.equal(of(evs, "prompt").length, 1, "<user_query> is a prompt, other wrappers are not");
  // cwd is recovered from an absolute path that matches the slug.
  assert.equal(st.main.cwd, "/tmp/demo-app");
  assert.equal(st.main.project, "demo-app");
  const starts = of(evs, "tool_start");
  assert.deepEqual(starts.map((e) => e.summary), ["Read index.ts", "$ bun test", "Spawn explore", "Edit index.ts"]);
  assert.equal(of(evs, "tool_end").length, 4);
  // Test results are never written, so there is no verdict.
  assert.equal(evs.filter((e) => e.kind.startsWith("test_")).length, 0);
  assert.equal(st.lastSpawnRole, "explore");
  assert.deepEqual(kinds(evs).slice(-2), ["reply", "waiting"]);
});

test("cursor: a subagent transcript is an intern that leaves at its turn end; aborted turns are errors", () => {
  const st = P.createCursorState({ sessionId: SUB, slug: "tmp-demo-app", parentId: CID, role: "explore" });
  const evs = run((l) => P.parseCursorLine(st, l), CURSOR_SUB);
  assert.deepEqual(kinds(evs), ["subagent_start", "prompt", "tool_start", "tool_end", "reply", "subagent_end"]);
  assert.ok(evs.every((e) => e.parentId === CID && e.role === "explore"));
  const m = P.createCursorState({ sessionId: "z", slug: "x" });
  const ab = P.parseCursorLine(m, JSON.stringify({ type: "turn_ended", status: "aborted" }));
  assert.deepEqual(kinds(ab), ["session_start", "error", "waiting"]);
  assert.equal(ab[1].summary, "Interrupted");
});

test("cwdFromSlug matches Claude- and Cursor-style slugs and rejects strangers", () => {
  assert.equal(P.cwdFromSlug("tmp-demo-app", "/tmp/demo-app/src/a.ts"), "/tmp/demo-app");
  assert.equal(P.cwdFromSlug("-Users-me-my.app", "/Users/me/my.app/x/y.ts"), "/Users/me/my.app");
  assert.equal(P.cwdFromSlug("tmp-demo-app", "/etc/passwd"), undefined);
  assert.equal(P.cwdFromSlug("tmp-demo-app", "relative/path"), undefined);
  // Windows: Claude Code's slug for C:\Users\me\my.app, the cwd as the transcript spells it.
  assert.equal(P.cwdFromSlug("C--Users-me-my-app", "C:\\Users\\me\\my.app\\src\\a.ts"), "C:\\Users\\me\\my.app");
  assert.equal(P.cwdFromSlug("c-Users-me-my-app", "C:/Users/me/my.app/x"), "C:\\Users\\me\\my.app", "case and the drive's dashes don't count");
  assert.equal(P.cwdFromSlug("C--Users-me-my-app", "D:\\Users\\me\\my.app"), undefined);
  assert.equal(P.cwdFromSlug("C--", "C:\\x.ts"), "C:\\");
});

/* ----------------------------------------------------------------- gemini */

const GID = "a1b2c3d4-0000-4000-8000-000000000001";
const GDIR = "gemini/tmp/demo-app/chats";

test("gemini: messages re-appended as they change are de-duplicated; tool calls end as they complete", () => {
  const st = P.createGeminiState({ sessionId: GID, cwd: "/tmp/demo-app" });
  const evs = run((l) => P.parseGeminiLine(st, l), `${GDIR}/session-2026-01-15T10-00-a1b2c3d4.jsonl`);
  assert.equal(of(evs, "prompt").length, 1);
  assert.equal(st.main.model, "gemini-3-pro");
  // m2 is written three times; its tokens count once and its tool call starts once.
  assert.equal(evs.reduce((n, e) => n + (e.tokens ?? 0), 0), 125);
  assert.deepEqual(of(evs, "tool_start").map((e) => e.summary), ["$ npm test", "Edit a.ts"]);
  assert.equal(of(evs, "test_fail").length, 1, "Exit Code: 1 in the function response");
  // A call awaiting approval asks for the human, then ends when approved.
  const i = kinds(evs).indexOf("waiting");
  assert.ok(i > 0 && evs[i].summary === "Needs you");
  assert.equal(kinds(evs).at(-1), "reply");
  assert.deepEqual(P.parseGeminiLine(st, lines(`${GDIR}/session-2026-01-15T10-00-a1b2c3d4.jsonl`).at(-1)), [], "a repeated record says nothing new");
});

test("gemini: subagents nest under the parent id; a legacy .json document replays once", () => {
  const sub = P.createGeminiState({ sessionId: "e5f6a7b8-0000-4000-8000-000000000002", parentId: GID });
  const evs = run((l) => P.parseGeminiLine(sub, l), `${GDIR}/${GID}/e5f6a7b8-0000-4000-8000-000000000002.jsonl`);
  assert.deepEqual(kinds(evs), ["subagent_start", "prompt", "tool_start", "tool_end"]);
  assert.equal(sub.main.cwd, "/tmp/demo-app", "from the metadata's directories");
  assert.equal(evs[2].summary, "Search *.test.ts");

  const doc = P.createGeminiState({ sessionId: "deadbeef", project: "demo-app" });
  const text = readFileSync(join(FX, `${GDIR}/session-2026-01-14T09-00-deadbeef.json`), "utf8");
  const first = P.parseGeminiDoc(doc, text);
  assert.deepEqual(kinds(first), ["session_start", "prompt", "tool_start", "tool_end", "reply"]);
  assert.equal(first.at(-1).tokens, 15);
  assert.deepEqual(P.parseGeminiDoc(doc, text), []);
  assert.equal(P.geminiShortId("session-2026-01-15T10-00-a1b2c3d4.jsonl"), "a1b2c3d4");
});

/* --------------------------------------------------------------- opencode */

const T0 = Date.parse("2026-01-15T10:00:00Z");
const sess = (o = {}) => ({ id: "ses_main", parent_id: null, directory: "/tmp/demo-app", agent: "build", time_created: T0, time_updated: T0 + 60_000, ...o });
const msg = (id, role, t, o = {}) => ({ id, session_id: "ses_main", time_created: T0 + t, time_updated: T0 + t, role, ...o });
const part = (id, message_id, t, o) => ({ id, message_id, time_created: T0 + t, time_updated: T0 + t, ...o });

test("opencode: parts are diffed across polls: a tool goes pending -> running -> completed once", () => {
  const st = P.createOpencodeState(sess());
  const u = msg("msg_01", "user", 0);
  const a = msg("msg_02", "assistant", 1_000, { model: "claude-opus-5-5", cwd: "/tmp/demo-app", finish: null, completed: null });
  let evs = P.applyOpencode(st, [u, a], [
    part("prt_01", "msg_01", 0, { type: "text", text_len: 12 }),
    part("prt_02", "msg_02", 1_100, { type: "reasoning" }),
    part("prt_03", "msg_02", 1_200, { type: "tool", tool: "bash", status: "running", command: "cd /tmp/demo-app && pnpm test" }),
  ]);
  assert.deepEqual(kinds(evs), ["session_start", "prompt", "thinking", "tool_start"]);
  assert.equal(evs[3].summary, "$ pnpm test");
  assert.equal(st.main.model, "claude-opus-5-5");
  // Same rows again: nothing new.
  assert.deepEqual(P.applyOpencode(st, [u, a], [part("prt_03", "msg_02", 1_200, { type: "tool", tool: "bash", status: "running", command: "pnpm test" })]), []);
  // Completed with a non-zero exit: tool_end + test_fail, then the step's tokens and the turn's end.
  const done = { ...a, finish: "stop", completed: T0 + 5_000, time_updated: T0 + 5_000 };
  evs = P.applyOpencode(st, [u, done], [
    { ...part("prt_03", "msg_02", 1_200, { type: "tool", tool: "bash", status: "completed", command: "pnpm test", exit: 1 }), time_updated: T0 + 4_000 },
    part("prt_04", "msg_02", 4_500, { type: "step-finish", tokens: 1234 }),
    part("prt_05", "msg_02", 4_600, { type: "text", text_len: 40 }),
  ]);
  assert.deepEqual(kinds(evs), ["tool_end", "test_fail", "thinking", "reply", "waiting"]);
  assert.equal(evs[0].isError, true);
  assert.equal(evs.find((e) => e.tokens)?.tokens, 1234);
});

test("opencode: MCP tools, apply_patch files, questions, aborts, and child sessions as interns", () => {
  const st = P.createOpencodeState(sess());
  const a = msg("msg_10", "assistant", 0, { model: "m", finish: "tool-calls", completed: T0 + 900 });
  const evs = P.applyOpencode(st, [a], [
    part("prt_10", "msg_10", 100, { type: "tool", tool: "context7_query-docs", status: "completed" }),
    part("prt_11", "msg_10", 200, { type: "tool", tool: "apply_patch", status: "completed", files: "src/a.ts\nsrc/b.ts" }),
    part("prt_12", "msg_10", 300, { type: "tool", tool: "question", status: "running" }),
    part("prt_13", "msg_10", 400, { type: "tool", tool: "read", status: "error", file: "/tmp/demo-app/missing.ts" }),
  ]);
  const starts = of(evs, "tool_start");
  assert.deepEqual(starts.map((e) => [e.category, e.summary]), [
    ["mcp", "context7 · query-docs"], ["edit", "Edit a.ts, b.ts"], ["other", "Question for you"], ["read", "Read missing.ts"],
  ]);
  assert.ok(of(evs, "waiting").some((e) => e.summary === "Needs you"));
  assert.equal(of(evs, "tool_end").find((e) => e.tool === "read").isError, true);
  // finish "tool-calls" is mid-turn: no reply, no waiting for the human.
  assert.equal(of(evs, "reply").length, 0);
  const aborted = P.applyOpencode(st, [msg("msg_11", "assistant", 2_000, { err: "MessageAbortedError", completed: T0 + 2_100 })], []);
  assert.deepEqual(kinds(aborted), ["error"]);
  assert.equal(aborted[0].summary, "Interrupted");

  const kid = P.createOpencodeState(sess({ id: "ses_kid", parent_id: "ses_main", agent: "explore" }));
  const k = P.applyOpencode(kid, [{ ...msg("msg_20", "assistant", 0, { finish: "stop", completed: T0 + 500 }), session_id: "ses_kid" }], [
    part("prt_20", "msg_20", 100, { type: "tool", tool: "grep", status: "completed", include: "*.ts" }),
  ]);
  assert.deepEqual(kinds(k), ["subagent_start", "tool_start", "tool_end", "reply", "subagent_end"]);
  assert.ok(k.every((e) => e.parentId === "ses_main" && e.role === "explore"));
  assert.equal(k[1].summary, "Search *.ts");
});

test("opencode SQL only asks for columns that exist and binds every value", () => {
  const old = P.sessionSql(new Set(["id", "time_updated"]), "updated");
  assert.match(old, /null as agent/);
  assert.doesNotMatch(old, /time_archived/);
  const cur = P.sessionSql(new Set(["id", "time_updated", "agent", "time_archived"]), "updated");
  assert.match(cur, /time_archived is null/);
  assert.equal((P.messagesSql(3).match(/\?/g) ?? []).length, 4);
  assert.equal((P.partsSql(5).match(/\?/g) ?? []).length, 6);
  // The parts query never selects whole text, prompts or file contents.
  assert.doesNotMatch(P.partsSql(1), /'\$\.text'\)\s+as/);
  assert.doesNotMatch(P.partsSql(1), /input\.content|oldString|newString/);
});
