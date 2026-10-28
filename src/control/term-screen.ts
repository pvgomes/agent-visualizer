/*
 * One session's headless screen: a headless xterm (with SerializeAddon) that
 * every PTY byte is written to. term.ts runs it in the office's own thread,
 * or in the terminal worker (term-worker.ts) when that is there, so parsing
 * the agent's output and serializing 3,000 lines of scrollback for a viewer
 * never hold up the office's event loop.
 *
 * Writes carry a sequence number; a snapshot reports the last one it
 * includes (`upTo`), so term.ts knows exactly which live bytes a viewer still
 * needs after it.
 */
import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";

/** The visible screen only (modes and the alt buffer included), or that plus the scrollback. */
export type SnapshotKind = "screen" | "full";

export interface ScreenOptions {
  cols: number;
  rows: number;
  scrollback: number;
  /** Bytes the terminal answers a query with (DSR, DA1, ...), for the PTY. */
  reply(data: string): void;
  /** The app turned bracketed paste on or off. */
  modes?(bracketedPaste: boolean): void;
}

export class HeadlessScreen {
  private readonly term: Terminal;
  private readonly ser: SerializeAddon;
  /** Sequence number of the last write handed to the terminal. */
  private written = 0;
  private paste = false;
  private disposed = false;

  constructor(private readonly o: ScreenOptions) {
    this.term = new Terminal({ cols: o.cols, rows: o.rows, scrollback: o.scrollback, allowProposedApi: true });
    this.ser = new SerializeAddon();
    this.term.loadAddon(this.ser as any);
    this.term.onData((d: string) => {
      if (!this.disposed) this.o.reply(d);
    });
    this.term.onWriteParsed(() => {
      const bp = this.term.modes.bracketedPasteMode;
      if (bp === this.paste) return;
      this.paste = bp;
      this.o.modes?.(bp);
    });
  }

  get bracketedPaste(): boolean {
    return this.term.modes.bracketedPasteMode;
  }

  write(chunk: Uint8Array | string, seq: number): void {
    if (this.disposed) return;
    this.term.write(chunk);
    this.written = seq;
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    if (cols !== this.term.cols || rows !== this.term.rows) this.term.resize(cols, rows);
  }

  /**
   * Once every byte written so far is parsed, and before any written after: each kind, in order.
   * Between kinds `between` runs (the office's thread yields there, so the screen goes out before
   * the scrollback is serialized); every snapshot reports the writes it includes.
   */
  snapshot(kinds: SnapshotKind[], each: (kind: SnapshotKind, data: string, upTo: number) => void, between?: (next: () => void) => void): void {
    const run = (i: number) => {
      if (i >= kinds.length || this.disposed) return;
      const upTo = this.written;
      this.term.write("", () => {
        if (this.disposed) return;
        const kind = kinds[i]!;
        let data = "";
        try {
          data = this.ser.serialize({ scrollback: kind === "screen" ? 0 : this.o.scrollback });
        } catch {
          data = "";
        }
        each(kind, data, upTo);
        if (i + 1 < kinds.length) (between ?? ((next) => next()))(() => run(i + 1));
      });
    };
    run(0);
  }

  /** The visible screen as plain text. `unwrap`: a line the terminal wrapped comes back whole (a long URL). */
  text(unwrap = false): Promise<string> {
    return new Promise((resolve) => {
      if (this.disposed) return resolve("");
      this.term.write("", () => {
        const b = this.term.buffer.active;
        const lines: string[] = [];
        for (let y = 0; y < this.term.rows; y++) {
          const line = b.getLine(b.viewportY + y);
          if (unwrap && y > 0 && line?.isWrapped && lines.length) lines[lines.length - 1] += line.translateToString(true);
          else lines.push(line?.translateToString(true) ?? "");
        }
        for (let i = 0; i < lines.length; i++) lines[i] = lines[i]!.trimEnd();
        while (lines.length && !lines[lines.length - 1]) lines.pop();
        resolve(lines.join("\n"));
      });
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.term.dispose();
  }
}
