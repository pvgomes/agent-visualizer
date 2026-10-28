/*
 * Qwen Code transcripts: ~/.qwen/projects/<cwd-slug>/chats/<sessionId>.jsonl.
 * Every line carries cwd, sessionId and timestamp. type "user" is a prompt,
 * "assistant" a model turn with Gemini-style parts ({text, thought} is
 * reasoning, {functionCall:{id,name,args}} a tool call) plus usageMetadata,
 * "tool_result" answers a call ({functionResponse}, toolCallResult.status),
 * and "system" lines are telemetry and slash commands, never shown (their
 * ui_telemetry payload even repeats the response text). Shell results end
 * with "Exit Code: N". The task tool's subagents run in-process and write no
 * transcript, so they become synthetic interns.
 */
import type { RawEvent } from "../shared/events.ts";
import { categorize } from "./categories.ts";
import {
  emit, endIntern, exitCode, isObj, isoTs, newCtx, num, parseJson, setCwd, spawnIntern, toolFields,
  type InternHost, type PendingTool, type WorkerCtx,
} from "./common.ts";
import { isTestCommand, outputLooksFailed, shellCategory, testExitHidden, testGuarded, testVerdict, toolSummary } from "./redact.ts";

export interface QwenFile {
  sessionId: string;
}

export type QwenState = InternHost;

const SHELL_TOOLS = new Set(["run_shell_command", "shell", "bash"]);
const INTERN_TOOLS = new Set(["task", "agent"]);
const ASKS_HUMAN = new Set(["exit_plan_mode", "ask_user", "ask_user_question"]);

export function createQwenState(f: QwenFile): QwenState {
  const main = newCtx("qwen", f.sessionId, {});
  return { main, workers: new Map([[main.workerId, main]]), internSeq: 0 };
}

export function parseQwenLine(state: QwenState, line: string): RawEvent[] {
  const o = parseJson(line);
  if (!o) return [];
  const ctx = state.main;
  if (typeof o.cwd === "string") setCwd(ctx, o.cwd);
  const ts = isoTs(o.timestamp, ctx.lastTs);
  const parts: any[] = isObj(o.message) && Array.isArray(o.message.parts) ? o.message.parts : [];
  switch (o.type) {
    case "user": {
      const text = parts.map((p) => (isObj(p) && typeof p.text === "string" ? p.text : "")).join("").trim();
      if (!text && !parts.some((p) => isObj(p) && (p.inlineData || p.fileData))) return [];
      if (text.startsWith("<")) return [];
      ctx.pending.clear();
      return emit(ctx, "prompt", ts, { summary: "New prompt" });
    }
    case "assistant":
      return assistant(state, ctx, o, parts, ts);
    case "tool_result":
      return toolResult(state, ctx, o, parts, ts);
    default:
      return [];
  }
}

function assistant(state: QwenState, ctx: WorkerCtx, o: Record<string, any>, parts: any[], ts: string): RawEvent[] {
  if (typeof o.model === "string" && o.model) ctx.model = o.model;
  const u = o.usageMetadata;
  if (isObj(u)) ctx.pendingTokens += num(u.totalTokenCount) || num(u.promptTokenCount) + num(u.candidatesTokenCount);
  const calls = parts.filter((p) => isObj(p) && isObj(p.functionCall));
  const out: RawEvent[] = [];
  let text = false;
  for (const p of parts) {
    if (!isObj(p)) continue;
    if (isObj(p.functionCall)) out.push(...toolStart(state, ctx, p.functionCall, ts));
    else if (typeof p.text === "string" && p.text.trim()) {
      if (p.thought === true || calls.length) out.push(...emit(ctx, "thinking", ts, { summary: "Thinking" }));
      else text = true;
    }
  }
  if (!calls.length && text) {
    ctx.pending.clear();
    out.push(...emit(ctx, "reply", ts, { summary: "Replied" }));
    out.push(...emit(ctx, "waiting", ts, { summary: "Waiting" }));
  } else if (!out.length && ctx.pendingTokens > 0) {
    out.push(...emit(ctx, "thinking", ts, { summary: "Thinking" }));
  }
  return out;
}

function toolStart(state: QwenState, ctx: WorkerCtx, fc: Record<string, any>, ts: string): RawEvent[] {
  const name = typeof fc.name === "string" && fc.name ? fc.name : "tool";
  const args: Record<string, any> = isObj(fc.args) ? fc.args : {};
  const shell = SHELL_TOOLS.has(name);
  const category = shell ? shellCategory(args.command) : categorize(name);
  const files = Array.isArray(args.paths) ? args.paths : undefined;
  const summary = toolSummary(name, category, {
    file: args.absolute_path ?? args.file_path ?? args.path,
    ...(files && category === "read" ? { files } : {}),
    command: shell ? args.command ?? "" : undefined,
    url: args.url,
    glob: name === "glob" ? args.pattern : args.glob ?? args.include,
    path: args.path ?? args.dir_path,
    subagentType: args.subagent_type,
    skill: args.skill ?? args.name,
  });
  const p: PendingTool = { tool: name, category, summary, test: false };
  if (shell && args.is_background !== true && isTestCommand(args.command)) {
    p.test = true;
    p.piped = testExitHidden(args.command);
    p.guarded = testGuarded(args.command);
  }
  const id = typeof fc.id === "string" && fc.id ? fc.id : `${ts}#${ctx.pending.size}`;
  ctx.pending.set(id, p);
  const out = emit(ctx, "tool_start", ts, toolFields(p));
  if (INTERN_TOOLS.has(name)) out.push(...spawnIntern(state, ctx, p, id, typeof args.subagent_type === "string" ? args.subagent_type : "subagent", ts));
  if (ASKS_HUMAN.has(name)) out.push(...emit(ctx, "waiting", ts, { summary: "Needs you" }));
  return out;
}

function toolResult(state: QwenState, ctx: WorkerCtx, o: Record<string, any>, parts: any[], ts: string): RawEvent[] {
  const r = isObj(o.toolCallResult) ? o.toolCallResult : {};
  const out: RawEvent[] = [];
  const responses = parts.filter((p) => isObj(p) && isObj(p.functionResponse)).map((p) => p.functionResponse);
  if (!responses.length && typeof r.callId === "string") responses.push({ id: r.callId, response: {} });
  for (const fr of responses) {
    const id = typeof fr.id === "string" ? fr.id : typeof r.callId === "string" ? r.callId : "";
    const p = ctx.pending.get(id);
    ctx.pending.delete(id);
    const resp = isObj(fr.response) ? fr.response : {};
    const text = typeof resp.output === "string" ? resp.output.slice(-200_000) : typeof r.resultDisplay === "string" ? r.resultDisplay.slice(-200_000) : "";
    const code = p && SHELL_TOOLS.has(p.tool) ? exitCode(text) : undefined;
    const isError = r.status === "error" || resp.error !== undefined || (code !== undefined && code !== 0);
    out.push(...emit(ctx, "tool_end", ts, { ...toolFields(p), ...(isError ? { isError: true } : {}) }));
    if (p?.test && r.status !== "cancelled") {
      const failed = isError || (!!p.piped && outputLooksFailed(text));
      const verdict = testVerdict(p, failed, text);
    if (verdict) out.push(...emit(ctx, verdict, ts, { ...toolFields(p), ...(verdict === "test_fail" ? { isError: true } : {}) }));
    }
    out.push(...endIntern(state, p, ts));
  }
  return out;
}
