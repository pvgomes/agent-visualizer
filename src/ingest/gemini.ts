/*
 * Gemini CLI chats: ~/.gemini/tmp/<project>/chats/session-<time>-<short>.jsonl
 * (subagents: chats/<parentSessionId>/<sessionId>.jsonl). Written from the
 * documented format and the CLI's chatRecordingService source; untested on
 * real data. The first line is metadata {sessionId, projectHash, kind,
 * directories}; then message records {id, timestamp, type: user | gemini |
 * error | info | warning, content, thoughts[], tokens, model, toolCalls[]}.
 * A message is re-appended whole each time it changes (tokens arrive, tool
 * calls are added to it when they complete), so everything is de-duplicated
 * by message and call id. {$set}, {$patch} and {$rewindTo} records adjust
 * the history. Older CLIs rewrote one session-*.json document instead; the
 * loop feeds that whole document to parseGeminiDoc on every change.
 */
import type { RawEvent, ToolCategory } from "../shared/events.ts";
import { categorize } from "./categories.ts";
import {
  emit, exitCode, isObj, isoTs, newCtx, num, parseJson, setCwd, toolFields,
  type ParserState, type PendingTool, type WorkerCtx,
} from "./common.ts";
import { isTestCommand, outputLooksFailed, shellCategory, testExitHidden, testGuarded, testVerdict, toolSummary } from "./redact.ts";

export interface GeminiFile {
  /** From the file name until the metadata line names the real session id. */
  sessionId: string;
  parentId?: string;
  cwd?: string;
  project?: string;
}

interface MsgSeen {
  thoughts: number;
  tokens: boolean;
  replied: boolean;
  calls: Map<string, string>;
}

export interface GeminiState extends ParserState {
  msgs: Map<string, MsgSeen>;
}

const SHELL_TOOLS = new Set(["run_shell_command", "shell"]);
const DONE = new Set(["success", "error", "cancelled", "canceled"]);
const ASKS = new Set(["awaiting_approval"]);

export function createGeminiState(f: GeminiFile): GeminiState {
  const main = newCtx("gemini", f.sessionId, f.parentId ? { parentId: f.parentId, role: "subagent" } : {});
  if (f.cwd) setCwd(main, f.cwd);
  else if (f.project) main.project = f.project;
  return { main, workers: new Map([[main.workerId, main]]), msgs: new Map() };
}

export function parseGeminiLine(state: GeminiState, line: string): RawEvent[] {
  const o = parseJson(line);
  return o ? record(state, o) : [];
}

/** A legacy whole-file session-*.json: replay its messages (already-seen ones are skipped). */
export function parseGeminiDoc(state: GeminiState, text: string): RawEvent[] {
  const o = parseJson(text);
  if (!o) return [];
  meta(state, o);
  const out: RawEvent[] = [];
  if (Array.isArray(o.messages)) for (const m of o.messages) if (isObj(m)) out.push(...message(state, m));
  return out;
}

function record(state: GeminiState, o: Record<string, any>): RawEvent[] {
  if (isObj(o.$set)) {
    meta(state, o.$set);
    return [];
  }
  if (isObj(o.$patch)) return patch(state, o.$patch);
  if (typeof o.$rewindTo === "string") return [];
  if (typeof o.sessionId === "string" && typeof o.projectHash === "string") {
    meta(state, o);
    return [];
  }
  if (typeof o.id === "string" && typeof o.type === "string") return message(state, o);
  return [];
}

function meta(state: GeminiState, o: Record<string, any>): void {
  const ctx = state.main;
  if (Array.isArray(o.directories) && typeof o.directories[0] === "string" && !ctx.cwd) setCwd(ctx, o.directories[0]);
  if (o.kind === "subagent" && !ctx.parentId) ctx.role = "subagent";
}

function seen(state: GeminiState, id: string): MsgSeen {
  let s = state.msgs.get(id);
  if (!s) {
    s = { thoughts: 0, tokens: false, replied: false, calls: new Map() };
    state.msgs.set(id, s);
    if (state.msgs.size > 400) state.msgs.delete(state.msgs.keys().next().value!);
  }
  return s;
}

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : isObj(p) && typeof p.text === "string" ? p.text : "")).join("");
  if (isObj(content) && typeof content.text === "string") return content.text;
  return "";
}

function message(state: GeminiState, m: Record<string, any>): RawEvent[] {
  const ctx = state.main;
  const ts = isoTs(m.timestamp, ctx.lastTs);
  const first = !state.msgs.has(m.id);
  const s = seen(state, m.id);
  switch (m.type) {
    case "user": {
      if (!first) return [];
      const t = text(m.content).trim();
      if (!t || t.startsWith("<")) return [];
      ctx.pending.clear();
      return emit(ctx, "prompt", ts, { summary: "New prompt" });
    }
    case "error":
      if (!first) return [];
      ctx.pending.clear();
      return emit(ctx, "error", ts, { summary: "Error", isError: true });
    case "gemini":
      return gemini(ctx, m, s, ts);
    default:
      return [];
  }
}

function gemini(ctx: WorkerCtx, m: Record<string, any>, s: MsgSeen, ts: string): RawEvent[] {
  if (typeof m.model === "string" && m.model) ctx.model = m.model;
  const out: RawEvent[] = [];
  if (!s.tokens && isObj(m.tokens)) {
    const t = m.tokens;
    const total = num(t.total) || num(t.input) + num(t.output) + num(t.thoughts) + num(t.tool);
    if (total) {
      s.tokens = true;
      ctx.pendingTokens += total;
    }
  }
  const thoughts = Array.isArray(m.thoughts) ? m.thoughts.length : 0;
  if (thoughts > s.thoughts) {
    s.thoughts = thoughts;
    out.push(...emit(ctx, "thinking", ts, { summary: "Thinking" }));
  }
  const calls: any[] = Array.isArray(m.toolCalls) ? m.toolCalls : [];
  for (const tc of calls) if (isObj(tc)) out.push(...toolCall(ctx, tc, s, ts));
  if (!calls.length && !s.replied && text(m.content).trim()) {
    // Tool calls are added to this same message when they finish, so this is not yet the end of the turn.
    s.replied = true;
    out.push(...emit(ctx, "reply", ts, { summary: "Replied" }));
  }
  if (!out.length && ctx.pendingTokens > 0) out.push(...emit(ctx, "thinking", ts, { summary: "Thinking" }));
  return out;
}

function toolCall(ctx: WorkerCtx, tc: Record<string, any>, s: MsgSeen, msgTs: string): RawEvent[] {
  const id = typeof tc.id === "string" && tc.id ? tc.id : `${msgTs}#${s.calls.size}`;
  const status = typeof tc.status === "string" ? tc.status : "";
  const prev = s.calls.get(id);
  if (prev !== undefined && (prev === status || DONE.has(prev))) return [];
  s.calls.set(id, status);
  const ts = isoTs(tc.timestamp, msgTs);
  const out: RawEvent[] = [];
  let p = ctx.pending.get(id);
  if (prev === undefined) {
    p = pending(tc);
    ctx.pending.set(id, p);
    out.push(...emit(ctx, "tool_start", ts, toolFields(p)));
  }
  if (ASKS.has(status)) out.push(...emit(ctx, "waiting", ts, { summary: "Needs you" }));
  if (DONE.has(status)) out.push(...finish(ctx, id, p, status, resultOf(tc), ts));
  return out;
}

function pending(tc: Record<string, any>): PendingTool {
  const name = typeof tc.name === "string" && tc.name ? tc.name : "tool";
  const args: Record<string, any> = isObj(tc.args) ? tc.args : {};
  const shell = SHELL_TOOLS.has(name);
  const category: ToolCategory = shell ? shellCategory(args.command) : categorize(name);
  const files = Array.isArray(args.paths) ? args.paths : Array.isArray(args.file_paths) ? args.file_paths : undefined;
  const summary = toolSummary(name, category, {
    file: args.file_path ?? args.absolute_path ?? args.path,
    ...(files && category === "read" ? { files } : {}),
    command: shell ? args.command ?? "" : undefined,
    url: args.url ?? (typeof args.prompt === "string" ? args.prompt.match(/https?:\/\/\S+/)?.[0] : undefined),
    glob: name === "glob" ? args.pattern : args.include ?? args.glob,
    path: args.dir_path ?? args.path,
    skill: args.name ?? args.skill,
  });
  const p: PendingTool = { tool: name, category, summary, test: false };
  if (shell && args.is_background !== true && isTestCommand(args.command)) {
    p.test = true;
    p.piped = testExitHidden(args.command);
    p.guarded = testGuarded(args.command);
  }
  return p;
}

function resultOf(tc: Record<string, any>): string {
  let s = "";
  const r = tc.result;
  const parts = Array.isArray(r) ? r : r ? [r] : [];
  for (const part of parts) {
    const fr = isObj(part) && isObj(part.functionResponse) ? part.functionResponse : undefined;
    const resp = fr && isObj(fr.response) ? fr.response : undefined;
    if (resp && typeof resp.output === "string") s += resp.output;
    else if (resp && typeof resp.error === "string") s += resp.error;
    else if (isObj(part) && typeof part.text === "string") s += part.text;
  }
  if (!s && typeof tc.resultDisplay === "string") s = tc.resultDisplay;
  return s.slice(-200_000);
}

function finish(ctx: WorkerCtx, id: string, p: PendingTool | undefined, status: string, out: string, ts: string): RawEvent[] {
  ctx.pending.delete(id);
  const code = p && SHELL_TOOLS.has(p.tool) ? exitCode(out) : undefined;
  const isError = status === "error" || (code !== undefined && code !== 0);
  const evs = emit(ctx, "tool_end", ts, { ...toolFields(p), ...(isError ? { isError: true } : {}) });
  if (p?.test && status !== "cancelled" && status !== "canceled") {
    const failed = isError || (!!p.piped && outputLooksFailed(out));
    const verdict = testVerdict(p, failed, out);
    if (verdict) evs.push(...emit(ctx, verdict, ts, { ...toolFields(p), ...(verdict === "test_fail" ? { isError: true } : {}) }));
  }
  return evs;
}

/** {$patch: {toolCalls: [{id, result}]}} fills in results for calls already recorded. */
function patch(state: GeminiState, p: Record<string, any>): RawEvent[] {
  const ctx = state.main;
  const out: RawEvent[] = [];
  const lists: unknown[] = [p.toolCalls, ...(Array.isArray(p.updates) ? p.updates.map((u: any) => (isObj(u) ? u.toolCalls : undefined)) : [])];
  const ts = ctx.lastTs ?? new Date().toISOString();
  for (const l of lists) {
    if (!Array.isArray(l)) continue;
    for (const tc of l) {
      if (!isObj(tc) || typeof tc.id !== "string" || !ctx.pending.has(tc.id)) continue;
      out.push(...finish(ctx, tc.id, ctx.pending.get(tc.id), "success", resultOf(tc), ts));
    }
  }
  return out;
}

/** session-2026-01-15T10-00-1a2b3c4d.jsonl -> "1a2b3c4d" (the session id's first 8 characters). */
export function geminiShortId(name: string): string | undefined {
  return name.match(/-([A-Za-z0-9_-]{8})\.jsonl?$/)?.[1];
}

