/*
 * Shared plumbing for the per-agent parsers. A parser keeps one WorkerCtx per
 * worker it has seen in a file (the session, plus any interns it spawns) and
 * builds RawEvents through emit(), which announces a worker the first time it
 * does anything, carries buffered token counts, and drops repeated "thinking"
 * so a long reasoning stream is one pose, not hundreds of events. Agents whose
 * subagents leave no transcript (Command Code, Droid, Qwen) spawn synthetic
 * interns that live exactly as long as the spawning tool call.
 */
import type { AgentKind, EventKind, RawEvent, ToolCategory } from "../shared/events.ts";

export interface PendingTool {
  tool: string;
  category: ToolCategory;
  summary?: string;
  /** The call is a test run: its result also produces test_pass / test_fail. */
  test: boolean;
  /** The command pipes its output (`npm test | tail`), so the exit code lies; read the output. */
  piped?: boolean;
  /** Another command runs before the test in its && chain: a failure only counts if the output shows failing tests. */
  guarded?: boolean;
  /** For synthetic interns (Command Code agent/explore calls): the intern's workerId. */
  internId?: string;
}

export interface WorkerCtx {
  agent: AgentKind;
  workerId: string;
  parentId?: string;
  project: string;
  cwd?: string;
  model?: string;
  role?: string;
  /** A session_start / subagent_start has gone out and no end since. */
  announced: boolean;
  lastKind?: EventKind;
  lastTs?: string;
  /** Tokens seen on lines that produced no event yet; rides on the next event. */
  pendingTokens: number;
  /** Tool calls issued and not yet answered, by call id. */
  pending: Map<string, PendingTool>;
  /** Wall-clock ms of the last activity, maintained by the ingest loop. */
  lastActivityMs: number;
  /** An intern with no transcript of its own; it ends with its parent's tool call, never by going quiet. */
  synthetic?: boolean;
  /** Transcript ts of the last keepalive re-sighting sent for this worker. */
  keepTs?: string;
  /** The last agent-visualizer MCP tool this worker called (office_status, ...) and the wall ms the loop saw it. */
  officeCall?: { tool: string; at: number };
}

export interface ParserState {
  main: WorkerCtx;
  /** Every worker this file speaks for, main included. */
  workers: Map<string, WorkerCtx>;
}

export function newCtx(agent: AgentKind, workerId: string, init: Partial<WorkerCtx> = {}): WorkerCtx {
  const ctx: WorkerCtx = {
    pendingTokens: 0,
    pending: new Map(),
    announced: false,
    lastActivityMs: 0,
    ...init,
    agent,
    workerId,
    project: "",
  };
  ctx.project = init.project || (init.cwd ? basename(init.cwd) : "");
  return ctx;
}

export function setCwd(ctx: WorkerCtx, cwd: unknown): void {
  if (typeof cwd !== "string" || !cwd) return;
  ctx.cwd = cwd;
  ctx.project = basename(cwd) || cwd;
}

function base(ctx: WorkerCtx, kind: EventKind, ts: string): RawEvent {
  const e: RawEvent = { ts, agent: ctx.agent, workerId: ctx.workerId, project: ctx.project || "~", kind };
  if (ctx.parentId) e.parentId = ctx.parentId;
  if (ctx.cwd) e.cwd = ctx.cwd;
  if (ctx.model) e.model = ctx.model;
  if (ctx.role) e.role = ctx.role;
  return e;
}

/** The session_start / subagent_start for a worker, built from what we know now. */
export function announcement(ctx: WorkerCtx, ts: string): RawEvent {
  const e = base(ctx, ctx.parentId ? "subagent_start" : "session_start", ts);
  if (ctx.parentId && ctx.role) e.summary = ctx.role;
  return e;
}

export type Extra = Partial<Pick<RawEvent, "tool" | "category" | "summary" | "isError" | "tokens">>;

export function emit(ctx: WorkerCtx, kind: EventKind, ts: string, extra: Extra = {}): RawEvent[] {
  if (kind === "thinking" && ctx.lastKind === "thinking") return [];
  if (kind === "subagent_end" || kind === "session_end") {
    if (!ctx.announced) return [];
    ctx.announced = false;
    ctx.pending.clear();
    ctx.lastKind = kind;
    ctx.lastTs = ts;
    return [{ ...base(ctx, kind, ts), ...extra }];
  }
  const out: RawEvent[] = [];
  if (!ctx.announced) {
    ctx.announced = true;
    out.push(announcement(ctx, ts));
  }
  if (kind === "session_start" || kind === "subagent_start") return out;
  const e: RawEvent = { ...base(ctx, kind, ts), ...extra };
  if (ctx.pendingTokens > 0) {
    e.tokens = (e.tokens ?? 0) + ctx.pendingTokens;
    ctx.pendingTokens = 0;
  }
  ctx.lastKind = kind;
  ctx.lastTs = ts;
  out.push(e);
  return out;
}

/** The pieces of a finished tool call that tool_end / test_* repeat. */
export function toolFields(p: PendingTool | undefined): Extra {
  if (!p) return {};
  const x: Extra = { tool: p.tool, category: p.category };
  if (p.summary) x.summary = p.summary;
  return x;
}

export function basename(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : "";
}

export function isoTs(v: unknown, fallback?: string): string {
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  } else if (typeof v === "number" && Number.isFinite(v)) {
    // Seconds or milliseconds since the epoch.
    return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  }
  return fallback ?? new Date().toISOString();
}

export function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

export function isObj(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseJson(line: string): Record<string, any> | null {
  const s = line.trim();
  if (!s || s[0] !== "{") return null;
  try {
    const o = JSON.parse(s);
    return isObj(o) ? o : null;
  } catch {
    return null;
  }
}

/** Join the text of a tool result, whatever shape it came in. */
export function resultText(content: unknown, limit = 200_000): string {
  if (typeof content === "string") return content.slice(0, limit);
  if (Array.isArray(content)) {
    let s = "";
    for (const c of content) {
      if (typeof c === "string") s += c;
      else if (isObj(c) && typeof c.text === "string") s += c.text;
      if (s.length >= limit) break;
    }
    return s.slice(0, limit);
  }
  if (isObj(content)) {
    if (typeof content.text === "string") return content.text.slice(0, limit);
    if (typeof content.value === "string") return content.value.slice(0, limit);
    if (typeof content.output === "string") return content.output.slice(0, limit);
  }
  return "";
}

/** Parsers whose subagents leave no transcript of their own: interns that live as long as the spawning call. */
export interface InternHost extends ParserState {
  internSeq: number;
}

/** Start a synthetic intern for an agent-spawning tool call; returns its events and marks the call. */
export function spawnIntern(state: InternHost, ctx: WorkerCtx, p: PendingTool, callId: string, role: string, ts: string): RawEvent[] {
  const internId = `${ctx.workerId}~${callId.replace(/[^A-Za-z0-9_-]/g, "").slice(-10) || ++state.internSeq}`;
  const intern = newCtx(ctx.agent, internId, {
    parentId: ctx.workerId,
    role: role || "agent",
    project: ctx.project,
    synthetic: true,
    ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
    ...(ctx.model ? { model: ctx.model } : {}),
  });
  state.workers.set(internId, intern);
  p.internId = internId;
  return [...emit(intern, "subagent_start", ts), ...emit(intern, "thinking", ts, { summary: "Thinking" })];
}

/** The spawning call returned: its intern walks out. */
export function endIntern(state: InternHost, p: PendingTool | undefined, ts: string): RawEvent[] {
  if (!p?.internId) return [];
  const intern = state.workers.get(p.internId);
  if (!intern) return [];
  state.workers.delete(p.internId);
  return emit(intern, "subagent_end", ts);
}

/** Close every open call of a worker whose transcript never records results (Cursor). */
export function closePending(state: InternHost, ctx: WorkerCtx, ts: string): RawEvent[] {
  const out: RawEvent[] = [];
  for (const [id, p] of ctx.pending) {
    ctx.pending.delete(id);
    out.push(...emit(ctx, "tool_end", ts, toolFields(p)));
    out.push(...endIntern(state, p, ts));
  }
  return out;
}

/** "Exit code: 1", "Exit Code: 0", "exit status 2" in a tool result. */
export function exitCode(text: string): number | undefined {
  const m = text.match(/\bexit(?:ed with)?[ _](?:code|status)\s*[:=]?\s*(-?\d+)/i);
  return m ? Number(m[1]) : undefined;
}
