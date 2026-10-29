/*
 * AgentSignals from the agent-visualizer MCP server: one JSON line each in
 * $AGENT_VISUALIZER_HOME/outbox/<pid>.jsonl. A signal names the agent (when the
 * MCP client said who it is) and its cwd, never a session, so it goes to the
 * live worker that is calling that very office tool right now (its transcript
 * shows an open or just-finished office_status / office_shout / ... call),
 * else the most recently active one with the same agent and cwd, else the
 * same cwd, else a worker whose launch folder contains the signal's cwd (or
 * the other way round), else nobody. Text is scrubbed again here and capped:
 * the MCP server should have done it, but this is what reaches the screen.
 */
import { SUMMARY_MAX, type AgentKind, type AgentSignal, type RawEvent } from "../shared/events.ts";
import { parseJson, type WorkerCtx } from "./common.ts";
import { scrubText } from "./redact.ts";

const KINDS = new Set<AgentSignal["kind"]>(["status", "shout", "celebrate", "flip"]);
const AGENTS = new Set<AgentKind>(["claude", "commandcode", "codex", "opencode", "droid", "gemini", "qwen", "cursor", "copilot", "other"]);
/**
 * The office tools as each agent's transcript names them: mcp__agent-visualizer__office_status (Claude Code),
 * agent-visualizer__office_status (Codex), agent-visualizer_office_status (opencode), office_status (Gemini, Qwen).
 */
export const OFFICE_TOOL = /(?:^|_)office_(status|shout|celebrate|flip|peers)$/;
/** A finished office call still identifies its caller this long (the signal can land after the result line). */
export const OFFICE_CALL_MS = 20_000;

export function parseSignal(line: string): AgentSignal | null {
  const o = parseJson(line);
  if (!o || o.v !== 1 || !KINDS.has(o.kind) || typeof o.cwd !== "string" || !o.cwd) return null;
  const s: AgentSignal = { v: 1, ts: typeof o.ts === "string" ? o.ts : "", cwd: o.cwd, kind: o.kind };
  if (typeof o.agent === "string" && AGENTS.has(o.agent as AgentKind)) s.agent = o.agent as AgentKind;
  if (typeof o.client === "string") s.client = o.client.slice(0, 64);
  if (typeof o.text === "string") s.text = o.text;
  if (typeof o.mood === "string") s.mood = o.mood;
  return s;
}

/** A Windows path ("C:\x", "c:/x"): one separator, and case doesn't count. */
const WIN_PATH = /^[A-Za-z]:(?:[\\/]|$)/;

function normPath(p: string, home?: string): string {
  let s = p.trim();
  if (home && (s === "~" || s.startsWith("~/") || s.startsWith("~\\"))) s = home + s.slice(1);
  if (WIN_PATH.test(s)) s = s.replace(/\//g, "\\").toLowerCase();
  s = s.replace(/[\\/]+$/, "") || "/";
  return s.replace(/^\/private(?=\/(?:var|tmp|etc)\b)/, "");
}

/** Path equality that survives trailing slashes, macOS's /private prefix, "~" and Windows' case and separators. */
export function sameCwd(a: string | undefined, b: string | undefined, home?: string): boolean {
  if (!a || !b) return false;
  return normPath(a, home) === normPath(b, home);
}

/** Is one folder inside the other? Never through "/", a drive's root or the home folder itself, which contain everything. */
export function nestedCwd(a: string | undefined, b: string | undefined, home?: string): boolean {
  if (!a || !b) return false;
  const x = normPath(a, home), y = normPath(b, home);
  const [outer, inner] = x.length <= y.length ? [x, y] : [y, x];
  if (outer === "/" || /^[a-z]:$/.test(outer) || (home && outer === normPath(home))) return false;
  return inner.startsWith(outer + (WIN_PATH.test(outer) ? "\\" : "/"));
}

function recency(c: WorkerCtx): number {
  return Math.max(c.lastActivityMs || 0, Date.parse(c.lastTs ?? "") || 0);
}

/** 2: it is calling exactly this office tool; 1: some office tool; 0: nothing says it is the caller. */
function callerScore(c: WorkerCtx, kind: AgentSignal["kind"], now: number): number {
  let best = 0;
  const rate = (tool: string) => {
    const m = OFFICE_TOOL.exec(tool);
    if (m) best = Math.max(best, m[1] === kind ? 2 : 1);
  };
  for (const p of c.pending.values()) rate(p.tool);
  if (c.officeCall && now - c.officeCall.at <= OFFICE_CALL_MS) rate(c.officeCall.tool);
  return best;
}

export interface Pick {
  ctx: WorkerCtx;
  /** Nothing else could have sent it: the only candidate, or the one calling the tool. */
  sure: boolean;
}

/** The worker a signal belongs to, if any is in the office. */
export function pickSignalWorker(workers: Iterable<WorkerCtx>, sig: AgentSignal, home?: string, now = Date.now()): Pick | undefined {
  const live = [...workers].filter((c) => c.announced);
  let cands = live.filter((c) => sameCwd(c.cwd, sig.cwd, home));
  if (!cands.length) cands = live.filter((c) => nestedCwd(c.cwd, sig.cwd, home));
  if (!cands.length) return undefined;
  if (sig.agent) {
    const mine = cands.filter((c) => c.agent === sig.agent);
    if (mine.length) cands = mine;
  }
  let best: WorkerCtx | undefined;
  let bestScore = -1;
  for (const c of cands) {
    const s = callerScore(c, sig.kind, now);
    if (s > bestScore || (s === bestScore && recency(c) > recency(best!))) {
      best = c;
      bestScore = s;
    }
  }
  return { ctx: best!, sure: cands.length === 1 || bestScore > 0 };
}

/** pickSignalWorker without the certainty, for callers that just want a worker. */
export function pickWorker(workers: Iterable<WorkerCtx>, sig: AgentSignal, home?: string, now?: number): WorkerCtx | undefined {
  return pickSignalWorker(workers, sig, home, now)?.ctx;
}

/** One emoji-ish token: no letters, digits or markup, at most 8 code points (ZWJ sequences, flags). Anything else is dropped. */
export function cleanMood(m: unknown): string | undefined {
  if (typeof m !== "string") return undefined;
  const s = m.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩\s]/g, "");
  if (!s || [...s].length > 8 || /[A-Za-z0-9<>&"'`\\]/.test(s)) return undefined;
  return s;
}

/** The office event for a signal, as said by `ctx`. */
export function signalEvent(sig: AgentSignal, ctx: WorkerCtx, nowMs: number): RawEvent {
  const t = Date.parse(sig.ts);
  const ts = new Date(Number.isFinite(t) && t <= nowMs ? t : nowMs).toISOString();
  const e: RawEvent = { ts, agent: ctx.agent, workerId: ctx.workerId, project: ctx.project || "~", kind: sig.kind };
  if (ctx.parentId) e.parentId = ctx.parentId;
  if (ctx.cwd) e.cwd = ctx.cwd;
  if (ctx.model) e.model = ctx.model;
  if (ctx.role) e.role = ctx.role;
  const text = typeof sig.text === "string" ? scrubText(sig.text) : "";
  if (text) e.summary = [...text].slice(0, SUMMARY_MAX).join("");
  if (sig.kind === "status") {
    const mood = cleanMood(sig.mood);
    if (mood) e.tool = mood;
  }
  return e;
}
