/*
 * A small tar writer for "Bring my setup": ustar headers, a pax header for
 * names past 100 bytes, regular files, folders and symlinks, then gzip. It
 * is what Vercel's file upload takes as is, and what `tar xzf -` reads on
 * every other platform. Owner and group are 0 with empty names, so an
 * extracting non-root user owns what it writes and root keeps root.
 */
import { gzip } from "node:zlib";

export interface TarEntry {
  /** Relative, "/"-separated; no "..", no leading "/". */
  name: string;
  type: "file" | "dir" | "symlink";
  mode: number;
  data?: Buffer;
  /** symlink target. */
  link?: string;
  mtime?: number;
}

const BLOCK = 512;

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

function header(name: string, size: number, mode: number, type: string, mtime: number, link = ""): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, "utf8");
  h.write(octal(mode & 0o7777, 8), 100, 8, "ascii");
  h.write(octal(0, 8), 108, 8, "ascii");
  h.write(octal(0, 8), 116, 8, "ascii");
  h.write(octal(size, 12), 124, 12, "ascii");
  h.write(octal(Math.max(0, Math.floor(mtime)), 12), 136, 12, "ascii");
  h.fill(" ", 148, 156);
  h.write(type, 156, 1, "ascii");
  h.write(link, 157, 100, "utf8");
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 7) + " ", 148, 8, "ascii");
  return h;
}

function pad(n: number): Buffer {
  const r = n % BLOCK;
  return r ? Buffer.alloc(BLOCK - r) : Buffer.alloc(0);
}

/** One pax record: "<len> key=value\n", where len counts itself. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body);
  return `${len}${body}`;
}

export function safeName(name: string): boolean {
  if (!name || name.startsWith("/") || name.includes("\0") || name.includes("\\")) return false;
  return name.split("/").every((p) => p !== ".." && p !== "");
}

/** The uncompressed archive. */
export function tarOf(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    if (!safeName(e.name)) throw new Error(`unsafe archive name ${JSON.stringify(e.name.slice(0, 60))}`);
    const name = e.type === "dir" && !e.name.endsWith("/") ? `${e.name}/` : e.name;
    const data = e.type === "file" ? (e.data ?? Buffer.alloc(0)) : Buffer.alloc(0);
    const link = e.type === "symlink" ? (e.link ?? "") : "";
    const mtime = e.mtime ?? Date.now() / 1000;
    const long = Buffer.byteLength(name) > 100 || Buffer.byteLength(link) > 100;
    if (long) {
      const pax = Buffer.from(paxRecord("path", name) + (link ? paxRecord("linkpath", link) : ""), "utf8");
      parts.push(header("PaxHeader", pax.length, 0o644, "x", mtime), pax, pad(pax.length));
    }
    const short = (s: string) => {
      const b = Buffer.from(s, "utf8");
      return b.length > 100 ? b.subarray(0, 100).toString("utf8").replace(/�+$/, "") : s;
    };
    parts.push(header(short(name), data.length, e.mode, e.type === "dir" ? "5" : e.type === "symlink" ? "2" : "0", mtime, short(link)));
    if (data.length) parts.push(data, pad(data.length));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

/** gzip'd; `prefix` ("home/me/app") goes in front of every name (Vercel extracts at "/"). */
export function tgzOf(entries: TarEntry[], prefix = ""): Promise<Buffer> {
  const p = prefix.replace(/^\/+|\/+$/g, "");
  const tar = tarOf(p ? entries.map((e) => ({ ...e, name: `${p}/${e.name}` })) : entries);
  return new Promise((resolve, reject) => gzip(tar, { level: 6 }, (err, out) => (err ? reject(err) : resolve(out))));
}
