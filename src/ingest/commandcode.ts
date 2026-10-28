/*
 * Command Code transcripts: ~/.commandcode/projects/<cwd-slug>/<id>.jsonl.
 * Two formats live side by side. v3 starts with {"type":"session",cwd} and
 * wraps each turn as {"type":"message",message:{role,content[]},usage,model}.
 * Legacy lines are bare {id,role,content,metadata} with "tool-call" /
 * "tool-result" parts and a separate "tool" role. Assistant messages are
 * written whole, so a message with no tool calls is the end of a turn.
 * Subagents (agent / explore calls) have no transcript of their own; they
 * become synthetic interns that live as long as the call is pending.
 */
import type { RawEvent } from "../shared/events.ts";
import { categorize } from "./categories.ts";
import {
  emit, isObj, isoTs, newCtx, num, parseJson, resultText, setCwd, toolFields,
  type ParserState, type PendingTool, type WorkerCtx,
} from "./common.ts";
import { isTestCommand, outputLooksFailed, shellCategory, testExitHidden, testGuarded, testVerdict, toolSummary } from "./redact.ts";

export interface CommandCodeFile {
  sessionId: string;
  cwd?: string;
  model?: string;
}

export interface CommandCodeState extends ParserState {
  internSeq: number;
}

const SHELL_TOOLS = new Set(["shell_command", "run_command", "shell", "bash", "execute_command", "run_shell_command"]);
const INTERN_TOOLS = new Set(["agent", "explore", "task"]);
const PROMPT_SOURCES = new Set(["user", "followup", "steering", "cli"]);

export function createCommandCodeState(f: CommandCodeFile): CommandCodeState {
  const main = newCtx("commandcode", f.sessionId, {});
  if (f.cwd) setCwd(main, f.cwd);
  if (f.model) main.model = f.model;
  return { main, workers: new Map([[main.workerId, main]]), internSeq: 0 };
}

export function parseCommandCodeLine(state: CommandCodeState, line: string): RawEvent[] {
  const o = parseJson(line);
  if (!o) return [];
  const ctx = state.main;
  if (o.type === "session") {
    setCwd(ctx, o.cwd);
    return [];
  }
  if (o.type === "model_change") {
    if (typeof o.model === "string" && o.model) ctx.model = o.model;
    return [];
  }
  let msg: Record<string, any>;
  let meta: Record<string, any> | undefined;
  let usage: unknown;
  if (o.type === "message" && isObj(o.message)) {
    msg = o.message;
    meta = isObj(msg.meta) ? msg.meta : undefined;
    usage = o.usage;
    if (typeof o.model === "string" && o.model) ctx.model = o.model;
  } else if (o.type === undefined && typeof o.role === "string") {
    msg = o;
    meta = isObj(o.metadata) ? o.metadata : undefined;
    usage = o.usage ?? meta?.usage;
  } else {
    return [];
  }
  const ts = isoTs(o.timestamp ?? meta?.createdAt, ctx.lastTs);
  if (isObj(usage)) ctx.pendingTokens += num(usage.inputTokens) + num(usage.outputTokens);
  const blocks: any[] = Array.isArray(msg.content)
    ? msg.content
    : typeof msg.content === "string"
      ? [{ type: "text", text: msg.content }]
      : [];
  switch (msg.role) {
    case "assistant":
      return assistant(state, ctx, blocks, ts);
    case "user":
      return user(state, ctx, blocks, meta, ts);
    case "tool":
      return blocks.flatMap((b) => (isObj(b) && b.type === "tool-result" ? legacyResult(state, ctx, b, ts) : []));
    default:
      return [];
  }
}

function assistant(state: CommandCodeState, ctx: WorkerCtx, blocks: any[], ts: string): RawEvent[] {
  const calls = blocks.filter((b) => isObj(b) && (b.type === "tool_use" || b.type === "tool-call"));
  const hasText = blocks.some((b) => isObj(b) && b.type === "text" && typeof b.text === "string" && b.text.trim());
  const out: RawEvent[] = [];
  for (const b of blocks) {
    if (!isObj(b)) continue;
    if (b.type === "thinking" || b.type === "reasoning") out.push(...emit(ctx, "thinking", ts, { summary: "Thinking" }));
    else if (b.type === "text" && calls.length && typeof b.text === "string" && b.text.trim()) out.push(...emit(ctx, "thinking", ts, { summary: "Thinking" }));
    else if (b.type === "tool_use") out.push(...toolStart(state, ctx, b.id, b.name, b.input, ts));
    else if (b.type === "tool-call") out.push(...toolStart(state, ctx, b.toolCallId, b.toolName, b.input ?? b.args, ts));
  }
  if (!calls.length && hasText) {
    ctx.pending.clear();
    out.push(...emit(ctx, "reply", ts, { summary: "Replied" }));
    out.push(...emit(ctx, "waiting", ts, { summary: "Waiting" }));
  } else if (!out.length && ctx.pendingTokens > 0) {
    out.push(...emit(ctx, "thinking", ts, { summary: "Thinking" }));
  }
  return out;
}

function toolStart(state: CommandCodeState, ctx: WorkerCtx, rawId: unknown, rawName: unknown, rawInput: unknown, ts: string): RawEvent[] {
  const name = typeof rawName === "string" && rawName ? rawName : "tool";
  const input: Record<string, any> = isObj(rawInput) ? rawInput : {};
  const shell = SHELL_TOOLS.has(name);
  const category = shell ? shellCategory(input.command) : categorize(name);
  const files = Array.isArray(input.include) ? input.include : Array.isArray(input.paths) ? input.paths : undefined;
  const summary = toolSummary(name, category, {
    file: input.file_path ?? input.absolutePath ?? input.filePath ?? (category === "read" || category === "edit" ? input.path : undefined),
    ...(files && category === "read" ? { files } : {}),
    command: shell ? input.command ?? "" : undefined,
    url: input.url,
    glob: name === "glob" ? input.pattern : typeof input.include === "string" ? input.include : input.glob,
    path: input.path ?? input.targetDirectory,
    subagentType: input.subagent_type,
    skill: input.name ?? input.skill,
  });
  const p: PendingTool = { tool: name, category, summary, test: false };
  if (shell && isTestCommand(input.command)) {
    p.test = true;
    p.piped = testExitHidden(input.command);
    p.guarded = testGuarded(input.command);
  }
  const id = typeof rawId === "string" && rawId ? rawId : `${ts}#${ctx.pending.size}`;
  ctx.pending.set(id, p);
  const out = emit(ctx, "tool_start", ts, toolFields(p));
  if (INTERN_TOOLS.has(name)) {
    const internId = `${ctx.workerId}~${id.replace(/[^A-Za-z0-9_-]/g, "").slice(-10) || ++state.internSeq}`;
    const intern = newCtx("commandcode", internId, {
      parentId: ctx.workerId,
      role: name === "explore" ? "explore" : typeof input.subagent_type === "string" && input.subagent_type ? input.subagent_type : "agent",
      project: ctx.project,
      synthetic: true,
      ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
      ...(ctx.model ? { model: ctx.model } : {}),
    });
    state.workers.set(internId, intern);
    p.internId = internId;
    out.push(...emit(intern, "subagent_start", ts));
    out.push(...emit(intern, "thinking", ts, { summary: "Thinking" }));
  }
  return out;
}

function user(state: CommandCodeState, ctx: WorkerCtx, blocks: any[], meta: Record<string, any> | undefined, ts: string): RawEvent[] {
  const out: RawEvent[] = [];
  let prompted = false;
  for (const b of blocks) {
    if (!isObj(b)) continue;
    if (b.type === "tool_result") {
      const text = resultText(b.content);
      out.push(...toolEnd(state, ctx, b.tool_use_id, text, b.is_error === true, ts));
    } else if (b.type === "text" || b.type === "image") {
      const text = typeof b.text === "string" ? b.text.trim() : "";
      if (/^Error:/.test(text)) {
        ctx.pending.clear();
        out.push(...emit(ctx, "error", ts, { summary: "Error", isError: true }));
        continue;
      }
      if (prompted || meta?.isMeta === true || meta?.isAutomated === true) continue;
      if (typeof meta?.source === "string" && !PROMPT_SOURCES.has(meta.source)) continue;
      if (!text && b.type !== "image") continue;
      prompted = true;
      ctx.pending.clear();
      out.push(...emit(ctx, "prompt", ts, { summary: "New prompt" }));
    }
  }
  return out;
}

function legacyResult(state: CommandCodeState, ctx: WorkerCtx, b: Record<string, any>, ts: string): RawEvent[] {
  const output = b.output;
  const text = isObj(output) && typeof output.value === "string" ? output.value : resultText(output) || (isObj(output) ? JSON.stringify(output.value ?? "") : "");
  const isError = isObj(output) && typeof output.type === "string" && output.type.startsWith("error");
  return toolEnd(state, ctx, b.toolCallId, text, isError, ts);
}

function toolEnd(state: CommandCodeState, ctx: WorkerCtx, rawId: unknown, text: string, flagged: boolean, ts: string): RawEvent[] {
  const id = typeof rawId === "string" ? rawId : "";
  const p = ctx.pending.get(id);
  ctx.pending.delete(id);
  const exit = text.match(/^Exit code:?\s*(-?\d+)/im);
  const isError = flagged || /^(Error|ERROR)\b/.test(text) || (!!exit && exit[1] !== "0");
  const out = emit(ctx, "tool_end", ts, { ...toolFields(p), ...(isError ? { isError: true } : {}) });
  if (p?.test) {
    const failed = isError || (!!p.piped && outputLooksFailed(text));
    const verdict = testVerdict(p, failed, text);
    if (verdict) out.push(...emit(ctx, verdict, ts, { ...toolFields(p), ...(verdict === "test_fail" ? { isError: true } : {}) }));
  }
  if (p?.internId) {
    const intern = state.workers.get(p.internId);
    if (intern) {
      out.push(...emit(intern, "subagent_end", ts));
      state.workers.delete(p.internId);
    }
  }
  return out;
}
