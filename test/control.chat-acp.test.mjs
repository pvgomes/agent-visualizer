// Tests for the ACP chat adapter (src/control/chat/acp.ts) against a fake agent that speaks the
// Agent Client Protocol v1 over stdio, the way `command-code acp` does: its initialize answer is
// the one recorded from Command Code 1.84.0, its modes and permission options are Command Code's,
// and like Command Code it refuses a second prompt while one runs.
import nodeTest, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fakeBin, load, NODE_DIR, scratch, sleep, until } from "./control.session-fakes.mjs";
import { CONTROL, skipAll } from "./platform.mjs";

const test = skipAll(nodeTest, CONTROL);

const M = await load("src/control/chat/acp.ts", "src/control/chat/common.ts", "src/control/agents.ts");
const { AcpChat, ACP_PROFILES, acpLabel, localPipe, chatLaunch } = M;
const procs = [];
after(() => {
  for (const p of procs) p.kill("SIGKILL");
  cleanup();
});

const SECRET = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV";

const FAKE_ACP = String.raw`
const fs = require("node:fs");
const log = (o) => process.env.FAKE_LOG && fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(o) + "\n");
const out = (o) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\n");
const S = "sess_1";
const update = (u) => out({ method: "session/update", params: { sessionId: S, update: u } });
const say = (text) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const OPTIONS = [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }, { optionId: "allow_always", name: "Always allow", kind: "allow_always" }, { optionId: "reject_once", name: "Reject", kind: "reject_once" }, { optionId: "reject_always", name: "Always reject", kind: "reject_always" }];
let seq = 100;
let total = 0;
let running = null; // the prompt request id in flight
const waits = new Map(); // our request id -> what to do with the client's answer
const ask = (toolCallId, options, then) => {
  const id = ++seq;
  waits.set(id, then);
  out({ id, method: "session/request_permission", params: { sessionId: S, toolCall: { toolCallId }, options } });
};
const finish = (stopReason, add) => {
  total += add;
  const id = running;
  running = null;
  out({ id, result: { stopReason, usage: { totalTokens: total, inputTokens: total, outputTokens: 0 } } });
};
const tool = (u) => update({ sessionUpdate: "tool_call", status: "pending", ...u });
const done = (toolCallId, status, content) => update({ sessionUpdate: "tool_call_update", toolCallId, status, ...(content ? { content } : {}) });
const text = (t) => [{ type: "content", content: { type: "text", text: t } }];
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  log(m);
  if (m.method === undefined && waits.has(m.id)) {
    const then = waits.get(m.id);
    waits.delete(m.id);
    return then(m.result.outcome);
  }
  if (m.method === "initialize") return out({ id: m.id, result: {"protocolVersion":1,"agentCapabilities":{"loadSession":true,"promptCapabilities":{"audio":false,"image":true,"embeddedContext":true},"mcpCapabilities":{"http":true,"sse":false},"sessionCapabilities":{"list":{},"resume":{},"close":{}}},"authMethods":[{"id":"command-code-cli","name":"Command Code CLI login","description":"Sign in once with ` + "`cmd login`" + String.raw` in a terminal; this session reuses that account."}],"agentInfo":{"name":"Command Code","version":"1.84.0"}} });
  if (m.method === "session/new") {
    if (process.env.FAKE_AUTH === "none") return out({ id: m.id, error: { code: -32000, message: "Authentication required" } });
    return out({ id: m.id, result: { sessionId: S, modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Standard" }, { id: "auto-accept", name: "Accept Edits" }, { id: "plan", name: "Plan" }, { id: "dont-ask", name: "Don't Ask" }, { id: "bypass", name: "Bypass Permissions" }] } } });
  }
  if (m.method === "session/set_mode") return out({ id: m.id, result: {} });
  if (m.method === "session/cancel") {
    if (running !== null) finish("cancelled", 300);
    return;
  }
  if (m.method !== "session/prompt") return;
  if (running !== null) return out({ id: m.id, error: { code: -32600, message: "A prompt is already running for this session" } });
  running = m.id;
  const p = m.params.prompt[0].text;
  if (p === "work") {
    out({ id: ++seq, method: "fs/read_text_file", params: { sessionId: S, path: "/etc/hosts" } });
    update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Let me think about the secret plan" } });
    say("Look");
    say("ing.");
    tool({ toolCallId: "c1", title: "Shell: npm test --token=${SECRET}", kind: "execute", rawInput: { command: "npm test" } });
    return ask("c1", OPTIONS, (o) => {
      if (o.outcome !== "selected" || !o.optionId.startsWith("allow")) {
        done("c1", "failed", text("Permission denied by the user."));
        return finish("end_turn", 10);
      }
      update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "in_progress" });
      done("c1", "completed", text(Array.from({ length: 15 }, (_, i) => "ok " + (i + 1)).join("\n") + "\nFAIL auth_token=${SECRET}\n"));
      tool({ toolCallId: "c2", title: "Edit", kind: "edit", locations: [{ path: "/w/src/a.ts" }], rawInput: { path: "/w/src/a.ts", old_string: "x = 1", new_string: "x = 2" },
        content: [{ type: "diff", path: "/w/src/a.ts", oldText: "keep1\nx = 1\nkeep2\nkeep3\nkeep4\nkeep5\ny = 1\nkeep6", newText: "keep1\nx = 2\nkeep2\nkeep3\nkeep4\nkeep5\ny = 2\nkeep6" }] });
      done("c2", "completed");
      tool({ toolCallId: "c3", title: "Write", kind: "edit", locations: [{ path: "/w/new.md" }], rawInput: { path: "/w/new.md", content: "# hi\n" }, content: [{ type: "diff", path: "/w/new.md", oldText: null, newText: "# hi\n" }] });
      done("c3", "completed");
      tool({ toolCallId: "c4", title: "Read: src/a.ts", kind: "read", locations: [{ path: "/w/src/a.ts" }], rawInput: { path: "/w/src/a.ts" } });
      done("c4", "completed", text("the file's own contents"));
      tool({ toolCallId: "c5", title: "Grep: hunter2", kind: "search", rawInput: { pattern: "hunter2" } });
      done("c5", "completed", text("src/a.ts:1: hunter2"));
      update({ sessionUpdate: "plan", entries: [{ content: "Run tests", priority: "high", status: "completed" }, { content: "Fix   the\nbug", priority: "medium", status: "in_progress" }, { content: "Ship", priority: "low", status: "pending" }] });
      update({ sessionUpdate: "usage_update", used: 53000, size: 200000 });
      say("Done.");
      finish("end_turn", 1000);
    });
  }
  if (p === "askonce" || p === "denyonce") {
    tool({ toolCallId: "c9-" + p, title: "Shell: rm -rf dist", kind: "execute", rawInput: { command: "rm -rf dist" } });
    return ask("c9-" + p, OPTIONS.filter((x) => x.kind.endsWith("_once")), (o) => {
      done("c9-" + p, o.optionId === "allow_once" ? "completed" : "failed", text("(no output)"));
      finish("end_turn", 50);
    });
  }
  if (p === "slowask") {
    tool({ toolCallId: "c7", title: "Shell: git push", kind: "execute", rawInput: { command: "git push" } });
    return ask("c7", OPTIONS, () => {});
  }
  if (p === "slowish") return setTimeout(() => (say("Slowly done."), finish("end_turn", 100)), 200);
  if (p === "limit") return finish("max_tokens", 5);
  say("Hi");
  finish("end_turn", 200);
});
process.stdin.on("end", () => process.exit(0));
`;

function items(conn) {
  const all = new Map();
  const seen = [];
  conn.onItem((it) => {
    all.set(it.id, it);
    seen.push(it);
  });
  return { all, seen, get: (id) => all.get(id), list: () => [...all.values()] };
}

async function spawnAcp(env = {}) {
  const d = scratch();
  const bin = fakeBin(join(d, "bin"), "command-code", FAKE_ACP);
  const logPath = join(d, "log.jsonl");
  const proc = await localPipe(bin, [], d, { PATH: `${NODE_DIR}:/usr/bin:/bin`, FAKE_LOG: logPath, ...env });
  procs.push(proc);
  const log = () => (existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { proc, log };
}

const chat = (proc, o = {}) => new AcpChat({ proc, cwd: "/w", where: "~/w", name: "Command Code", permission: "default", version: "9.9.9", home: "/Users/test-home", ...ACP_PROFILES.commandcode, ...o });
const userItem = (it, text) => it.list().find((x) => x.kind === "user" && x.text === text);

test("ACP: handshake, the hire's mode, streamed text, labelled tools, Always only when offered, diffs, output tails, the plan, the turn's end", async () => {
  const { proc, log } = await spawnAcp();
  const c = chat(proc, { permission: "acceptEdits" });
  const it = items(c);
  const approvals = [];
  c.onApproval((a) => approvals.push(a));
  await c.ready;
  assert.equal(it.list()[0].text, "Command Code is ready in ~/w.");
  assert.equal(c.agentSessionId, "sess_1");
  const sent = log();
  assert.ok(sent.every((l) => l.jsonrpc === "2.0"), "JSON-RPC 2.0, with the field");
  assert.deepEqual(sent.map((l) => l.method), ["initialize", "session/new", "session/set_mode"]);
  assert.deepEqual(sent[0].params, { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "agent-visualizer", title: "agent-visualizer", version: "9.9.9" } });
  assert.deepEqual(sent[1].params, { cwd: "/w", mcpServers: [] });
  assert.deepEqual(sent[2].params, { sessionId: "sess_1", modeId: "auto-accept" });

  await c.send("work");
  const prompt = await until(() => log().find((l) => l.method === "session/prompt"), 3000, "prompt");
  assert.deepEqual(prompt.params, { sessionId: "sess_1", prompt: [{ type: "text", text: "work" }] });
  const ap = await until(() => approvals.find(Boolean), 3000, "approval");
  assert.deepEqual({ tool: ap.tool, category: ap.category, summary: ap.summary, detail: ap.detail, noAlways: ap.noAlways }, { tool: "shell", category: "bash", summary: "$ npm test", detail: "npm test", noAlways: undefined });
  assert.equal(log().find((l) => l.id !== undefined && l.error && l.method === undefined).error.code, -32601, "fs/read_text_file: not offered");
  await c.answer({ id: ap.id, decision: "allow", always: true });
  const T = userItem(it, "work").turnId;
  await until(() => it.get(`end-${T}`), 3000, "turn end");
  assert.deepEqual(log().find((l) => l.id === Number(ap.id)).result, { outcome: { outcome: "selected", optionId: "allow_always" } });
  assert.equal(it.get(`ap-${ap.id}`).text, "Allowed for this session");

  const ready = it.list()[0];
  assert.ok(it.list().filter((x) => x !== ready).every((x) => x.turnId === T), "every item of the turn names it");
  const texts = it.list().filter((x) => x.kind === "assistant");
  assert.deepEqual(texts.map((x) => [x.text, x.streaming]), [["Looking.", false], ["Done.", false]], "a tool call ends the text before it; reasoning isn't shown");
  assert.ok(it.seen.some((x) => x.kind === "assistant" && x.streaming === true));
  const sh = it.get("t-c1");
  assert.deepEqual([sh.status, sh.summary, typeof sh.durationMs], ["ok", "$ npm test", "number"]);
  assert.deepEqual([sh.detail.split("\n").length, sh.detail.split("\n").at(-1)], [12, "FAIL auth_token=•••"]);
  assert.deepEqual(it.get("t-c2").diff, { file: "src/a.ts", added: 2, removed: 2, lines: ["-x = 1", "+x = 2", "@@", "-y = 1", "+y = 2"] }, "only changed lines: an ACP diff may be whole files");
  assert.equal(it.get("t-c3").diff, undefined, "Command Code sends no oldText for overwrites too");
  assert.deepEqual([it.get("t-c4").summary, it.get("t-c4").detail], ["Read a.ts", undefined]);
  assert.deepEqual([it.get("t-c5").summary, it.get("t-c5").detail], ["Search", undefined], "no regex in the label, no file lines in the detail");
  const plan = it.get(`plan-${T}`);
  assert.deepEqual([plan.summary, plan.category, plan.detail], ["Plan 3 steps", "todo", "✓ Run tests\n→ Fix the bug\n· Ship"]);
  const end = it.get(`end-${T}`);
  assert.deepEqual([end.kind, end.text, end.turnEnd, typeof end.durationMs, end.tokens], ["system", undefined, true, "number", 1000]);
  const all = JSON.stringify(it.seen);
  assert.ok(!all.includes(SECRET) && !all.includes("secret plan") && !all.includes("hunter2") && !all.includes("own contents"));
  await c.stop();
});

test("ACP: one prompt at a time, queued prompts, Interrupt cancels the open ask and drops what is held, token deltas", async () => {
  const { proc, log } = await spawnAcp();
  const c = chat(proc);
  const it = items(c);
  const approvals = [];
  c.onApproval((a) => approvals.push(a));
  await c.ready;
  assert.deepEqual(log().map((l) => l.method), ["initialize", "session/new"], "already in the mode asked for: no set_mode");
  const prompts = () => log().filter((l) => l.method === "session/prompt").map((l) => l.params.prompt[0].text);

  // No Always offered: Allow / Deny only, and an Always answer is a plain allow.
  await c.send("askonce");
  const once = await until(() => approvals.find((a) => a?.summary === "$ rm"), 3000, "approval");
  assert.equal(once.noAlways, true);
  await c.answer({ id: once.id, decision: "allow", always: true });
  await until(() => it.get(`end-${userItem(it, "askonce").turnId}`), 3000, "askonce");
  assert.deepEqual(log().find((l) => l.id === Number(once.id)).result.outcome, { outcome: "selected", optionId: "allow_once" });
  assert.equal(it.get(`ap-${once.id}`).text, "Allowed");
  assert.equal(it.get(`end-${userItem(it, "askonce").turnId}`).tokens, 50);
  await c.send("denyonce");
  const deny = await until(() => approvals.filter((a) => a?.summary === "$ rm")[1], 3000, "approval 2");
  await c.answer({ id: deny.id, decision: "deny" });
  await until(() => it.get(`end-${userItem(it, "denyonce").turnId}`), 3000, "denyonce");
  assert.deepEqual(log().find((l) => l.id === Number(deny.id)).result.outcome, { outcome: "selected", optionId: "reject_once" });
  assert.equal(it.get("t-c9-denyonce").status, "error");

  // Held while a prompt runs, sent when it returns.
  await c.send("slowish");
  await c.send("next");
  assert.equal(it.seen.find((x) => x.kind === "user" && x.text === "next").queued, true);
  await until(() => prompts().length === 3, 3000, "slowish sent");
  await sleep(50);
  assert.deepEqual(prompts(), ["askonce", "denyonce", "slowish"]);
  const Tn = userItem(it, "next").turnId;
  await until(() => it.get(`end-${Tn}`), 3000, "queued prompt");
  assert.equal(userItem(it, "next").queued, undefined);
  assert.deepEqual(prompts(), ["askonce", "denyonce", "slowish", "next"]);
  assert.equal(it.get(`end-${userItem(it, "slowish").turnId}`).tokens, 100, "the session total grew by 100");
  assert.equal(it.get(`end-${Tn}`).tokens, 200);
  assert.ok(!it.list().some((x) => x.kind === "error"), "never two prompts at once");

  // Interrupt: the open ask is answered "cancelled", session/cancel goes out, held prompts are dropped.
  await c.send("slowask");
  const push = await until(() => approvals.find((a) => a?.summary === "$ git push"), 3000, "approval 3");
  await c.send("q1");
  assert.equal(userItem(it, "q1").queued, true);
  await c.interrupt();
  const Ts = userItem(it, "slowask").turnId;
  await until(() => it.get(`end-${Ts}`), 3000, "interrupted");
  assert.deepEqual(log().find((l) => l.id === Number(push.id)).result, { outcome: { outcome: "cancelled" } });
  assert.deepEqual(log().find((l) => l.method === "session/cancel").params, { sessionId: "sess_1" });
  assert.deepEqual([it.get(`end-${Ts}`).text, it.get(`end-${Ts}`).turnEnd, it.get(`end-${Ts}`).tokens], ["Interrupted.", true, 300]);
  assert.equal(it.get(`ap-${push.id}`).text, "Interrupted");
  assert.equal(it.get("t-c7").status, "error", "a tool that never ran stops spinning");
  const q1 = userItem(it, "q1");
  assert.deepEqual([q1.queued, it.get(`end-${q1.turnId}`).text], [undefined, "Not sent: the turn before it was interrupted."]);
  assert.ok(!prompts().includes("q1"));

  await c.send("limit");
  await until(() => it.get(`end-${userItem(it, "limit").turnId}`), 3000, "limit");
  assert.deepEqual([it.get(`end-${userItem(it, "limit").turnId}`).kind, it.get(`end-${userItem(it, "limit").turnId}`).text], ["error", "Stopped: it hit the token limit."]);
  const exit = new Promise((r) => c.onExit(r));
  await c.stop();
  assert.equal((await exit).code, 0);
});

test("ACP: not signed in says how, from the agent; a mode it doesn't offer starts nothing; the spec's defaults", async () => {
  const a = await spawnAcp({ FAKE_AUTH: "none" });
  const c1 = chat(a.proc);
  await assert.rejects(c1.ready, /^Error: Command Code isn't signed in\. Sign in once with `cmd login` in a terminal; this session reuses that account\.$/);
  await c1.stop();

  const b = await spawnAcp();
  const c2 = chat(b.proc, { permission: "plan", modes: { plan: "read-only" } });
  await assert.rejects(c2.ready, /didn't offer its "read-only" mode/);
  await c2.stop();

  // No profile: PromptResponse.usage isn't read; a diff with no oldText is a new file (the spec).
  const d = await spawnAcp();
  const c3 = new AcpChat({ proc: d.proc, cwd: "/w", where: "~/w", name: "Some Agent", permission: "default", version: "1" });
  const it = items(c3);
  c3.onApproval((x) => x && void c3.answer({ id: x.id, decision: "allow" }));
  await c3.ready;
  await c3.send("work");
  const T = await until(() => userItem(it, "work")?.turnId, 3000, "prompt");
  await until(() => it.get(`end-${T}`), 3000, "turn");
  assert.equal(it.get(`end-${T}`).tokens, undefined);
  assert.deepEqual(it.get("t-c3").diff, { file: "new.md", added: 1, removed: 0, lines: ["@@ -0,0 +1,1 @@", "+# hi"] });
  await c3.stop();
});

test("Command Code's ACP launch and profile; ACP tool kinds as office labels", () => {
  const launch = chatLaunch({ agent: "commandcode", bin: "command-code", cwd: "/w", permission: "bypass", keys: { COMMAND_CODE_API_KEY: "k" } });
  assert.deepEqual(launch.argv, ["command-code", "acp"]);
  assert.deepEqual(launch.secret, ["COMMAND_CODE_API_KEY"]);
  assert.deepEqual(ACP_PROFILES.commandcode.modes, { default: "default", acceptEdits: "auto-accept", plan: "plan", bypass: "bypass" });
  assert.deepEqual(acpLabel("execute", { command: "cd /x && FOO=1 npm run test:unit -- --grep secret" }), { tool: "shell", category: "bash", summary: "$ npm run test:unit" });
  assert.deepEqual(acpLabel("execute", { command: "rg -n TODO src" }).category, "search");
  assert.deepEqual(acpLabel("edit", { path: "/Users/me/app/src/cli.ts" }), { tool: "edit", category: "edit", summary: "Edit cli.ts" });
  assert.deepEqual(acpLabel("delete", {}, [{ path: "/w/old.ts" }]).summary, "Delete old.ts");
  assert.deepEqual(acpLabel("fetch", { url: "https://docs.python.org/3/x?token=abc" }), { tool: "fetch", category: "web", summary: "Fetch docs.python.org" });
  assert.deepEqual(acpLabel("search", { pattern: "password=hunter2", glob: "src/**/*.ts" }).summary, "Search *.ts");
  assert.deepEqual(acpLabel("mystery", { anything: 1 }), { tool: "tool", category: "other", summary: "Tool" });
});
