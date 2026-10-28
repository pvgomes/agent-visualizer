/*
 * Claude Code transcripts: ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl,
 * subagents under <sessionId>/subagents/agent-<id>.jsonl (and
 * subagents/workflows/<run>/agent-<id>.jsonl). Each content block of an API
 * response is its own "assistant" line sharing message.id and usage, so tokens
 * are counted once per message id. Older versions wrote subagent lines into
 * the parent file with isSidechain:true; those become an intern too.
 */
import type { RawEvent } from "../shared/events.ts";
import { categorize } from "./categories.ts";
import {
  basename, emit, isObj, isoTs, newCtx, num, parseJson, resultText, setCwd, toolFields,
  type ParserState, type PendingTool, type WorkerCtx,
} from "./common.ts";
import { cwdFromSlug } from "./discover.ts";
import { isTestCommand, outputLooksFailed, shellCategory, testExitHidden, testGuarded, testVerdict, toolSummary } from "./redact.ts";

export interface ClaudeFile {
  sessionId: string;
  /** Set for subagent transcripts (agent-<agentId>.jsonl). */
  agentId?: string;
  /** Subagent role from the sibling .meta.json (agentType). */
  role?: string;
  /** The project folder name (-Users-me-app): the cwd the session was started in, slugged. */
  slug?: string;
}

export interface ClaudeState extends ParserState {
  sessionId: string;
  subagent: boolean;
  /** message.id -> tokens already counted for it. */
  msgTokens: Map<string, number>;
  /** subagent_type of the last Task/Agent call, for legacy sidechain interns. */
  lastSpawnRole?: string;
  slug?: string;
}

const SHELL_TOOLS = new Set(["Bash", "bash", "Shell", "PowerShell"]);
const ASKS_HUMAN = new Set(["AskUserQuestion", "ExitPlanMode"]);
const FINAL_STOPS = new Set(["end_turn", "stop_sequence", "max_tokens", "refusal"]);

export function claudeWorkerId(f: ClaudeFile): string {
  return f.agentId ? `agent-${f.agentId}` : f.sessionId;
}

export function createClaudeState(f: ClaudeFile): ClaudeState {
  const main = newCtx("claude", claudeWorkerId(f), f.agentId ? { parentId: f.sessionId, role: f.role || "subagent" } : {});
  return {
    main,
    workers: new Map([[main.workerId, main]]),
    sessionId: f.sessionId,
    subagent: !!f.agentId,
    msgTokens: new Map(),
    ...(f.slug ? { slug: f.slug } : {}),
  };
}

export function parseClaudeLine(state: ClaudeState, line: string): RawEvent[] {
  const o = parseJson(line);
  if (!o) return [];
  let ctx = state.main;
  if (o.isSidechain === true && !state.subagent) ctx = sidechain(state, o);
  if (typeof o.cwd === "string" && o.cwd) {
    // Every line carries the shell's current folder, which follows the agent's `cd`. The worker
    // keeps the folder the session was started in (the slug says which one), so its project and
    // the MCP signals its office tools send (from that folder) stay put.
    const root = state.slug ? cwdFromSlug(state.slug, o.cwd) : undefined;
    if (root) {
      if (ctx.cwd !== root) setCwd(ctx, root);
    } else if (!ctx.cwd) setCwd(ctx, o.cwd);
    if (ctx !== state.main && !state.main.cwd) setCwd(state.main, ctx.cwd);
  }
  const ts = isoTs(o.timestamp, ctx.lastTs);
  switch (o.type) {
    case "assistant":
      return assistant(state, ctx, o, ts);
    case "user":
      return user(ctx, o, ts);
    case "system":
      return system(ctx, o, ts);
    default:
      return [];
  }
}

function sidechain(state: ClaudeState, o: Record<string, any>): WorkerCtx {
  const id = `agent-${typeof o.agentId === "string" && o.agentId ? o.agentId : state.sessionId.slice(0, 8) + "-side"}`;
  let c = state.workers.get(id);
  if (!c) {
    c = newCtx("claude", id, {
      parentId: state.main.workerId,
      role: state.lastSpawnRole || "subagent",
      project: state.main.project,
      ...(state.main.cwd ? { cwd: state.main.cwd } : {}),
    });
    state.workers.set(id, c);
  }
  return c;
}

function assistant(state: ClaudeState, ctx: WorkerCtx, o: Record<string, any>, ts: string): RawEvent[] {
  const m = o.message;
  if (!isObj(m)) return [];
  if (o.isApiErrorMessage === true) {
    ctx.pending.clear();
    return emit(ctx, "error", ts, { summary: "API error", isError: true });
  }
  // "<synthetic>" lines are Claude Code talking to itself (e.g. after an interrupt).
  if (m.model === "<synthetic>") return [];
  if (typeof m.model === "string" && m.model) ctx.model = m.model;
  countTokens(state, ctx, m);

  const blocks: any[] = Array.isArray(m.content) ? m.content : typeof m.content === "string" ? [{ type: "text", text: m.content }] : [];
  const hasTool = blocks.some((b) => isObj(b) && (b.type === "tool_use" || b.type === "server_tool_use"));
  const final = FINAL_STOPS.has(m.stop_reason) && !hasTool;
  const out: RawEvent[] = [];
  for (const b of blocks) {
    if (!isObj(b)) continue;
    if (b.type === "thinking" || b.type === "redacted_thinking") {
      out.push(...emit(ctx, "thinking", ts, { summary: "Thinking" }));
    } else if (b.type === "text") {
      if (typeof b.text !== "string" || !b.text.trim()) continue;
      if (final) out.push(...finishTurn(ctx, ts));
      else out.push(...emit(ctx, "thinking", ts, { summary: "Thinking" }));
    } else if (b.type === "tool_use" || b.type === "server_tool_use") {
      out.push(...toolStart(state, ctx, b, ts));
    }
  }
  // Tokens on a line that produced nothing (an empty text block) still need a ride.
  if (!out.length && ctx.pendingTokens > 0 && ctx.lastKind !== "thinking") {
    out.push(...emit(ctx, "thinking", ts, { summary: "Thinking" }));
  }
  return out;
}

/** The model stopped talking: a session waits on its human, an intern hands back and leaves. */
function finishTurn(ctx: WorkerCtx, ts: string): RawEvent[] {
  ctx.pending.clear();
  const out = emit(ctx, "reply", ts, { summary: "Replied" });
  out.push(...(ctx.parentId ? emit(ctx, "subagent_end", ts) : emit(ctx, "waiting", ts, { summary: "Waiting" })));
  return out;
}

function countTokens(state: ClaudeState, ctx: WorkerCtx, m: Record<string, any>): void {
  const u = m.usage;
  if (!isObj(u)) return;
  const total =
    num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens) + num(u.output_tokens);
  if (!total) return;
  const id = typeof m.id === "string" ? m.id : "";
  if (!id) {
    ctx.pendingTokens += total;
    return;
  }
  const prev = state.msgTokens.get(id) ?? 0;
  if (total <= prev) return;
  ctx.pendingTokens += total - prev;
  state.msgTokens.set(id, total);
  if (state.msgTokens.size > 64) state.msgTokens.delete(state.msgTokens.keys().next().value!);
}

function toolStart(state: ClaudeState, ctx: WorkerCtx, b: Record<string, any>, ts: string): RawEvent[] {
  const name = typeof b.name === "string" && b.name ? b.name : "tool";
  const input: Record<string, any> = isObj(b.input) ? b.input : {};
  const shell = SHELL_TOOLS.has(name);
  const category = shell ? shellCategory(input.command) : categorize(name);
  const summary = toolSummary(name, category, {
    file: input.file_path ?? input.notebook_path,
    command: shell ? input.command ?? "" : undefined,
    url: input.url,
    glob: name === "Glob" ? input.pattern : input.glob ?? (typeof input.type === "string" ? `*.${input.type}` : undefined),
    path: input.path,
    subagentType: input.subagent_type,
    skill: input.skill ?? input.command,
  });
  const p: PendingTool = { tool: name, category, summary, test: false };
  if (shell && input.run_in_background !== true && isTestCommand(input.command)) {
    p.test = true;
    p.piped = testExitHidden(input.command);
    p.guarded = testGuarded(input.command);
  }
  if (name === "Task" || name === "Agent") state.lastSpawnRole = typeof input.subagent_type === "string" ? input.subagent_type : undefined;
  const id = typeof b.id === "string" && b.id ? b.id : `${ts}#${ctx.pending.size}`;
  ctx.pending.set(id, p);
  const out = emit(ctx, "tool_start", ts, toolFields(p));
  if (ASKS_HUMAN.has(name)) out.push(...emit(ctx, "waiting", ts, { summary: "Needs you" }));
  return out;
}

const INTERRUPT = /^\[Request interrupted by user/;
const NOT_A_PROMPT = /^<(local-command|command-|task-notification|system-reminder|bash-|user-memory|ide_|user-prompt-submit-hook)/;
const DENIED = /^(The user doesn't want|User rejected|Permission to use|<tool_use_error>|Hook |Interrupted)/i;

function user(ctx: WorkerCtx, o: Record<string, any>, ts: string): RawEvent[] {
  const m = o.message;
  const content = isObj(m) ? m.content : undefined;
  const out: RawEvent[] = [];
  if (Array.isArray(content) && content.some((x) => isObj(x) && x.type === "tool_result")) {
    for (const x of content) {
      if (!isObj(x)) continue;
      if (x.type === "tool_result") out.push(...toolEnd(ctx, x, o.toolUseResult, ts));
      else if (x.type === "text" && typeof x.text === "string" && INTERRUPT.test(x.text.trim())) out.push(...interrupted(ctx, ts));
    }
    return out;
  }
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.filter((x) => isObj(x) && x.type === "text" && typeof x.text === "string").map((x) => x.text).join("\n")
        : "";
  const t = text.trimStart();
  if (INTERRUPT.test(t)) return interrupted(ctx, ts);
  if (o.isMeta === true || o.isCompactSummary === true || o.isVisibleInTranscriptOnly === true) return [];
  if (isObj(o.origin) && typeof o.origin.kind === "string" && o.origin.kind !== "human") return [];
  if (o.promptSource === "system") return [];
  const hasImage = Array.isArray(content) && content.some((x) => isObj(x) && x.type === "image");
  if (!t && !hasImage) return [];
  if (NOT_A_PROMPT.test(t) || t.startsWith("Caveat:")) return [];
  ctx.pending.clear();
  return emit(ctx, "prompt", ts, { summary: "New prompt" });
}

function interrupted(ctx: WorkerCtx, ts: string): RawEvent[] {
  ctx.pending.clear();
  return emit(ctx, "error", ts, { summary: "Interrupted", isError: true });
}

function toolEnd(ctx: WorkerCtx, x: Record<string, any>, tur: unknown, ts: string): RawEvent[] {
  const id = typeof x.tool_use_id === "string" ? x.tool_use_id : "";
  const p = ctx.pending.get(id);
  ctx.pending.delete(id);
  const isError = x.is_error === true;
  const out = emit(ctx, "tool_end", ts, { ...toolFields(p), ...(isError ? { isError: true } : {}) });
  if (!p?.test) return out;
  const text = resultText(x.content);
  const r = isObj(tur) ? tur : {};
  if (r.backgroundTaskId || r.interrupted === true || (isError && DENIED.test(text.trim()))) return out;
  const exit = text.match(/^Exit code (-?\d+)/m);
  const failed = isError || (!!exit && exit[1] !== "0") || (!!p.piped && outputLooksFailed(text));
  const verdict = testVerdict(p, failed, text);
  if (verdict) out.push(...emit(ctx, verdict, ts, { ...toolFields(p), ...(verdict === "test_fail" ? { isError: true } : {}) }));
  return out;
}

function system(ctx: WorkerCtx, o: Record<string, any>, ts: string): RawEvent[] {
  const sub = typeof o.subtype === "string" ? o.subtype : "";
  if (sub === "turn_duration" || sub === "stop_hook_summary") {
    // Backstop for turns whose last text line never carried a stop_reason.
    if (!ctx.parentId && ctx.announced && ctx.pending.size === 0 && (ctx.lastKind === "thinking" || ctx.lastKind === "tool_end" || ctx.lastKind === "reply")) {
      return emit(ctx, "waiting", ts, { summary: "Waiting" });
    }
    return [];
  }
  if (sub === "api_error" || (o.level === "error" && /error/i.test(sub))) {
    return emit(ctx, "error", ts, { summary: "API error", isError: true });
  }
  return [];
}

/** <slug>/<sessionId>/subagents/[workflows/<run>/]agent-<id>.jsonl -> its ids. */
export function claudeFileInfo(path: string): ClaudeFile & { parentPath?: string } {
  const parts = path.split(/[\\/]+/);
  const file = basename(path).replace(/\.jsonl$/, "");
  const si = parts.lastIndexOf("subagents");
  if (file.startsWith("agent-") && si > 0) {
    const sessionId = parts[si - 1]!;
    const parentPath = [...parts.slice(0, si - 1), `${sessionId}.jsonl`].join("/");
    const slug = parts[si - 2];
    return { sessionId, agentId: file.slice("agent-".length), parentPath, ...(slug ? { slug } : {}) };
  }
  const slug = parts[parts.length - 2];
  return { sessionId: file, ...(slug ? { slug } : {}) };
}
