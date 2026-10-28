/*
 * Factory Droid transcripts: ~/.factory/sessions/<cwd-slug>/<id>.jsonl, with
 * a sibling <id>.settings.json holding the model and the session's running
 * token total. Lines are {type:"session_start", cwd}, {type:"message",
 * message:{role, content[]}} with Anthropic-style blocks (text, thinking,
 * tool_use, tool_result), and bookkeeping like todo_state. User text that
 * starts with "<" is a system reminder, not a prompt. Task calls spawn custom
 * droids that write no transcript of their own, so they become synthetic
 * interns that live as long as the call.
 */
import type { RawEvent } from "../shared/events.ts";
import { categorize } from "./categories.ts";
import {
  emit, endIntern, exitCode, isObj, isoTs, newCtx, num, parseJson, resultText, setCwd, spawnIntern, toolFields,
  type InternHost, type PendingTool, type WorkerCtx,
} from "./common.ts";
import { isTestCommand, outputLooksFailed, shellCategory, testExitHidden, testGuarded, testVerdict, toolSummary } from "./redact.ts";

export interface DroidFile {
  sessionId: string;
  cwd?: string;
  model?: string;
}

export interface DroidState extends InternHost {
  /** Token total from the settings file last time it was read. */
  settingsTokens: number;
}

const SHELL_TOOLS = new Set(["Execute", "Bash", "Shell", "execute", "run_command"]);
const INTERN_TOOLS = new Set(["Task", "task"]);
const ASKS_HUMAN = new Set(["AskUser", "AskUserQuestion", "ExitSpecMode"]);
const INTERRUPT = /interrupted by user|request (was )?(cancelled|aborted)/i;

export function createDroidState(f: DroidFile): DroidState {
  const main = newCtx("droid", f.sessionId, {});
  if (f.cwd) setCwd(main, f.cwd);
  if (f.model) main.model = f.model;
  return { main, workers: new Map([[main.workerId, main]]), internSeq: 0, settingsTokens: 0 };
}

/** <id>.settings.json changed: pick up the model and the growth of the token total. */
export function applyDroidSettings(state: DroidState, s: Record<string, any> | null): void {
  if (!s) return;
  if (typeof s.model === "string" && s.model) state.main.model = s.model;
  const u = isObj(s.tokenUsage) ? s.tokenUsage : undefined;
  if (!u) return;
  const total = num(u.inputTokens) + num(u.outputTokens) + num(u.cacheCreationTokens) + num(u.cacheReadTokens) + num(u.thinkingTokens);
  if (total > state.settingsTokens) state.main.pendingTokens += total - state.settingsTokens;
  state.settingsTokens = Math.max(state.settingsTokens, total);
}

export function parseDroidLine(state: DroidState, line: string): RawEvent[] {
  const o = parseJson(line);
  if (!o) return [];
  const ctx = state.main;
  if (o.type === "session_start") {
    setCwd(ctx, o.cwd);
    return [];
  }
  if (o.type !== "message" || !isObj(o.message)) return [];
  const m = o.message;
  const ts = isoTs(o.timestamp, ctx.lastTs);
  if (typeof m.model === "string" && m.model) ctx.model = m.model;
  const blocks: any[] = Array.isArray(m.content) ? m.content : typeof m.content === "string" ? [{ type: "text", text: m.content }] : [];
  if (m.role === "assistant") return assistant(state, ctx, blocks, ts);
  if (m.role === "user") return user(state, ctx, blocks, m, ts);
  return [];
}

function assistant(state: DroidState, ctx: WorkerCtx, blocks: any[], ts: string): RawEvent[] {
  const hasTool = blocks.some((b) => isObj(b) && b.type === "tool_use");
  const out: RawEvent[] = [];
  let text = false;
  for (const b of blocks) {
    if (!isObj(b)) continue;
    if (b.type === "thinking" || b.type === "redacted_thinking") out.push(...emit(ctx, "thinking", ts, { summary: "Thinking" }));
    else if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
      text = true;
      if (hasTool) out.push(...emit(ctx, "thinking", ts, { summary: "Thinking" }));
    } else if (b.type === "tool_use") out.push(...toolStart(state, ctx, b, ts));
  }
  if (!hasTool && text) {
    ctx.pending.clear();
    out.push(...emit(ctx, "reply", ts, { summary: "Replied" }));
    out.push(...emit(ctx, "waiting", ts, { summary: "Waiting" }));
  } else if (!out.length && ctx.pendingTokens > 0) {
    out.push(...emit(ctx, "thinking", ts, { summary: "Thinking" }));
  }
  return out;
}

function toolStart(state: DroidState, ctx: WorkerCtx, b: Record<string, any>, ts: string): RawEvent[] {
  const name = typeof b.name === "string" && b.name ? b.name : "tool";
  const input: Record<string, any> = isObj(b.input) ? b.input : {};
  const shell = SHELL_TOOLS.has(name);
  const category = shell ? shellCategory(input.command) : categorize(name);
  const globs = Array.isArray(input.patterns) ? input.patterns : undefined;
  const summary = toolSummary(name, category, {
    file: input.file_path ?? input.filePath,
    command: shell ? input.command ?? "" : undefined,
    url: input.url,
    glob: globs?.[0] ?? input.glob_pattern ?? input.glob,
    path: input.directory_path ?? input.folder ?? input.path,
    subagentType: input.subagent_type,
    skill: input.skill ?? input.name,
  });
  const p: PendingTool = { tool: name, category, summary, test: false };
  if (shell && isTestCommand(input.command)) {
    p.test = true;
    p.piped = testExitHidden(input.command);
    p.guarded = testGuarded(input.command);
  }
  const id = typeof b.id === "string" && b.id ? b.id : `${ts}#${ctx.pending.size}`;
  ctx.pending.set(id, p);
  const out = emit(ctx, "tool_start", ts, toolFields(p));
  if (INTERN_TOOLS.has(name)) out.push(...spawnIntern(state, ctx, p, id, typeof input.subagent_type === "string" ? input.subagent_type : "droid", ts));
  if (ASKS_HUMAN.has(name)) out.push(...emit(ctx, "waiting", ts, { summary: "Needs you" }));
  return out;
}

function user(state: DroidState, ctx: WorkerCtx, blocks: any[], m: Record<string, any>, ts: string): RawEvent[] {
  const out: RawEvent[] = [];
  let prompted = false;
  for (const b of blocks) {
    if (!isObj(b)) continue;
    if (b.type === "tool_result") {
      out.push(...toolEnd(state, ctx, b, ts));
    } else if (b.type === "text" || b.type === "image") {
      const t = typeof b.text === "string" ? b.text.trim() : "";
      if (INTERRUPT.test(t) && t.length < 120) {
        ctx.pending.clear();
        out.push(...emit(ctx, "error", ts, { summary: "Interrupted", isError: true }));
        continue;
      }
      // System reminders and UI-only notes are not the human talking.
      if (prompted || t.startsWith("<") || m.visibility === "user_only" || m.isMeta === true) continue;
      if (!t && b.type !== "image") continue;
      prompted = true;
      ctx.pending.clear();
      out.push(...emit(ctx, "prompt", ts, { summary: "New prompt" }));
    }
  }
  return out;
}

function toolEnd(state: DroidState, ctx: WorkerCtx, b: Record<string, any>, ts: string): RawEvent[] {
  const id = typeof b.tool_use_id === "string" ? b.tool_use_id : "";
  const p = ctx.pending.get(id);
  ctx.pending.delete(id);
  const text = resultText(b.content);
  const code = p?.test || SHELL_TOOLS.has(p?.tool ?? "") ? exitCode(text) : undefined;
  const isError = b.is_error === true || (code !== undefined && code !== 0);
  const out = emit(ctx, "tool_end", ts, { ...toolFields(p), ...(isError ? { isError: true } : {}) });
  if (p?.test) {
    const failed = isError || (!!p.piped && outputLooksFailed(text));
    const verdict = testVerdict(p, failed, text);
    if (verdict) out.push(...emit(ctx, verdict, ts, { ...toolFields(p), ...(verdict === "test_fail" ? { isError: true } : {}) }));
  }
  out.push(...endIntern(state, p, ts));
  return out;
}
