/*
 * A minimal RFC 6455 WebSocket client over node:http / node:https, for Node
 * 18+ (the global WebSocket only arrived unflagged in Node 22, and it can't
 * send headers on the upgrade, which Daytona's toolbox needs). Enough for the
 * three cloud terminals the office opens: Daytona's PTY, Vercel's
 * interactive shell and Railway's exec bridge.
 *
 *   - extra headers and subprotocols on the upgrade request (Railway puts a
 *     short-lived token in the subprotocol list);
 *   - Sec-WebSocket-Accept checked, and a subprotocol we didn't offer refused;
 *   - client frames masked, server frames must not be;
 *   - fragmented messages reassembled, at most 16 MB per message;
 *   - ping answered with pong, and our own ping every 20 s so an idle terminal isn't dropped;
 *     close answered, with a 2 s deadline on ours.
 *
 * Messages that arrive before anyone listens are kept and handed to the first
 * listener, so a server that speaks first (Daytona's "connected") is never
 * missed. Upgrade failures become RemoteErrors: "auth" for 401/403,
 * "timeout", or "unreachable"; their messages never carry the URL's query,
 * which is where a token may ride.
 */
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import { RemoteError, scrubMessage } from "../remote/util.ts";
import type { Disposable } from "./types.ts";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const WS_MAX_MESSAGE = 16 << 20;
const CLOSE_DEADLINE_MS = 2_000;
const PING_MS = 20_000;

export interface WsOptions {
  headers?: Record<string, string>;
  protocols?: string[];
  /** For the upgrade (default 15 s). */
  timeoutMs?: number;
  maxMessageBytes?: number;
  /**
   * A ping this often while open (default 20 s; 0: none). A terminal waiting at a prompt sends
   * nothing for minutes, and a proxy in front of it (Vercel's) drops a connection that quiet.
   */
  pingMs?: number;
}

export interface Ws {
  /** The subprotocol the server picked ("" for none). */
  readonly protocol: string;
  readonly closed: boolean;
  send(data: string | Uint8Array): void;
  onMessage(fn: (data: Uint8Array | string) => void): Disposable;
  /** Once. 1005: the server sent no code; 1006: the connection dropped without a close. */
  onClose(fn: (code: number, reason: string) => void): Disposable;
  close(code?: number, reason?: string): void;
}

/** host[:port]/path of a URL, for messages: never the query string. */
function where(u: URL): string {
  return `${u.host}${u.pathname}`.slice(0, 120);
}

export function connectWs(url: string, o: WsOptions = {}): Promise<Ws> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return Promise.reject(new RemoteError("failed", "bad WebSocket URL"));
  }
  if (u.protocol !== "ws:" && u.protocol !== "wss:") return Promise.reject(new RemoteError("failed", `not a WebSocket URL (${u.protocol})`));
  const secure = u.protocol === "wss:";
  const key = randomBytes(16).toString("base64");
  const protocols = (o.protocols ?? []).filter(Boolean);
  const headers: Record<string, string> = {
    ...o.headers,
    Connection: "Upgrade",
    Upgrade: "websocket",
    "Sec-WebSocket-Version": "13",
    "Sec-WebSocket-Key": key,
  };
  if (protocols.length) headers["Sec-WebSocket-Protocol"] = protocols.join(", ");
  const timeoutMs = o.timeoutMs ?? 15_000;

  return new Promise<Ws>((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };
    const req = (secure ? httpsRequest : httpRequest)({
      protocol: secure ? "https:" : "http:",
      hostname: u.hostname.replace(/^\[|\]$/g, ""),
      port: u.port || (secure ? 443 : 80),
      path: u.pathname + u.search,
      method: "GET",
      headers,
    });
    const timer = setTimeout(() => {
      fail(new RemoteError("timeout", `${where(u)}: WebSocket upgrade timed out`));
      req.destroy();
    }, Math.max(1, timeoutMs));
    timer.unref?.();
    req.on("error", (e) => fail(new RemoteError("unreachable", `${where(u)}: ${scrubMessage(e.message)}`)));
    req.on("response", (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        if (size < 4096) chunks.push(c);
        size += c.length;
      });
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        let msg = "";
        try {
          const j = JSON.parse(body);
          msg = typeof j?.message === "string" ? j.message : typeof j?.error === "string" ? j.error : typeof j?.error?.message === "string" ? j.error.message : "";
        } catch {
          msg = body.slice(0, 80);
        }
        const code = status === 401 || status === 403 ? "auth" : status === 404 || status === 410 ? "gone" : status >= 500 ? "unreachable" : "failed";
        fail(new RemoteError(code, `${where(u)}: ${status}${msg ? ` ${scrubMessage(msg)}` : ""}`));
      });
      res.on("error", () => fail(new RemoteError("unreachable", `${where(u)}: ${status}`)));
    });
    req.on("upgrade", (res: IncomingMessage, socket: Socket, head: Buffer) => {
      if (settled) {
        socket.destroy();
        return;
      }
      const accept = createHash("sha1").update(key + GUID).digest("base64");
      if (res.headers["sec-websocket-accept"] !== accept) {
        socket.destroy();
        return fail(new RemoteError("failed", `${where(u)}: bad Sec-WebSocket-Accept`));
      }
      const picked = String(res.headers["sec-websocket-protocol"] ?? "").trim();
      if (picked && !protocols.includes(picked)) {
        socket.destroy();
        return fail(new RemoteError("failed", `${where(u)}: server picked a subprotocol we didn't offer`));
      }
      settled = true;
      clearTimeout(timer);
      resolve(new Conn(socket, picked, o.maxMessageBytes ?? WS_MAX_MESSAGE, head, o.pingMs ?? PING_MS));
    });
    req.end();
  });
}

class Conn implements Ws {
  private buf: Buffer = Buffer.alloc(0);
  private parts: Buffer[] = [];
  private partsSize = 0;
  private partsOp = 0;
  private readonly msgFns = new Set<(d: Uint8Array | string) => void>();
  private readonly closeFns = new Set<(code: number, reason: string) => void>();
  private queued: (Uint8Array | string)[] = [];
  private sentClose = false;
  private gotClose = false;
  private done: { code: number; reason: string } | undefined;
  private closeTimer?: ReturnType<typeof setTimeout>;
  private pinger?: ReturnType<typeof setInterval>;

  constructor(private readonly socket: Socket, readonly protocol: string, private readonly max: number, head: Buffer, pingMs = 0) {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 15_000);
    if (pingMs > 0) {
      this.pinger = setInterval(() => {
        if (!this.closed) this.frame(9, Buffer.alloc(0));
      }, pingMs);
      this.pinger.unref?.();
    }
    socket.on("data", (c: Buffer) => this.feed(c));
    socket.on("error", () => {});
    socket.on("close", () => this.finish(1006, ""));
    if (head?.length) queueMicrotask(() => this.feed(head));
  }

  get closed(): boolean {
    return this.done !== undefined || this.sentClose;
  }

  send(data: string | Uint8Array): void {
    if (this.closed) return;
    const text = typeof data === "string";
    this.frame(text ? 1 : 2, text ? Buffer.from(data, "utf8") : Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  }

  onMessage(fn: (d: Uint8Array | string) => void): Disposable {
    this.msgFns.add(fn);
    if (this.queued.length) {
      const q = this.queued;
      this.queued = [];
      queueMicrotask(() => {
        for (const m of q) this.emit(m);
      });
    }
    return { dispose: () => void this.msgFns.delete(fn) };
  }

  onClose(fn: (code: number, reason: string) => void): Disposable {
    if (this.done) {
      const { code, reason } = this.done;
      let live = true;
      queueMicrotask(() => live && fn(code, reason));
      return { dispose: () => void (live = false) };
    }
    this.closeFns.add(fn);
    return { dispose: () => void this.closeFns.delete(fn) };
  }

  close(code = 1000, reason = ""): void {
    if (this.done || this.sentClose) return;
    this.sentClose = true;
    const r = Buffer.from(reason, "utf8").subarray(0, 123);
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0);
    r.copy(p, 2);
    this.frame(8, p);
    if (this.gotClose) {
      this.socket.end();
      return;
    }
    this.closeTimer = setTimeout(() => this.socket.destroy(), CLOSE_DEADLINE_MS);
    this.closeTimer.unref?.();
  }

  /* ------------------------------------------------------------ framing */

  private frame(op: number, payload: Buffer): void {
    const len = payload.length;
    const head = len < 126 ? Buffer.alloc(6) : len < 65536 ? Buffer.alloc(8) : Buffer.alloc(14);
    head[0] = 0x80 | op;
    let off: number;
    if (len < 126) {
      head[1] = 0x80 | len;
      off = 2;
    } else if (len < 65536) {
      head[1] = 0x80 | 126;
      head.writeUInt16BE(len, 2);
      off = 4;
    } else {
      head[1] = 0x80 | 127;
      head.writeBigUInt64BE(BigInt(len), 2);
      off = 10;
    }
    const mask = randomBytes(4);
    mask.copy(head, off);
    const body = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) body[i] = payload[i]! ^ mask[i & 3]!;
    try {
      this.socket.write(Buffer.concat([head, body]));
    } catch {
      // The socket is gone; "close" reports it.
    }
  }

  private feed(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (!this.done) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0]! & 0x80) !== 0;
      const rsv = b[0]! & 0x70;
      const op = b[0]! & 0x0f;
      const masked = (b[1]! & 0x80) !== 0;
      let len = b[1]! & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(this.max)) return this.protocolError(1009, "message too big");
        len = Number(big);
        off = 10;
      }
      if (rsv) return this.protocolError(1002, "reserved bits set");
      if (masked) return this.protocolError(1002, "masked server frame");
      if (op >= 8 && (!fin || len > 125)) return this.protocolError(1002, "bad control frame");
      if (len > this.max) return this.protocolError(1009, "message too big");
      if (b.length < off + len) return;
      const payload = b.subarray(off, off + len);
      this.buf = b.subarray(off + len);
      this.handle(fin, op, payload);
    }
  }

  private handle(fin: boolean, op: number, payload: Buffer): void {
    if (op === 9) return this.frame(10, Buffer.from(payload));
    if (op === 10) return;
    if (op === 8) {
      this.gotClose = true;
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
      if (!this.sentClose) {
        this.sentClose = true;
        this.frame(8, payload.length >= 2 ? Buffer.from(payload.subarray(0, 2)) : Buffer.alloc(0));
      }
      this.finish(code, reason);
      this.socket.end();
      return;
    }
    if (op === 0) {
      if (!this.partsOp) return this.protocolError(1002, "continuation without a start");
    } else if (op === 1 || op === 2) {
      if (this.partsOp) return this.protocolError(1002, "new message inside a fragmented one");
      this.partsOp = op;
    } else {
      return this.protocolError(1002, "unknown opcode");
    }
    this.partsSize += payload.length;
    if (this.partsSize > this.max) return this.protocolError(1009, "message too big");
    this.parts.push(Buffer.from(payload));
    if (!fin) return;
    const whole = this.parts.length === 1 ? this.parts[0]! : Buffer.concat(this.parts);
    const text = this.partsOp === 1;
    this.parts = [];
    this.partsSize = 0;
    this.partsOp = 0;
    this.emit(text ? whole.toString("utf8") : new Uint8Array(whole.buffer, whole.byteOffset, whole.byteLength));
  }

  private emit(m: Uint8Array | string): void {
    if (!this.msgFns.size) {
      this.queued.push(m);
      return;
    }
    for (const fn of [...this.msgFns]) {
      try {
        fn(m);
      } catch {
        // A listener's bug never breaks the connection.
      }
    }
  }

  private protocolError(code: number, reason: string): void {
    this.close(code, reason);
    this.finish(code, reason);
    this.socket.destroy();
  }

  private finish(code: number, reason: string): void {
    if (this.done) return;
    this.done = { code, reason };
    if (this.closeTimer) clearTimeout(this.closeTimer);
    if (this.pinger) clearInterval(this.pinger);
    // What arrived before anyone listened stays queued for the first onMessage, which hands it
    // over ahead of the close it registers for after (a server that sends and closes at once).
    if (this.msgFns.size) {
      const q = this.queued;
      this.queued = [];
      for (const m of q) for (const fn of [...this.msgFns]) fn(m);
    }
    for (const fn of [...this.closeFns]) {
      try {
        fn(code, reason);
      } catch {
        // Ignore.
      }
    }
    this.closeFns.clear();
  }
}
