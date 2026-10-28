/*
 * Linking placeholder workers to their real transcripts. A hired agent is
 * worker "ctl:<id>" the moment it is hired, an agent seen launching in a
 * terminal is "proc:<pid>" (presence.ts); neither has written a transcript
 * yet. Each registers a LinkExpectation, and when ingest is about to create
 * a new top-level worker OfficeState asks the claimer here whether one of
 * them should take it over in place:
 *
 *   1. exact: the transcript's worker id is the session id the launch pinned
 *      ("<hostId>/<sessionId>" for a remote), for agents that allow pinning;
 *   2. guess (unless exactOnly): same agent, same host, same folder after the
 *      office's own folding ("~", /private), first seen no earlier than
 *      since - 5s, not claimed before. The oldest expectation wins, except
 *      that one which opted out of guessing between two (onAmbiguous) is
 *      dropped when another also matches: two terminals in one repo would
 *      otherwise swap desks.
 *
 * An expectation links once. After that it follows its worker through later
 * renames (Claude's /clear re-links with a new exact expectation on the
 * linked worker), calling onLinked with each new id, until it is disposed.
 */
import type { RawEvent } from "../shared/events.ts";
import { foldPrivate } from "../ingest/presence.ts";
import type { OfficeState } from "../server/state.ts";
import type { Disposable, LinkExpectation, OfficePort } from "./types.ts";

/** A transcript first seen this long before the expectation's `since` still matches (clock skew, ps resolution). */
export const LINK_SLACK_MS = 5_000;

interface Entry {
  x: LinkExpectation;
  /** Registration order: the oldest expectation wins a guess. */
  n: number;
  /** The worker it is following once linked. */
  linked?: string;
}

export interface Linker {
  expect(x: LinkExpectation): Disposable;
  /** OfficeState's claimer: the placeholder this new top-level worker should replace. */
  claim(e: RawEvent): string | undefined;
  /** Live expectations, for tests and doctor. */
  size(): number;
  dispose(): void;
}

/** Wire a linker into this OfficeState (sets its claimer). `home` is the folder the state shows as "~". */
export function createLinker(state: OfficeState, home: string | null): Linker {
  const entries = new Set<Entry>();
  const claimed = new Set<string>();
  let seq = 0;

  const local = (p: string) => {
    let v = p.trim().replace(/[\\/]+$/, "") || "/";
    if (home && (v === "~" || v.startsWith("~/"))) v = home.replace(/[\\/]+$/, "") + v.slice(1);
    return foldPrivate(v);
  };
  const remote = (p: string) => p.trim().replace(/\/+$/, "") || "/";

  function exactId(x: LinkExpectation): string | undefined {
    if (!x.sessionId) return undefined;
    return x.hostId ? `${x.hostId}/${x.sessionId}` : x.sessionId;
  }

  function claim(e: RawEvent): string | undefined {
    if (e.parentId || claimed.has(e.workerId)) return undefined;
    const open = [...entries].filter((en) => !en.linked && state.has(en.x.placeholder)).sort((a, b) => a.n - b.n);
    const exact = open.find((en) => exactId(en.x) === e.workerId);
    if (exact) return take(exact, e.workerId);
    const t = Date.parse(e.ts);
    const hostId = e.host?.id;
    const guesses = open.filter(({ x }) => {
      if (x.exactOnly ?? !!x.sessionId) return false;
      if (x.agent !== e.agent || (x.hostId ?? undefined) !== hostId) return false;
      if (!x.cwd || !e.cwd) return false;
      const same = hostId ? remote(x.cwd) === remote(e.cwd) : local(x.cwd) === local(e.cwd);
      return same && Number.isFinite(t) && t >= x.since - LINK_SLACK_MS;
    });
    if (guesses.length > 1 && guesses.some((en) => en.x.onAmbiguous)) {
      for (const en of guesses) {
        if (!en.x.onAmbiguous) continue;
        entries.delete(en);
        try {
          en.x.onAmbiguous();
        } catch {
          // The owner's bookkeeping failing must not stop the office.
        }
      }
      const rest = guesses.filter((en) => !en.x.onAmbiguous);
      return rest.length ? take(rest[0]!, e.workerId) : undefined;
    }
    return guesses.length ? take(guesses[0]!, e.workerId) : undefined;
  }

  /** Mark it pending; the rename itself is confirmed by the session_start with `replaces` below. */
  function take(en: Entry, workerId: string): string {
    claimed.add(workerId);
    return en.x.placeholder;
  }

  // Every rename the office publishes: link the expectation waiting on that placeholder, and move
  // every expectation already following the old id along to the new one.
  const off = state.subscribe((e) => {
    if (e.kind !== "session_start" || !e.replaces) return;
    const from = e.replaces;
    const to = e.workerId;
    claimed.add(to);
    for (const en of entries) {
      const following = en.linked ?? (en.x.placeholder === from ? from : undefined);
      if (following !== from) continue;
      en.linked = to;
      try {
        en.x.onLinked(to);
      } catch {
        // The owner's bookkeeping failing must not stop the office.
      }
    }
  });

  state.setClaimer(claim);

  return {
    expect(x) {
      const en: Entry = { x, n: seq++ };
      entries.add(en);
      return { dispose: () => void entries.delete(en) };
    },
    claim,
    size: () => entries.size,
    dispose() {
      off();
      entries.clear();
      state.setClaimer(undefined);
    },
  };
}

/** The office floor as the control plane sees it: OfficeState plus the linker. */
export function createOfficePort(state: OfficeState, linker: Linker, o: { home: string; hired?: () => string[]; exists?: (dir: string) => boolean }): OfficePort {
  const expand = (p: string) => (p === "~" ? o.home : p.startsWith("~/") ? o.home + p.slice(1) : p);
  return {
    emit: (e) => void state.ingest(e),
    expect: (x) => linker.expect(x),
    hold: (id) => state.hold(id),
    release: (id) => state.release(id),
    end: (id) => state.end(id),
    workersOn: (hostId) => state.sessions().filter((w) => w.host?.id === hostId).length,
    recentFolders() {
      const seen = state
        .sessions()
        .filter((w) => !w.host && w.cwd)
        .sort((a, b) => Date.parse(b.lastTs) - Date.parse(a.lastTs))
        .map((w) => expand(w.cwd!));
      const out: string[] = [];
      for (const p of [...seen, ...(o.hired?.() ?? [])]) {
        if (!p.startsWith("/") || out.includes(p)) continue;
        if (o.exists && !o.exists(p)) continue;
        out.push(p);
      }
      return out.slice(0, 20);
    },
  };
}
