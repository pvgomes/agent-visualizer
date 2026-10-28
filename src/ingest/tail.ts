/*
 * Byte-offset line reader for append-only JSONL files. Reads in fixed chunks
 * with async I/O so a 300 MB transcript never blocks the event loop, splits
 * on raw newline bytes (a UTF-8 character cut by a chunk boundary is joined
 * before decoding), and holds an unterminated last line until its newline
 * arrives. Callers detect truncation (size < offset) and seek back to 0.
 * The ingest loop reads through a Source and hands bytes to take(); pull()
 * reads a local file directly.
 */
import { open } from "node:fs/promises";

export const CHUNK_BYTES = 1 << 20;
/** A "line" longer than this without a newline is dropped rather than buffered forever. */
export const MAX_LINE_BYTES = 64 << 20;

export class LineTail {
  /** Bytes consumed so far (complete lines plus the buffered partial line). */
  offset = 0;
  private rest: Buffer[] = [];
  private restBytes = 0;
  /** Discard bytes up to the next newline (we started mid-line, or dropped an oversized line). */
  private skipToNewline = false;

  constructor(
    readonly path: string,
    private readonly maxLine = MAX_LINE_BYTES,
  ) {}

  /** Continue from `offset`. With `midLine`, the bytes before the first newline are a fragment and are skipped. */
  seek(offset: number, midLine = offset > 0): void {
    this.offset = offset;
    this.rest = [];
    this.restBytes = 0;
    this.skipToNewline = midLine;
  }

  get buffered(): number {
    return this.restBytes;
  }

  /** Read [offset, end) and return the complete lines in it. */
  async pull(end: number): Promise<string[]> {
    if (end <= this.offset) return [];
    const lines: string[] = [];
    const fh = await open(this.path, "r");
    try {
      const buf = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, end - this.offset));
      while (this.offset < end) {
        const want = Math.min(buf.length, end - this.offset);
        const { bytesRead } = await fh.read(buf, 0, want, this.offset);
        if (bytesRead <= 0) break;
        this.offset += bytesRead;
        this.feed(buf.subarray(0, bytesRead), lines);
      }
    } finally {
      await fh.close();
    }
    return lines;
  }

  /** Feed bytes read at `offset` (from any Source) and return the complete lines; advances the offset. */
  take(chunk: Buffer): string[] {
    const lines: string[] = [];
    this.offset += chunk.length;
    this.feed(chunk, lines);
    return lines;
  }

  /** Split a chunk into lines; exposed for tests. */
  feed(chunk: Buffer, lines: string[]): void {
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(10, start);
      if (nl < 0) break;
      const piece = chunk.subarray(start, nl);
      start = nl + 1;
      if (this.skipToNewline) {
        this.skipToNewline = false;
        this.rest = [];
        this.restBytes = 0;
        continue;
      }
      let bytes: Buffer = piece;
      if (this.restBytes) {
        bytes = Buffer.concat([...this.rest, piece]);
        this.rest = [];
        this.restBytes = 0;
      }
      const line = bytes.toString("utf8");
      if (line.trim()) lines.push(line.endsWith("\r") ? line.slice(0, -1) : line);
    }
    if (start < chunk.length && !this.skipToNewline) {
      // Copy: the read buffer is reused for the next chunk.
      const tail = Buffer.from(chunk.subarray(start));
      this.rest.push(tail);
      this.restBytes += tail.length;
      if (this.restBytes > this.maxLine) {
        this.rest = [];
        this.restBytes = 0;
        this.skipToNewline = true;
      }
    }
  }
}

/** The first line of a file (session headers), up to `max` bytes. */
export async function readFirstLine(path: string, max = 4 << 20): Promise<string> {
  let fh;
  try {
    fh = await open(path, "r");
  } catch {
    return "";
  }
  try {
    const parts: Buffer[] = [];
    let total = 0;
    const buf = Buffer.allocUnsafe(64 << 10);
    while (total < max) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, total);
      if (bytesRead <= 0) break;
      const nl = buf.subarray(0, bytesRead).indexOf(10);
      if (nl >= 0) {
        parts.push(Buffer.from(buf.subarray(0, nl)));
        return Buffer.concat(parts).toString("utf8");
      }
      parts.push(Buffer.from(buf.subarray(0, bytesRead)));
      total += bytesRead;
    }
    return "";
  } catch {
    return "";
  } finally {
    await fh.close();
  }
}
