/*
 * Serves the built web app out of dist/web. Paths are resolved strictly:
 * anything with a dot segment, a backslash, a null byte, double encoding or
 * a dotfile is refused before it touches the filesystem, and the resolved
 * real path must still sit inside the web root (no symlink escapes).
 *
 * Files are answered from memory once read (re-read when their size or mtime
 * changes), and a script's precompressed copy (<name>.br, <name>.gz, written
 * by the build) is sent instead when the browser accepts it. Names with a
 * content hash (app-3FQ2K7ZD.js) never change, so they may be cached for good
 * (HASHED, IMMUTABLE); the rest revalidate by ETag.
 */
import { existsSync, readFileSync, realpathSync, statSync, type Stats } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".webmanifest": "application/manifest+json",
};

export function contentType(file: string): string {
  return TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
}

/**
 * dist/cli.js -> dist/web. Falls back to ../../dist/web so the server also
 * finds the bundle when run from src/server directly.
 */
export function defaultWebRoot(): string {
  const candidates = [new URL("./web/", import.meta.url), new URL("../../dist/web/", import.meta.url)];
  for (const c of candidates) {
    if (c.protocol !== "file:") continue;
    const dir = fileURLToPath(c);
    if (existsSync(resolve(dir, "index.html"))) return dir;
  }
  return candidates[0]!.protocol === "file:" ? fileURLToPath(candidates[0]!) : resolve("dist/web");
}

/**
 * Map a still-encoded URL path (relative to root, no leading slash) to an
 * absolute file path inside root, or null if it is anything but a plain
 * relative path.
 */
export function safeResolve(root: string, encoded: string): string | null {
  if (!encoded || encoded.includes("\0") || /%00/i.test(encoded)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  // A "%" left after one decode means double encoding; nothing we ship has one.
  if (/[\0\\%]/.test(decoded) || /[\u0000-\u001f\u007f]/.test(decoded)) return null;
  const segments = decoded.split("/");
  if (segments.some((s) => s === "" || s === "." || s === ".." || s.startsWith("."))) return null;
  const base = resolve(root);
  const full = resolve(base, ...segments);
  return full.startsWith(base + sep) ? full : null;
}

export interface ServeOptions {
  /** Cache-Control for this response. */
  cache: string;
  headers: Record<string, string>;
}

/** A build output named with esbuild's content hash: its content never changes under that name. */
export const HASHED = /-[A-Z0-9]{8}\.(?:js|css)$/;
export const IMMUTABLE = "public, max-age=31536000, immutable";

/** The encodings we keep copies in that the browser accepts (q > 0), best first: br, then gzip. */
function accepted(req: IncomingMessage): ("br" | "gzip")[] {
  const ok = new Set<string>();
  for (const part of String(req.headers["accept-encoding"] ?? "").toLowerCase().split(",")) {
    const [name, ...params] = part.split(";").map((x) => x.trim());
    const q = params.find((p) => p.startsWith("q="));
    if (name && (!q || Number(q.slice(2)) > 0)) ok.add(name);
  }
  return (["br", "gzip"] as const).filter((e) => ok.has(e));
}

interface Cached {
  size: number;
  mtimeMs: number;
  data: Buffer;
}
const memo = new Map<string, Cached>();
/** Small files only: the web app is a few MB in all. */
const MEMO_MAX_BYTES = 8 << 20;

/** The file's bytes, from memory when it hasn't changed since. */
function contents(file: string, st: Stats): Buffer {
  const hit = memo.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.data;
  const data = readFileSync(file);
  if (data.length <= MEMO_MAX_BYTES) memo.set(file, { size: st.size, mtimeMs: st.mtimeMs, data });
  return data;
}

/** <file>.br or <file>.gz when the browser takes it and the build wrote one (a regular file inside root). */
function encoded(req: IncomingMessage, file: string, realRoot: string): { enc: "br" | "gzip"; file: string; st: Stats } | null {
  if (!/\.(?:js|css|svg)$/.test(file)) return null;
  for (const enc of accepted(req)) {
    const alt = `${file}.${enc === "br" ? "br" : "gz"}`;
    try {
      const st = statSync(alt);
      if (!st.isFile() || !realpathSync(alt).startsWith(realRoot + sep)) continue;
      return { enc, file: alt, st };
    } catch {
      // No copy in that encoding.
    }
  }
  return null;
}

/**
 * Send one file that safeResolve already vetted. Returns false (and writes
 * nothing) when it is not a regular file inside root, so the caller can 404.
 */
export function serveFile(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  file: string,
  opts: ServeOptions,
): boolean {
  let st: Stats;
  let realRoot: string;
  try {
    st = statSync(file);
    if (!st.isFile()) return false;
    realRoot = realpathSync(root);
    const real = realpathSync(file);
    if (!real.startsWith(realRoot + sep)) return false;
  } catch {
    return false;
  }

  const alt = encoded(req, file, realRoot);
  const body = alt ?? { file, st };
  const tag = `${body.st.size.toString(16)}-${Math.floor(body.st.mtimeMs).toString(16)}${alt ? `-${alt.enc}` : ""}`;
  const etag = `W/"${tag}"`;
  const headers: Record<string, string> = {
    ...opts.headers,
    "Content-Type": contentType(file),
    "Cache-Control": opts.cache,
    ETag: etag,
    "Last-Modified": st.mtime.toUTCString(),
  };
  if (/\.(?:js|css|svg)$/.test(file)) headers.Vary = "Accept-Encoding";
  if (alt) headers["Content-Encoding"] = alt.enc;
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  let data: Buffer;
  try {
    data = contents(body.file, body.st);
  } catch {
    return false;
  }
  headers["Content-Length"] = String(data.length);
  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : data);
  return true;
}
