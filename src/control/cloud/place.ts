/*
 * What every remote place shares: the RemotePlace a driver (ssh, Daytona,
 * Vercel, Railway) builds on, a Term for transports that aren't a local
 * process (WebSockets), a PipeProc over a local child, and the record of
 * sandboxes the office created ($AGENT_VISUALIZER_HOME/sandboxes.json, 0600).
 *
 * A driver supplies run() (a long-running exec: installs, seeding, env
 * files), openTerm() and pipe() for chat mode. The base adds
 * the agent install, first-run seeding (office sandboxes only), the Codex
 * provider flags, and the PATH ensureAgent found, so every driver launches
 * the same way.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderStatus, SandboxInfo } from "../../shared/control.ts";
import type { AgentKind, Host, RemoteTarget } from "../../shared/events.ts";
import type { RailwayBudget } from "../../remote/railway.ts";
import { shQuote } from "../../remote/source.ts";
import { RemoteError, scrubMessage, type FetchFn } from "../../remote/util.ts";
import {
  ControlError, FILES, NESTED_ENV, PLATFORM_KEY_NAMES,
  type Disposable, type Launch, type OpenOptions, type PipeProc, type PlacesContext, type RemotePlace, type Term, type TermExit,
} from "../types.ts";
import type { TarEntry } from "../tar.ts";
import type { SetupApplied, SetupBundle } from "../types.ts";
import { adjustLaunch, firstRunScript, geminiScript } from "./firstrun.ts";
import { ensureAgent, type Ensured } from "./install.ts";
import { bringSetup } from "./setup.ts";

export const NOOP: Disposable = { dispose() {} };

export class Listeners<T> {
  private fns = new Set<(v: T) => void>();
  on(fn: (v: T) => void): Disposable {
    this.fns.add(fn);
    return { dispose: () => void this.fns.delete(fn) };
  }
  emit(v: T): void {
    for (const fn of [...this.fns]) {
      try {
        fn(v);
      } catch {
        // A listener's bug stays its own.
      }
    }
  }
}

/**
 * Listeners that keep what is emitted before the first one comes and hand it to that one (in a
 * microtask, as Once does): a pipe whose output can arrive before its caller has subscribed.
 */
export class Held<T> {
  private fns = new Listeners<T>();
  private kept: T[] | undefined = [];
  on(fn: (v: T) => void): Disposable {
    const d = this.fns.on(fn);
    const kept = this.kept;
    this.kept = undefined;
    if (kept?.length)
      queueMicrotask(() => {
        for (const v of kept) fn(v);
      });
    return d;
  }
  emit(v: T): void {
    if (!this.kept) return this.fns.emit(v);
    if (this.kept.length < 4096) this.kept.push(v);
  }
}

/** One-shot: a listener that comes late still hears it. */
export class Once<T> {
  private v: { v: T } | undefined;
  private fns = new Listeners<T>();
  on(fn: (v: T) => void): Disposable {
    if (this.v) {
      const { v } = this.v;
      let live = true;
      queueMicrotask(() => live && fn(v));
      return { dispose: () => void (live = false) };
    }
    return this.fns.on(fn);
  }
  fire(v: T): boolean {
    if (this.v) return false;
    this.v = { v };
    this.fns.emit(v);
    return true;
  }
  get fired(): boolean {
    return this.v !== undefined;
  }
}

export function sid(): string {
  return randomBytes(6).toString("hex");
}

export function clampSize(cols: number, rows: number): { cols: number; rows: number } {
  const c = Number.isFinite(cols) ? Math.round(cols) : 120;
  const r = Number.isFinite(rows) ? Math.round(rows) : 32;
  return { cols: Math.min(500, Math.max(10, c)), rows: Math.min(200, Math.max(4, r)) };
}

/** A RemoteError or anything else, as the ControlError the router shows (502: a platform failed). */
export function asControlError(err: unknown, prefix = ""): ControlError {
  if (err instanceof ControlError) return err;
  const msg = scrubMessage((err as Error)?.message ?? String(err));
  return new ControlError(502, (prefix ? `${prefix}: ` : "") + msg);
}

/** Environment for a local helper process (ssh, a platform CLI): no nested-agent markers; platform tokens only when asked. */
export function helperEnv(base: NodeJS.ProcessEnv, keepPlatform: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || NESTED_ENV.includes(k)) continue;
    if (!keepPlatform && PLATFORM_KEY_NAMES.includes(k)) continue;
    out[k] = v;
  }
  out.TERM = "xterm-256color";
  return out;
}

/* ----------------------------------------------------------------- terms */

/** A Term whose bytes come from somewhere other than a local process. */
export class StreamTerm implements Term {
  readonly pid?: number;
  private readonly data = new Listeners<Uint8Array>();
  private readonly exit = new Once<TermExit>();

  constructor(private readonly impl: { write(d: Uint8Array): void; resize(cols: number, rows: number): void; kill(signal?: NodeJS.Signals): void }) {}

  write(d: string | Uint8Array): void {
    if (this.exit.fired) return;
    this.impl.write(typeof d === "string" ? Buffer.from(d, "utf8") : d);
  }
  resize(cols: number, rows: number): void {
    if (this.exit.fired) return;
    const s = clampSize(cols, rows);
    this.impl.resize(s.cols, s.rows);
  }
  kill(signal?: NodeJS.Signals): void {
    if (this.exit.fired) return;
    this.impl.kill(signal);
  }
  onData(fn: (c: Uint8Array) => void): Disposable {
    return this.data.on(fn);
  }
  onExit(fn: (e: TermExit) => void): Disposable {
    return this.exit.on(fn);
  }
  /* for the driver */
  push(c: Uint8Array): void {
    if (!this.exit.fired && c.byteLength) this.data.emit(c);
  }
  end(e: TermExit): boolean {
    return this.exit.fire(e);
  }
  get ended(): boolean {
    return this.exit.fired;
  }
}

/** Run something when a Term exits (cleanup on the remote), keeping the Term as is. */
export function afterExit(term: Term, fn: (e: TermExit) => void): Term {
  term.onExit((e) => {
    try {
      fn(e);
    } catch {
      // Best effort.
    }
  });
  return term;
}

/* ----------------------------------------------------------------- pipes */

const SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };

/** A PipeProc over a local child (ssh -T, a platform CLI). */
export function childPipe(child: ChildProcess): PipeProc {
  const out = new Listeners<Uint8Array>();
  const err = new Listeners<Uint8Array>();
  const exit = new Once<TermExit>();
  child.stdout?.on("data", (c: Buffer) => out.emit(new Uint8Array(c)));
  child.stderr?.on("data", (c: Buffer) => err.emit(new Uint8Array(c)));
  child.stdin?.on("error", () => {});
  child.on("error", () => exit.fire({ code: null }));
  child.on("exit", (code, signal) => {
    exit.fire(signal ? { code: 128 + (SIGNALS[signal] ?? 0), signal } : { code });
  });
  return {
    pid: child.pid,
    write(d) {
      if (!exit.fired) child.stdin?.write(d);
    },
    end() {
      child.stdin?.end();
    },
    onStdout: (fn) => out.on(fn),
    onStderr: (fn) => err.on(fn),
    onExit: (fn) => exit.on(fn),
    kill(signal = "SIGTERM") {
      try {
        child.kill(signal);
      } catch {
        // Gone.
      }
    },
  };
}

export function spawnPipe(file: string, args: string[], env: Record<string, string>, cwd: string): PipeProc {
  let child: ChildProcess;
  try {
    child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"], env, cwd, windowsHide: true });
  } catch {
    throw new ControlError(500, `Could not start ${file.split("/").pop()}`);
  }
  return childPipe(child);
}

/* ----------------------------------------------------------------- place */

export interface PlaceInit {
  host: Host;
  cwd: string;
  ours: boolean;
  target: RemoteTarget;
  agent: AgentKind;
  /** "Daytona agent-visualizer-1a2b3c", for messages. */
  where: string;
  log(msg: string, level?: "info" | "warn"): void;
}

export abstract class BasePlace implements RemotePlace {
  readonly host: Host;
  readonly cwd: string;
  readonly ours: boolean;
  readonly target: RemoteTarget;
  readonly agent: AgentKind;
  readonly where: string;
  protected readonly log: PlaceInit["log"];
  /** Where ensureAgent found the agent: PATH entries for the launch. */
  protected path?: string[];
  private seedGemini = false;
  private readonly closers: (() => void)[] = [];
  private closed = false;
  /** Set by createPlaces on a sandbox it just created: delete it again (RemotePlace.discard). */
  discard?: () => Promise<boolean>;

  constructor(i: PlaceInit) {
    this.host = i.host;
    this.cwd = i.cwd;
    this.ours = i.ours;
    this.target = i.target;
    this.agent = i.agent;
    this.where = i.where;
    this.log = i.log;
  }

  /** A script with a deadline; stderr folded into the output where the transport allows. */
  abstract run(script: string, o: { timeoutMs: number }): Promise<string>;
  /**
   * A script whose environment carries `env` (secret values, for "Bring my
   * setup"): the platform's per-command environment, or ssh's stdin. Never a
   * command line, never a log.
   */
  protected abstract runSecret(script: string, env: Record<string, string>, o: { timeoutMs: number }): Promise<string>;
  /** Extract these entries into `dir` there (absolute, already made): the platform's file upload, or tar on the exec channel. */
  protected abstract upload(entries: TarEntry[], dir: string, o: { home: string; timeoutMs: number }): Promise<void>;
  protected abstract openTerm(launch: Launch, size: { cols: number; rows: number }, sid: string, path: string[] | undefined): Promise<Term>;

  async ensureAgent(agent: AgentKind, progress: OpenOptions["progress"]): Promise<Ensured> {
    const r = await ensureAgent(agent, (s, o) => this.run(s, o), progress, this.where);
    this.path = r.path;
    return r;
  }

  async firstRun(agent: AgentKind, cwd: string): Promise<void> {
    if (!this.ours) return;
    if (agent === "gemini") this.seedGemini = true;
    const script = firstRunScript(agent, cwd);
    if (!script) return;
    try {
      await this.run(script, { timeoutMs: 30_000 });
    } catch (err) {
      // The user clicks through what wasn't pre-answered.
      this.log(`${this.where}: first-run setup for ${agent} skipped (${scrubMessage((err as Error).message)})`, "warn");
    }
  }

  async bring(bundle: SetupBundle, secrets: Record<string, string>, progress: (detail: string) => void): Promise<SetupApplied> {
    if (this.closed) throw new ControlError(409, `${this.where} is closed`);
    try {
      return await bringSetup(
        {
          where: this.where,
          ours: this.ours,
          cwd: this.cwd,
          run: (s, o) => this.run(s, o),
          runSecret: (s, env, o) => this.runSecret(s, env, o),
          upload: (entries, dir, o) => this.upload(entries, dir, o),
        },
        bundle,
        secrets,
        progress,
      );
    } catch (err) {
      throw asControlError(err, `${this.where}: copying your setup`);
    }
  }

  /** The Launch as this place runs it. */
  protected prepare(launch: Launch): Launch {
    return adjustLaunch(this.agent, launch);
  }

  async attach(launch: Launch, size: { cols: number; rows: number }): Promise<Term> {
    if (this.closed) throw new ControlError(409, `${this.where} is closed`);
    const l = this.prepare(launch);
    if (this.seedGemini && "GEMINI_API_KEY" in l.env) {
      this.seedGemini = false;
      await this.run(geminiScript(), { timeoutMs: 30_000 }).catch(() => {});
    }
    try {
      return await this.openTerm(l, clampSize(size.cols, size.rows), sid(), l.path?.length ? l.path : this.path);
    } catch (err) {
      throw asControlError(err, this.where);
    }
  }

  keepAlive(): Disposable {
    return NOOP;
  }

  /** Run on close (watch release, heartbeats). */
  onClose(fn: () => void): void {
    if (this.closed) fn();
    else this.closers.push(fn);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const fn of this.closers.splice(0)) {
      try {
        fn();
      } catch {
        // Best effort.
      }
    }
  }
}

/** `tar xzf -` into `dir`, for transports that stream an archive on stdin (Railway's bridge, ssh). */
export function untarScript(dir: string): string {
  return `umask 077; mkdir -p ${shQuote(dir)} && tar xzf - -C ${shQuote(dir)}`;
}

/** A remote command failed: the error with its last line of output, which is never a secret (scrubbed anyway). */
export function failed(where: string, code: number | string, out: string): RemoteError {
  const last = out.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  return new RemoteError("failed", `${where}: exit ${code}${last ? `: ${last.slice(0, 160)}` : ""}`);
}

/* -------------------------------------------------------------- registry */

export type CloudKind = "daytona" | "vercel" | "railway";

export interface OurSandbox {
  provider: CloudKind;
  id: string;
  name: string;
  createdAt: string;
  environmentId?: string;
  projectId?: string;
  teamId?: string;
}

/** sandboxes.json: every sandbox the office created, labels or not (Railway has none). */
export class Registry {
  private readonly file: string;
  constructor(private readonly home: string) {
    this.file = join(home, FILES.sandboxes);
  }

  list(provider?: CloudKind): OurSandbox[] {
    let j: any;
    try {
      j = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      return [];
    }
    const rows: any[] = Array.isArray(j?.sandboxes) ? j.sandboxes : [];
    return rows.filter((r) => r && typeof r.id === "string" && typeof r.provider === "string" && (!provider || r.provider === provider));
  }

  get(provider: CloudKind, id: string): OurSandbox | undefined {
    return this.list(provider).find((r) => r.id === id);
  }

  add(r: OurSandbox): void {
    this.write([...this.list().filter((x) => !(x.provider === r.provider && x.id === r.id)), r]);
  }

  remove(provider: CloudKind, id: string): void {
    const all = this.list();
    const kept = all.filter((x) => !(x.provider === provider && x.id === id));
    if (kept.length !== all.length) this.write(kept);
  }

  private write(rows: OurSandbox[]): void {
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ v: 1, sandboxes: rows }, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

/* ---------------------------------------------------------------- clouds */

export interface CloudDeps {
  ctx: PlacesContext;
  registry: Registry;
  fetch?: FetchFn;
  /** How often to look while a new sandbox starts (default 2 s). */
  pollMs?: number;
  /** Platform CLIs for the fallbacks (tests point these at fakes). */
  bins?: { daytona?: string; railway?: string; npx?: string };
  /** The one Railway API budget the watcher spends from too. */
  railwayBudget?: RailwayBudget;
}

export interface CreateOptions {
  name: string;
  timeoutMin: number;
  cwd?: string;
  /** Railway: the project (id or name) and environment the hire picked. */
  project?: string;
  environment?: string;
  /** Called the moment the platform has the sandbox (recorded in sandboxes.json), before it is up. */
  onCreated?(id: string): void;
}

/** One sandbox platform: its status row, and create / open / delete. */
export interface Cloud {
  readonly kind: CloudKind;
  readonly name: string;
  /** Offline: is there a login to try? */
  login(): { ready: boolean; via?: string; why?: string };
  status(): Promise<ProviderStatus>;
  create(c: CreateOptions, o: OpenOptions): Promise<BasePlace>;
  open(id: string, cwd: string | undefined, o: OpenOptions): Promise<BasePlace>;
  remove(id: string): Promise<void>;
}

export function sandboxRow(ctx: PlacesContext, provider: CloudKind, r: Omit<SandboxInfo, "provider" | "workers">, hostId: string): SandboxInfo {
  return { ...r, provider, workers: ctx.office.workersOn(hostId) };
}

/* --------------------------------------------------------------- helpers */

/** "agent-visualizer-<slug>" from what the user typed, else "agent-visualizer-<6 hex>". */
export function sandboxName(asked?: string): string {
  const slug = (asked ?? "").toLowerCase().replace(/^agent-visualizer-/, "").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `agent-visualizer-${slug || randomBytes(3).toString("hex")}`;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ControlError(409, "Cancelled"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new ControlError(409, "Cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
