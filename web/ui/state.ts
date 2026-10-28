/*
 * The chrome's own fold of the event stream: who is in the office, the
 * running totals, which remote hosts are up, and each worker's recent
 * actions and mood. The scene keeps its own state for drawing; this one only
 * feeds counters, the legend and the inspector, so it can stay small.
 */
import { BRAND, type AgentKind, type EventKind, type Host, type OfficeEvent, type Snapshot, type ToolCategory, type WorkerState } from "../../src/shared/events.ts";
import { parseTs } from "./format.ts";

export interface Action {
  seq: number;
  ts: number;
  kind: EventKind;
  category?: ToolCategory;
  tool?: string;
  summary?: string;
  isError?: boolean;
  role?: string;
}

export interface Worker extends WorkerState {
  history: Action[];
  /** Edit summaries seen live, on top of the snapshot's filesTouched. */
  edits: Set<string>;
  baseFiles: number;
}

export interface Change {
  worker?: Worker;
  joined?: Worker;
  left?: Worker;
  /** OfficeEvent.replaces: this worker took over `from` in place, history and all. */
  renamed?: { from: string; to: string };
  /** a remote host went down or came back */
  hosts?: boolean;
}

export interface HostSummary {
  host: Host;
  workers: number;
  offline: boolean;
}

const HISTORY = 12;
/** Events an agent sends through MCP alongside its work; they never change what it is doing. */
const SIGNALS = new Set<EventKind>(["status", "shout", "celebrate"]);
const OFFLINE = /^remote offline/i;
const isRemote = (h?: Host): h is Host => !!h && h.kind !== "local";

/** The mood line an MCP status event sets: emoji (sent as `tool`) and text. */
export function moodOf(e: Pick<OfficeEvent, "tool" | "summary">): string {
  const text = (e.summary ?? "").trim();
  const emoji = e.tool && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(e.tool) && !text.startsWith(e.tool) ? e.tool : "";
  return [emoji, text].filter(Boolean).join(" ");
}

export class OfficeModel {
  readonly workers = new Map<string, Worker>();
  toolCalls = 0;
  tokens = 0;
  flips = 0;
  demo = false;
  loaded = false;
  /** remote hosts seen, by id, and which of them are down */
  readonly hostsSeen = new Map<string, Host>();
  readonly offline = new Set<string>();

  load(s: Snapshot): void {
    this.workers.clear();
    this.hostsSeen.clear();
    this.offline.clear();
    this.demo = !!s.demo;
    this.loaded = true;
    for (const w of s.workers ?? []) this.workers.set(w.workerId, this.make(w));
    this.toolCalls = 0;
    this.tokens = 0;
    for (const w of this.workers.values()) {
      this.toolCalls += w.toolCalls || 0;
      this.tokens += w.tokens || 0;
    }
    for (const w of this.workers.values()) if (isRemote(w.host)) this.hostsSeen.set(w.host.id, w.host);
    this.flips = 0;
    for (const e of s.recent ?? []) {
      if (e.kind === "test_fail" || e.kind === "flip") this.flips++;
      if (isRemote(e.host)) {
        this.hostsSeen.set(e.host.id, e.host);
        if (e.kind === "error" && OFFLINE.test(e.summary ?? "")) this.offline.add(e.host.id);
        else this.offline.delete(e.host.id);
      }
      const w = this.workers.get(e.workerId);
      if (w) push(w, e);
    }
    // a server may also list its remotes (optional; not part of every snapshot)
    const hosts = (s as Snapshot & { hosts?: { host?: Host; id?: string; kind?: Host["kind"]; name?: string; online?: boolean; status?: string }[] }).hosts;
    if (Array.isArray(hosts)) {
      for (const x of hosts) {
        const host = x.host ?? (x.id && x.kind ? { id: x.id, kind: x.kind, name: x.name ?? x.id } : undefined);
        if (!isRemote(host)) continue;
        this.hostsSeen.set(host.id, host);
        if (x.online === false || (typeof x.status === "string" && /off|down|error/i.test(x.status))) this.offline.add(host.id);
      }
    }
  }

  apply(e: OfficeEvent): Change {
    const change: Change = {};
    if (isRemote(e.host)) {
      const known = this.hostsSeen.has(e.host.id);
      this.hostsSeen.set(e.host.id, e.host);
      if (e.kind === "error" && OFFLINE.test(e.summary ?? "")) {
        change.hosts = !this.offline.has(e.host.id) || !known;
        this.offline.add(e.host.id);
        // the notice is about the host, not a worker
        if (!this.workers.has(e.workerId)) return change;
      } else if (this.offline.delete(e.host.id) || !known) change.hosts = true;
    }
    if (e.kind === "session_start" && e.replaces && e.replaces !== e.workerId) {
      const old = this.workers.get(e.replaces);
      if (old) {
        this.workers.delete(e.replaces);
        if (!this.workers.has(e.workerId)) {
          old.workerId = e.workerId;
          this.workers.set(e.workerId, old);
        }
        for (const k of this.workers.values()) if (k.parentId === e.replaces) k.parentId = e.workerId;
        change.renamed = { from: e.replaces, to: e.workerId };
      }
    }
    const ending = e.kind === "session_end" || e.kind === "subagent_end";
    // A parent announcing its subagent (no parentId) must not spawn a worker.
    const announcesOnly = e.kind === "subagent_start" && !e.parentId && !this.workers.has(e.workerId);
    let w = this.workers.get(e.workerId);

    if (!w && !ending && !announcesOnly) {
      w = this.make({
        workerId: e.workerId,
        parentId: e.parentId,
        agent: e.agent,
        project: e.project,
        cwd: e.cwd,
        model: e.model,
        role: e.role,
        host: e.host,
        status: SIGNALS.has(e.kind) ? "thinking" : e.kind,
        lastTs: e.ts,
        toolCalls: 0,
        tokens: 0,
        filesTouched: 0,
      });
      this.workers.set(w.workerId, w);
      change.joined = w;
    }

    if (e.kind === "test_fail" || e.kind === "flip") this.flips++;
    if (e.kind === "tool_start") this.toolCalls++;
    if (e.tokens && e.tokens > 0) this.tokens += e.tokens;
    if (!w) return change;

    if (e.project) w.project = e.project;
    if (e.cwd) w.cwd = e.cwd;
    if (e.model) w.model = e.model;
    if (e.role) w.role = e.role;
    if (e.host) w.host = e.host;
    w.lastTs = e.ts;
    if (e.kind === "status") w.mood = moodOf(e) || undefined;
    if (e.kind !== "tool_end" && !SIGNALS.has(e.kind)) w.status = e.kind;
    if (e.kind === "tool_start") {
      w.toolCalls++;
      w.tool = e.tool;
      w.category = e.category;
      w.summary = e.summary;
      if (e.category === "edit" && e.summary) w.edits.add(e.summary);
      w.filesTouched = w.baseFiles + w.edits.size;
    } else if (e.kind === "thinking" || e.kind === "waiting" || e.kind === "idle" || e.kind === "prompt") {
      w.tool = undefined;
      w.category = undefined;
      w.summary = undefined;
    } else if (e.summary && e.kind !== "tool_end" && !SIGNALS.has(e.kind)) {
      w.summary = e.summary;
    }
    if (e.tokens && e.tokens > 0) w.tokens += e.tokens;
    push(w, e);
    change.worker = w;

    // subagent_end only removes an intern; a parent reporting it is left alone.
    if (e.kind === "session_end" || (e.kind === "subagent_end" && w.parentId)) {
      this.workers.delete(w.workerId);
      change.left = w;
    }
    return change;
  }

  get(id: string | null): Worker | undefined {
    return id ? this.workers.get(id) : undefined;
  }

  byAgent(): Record<AgentKind, number> {
    const out = Object.fromEntries(Object.keys(BRAND).map((k) => [k, 0])) as Record<AgentKind, number>;
    for (const w of this.workers.values()) out[w.agent] = (out[w.agent] ?? 0) + 1;
    return out;
  }

  /** Remote hosts with workers on them, plus any that are down. */
  hosts(): HostSummary[] {
    const by = new Map<string, HostSummary>();
    for (const w of this.workers.values()) {
      if (!isRemote(w.host)) continue;
      const have = by.get(w.host.id);
      if (have) have.workers++;
      else by.set(w.host.id, { host: w.host, workers: 1, offline: this.offline.has(w.host.id) });
    }
    for (const id of this.offline) {
      const host = this.hostsSeen.get(id);
      if (host && !by.has(id)) by.set(id, { host, workers: 0, offline: true });
    }
    return [...by.values()];
  }

  private make(w: WorkerState): Worker {
    return { ...w, history: [], edits: new Set(), baseFiles: w.filesTouched || 0 };
  }
}

function push(w: Worker, e: OfficeEvent): void {
  if (e.kind === "thinking" || e.kind === "reply" || (e.kind === "tool_end" && !e.isError)) return;
  w.history.push({
    seq: e.seq,
    ts: parseTs(e.ts),
    kind: e.kind,
    category: e.category,
    tool: e.tool,
    summary: e.summary,
    isError: e.isError,
    role: e.role,
  });
  if (w.history.length > HISTORY) w.history.splice(0, w.history.length - HISTORY);
}
