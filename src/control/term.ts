/*
 * The server's copy of a session's screen. Every PTY byte goes through a
 * headless xterm (3000 lines of scrollback, term-screen.ts) on its way to the
 * browsers, which buys three things:
 *
 *   - replay: a browser that connects late, or reconnects, gets the
 *     serialized screen first (alt buffer and modes included, so bracketed
 *     paste and application cursor keys still work), then live bytes, with no
 *     gap and no duplicate. A viewer that can take it in two steps
 *     (TermSink.replay) gets the visible screen at once, live bytes from then
 *     on, and the whole replay (scrollback too) as soon as it is serialized;
 *     it redraws from that, and the live bytes it doesn't include are sent
 *     again after it;
 *   - query answers: a TUI asks its terminal for the cursor position or its
 *     device attributes at start, and with no browser open nobody would
 *     answer. The headless terminal answers into the PTY itself, and the same
 *     kind of answer arriving from a browser shortly after is dropped, so the
 *     agent never reads two;
 *   - one frame per 16 ms per viewer, at most 64 KB raw, instead of one per
 *     read.
 *
 * The headless terminals run in a worker thread (term-worker.ts, built next
 * to the CLI as term-worker.mjs) when it is there, so parsing a chatty
 * agent's output and serializing a replay never hold up the office's event
 * loop; otherwise (a bundle without the worker, or a worker that died) in
 * this thread, where the replay's scrollback is serialized a tick after its
 * screen went out.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { clampSize } from "./pty.ts";
import { HeadlessScreen, type SnapshotKind } from "./term-screen.ts";
import type { WorkerIn, WorkerOut } from "./term-worker.ts";
import { SCROLLBACK_LINES, type Disposable, type TermSink } from "./types.ts";

export const FRAME_MS = 16;
export const FRAME_MAX = 64 * 1024;
/** A browser's answer of a kind the headless terminal answered this recently is dropped. */
export const REPLY_DEDUP_MS = 2_000;
/** Live bytes a two-step viewer is sent while its whole replay is serialized; past this they wait for it. */
export const RESEND_MAX = 1 << 20;

/** Terminal answers, by kind. The headless terminal answers CPR, DA1, DA2, DSR and DECRPM; the others pass through from a browser. */
const REPLIES: { kind: string; re: RegExp }[] = [
  { kind: "cpr", re: /\x1b\[\d+;\d+R/g },
  { kind: "da1", re: /\x1b\[\?[\d;]*c/g },
  { kind: "da2", re: /\x1b\[>[\d;]*c/g },
  { kind: "dsr", re: /\x1b\[0n/g },
  { kind: "decrpm", re: /\x1b\[\??\d+;\d+\$y/g },
  { kind: "xtversion", re: /\x1bP>\|[^\x1b]*\x1b\\/g },
  { kind: "osc-color", re: /\x1b\]1[01];rgb:[^\x07\x1b]*(?:\x07|\x1b\\)/g },
  { kind: "kitty", re: /\x1b\[\?\d+u/g },
];

export function replyKinds(s: string): string[] {
  const out: string[] = [];
  for (const { kind, re } of REPLIES) {
    re.lastIndex = 0;
    if (re.test(s)) out.push(kind);
  }
  return out;
}

/* ---------------------------------------------------------------- engines */

/** Where a session's headless screen lives: this thread or the worker. */
interface Engine {
  readonly bracketedPaste: boolean;
  write(chunk: Uint8Array, seq: number): void;
  resize(cols: number, rows: number): void;
  /** `data` null: there is no screen to take it from any more (the worker died); nothing to replay. */
  snapshot(kinds: SnapshotKind[], each: (kind: SnapshotKind, data: string | null, upTo: number) => void): void;
  text(unwrap: boolean): Promise<string>;
  dispose(): void;
}

interface EngineHooks {
  reply(data: string): void;
}

function localEngine(cols: number, rows: number, scrollback: number, hooks: EngineHooks): Engine {
  const s = new HeadlessScreen({ cols, rows, scrollback, reply: (d) => hooks.reply(d) });
  return {
    get bracketedPaste() {
      return s.bracketedPaste;
    },
    write: (chunk, seq) => s.write(chunk, seq),
    resize: (c, r) => s.resize(c, r),
    // A tick between the screen and the scrollback: the screen is on its way before the long serialize.
    snapshot: (kinds, each) => s.snapshot(kinds, each, (next) => void setImmediate(next)),
    text: (unwrap) => s.text(unwrap),
    dispose: () => s.dispose(),
  };
}

/** The worker beside the bundle: dist/term-worker.mjs next to dist/cli.js. */
function defaultWorkerFile(): string | null {
  try {
    const url = new URL("./term-worker.mjs", import.meta.url);
    if (url.protocol !== "file:") return null;
    const file = fileURLToPath(url);
    return existsSync(file) ? file : null;
  } catch {
    return null;
  }
}

interface Remote {
  hooks: EngineHooks;
  /** What the worker last said about bracketed paste. */
  paste: boolean;
  /** The worker died: this session's screen carries on here, from the next byte. */
  fallback?: Engine;
  cols: number;
  rows: number;
  scrollback: number;
}

/** One worker thread for every session's screen; started on first use, ended when the last session goes. */
class WorkerHost {
  private worker: Worker | null = null;
  private readonly remotes = new Map<number, Remote>();
  private readonly snaps = new Map<number, (kind: SnapshotKind, data: string | null, upTo: number) => void>();
  private readonly texts = new Map<number, (text: string) => void>();
  private nextId = 0;
  private nextReq = 0;
  private broken = false;

  constructor(private readonly file: string) {}

  get usable(): boolean {
    return !this.broken;
  }

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(this.file, { stdout: false, stderr: false });
    w.unref();
    w.on("message", (m: WorkerOut) => this.onMessage(m));
    const fail = () => {
      if (this.worker !== w) return;
      this.worker = null;
      this.broken = true;
      this.failover();
    };
    w.on("error", fail);
    w.on("exit", fail);
    this.worker = w;
    return w;
  }

  private post(m: WorkerIn, transfer?: ArrayBuffer[]): void {
    if (this.broken) return;
    try {
      this.ensure().postMessage(m, transfer);
    } catch {
      this.broken = true;
      this.failover();
    }
  }

  private onMessage(m: WorkerOut): void {
    switch (m.t) {
      case "reply":
        this.remotes.get(m.id)?.hooks.reply(m.d);
        break;
      case "modes": {
        const r = this.remotes.get(m.id);
        if (r) r.paste = m.bp;
        break;
      }
      case "snap":
        this.snaps.get(m.req)?.(m.kind, m.data, m.upTo);
        break;
      case "text":
        this.texts.get(m.req)?.(m.text);
        this.texts.delete(m.req);
        break;
    }
  }

  /**
   * The worker is gone: each screen starts over in this thread from the next byte, and a viewer
   * waiting for a replay is told there is none (it keeps what it has, and gets the live bytes).
   */
  private failover(): void {
    for (const r of this.remotes.values()) r.fallback ??= localEngine(r.cols, r.rows, r.scrollback, r.hooks);
    for (const fn of this.snaps.values()) fn("full", null, 0);
    this.snaps.clear();
    for (const fn of this.texts.values()) fn("");
    this.texts.clear();
  }

  engine(cols: number, rows: number, scrollback: number, hooks: EngineHooks): Engine {
    const id = ++this.nextId;
    const r: Remote = { hooks, paste: false, cols, rows, scrollback };
    this.remotes.set(id, r);
    this.post({ t: "new", id, cols, rows, scrollback });
    const host = this;
    return {
      get bracketedPaste() {
        return r.fallback ? r.fallback.bracketedPaste : r.paste;
      },
      write(chunk, seq) {
        if (r.fallback) return r.fallback.write(chunk, seq);
        // Its own copy, handed over rather than cloned: a Buffer can be a view into a shared pool.
        const d = Uint8Array.prototype.slice.call(chunk);
        host.post({ t: "w", id, d, seq }, [d.buffer]);
      },
      resize(c, rw) {
        r.cols = c;
        r.rows = rw;
        if (r.fallback) return r.fallback.resize(c, rw);
        host.post({ t: "rs", id, cols: c, rows: rw });
      },
      snapshot(kinds, each) {
        if (r.fallback) return r.fallback.snapshot(kinds, each);
        const req = ++host.nextReq;
        let left = kinds.length;
        host.snaps.set(req, (kind, data, upTo) => {
          if (--left <= 0 || data === null) host.snaps.delete(req);
          each(kind, data, upTo);
        });
        host.post({ t: "snap", id, req, kinds });
      },
      text(unwrap) {
        if (r.fallback) return r.fallback.text(unwrap);
        return new Promise<string>((resolve) => {
          const req = ++host.nextReq;
          host.texts.set(req, resolve);
          host.post({ t: "text", id, req, unwrap });
        });
      },
      dispose() {
        r.fallback?.dispose();
        host.remotes.delete(id);
        host.post({ t: "del", id });
        if (!host.remotes.size && host.worker) {
          const w = host.worker;
          host.worker = null;
          void w.terminate().catch(() => {});
        }
      },
    };
  }
}

const hosts = new Map<string, WorkerHost>();

function makeEngine(o: TermBufferOptions, cols: number, rows: number, scrollback: number, hooks: EngineHooks): Engine {
  const file = o.worker === false ? null : o.worker ?? defaultWorkerFile();
  if (file) {
    let host = hosts.get(file);
    if (!host) hosts.set(file, (host = new WorkerHost(file)));
    if (host.usable) return host.engine(cols, rows, scrollback, hooks);
  }
  return localEngine(cols, rows, scrollback, hooks);
}

/* ------------------------------------------------------------- the buffer */

interface Live {
  seq: number;
  chunk: Uint8Array;
}

interface Viewer {
  sink: TermSink;
  /** Live bytes not sent yet. */
  queue: Live[];
  queued: number;
  /**
   * replay: waiting for its first snapshot (live bytes collect in queue meanwhile).
   * full: a two-step viewer has its screen; live bytes go out and are kept until the whole replay lands.
   * live: caught up.
   */
  phase: "replay" | "full" | "live";
  kept: Live[];
  keptBytes: number;
  exitAfterReplay: boolean;
}

export interface TermBufferOptions {
  cols: number;
  rows: number;
  /** Bytes the terminal answers with, for the PTY (query replies). */
  reply(data: string): void;
  now?: () => number;
  scrollback?: number;
  /** The terminal worker's file (default: term-worker.mjs beside this bundle, if it is there); false: this thread. */
  worker?: string | false;
}

export class TermBuffer {
  private readonly engine: Engine;
  private readonly viewers = new Set<Viewer>();
  private readonly answered = new Map<string, number>();
  private readonly now: () => number;
  private readonly scrollback: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private exitCode: number | null | undefined = undefined;
  private disposed = false;
  private bytes = 0;
  private seq = 0;
  private dims: { cols: number; rows: number };

  constructor(private readonly o: TermBufferOptions) {
    this.now = o.now ?? Date.now;
    this.dims = clampSize(o.cols, o.rows);
    this.scrollback = o.scrollback ?? SCROLLBACK_LINES;
    this.engine = makeEngine(o, this.dims.cols, this.dims.rows, this.scrollback, {
      reply: (d) => {
        if (this.disposed || this.exitCode !== undefined) return;
        const t = this.now();
        for (const k of replyKinds(d)) this.answered.set(k, t);
        this.o.reply(d);
      },
    });
  }

  /** Total PTY bytes seen. */
  get size(): number {
    return this.bytes;
  }

  get cols(): number {
    return this.dims.cols;
  }

  get rows(): number {
    return this.dims.rows;
  }

  /** The app asked for bracketed paste (ESC[?2004h). */
  get bracketedPaste(): boolean {
    return this.engine.bracketedPaste;
  }

  get exited(): boolean {
    return this.exitCode !== undefined;
  }

  /** A chunk from the PTY. */
  write(chunk: Uint8Array): void {
    if (this.disposed || !chunk.length) return;
    this.bytes += chunk.length;
    const seq = ++this.seq;
    this.engine.write(chunk, seq);
    for (const v of this.viewers) {
      v.queue.push({ seq, chunk });
      v.queued += chunk.length;
    }
    this.schedule();
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    const s = clampSize(cols, rows);
    if (s.cols === this.dims.cols && s.rows === this.dims.rows) return;
    this.dims = s;
    this.engine.resize(s.cols, s.rows);
  }

  /**
   * Browser keystrokes on their way to the PTY: answers to terminal queries
   * the headless terminal already gave are taken out.
   */
  filterInput(data: string): string {
    if (!data.includes("\x1b")) return data;
    const t = this.now();
    let out = data;
    for (const { kind, re } of REPLIES) {
      const at = this.answered.get(kind);
      if (at === undefined || t - at > REPLY_DEDUP_MS) continue;
      re.lastIndex = 0;
      out = out.replace(re, "");
    }
    return out;
  }

  /** Replay (the screen first for a two-step viewer, then screen + scrollback), then live bytes, then exit. */
  attach(sink: TermSink): Disposable {
    if (this.disposed) {
      sink.exit(this.exitCode ?? null);
      return { dispose() {} };
    }
    const v: Viewer = { sink, queue: [], queued: 0, phase: "replay", kept: [], keptBytes: 0, exitAfterReplay: false };
    this.viewers.add(v);
    const twoStep = typeof sink.replay === "function";
    // Each snapshot covers every byte written before it was asked for (upTo), and none after.
    this.engine.snapshot(twoStep ? ["screen", "full"] : ["full"], (kind, data, upTo) => {
      if (!this.viewers.has(v)) return;
      if (data === null) {
        // No screen to replay from any more (the worker died): what the viewer has stays, and every
        // live byte it hasn't had yet goes now.
        v.kept = [];
        v.keptBytes = 0;
        v.phase = "live";
        this.flushOne(v);
        if (v.exitAfterReplay || this.exitCode !== undefined) this.finish(v);
        return;
      }
      const bytes = data ? Buffer.from(data, "utf8") : null;
      if (kind === "screen") {
        if (bytes) this.deliver(v, () => sink.replay!(bytes, "screen"));
        this.dropUpTo(v, upTo);
        v.phase = "full";
        this.flushOne(v);
        return;
      }
      if (twoStep) this.deliver(v, () => sink.replay!(bytes ?? Buffer.alloc(0), "full"));
      else if (bytes) this.send(v, bytes);
      if (!this.viewers.has(v)) return;
      // Live bytes sent after the screen that this replay doesn't include go again, after it.
      const again = v.kept.filter((k) => k.seq > upTo);
      v.kept = [];
      v.keptBytes = 0;
      this.dropUpTo(v, upTo);
      v.phase = "live";
      for (const k of again) this.send(v, k.chunk);
      this.flushOne(v);
      if (v.exitAfterReplay || this.exitCode !== undefined) this.finish(v);
    });
    return { dispose: () => void this.viewers.delete(v) };
  }

  get viewerCount(): number {
    return this.viewers.size;
  }

  /** The program ended: viewers get what's left, then exit. The screen stays replayable. */
  exit(code: number | null): void {
    if (this.exitCode !== undefined) return;
    this.exitCode = code;
    for (const v of this.viewers) {
      if (v.phase !== "live") v.exitAfterReplay = true;
      else {
        this.flushOne(v);
        this.finish(v);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    if (this.exitCode === undefined) this.exit(null);
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.viewers.clear();
    this.engine.dispose();
  }

  /** The visible screen as plain text, for tests and diagnostics. `unwrap`: a line the terminal wrapped comes back whole (a long URL). */
  screen(o: { unwrap?: boolean } = {}): Promise<string> {
    return this.engine.text(!!o.unwrap);
  }

  private dropUpTo(v: Viewer, upTo: number): void {
    if (!v.queue.length || v.queue[0]!.seq > upTo) return;
    v.queue = v.queue.filter((q) => q.seq > upTo);
    v.queued = v.queue.reduce((n, q) => n + q.chunk.length, 0);
  }

  private finish(v: Viewer): void {
    this.viewers.delete(v);
    try {
      v.sink.exit(this.exitCode ?? null);
    } catch {
      // The viewer went away.
    }
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      for (const v of this.viewers) if (v.phase !== "replay") this.flushOne(v);
    }, FRAME_MS);
  }

  private flushOne(v: Viewer): void {
    if (!v.queued || v.phase === "replay") return;
    // Waiting for its whole replay with this much already sent: the rest waits for it too.
    if (v.phase === "full" && v.keptBytes >= RESEND_MAX) return;
    const items = v.queue;
    v.queue = [];
    v.queued = 0;
    if (v.phase === "full") {
      v.kept.push(...items);
      for (const it of items) v.keptBytes += it.chunk.length;
    }
    const all = items.length === 1 ? items[0]!.chunk : Buffer.concat(items.map((i) => i.chunk));
    for (let i = 0; i < all.length; i += FRAME_MAX) this.send(v, all.subarray(i, i + FRAME_MAX));
  }

  private deliver(v: Viewer, fn: () => void): void {
    try {
      fn();
    } catch {
      this.viewers.delete(v);
    }
  }

  private send(v: Viewer, chunk: Uint8Array): void {
    try {
      v.sink.data(chunk);
    } catch {
      this.viewers.delete(v);
    }
  }
}
