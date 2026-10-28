/*
 * Remote hosts in the office: ssh boxes from flags and config, plus Daytona,
 * boat, Railway and Vercel sandboxes discovered on their platforms (auto-
 * detected when a login or CLI is around). Every host gets its own ingest
 * watcher over its RemoteTarget, so remote workers come through the same
 * parsers as local ones. Discovery reruns every 30s: a sandbox that starts
 * walks its workers in, one that stops sends them home (session_end).
 *
 * Each target is wrapped in a health gate. Failures back off (2s doubling to
 * 60s, no exec at all inside the window), two in a row mark the host
 * offline, and the office hears it as an "error / remote offline" event on
 * each of that host's workers, which dims its pod; the next good answer
 * brings it back. One broken remote never touches the others or this
 * machine.
 *
 * Cost safety: on Daytona and Railway an exec counts as activity, so polling
 * a sandbox nobody uses would keep it from idling out. When such a sandbox
 * (with an idle timeout) has sent nothing for a while, the gate goes
 * "dormant": the watcher's polls are refused locally, and the office only
 * peeks for fresh transcript files once per idle-timeout-plus-5-minutes,
 * which leaves room for the sandbox to stop. A newer lastActivityAt from
 * Daytona's API, or a fresh file on a peek, wakes it straight away, and the
 * watcher picks up where it left off.
 */
import type { AgentKind, Host, HostKind, HostStatus, RawEvent, RemoteTarget } from "../shared/events.ts";
import { GONE_MS } from "../shared/events.ts";
import { createIngest } from "../ingest/index.ts";
import { agentRoots, outboxDir } from "../ingest/discover.ts";
import type { ListRequest } from "../ingest/source.ts";
import { createBoatProvider, createBoatTargets } from "./boat.ts";
import type { RemoteSelector } from "./config.ts";
import { createDaytonaProvider, createDaytonaTargets } from "./daytona.ts";
import { createRailwayProvider, createRailwayTargets, type RailwayBudget } from "./railway.ts";
import { createRemoteSource, type TunedTarget } from "./source.ts";
import { createSshTarget } from "./ssh.ts";
import { RemoteError, pick, type CloudKind, type Discovered, type Provider, type ProviderOptions, type RemoteKind } from "./util.ts";
import { createVercelProvider, createVercelTargets } from "./vercel.ts";

export { readRemoteConfig, mergeSelectors, parseRemoteEntry, REMOTE_KINDS, type RemoteSelector } from "./config.ts";
export { createSshTarget } from "./ssh.ts";
export type { Provider, Discovered } from "./util.ts";

export const DISCOVER_MS = 30_000;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;
const READY_WAIT_MS = 3_000;
const READY_MAX_MS = 5_000;
const CLOUD: CloudKind[] = ["daytona", "boat", "railway", "vercel"];

export const LABEL: Record<HostKind, string> = {
  local: "this machine",
  ssh: "ssh",
  daytona: "Daytona",
  boat: "boat",
  railway: "Railway",
  vercel: "Vercel",
};

export type Watch = (
  target: RemoteTarget,
  agents: AgentKind[],
  onEvent: (e: RawEvent) => void,
  log: (msg: string) => void,
  opts?: { pollMs?: number },
) => { stop(): void };

/** The real thing: one ingest loop for one host. */
export const ingestWatch: Watch = (target, agents, onEvent, log, opts) => {
  const ing = createIngest({ agents, remotes: [target], local: false, onEvent, log, watch: false, remotePollMs: opts?.pollMs });
  ing.start();
  return { stop: () => ing.stop() };
};

export interface StartRemotesOptions {
  agents: AgentKind[];
  /** From flags and config.json. Cloud kinds listed here are not auto-detected. */
  selectors?: RemoteSelector[];
  /** Watch every platform that has a login (default true). */
  autoDetect?: boolean;
  onEvent: (e: RawEvent) => void;
  /** One-line notices for the terminal. */
  log?: (msg: string, level: "info" | "warn") => void;
  /** Ingest chatter, for --verbose. */
  debug?: (msg: string) => void;
  env?: NodeJS.ProcessEnv;
  /** Shared with the control plane's Railway calls (createPlaces' railwayBudget). */
  railwayBudget?: RailwayBudget;
  /**
   * Is this worker still in the office? The manager's own notes about a host
   * (offline, back, stopped) go only to those; a worker the office already
   * sent home (its hired agent ended) is forgotten instead of walked back in.
   */
  inOffice?: (workerId: string) => boolean;
  /* tests */
  providers?: Provider[];
  sshTarget?: (sel: RemoteSelector) => RemoteTarget;
  watch?: Watch;
  discoverMs?: number;
  /** How long ready waits for every host's first answer (default 3s). */
  readyWaitMs?: number;
  now?: () => number;
  /** false: no timers; drive it with tick(). */
  timers?: boolean;
}

export interface Remotes {
  /** The first discovery round is done and every host answered once (at most ~5s). */
  ready: Promise<void>;
  hosts(): HostStatus[];
  /** For the banner: "2 Daytona", "ssh shubham"; and what went wrong, one line each. */
  summary(): { watching: string[]; problems: string[] };
  /** One discovery and housekeeping round now (tests; also run every DISCOVER_MS). */
  tick(): Promise<void>;
  /**
   * Follow this host's transcripts even outside auto-detect's scope (the control plane started
   * an agent there). Ref-counted; discovery never drops a held host, and one this added is
   * removed (its workers sent home) when the last hold is disposed.
   */
  watch(target: RemoteTarget): { dispose(): void };
  stop(): void;
}

interface Seen {
  agent: AgentKind;
  workerId: string;
  project: string;
  cwd?: string;
  model?: string;
  at: number;
}

interface Rec {
  host: Host;
  raw: RemoteTarget;
  provider?: Provider;
  /** watch() holds on it. */
  pins: number;
  /** Added by watch(), not by a flag or discovery: removed with its last hold. */
  adopted?: boolean;
  gated: RemoteTarget;
  watcher?: { stop(): void };
  status: HostStatus["status"];
  error?: string;
  failures: number;
  blockedUntil: number;
  lastErr?: Error;
  everOk: boolean;
  lastEventAt: number;
  workers: Map<string, Seen>;
  idleStopMin?: number;
  activityAt?: number;
  /** Dormant: Daytona activity baseline, and when to peek next. */
  baseline?: number;
  settleRounds?: number;
  nextPeekAt?: number;
  peeking?: boolean;
  source?: ReturnType<typeof createRemoteSource>;
  answered: Promise<void>;
  markAnswered: () => void;
}

export function startRemotes(o: StartRemotesOptions): Remotes {
  return new Manager(o);
}

class Manager implements Remotes {
  readonly ready: Promise<void>;
  private readonly recs = new Map<string, Rec>();
  private readonly providers: { p: Provider; sels: string[]; explicit: boolean; listedAt?: number }[] = [];
  private readonly problems = new Map<string, string>();
  private readonly now: () => number;
  private readonly log: (msg: string, level: "info" | "warn") => void;
  private readonly startWatch: Watch;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private round?: Promise<void>;
  /** Notices before the banner would land above it; the banner lists them instead. */
  private announced = false;

  constructor(private readonly o: StartRemotesOptions) {
    this.now = o.now ?? Date.now;
    this.log = o.log ?? (() => {});
    this.startWatch = o.watch ?? ingestWatch;
    const sels = o.selectors ?? [];
    const env = o.env ?? process.env;

    for (const s of sels.filter((s) => s.kind === "ssh")) {
      try {
        const t = o.sshTarget ? o.sshTarget(s) : createSshTarget(s.id, { env: s.env, processEnv: env });
        if (!this.recs.has(t.host.id)) this.add(t);
      } catch (err) {
        this.problem(`ssh:${s.id}`, `ssh ${s.id}: ${(err as Error).message}`);
      }
    }

    const builtIn = o.providers ?? defaultProviders({ env, railwayBudget: o.railwayBudget });
    for (const p of builtIn) {
      const mine = sels.filter((s) => s.kind === p.kind).map((s) => s.id);
      if (mine.length) {
        this.providers.push({ p, sels: mine.includes("all") ? ["all"] : mine, explicit: true });
        continue;
      }
      if (o.autoDetect === false || p.autoDetect === false) continue;
      const a = p.available();
      if (a.ok) this.providers.push({ p, sels: ["all"], explicit: false });
    }

    // Never hold the banner for long: a platform that hangs shows up later, with a log line.
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());
    this.ready = Promise.race([
      (async () => {
        await this.tick();
        await Promise.race([Promise.all([...this.recs.values()].map((r) => r.answered)), sleep(o.readyWaitMs ?? READY_WAIT_MS)]);
      })(),
      sleep(READY_MAX_MS),
    ])
      .catch(() => {})
      .finally(() => (this.announced = true));

    if (o.timers !== false && this.providers.length) {
      this.timer = setInterval(() => void this.tick(), o.discoverMs ?? DISCOVER_MS);
      this.timer.unref?.();
    }
  }

  /* ---------------------------------------------------------- discovery */

  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.round ??= (async () => {
      try {
        const now = this.now();
        // Each platform at its own pace (Railway's API quota is tight); the first round lists them all.
        const due = this.providers.filter((x) => x.listedAt === undefined || now - x.listedAt >= (x.p.discoverMs ?? 0) - 1_000);
        for (const x of due) x.listedAt = now;
        await Promise.all(due.map((x) => this.discover(x)));
        await this.housekeep();
      } finally {
        this.round = undefined;
      }
    })();
    return this.round;
  }

  private async discover(x: { p: Provider; sels: string[]; explicit: boolean; listedAt?: number }): Promise<void> {
    const { p } = x;
    let found: Discovered[];
    try {
      // Auto-detection stays inside the user's own scope; a flag can widen it.
      found = await p.list(x.explicit ? "all" : "auto");
      this.problems.delete(p.kind);
    } catch (err) {
      const msg = (err as Error).message;
      // An auto-detected platform that simply has nothing set up stays quiet, and so does a paused budget.
      if ((err as RemoteError).code === "throttled") return;
      if ((err as RemoteError).code === "missing" && !x.explicit) return;
      this.problem(p.kind, msg);
      return; // keep what we have: a failed listing is not a stopped sandbox
    }
    if (this.stopped) return;
    const wanted = new Map<string, Discovered>();
    for (const sel of x.sels) {
      const hit = pick(found, sel, (d) => [d.host.id.slice(d.host.id.indexOf(":") + 1), d.host.name]);
      if (!hit.length && sel !== "all") this.problem(`${p.kind}:${sel}`, `${p.label} "${sel}": not found, or not running`);
      else this.problems.delete(`${p.kind}:${sel}`);
      for (const d of hit) wanted.set(d.host.id, d);
    }
    for (const d of wanted.values()) {
      let rec = this.recs.get(d.host.id);
      if (!rec) {
        rec = this.add(d.target, p, d.pollMs);
        if (this.announced) this.log(`${p.label} ${d.host.name} is up: watching it`, "info");
      } else if (rec.adopted) {
        // Discovery sees it too now: it stays after the control plane lets go.
        rec.provider = p;
        rec.adopted = false;
      }
      rec.idleStopMin = d.idleStopMin;
      rec.activityAt = d.activityAt;
    }
    for (const rec of [...this.recs.values()]) {
      if (rec.provider !== p || wanted.has(rec.host.id) || rec.pins > 0) continue;
      this.log(`${p.label} ${rec.host.name} stopped${rec.workers.size ? "; its workers went home" : ""}`, "info");
      this.remove(rec, "session_end");
    }
  }

  private add(raw: RemoteTarget, provider?: Provider, pollMs?: number): Rec {
    let markAnswered!: () => void;
    const answered = new Promise<void>((r) => (markAnswered = r));
    const rec: Rec = {
      host: raw.host,
      raw,
      provider,
      pins: 0,
      gated: undefined as unknown as RemoteTarget,
      status: "connecting",
      failures: 0,
      blockedUntil: 0,
      everOk: false,
      lastEventAt: this.now(),
      workers: new Map(),
      answered,
      markAnswered,
    };
    rec.gated = {
      host: raw.host,
      exec: (script, eo) => this.exec(rec, script, eo),
      close() {}, // the manager owns the real target's lifetime
      ...((raw as TunedTarget).readLimits ? { readLimits: (raw as TunedTarget).readLimits } : {}),
    } as TunedTarget;
    this.recs.set(rec.host.id, rec);
    rec.watcher = this.startWatch(rec.gated, this.o.agents, (e) => this.onEvent(rec, e), this.o.debug ?? (() => {}), { pollMs });
    return rec;
  }

  private remove(rec: Rec, ending: "session_end" | null): void {
    this.recs.delete(rec.host.id);
    try {
      rec.watcher?.stop();
    } catch {
      // Already stopped.
    }
    try {
      rec.raw.close?.();
    } catch {
      // Best effort.
    }
    if (ending) for (const w of rec.workers.values()) this.notify(rec, w, { kind: "session_end" });
    rec.workers.clear();
    rec.markAnswered();
  }

  /* --------------------------------------------------------------- health */

  private async exec(rec: Rec, script: string, eo?: { timeoutMs?: number }): Promise<string> {
    if (this.stopped || !this.recs.has(rec.host.id)) throw new RemoteError("gone", `${rec.host.name}: no longer watched`);
    if (rec.status === "dormant") throw new RemoteError("timeout", `${rec.host.name}: resting (quiet sandbox, polled rarely so it can idle out)`);
    if (this.now() < rec.blockedUntil && rec.lastErr) throw rec.lastErr;
    try {
      const out = await rec.raw.exec(script, eo);
      this.ok(rec);
      return out;
    } catch (err) {
      // Our own rate budget saying "later" says nothing about the sandbox: the watcher just backs off.
      if ((err as RemoteError).code !== "throttled") this.fail(rec, err as Error);
      throw err;
    }
  }

  private ok(rec: Rec): void {
    const was = rec.status;
    rec.failures = 0;
    rec.blockedUntil = 0;
    rec.lastErr = undefined;
    rec.everOk = true;
    rec.error = undefined;
    if (was === "dormant") return;
    rec.status = "online";
    this.problems.delete(rec.host.id);
    if (was === "offline") {
      this.log(`${LABEL[rec.host.kind]} ${rec.host.name} is back`, "info");
      // Quiet workers would keep their "offline" look until their next line; an idle pose lifts it.
      for (const w of rec.workers.values()) this.notify(rec, w, { kind: "idle" });
    }
    rec.markAnswered();
  }

  private fail(rec: Rec, err: Error): void {
    if (!this.recs.has(rec.host.id)) return;
    rec.failures++;
    rec.lastErr = err;
    rec.blockedUntil = this.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (rec.failures - 1));
    rec.error = shortReason(err);
    if (rec.status === "offline" || rec.status === "dormant") return;
    if (rec.failures < 2 && rec.everOk) return;
    rec.status = "offline";
    this.problems.set(rec.host.id, `${LABEL[rec.host.kind]} ${rec.host.name}: ${rec.error}`);
    if (this.announced) this.log(`${LABEL[rec.host.kind]} ${rec.host.name} is offline: ${rec.error}`, "warn");
    for (const w of rec.workers.values()) this.notify(rec, w, { kind: "error", summary: "remote offline", isError: true });
    rec.markAnswered();
  }

  /* ------------------------------------------------------------ dormancy */

  private async housekeep(): Promise<void> {
    const now = this.now();
    for (const rec of this.recs.values()) {
      for (const [id, w] of rec.workers) if (now - w.at > GONE_MS + 60_000) rec.workers.delete(id);
      const idle = rec.idleStopMin;
      // A host the control plane holds has a live session (and its own heartbeats): never dormant.
      if (!rec.provider?.keepsAwake || !idle || idle <= 0 || rec.pins > 0) {
        if (rec.status === "dormant") this.wake(rec, "");
        continue;
      }
      const interval = (idle + 5) * 60_000;
      if (rec.status !== "dormant") {
        const after = Math.min(20 * 60_000, Math.max(5 * 60_000, (idle - 5) * 60_000));
        if (rec.status === "online" && now - rec.lastEventAt >= after) {
          rec.status = "dormant";
          rec.baseline = rec.activityAt;
          rec.settleRounds = 1;
          rec.nextPeekAt = now + interval;
          this.log(`${LABEL[rec.host.kind]} ${rec.host.name} is quiet: checking it every ${idle + 5} min so it can idle out`, "info");
        }
        continue;
      }
      // Our own last polls may still land in lastActivityAt one round late.
      if (rec.settleRounds && rec.settleRounds > 0) {
        rec.settleRounds--;
        rec.baseline = Math.max(rec.baseline ?? 0, rec.activityAt ?? 0) || undefined;
      } else if (rec.activityAt && rec.activityAt > (rec.baseline ?? 0)) {
        this.wake(rec, "activity");
        continue;
      }
      if (!rec.peeking && now >= (rec.nextPeekAt ?? 0)) {
        rec.peeking = true;
        try {
          if (await this.peek(rec, interval + 60_000)) this.wake(rec, "new transcripts");
          else rec.nextPeekAt = this.now() + interval;
        } catch {
          rec.nextPeekAt = this.now() + interval;
        } finally {
          rec.peeking = false;
        }
      }
    }
  }

  /** Any agent transcript (or MCP signal) written within `withinMs`? One exec. */
  private async peek(rec: Rec, withinMs: number): Promise<boolean> {
    rec.source ??= createRemoteSource(rec.raw);
    const env = await rec.source.env();
    const reqs: ListRequest[] = [];
    const suffixes = [".jsonl", ".json", ".db", ".db-wal"];
    for (const agent of this.o.agents) {
      for (const root of agentRoots(agent, env, false)) {
        if (root.endsWith(".db")) reqs.push({ root: root.slice(0, root.lastIndexOf("/")) || "/", depth: 0, suffixes, newerThanMs: withinMs });
        else reqs.push({ root, depth: 6, suffixes, newerThanMs: withinMs });
      }
    }
    reqs.push({ root: outboxDir(env), depth: 0, suffixes: [".jsonl"], newerThanMs: withinMs });
    const lists = await rec.source.list(reqs);
    return lists.some((l) => l.length > 0);
  }

  private wake(rec: Rec, why: string): void {
    rec.status = rec.everOk ? "online" : "connecting";
    rec.lastEventAt = this.now();
    rec.failures = 0;
    rec.blockedUntil = 0;
    rec.baseline = rec.settleRounds = rec.nextPeekAt = undefined;
    if (why) this.log(`${LABEL[rec.host.kind]} ${rec.host.name} woke up (${why})`, "info");
  }

  /* --------------------------------------------------------------- events */

  private onEvent(rec: Rec, e: RawEvent): void {
    if (this.stopped || !this.recs.has(rec.host.id)) return;
    rec.lastEventAt = this.now();
    if (!e.parentId) {
      if (e.kind === "session_end") rec.workers.delete(e.workerId);
      else rec.workers.set(e.workerId, { agent: e.agent, workerId: e.workerId, project: e.project, cwd: e.cwd, model: e.model, at: rec.lastEventAt });
    }
    this.o.onEvent(e);
  }

  private notify(rec: Rec, w: Seen, extra: Pick<RawEvent, "kind"> & Partial<RawEvent>): void {
    if (this.o.inOffice && !this.o.inOffice(w.workerId)) {
      rec.workers.delete(w.workerId);
      return;
    }
    const e: RawEvent = { ts: new Date(this.now()).toISOString(), agent: w.agent, workerId: w.workerId, project: w.project, host: rec.host, ...extra };
    if (w.cwd) e.cwd = w.cwd;
    if (w.model) e.model = w.model;
    try {
      this.o.onEvent(e);
    } catch {
      // The state store never throws; a test listener might.
    }
  }

  /* -------------------------------------------------------------- reports */

  private problem(key: string, msg: string): void {
    if (this.problems.get(key) === msg) return;
    this.problems.set(key, msg);
    if (this.announced) this.log(msg, "warn");
  }

  watch(target: RemoteTarget): { dispose(): void } {
    if (this.stopped) return { dispose() {} };
    let rec = this.recs.get(target.host.id);
    if (!rec) {
      rec = this.add(target);
      rec.adopted = true;
    }
    const held = rec;
    held.pins++;
    let done = false;
    return {
      dispose: () => {
        if (done) return;
        done = true;
        held.pins = Math.max(0, held.pins - 1);
        if (held.pins === 0 && held.adopted && this.recs.get(held.host.id) === held) this.remove(held, "session_end");
      },
    };
  }

  hosts(): HostStatus[] {
    return [...this.recs.values()].map((r) => ({
      host: r.host,
      online: r.status !== "offline",
      status: r.status,
      ...(r.status === "offline" && r.error ? { error: r.error } : {}),
    }));
  }

  summary(): { watching: string[]; problems: string[] } {
    const watching: string[] = [];
    for (const kind of CLOUD) {
      const n = [...this.recs.values()].filter((r) => r.host.kind === kind).length;
      if (n) watching.push(`${n} ${LABEL[kind]}`);
    }
    for (const r of this.recs.values()) if (r.host.kind === "ssh") watching.push(`ssh ${r.host.name}`);
    return { watching, problems: [...new Set(this.problems.values())] };
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const rec of [...this.recs.values()]) this.remove(rec, null);
  }
}

function shortReason(err: Error): string {
  const code = (err as RemoteError).code;
  const msg = err.message.replace(/^[^:]+: /, "");
  if (code === "timeout") return msg || "timed out";
  return msg.slice(0, 120) || "unreachable";
}

/** `railwayBudget`: one hourly API budget shared with the control plane's own Railway calls. */
export function defaultProviders(o: ProviderOptions & { railwayBudget?: RailwayBudget } = {}): Provider[] {
  return [createDaytonaProvider(o), createBoatProvider(o), createRailwayProvider({ ...o, budget: o.railwayBudget }), createVercelProvider(o)];
}

/** `--ssh | --daytona | --boat | --railway | --vercel <all|id>` -> targets, for the installer. */
const INSTALL_TIMEOUT_MS = 60_000;
export const REMOTE_FACTORIES: Record<RemoteKind, (id: string) => Promise<RemoteTarget[]>> = {
  ssh: async (id) => [createSshTarget(id, { timeoutMs: INSTALL_TIMEOUT_MS })],
  daytona: (id) => createDaytonaTargets(id, { timeoutMs: INSTALL_TIMEOUT_MS }),
  boat: (id) => createBoatTargets(id, { timeoutMs: INSTALL_TIMEOUT_MS }),
  railway: (id) => createRailwayTargets(id, { timeoutMs: INSTALL_TIMEOUT_MS }),
  vercel: (id) => createVercelTargets(id, { timeoutMs: INSTALL_TIMEOUT_MS }),
};

