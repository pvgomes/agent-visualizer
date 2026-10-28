/*
 * What the three chat adapters share: the ChatConn listener plumbing, item
 * throttling and scrubbing, JSON-lines framing, and a local child on pipes.
 *
 * Chat mode is the one place prompt and reply text reaches the browser, and
 * only an unlocked one. Even so every text goes through redactSecrets, so a
 * key an agent prints doesn't land on a screen recording, and tool calls
 * carry the office's redacted labels, never their raw input.
 */
import { spawn } from "node:child_process";
import type { Approval, ApprovalAnswer, ChatItem } from "../../shared/control.ts";
import { redactSecrets } from "../../ingest/redact.ts";
import { approvalDetail } from "../approvals.ts";
import { Emitter, Latch } from "../emitter.ts";
import { ControlError, type ChatConn, type Disposable, type PipeProc, type TermExit } from "../types.ts";
import { exitOf } from "../pty.ts";

export const TEXT_MAX = 64 * 1024;
/** At most 8 updates a second per streaming item. */
export const ITEM_MIN_MS = 125;

export function scrubChat(text: string): string {
  const t = text.length > TEXT_MAX ? text.slice(0, TEXT_MAX) + "\n…" : text;
  return redactSecrets(t);
}

export function approvalItem(a: Approval, text: string, turnId?: string): ChatItem {
  return { id: `ap-${a.id}`, kind: "approval", tool: a.tool, ...(a.category ? { category: a.category } : {}), summary: a.summary, ...(a.detail ? { detail: a.detail } : {}), text, ...(turnId ? { turnId } : {}), at: a.at };
}

export const APPROVAL_TEXT = {
  open: "Waiting for you",
  allowed: "Allowed",
  always: "Allowed for this session",
  denied: "Denied",
  withdrawn: "Answered elsewhere",
  interrupted: "Interrupted",
} as const;

/** Short, single-line, scrubbed: for error and system items built from an agent's message. */
export function shortReason(text: unknown, max = 300): string {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return redactSecrets(s.length > max ? s.slice(0, max - 1) + "…" : s);
}

/** ChatItem.detail on a tool: its output's last few lines. */
export const TAIL_LINES = 12;
export const TAIL_CHARS = 2000;
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

/**
 * The tail of what a tool printed, for ChatItem.detail: colours out, a
 * progress line's carriage-return rewrites folded to their last state, keys
 * masked (each whole line, before any cut), home as "~", <= TAIL_LINES lines
 * and TAIL_CHARS characters. Undefined for no output.
 */
export function outputTail(text: unknown, home?: string): string | undefined {
  if (typeof text !== "string" || !text.trim()) return undefined;
  const lines = text
    .slice(-TAIL_CHARS * 8)
    .replace(ANSI, "")
    .replace(/\r\n/g, "\n")
    .replace(/\s+$/, "")
    .split("\n")
    .slice(-TAIL_LINES)
    .map((l) => redactSecrets(l.slice(l.lastIndexOf("\r") + 1)).slice(0, TAIL_CHARS));
  const tail = approvalDetail([lines.join("\n")], home);
  if (!tail) return undefined;
  return tail.length > TAIL_CHARS ? "…" + tail.slice(tail.length - TAIL_CHARS + 1) : tail;
}

/** A longer, multi-line reason, for an error item's detail (masked, home as "~", capped). */
export function longReason(text: unknown, home?: string): string | undefined {
  return typeof text === "string" ? approvalDetail([text], home) : undefined;
}

/** A finite number, or undefined. */
export function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** What closes a turn: ChatItem.turnEnd on a text-less "done", on "Interrupted.", or on an error. */
export interface TurnEnd {
  text?: string;
  kind?: "system" | "error";
  detail?: string;
  /** The whole turn, as the agent reports it or as timed here. */
  durationMs?: number;
  tokens?: number;
}

export abstract class ChatBase implements ChatConn {
  protected readonly items = new Emitter<ChatItem>();
  protected readonly approvals = new Emitter<Approval | null>();
  protected readonly turns = new Emitter<"busy" | "idle">();
  protected readonly ids = new Emitter<string>();
  protected readonly exit = new Latch<TermExit>();
  protected sessionId: string | undefined;
  private busy = false;
  private readonly last = new Map<string, { at: number; timer?: ReturnType<typeof setTimeout>; item?: ChatItem }>();
  /** Assistant items put with `streaming: true` and not final yet: their latest version. */
  private readonly open = new Map<string, ChatItem>();
  private seq = 0;

  constructor(protected readonly now: () => number = Date.now) {}

  get agentSessionId(): string | undefined {
    return this.sessionId;
  }

  abstract send(text: string): Promise<void>;
  abstract interrupt(): Promise<void>;
  abstract answer(a: ApprovalAnswer): Promise<void>;
  abstract stop(): Promise<void>;

  onItem(fn: (it: ChatItem) => void): Disposable {
    return this.items.on(fn);
  }
  onApproval(fn: (a: Approval | null) => void): Disposable {
    return this.approvals.on(fn);
  }
  onTurn(fn: (state: "busy" | "idle") => void): Disposable {
    return this.turns.on(fn);
  }
  onSessionId(fn: (id: string) => void): Disposable {
    if (this.sessionId) {
      const id = this.sessionId;
      queueMicrotask(() => fn(id));
    }
    return this.ids.on(fn);
  }
  onExit(fn: (e: TermExit) => void): Disposable {
    return this.exit.on(fn);
  }

  protected iso(): string {
    return new Date(this.now()).toISOString();
  }

  protected nextId(prefix: string): string {
    return `${prefix}-${++this.seq}`;
  }

  protected setSessionId(id: string): void {
    if (!id || id === this.sessionId) return;
    this.sessionId = id;
    this.ids.emit(id);
  }

  protected setBusy(busy: boolean): void {
    if (busy === this.busy) return;
    this.busy = busy;
    this.turns.emit(busy ? "busy" : "idle");
  }

  protected get isBusy(): boolean {
    return this.busy;
  }

  /** Emit an item now (an assistant item without `streaming` is final), flushing any throttled version of it first. */
  protected put(item: ChatItem): void {
    let it = item.text !== undefined ? { ...item, text: scrubChat(item.text) } : item;
    if (it.kind === "assistant") {
      if (it.streaming) this.open.set(it.id, item);
      else {
        if (it.streaming === undefined) it = { ...it, streaming: false };
        this.open.delete(it.id);
      }
    }
    const l = this.last.get(it.id);
    if (l?.timer) clearTimeout(l.timer);
    this.last.set(it.id, { at: this.now() });
    if (this.last.size > 600) this.last.delete(this.last.keys().next().value!);
    this.items.emit(it);
  }

  /** Emit a streaming update (`streaming: true`), at most ITEM_MIN_MS apart per id; the latest version always arrives. */
  protected stream(item: ChatItem): void {
    item = { ...item, streaming: true };
    this.open.set(item.id, item);
    const l = this.last.get(item.id);
    const t = this.now();
    if (!l || t - l.at >= ITEM_MIN_MS) return this.put(item);
    l.item = item;
    if (l.timer) return;
    l.timer = setTimeout(() => {
      const cur = this.last.get(item.id);
      if (cur?.item) this.put(cur.item);
    }, ITEM_MIN_MS - (t - l.at));
  }

  /** Text still marked streaming whose final version never came (an interrupted reply): put it final as it stands. */
  protected settle(turnId?: string): void {
    for (const it of [...this.open.values()]) if (turnId === undefined || it.turnId === turnId) this.put({ ...it, streaming: false, at: this.iso() });
  }

  protected system(text: string, kind: "system" | "error" = "system", extra: Partial<ChatItem> = {}): void {
    this.put({ id: this.nextId(kind === "error" ? "err" : "sys"), kind, text, ...extra, at: this.iso() });
  }

  /** A prompt; a `queued` one waits for its turn (unqueue it when that starts). */
  protected user(text: string, extra: Pick<ChatItem, "turnId" | "queued"> = {}): ChatItem {
    const it: ChatItem = { id: this.nextId("u"), kind: "user", text, ...(extra.turnId ? { turnId: extra.turnId } : {}), ...(extra.queued ? { queued: true } : {}), at: this.iso() };
    this.put(it);
    return it;
  }

  /** A queued prompt's turn starts: the same item again, without `queued`. */
  protected unqueue(it: ChatItem): void {
    const { queued: _queued, ...rest } = it;
    this.put({ ...rest, at: this.iso() });
  }

  /** A fresh ChatItem.turnId: the office's own, one per prompt, fixed from the moment it is sent. */
  protected newTurnId(): string {
    return this.nextId("turn");
  }

  /** The item that closes a turn. */
  protected endTurn(turnId: string, e: TurnEnd = {}): void {
    const ms = num(e.durationMs);
    const tokens = num(e.tokens);
    this.put({
      id: `end-${turnId}`,
      kind: e.kind ?? "system",
      ...(e.text ? { text: e.text } : {}),
      ...(e.detail ? { detail: e.detail } : {}),
      turnId,
      turnEnd: true,
      ...(ms !== undefined && ms >= 0 ? { durationMs: Math.round(ms) } : {}),
      ...(tokens !== undefined && tokens > 0 ? { tokens: Math.round(tokens) } : {}),
      at: this.iso(),
    });
  }

  /**
   * Queued prompts that will never run (the user interrupted the turn before
   * them, or the agent exited). Each leaves the queue as a turn of its own
   * that says so.
   */
  protected dropQueued(prompts: ChatItem[], why = "Not sent: the turn before it was interrupted."): void {
    for (const it of prompts) {
      this.unqueue(it);
      if (it.turnId) this.endTurn(it.turnId, { text: why });
    }
  }

  protected finished(e: TermExit): void {
    for (const l of this.last.values()) if (l.timer) clearTimeout(l.timer);
    this.settle();
    this.setBusy(false);
    this.exit.fire(e);
  }
}

/** JSON lines from a byte stream: one parsed object per complete line, junk skipped. */
export function jsonLines(fn: (msg: any) => void): (chunk: Uint8Array) => void {
  const dec = new TextDecoder();
  let buf = "";
  return (chunk) => {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line || line[0] !== "{") continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg && typeof msg === "object") fn(msg);
    }
    if (buf.length > 32 << 20) buf = "";
  };
}

/** Keep the last few KB of stderr, for a short reason when the agent dies early. */
export function tailOf(max = 2048): { push(d: Uint8Array): void; text(): string } {
  let s = "";
  return {
    push(d) {
      s = (s + Buffer.from(d).toString("utf8")).slice(-max);
    },
    text: () => s,
  };
}

/** A local child on plain pipes, as a PipeProc. */
/**
 * A local child on pipes, leading its own process group. With `watchdog`,
 * a tiny sh beside it ends that group if the office itself dies without its
 * shutdown (SIGKILL, a crash): for agents that don't stop when their stdin
 * closes (opencode serve), which would otherwise keep running, logged in,
 * on their loopback port.
 */
export function localPipe(file: string, args: string[], cwd: string, env: Record<string, string>, o: { watchdog?: boolean } = {}): Promise<PipeProc> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    if (o.watchdog) watch(child.pid);
    const out = new Emitter<Uint8Array>();
    const err = new Emitter<Uint8Array>();
    const exit = new Latch<TermExit>();
    let started = false;
    child.stdout!.on("data", (d: Buffer) => out.emit(d));
    child.stderr!.on("data", (d: Buffer) => err.emit(d));
    child.stdin!.on("error", () => {});
    child.on("error", (e) => {
      if (!started) reject(new ControlError(500, `Could not start ${file.split("/").pop()}: ${(e as NodeJS.ErrnoException).code ?? "error"}`));
      exit.fire({ code: 127 });
    });
    child.on("exit", (code, signal) => exit.fire(exitOf(code, signal)));
    child.on("spawn", () => {
      started = true;
      resolve({
        pid: child.pid,
        write: (d) => {
          if (!exit.fired && child.stdin!.writable) child.stdin!.write(d);
        },
        end: () => {
          if (child.stdin!.writable) child.stdin!.end();
        },
        onStdout: (fn) => out.on(fn),
        onStderr: (fn) => err.on(fn),
        onExit: (fn) => exit.on(fn),
        kill: (sig = "SIGTERM") => {
          if (exit.fired || !child.pid) return;
          try {
            // detached: the child leads its own group, so this reaches what it started too.
            process.kill(sig === "SIGKILL" ? -child.pid : child.pid, sig);
          } catch {
            try {
              child.kill(sig);
            } catch {
              // Already gone.
            }
          }
        },
      });
    });
  });
}

const WATCHDOG = 'while kill -0 "$1" 2>/dev/null && kill -0 "$2" 2>/dev/null; do sleep 2; done; kill -0 "$1" 2>/dev/null || kill -s TERM -- "-$2" 2>/dev/null; exit 0';

/** Ends process group `pid` within ~2 s of this process dying; goes away by itself when that group's leader exits. */
function watch(pid: number | undefined): void {
  if (!pid || process.platform === "win32") return;
  try {
    const dog = spawn("/bin/sh", ["-c", WATCHDOG, "agent-visualizer-watchdog", String(process.pid), String(pid)], { stdio: "ignore", detached: true });
    dog.on("error", () => {});
    dog.unref();
  } catch {
    // No sh: the office's own shutdown still ends it.
  }
}

/** stdin closed, then SIGTERM, then SIGKILL: resolves once the process is gone. */
export function endGracefully(p: PipeProc, o: { endStdin: boolean; termAfterMs: number; killAfterMs: number }): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    p.onExit(() => {
      done = true;
      for (const t of timers) clearTimeout(t);
      resolve();
    });
    if (o.endStdin) p.end();
    else p.kill("SIGTERM");
    timers.push(
      setTimeout(() => !done && p.kill("SIGTERM"), o.termAfterMs),
      setTimeout(() => !done && p.kill("SIGKILL"), o.termAfterMs + o.killAfterMs),
      setTimeout(() => !done && resolve(), o.termAfterMs + o.killAfterMs + 2000),
    );
    for (const t of timers) t.unref?.();
  });
}
