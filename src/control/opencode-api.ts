/*
 * The slice of opencode's HTTP server the office drives, for both of its
 * modes: the TUI (`opencode --port`) and `opencode serve` (chat). Basic auth
 * with a random password the office set in OPENCODE_SERVER_PASSWORD, so no
 * other local program can drive the agent. The port is never shown to the
 * browser.
 */
import { createServer } from "node:net";

export interface OpencodeEvent {
  type: string;
  properties: any;
}

export interface OpencodeClient {
  readonly baseUrl: string;
  /** Resolves once the server answers (GET /session 200), rejects after timeoutMs. */
  ready(timeoutMs: number, signal?: AbortSignal): Promise<void>;
  sessions(): Promise<{ id: string; directory?: string; time?: { created?: number; updated?: number } }[]>;
  createSession(): Promise<string>;
  promptAsync(sessionId: string, text: string, agent?: string): Promise<void>;
  abort(sessionId: string): Promise<void>;
  /** "once" | "always" | "reject"; falls back to the v2 reply route on 404. */
  replyPermission(sessionId: string, permissionId: string, response: "once" | "always" | "reject"): Promise<void>;
  tuiAppend(text: string): Promise<void>;
  tuiSubmit(): Promise<void>;
  tuiClear(): Promise<void>;
  /** The event stream; reconnects until closed. */
  events(fn: (e: OpencodeEvent) => void): { close(): void };
}

export interface OpencodeClientOptions {
  port: number;
  password: string;
  directory: string;
  fetch?: typeof fetch;
  /** Base URL override (tests). */
  baseUrl?: string;
}

export class OpencodeError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** A free loopback port: listen on 0, read it, close. The race until the agent binds it is accepted. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

export function opencodeClient(o: OpencodeClientOptions): OpencodeClient {
  const f = o.fetch ?? fetch;
  const baseUrl = (o.baseUrl ?? `http://127.0.0.1:${o.port}`).replace(/\/+$/, "");
  const auth = `Basic ${Buffer.from(`opencode:${o.password}`).toString("base64")}`;
  const q = `directory=${encodeURIComponent(o.directory)}`;
  const url = (path: string) => `${baseUrl}${path}${path.includes("?") ? "&" : "?"}${q}`;

  async function call(method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<any> {
    const res = await f(url(path), {
      method,
      headers: { authorization: auth, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new OpencodeError(res.status, `opencode answered ${res.status} for ${method} ${path.split("?")[0]}`);
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  return {
    baseUrl,
    async ready(timeoutMs, signal) {
      const until = Date.now() + timeoutMs;
      let health = true;
      for (;;) {
        if (signal?.aborted) throw new Error("aborted");
        try {
          // Listening yet? Cheap, where the server has it (older ones answer 404).
          if (health) {
            try {
              await call("GET", "/global/health", undefined, 2_000);
            } catch (err) {
              if (err instanceof OpencodeError && err.status === 404) health = false;
              else throw err;
            }
          }
          // The folder's instance: the first call boots it (plugins, MCP servers, a large
          // database), which can take most of a minute, so it gets the time that's left.
          await call("GET", "/session", undefined, Math.max(2_000, until - Date.now()));
          return;
        } catch (err) {
          if (err instanceof OpencodeError && (err.status === 401 || err.status === 403)) throw err;
          if (Date.now() > until) throw new Error(`opencode's server didn't come up within ${Math.round(timeoutMs / 1000)}s`);
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    },
    async sessions() {
      const r = await call("GET", "/session");
      return Array.isArray(r) ? r : [];
    },
    async createSession() {
      const r = await call("POST", "/session", {});
      if (!r || typeof r.id !== "string") throw new Error("opencode created no session");
      return r.id;
    },
    async promptAsync(sessionId, text, agent) {
      await call("POST", `/session/${encodeURIComponent(sessionId)}/prompt_async`, { parts: [{ type: "text", text }], ...(agent ? { agent } : {}) });
    },
    async abort(sessionId) {
      await call("POST", `/session/${encodeURIComponent(sessionId)}/abort`, {});
    },
    async replyPermission(sessionId, permissionId, response) {
      try {
        await call("POST", `/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`, { response });
      } catch (err) {
        if (!(err instanceof OpencodeError) || err.status !== 404) throw err;
        await call("POST", `/permission/${encodeURIComponent(permissionId)}/reply`, { reply: response });
      }
    },
    async tuiAppend(text) {
      await call("POST", "/tui/append-prompt", { text });
    },
    async tuiSubmit() {
      await call("POST", "/tui/submit-prompt", {});
    },
    async tuiClear() {
      await call("POST", "/tui/clear-prompt", {});
    },
    events(fn) {
      let closed = false;
      let ctl: AbortController | undefined;
      const loop = async () => {
        while (!closed) {
          ctl = new AbortController();
          try {
            const res = await f(url("/event"), { headers: { authorization: auth, accept: "text/event-stream" }, signal: ctl.signal });
            if (!res.ok || !res.body) throw new Error(`event stream ${res.status}`);
            await readSse(res.body, (data) => {
              try {
                const e = JSON.parse(data);
                if (e && typeof e.type === "string") fn({ type: e.type, properties: e.properties ?? {} });
              } catch {
                // Not JSON: skip.
              }
            });
          } catch {
            // Dropped or refused: retry below.
          }
          if (!closed) await new Promise((r) => setTimeout(r, 500));
        }
      };
      void loop();
      return {
        close() {
          closed = true;
          ctl?.abort();
        },
      };
    },
  };
}

/** Feed each SSE `data:` payload (multi-line joined) to fn until the stream ends. */
export async function readSse(body: ReadableStream<Uint8Array>, fn: (data: string) => void): Promise<void> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let data: string[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (line === "") {
        if (data.length) fn(data.join("\n"));
        data = [];
      } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (buf.length > 8 << 20) throw new Error("event too large");
  }
}
