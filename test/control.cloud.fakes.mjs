// Shared fakes for the cloud control tests (test/control.ws.test.mjs, test/control.cloud.*.test.mjs):
// a handwritten WebSocket server (RFC 6455, server side) on an HTTP server that also answers
// plain requests, a pipe-backed stand-in for the PTY backend that records what it was asked to
// run, and a PlacesContext with a fake office, key store and watch. Nothing here talks to a real
// service, and every key is a dummy.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** A frame from the server (never masked). */
export function serverFrame(op, payload, { fin = true, mask = false, rsv = 0 } = {}) {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? "");
  const len = p.length;
  const head = [((fin ? 0x80 : 0) | rsv | op) & 0xff];
  const m = mask ? 0x80 : 0;
  if (len < 126) head.push(m | len);
  else if (len < 65536) head.push(m | 126, len >> 8, len & 0xff);
  else {
    head.push(m | 127);
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(len));
    head.push(...b);
  }
  const key = mask ? Buffer.from([1, 2, 3, 4]) : Buffer.alloc(0);
  const body = mask ? Buffer.from(p.map((x, i) => x ^ key[i & 3])) : p;
  return Buffer.concat([Buffer.from(head), key, body]);
}

/** Parse client frames out of `buf`; returns {frames, rest}. Every client frame must be masked. */
function parseClient(buf) {
  const frames = [];
  let b = buf;
  for (;;) {
    if (b.length < 2) break;
    const fin = (b[0] & 0x80) !== 0;
    const op = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) break;
      len = b.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (b.length < 10) break;
      len = Number(b.readBigUInt64BE(2));
      off = 10;
    }
    const mlen = masked ? 4 : 0;
    if (b.length < off + mlen + len) break;
    const key = b.subarray(off, off + mlen);
    const raw = b.subarray(off + mlen, off + mlen + len);
    const payload = masked ? Buffer.from(raw.map((x, i) => x ^ key[i & 3])) : Buffer.from(raw);
    frames.push({ fin, op, masked, payload });
    b = b.subarray(off + mlen + len);
  }
  return { frames, rest: b };
}

/**
 * An HTTP + WebSocket server. `http(req, body, url)` answers plain requests like remote.fakes' serve
 * ({status, json} | {status, text}); `ws(conn, req, url)` gets each upgraded connection, unless
 * `reject(req, url)` returns a status to refuse the upgrade with. `protocol(offered)` picks the
 * subprotocol to answer (default: the first offered one, none when none was offered).
 * `stream(req, res, url)` may take a request over and answer it as it likes (a long-lived
 * stream): it returns true when it did.
 */
export async function wsServe({ http, ws, reject, protocol, accept, stream } = {}) {
  const requests = [];
  const conns = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bytes = Buffer.concat(chunks);
    const raw = bytes.toString("utf8");
    let body;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    const url = new URL(req.url, "http://x");
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
    if (stream?.(req, res, url, body)) return;
    try {
      // The raw bytes too, for uploads (an archive isn't text).
      const r = (await http?.(req, body, url, bytes)) ?? { status: 404, json: { message: "no route" } };
      res.writeHead(r.status ?? 200, { "content-type": r.type ?? "application/json" });
      res.end(r.text ?? JSON.stringify(r.json ?? {}));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: String(err) }));
    }
  });
  server.on("upgrade", (req, socket) => {
    const url = new URL(req.url, "http://x");
    requests.push({ method: "UPGRADE", path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers });
    const refused = reject?.(req, url);
    if (refused) {
      socket.end(`HTTP/1.1 ${refused} Nope\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n${JSON.stringify({ message: "refused" })}`);
      return;
    }
    const key = req.headers["sec-websocket-key"];
    const offered = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const picked = protocol ? protocol(offered) : offered[0];
    const acc = accept ?? createHash("sha1").update(key + GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${acc}\r\n` +
        (picked ? `Sec-WebSocket-Protocol: ${picked}\r\n` : "") +
        "\r\n",
    );
    const conn = new ServerConn(socket, req, url, picked);
    conns.push(conn);
    ws?.(conn, req, url);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  server.unref();
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    requests,
    conns,
    close: () =>
      new Promise((r) => {
        for (const c of conns) c.socket.destroy();
        server.close(r);
        // A stream still being answered (a chat's log) would hold the close open.
        server.closeAllConnections?.();
      }),
  };
}

class ServerConn {
  constructor(socket, req, url, protocol) {
    this.socket = socket;
    this.req = req;
    this.url = url;
    this.protocol = protocol;
    this.received = []; // {op, data: Buffer|string}
    this.frames = []; // raw client frames, to check masking
    this.closed = undefined;
    this.listeners = [];
    this.closeListeners = [];
    this.parts = [];
    let buf = Buffer.alloc(0);
    socket.on("data", (c) => {
      buf = Buffer.concat([buf, c]);
      const { frames, rest } = parseClient(buf);
      buf = rest;
      for (const f of frames) this.onFrame(f);
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (!this.closed) this.closed = { code: 1006, reason: "" };
      for (const fn of this.closeListeners) fn(this.closed);
    });
  }

  onFrame(f) {
    this.frames.push(f);
    if (f.op === 8) {
      const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005;
      this.closed = { code, reason: f.payload.subarray(2).toString("utf8") };
      if (!this.sentClose) this.socket.write(serverFrame(8, f.payload.subarray(0, 2)));
      this.socket.end();
      return;
    }
    if (f.op === 9) return this.socket.write(serverFrame(10, f.payload));
    if (f.op === 10) {
      this.pong = f.payload.toString("utf8");
      return;
    }
    if (f.op === 1 || f.op === 2) this.op = f.op;
    this.parts.push(f.payload);
    if (!f.fin) return;
    const whole = Buffer.concat(this.parts);
    this.parts = [];
    const msg = { op: this.op, data: this.op === 1 ? whole.toString("utf8") : whole };
    this.received.push(msg);
    for (const fn of this.listeners) fn(msg);
  }

  onMessage(fn) {
    this.listeners.push(fn);
  }

  onClose(fn) {
    this.closeListeners.push(fn);
  }

  text(s) {
    this.socket.write(serverFrame(1, Buffer.from(s, "utf8")));
  }

  binary(b) {
    this.socket.write(serverFrame(2, Buffer.from(b)));
  }

  raw(buf) {
    this.socket.write(buf);
  }

  close(code = 1000, reason = "") {
    this.sentClose = true;
    const r = Buffer.from(reason, "utf8");
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0);
    r.copy(p, 2);
    this.socket.write(serverFrame(8, p));
  }

  /** Wait for the next message matching `pred`. */
  next(pred = () => true, ms = 5000) {
    const hit = this.received.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timed out waiting for a client message")), ms);
      this.listeners.push((m) => {
        if (pred(m)) {
          clearTimeout(t);
          resolve(m);
        }
      });
    });
  }
}

/**
 * A PtyBackend stand-in: runs the program on plain pipes (no terminal), so a fake ssh / railway /
 * daytona CLI written as a node script can record its argv and stdin. Records every spawn and resize.
 */
export function fakePty() {
  const spawns = [];
  const children = [];
  return {
    kind: "python",
    spawns,
    children,
    spawn(spec) {
      const rec = { ...spec, resizes: [], writes: [] };
      spawns.push(rec);
      const child = spawn(spec.file, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ["pipe", "pipe", "pipe"] });
      children.push(child);
      const data = [];
      const exits = [];
      let exited;
      const emit = (c) => {
        for (const fn of data) fn(new Uint8Array(c));
      };
      child.stdout.on("data", emit);
      child.stderr.on("data", emit);
      child.stdin.on("error", () => {});
      child.on("error", () => {});
      child.on("exit", (code, signal) => {
        exited = { code: signal ? 128 + ({ SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 }[signal] ?? 0) : code, ...(signal ? { signal } : {}) };
        setTimeout(() => {
          for (const fn of exits) fn(exited);
        }, 20);
      });
      return {
        pid: child.pid,
        write(d) {
          rec.writes.push(typeof d === "string" ? d : Buffer.from(d).toString("utf8"));
          try {
            child.stdin.write(d);
          } catch {
            // Gone.
          }
        },
        resize(cols, rows) {
          rec.resizes.push([cols, rows]);
        },
        onData(fn) {
          data.push(fn);
          return { dispose: () => data.splice(data.indexOf(fn), 1) };
        },
        onExit(fn) {
          if (exited) setTimeout(() => fn(exited), 0);
          else exits.push(fn);
          return { dispose: () => exits.splice(exits.indexOf(fn), 1) };
        },
        kill(sig = "SIGHUP") {
          try {
            child.kill(sig);
          } catch {
            // Gone.
          }
        },
        endInput() {
          child.stdin.end();
        },
      };
    },
    killAll() {
      for (const c of children) {
        try {
          c.kill("SIGKILL");
        } catch {
          // Gone.
        }
      }
    },
  };
}

/** A PlacesContext with fakes for everything B owns. `env` is what providerEnv() returns. */
export function fakeContext({ home, userHome, env = {}, pty = null, keys = {}, workers = {} } = {}) {
  const logs = [];
  const watched = [];
  const emitted = [];
  return {
    logs,
    watched,
    emitted,
    home,
    userHome: userHome ?? home,
    version: "0.0.0-test",
    platform: process.platform,
    now: () => Date.now(),
    log: (m, level = "info") => logs.push({ m, level }),
    agentEnv: () => ({ PATH: process.env.PATH }),
    officeUrl: () => "http://127.0.0.1:1",
    office: {
      emit: (e) => emitted.push(e),
      expect: () => ({ dispose() {} }),
      hold() {},
      release() {},
      end() {},
      workersOn: (hostId) => workers[hostId] ?? 0,
      recentFolders: () => [],
    },
    keys: {
      list: () => Object.keys(keys).map((name) => ({ name, agents: [], preview: "•••", addedAt: "2026-10-18T00:00:00.000Z" })),
      put() {
        throw new Error("not in tests");
      },
      remove: () => false,
      importFromShell: async () => [],
      reveal: (names) => Object.fromEntries(names.map((n) => [n, keys[n]])),
      platformEnv: () => ({}),
      onChange: () => ({ dispose() {} }),
    },
    viewers: () => 1,
    providerEnv: () => ({ ...env }),
    pty: async () => pty,
    watch(target) {
      const rec = { target, disposed: false };
      watched.push(rec);
      return { dispose: () => void (rec.disposed = true) };
    },
  };
}

/** Collect everything a Term writes until it exits (or `ms`). */
export function collect(term) {
  const out = [];
  let exit;
  const done = new Promise((resolve) => {
    term.onExit((e) => {
      exit = e;
      resolve(e);
    });
  });
  term.onData((c) => out.push(Buffer.from(c)));
  return {
    text: () => Buffer.concat(out).toString("utf8"),
    exit: () => exit,
    done,
  };
}

/**
 * A fake agent: prints one JSON line (argv, cwd, the keys it got, what is left in the run folder),
 * then echoes each input line as "got:<line>"; "quit" exits 3, end of input exits 0.
 */
export const AGENT_SCRIPT = `
const fs = require("fs");
const run = process.env.HOME + "/.agent-visualizer/run";
const keys = {};
for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"]) if (process.env[k]) keys[k] = process.env[k];
process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), keys, prompt: process.env.AO_PROMPT ?? null, term: process.env.TERM ?? null, files: fs.existsSync(run) ? fs.readdirSync(run) : [] }) + "\\n");
let buf = "";
process.stdin.on("data", (d) => { buf += d; let n; while ((n = buf.search(/[\\r\\n]/)) >= 0) { const l = buf.slice(0, n); buf = buf.slice(n + 1); if (!l) continue; if (l === "quit") process.exit(3); process.stdout.write("got:" + l + "\\n"); } });
process.stdin.on("end", () => process.exit(0));
process.on("SIGHUP", () => process.exit(129));
process.on("SIGTERM", () => process.exit(143));
`;

/**
 * AGENT_SCRIPT for chat transports, which keep stderr apart: each input line also comes back as
 * "err:<line>" there, and "bye" prints "bye!" and exits 4 once that is written (a pipe's writes
 * are asynchronous on macOS: process.exit right after one can lose it).
 */
export const CHAT_SCRIPT = AGENT_SCRIPT.replace(`process.stdout.write("got:" + l + "\\n");`, `process.stdout.write("got:" + l + "\\n"); process.stderr.write("err:" + l + "\\n");`).replace(
  `if (l === "quit") process.exit(3);`,
  `if (l === "quit") process.exit(3); if (l === "bye") return void process.stdout.write("bye!\\n", () => process.exit(4));`,
);

/** Run `sh` as if it were a sandbox's login shell: input in, output out, under `home` with `bin` first on PATH. */
export function sandboxShell(home, bin, extraEnv = {}) {
  return spawn("sh", [], { cwd: home, env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, LC_ALL: "C", ...extraEnv }, stdio: ["pipe", "pipe", "pipe"] });
}
