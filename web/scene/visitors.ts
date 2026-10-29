/*
 * People who aren't agents: now and then someone comes up in the lift and
 * spends a while in the office before taking the lift back down. Each picks a
 * few things to do, in a random order: drop by an agent's desk for a chat
 * (they take turns in speech bubbles), sit on a lounge sofa and read (or talk,
 * when someone else sits there too), or stop at the glass to look at the city.
 * They walk the same corridor and aisles as the agents. Purely decorative.
 */
import { lookFor, sprite, SPRITE_FOOT, SPRITE_W, type Dir, type Look } from "./sprites.ts";
import { CORRIDOR_Y, DESK_DY, LANE_DY, POD_GAP, WALL_H, type Decor, type Pt } from "./layout.ts";
import { speechBubble } from "./props.ts";
import { brandInk, type Crew, type DrawCall, type Worker } from "./workers.ts";

const MAX = 3;
const WALK = 30;
/** A new visitor every so often; the first soon after the page opens. */
const EVERY_MS = [18_000, 40_000], FIRST_MS = 7_000;
/** Turns in a conversation. */
const TURN_MS = 1_400;
/** Casual shirts: base, shadow, highlight (no logo, so the logo pixel is the shirt). */
const SHIRTS: [string, string, string][] = [
  ["#c9524a", "#9c3a34", "#e27a70"], ["#3f7fc4", "#2c5c94", "#6aa3dd"], ["#4fa36a", "#367a4d", "#78c48f"],
  ["#d9a23a", "#a87a24", "#ecc46a"], ["#8a6ac6", "#664c9c", "#ab92de"], ["#e6e1d6", "#bdb6a8", "#f6f3ec"],
  ["#3a3f4a", "#262a33", "#575e6c"],
];
const BOOKS = ["#c9524a", "#3f7fc4", "#4fa36a", "#d9a23a"];

type Errand = "agent" | "sofa" | "window";
type State = "arrive" | "walk" | "talk" | "sit" | "look" | "out";

interface Visitor {
  look: Look;
  x: number;
  y: number;
  dir: Dir;
  dist: number;
  alpha: number;
  state: State;
  path: Pt[];
  onArrive?: (now: number) => void;
  /** the way back to the corridor from where it is now */
  back: Pt[];
  errands: Errand[];
  until: number;
  t0: number;
  /** who it's talking to at a desk */
  agent?: string;
  /** where it sits: the sofa and which end */
  sofa?: { d: Decor; end: 0 | 1 };
  book: string;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;

export class Visitors {
  private people: Visitor[] = [];
  private next = -1;

  constructor(private crew: Crew) {}

  private get door(): Pt {
    return { x: this.crew.elevator.x, y: WALL_H + 1 };
  }

  private spawn(now: number) {
    const [o, O, p] = pick(SHIRTS);
    const look: Look = { ...lookFor(`visitor-${Math.random()}`, "claude", false), kit: { o, O, p, l: o } };
    look.key += `|v${o}`;
    const errands: Errand[] = [];
    for (let n = 1 + Math.floor(Math.random() * 3); n > 0; n--) errands.push(pick(["agent", "agent", "sofa", "sofa", "window"] as const));
    const d = this.door;
    this.people.push({
      look, x: d.x, y: d.y, dir: "down", dist: 0, alpha: 0, state: "arrive", path: [], back: [],
      errands, until: 0, t0: now, book: pick(BOOKS),
    });
    this.crew.callElevator(now);
  }

  /** Where on the corridor a visitor will be once it has walked `back`. */
  private corridorX(v: Visitor): number {
    return v.back.length ? v.back.at(-1)!.x : v.x;
  }

  /** From the corridor (or wherever `back` leads there) along `pts`; `back` is how to return. */
  private go(v: Visitor, pts: Pt[], back: Pt[], done: (now: number) => void) {
    v.path = [...v.back, ...pts];
    v.back = back;
    v.state = "walk";
    v.onArrive = done;
  }

  /** Next errand, or home. */
  private nextErrand(v: Visitor, now: number): void {
    const e = v.errands.shift();
    if (e === "agent" && this.toAgent(v)) return;
    if (e === "sofa" && this.toSofa(v)) return;
    if (e === "window") {
      const room = this.crew.layout.main;
      const x = Math.round(rand(room.x + 60, room.x + room.w - 50));
      const y = CORRIDOR_Y - 4;
      this.go(v, [{ x: this.corridorX(v), y: CORRIDOR_Y }, { x, y: CORRIDOR_Y }, { x, y }], [{ x, y: CORRIDOR_Y }], (t) => {
        v.state = "look";
        v.dir = "up";
        v.until = t + rand(4_000, 9_000);
      });
      return;
    }
    if (e) return this.nextErrand(v, now);
    // done: back to the lift
    const d = this.door;
    this.go(v, [{ x: this.corridorX(v), y: CORRIDOR_Y }, { x: d.x, y: CORRIDOR_Y }, d], [], (t) => {
      v.state = "out";
      v.dir = "up";
      this.crew.callElevator(t);
    });
  }

  /** Stand beside a seated agent's chair and talk. */
  private toAgent(v: Visitor): boolean {
    const busy = new Set(this.people.map((p) => p.agent));
    const ws = [...this.crew.workers.values()].filter((w) => !w.intern && w.seated && !w.leaving && !w.walking && !busy.has(w.id));
    if (!ws.length) return false;
    const w = pick(ws);
    const s = w.seat;
    const ax = this.crew.layout.aisleFor(s);
    const x = s.x + 13, y = s.y + 3;
    this.go(v, [{ x: this.corridorX(v), y: CORRIDOR_Y }, { x: ax, y: CORRIDOR_Y }, { x: ax, y: s.laneY }, { x, y: s.laneY }, { x, y }],
      [{ x, y: s.laneY }, { x: ax, y: s.laneY }, { x: ax, y: CORRIDOR_Y }], (t) => {
        v.state = "talk";
        v.agent = w.id;
        v.dir = "left";
        v.t0 = t;
        v.until = t + rand(6_000, 12_000);
      });
    return true;
  }

  /** Sit on a free end of a lounge sofa. */
  private toSofa(v: Visitor): boolean {
    const free: { d: Decor; end: 0 | 1 }[] = [];
    for (const d of this.crew.layout.decor) {
      if (d.kind !== "lounge") continue;
      for (const end of [0, 1] as const) if (!this.people.some((p) => p.sofa?.d === d && p.sofa.end === end)) free.push({ d, end });
    }
    if (!free.length) return false;
    const spot = pick(free);
    const { x, y } = sofaSeat(spot.d, spot.end);
    const lane = spot.d.y + DESK_DY + LANE_DY;
    // down the gap left of the lounge, like an aisle between pods
    const ax = spot.d.x - POD_GAP / 2;
    v.sofa = spot;
    this.go(v, [{ x: this.corridorX(v), y: CORRIDOR_Y }, { x: ax, y: CORRIDOR_Y }, { x: ax, y: lane }, { x, y: lane }, { x, y: y + 2 }],
      [{ x, y: lane }, { x: ax, y: lane }, { x: ax, y: CORRIDOR_Y }], (t) => {
        v.state = "sit";
        v.dir = "down";
        v.t0 = t;
        v.until = t + rand(15_000, 35_000);
      });
    return true;
  }

  update(dt: number, now: number) {
    if (this.next < 0) this.next = now + FIRST_MS;
    if (now >= this.next) {
      if (this.people.length < MAX) this.spawn(now);
      this.next = now + rand(EVERY_MS[0], EVERY_MS[1]);
    }
    const el = this.crew.elevator;
    const step = (WALK * dt) / 1000;
    for (const v of this.people) {
      switch (v.state) {
        case "arrive":
          // out of the lift once the doors are open
          if (el.open > 0.6) {
            v.alpha = Math.min(1, v.alpha + dt / 300);
            if (v.alpha >= 1) this.nextErrand(v, now);
          }
          break;
        case "out":
          if (el.open > 0.6) v.alpha -= dt / 300;
          break;
        case "walk": {
          let left = step;
          while (left > 0 && v.path.length) {
            const p = v.path[0]!;
            const dx = p.x - v.x, dy = p.y - v.y;
            const d = Math.abs(dx) + Math.abs(dy);
            if (d <= left) {
              v.x = p.x; v.y = p.y; left -= d; v.path.shift();
              continue;
            }
            if (Math.abs(dx) > 0.01) { v.x += Math.sign(dx) * left; v.dir = dx > 0 ? "right" : "left"; }
            else { v.y += Math.sign(dy) * left; v.dir = dy > 0 ? "down" : "up"; }
            left = 0;
          }
          v.dist += step;
          if (!v.path.length) v.onArrive?.(now);
          break;
        }
        case "talk": {
          const w = v.agent ? this.crew.workers.get(v.agent) : undefined;
          if (now > v.until || !w || w.leaving || w.walking) { v.agent = undefined; this.nextErrand(v, now); }
          break;
        }
        case "sit":
          if (now > v.until) { v.sofa = undefined; this.nextErrand(v, now); }
          break;
        case "look":
          if (now > v.until) this.nextErrand(v, now);
          break;
      }
    }
    this.people = this.people.filter((v) => v.state !== "out" || v.alpha > 0);
  }

  draw(out: DrawCall[], now: number) {
    for (const v of this.people) {
      if (v.alpha <= 0) continue;
      const fx = Math.round(v.x), fy = Math.round(v.y);
      // whose turn it is: the visitor opens, the other answers
      const turn = Math.floor((now - v.t0) / TURN_MS) % 2 === 0;
      if (v.state === "sit" && v.sofa) {
        const mate = this.people.find((p) => p !== v && p.state === "sit" && p.sofa?.d === v.sofa!.d);
        const seat = sofaSeat(v.sofa.d, v.sofa.end);
        // on the sofa, facing the room: everything above the hips, a book in the lap unless chatting
        const spr = sprite(v.look, "stand", "down", 0);
        const h = SPRITE_FOOT - 8;
        const speaking = mate && turn === (v.sofa.end === 0);
        out.push({
          y: v.sofa.d.y + 59,
          fn: (g) => {
            g.globalAlpha = v.alpha;
            g.drawImage(spr.c, 0, 0, SPRITE_W, h, seat.x - (SPRITE_W >> 1), seat.y - h, SPRITE_W, h);
            if (!mate) {
              g.fillStyle = v.book;
              g.fillRect(seat.x - 4, seat.y - 9, 8, 5);
              g.fillStyle = "#f4f1ea";
              g.fillRect(seat.x - 3, seat.y - 9, 6, 1);
              g.fillRect(seat.x, seat.y - 9, 1, 5);
            } else if (speaking) speechBubble(g, seat.x + (v.sofa!.end ? 1 : -12), seat.y - h - 9, now, v.look.kit!.o);
            g.globalAlpha = 1;
          },
        });
        continue;
      }
      const moving = v.state === "walk";
      const spr = sprite(v.look, moving ? "walk" : "stand", v.dir, moving ? Math.floor(v.dist / 4) & 3 : 0);
      const w = v.state === "talk" && v.agent ? this.crew.workers.get(v.agent) : undefined;
      out.push({
        y: v.y,
        fn: (g) => {
          g.globalAlpha = v.alpha;
          g.fillStyle = "rgba(14,13,22,0.3)";
          g.fillRect(fx - 4, fy + 1, 9, 1);
          g.drawImage(spr.c, fx - (SPRITE_W >> 1), fy - SPRITE_FOOT);
          g.globalAlpha = 1;
          if (w) {
            if (turn) speechBubble(g, fx + 1, fy - SPRITE_FOOT - 8, now, v.look.kit!.o);
            else agentBubble(g, this.crew, w, now);
          }
        },
      });
    }
  }
}

/** Where a sitter's hips are on one end of a lounge's sofa (see decorBitmap: the sofa is 48 wide at the lounge's centre). */
function sofaSeat(d: Decor, end: 0 | 1): Pt {
  const x0 = d.x + Math.round(d.w / 2) - 24, y0 = d.y + 10 + 18;
  return { x: x0 + (end ? 34 : 14), y: y0 + 12 };
}

/** The agent answers from the other side of its head, in its own colour. */
function agentBubble(g: CanvasRenderingContext2D, crew: Crew, w: Worker, now: number) {
  const h = crew.headPos(w);
  speechBubble(g, h.x - 16, h.y - 13, now, brandInk(w.agent));
}

