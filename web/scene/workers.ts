/*
 * The crew: one Worker per session or subagent, plus the stations they sit
 * at. Events become behaviour here: walking in from the elevator (remote
 * sandboxes to the cloud-room), typing, thinking, raising a hand
 * when the human is needed, flipping the desk when a test fails or when the
 * agent flips it itself through MCP, wearing the mood it set, shouting onto
 * the office TV. Each activity is held on screen for a minimum time so fast
 * tool bursts stay readable. draw() emits y-sorted draw calls for the scene.
 */
import type { AgentKind, Host, OfficeEvent, Snapshot, ToolCategory, WorkerState } from "../../src/shared/events.ts";
import { BRAND, IDLE_MS } from "../../src/shared/events.ts";
import { BRAND_ART, C, rgba, type ArtKey } from "./palette.ts";
import {
  Layout, WALL_H, CORRIDOR_Y, DESK_W, SEAT_W, LAPTOP_DX,
  benchDX, deskTop, routeFromSeat, routeToSeat, type Block, type Pt, type Seat,
} from "./layout.ts";
import { lookFor, silhouette, sprite, SPRITE_FOOT, SPRITE_W, type Dir, type Look, type Pose } from "./sprites.ts";
import * as P from "./props.ts";
import { podProps, SHOUT_MS, type Board } from "./room.ts";
import { Fx } from "./fx.ts";
import { bitmap, clamp, easeInOutCubic, easeOutCubic, hash, splitMood, type Bitmap } from "./util.ts";

export type { Board };

export type Act =
  | "idle" | "thinking" | "read" | "edit" | "bash" | "search" | "web" | "agent"
  | "todo" | "mcp" | "other" | "reply" | "waiting" | "error";

interface Show { kind: "flip" | "cheer" | "point" | "alarm"; t0: number; dur: number; side: number }

export interface Worker {
  id: string;
  agent: AgentKind;
  project: string;
  host?: Host;
  remote: boolean;
  cwd?: string;
  model?: string;
  role?: string;
  parentId?: string;
  intern: boolean;
  look: Look;
  seed: number;
  seat: Seat;
  x: number;
  y: number;
  dir: Dir;
  path: Pt[];
  speed: number;
  walkDist: number;
  onArrive?: () => void;
  walking: boolean;
  seated: boolean;
  /** 0 = sitting, 1 = standing next to the chair */
  stand: number;
  act: Act;
  actSince: number;
  summary: string;
  summaryAt: number;
  pending: { act: Act; summary?: string; at: number } | null;
  needsHuman: boolean;
  show: Show | null;
  /** the agent's own words for a flip it asked for through MCP */
  flipReason: string;
  /** status the agent set through MCP: one emoji and a short line */
  mood: { emoji: string; text: string; at: number } | null;
  shoutAt: number;
  bulbAt: number;
  stickies: number;
  stickyAt: number;
  alpha: number;
  leaving: boolean;
  gone: boolean;
  carrying: boolean;
  bornAt: number;
  lastEventAt: number;
  trinkets: [P.Trinket, P.Trinket];
  /** queued fx timers */
  nextFx: number;
  monSnap?: Bitmap;
  /** which flip side effects already fired */
  fxStage: number;
  /** when a leaving worker gets up and walks */
  leaveAt: number;
  leaveRoute: Pt[];
  /** route the worker is walking to its seat: how many points it had */
  toSeat: boolean;
}

const MIN_SHOW = 650;
const SLEEP_AFTER = 40_000;
const FLIP_DUR = 6400;
/** How far toward the camera a flipped desk lands, art px. */
const FLIP_OUT = 24;
const CHEER_DUR = 2600;
const POINT_DUR = 1700;
const ALARM_DUR = 4200;
const SHOUT_ICON_MS = 4200;
const AGENTS = Object.keys(BRAND) as AgentKind[];

export const zeroAgents = (): Record<AgentKind, number> => Object.fromEntries(AGENTS.map((a) => [a, 0])) as Record<AgentKind, number>;

function catAct(c?: ToolCategory): Act {
  switch (c) {
    case "read": return "read";
    case "edit": return "edit";
    case "bash": return "bash";
    case "search": return "search";
    case "web": return "web";
    case "agent": return "agent";
    case "todo": return "todo";
    case "mcp": return "mcp";
    default: return "other";
  }
}

function statusAct(s: WorkerState): Act {
  const age = Date.now() - Date.parse(s.lastTs);
  switch (s.status) {
    case "tool_start": return catAct(s.category);
    case "reply": return "reply";
    case "waiting": return "waiting";
    case "idle": return "idle";
    case "subagent_start": return "agent";
    default: return age > IDLE_MS ? "idle" : "thinking";
  }
}

/** Readable brand colour on dark: glows, rings, labels. */
export function brandInk(agent: AgentKind): string {
  return (BRAND_ART[agent] ?? BRAND_ART.claude).ink;
}

const isRemote = (h?: Host) => !!h && h.kind !== "local";
const OFFLINE = /^remote offline/i;

export interface DrawCall { y: number; fn: (g: CanvasRenderingContext2D) => void }

export class Crew {
  workers = new Map<string, Worker>();
  layout = new Layout();
  fx = new Fx();
  elevator = { x: 0, open: 0, hold: 0, ding: 0 };
  board: Board = { workers: 0, tools: 0, flips: 0, byAgent: zeroAgents(), spark: [], live: true, shouts: [] };
  /** remote hosts currently unreachable (host id) */
  offline = new Set<string>();
  /** tool calls per 2s bucket, for the TV sparkline and the rack */
  private bucketAt = 0;
  private bucket = 0;
  selected: string | null = null;
  hovered: string | null = null;
  private recentTools: number[] = [];
  /** Interns whose bubble waits its turn this frame (see takeTurns). */
  private hushed = new Set<string>();
  private lastPack = -1;

  constructor(private now: () => number) {}

  setElevatorX(x: number) {
    this.elevator.x = x;
  }

  /* -------------------------------------------------------------- input */

  clear() {
    this.workers.clear();
    this.layout.clear();
    this.offline.clear();
    this.fx.ps = [];
    this.fx.planes = [];
    this.board.shouts = [];
  }

  load(s: Snapshot) {
    this.clear();
    const now = this.now();
    const sorted = [...s.workers].sort((a, b) => Number(!!a.parentId) - Number(!!b.parentId));
    let tools = 0;
    for (const ws of sorted) {
      const w = this.spawn(ws, now, false);
      w.act = statusAct(ws);
      w.summary = ws.summary ?? "";
      w.summaryAt = now - 10_000;
      w.needsHuman = ws.status === "waiting";
      if (w.act === "waiting") w.stand = 1;
      if (ws.mood) {
        const m = splitMood(ws.mood);
        const text = m.text || (ws.status === "status" ? ws.summary ?? "" : "");
        if (m.emoji || text) w.mood = { emoji: m.emoji, text, at: now - 10_000 };
      }
      tools += ws.toolCalls;
    }
    // optional host list (a server may report remotes that are down)
    const hosts = (s as Snapshot & { hosts?: { host?: Host; id?: string; kind?: string; name?: string; online?: boolean; status?: string }[] }).hosts;
    if (Array.isArray(hosts)) {
      for (const h of hosts) {
        const host: Host | undefined = h.host ?? (h.id && h.kind ? { id: h.id, kind: h.kind as Host["kind"], name: h.name ?? h.id } : undefined);
        const down = h.online === false || (typeof h.status === "string" && /off|down|error/i.test(h.status));
        if (host && isRemote(host) && down) this.markOffline(host, true);
      }
    }
    this.board.tools = tools;
    this.board.flips = s.recent.filter((e) => e.kind === "test_fail" || e.kind === "flip").length;
    this.board.live = !s.demo;
    this.board.spark = new Array(30).fill(0);
    const t0 = Date.now();
    for (const e of s.recent) {
      if (e.kind === "tool_start") {
        const age = (t0 - Date.parse(e.ts)) / 2000;
        if (age >= 0 && age < 30) this.board.spark[29 - Math.floor(age)]++;
      }
      if (e.kind === "shout" && e.summary && t0 - Date.parse(e.ts) < SHOUT_MS) this.board.shouts.push({ text: e.summary, agent: e.agent, t0: now - (t0 - Date.parse(e.ts)) });
      if (e.kind === "error" && e.host && OFFLINE.test(e.summary ?? "")) this.markOffline(e.host, true);
    }
  }

  private markOffline(host: Host, down: boolean) {
    if (down) this.offline.add(host.id);
    else this.offline.delete(host.id);
  }

  private spawn(e: Pick<OfficeEvent, "workerId" | "agent" | "project" | "parentId" | "role" | "cwd" | "model" | "host">, now: number, arrive: boolean): Worker {
    const parent = e.parentId ? this.workers.get(e.parentId) : undefined;
    const intern = !!e.parentId;
    const host = e.host ?? parent?.host;
    const seat = parent && !parent.intern
      ? this.layout.allocIntern(e.workerId, parent.id, e.agent, e.project, host, now)
      : this.layout.allocMain(e.workerId, e.agent, e.project, host, now);
    const remote = seat.remote;
    const seed = hash(e.workerId);
    const w: Worker = {
      id: e.workerId, agent: e.agent, project: e.project, host, remote, cwd: e.cwd, model: e.model, role: e.role, parentId: e.parentId,
      intern, look: lookFor(e.workerId, e.agent, intern), seed, seat,
      x: seat.x, y: seat.y, dir: "up", path: [], speed: 44, walkDist: 0, walking: false, seated: true, stand: 0,
      act: "thinking", actSince: now, summary: "", summaryAt: 0, pending: null, needsHuman: false, show: null,
      flipReason: "", mood: null, shoutAt: -1e9,
      bulbAt: -1e9, stickies: 0, stickyAt: 0, alpha: 1, leaving: false, gone: false, carrying: false,
      bornAt: now, lastEventAt: now, trinkets: P.trinketsFor(seed), nextFx: 0, fxStage: 0, leaveAt: 0, leaveRoute: [],
      toSeat: false,
    };
    if (arrive) {
      const door = { x: this.elevator.x, y: WALL_H + 1 };
      w.x = door.x; w.y = door.y; w.dir = "down";
      w.alpha = 0;
      w.seated = false;
      w.stand = 1;
      this.callElevator(now);
      this.walkTo(w, routeToSeat(this.layout, door, seat), () => this.sitDown(w));
      w.toSeat = true;
      w.walking = false; // waits for the doors
    }
    this.workers.set(w.id, w);
    return w;
  }

  private walkTo(w: Worker, pts: Pt[], done?: () => void) {
    w.path = pts.slice();
    w.speed = walkSpeed(w, w.path);
    w.walking = true;
    w.seated = false;
    w.onArrive = done;
  }

  private sitDown(w: Worker) {
    w.walking = false;
    w.toSeat = false;
    w.dir = "up";
    w.seated = true;
  }

  private callElevator(now: number) {
    this.elevator.hold = Math.max(this.elevator.hold, now + 1900);
    if (now - this.elevator.ding > 900) {
      this.elevator.ding = now;
      this.fx.ding(this.elevator.x, WALL_H - 52);
    }
  }

  apply(e: OfficeEvent) {
    const now = this.now();
    // a remote that dropped: dim its people, never spawn a worker for the notice
    if (e.host && isRemote(e.host)) {
      if (e.kind === "error" && OFFLINE.test(e.summary ?? "")) {
        this.markOffline(e.host, true);
        if (!this.workers.has(e.workerId)) return;
      } else this.markOffline(e.host, false);
    }
    if (e.kind === "session_start" && e.replaces && e.replaces !== e.workerId) this.takeOver(e.replaces, e.workerId, now);
    let w = this.workers.get(e.workerId);
    if (e.kind === "tool_start") {
      this.board.tools++;
      this.bucket++;
      this.recentTools.push(now);
    }
    if (!w) {
      if (e.kind === "session_end" || e.kind === "subagent_end" || e.kind === "idle") return;
      // a parent announcing its subagent is not the subagent itself
      if (e.kind === "subagent_start" && !e.parentId) return;
      w = this.spawn(e, now, true);
      if (e.parentId && e.kind !== "subagent_start") this.parentPoints(e.parentId, now);
    }
    w.lastEventAt = now;
    if (e.cwd) w.cwd = e.cwd;
    if (e.model) w.model = e.model;
    if (e.role) w.role = e.role;
    switch (e.kind) {
      case "session_start":
        break;
      case "subagent_start":
        if (e.parentId) this.parentPoints(e.parentId, now);
        break;
      case "prompt": {
        w.needsHuman = false;
        const tx = w.seat.deskX + DESK_W / 2, ty = w.seat.deskY - 4;
        const fromLeft = (w.seed & 1) === 0;
        const id = e.workerId;
        this.fx.plane(tx + (fromLeft ? -190 : 190), ty - 150, tx, ty, now, () => {
          const ww = this.workers.get(id);
          if (!ww) return;
          this.fx.stars(ww.seat.deskX + DESK_W / 2, ww.seat.deskY - 4, C.white);
          this.setAct(ww, "thinking", "new prompt", this.now(), true);
        });
        this.setAct(w, w.act === "waiting" || w.act === "idle" ? "thinking" : w.act, "prompt incoming", now, true);
        break;
      }
      case "thinking":
        this.setAct(w, "thinking", e.summary, now);
        break;
      case "tool_start": {
        const a = catAct(e.category);
        if (a === "todo") { w.stickies = Math.min(4, w.stickies + 1); w.stickyAt = now; }
        this.setAct(w, a, e.summary ?? e.tool, now);
        break;
      }
      case "tool_end":
        if (e.isError) {
          const m = this.monitorPos(w);
          this.fx.smoke(m.x + 12, m.y + 2, 4, true);
        }
        this.setAct(w, "thinking", undefined, now);
        break;
      case "reply":
        this.setAct(w, "reply", e.summary, now);
        break;
      case "waiting":
        w.needsHuman = true;
        this.setAct(w, "waiting", e.summary || "needs you", now, true);
        break;
      case "idle":
        this.setAct(w, "idle", undefined, now);
        break;
      case "error":
        this.startShow(w, "alarm", now);
        this.setAct(w, "error", e.summary || "error", now, true);
        break;
      case "test_fail":
        this.board.flips++;
        w.flipReason = "";
        this.startShow(w, "flip", now);
        w.summary = e.summary || "tests failed";
        w.summaryAt = now;
        break;
      case "flip":
        // the agent flipped its own table: same drama, its own words
        this.board.flips++;
        w.flipReason = (e.summary ?? "").trim();
        this.startShow(w, "flip", now);
        if (e.summary) { w.summary = e.summary; w.summaryAt = now; }
        break;
      case "test_pass":
        this.startShow(w, "cheer", now);
        w.summary = e.summary || "tests passed";
        w.summaryAt = now;
        break;
      case "celebrate":
        this.startShow(w, "cheer", now);
        this.fx.confetti(w.x, w.y - 34, [C.gold3, C.pink, C.blue5, C.green4, C.white, brandInk(w.agent)]);
        if (e.summary) { w.summary = e.summary; w.summaryAt = now; }
        break;
      case "status": {
        const m = splitMood(e.summary);
        const emoji = (e.tool && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(e.tool) ? e.tool : "") || m.emoji;
        const text = m.text;
        w.mood = emoji || text ? { emoji, text, at: now } : null;
        this.fx.stars(w.x, w.y - 30, brandInk(w.agent));
        break;
      }
      case "shout":
        if (e.summary) {
          this.board.shouts.push({ text: e.summary, agent: e.agent, t0: now });
          if (this.board.shouts.length > 6) this.board.shouts.shift();
        }
        w.shoutAt = now;
        break;
      case "subagent_end":
      case "session_end":
        this.leave(w, now);
        if (e.kind === "session_end") for (const k of this.workers.values()) if (k.parentId === w.id) this.leave(k, now);
        break;
    }
  }

  /**
   * OfficeEvent.replaces: a hired worker ("ctl:<id>") or one seen launching
   * ("proc:<pid>") becomes its real session in place. Same sprite, desk,
   * selection and interns; no walk out and back in. If both already exist the
   * placeholder simply leaves.
   */
  private takeOver(from: string, to: string, now: number) {
    const w = this.workers.get(from);
    if (!w) return;
    if (this.workers.has(to)) { this.leave(w, now); return; }
    this.workers.delete(from);
    w.id = to;
    this.workers.set(to, w);
    this.layout.rename(from, to);
    for (const k of this.workers.values()) if (k.parentId === from) k.parentId = to;
    if (this.selected === from) this.selected = to;
    if (this.hovered === from) this.hovered = to;
  }

  private parentPoints(parentId: string, now: number) {
    const p = this.workers.get(parentId);
    if (!p || p.walking || p.leaving) return;
    if (p.show && p.show.kind !== "point") return;
    this.startShow(p, "point", now);
  }

  private startShow(w: Worker, kind: Show["kind"], now: number) {
    if (w.walking || w.leaving) return;
    if (w.show?.kind === "flip" && kind !== "flip") return;
    const dur = kind === "flip" ? FLIP_DUR : kind === "cheer" ? CHEER_DUR : kind === "point" ? POINT_DUR : ALARM_DUR;
    const side = this.elevator.x < w.x ? -1 : 1;
    w.show = { kind, t0: now, dur, side: kind === "point" ? side : (w.seed & 2 ? 1 : -1) };
    if (kind === "cheer") {
      const b = BRAND_ART[w.agent] ?? BRAND_ART.claude;
      const cols = b.main === b.ink ? [b.main, b.light, b.pale, C.gold3, C.white] : [b.ink, C.slate4, C.gold3, C.white];
      this.fx.confetti(w.x, w.y - 30, cols);
    }
    if (kind === "flip") {
      const snap = bitmap(P.MON_W, P.MON_H + 3);
      P.monitorFrame(snap.g, 0, 0, this.artOf(w));
      P.drawScreen(snap.g, 2, 2, P.SCR_W, P.SCR_H, "fail", w.agent, 0, w.seed);
      w.monSnap = snap;
    }
    if (kind === "alarm") {
      const m = this.monitorPos(w);
      this.fx.smoke(m.x + 12, m.y, 12);
    }
  }

  private leave(w: Worker, now: number) {
    if (w.leaving) return;
    w.leaving = true;
    w.show = null;
    w.needsHuman = false;
    w.pending = null;
    w.carrying = !w.intern;
    const door = { x: this.elevator.x, y: WALL_H + 1 };
    const atSeat = !w.walking && Math.abs(w.x - w.seat.x) < 1;
    w.leaveRoute = atSeat ? routeFromSeat(this.layout, w.seat, door) : [{ x: w.x, y: CORRIDOR_Y }, { x: door.x, y: CORRIDOR_Y }, door];
    w.path = [];
    w.walking = false;
    w.toSeat = false;
    w.seated = false;
    // stand up and pack first
    w.leaveAt = now + (w.intern ? 250 : 800);
  }

  private setAct(w: Worker, act: Act, summary: string | undefined, now: number, force = false) {
    if (w.leaving) return;
    if (!force && w.act !== act && now - w.actSince < MIN_SHOW) {
      w.pending = { act, summary, at: w.actSince + MIN_SHOW };
      return;
    }
    this.commitAct(w, act, summary, now);
  }

  private commitAct(w: Worker, act: Act, summary: string | undefined, now: number) {
    if (w.act === "thinking" && act !== "thinking" && act !== "idle" && act !== "waiting" && now - w.actSince > 500) w.bulbAt = now;
    if (act !== "waiting" && act !== "idle") w.needsHuman = false;
    if (w.act !== act) w.actSince = now;
    w.act = act;
    w.pending = null;
    if (summary) { w.summary = summary; w.summaryAt = now; }
  }

  /* ------------------------------------------------------------- update */

  artOf(w: Worker): ArtKey {
    return w.seat.st.agent ?? w.seat.block.agent;
  }

  monitorPos(w: Worker): Pt {
    if (w.seat.kind === "intern") return { x: w.seat.x - 5, y: w.seat.deskY - 4 };
    return { x: w.seat.deskX + 6, y: w.seat.deskY - 13 };
  }

  activity(): number {
    const now = this.now();
    this.recentTools = this.recentTools.filter((t) => now - t < 20_000);
    return clamp(this.recentTools.length / 40, 0, 1);
  }

  update(dt: number) {
    const now = this.now();
    const s = dt / 1000;
    if (now - this.bucketAt > 2000) {
      this.bucketAt = now;
      this.board.spark.push(this.bucket);
      if (this.board.spark.length > 40) this.board.spark.shift();
      this.bucket = 0;
    }
    this.layout.update(dt, now);
    // pods reflowed: walkers heading to a seat follow it
    if (this.layout.packs !== this.lastPack) {
      this.lastPack = this.layout.packs;
      for (const w of this.workers.values()) {
        if (!w.toSeat || w.leaving || !w.path.length) continue;
        const full = routeToSeat(this.layout, { x: this.elevator.x, y: WALL_H + 1 }, w.seat);
        w.path = full.slice(Math.max(0, full.length - w.path.length));
        // A brand-new desk had no position when the walk was planned: pace the walk again now it has one.
        w.speed = walkSpeed(w, w.path);
      }
    }
    const el = this.elevator;
    const want = now < el.hold ? 1 : 0;
    el.open += clamp(want - el.open, -s * 2.6, s * 2.6);

    let count = 0;
    let waiting = 0;
    const by = zeroAgents();
    for (const w of [...this.workers.values()]) {
      if (!w.leaving) { count++; by[w.agent] = (by[w.agent] ?? 0) + 1; }
      if (!w.leaving && w.needsHuman && !w.intern) waiting++;
      if (w.path.length && !w.walking && !w.leaving && el.open > 0.7) w.walking = true;
      if (w.alpha < 1 && !w.gone && (el.open > 0.6 || !w.path.length)) w.alpha = Math.min(1, w.alpha + s * 3);
      if (w.gone) {
        w.alpha -= s * 2.2;
        if (w.alpha <= 0) {
          this.workers.delete(w.id);
          this.layout.free(w.id, now);
          if (this.selected === w.id) this.selected = null;
        }
        continue;
      }
      if (w.leaveAt && now >= w.leaveAt) {
        w.leaveAt = 0;
        this.walkTo(w, w.leaveRoute, () => {
          w.walking = false;
          w.dir = "up";
          this.callElevator(this.now());
          w.gone = true;
        });
      }
      if (w.walking) this.step(w, s);
      const standing = w.walking || !w.seated || w.act === "waiting" || (w.show && w.show.kind !== "alarm" && this.showStanding(w, now));
      w.stand = clamp(w.stand + (standing ? 1 : -1) * s * 6, 0, 1);
      if (!w.walking && w.seated) {
        w.x = w.seat.x;
        w.y = w.seat.y + (w.seated ? w.stand * 4 : 0);
      }
      if (w.show && now - w.show.t0 >= w.show.dur) {
        w.show = null;
        if (w.act === "error") w.act = "thinking";
      }
      if (w.pending && !w.show && now >= w.pending.at) this.commitAct(w, w.pending.act, w.pending.summary, now);
      if (w.stickies && now - w.stickyAt > 25_000 && w.act !== "todo") w.stickies = 0;
      this.ambientFx(w, now);
    }
    this.board.workers = count;
    this.board.waiting = waiting;
    this.board.byAgent = by;
    this.board.shouts = this.board.shouts.filter((x) => now - x.t0 < SHOUT_MS * 3);
    this.fx.update(dt, now);
  }

  private showStanding(w: Worker, now: number): boolean {
    const sh = w.show!;
    const t = now - sh.t0;
    if (sh.kind === "flip") return t < 5000;
    if (sh.kind === "cheer") return t < CHEER_DUR - 300;
    if (sh.kind === "point") return t < POINT_DUR - 250;
    return false;
  }

  private step(w: Worker, s: number) {
    if (!Number.isFinite(w.speed) || w.speed <= 0) w.speed = walkSpeed(w, w.path);
    if (w.path.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return; // the desk isn't placed yet
    let move = w.speed * s;
    while (move > 0 && w.path.length) {
      const t = w.path[0];
      const dx = t.x - w.x, dy = t.y - w.y;
      const d = Math.abs(dx) + Math.abs(dy);
      if (d < 0.01) { w.path.shift(); continue; }
      if (Math.abs(dx) > 0.01) w.dir = dx > 0 ? "right" : "left";
      else w.dir = dy > 0 ? "down" : "up";
      const m = Math.min(move, d);
      if (Math.abs(dx) > 0.01) w.x += Math.sign(dx) * Math.min(m, Math.abs(dx));
      else w.y += Math.sign(dy) * Math.min(m, Math.abs(dy));
      w.walkDist += m;
      move -= m;
    }
    if (!w.path.length) {
      w.walking = false;
      const cb = w.onArrive;
      w.onArrive = undefined;
      cb?.();
    }
  }

  private ambientFx(w: Worker, now: number) {
    if (now < w.nextFx || w.walking) return;
    const m = this.monitorPos(w);
    const sh = w.show;
    if (sh?.kind === "alarm") {
      this.fx.smoke(m.x + 12, m.y, 2);
      w.nextFx = now + 500;
      return;
    }
    switch (w.act) {
      case "edit":
        if (w.seated) this.fx.key(w.seat.deskX + 18, w.seat.deskY + 4, brandInk(w.agent));
        w.nextFx = now + 140 + (w.seed % 60);
        return;
      case "bash":
        if (w.seated && Math.random() < 0.3) this.fx.key(w.seat.deskX + 18, w.seat.deskY + 4, C.green4);
        w.nextFx = now + 300;
        return;
      case "idle": {
        const mug = w.seat.kind === "main" ? w.seat.deskX + 3 : w.seat.x + 6;
        this.fx.steam(mug, w.seat.deskY - 4);
        if (now - w.actSince > SLEEP_AFTER && w.seated) this.fx.zzz(w.x + 4, w.y - 24);
        w.nextFx = now + (now - w.actSince > SLEEP_AFTER ? 1100 : 380);
        return;
      }
      default:
        w.nextFx = now + 400;
    }
  }

  /** Called every frame by the scene to fire the flip's sparks, papers and shakes on cue. */
  showFx(now: number, onShake: (amt: number) => void) {
    for (const w of this.workers.values()) {
      const sh = w.show;
      if (!sh || sh.kind !== "flip") { w.fxStage = 0; continue; }
      const t = now - sh.t0;
      const m = this.monitorPos(w);
      if (t >= 600 && w.fxStage < 1) {
        this.fx.sparks(m.x + 12, m.y + 6, 34);
        this.fx.papers(w.seat.deskX + 18, w.seat.deskY + 2, 10);
        for (let i = 0; i < 10; i++) this.fx.key(w.seat.deskX + 18, w.seat.deskY + 4, i % 2 ? C.white : C.slate4);
        onShake(9);
        w.fxStage = 1;
      } else if (t >= 1350 && w.fxStage < 2) {
        this.fx.smoke(w.seat.deskX + 18 + sh.side * 6, w.seat.deskY + 2, 10);
        this.fx.sparks(m.x + 12 + sh.side * 30, m.y + 24, 18);
        onShake(4);
        w.fxStage = 2;
      } else if (t >= 4800 && w.fxStage < 3) {
        this.fx.smoke(w.seat.deskX + 18, w.seat.deskY + 12, 6);
        w.fxStage = 3;
      }
    }
  }

  /* --------------------------------------------------------------- draw */

  screenOf(w: Worker | undefined, now: number): P.Screen {
    if (!w) return "off";
    if (w.walking && !w.seated) return now - w.bornAt < 400 ? "off" : "boot";
    if (w.leaving) return "off";
    if (w.remote && this.offline.has(w.host!.id)) return "off";
    if (w.show?.kind === "flip") return "fail";
    if (w.show?.kind === "cheer") return "pass";
    if (w.show?.kind === "alarm") return "error";
    switch (w.act) {
      case "idle": return "idle";
      case "thinking": return "thinking";
      case "error": return "error";
      default: return w.act;
    }
  }

  pose(w: Worker, now: number): { pose: Pose; dir: Dir; frame: number } {
    const sh = w.show;
    if (w.walking || (w.path.length && !w.seated)) {
      const frame = Math.floor(w.walkDist / 4) & 3;
      return { pose: w.carrying ? "carry" : "walk", dir: w.dir, frame: w.walking ? frame : 0 };
    }
    if (w.gone) return { pose: "stand", dir: "up", frame: 0 };
    if (sh) {
      const t = now - sh.t0;
      if (sh.kind === "flip") {
        if (t < 250) return { pose: "stand", dir: "up", frame: 0 };
        if (t < 600) return { pose: "grab", dir: "up", frame: 0 };
        if (t < 950) return { pose: "flip", dir: "up", frame: 0 };
        if (t < 1900) return { pose: "cheer", dir: "down", frame: Math.floor(t / 140) & 1 };
        if (t < 3900) return { pose: "stand", dir: "down", frame: 0 };
        if (t < 4900) return { pose: "grab", dir: "up", frame: 0 };
      } else if (sh.kind === "cheer" && t < CHEER_DUR - 300) {
        return { pose: "cheer", dir: "down", frame: Math.floor(t / 180) & 1 };
      } else if (sh.kind === "point" && t < POINT_DUR - 250) {
        return { pose: "point", dir: sh.side < 0 ? "left" : "right", frame: 0 };
      }
    }
    if (w.act === "waiting" && w.stand > 0.5) return { pose: "raise", dir: "down", frame: Math.floor(now / 380) & 1 };
    if (!w.seated) return { pose: "stand", dir: "up", frame: 0 };
    if (w.stand > 0.5) return { pose: "stand", dir: "down", frame: 0 };
    switch (w.act) {
      case "edit": return { pose: "type", dir: "up", frame: Math.floor(now / 90 + w.seed) % 3 };
      case "bash": case "reply": case "other": return { pose: "type", dir: "up", frame: Math.floor(now / 150 + w.seed) % 3 };
      case "search": case "agent": case "todo": case "mcp": return { pose: "type", dir: "up", frame: Math.floor(now / 260 + w.seed) % 3 };
      case "thinking": return { pose: "think", dir: "up", frame: Math.floor(now / 700 + w.seed) & 1 };
      case "idle": return { pose: now - w.actSince > SLEEP_AFTER ? "sleep" : "lean", dir: "up", frame: 0 };
      default: return { pose: "sit", dir: "up", frame: 0 };
    }
  }

  /** Where the worker's head is (world), for labels and bubbles. */
  headPos(w: Worker): Pt {
    const pose = this.pose(w, this.now());
    const seated = pose.pose === "sit" || pose.pose === "type" || pose.pose === "think" || pose.pose === "lean" || pose.pose === "sleep";
    const top = (seated ? 6 : 3) + (w.intern ? 2 : 0);
    return { x: Math.round(w.x), y: Math.round(w.y) - SPRITE_FOOT + top };
  }

  draw(out: DrawCall[], over: DrawCall[], now: number) {
    this.takeTurns(now);
    for (const b of this.layout.blocks.values()) this.drawBlock(out, b, now);
    for (const w of this.workers.values()) {
      const y = w.y;
      out.push({ y: y + (w.walking ? 0.2 : 0), fn: (g) => this.drawWorker(g, w, now) });
      if (!w.walking && !w.gone) over.push({ y, fn: (g) => this.drawOverhead(g, w, now) });
    }
  }

  /**
   * Interns in one pod saying the same kind of thing at once (all thinking, all
   * replying) take turns: one bubble per kind per pod at a time, rotating, so a
   * busy bench reads as a conversation instead of a row of identical bubbles.
   */
  private takeTurns(now: number) {
    this.hushed.clear();
    const groups = new Map<string, Worker[]>();
    for (const w of this.workers.values()) {
      if (!w.intern || w.leaving || w.walking || !w.seated || w.stand > 0.5 || w.mood) continue;
      if (w.act !== "thinking" && w.act !== "reply") continue;
      const k = `${w.seat.block.key}|${w.act}`;
      const g = groups.get(k);
      if (g) g.push(w);
      else groups.set(k, [w]);
    }
    for (const [k, g] of groups) {
      if (g.length < 2) continue;
      g.sort((a, b) => a.seat.x - b.seat.x);
      const turn = Math.floor(now / 1400 + (hash(k) % 5)) % g.length;
      g.forEach((w, i) => { if (i !== turn) this.hushed.add(w.id); });
    }
  }

  private occupant(id: string | null | undefined): Worker | undefined {
    return id ? this.workers.get(id) : undefined;
  }

  private drawBlock(out: DrawCall[], b: Block, now: number) {
    const podKey: ArtKey = b.agent;
    const a = b.alpha;
    const wrap = (fn: (g: CanvasRenderingContext2D) => void) => (g: CanvasRenderingContext2D) => {
      if (a < 1) g.globalAlpha = a;
      fn(g);
      g.globalAlpha = 1;
    };
    for (const st of b.stations) {
      const dx = Math.round(b.x + st.x);
      const dy = deskTop(b, st);
      // In a pod two agents share (and in the cloud-room), each desk is in its own agent's colours.
      const key: ArtKey = st.agent ?? podKey;
      if (st.hot) {
        // a shared hot desk: just the bench, its laptops and stools
        this.pushBench(out, wrap, st, key, b.agent, dx, dy, now);
        continue;
      }
      const occ = this.occupant(st.main);
      const seated = occ && occ.seated && !occ.leaving && !occ.walking;
      const flipping = occ?.show?.kind === "flip" ? occ : undefined;
      if (flipping) {
        const t = now - flipping.show!.t0;
        const air = t > 550 && t < 1400 || t > 3850 && t < 4850;
        // Landed, the upturned desk lies in front of its worker: drawn after them.
        const down = t >= 1100 && t < 4300;
        out.push({ y: air ? 1e5 : down ? dy + FLIP_OUT + 20 : dy + 4, fn: (g) => this.drawFlippingDesk(g, flipping, key, dx, dy, now) });
        out.push({ y: air ? 1e5 + 1 : dy + 30, fn: (g) => this.drawFlyingMonitor(g, flipping, dx + 6, dy - 13, now) });
      } else out.push({ y: dy + 14, fn: wrap((g) => this.drawDesk(g, key, b.agent, dx, dy, occ, !!seated, now)) });
      const chairOff = occ ? Math.round(occ.stand * (flipping ? 9 : 7)) : 0;
      const sx = dx + DESK_W / 2 + chairOff, sy = dy + 26;
      out.push({ y: sy + 0.5, fn: wrap((g) => P.chair(g, sx, sy, key, !(seated && occ!.stand < 0.5))) });
      if (st.seats > 0) this.pushBench(out, wrap, st, key, b.agent, dx, dy, now);
    }
    for (const pr of podProps(b)) {
      out.push({ y: pr.y, fn: wrap((g) => P.podProp(g, pr.kind, pr.x, pr.y, hash(b.key) + pr.x, now)) });
    }
  }


  private drawDesk(g: CanvasRenderingContext2D, key: ArtKey, agent: AgentKind, x: number, y: number, occ: Worker | undefined, seated: boolean, now: number) {
    const body = P.deskBody(key);
    P.floorShadow(g, x, y + 14, DESK_W, 6);
    const mx = x + 6, my = y - 13;
    g.drawImage(body.c, x, y);
    const scr = seated || (occ && !occ.leaving && occ.stand > 0) ? this.screenOf(occ, now) : occ && !occ.leaving ? "boot" : "off";
    const screenAgent = occ?.agent ?? agent;
    P.monitorFrame(g, mx, my, key);
    P.drawScreen(g, mx + 2, my + 2, P.SCR_W, P.SCR_H, scr, screenAgent, now, occ?.seed ?? 0);
    const typing = !!occ && seated && (occ.act === "edit" || occ.act === "bash" || occ.act === "other" || occ.act === "reply");
    P.keyboard(g, x + 9, y + 5, key, typing, now, occ?.seed ?? 0);
    if (occ && !occ.leaving) {
      P.trinket(g, occ.trinkets[0], x + 2, y + 8, occ.seed, now);
      P.trinket(g, occ.trinkets[1], x + 30, y + 8, occ.seed + 1, now);
      if (occ.stickies) P.stickies(g, mx, my, occ.stickies);
      if (occ.act === "read" && seated) {
        g.fillStyle = C.white; g.fillRect(x + 25, y + 2, 7, 4);
        g.fillStyle = C.slate4; g.fillRect(x + 28, y + 2, 1, 4); g.fillRect(x + 26, y + 3, 2, 1); g.fillRect(x + 30, y + 3, 1, 1);
      }
      if (occ.show?.kind === "alarm") P.alarmLight(g, x + 30, y + 3, now);
    }
  }

  /**
   * The desk goes up, over and toward the camera, and lands legs-up in front of the worker
   * (┻━┻ in the open, clear of the pod sign above), bounces once, and is put back later.
   */
  private drawFlippingDesk(g: CanvasRenderingContext2D, w: Worker, key: ArtKey, x: number, y: number, now: number) {
    const body = P.deskBody(key);
    const t = now - w.show!.t0;
    const side = w.show!.side;
    let p = 0;
    if (t < 600) p = 0;
    else if (t < 1350) p = easeOutCubic((t - 600) / 750);
    else if (t < 3900) p = 1;
    else if (t < 4800) p = 1 - easeInOutCubic((t - 3900) / 900);
    const shakeY = t >= 250 && t < 600 ? (Math.floor(t / 50) % 2 ? -1 : 0) : 0;
    const lift = Math.sin(p * Math.PI) * 30;
    // one bounce on landing
    const bounce = t >= 1350 && t < 1650 ? Math.sin(((t - 1350) / 300) * Math.PI) * 3 : 0;
    const cx = x + DESK_W / 2 + side * p * 4;
    const cy = y + 9 - lift + p * FLIP_OUT - bounce + shakeY;
    const sy = Math.cos(p * Math.PI);
    const rot = Math.sin(p * Math.PI) * 0.35 * side;
    const bm = sy >= 0 ? body : P.deskUnderside(key);
    const sc = Math.max(0.14, Math.abs(sy));
    // its shadow on the floor where it will land
    g.fillStyle = "rgba(14,13,22,0.28)";
    const sw = Math.round(30 - lift * 0.4);
    g.fillRect(Math.round(cx - sw / 2), y + 14 + Math.round(p * FLIP_OUT) + 6, sw, 3);
    g.save();
    g.translate(Math.round(cx), Math.round(cy));
    g.rotate(rot);
    g.scale(1, sc);
    if (sy < 0) {
      // upside down it's mostly underside: a light rim keeps the ┻━┻ readable on any rug or deck
      const sil = silhouette(bm, "rgba(255,244,230,0.85)");
      for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) g.drawImage(sil.c, -DESK_W / 2 + ox, -10 + oy);
    }
    g.drawImage(bm.c, -DESK_W / 2, -10);
    g.restore();
    if (t >= 4800) P.keyboard(g, x + 9, y + 5, key, false, now, w.seed);
  }

  /** The monitor takes its own arc and lands face down on the floor beside the chair. */
  private drawFlyingMonitor(g: CanvasRenderingContext2D, w: Worker, mx: number, my: number, now: number) {
    const snap = w.monSnap;
    if (!snap) return;
    const t = now - w.show!.t0;
    const side = w.show!.side;
    let q = 0;
    if (t >= 600 && t < 1300) q = easeOutCubic((t - 600) / 700);
    else if (t >= 1300 && t < 3900) q = 1;
    else if (t >= 3900 && t < 4800) q = 1 - easeInOutCubic((t - 3900) / 900);
    const mlift = Math.sin(q * Math.PI) * 48;
    const mcx = mx + 12 + side * q * 34;
    const mcy = my + 8 - mlift + q * 36;
    if (q > 0.05) {
      g.fillStyle = "rgba(14,13,22,0.25)";
      g.fillRect(Math.round(mcx - 10), Math.round(my + 8 + q * 36 + 7), 20, 2);
    }
    g.save();
    g.translate(Math.round(mcx), Math.round(mcy));
    g.rotate(q * side * (Math.PI * 2 + 0.35));
    g.drawImage(snap.c, -12, -9);
    g.restore();
  }

  /** A station's intern bench (or a hot desk) and its stools, into the y-sorted pass. */
  private pushBench(out: DrawCall[], wrap: (fn: (g: CanvasRenderingContext2D) => void) => (g: CanvasRenderingContext2D) => void, st: Block["stations"][number], key: ArtKey, agent: AgentKind, dx: number, dy: number, now: number) {
    const bx = dx + benchDX(st);
    const n = Math.max(1, st.seats);
    const occs = st.interns.slice(0, n).map((id) => this.occupant(id));
    out.push({ y: dy + 15, fn: wrap((g) => this.drawBench(g, key, agent, bx, dy, n, occs, now, !!st.hot)) });
    for (let k = 0; k < n; k++) {
      const ix = bx + (SEAT_W >> 1) + k * SEAT_W, iy = dy + 25;
      out.push({ y: iy + 0.5, fn: wrap((g) => P.stool(g, ix, iy, key)) });
    }
  }

  private drawBench(g: CanvasRenderingContext2D, key: ArtKey, agent: AgentKind, x: number, y: number, seats: number, occ: (Worker | undefined)[], now: number, hot = false) {
    const b = P.benchBody(key, seats, hot);
    P.floorShadow(g, x, y + 15, b.w, 5);
    g.drawImage(b.c, x, y);
    for (let k = 0; k < seats; k++) {
      const o = occ[k];
      const lx = x + LAPTOP_DX + k * SEAT_W, ly = y - 4;
      P.laptop(g, lx, ly, key);
      const on = o && !o.leaving && (o.seated || o.stand > 0);
      P.drawScreen(g, lx + 1, ly + 1, 8, 5, on ? this.screenOf(o, now) : "off", o?.agent ?? agent, now, o?.seed ?? 3);
    }
  }

  private drawWorker(g: CanvasRenderingContext2D, w: Worker, now: number) {
    const { pose, dir, frame } = this.pose(w, now);
    const spr = sprite(w.look, pose, dir, frame);
    const x = Math.round(w.x) - (SPRITE_W >> 1);
    const y = Math.round(w.y) - SPRITE_FOOT;
    let alpha = clamp(w.alpha, 0, 1);
    if (w.remote && w.host && this.offline.has(w.host.id)) alpha *= 0.55;
    g.globalAlpha = alpha;
    g.fillStyle = "rgba(14,13,22,0.35)";
    g.fillRect(x + 4, Math.round(w.y), 10, 1);
    g.fillRect(x + 5, Math.round(w.y) + 1, 8, 1);
    const sel = this.selected === w.id;
    const hov = this.hovered === w.id && !sel;
    if (sel) {
      const col = brandInk(w.agent);
      const k = Math.floor(now / 160) % 2;
      const fx = Math.round(w.x), fy = Math.round(w.y);
      const rx = 9 + k, ry = 3;
      g.fillStyle = col;
      for (let i = -rx; i <= rx; i++) {
        const dy = Math.round(ry * Math.sqrt(Math.max(0, 1 - (i * i) / (rx * rx))));
        g.fillRect(fx + i, fy + dy, 1, 1);
        g.fillRect(fx + i, fy - dy, 1, 1);
      }
    }
    if (sel || hov) {
      const col = sel ? brandInk(w.agent) : C.white;
      const sil = silhouette(spr, col);
      g.globalAlpha = (sel ? 0.75 + 0.25 * Math.sin(now * 0.008) : 0.6) * alpha;
      g.drawImage(sil.c, x - 1, y); g.drawImage(sil.c, x + 1, y); g.drawImage(sil.c, x, y - 1); g.drawImage(sil.c, x, y + 1);
      g.globalAlpha = alpha;
    }
    const box = w.carrying && w.walking;
    if (box && dir === "up") P.box(g, Math.round(w.x) - 5, Math.round(w.y) - 17);
    g.drawImage(spr.c, x, y);
    if (box && dir !== "up") P.box(g, Math.round(w.x) - 5, Math.round(w.y) - 13);
    g.globalAlpha = 1;
  }

  /** Bubbles and icons above the worker's head and monitor. */
  private drawOverhead(g: CanvasRenderingContext2D, w: Worker, now: number) {
    if (w.alpha < 0.9 || w.leaving) return;
    g.globalAlpha = clamp((now - w.actSince) / 220, 0.25, 1);
    this.overhead(g, w, now);
    g.globalAlpha = 1;
  }

  private overhead(g: CanvasRenderingContext2D, w: Worker, now: number) {
    const h = this.headPos(w);
    const m = this.monitorPos(w);
    const sh = w.show;
    if (sh?.kind === "flip") return;
    if (w.act === "waiting" && w.needsHuman) {
      const ink = (BRAND_ART[w.agent] ?? BRAND_ART.claude).ink;
      const dark = ink === C.cc9 || ink === C.cu9;
      const a = g.globalAlpha;
      // beside the head, off the monitor: the screen keeps showing what the agent last did
      const bx = h.x + 8, by = h.y - 7;
      P.ping(g, bx + 4, by + 5, now, ink);
      g.globalAlpha = a;
      P.alertBubble(g, bx, by, ink, dark ? C.ink : C.white, now);
      return;
    }
    if (now - w.shoutAt < SHOUT_ICON_MS) {
      megaphone(g, h.x + 5, h.y - 12, now, brandInk(w.agent));
      return;
    }
    if (now - w.bulbAt < 800) { P.bulb(g, h.x - 2, h.y - 12 - Math.floor((now - w.bulbAt) / 200), now); return; }
    if (!w.seated || w.stand > 0.5) return;
    const main = w.seat.kind === "main";
    switch (w.act) {
      case "thinking":
        if (!w.mood && !this.hushed.has(w.id)) P.thoughtBubble(g, h.x + 3, h.y - 17, now, brandInk(w.agent));
        break;
      case "reply":
        if (!w.mood && !this.hushed.has(w.id)) P.speechBubble(g, h.x + 4, h.y - 13, now, brandInk(w.agent));
        break;
      case "search": {
        const sweep = Math.sin(now * 0.004 + w.seed) * (main ? 7 : 3);
        P.magnifier(g, Math.round(m.x + (main ? 12 : 5) + sweep), Math.round(m.y + (main ? 7 : 3) + Math.cos(now * 0.006) * 2));
        break;
      }
      case "web":
        // low enough to stay clear of the pod sign right above the desk
        P.globe(g, m.x + (main ? 7 : 1), m.y - 4, now);
        P.wifi(g, m.x + (main ? 21 : 13), m.y + 2, now);
        break;
      case "mcp":
        P.plug(g, m.x + (main ? 25 : 11), m.y - 4, now);
        break;
      case "agent":
        if (Math.floor(now / 500) % 2) { g.fillStyle = C.gold3; g.fillRect(m.x + (main ? 11 : 4), m.y - 4, 2, 2); }
        break;
    }
  }

  hit(wx: number, wy: number): string | null {
    let best: Worker | null = null;
    for (const w of this.workers.values()) {
      if (w.gone) continue;
      const x0 = w.x - 7, x1 = w.x + 7, y0 = w.y - 24, y1 = w.y + 1;
      if (wx >= x0 && wx <= x1 && wy >= y0 && wy <= y1 && (!best || w.y > best.y)) best = w;
    }
    return best?.id ?? null;
  }
}

/** About seven seconds door to desk, never slower than a stroll; a path not laid out yet gets the stroll. */
function walkSpeed(w: Worker, pts: Pt[]): number {
  let len = 0, px = w.x, py = w.y;
  for (const p of pts) { len += Math.abs(p.x - px) + Math.abs(p.y - py); px = p.x; py = p.y; }
  return Number.isFinite(len) ? Math.max(46, len / 7) : 46;
}

/** A little megaphone with sound waves: the agent just shouted to the office. */
function megaphone(g: CanvasRenderingContext2D, x: number, y: number, t: number, col: string) {
  const bob = Math.floor(t / 200) % 2;
  const yy = y - bob;
  g.fillStyle = C.ink;
  g.fillRect(x - 1, yy + 1, 10, 7);
  g.fillStyle = C.white;
  g.fillRect(x, yy + 3, 3, 3);
  g.fillRect(x + 3, yy + 2, 2, 5);
  g.fillRect(x + 5, yy + 1, 3, 7);
  g.fillStyle = col;
  g.fillRect(x + 5, yy + 1, 1, 7);
  g.fillStyle = C.slate4;
  g.fillRect(x + 1, yy + 6, 1, 3);
  const k = Math.floor(t / 180) % 3;
  g.fillStyle = col;
  for (let i = 0; i <= k; i++) {
    g.fillRect(x + 10 + i * 2, yy + 3 - i, 1, 3 + i * 2);
  }
  g.fillStyle = rgba(C.white, 0.6);
  g.fillRect(x + 6, yy + 2, 1, 1);
}
