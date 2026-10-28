/*
 * Agents walk in the moment they launch and leave the moment they quit, not
 * after their first prompt and twenty quiet minutes. Every couple of seconds
 * the process table (src/ingest/presence.ts scanProcesses) is compared with
 * the office:
 *
 *   walk in   an agent process with a terminal, not owned by the control
 *             plane (or a child of one), not nested under another agent,
 *             started after the office or within ACTIVE_WINDOW_MS before it,
 *             in a folder whose existing unlinked workers don't already
 *             account for it, becomes worker "proc:<pid>" (held), and waits
 *             through the linker for its transcript to take its desk;
 *   walk out  a tracked pid missing from two scans in a row sends its
 *             current worker home (OfficePort.end, which also tombstones it).
 *   follow    the same process starting a new transcript (/clear, /resume,
 *             Codex /new) moves its desk there and sends the old
 *             conversation home: exactly when the agent records which
 *             session a pid is in (Claude Code's sessions/<pid>.json, also
 *             the exact link at launch), otherwise when the new transcript is
 *             the only one in that folder nothing else accounts for.
 *
 * Two launches of one agent in one folder are never guessed between: if a
 * transcript could be either's, both give up their placeholders and those
 * processes are counted like any other (below) instead of swapping desks.
 *
 * Everything else (scripts' `claude -p`, sessions from before the office) is
 * left to OfficeState.reconcileLocal, which this also feeds: per agent and
 * folder, keep as many unlinked sessions as there are untracked processes
 * (an npm launcher and the native binary it runs count once).
 */
import { ACTIVE_WINDOW_MS, type AgentKind, type RawEvent } from "../shared/events.ts";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { foldPrivate, type ProcessScan, type ScannedAgent } from "../ingest/presence.ts";
import type { OfficeState } from "../server/state.ts";
import { isPlaceholder } from "../server/state.ts";
import { LINK_SLACK_MS } from "./link.ts";
import type { Disposable, OfficePort } from "./types.ts";

export const PRESENCE_EVERY_MS = 2_000;
/** Scans in a row a tracked pid must be missing from before its worker goes home (one ps can race a fork). */
const MISSES = 2;
/** A new transcript must be this old (and the old one quiet since) before a desk follows it on a guess. */
const FOLLOW_AFTER_MS = 2_000;
/** Another process of that agent in that folder this recently: a new transcript there may well be its. */
const OTHERS_RECENT_MS = 30_000;

export interface PresenceOptions {
  state: OfficeState;
  office: OfficePort;
  scan: () => Promise<ProcessScan | null>;
  /** Processes the control plane started (they and their children are its own workers). */
  ownedPids?: () => number[];
  /** When this office started, epoch ms. */
  startedAt: number;
  /** The folder OfficeState shows as "~". */
  home: string | null;
  now?: () => number;
  everyMs?: number;
  agents?: AgentKind[];
  /** No timer and no first scan: the caller ticks (tests). */
  manual?: boolean;
  /**
   * The session a process is in, from the agent's own record, if it keeps one
   * (claudeSessionOf). startedAt is the process's, to tell a reused pid.
   */
  sessionOf?: (agent: AgentKind, pid: number, startedAt: number) => string | undefined;
}

export interface Presence {
  /** One scan now (tests; also run every everyMs). */
  tick(): Promise<void>;
  /** pid -> the worker it is in the office as right now. */
  tracked(): Map<number, string>;
  stop(): void;
}

interface Tracked {
  agent: AgentKind;
  cwd: string;
  /** agent + folded folder. */
  key: string;
  workerId: string;
  misses: number;
  link: Disposable;
  /** When it took its current worker (walk-in, link, follow), epoch ms. */
  since: number;
  /** The session id the agent's own record named last. */
  sid?: string;
}

/**
 * Claude Code's own record of the session a process is in:
 * <config dir>/sessions/<pid>.json {pid, sessionId, startedAt, ...}. Only
 * those three fields are read (the .key file beside it is never touched).
 */
export function claudeSessionOf(configDir: string, pid: number, startedAt: number): string | undefined {
  const file = join(configDir, "sessions", `${pid}.json`);
  try {
    if (statSync(file).size > 64 * 1024) return undefined;
    const j = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown; sessionId?: unknown; startedAt?: unknown };
    if (j.pid !== pid || typeof j.sessionId !== "string" || !/^[0-9a-f-]{8,64}$/i.test(j.sessionId)) return undefined;
    // A record left by an earlier process that had this pid.
    if (typeof j.startedAt === "number" && startedAt && Math.abs(j.startedAt - startedAt) > 120_000) return undefined;
    return j.sessionId;
  } catch {
    return undefined;
  }
}

export function startPresence(o: PresenceOptions): Presence {
  const now = o.now ?? Date.now;
  const tracked = new Map<number, Tracked>();
  /** Pids presence gave up on (a transcript could have been theirs or another's): counted, never walked in. */
  const skip = new Set<number>();
  /** New top-level local workers -> when they arrived, and the time on their first line. */
  const arrived = new Map<string, { at: number; ts: number }>();
  /** agent + folder -> when a process presence doesn't track last ran there. */
  const othersAt = new Map<string, number>();
  const allowed = o.agents ? new Set(o.agents) : null;
  const fold = (p: string) => {
    let v = p.replace(/[\\/]+$/, "") || "/";
    if (o.home && (v === "~" || v.startsWith("~/"))) v = o.home.replace(/[\\/]+$/, "") + v.slice(1);
    return foldPrivate(v);
  };
  const keyOf = (agent: AgentKind, cwd: string) => `${agent}\0${fold(cwd)}`;
  const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? "~";
  let busy = false;
  let stopped = false;
  const off = o.state.subscribe((e) => {
    if (e.kind === "session_start" && !e.parentId && !e.host && !e.replaces && !isPlaceholder(e.workerId)) {
      arrived.set(e.workerId, { at: now(), ts: Date.parse(e.ts) });
      if (arrived.size > 500) arrived.delete(arrived.keys().next().value!);
    } else if (e.kind === "session_end") arrived.delete(e.workerId);
  });

  function ancestors(pid: number, parents: Map<number, number>): number[] {
    const out: number[] = [];
    for (let p = parents.get(pid), n = 0; p && p > 1 && n < 64; p = parents.get(p), n++) out.push(p);
    return out;
  }

  function apply(scan: ProcessScan): void {
    const t = now();
    const agents = scan.agents.filter((a) => !allowed || allowed.has(a.agent));
    const alive = new Set(agents.map((a) => a.pid));

    // Walk out.
    for (const [pid, tr] of tracked) {
      if (alive.has(pid)) {
        tr.misses = 0;
        continue;
      }
      if (++tr.misses < MISSES) continue;
      tracked.delete(pid);
      tr.link.dispose();
      o.office.end(tr.workerId);
    }
    for (const pid of skip) if (!alive.has(pid)) skip.delete(pid);

    const owned = new Set(o.ownedPids?.() ?? []);
    const agentPids = new Set(agents.map((a) => a.pid));
    const agentOf = new Map(agents.map((a) => [a.pid, a.agent]));
    const ownedOrUnder = (a: ScannedAgent) => owned.has(a.pid) || ancestors(a.pid, scan.parents).some((p) => owned.has(p));
    const nested = (a: ScannedAgent) => ancestors(a.pid, scan.parents).some((p) => agentPids.has(p));
    /** The native binary an npm launcher runs (node codex.js -> codex): one agent, not two. */
    const launched = (a: ScannedAgent) => agentOf.get(scan.parents.get(a.pid) ?? 0) === a.agent;

    // The agent's own record of its session, where it keeps one.
    if (o.sessionOf) {
      for (const a of agents) {
        const tr = tracked.get(a.pid);
        if (tr) follow(tr, o.sessionOf(a.agent, a.pid, a.startedAt));
      }
    }

    // Walk in: candidates per agent and folder, minus what existing unlinked workers there account for.
    const groups = new Map<string, ScannedAgent[]>();
    for (const a of agents) {
      if (tracked.has(a.pid) || skip.has(a.pid) || !a.tty || !a.cwd) continue;
      if (a.startedAt < o.startedAt - ACTIVE_WINDOW_MS) continue;
      if (ownedOrUnder(a) || nested(a)) continue;
      const k = `${a.agent}\0${fold(a.cwd)}`;
      const g = groups.get(k);
      if (g) g.push(a);
      else groups.set(k, [a]);
    }
    if (groups.size) {
      const unlinked = new Map<string, number>();
      for (const w of o.state.sessions()) {
        if (w.host || !w.cwd || isPlaceholder(w.workerId) || o.state.isHeld(w.workerId)) continue;
        const k = `${w.agent}\0${fold(w.cwd)}`;
        unlinked.set(k, (unlinked.get(k) ?? 0) + 1);
      }
      for (const [k, list] of groups) {
        const extra = list.length - (unlinked.get(k) ?? 0);
        if (extra <= 0) continue;
        // The newest processes are the ones no transcript accounts for yet.
        list.sort((a, b) => b.startedAt - a.startedAt);
        for (const a of list.slice(0, extra)) walkIn(a, t);
      }
    }

    const others = agents.filter((a) => !tracked.has(a.pid) && !owned.has(a.pid) && !launched(a));
    for (const a of others) if (a.cwd) othersAt.set(keyOf(a.agent, a.cwd), t);
    followNewTranscripts(t);

    // The count-based goodbye for everything presence doesn't track.
    o.state.reconcileLocal(others.map((a) => ({ agent: a.agent, cwd: a.cwd })));
  }

  /** The agent says this process is in session `sid` now: link to it exactly, or move the desk there. */
  function follow(tr: Tracked, sid: string | undefined): void {
    if (!sid || sid === tr.sid) return;
    tr.sid = sid;
    if (tr.workerId === sid) return;
    if (!isPlaceholder(tr.workerId) && o.state.has(sid) && !o.state.isHeld(sid)) return moveTo(tr, sid);
    // Not written yet: when it is, it takes this desk in place (a placeholder still links by folder meanwhile).
    tr.link.dispose();
    tr.link = expectFor(tr, sid);
  }

  /**
   * /clear, /resume or /new without a record: a new transcript in a tracked
   * process's folder, after it took its desk, while its conversation went
   * quiet, with no other process of that agent there to own it.
   */
  function followNewTranscripts(t: number): void {
    const perKey = new Map<string, number>();
    for (const tr of tracked.values()) perKey.set(tr.key, (perKey.get(tr.key) ?? 0) + 1);
    let workers: ReturnType<OfficeState["sessions"]> | undefined;
    for (const tr of tracked.values()) {
      if (isPlaceholder(tr.workerId) || perKey.get(tr.key) !== 1) continue;
      if (t - (othersAt.get(tr.key) ?? -Infinity) < OTHERS_RECENT_MS) continue;
      workers ??= o.state.sessions();
      let best: { id: string; at: number } | undefined;
      for (const w of workers) {
        if (w.host || !w.cwd || isPlaceholder(w.workerId) || w.workerId === tr.workerId || o.state.isHeld(w.workerId)) continue;
        if (w.agent !== tr.agent || keyOf(w.agent, w.cwd) !== tr.key) continue;
        const a = arrived.get(w.workerId);
        // Written after this process took its desk (not an older transcript the backfill or a tail just reached).
        if (!a || a.at < tr.since || !(a.ts >= tr.since - LINK_SLACK_MS) || t - a.at < FOLLOW_AFTER_MS) continue;
        if (!best || a.at > best.at) best = { id: w.workerId, at: a.at };
      }
      if (!best) continue;
      const mine = workers.find((w) => w.workerId === tr.workerId);
      if (mine && Date.parse(mine.lastTs) > best.at) continue; // still talking: the new one is someone else's
      moveTo(tr, best.id);
    }
  }

  /** The desk follows the process to `to` (already in the office); its old conversation goes home. */
  function moveTo(tr: Tracked, to: string): void {
    const from = tr.workerId;
    tr.link.dispose();
    tr.link = { dispose() {} };
    o.office.hold(to);
    tr.workerId = to;
    tr.since = now();
    if (from !== to) o.office.end(from);
  }

  function expectFor(tr: Tracked, sid: string | undefined): Disposable {
    const unlinked = isPlaceholder(tr.workerId);
    return o.office.expect({
      placeholder: tr.workerId,
      agent: tr.agent,
      cwd: tr.cwd,
      since: tr.since - 2_000,
      ...(sid ? { sessionId: sid, exactOnly: !unlinked } : {}),
      onLinked: (w) => {
        tr.workerId = w;
        tr.since = now();
      },
      ...(unlinked ? { onAmbiguous: () => queueMicrotask(() => giveUp(tr)) } : {}),
    });
  }

  /** A transcript could have been this launch's or another's: no placeholder, counted like any process. */
  function giveUp(tr: Tracked): void {
    for (const [pid, x] of tracked) {
      if (x !== tr) continue;
      tracked.delete(pid);
      skip.add(pid);
      tr.link.dispose();
      if (isPlaceholder(tr.workerId)) o.office.end(tr.workerId);
      else o.office.release(tr.workerId);
    }
  }

  function walkIn(a: ScannedAgent, t: number): void {
    const workerId = `proc:${a.pid}`;
    const cwd = a.cwd!;
    const e: RawEvent = { ts: new Date(t).toISOString(), agent: a.agent, workerId, project: base(cwd), cwd, kind: "session_start" };
    o.office.emit(e);
    o.office.hold(workerId);
    const sid = o.sessionOf?.(a.agent, a.pid, a.startedAt);
    const tr: Tracked = { agent: a.agent, cwd, key: keyOf(a.agent, cwd), workerId, misses: 0, link: { dispose() {} }, since: a.startedAt, ...(sid ? { sid } : {}) };
    tracked.set(a.pid, tr);
    tr.link = expectFor(tr, sid);
  }

  async function tick(): Promise<void> {
    if (busy || stopped) return;
    busy = true;
    try {
      const scan = await o.scan();
      if (scan && !stopped) apply(scan);
    } catch {
      // A failed scan changes nothing: no arrivals, no goodbyes this round.
    } finally {
      busy = false;
    }
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  if (!o.manual) {
    void tick();
    timer = setInterval(() => void tick(), o.everyMs ?? PRESENCE_EVERY_MS);
    timer.unref?.();
  }
  return {
    tick,
    tracked: () => new Map([...tracked].map(([pid, tr]) => [pid, tr.workerId])),
    stop() {
      stopped = true;
      clearInterval(timer);
      off();
      for (const tr of tracked.values()) tr.link.dispose();
    },
  };
}
