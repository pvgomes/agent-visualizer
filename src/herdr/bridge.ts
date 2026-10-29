/*
 * The office and herdr (https://herdr.dev), the terminal workspace manager for coding agents.
 * herdr knows every agent in its panes and whether it is idle, working, blocked (waiting on its
 * human) or done, for agents whose transcripts the office reads and for ones it can't (Pi, Devin,
 * Amp, ...). Every couple of seconds the bridge asks for herdr's snapshot and compares.
 *
 *   herd mode     herdr decides who is in the office: each agent herdr runs is a worker (in
 *                 the pod of its folder) for as long as its pane lives, posed by herdr's state.
 *                 Transcripts still bring the detail (which tool, which file, tests passing) for
 *                 the agents herdr names by session id; nothing else comes in.
 *   machine mode  the office works as it always has; herdr only adds what transcripts can't see:
 *                 an agent blocked on a permission prompt raises its hand.
 *
 * Both: the office knows which herdr pane a worker lives in (to focus it from the page), and can
 * start an agent in a new herdr workspace.
 */
import { basename } from "node:path";
import type { AgentKind, RawEvent } from "../shared/events.ts";
import type { HerdrRequest } from "./client.ts";

export type HerdrMode = "herd" | "machine";
type Status = "idle" | "working" | "blocked" | "done" | "unknown";

/** One agent in a herdr pane, as the office sees it. */
export interface HerdrAgent {
  pane: string;
  agent: AgentKind;
  /** herdr's name for the agent ("claude", "pi"), shown for the ones the office has no kind for. */
  name: string;
  status: Status;
  /** The agent's session id when herdr knows it: the same id the office's transcript workers have. */
  session?: string;
  workerId: string;
  cwd?: string;
  workspace: string;
}

export interface HerdrBridge {
  readonly mode: HerdrMode;
  /** herdr answered the last snapshot. */
  available(): boolean;
  agents(): HerdrAgent[];
  /** The herdr pane a worker runs in, if it runs in herdr. */
  paneOf(workerId: string): string | undefined;
  /** Herd mode: should this transcript event reach the office? (machine mode: always) */
  admit(e: RawEvent): boolean;
  focus(workerId: string): Promise<void>;
  /** A new workspace in `folder` with the agent started in it; resolves once herdr sees it ready. */
  start(o: { agent: AgentKind; folder: string; args: string[] }): Promise<{ pane: string }>;
  /** Resolves once the first snapshot is in (or herdr didn't answer it). */
  ready(): Promise<void>;
  /** One poll now (tests; also every everyMs). */
  tick(): Promise<void>;
  stop(): void;
}

/** herdr's agent names the office has its own kind for; the rest are "other". */
const KINDS: Record<string, AgentKind> = {
  claude: "claude", codex: "codex", copilot: "copilot", cursor: "cursor", opencode: "opencode",
  droid: "droid", qwen: "qwen", gemini: "gemini", commandcode: "commandcode", "command-code": "commandcode",
};
/** Office kinds herdr's `agent.start` can launch (its --kind values). */
export const HERDR_STARTABLE: readonly AgentKind[] = ["claude", "codex", "copilot", "cursor", "opencode", "droid", "gemini"];

export const HERDR_EVERY_MS = 1_500;
/** Live agents are re-sighted this often, so a quiet one isn't sent home while its pane is open. */
const KEEPALIVE_MS = 60_000;
/** While herdr doesn't answer (not installed, not running), ask this seldom. */
const RETRY_MS = 10_000;
/** A worker whose transcript spoke this recently is posed by its transcript, not by herdr. */
const TRANSCRIPT_FRESH_MS = 120_000;

export interface HerdrOptions {
  mode: HerdrMode;
  request: HerdrRequest;
  onEvent(e: RawEvent): void;
  /** Does the office already have this worker (machine mode only touches workers it has)? */
  has(workerId: string): boolean;
  log?: (msg: string, level?: "info" | "warn") => void;
  now?: () => number;
  everyMs?: number;
  /** No timer: the caller ticks (tests). */
  manual?: boolean;
}

export function startHerdr(o: HerdrOptions): HerdrBridge {
  const now = o.now ?? Date.now;
  const live = new Map<string, HerdrAgent & { sightedAt: number }>();
  /** Transcript workers (and their interns) herd mode lets in, and when each last spoke. */
  const spoke = new Map<string, number>();
  const interns = new Set<string>();
  let ok = false;
  let warned = false;
  let busy = false;
  let retryAt = 0;

  const iso = () => new Date(now()).toISOString();
  const base = (a: HerdrAgent): RawEvent => ({
    ts: iso(), agent: a.agent, workerId: a.workerId, project: a.cwd ? basename(a.cwd) : a.workspace, kind: "session_start",
    ...(a.cwd ? { cwd: a.cwd } : {}),
    ...(a.agent === "other" ? { model: a.name } : {}),
  });
  const fresh = (id: string) => now() - (spoke.get(id) ?? -Infinity) < TRANSCRIPT_FRESH_MS;

  /** What a change of herdr state means in the office. */
  function pose(a: HerdrAgent): RawEvent | null {
    const e = base(a);
    if (a.status === "blocked") return { ...e, kind: "waiting", summary: "Needs you" };
    // the rest only in herd mode, and only where no transcript is telling the story
    if (o.mode !== "herd" || fresh(a.workerId)) return null;
    if (a.status === "working") return { ...e, kind: "thinking", summary: "Working" };
    if (a.status === "done") return { ...e, kind: "waiting", summary: "Done" };
    if (a.status === "idle") return { ...e, kind: "idle" };
    return null;
  }

  function apply(agents: HerdrAgent[]) {
    const t = now();
    const seen = new Set<string>();
    for (const a of agents) {
      seen.add(a.pane);
      const was = live.get(a.pane);
      const herd = o.mode === "herd";
      if (!was || was.workerId !== a.workerId) {
        if (was && herd) o.onEvent({ ...base(was), kind: "session_end" });
        live.set(a.pane, { ...a, sightedAt: t });
        if (herd) o.onEvent(base(a));
        if (herd || o.has(a.workerId)) {
          const p = pose(a);
          if (p) o.onEvent(p);
        }
        continue;
      }
      if (was.status !== a.status && (herd || o.has(a.workerId))) {
        const p = pose(a);
        if (p) o.onEvent(p);
      }
      if (herd && t - was.sightedAt > KEEPALIVE_MS) {
        o.onEvent(base(a));
        was.sightedAt = t;
      }
      Object.assign(was, a);
    }
    for (const [pane, a] of live) {
      if (seen.has(pane)) continue;
      live.delete(pane);
      if (o.mode === "herd") o.onEvent({ ...base(a), kind: "session_end" });
    }
  }

  async function tick() {
    if (busy || (!ok && now() < retryAt)) return;
    busy = true;
    try {
      const r = await o.request("session.snapshot");
      const snap = r?.snapshot ?? {};
      const labels = new Map<string, string>((snap.workspaces ?? []).map((w: any) => [w.workspace_id, w.label ?? w.workspace_id]));
      const agents: HerdrAgent[] = [];
      for (const x of snap.agents ?? []) {
        if (typeof x?.pane_id !== "string" || typeof x.agent !== "string" || !x.agent) continue;
        const ref = x.agent_session;
        const session = ref && ref.kind === "id" && typeof ref.value === "string" && ref.value ? ref.value : undefined;
        agents.push({
          pane: x.pane_id,
          agent: KINDS[x.agent] ?? "other",
          name: x.agent,
          status: (["idle", "working", "blocked", "done"].includes(x.agent_status) ? x.agent_status : "unknown") as Status,
          ...(session ? { session } : {}),
          workerId: session ?? `herdr:${x.pane_id}`,
          ...(typeof x.cwd === "string" && x.cwd ? { cwd: x.cwd } : {}),
          workspace: labels.get(x.workspace_id) ?? String(x.workspace_id ?? ""),
        });
      }
      if (!ok) o.log?.(`herdr: connected, ${agents.length} agent${agents.length === 1 ? "" : "s"} (${o.mode === "herd" ? "herd mode" : "adding blocked states"})`);
      ok = true;
      warned = false;
      apply(agents);
    } catch (err) {
      if (ok || !warned) o.log?.(`herdr: not reachable (${(err as Error).message})`, ok ? "warn" : "info");
      ok = false;
      warned = true;
      retryAt = now() + RETRY_MS;
    } finally {
      busy = false;
    }
  }

  const timer = o.manual ? undefined : setInterval(() => void tick(), o.everyMs ?? HERDR_EVERY_MS);
  timer?.unref?.();
  const first = o.manual ? Promise.resolve() : tick();

  const paneOf = (workerId: string) => [...live.values()].find((a) => a.workerId === workerId)?.pane;

  return {
    mode: o.mode,
    available: () => ok,
    agents: () => [...live.values()].map(({ sightedAt: _s, ...a }) => a),
    paneOf,
    admit(e) {
      if (o.mode !== "herd") return true;
      const owned = [...live.values()].some((a) => a.workerId === e.workerId);
      const intern = !!e.parentId && (interns.has(e.parentId) || [...live.values()].some((a) => a.workerId === e.parentId));
      if (!owned && !intern && !interns.has(e.workerId)) return false;
      if (intern) interns.add(e.workerId);
      spoke.set(e.parentId && !owned ? e.parentId : e.workerId, now());
      return true;
    },
    async focus(workerId) {
      const pane = paneOf(workerId);
      if (!pane) throw new Error("That worker isn't in a herdr pane.");
      await o.request("agent.focus", { target: pane });
    },
    async start({ agent, folder, args }) {
      if (!HERDR_STARTABLE.includes(agent)) throw new Error(`herdr can't start ${agent}.`);
      const label = basename(folder) || folder;
      const ws = await o.request("workspace.create", { cwd: folder, label, focus: true });
      const pane = ws?.root_pane?.pane_id;
      if (typeof pane !== "string") throw new Error("herdr made the workspace but didn't say which pane.");
      await o.request("agent.start", { name: `${agent}-${label}`.slice(0, 60), kind: agent, pane_id: pane, args, timeout_ms: 30_000 }, 40_000);
      void tick();
      return { pane };
    },
    ready: () => first,
    tick,
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}
