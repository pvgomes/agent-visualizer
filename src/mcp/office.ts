/*
 * Finding the office from inside an MCP server. The office is whatever
 * `npx github:pvgomes/agent-visualizer` is serving on this machine: it leaves its port and a
 * random secret in $AGENT_VISUALIZER_HOME/office.json (0600, written on start,
 * see writeOfficeFile). An office only counts once it proves it knows that
 * secret: /healthz answers a fresh random challenge with an HMAC of it, so
 * some other program listening on a nearby port can't pose as the office and
 * feed agents a made-up briefing. AGENT_VISUALIZER_PORT overrides the port, never
 * the proof. Everything here has a hard deadline: the calling agent is
 * waiting on us.
 */
import { request } from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Snapshot } from "../shared/events.ts";
import { officeHome } from "./outbox.ts";

export const DEFAULT_OFFICE_PORT = 4747;

/** The record a running office leaves in $AGENT_VISUALIZER_HOME/office.json. */
export interface OfficeFile {
  pid: number;
  port: number;
  host: string;
  url: string;
  startedAt: string;
  version?: string;
  demo?: boolean;
  /** 32 random bytes, hex: the key /healthz proves itself with. */
  secret?: string;
  /** The background service's office (src/control/service.ts). */
  service?: boolean;
  /** Whether this office has the control plane (hire from the page); false: watch-only. */
  control?: boolean;
}

/** A new office secret. */
export function newOfficeSecret(): string {
  return randomBytes(32).toString("hex");
}

/** What /healthz?challenge=<c> answers with: HMAC-SHA256(secret, "agent-visualizer:" + c), hex. */
export function officeProof(secret: string, challenge: string): string {
  return createHmac("sha256", secret).update(`agent-visualizer:${challenge}`).digest("hex");
}

export function officeFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(officeHome(env), "office.json");
}

/** Called by the office after it starts listening, so agents can find a non-default port. */
export function writeOfficeFile(info: OfficeFile, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const file = officeFilePath(env);
    mkdirSync(officeHome(env), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(info, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    // Agents fall back to probing the default ports.
  }
}

/** Called on shutdown; only removes the file if it is still ours. */
export function clearOfficeFile(pid = process.pid, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const file = officeFilePath(env);
    const cur = JSON.parse(readFileSync(file, "utf8")) as Partial<OfficeFile>;
    if (cur.pid === pid) unlinkSync(file);
  } catch {
    // Already gone.
  }
}

function alive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface Got {
  status: number;
  body: string;
}

/** GET http://127.0.0.1:<port><path> with a deadline. Resolves null on any failure. */
export function getLocal(port: number, path: string, timeoutMs: number, host = "127.0.0.1"): Promise<Got | null> {
  return new Promise((done) => {
    let settled = false;
    const finish = (v: Got | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(v);
    };
    const req = request(
      { host, port, path, method: "GET", headers: { accept: "application/json" }, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > 8 << 20) req.destroy();
          else chunks.push(c);
        });
        res.on("end", () => finish({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", () => finish(null));
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      finish(null);
    }, timeoutMs);
    req.on("error", () => finish(null));
    req.end();
  });
}

/** Is the office that wrote `secret` the one answering on `port`? */
async function isOffice(port: number, secret: string, timeoutMs: number): Promise<boolean> {
  const challenge = randomBytes(16).toString("hex");
  const r = await getLocal(port, `/healthz?challenge=${challenge}`, timeoutMs);
  if (!r || r.status !== 200) return false;
  try {
    const j = JSON.parse(r.body);
    if (!j || j.ok !== true || typeof j.proof !== "string") return false;
    const want = Buffer.from(officeProof(secret, challenge), "hex");
    const got = Buffer.from(j.proof, "hex");
    return got.length === want.length && timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

function envPort(env: NodeJS.ProcessEnv): number | undefined {
  const v = env.AGENT_VISUALIZER_PORT?.trim();
  if (!v || !/^\d+$/.test(v)) return undefined;
  const n = Number(v);
  return n > 0 && n < 65536 ? n : undefined;
}

/** The port of a live office on this machine that knows this machine's office secret, or null. */
export async function findOffice(env: NodeJS.ProcessEnv = process.env, timeoutMs = 600): Promise<number | null> {
  let f: Partial<OfficeFile>;
  try {
    f = JSON.parse(readFileSync(officeFilePath(env), "utf8")) as Partial<OfficeFile>;
  } catch {
    return null; // no office has started here (or under this AGENT_VISUALIZER_HOME)
  }
  if (typeof f.secret !== "string" || !/^[0-9a-f]{32,128}$/.test(f.secret)) return null;
  const port = envPort(env) ?? (typeof f.port === "number" && alive(f.pid) ? f.port : undefined);
  if (!port) return null;
  return (await isOffice(port, f.secret, timeoutMs)) ? port : null;
}

export async function fetchSnapshot(port: number, timeoutMs = 1_200): Promise<Snapshot | null> {
  const r = await getLocal(port, "/api/snapshot", timeoutMs);
  if (!r || r.status !== 200) return null;
  try {
    const s = JSON.parse(r.body) as Snapshot;
    return s && Array.isArray(s.workers) ? s : null;
  } catch {
    return null;
  }
}
