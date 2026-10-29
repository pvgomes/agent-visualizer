/*
 * herdr's local socket API (https://herdr.dev/docs/socket-api/): newline-delimited JSON over a
 * Unix socket, {id, method, params} in, {id, result} or {id, error} back. One connection per
 * request: the office asks for a snapshot every second or two and starts the odd agent, so there
 * is no stream worth keeping open.
 */
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export class HerdrError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

export type HerdrRequest = (method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<any>;

/** $HERDR_SOCKET_PATH (set inside herdr panes and plugins), else herdr's default under the config dir. */
export function herdrSocketPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (env.HERDR_SOCKET_PATH) return env.HERDR_SOCKET_PATH;
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "herdr", "herdr.sock");
}

/** A request function bound to one socket path. Rejects with HerdrError on herdr's own errors. */
export function herdrClient(path = herdrSocketPath()): HerdrRequest {
  let seq = 0;
  return (method, params = {}, timeoutMs = 3_000) =>
    new Promise((resolve, reject) => {
      const sock = createConnection(path);
      let buf = "";
      let settled = false;
      const done = (err: Error | null, v?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.destroy();
        if (err) reject(err);
        else resolve(v);
      };
      const timer = setTimeout(() => done(new HerdrError("herdr didn't answer in time", "timeout")), timeoutMs);
      sock.setEncoding("utf8");
      sock.on("connect", () => sock.write(JSON.stringify({ id: `av_${++seq}`, method, params }) + "\n"));
      sock.on("data", (d: string) => {
        buf += d;
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        let m: { result?: unknown; error?: { code?: string; message?: string } };
        try {
          m = JSON.parse(buf.slice(0, nl));
        } catch {
          return done(new HerdrError("herdr sent something that isn't JSON"));
        }
        if (m.error) done(new HerdrError(m.error.message || "herdr refused", m.error.code));
        else done(null, m.result);
      });
      sock.on("error", (err) => done(err));
      sock.on("close", () => done(new HerdrError("herdr closed the connection")));
    });
}
