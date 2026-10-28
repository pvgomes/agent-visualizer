/*
 * The localhost server. Serves the web app, streams the office over SSE and
 * answers a couple of JSON endpoints. Locked down for a page that shows what
 * your agents are doing: only loopback (or the bound host) may be named in
 * the Host header, which defeats DNS rebinding; there are no CORS headers, so
 * other origins can't read anything; and every response carries a strict CSP.
 *
 *   GET /               dist/web/index.html (revalidated by ETag on every load)
 *   GET /assets/*       dist/web/assets/*: hashed names cached for good, the rest revalidated
 *   GET /events         text/event-stream: snapshot, then office events, pings
 *   GET /api/snapshot   the Snapshot as JSON
 *   GET /healthz        liveness; ?challenge=<hex> also returns proof, an HMAC of
 *                       the challenge under the secret in office.json, so the MCP
 *                       server can tell this office from an impostor
 *
 * With a control plane (src/control), /unlock, /api/control/** and
 * /api/hook/** are handed to it before the GET-only gate; the snapshot says
 * per browser whether controls are "enabled", "locked" or "off", and only
 * unlocked /events clients get its control, control_gone and control_info
 * frames.
 */
import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { hostname, networkInterfaces } from "node:os";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import type { OfficeEvent, Snapshot } from "../shared/events.ts";
import type { ControlPlane } from "../control/types.ts";
import type { OfficeState } from "./state.ts";
import { defaultWebRoot, HASHED, IMMUTABLE, safeResolve, serveFile } from "./static.ts";

export const DEFAULT_PORT = 4747;
export const DEFAULT_HOST = "127.0.0.1";
const PING_MS = 15_000;
const MAX_CLIENTS = 64;
/** A client this far behind on the stream is dropped rather than buffered forever. */
const MAX_BACKLOG = 1 << 20;

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // Inline styles (never scripts) for xterm.js, the session terminal: its DOM
  // renderer injects <style> elements and colour style attributes. The chrome
  // itself uses a constructed stylesheet and needs no exemption.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

export interface ServerOptions {
  state: OfficeState;
  host?: string;
  port?: number;
  /** Ports to try after `port` when it is taken. Default 20. */
  portFallback?: number;
  /** Directory holding index.html and assets/. Defaults to dist/web next to the bundle. */
  webRoot?: string;
  pingMs?: number;
  /** The office secret (office.json) that /healthz proves itself with. */
  secret?: string;
  /** Called as a live view opens, before its snapshot is sent; `first`: nobody else is watching. */
  onViewer?: (first: boolean) => void;
  /** Hiring and driving agents from the page (src/control). Absent: watch-only ("off"). */
  control?: ControlPlane;
}

export interface OfficeServer {
  readonly server: Server;
  readonly host: string;
  readonly port: number;
  /** What to open in the browser. */
  readonly url: string;
  readonly webRoot: string;
  clients(): number;
  close(): Promise<void>;
}

export async function startServer(opts: ServerOptions): Promise<OfficeServer> {
  const state = opts.state;
  const host = opts.host ?? DEFAULT_HOST;
  const webRoot = resolve(opts.webRoot ?? defaultWebRoot());
  const assetsRoot = resolve(webRoot, "assets");
  const clients = new Set<ServerResponse>();
  /** /events clients whose request carried a valid unlock cookie and page token: they get control frames (re-checked per frame, so a rotation cuts them off). */
  const unlocked = new Map<ServerResponse, IncomingMessage>();
  const allowed = allowedHosts(host);
  const control = opts.control;
  const controlState = (req: IncomingMessage): NonNullable<Snapshot["control"]> =>
    !control?.enabled ? "off" : control.unlocked(req) ? "enabled" : "locked";
  const snapshotFor = (req: IncomingMessage): Snapshot => ({ ...state.snapshot(), control: controlState(req) });

  const send = (res: ServerResponse, frame: string) => {
    if (res.writableLength > MAX_BACKLOG) {
      clients.delete(res);
      unlocked.delete(res);
      res.destroy();
      return;
    }
    res.write(frame);
  };

  const frames = control?.onFrame((f) => {
    if (!unlocked.size) return;
    const frame = `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`;
    for (const [res, req] of unlocked) {
      if (control.unlocked(req)) send(res, frame);
      else unlocked.delete(res);
    }
  });
  control?.setViewers?.(() => unlocked.size);

  const unsubscribe = state.subscribe((e: OfficeEvent) => {
    if (!clients.size) return;
    const frame = `id: ${e.seq}\nevent: office\ndata: ${JSON.stringify(e)}\n\n`;
    for (const res of clients) send(res, frame);
  });

  const ping = setInterval(() => {
    for (const res of clients) send(res, ": ping\n\n");
  }, opts.pingMs ?? PING_MS);
  ping.unref();

  const server = createServer((req, res) => {
    try {
      handle(req, res);
    } catch {
      if (!res.headersSent) text(res, 500, "Internal error");
      else res.destroy();
    }
  });

  function handle(req: IncomingMessage, res: ServerResponse): void {
    if (!hostAllowed(req.headers.host, allowed)) {
      return text(res, 403, "Forbidden: agent-visualizer only answers to localhost.");
    }
    const raw = req.url ?? "/";
    if (!raw.startsWith("/") || raw.startsWith("//")) return text(res, 400, "Bad request");
    const q = raw.indexOf("?");
    const path = q === -1 ? raw : raw.slice(0, q);
    if (control?.handle(req, res, path)) return;
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      return text(res, 405, "Method not allowed");
    }

    if (path === "/" || path === "/index.html") {
      const ok = serveFile(req, res, webRoot, resolve(webRoot, "index.html"), {
        cache: "no-cache",
        headers: SECURITY_HEADERS,
      });
      if (!ok) text(res, 503, "The web app is not built. Run `npm run build` first.");
      return;
    }
    if (path.startsWith("/assets/")) {
      const file = safeResolve(assetsRoot, path.slice("/assets/".length));
      if (!file) return text(res, 400, "Bad path");
      const ok = serveFile(req, res, assetsRoot, file, { cache: HASHED.test(file) ? IMMUTABLE : "no-cache", headers: SECURITY_HEADERS });
      if (!ok) text(res, 404, "Not found");
      return;
    }
    if (path === "/events" || path === "/api/snapshot") {
      if (crossSite(req, allowed)) return text(res, 403, "Forbidden: cross-site request.");
      if (path === "/api/snapshot") return json(res, 200, snapshotFor(req));
      return openStream(req, res);
    }
    if (path === "/healthz") {
      const challenge = q === -1 ? null : new URLSearchParams(raw.slice(q + 1)).get("challenge");
      const proof = opts.secret && challenge && /^[0-9a-f]{16,128}$/.test(challenge)
        ? createHmac("sha256", opts.secret).update(`agent-visualizer:${challenge}`).digest("hex")
        : undefined;
      return json(res, 200, {
        ok: true,
        demo: state.demo,
        startedAt: state.startedAt,
        uptimeSec: Math.round(process.uptime()),
        workers: state.size,
        clients: clients.size,
        ...(proof ? { proof } : {}),
      });
    }
    if (path === "/favicon.ico") {
      const ok = serveFile(req, res, webRoot, resolve(webRoot, "favicon.ico"), {
        cache: "no-cache",
        headers: SECURITY_HEADERS,
      });
      if (!ok) {
        res.writeHead(204, SECURITY_HEADERS);
        res.end();
      }
      return;
    }
    text(res, 404, "Not found");
  }

  function openStream(req: IncomingMessage, res: ServerResponse): void {
    if (clients.size >= MAX_CLIENTS) return text(res, 503, "Too many viewers");
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    try {
      opts.onViewer?.(clients.size === 0);
    } catch {
      // A hook must never cost a viewer its stream.
    }
    res.write(`retry: 2000\n\nevent: snapshot\ndata: ${JSON.stringify(snapshotFor(req))}\n\n`);
    clients.add(res);
    if (control?.enabled && control.unlocked(req)) unlocked.set(res, req);
    const drop = () => {
      clients.delete(res);
      unlocked.delete(res);
    };
    req.on("close", drop);
    res.on("close", drop);
    res.on("error", drop);
  }

  const port = await listen(server, host, opts.port ?? DEFAULT_PORT, opts.portFallback ?? 20);

  let closing: Promise<void> | undefined;
  return {
    server,
    host,
    port,
    url: `http://${urlHost(host)}:${port}`,
    webRoot,
    clients: () => clients.size,
    close() {
      closing ??= new Promise<void>((done) => {
        clearInterval(ping);
        unsubscribe();
        frames?.dispose();
        for (const res of clients) res.end();
        clients.clear();
        unlocked.clear();
        server.close(() => done());
        server.closeAllConnections?.();
      });
      return closing;
    },
  };
}

/** Listen on port, or the next free one up to port + fallback. Port 0 picks any. */
function listen(server: Server, host: string, port: number, fallback: number): Promise<number> {
  return new Promise((ok, fail) => {
    let attempt = port;
    const tryListen = () => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        if (err.code === "EADDRINUSE" && port !== 0 && attempt < port + fallback && attempt < 65535) {
          attempt++;
          tryListen();
        } else {
          fail(err);
        }
      };
      const onListening = () => {
        server.off("error", onError);
        ok((server.address() as AddressInfo).port);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(attempt, host);
    };
    tryListen();
  });
}

const WILDCARD = new Set(["0.0.0.0", "::", "[::]", ""]);

export function isLoopback(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

export function isWildcard(host: string): boolean {
  return WILDCARD.has(host.trim());
}

/** Hostnames (no port, IPv6 in brackets) a request may name in its Host header. */
export function allowedHosts(bound: string): Set<string> {
  const set = new Set(["localhost", "127.0.0.1", "[::1]"]);
  const add = (h: string) => {
    const v = h.toLowerCase();
    set.add(v.includes(":") && !v.startsWith("[") ? `[${v}]` : v);
  };
  if (isWildcard(bound)) {
    // Bound to every interface on purpose: accept this machine's own addresses and name.
    for (const list of Object.values(networkInterfaces())) {
      for (const a of list ?? []) if (!a.address.startsWith("fe80")) add(a.address);
    }
    const name = hostname().toLowerCase();
    if (name) {
      add(name);
      if (!name.endsWith(".local")) add(`${name}.local`);
    }
  } else {
    add(bound);
  }
  return set;
}

/** The hostname part of a Host header, lowercased: "[::1]:4747" -> "[::1]". */
export function hostOf(header: string | undefined): string | null {
  if (!header) return null;
  const h = header.trim().toLowerCase();
  if (!h || /[\s/@\\]/.test(h)) return null;
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    if (end === -1) return null;
    const rest = h.slice(end + 1);
    if (rest && !/^:\d{1,5}$/.test(rest)) return null;
    return h.slice(0, end + 1);
  }
  const parts = h.split(":");
  if (parts.length > 2 || (parts.length === 2 && !/^\d{1,5}$/.test(parts[1]!))) return null;
  return parts[0]!;
}

export function hostAllowed(header: string | undefined, allowed: Set<string>): boolean {
  const h = hostOf(header);
  return h !== null && allowed.has(h);
}

/** Data endpoints refuse requests a browser marks as coming from another site. */
function crossSite(req: IncomingMessage, allowed: Set<string>): boolean {
  const site = req.headers["sec-fetch-site"];
  if (site === "cross-site" || site === "same-site") return true;
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return !allowed.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return true;
  }
}

function urlHost(host: string): string {
  if (isWildcard(host)) return "localhost";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function text(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": String(Buffer.byteLength(body)),
  });
  res.end(body);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": String(Buffer.byteLength(data)),
  });
  res.end(data);
}
