/*
 * What the page knows about the control plane: whether this browser may use
 * it, the agents, places and keys it offers, and the sessions the office
 * started. Filled by GET /api/control and kept current by the `control`,
 * `control_gone` and `control_info` events on /events. A session's worker is
 * always looked up by ControlSession.workerId, which follows a `replaces`
 * rename.
 */
import type { ControlInfo, ControlSession } from "../../../src/shared/control.ts";
import { api, ControlError } from "./api.ts";

/** unknown: not asked yet. locked: 401, watch-only. off: this server has no control plane. */
export type ControlState = "unknown" | "locked" | "enabled" | "off";

export class ControlStore {
  state: ControlState = "unknown";
  /** What the snapshot said while GET /api/control is still on its way (it can take a few seconds cold). */
  private expected: ControlState = "unknown";
  info: ControlInfo | null = null;
  readonly sessions = new Map<string, ControlSession>();
  private subs = new Set<(what: "info" | "sessions") => void>();
  private loading: Promise<void> | null = null;
  /** When GET /api/control last answered (ms): the first snapshot right after doesn't ask again. */
  private loadedAt = 0;
  /** A control frame came in while GET /api/control was out: its answer may be older than that frame. */
  private overtaken = false;

  get enabled(): boolean {
    return this.state === "enabled";
  }

  /** The state, or until it is known, what the snapshot promised: Hire shows at once, and opens once the info is here. */
  get likely(): ControlState {
    return this.state === "unknown" ? this.expected : this.state;
  }

  subscribe(fn: (what: "info" | "sessions") => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  private emit(what: "info" | "sessions"): void {
    for (const fn of this.subs) {
      try {
        fn(what);
      } catch (err) {
        console.warn("[agent-visualizer] control listener failed", err);
      }
    }
  }

  /** What the snapshot says about this browser (Snapshot.control); absent: ask the server. */
  fromSnapshot(control: "enabled" | "locked" | "off" | undefined): Promise<void> {
    if (control === "locked") {
      this.setLocked();
      return Promise.resolve();
    }
    if (control === "off") {
      this.info = null;
      this.sessions.clear();
      this.setState("off");
      this.emit("sessions");
      return Promise.resolve();
    }
    if (control === "enabled" && this.state === "unknown" && this.expected !== "enabled") {
      this.expected = "enabled";
      this.emit("info");
    }
    // asked a moment ago (the page primed it while /events connected): that answer stands
    if (control === "enabled" && this.state === "enabled" && Date.now() - this.loadedAt < 5_000) return Promise.resolve();
    return this.refresh();
  }

  /**
   * GET /api/control. `keepSessions`: only the rest (agents, platforms, keys, logins), for a dialog
   * that opens; the sessions stay as their events left them, which may be newer than this answer.
   * A control frame that arrives while it is out (before the first answer the store drops them)
   * may be newer than the answer, so the store asks once more then (twice at most).
   */
  refresh(o: { keepSessions?: boolean } = {}): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        for (let round = 0; round < 3; round++) {
          this.overtaken = false;
          const keep = !!o.keepSessions && this.state === "enabled";
          const info = await api.info();
          if (!info || info.enabled === false) {
            this.setLocked();
            return;
          }
          this.info = keep ? { ...info, sessions: this.info?.sessions ?? [] } : info;
          this.state = "enabled";
          this.loadedAt = Date.now();
          if (!keep) {
            this.sessions.clear();
            for (const s of info.sessions ?? []) this.sessions.set(s.id, s);
          }
          this.emit("info");
          if (!keep) this.emit("sessions");
          if (!this.overtaken) break;
        }
      } catch (err) {
        if (err instanceof ControlError && err.status === 401) this.setLocked();
        else if (err instanceof ControlError && (err.status === 404 || err.status === 405 || err.status === 501)) this.setState("off");
        else if (this.state === "unknown") this.setState("off");
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  private setLocked(): void {
    this.info = null;
    this.sessions.clear();
    this.setState("locked");
    this.emit("sessions");
  }

  private setState(s: ControlState): void {
    if (this.state === s) return;
    this.state = s;
    this.emit("info");
  }

  /** One of the control events riding /events. */
  onEvent(name: string, data: unknown): void {
    if (this.loading && (name === "control" || name === "control_gone" || name === "control_info")) this.overtaken = true;
    if (!this.enabled || !data || typeof data !== "object") return;
    if (name === "control") {
      const s = data as ControlSession;
      if (typeof s.id !== "string" || typeof s.workerId !== "string") return;
      this.sessions.set(s.id, s);
      this.emit("sessions");
    } else if (name === "control_gone") {
      const id = (data as { id?: unknown }).id;
      if (typeof id === "string" && this.sessions.delete(id)) this.emit("sessions");
    } else if (name === "control_info" && this.info) {
      const patch = data as Partial<ControlInfo>;
      const { sessions, enabled, ...rest } = patch;
      void enabled;
      this.info = { ...this.info, ...rest };
      if (Array.isArray(sessions)) {
        this.sessions.clear();
        for (const s of sessions) this.sessions.set(s.id, s);
        this.emit("sessions");
      }
      this.emit("info");
    }
  }

  /** A hire answered: show the session at once, before its event arrives. */
  upsert(s: ControlSession): void {
    this.sessions.set(s.id, s);
    this.emit("sessions");
  }

  forWorker(workerId: string | null | undefined): ControlSession | undefined {
    if (!workerId) return undefined;
    for (const s of this.sessions.values()) if (s.workerId === workerId) return s;
    return undefined;
  }

  get(id: string | null | undefined): ControlSession | undefined {
    return id ? this.sessions.get(id) : undefined;
  }

  /** The newest first, live ones before the ones that ended. */
  list(): ControlSession[] {
    const live = (s: ControlSession) => (s.status === "exited" || s.status === "failed" ? 1 : 0);
    return [...this.sessions.values()].sort((a, b) => live(a) - live(b) || Date.parse(b.startedAt) - Date.parse(a.startedAt));
  }
}
