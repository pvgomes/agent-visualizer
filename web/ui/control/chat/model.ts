/*
 * The chat stream folded into turns, without touching the DOM (so it is
 * tested in node). Items arrive in order and update in place by id; this
 * groups them per turn, times tools and turns from their `at` stamps, works
 * out whether a turn is still running, and which prompts are queued.
 *
 * It renders well from the bare contract (kind/text/tool/category/summary/
 * status/at) and gets exact when an adapter adds the optional fields:
 * turnId groups precisely and places queued prompts, turnEnd closes a turn,
 * streaming keeps it open while text arrives, durationMs / diff / detail /
 * tokens fill in rows and footers. Without turnEnd, "is it still working?"
 * after a finished step is answered by a hint from the office (the worker's
 * last pose), and failing that by what the last item was.
 */
import type { ChatItem } from "../../../../src/shared/control.ts";
import type { ToolCategory } from "../../../../src/shared/events.ts";

export type ApprovalState = "open" | "allowed" | "always" | "denied" | "withdrawn" | "interrupted" | "answered";

export interface Rec {
  item: ChatItem;
  /** First-sight order: a row keeps its place when it updates. */
  seq: number;
  turn: Turn;
  /** Server time it was first seen, and of its latest version. */
  firstAt: number;
  lastAt: number;
  /** Client time of its latest version (orders it against office hints), and of its first. */
  recvAt: number;
  firstRecv: number;
  /** A tool seen running: when it started and, once done, ended (server time). */
  startAt?: number;
  endAt?: number;
  /** A prompt sent while a turn ran, with no turnId to place it: shown in the queue while that turn runs, then inline where it was sent. */
  mid?: boolean;
  /** Client time an assistant item's text last grew (how a stream without the `streaming` flag shows). */
  grewAt?: number;
}

/** Without the flag, text that grew this recently is taken to be still streaming. */
export const GREW_MS = 1500;

export interface Turn {
  key: string;
  turnId?: string;
  /** The prompt that opened it (absent for the session preamble). */
  user?: Rec;
  recs: Rec[];
  started: boolean;
  /** Closed: by turnEnd, or because a later turn started. */
  ended: boolean;
  endRec?: Rec;
  /** Bumped on every change, for the view's dirty check. */
  rev: number;
}

export type Phase = "idle" | "thinking" | "streaming" | "tool" | "waiting";

export interface TurnStats {
  tools: number;
  byCategory: [ToolCategory, number][];
  failed: number;
  running: number;
  testsFailed: number;
  testsPassed: number;
  /** How the turn's last test run went. */
  lastTest?: "ok" | "error";
  files: number;
  added: number;
  removed: number;
  approvals: number;
  denied: number;
  tokens?: number;
  startAt: number;
  endAt: number;
}

export interface TurnParts {
  /** Tools, answered approvals and the agent's in-between notes, in order. */
  log: Rec[];
  /** What renders after the log: open approvals, the reply, errors, notes, mid-turn prompts. */
  after: Rec[];
}

const CATEGORY_ORDER: ToolCategory[] = ["read", "edit", "bash", "search", "web", "agent", "todo", "mcp", "other"];

export const CATEGORY_LABEL: Record<ToolCategory, string> = {
  read: "Read",
  edit: "Edit",
  bash: "Bash",
  search: "Search",
  web: "Web",
  agent: "Agent",
  todo: "Todo",
  mcp: "MCP",
  other: "Other",
};

/** "$ npm test", "$ cargo test", "$ python -m pytest": the office's labels for test runs. */
const TEST_RE = /^\$ (?:(?:npm|pnpm|yarn|bun)(?: run)? test|(?:cargo|go|deno|mix|dotnet|flutter|dart|swift|bun|zig|turbo|nx|sbt|lein|stack|cabal|meson|bazel|gradlew?|mvn) (?:test|check|verify)|node --test|python3? -m (?:pytest|unittest)|pytest|vitest|jest|mocha|ava|tap|rspec|phpunit|tox|nox|ctest|make (?:test|check))\b/;

export function isTestRun(it: Pick<ChatItem, "category" | "summary">): boolean {
  return (it.category === "bash" || it.category === undefined) && TEST_RE.test(it.summary ?? "");
}

export function approvalState(it: ChatItem): ApprovalState {
  const t = (it.text ?? "").toLowerCase();
  if (!t || /wait/.test(t)) return "open";
  if (/interrupt/.test(t)) return "interrupted";
  if (/elsewhere|withdr|expired|cancel/.test(t)) return "withdrawn";
  if (/den|reject|refus/.test(t)) return "denied";
  if (/session|always/.test(t)) return "always";
  if (/allow|approv|accept/.test(t)) return "allowed";
  return "answered";
}

/** "Claude Code is ready in ~/Codes/api." */
export const READY_RE = /^(.{1,40}?) is ready in (.+?)\.?$/;

const parse = (iso: string | undefined): number => {
  const n = Date.parse(iso ?? "");
  return Number.isFinite(n) ? n : 0;
};

const BUSY_HINTS = new Set(["prompt", "thinking", "tool_start", "tool_end", "test_fail", "test_pass", "subagent_start"]);
const IDLE_HINTS = new Set(["waiting", "idle", "session_end", "error"]);

export class ChatModel {
  turns: Turn[] = [];
  /** Turns whose prompt is queued (turnId or queued flag): not started yet. */
  queue: Turn[] = [];
  readonly recs = new Map<string, Rec>();
  ready: ChatItem | null = null;
  /** The session is running: nothing is "working" otherwise. */
  live = true;
  private seq = 0;
  private active: Turn | null = null;
  private pre: Turn | null = null;
  private hintState: { busy: boolean; at: number } | null = null;
  private n = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Start over (the stream reconnected and replays its history). */
  reset(): void {
    this.turns = [];
    this.queue = [];
    this.recs.clear();
    this.ready = null;
    this.active = null;
    this.pre = null;
    this.seq = 0;
  }

  get size(): number {
    return this.recs.size;
  }

  /** The office's latest pose for this agent's worker (an OfficeEvent kind), as a hint for whether a turn still runs. */
  hint(kind: string, recvAt = this.now()): boolean {
    const busy = BUSY_HINTS.has(kind) ? true : IDLE_HINTS.has(kind) ? false : null;
    if (busy === null) return false;
    const was = this.hintState?.busy;
    this.hintState = { busy, at: recvAt };
    // the transcript logs a queued prompt when the agent picks it up: its turn starts now
    const promoted = kind === "prompt" && this.promoteMid(recvAt);
    return promoted || was !== busy;
  }

  /** The oldest mid-turn prompt becomes the start of a new turn. */
  private promoteMid(recvAt: number): boolean {
    const t = this.active;
    const r = t?.recs.filter((x) => x.mid && x.firstRecv < recvAt - 50).sort((a, b) => a.seq - b.seq)[0];
    if (!t || !r) return false;
    // the prompts still waiting behind it move along with it
    const rest = t.recs.filter((x) => x.mid && x !== r);
    t.recs = t.recs.filter((x) => !x.mid);
    const next = this.newTurn();
    r.mid = false;
    r.turn = next;
    next.user = r;
    for (const x of rest) x.turn = next;
    next.recs.push(...rest);
    this.start(next, new Set());
    t.rev++;
    next.rev++;
    return true;
  }

  /** Fold one item in; returns the turns that changed. */
  put(item: ChatItem): Turn[] {
    if (!item || typeof item.id !== "string" || typeof item.kind !== "string") return [];
    const recvAt = this.now();
    const prev = this.recs.get(item.id);
    if (prev) return this.update(prev, item, recvAt);
    const at = parse(item.at);
    const changed = new Set<Turn>();
    const rec: Rec = { item, seq: ++this.seq, turn: null as unknown as Turn, firstAt: at, lastAt: at, recvAt, firstRecv: recvAt };
    if (item.kind === "tool" && item.status !== "ok" && item.status !== "error") rec.startAt = at;

    if (item.kind === "user") {
      if (item.turnId) {
        const t = this.turnById(item.turnId) ?? this.newTurn(item.turnId);
        rec.turn = t;
        t.user = rec;
        if (!t.started && !t.recs.length && this.active && this.active !== t && this.running(this.active)) this.enqueue(t);
        else this.start(t, changed);
      } else if (item.queued) {
        const t = this.newTurn();
        rec.turn = t;
        t.user = rec;
        this.enqueue(t);
      } else if (this.active && this.active !== this.pre && this.running(this.active)) {
        rec.mid = true;
        rec.turn = this.active;
        this.active.recs.push(rec);
      } else {
        const t = this.newTurn();
        rec.turn = t;
        t.user = rec;
        this.start(t, changed);
      }
    } else {
      let t: Turn;
      if (item.turnId) {
        t = this.turnById(item.turnId) ?? this.newTurn(item.turnId);
        if (!t.started) this.start(t, changed);
      } else t = this.active ?? this.preamble(changed);
      rec.turn = t;
      if (item.kind === "system" && !this.ready && !this.turns.some((x) => x.user) && READY_RE.test(item.text ?? "")) this.ready = item;
      t.recs.push(rec);
      if (item.turnEnd) {
        t.ended = true;
        t.endRec = rec;
      }
    }
    this.recs.set(item.id, rec);
    rec.turn.rev++;
    changed.add(rec.turn);
    return [...changed];
  }

  private update(rec: Rec, item: ChatItem, recvAt: number): Turn[] {
    const old = rec.item;
    const at = parse(item.at);
    const changed = new Set<Turn>([rec.turn]);
    if (old.kind === "tool") {
      const was = old.status === "ok" || old.status === "error";
      const done = item.status === "ok" || item.status === "error";
      if (!was && done) rec.endAt = at;
      if (was && !done) {
        rec.startAt = at;
        rec.endAt = undefined;
      }
    }
    if (old.kind === "assistant" && (item.text ?? "").length > (old.text ?? "").length && (item.text ?? "").startsWith(old.text ?? "")) rec.grewAt = recvAt;
    rec.item = { ...item, kind: old.kind };
    rec.lastAt = at;
    rec.recvAt = recvAt;
    if (old.kind === "user" && old.queued && !item.queued) {
      const t = rec.turn;
      if (!t.started) this.start(t, changed);
    }
    if (item.turnEnd && !rec.turn.ended) {
      rec.turn.ended = true;
      rec.turn.endRec = rec;
    }
    for (const t of changed) t.rev++;
    return [...changed];
  }

  private newTurn(turnId?: string): Turn {
    return { key: turnId ? `t:${turnId}` : `n:${++this.n}`, turnId, recs: [], started: false, ended: false, rev: 0 };
  }

  private turnById(id: string): Turn | undefined {
    return this.turns.find((t) => t.turnId === id) ?? this.queue.find((t) => t.turnId === id);
  }

  private preamble(changed: Set<Turn>): Turn {
    if (!this.pre) {
      this.pre = { key: "pre", recs: [], started: true, ended: false, rev: 0 };
      this.turns.push(this.pre);
      this.active = this.pre;
      changed.add(this.pre);
    }
    return this.pre;
  }

  private enqueue(t: Turn): void {
    if (!this.queue.includes(t)) this.queue.push(t);
  }

  private start(t: Turn, changed: Set<Turn>): void {
    if (this.active && this.active !== t && !this.active.ended) {
      this.active.ended = true;
      this.active.rev++;
      changed.add(this.active);
    }
    this.queue = this.queue.filter((x) => x !== t);
    t.started = true;
    if (!this.turns.includes(t)) this.turns.push(t);
    this.active = t;
    changed.add(t);
  }

  /* ------------------------------------------------------------ queries */

  /** Is this assistant text still arriving? The flag when the adapter sends it, else "it grew a moment ago". */
  streaming(r: Rec): boolean {
    if (r.item.kind !== "assistant" || !this.live) return false;
    if (typeof r.item.streaming === "boolean") return r.item.streaming;
    return r.grewAt !== undefined && this.now() - r.grewAt < GREW_MS && !r.turn.ended;
  }

  current(): Turn | null {
    return this.active;
  }

  /** Is this turn still working? Only the active turn of a live session can be. */
  running(t: Turn | null = this.active): boolean {
    if (!t || !this.live || t.ended || t !== this.active || t === this.pre) return false;
    return this.phaseOf(t) !== "idle";
  }

  /** What the active turn is doing right now. */
  phase(): Phase {
    const t = this.active;
    if (!t || !this.live || t.ended || t === this.pre) return "idle";
    return this.phaseOf(t);
  }

  private phaseOf(t: Turn): Phase {
    let last: Rec | undefined;
    let tool = false;
    let streaming = false;
    let waiting = false;
    for (const r of t.recs) {
      if (r.mid) continue;
      const it = r.item;
      if (it.kind === "tool" && it.status !== "ok" && it.status !== "error") tool = true;
      if (it.kind === "assistant" && this.streaming(r)) streaming = true;
      if (it.kind === "approval" && approvalState(it) === "open") waiting = true;
      last = r;
    }
    if (waiting) return "waiting";
    if (streaming) return "streaming";
    if (tool) return "tool";
    if (!last) return t.user ? this.hinted(t, true) : "idle"; // the prompt is out, nothing back yet
    const it = last.item;
    if (it.kind === "error") return "idle";
    if (it.kind === "system") return /interrupt|stopp|exited|cancel/i.test(it.text ?? "") ? "idle" : this.hinted(t, false);
    if (it.kind === "tool" || it.kind === "approval") return this.hinted(t, true);
    // a finished reply: done, unless the office says the agent is still at it
    return this.hinted(t, false);
  }

  /** Ambiguous moment: what the office hint says, if it is about this turn, else the default. */
  private hinted(t: Turn, def: boolean): Phase {
    const h = this.hintState;
    let lastRecv = t.user?.recvAt ?? 0;
    for (const r of t.recs) if (r.recvAt > lastRecv) lastRecv = r.recvAt;
    // a hint counts only if it came after the last thing the turn showed
    if (h && h.at >= lastRecv - 250) return h.busy ? "thinking" : "idle";
    return def ? "thinking" : "idle";
  }

  /** Prompts waiting for their turn: queued turns, and mid-turn prompts while the turn they interrupted runs. */
  queued(): Rec[] {
    const out: Rec[] = [];
    if (this.active && this.running(this.active)) for (const r of this.active.recs) if (r.mid) out.push(r);
    for (const t of this.queue) if (t.user) out.push(t.user);
    return out.sort((a, b) => a.seq - b.seq);
  }

  /** When the active turn's current step began (server time), for "Thinking · 12s". */
  since(): number {
    const t = this.active;
    if (!t) return this.now();
    let at = t.user?.firstAt ?? 0;
    for (const r of t.recs) if (!r.mid) at = Math.max(at, r.lastAt);
    return at || this.now();
  }

  /** The turn's rows in log order and what comes after. */
  parts(t: Turn): TurnParts {
    let lastWork = -1;
    for (const r of t.recs) if (r.item.kind === "tool" || (r.item.kind === "approval" && approvalState(r.item) !== "open")) lastWork = Math.max(lastWork, r.seq);
    const log: Rec[] = [];
    const after: Rec[] = [];
    const showMid = !this.running(t);
    // an answered approval paired with its tool is shown on the tool's row ("Allowed · $ rm -rf dist")
    const folded = new Set(this.pairs(t).values());
    // Claude reports a failed turn twice, as its reply and as the error: the error card says it once
    const norm = (x: string | undefined) => (x ?? "").replace(/\s+/g, " ").trim();
    const errors = new Set(t.recs.filter((r) => r.item.kind === "error").map((r) => norm(r.item.text)));
    for (const r of t.recs) {
      const k = r.item.kind;
      if (r.mid) {
        if (showMid) after.push(r);
      } else if (k === "tool") log.push(r);
      else if (k === "approval") {
        if (approvalState(r.item) === "open") after.push(r);
        else if (!folded.has(r)) log.push(r);
      }
      else if (k === "assistant") {
        if (errors.size && errors.has(norm(r.item.text))) continue;
        (r.seq < lastWork ? log : after).push(r);
      }
      else if (k === "system" && r.item === this.ready) continue;
      else if (k === "system" && !r.item.text && r.item.turnEnd) continue;
      else after.push(r);
    }
    return { log, after };
  }

  /** The tool an approval was about, matched by tool and label in the same turn. */
  pairs(t: Turn): Map<Rec, Rec> {
    const out = new Map<Rec, Rec>();
    const used = new Set<Rec>();
    const tools = t.recs.filter((r) => r.item.kind === "tool");
    for (const a of t.recs) {
      if (a.item.kind !== "approval") continue;
      const match = (r: Rec) => !used.has(r) && r.item.summary === a.item.summary && (!a.item.tool || !r.item.tool || r.item.tool === a.item.tool);
      // nearest before it (the call the agent is asking about), else the first after it
      const before = tools.filter((r) => r.seq < a.seq && match(r)).pop();
      const tool = before ?? tools.find((r) => r.seq > a.seq && match(r));
      if (tool) {
        used.add(tool);
        out.set(tool, a);
      }
    }
    return out;
  }

  stats(t: Turn): TurnStats {
    const refused = new Set<Rec>();
    for (const [tool, ap] of this.pairs(t)) if (["denied", "interrupted", "withdrawn"].includes(approvalState(ap.item))) refused.add(tool);
    const by = new Map<ToolCategory, number>();
    const files = new Map<string, { a: number; r: number }>();
    let tools = 0, failed = 0, running = 0, testsFailed = 0, testsPassed = 0, approvals = 0, denied = 0;
    let tokens: number | undefined;
    let lastTest: TurnStats["lastTest"];
    const startAt = t.user?.firstAt || t.recs.find((r) => !r.mid)?.firstAt || 0;
    let endAt = startAt;
    for (const r of t.recs) {
      if (r.mid) continue;
      const it = r.item;
      endAt = Math.max(endAt, r.lastAt);
      if (it.kind === "assistant" && typeof it.tokens === "number" && it.tokens > 0) tokens = (tokens ?? 0) + it.tokens;
      if (it.kind === "approval") {
        const st = approvalState(it);
        if (st !== "open") approvals++;
        if (st === "denied") denied++;
      }
      if (it.kind !== "tool") continue;
      tools++;
      const cat = (it.category && it.category in CATEGORY_LABEL ? it.category : "other") as ToolCategory;
      by.set(cat, (by.get(cat) ?? 0) + 1);
      if (it.status === "error" && !refused.has(r)) failed++;
      else if (it.status !== "ok" && it.status !== "error") running++;
      if (isTestRun(it) && (it.status === "ok" || it.status === "error")) {
        if (it.status === "error") testsFailed++;
        else testsPassed++;
        lastTest = it.status;
      }
      if (it.diff && typeof it.diff.file === "string") {
        const f = files.get(it.diff.file) ?? { a: 0, r: 0 };
        f.a += Math.max(0, it.diff.added | 0);
        f.r += Math.max(0, it.diff.removed | 0);
        files.set(it.diff.file, f);
      } else if (cat === "edit" && it.status !== "error") {
        const name = (it.summary ?? "").replace(/^\w+\s+/, "");
        if (name && !files.has(name)) files.set(name, { a: 0, r: 0 });
      }
    }
    const end = t.endRec?.item;
    if (end && typeof end.tokens === "number") tokens = end.tokens;
    if (end && typeof end.durationMs === "number" && end.durationMs >= 0 && startAt) endAt = startAt + end.durationMs;
    let added = 0, removed = 0;
    for (const f of files.values()) {
      added += f.a;
      removed += f.r;
    }
    const byCategory = CATEGORY_ORDER.filter((c) => by.has(c)).map((c) => [c, by.get(c)!] as [ToolCategory, number]);
    return { tools, byCategory, failed, running, testsFailed, testsPassed, lastTest, files: files.size, added, removed, approvals, denied, tokens, startAt, endAt };
  }

  /** How a finished turn ended. */
  outcome(t: Turn): "done" | "interrupted" | "failed" {
    const last = [...t.recs].reverse().find((r) => !r.mid && (r.item.kind === "error" || r.item.kind === "system" || r.item.kind === "assistant" || r.item.kind === "tool"));
    if (last?.item.kind === "error") return "failed";
    if (last?.item.kind === "system" && /interrupt/i.test(last.item.text ?? "")) return "interrupted";
    return "done";
  }

  /** A tool's run time: its own durationMs, else what was seen live. */
  static toolMs(r: Rec): number | undefined {
    const d = r.item.durationMs;
    if (typeof d === "number" && d >= 0) return d;
    if (r.startAt !== undefined && r.endAt !== undefined) return Math.max(0, r.endAt - r.startAt);
    return undefined;
  }
}

/* ------------------------------------------------------------------ words */

/** 0.4s, 3s, 42s, 1m 05s, 1h 02m. */
export function dur(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  if (ms < 1000) return `${Math.max(0.1, Math.round(ms / 100) / 10)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** 980, 12.3k, 1.2M. */
export function compact(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
}

/** "10:42", "Yesterday 18:03", "Oct 16, 18:03". */
export function stamp(at: number, now = Date.now()): string {
  if (!at) return "";
  const d = new Date(at);
  const n = new Date(now);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(n) - day(d)) / 86_400_000);
  if (diff === 0) return hm;
  if (diff === 1) return `Yesterday ${hm}`;
  return `${d.toLocaleString("en", { month: "short" })} ${d.getDate()}, ${hm}`;
}
