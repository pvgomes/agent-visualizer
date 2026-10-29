/*
 * People who aren't agents: now and then someone comes up in the lift and
 * spends a while in the office before taking the lift back down. Each runs a
 * few errands in a random order: drop by an agent's desk for a chat (they take
 * turns in speech bubbles), get a coffee (and carry the cup from then on), sit
 * on a lounge sofa and read (or talk, when someone sits at the other end), or
 * look out at the city. Every errand is a spot to go to: down the corridor,
 * down an aisle to a row's lane if it's out on the floor, and back the same
 * way. Purely decorative.
 */
import { lookFor, sprite, SPRITE_FOOT, SPRITE_W, type Dir, type Look } from "./sprites.ts";
import { CORRIDOR_Y, DESK_DY, LANE_DY, POD_GAP, WALL_H, type Decor, type Pt } from "./layout.ts";
import { speechBubble } from "./props.ts";
import { mix } from "./palette.ts";
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
const INK = "#0e0d16", PAPER = "#f4f1ea", COFFEE = "#6b4226";

type Errand = "agent" | "sofa" | "coffee" | "window";
/** Weighted: chats and the sofa more often than the window. */
const ERRANDS: readonly Errand[] = ["agent", "agent", "sofa", "sofa", "coffee", "coffee", "window"];

/** Where an errand happens. */
interface Spot {
  doing: Errand;
  /** where to stand (for the sofa: in front of the seat) */
  at: Pt;
  face: Dir;
  /** how long to stay, ms */
  ms: [number, number];
  /** out on the floor: down this aisle to the row's lane first */
  aisle?: { x: number; lane: number };
  agent?: string;
  sofa?: { d: Decor; end: 0 | 1 };
}

interface Visitor {
  look: Look;
  x: number;
  y: number;
  dir: Dir;
  dist: number;
  alpha: number;
  state: "arrive" | "walk" | "stay" | "out";
  path: Pt[];
  /** the way back to the corridor from where it is now */
  back: Pt[];
  errands: Errand[];
  /** the errand it's on; none on the way home */
  spot?: Spot;
  t0: number;
  until: number;
  book: string;
  cup: boolean;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;

export class Visitors {
  private people: Visitor[] = [];
  private next = -1;

  /** `coffee`: the coffee machine's foot, on the back wall. */
  constructor(private crew: Crew, private coffee: () => Pt) {}

  private get door(): Pt {
    return { x: this.crew.elevator.x, y: WALL_H + 1 };
  }

  private spawn(now: number) {
    const [o, O, p] = pick(SHIRTS);
    const look: Look = { ...lookFor(`visitor-${Math.random()}`, "claude", false), kit: { o, O, p, l: o } };
    look.key += `|v${o}`;
    const errands = Array.from({ length: 1 + Math.floor(Math.random() * 3) }, () => pick(ERRANDS));
    const { x, y } = this.door;
    this.people.push({ look, x, y, dir: "down", dist: 0, alpha: 0, state: "arrive", path: [], back: [], errands, t0: now, until: 0, book: pick(BOOKS), cup: false });
    this.crew.callElevator(now);
  }

  /* ------------------------------------------------------------ errands */

  private taken(test: (s: Spot) => boolean): boolean {
    return this.people.some((p) => p.spot && test(p.spot));
  }

  private spotFor(e: Errand): Spot | null {
    switch (e) {
      case "agent": {
        // beside a seated agent's chair, facing them; one visitor per agent
        const ws = [...this.crew.workers.values()].filter((w) => !w.intern && w.seated && !w.leaving && !w.walking && !this.taken((s) => s.agent === w.id));
        if (!ws.length) return null;
        const w = pick(ws), s = w.seat;
        return { doing: e, at: { x: s.x + 13, y: s.y + 3 }, face: "left", ms: [6_000, 12_000], aisle: { x: this.crew.layout.aisleFor(s), lane: s.laneY }, agent: w.id };
      }
      case "sofa": {
        const free: { d: Decor; end: 0 | 1 }[] = [];
        for (const d of this.crew.layout.decor) {
          if (d.kind !== "lounge") continue;
          for (const end of [0, 1] as const) if (!this.taken((s) => s.sofa?.d === d && s.sofa.end === end)) free.push({ d, end });
        }
        if (!free.length) return null;
        const sofa = pick(free);
        const seat = sofaSeat(sofa.d, sofa.end);
        // down the gap left of the lounge, like an aisle between pods
        return { doing: e, at: { x: seat.x, y: seat.y + 2 }, face: "down", ms: [15_000, 35_000], aisle: { x: sofa.d.x - POD_GAP / 2, lane: sofa.d.y + DESK_DY + LANE_DY }, sofa };
      }
      case "coffee": {
        if (this.taken((s) => s.doing === "coffee")) return null;
        const c = this.coffee();
        return { doing: e, at: { x: c.x + 13, y: CORRIDOR_Y - 4 }, face: "up", ms: [3_500, 6_000] };
      }
      case "window": {
        const room = this.crew.layout.main;
        return { doing: e, at: { x: Math.round(rand(room.x + 60, room.x + room.w - 50)), y: CORRIDOR_Y - 4 }, face: "up", ms: [4_000, 9_000] };
      }
    }
  }

  /** Off to the next errand that can be done, or back to the lift when there are none left. */
  private nextErrand(v: Visitor) {
    v.spot = undefined;
    while (v.errands.length && !v.spot) v.spot = this.spotFor(v.errands.shift()!) ?? undefined;
    const cx = v.back.length ? v.back.at(-1)!.x : v.x;
    let there: Pt[];
    if (!v.spot) there = [{ x: this.door.x, y: CORRIDOR_Y }, this.door];
    else {
      const { at, aisle } = v.spot;
      const via = aisle ? [{ x: aisle.x, y: CORRIDOR_Y }, { x: aisle.x, y: aisle.lane }, { x: at.x, y: aisle.lane }] : [{ x: at.x, y: CORRIDOR_Y }];
      there = [...via, at];
    }
    v.path = [...v.back, { x: cx, y: CORRIDOR_Y }, ...there];
    v.back = there.slice(0, -1).reverse();
    v.state = "walk";
  }

  /** Walked to the end of its path: start the errand, or step into the lift. */
  private arrive(v: Visitor, now: number) {
    if (!v.spot) {
      v.state = "out";
      v.dir = "up";
      this.crew.callElevator(now);
      return;
    }
    v.state = "stay";
    v.dir = v.spot.face;
    v.t0 = now;
    v.until = now + rand(...v.spot.ms);
  }

  private done(v: Visitor, now: number): boolean {
    if (now > v.until) return true;
    const w = v.spot?.agent ? this.crew.workers.get(v.spot.agent) : undefined;
    return !!v.spot?.agent && (!w || w.leaving || w.walking);
  }

  /* ------------------------------------------------------------- update */

  update(dt: number, now: number) {
    if (this.next < 0) this.next = now + FIRST_MS;
    if (now >= this.next) {
      if (this.people.length < MAX) this.spawn(now);
      this.next = now + rand(EVERY_MS[0], EVERY_MS[1]);
    }
    const open = this.crew.elevator.open > 0.6;
    for (const v of this.people) {
      switch (v.state) {
        case "arrive":
          // out of the lift once the doors are open
          if (!open) break;
          v.alpha = Math.min(1, v.alpha + dt / 300);
          if (v.alpha >= 1) this.nextErrand(v);
          break;
        case "out":
          if (open) v.alpha -= dt / 300;
          break;
        case "walk":
          this.walk(v, (WALK * dt) / 1000);
          if (!v.path.length) this.arrive(v, now);
          break;
        case "stay":
          if (!this.done(v, now)) break;
          if (v.spot?.doing === "coffee") v.cup = true;
          this.nextErrand(v);
          break;
      }
    }
    this.people = this.people.filter((v) => v.state !== "out" || v.alpha > 0);
  }

  /** Along the path, one leg at a time. */
  private walk(v: Visitor, step: number) {
    v.dist += step;
    while (step > 0 && v.path.length) {
      const p = v.path[0]!;
      const dx = p.x - v.x, dy = p.y - v.y;
      const d = Math.abs(dx) + Math.abs(dy);
      if (d <= step) {
        v.x = p.x; v.y = p.y; step -= d; v.path.shift();
      } else if (dx) {
        v.x += Math.sign(dx) * step; v.dir = dx > 0 ? "right" : "left"; step = 0;
      } else {
        v.y += Math.sign(dy) * step; v.dir = dy > 0 ? "down" : "up"; step = 0;
      }
    }
  }

  /* --------------------------------------------------------------- draw */

  draw(out: DrawCall[], now: number) {
    for (const v of this.people) {
      if (v.alpha <= 0) continue;
      // whose turn it is: the visitor opens, the other answers
      const turn = Math.floor((now - v.t0) / TURN_MS) % 2 === 0;
      const sofa = v.state === "stay" ? v.spot?.sofa : undefined;
      if (sofa) out.push({ y: sofa.d.y + 59, fn: (g) => this.drawSitting(g, v, sofa, turn, now) });
      else out.push({ y: v.y, fn: (g) => this.drawStanding(g, v, turn, now) });
    }
  }

  private drawStanding(g: CanvasRenderingContext2D, v: Visitor, turn: boolean, now: number) {
    const fx = Math.round(v.x), fy = Math.round(v.y);
    const moving = v.state === "walk";
    const spr = sprite(v.look, moving ? "walk" : "stand", v.dir, moving ? Math.floor(v.dist / 4) & 3 : 0);
    g.globalAlpha = v.alpha;
    g.fillStyle = "rgba(14,13,22,0.3)";
    g.fillRect(fx - 4, fy + 1, 9, 1);
    if (v.cup && v.dir === "up") cup(g, fx + 4, fy - 10);
    g.drawImage(spr.c, fx - (SPRITE_W >> 1), fy - SPRITE_FOOT);
    if (v.cup && v.dir !== "up") cup(g, v.dir === "left" ? fx - 7 : fx + 4, fy - 10);
    g.globalAlpha = 1;
    const w = v.state === "stay" && v.spot?.agent ? this.crew.workers.get(v.spot.agent) : undefined;
    if (!w) return;
    if (turn) speechBubble(g, fx + 1, fy - SPRITE_FOOT - 8, now, v.look.kit!.o);
    else agentBubble(g, this.crew, w, now);
  }

  /** Facing the room: everything above the hips, the legs folded down the sofa's front, a book in the lap unless chatting. */
  private drawSitting(g: CanvasRenderingContext2D, v: Visitor, sofa: NonNullable<Spot["sofa"]>, turn: boolean, now: number) {
    const seat = sofaSeat(sofa.d, sofa.end);
    const mate = this.people.some((p) => p !== v && p.state === "stay" && p.spot?.sofa?.d === sofa.d);
    const spr = sprite(v.look, "stand", "down", 0);
    const h = SPRITE_FOOT - 8;
    g.globalAlpha = v.alpha;
    g.drawImage(spr.c, 0, 0, SPRITE_W, h, seat.x - (SPRITE_W >> 1), seat.y - h, SPRITE_W, h);
    seatedLegs(g, seat.x, seat.y, v.look);
    if (!mate) {
      g.fillStyle = v.book;
      g.fillRect(seat.x - 4, seat.y - 9, 8, 5);
      g.fillStyle = PAPER;
      g.fillRect(seat.x - 3, seat.y - 9, 6, 1);
      g.fillRect(seat.x, seat.y - 9, 1, 5);
    } else if (turn === (sofa.end === 0)) speechBubble(g, seat.x + (sofa.end ? 1 : -12), seat.y - h - 9, now, v.look.kit!.o);
    g.globalAlpha = 1;
  }
}

/** Where a sitter's hips are on one end of a lounge's sofa (see decorBitmap: the sofa is 48 wide at the lounge's centre). */
function sofaSeat(d: Decor, end: 0 | 1): Pt {
  const x0 = d.x + Math.round(d.w / 2) - 24, y0 = d.y + 10 + 18;
  return { x: x0 + (end ? 34 : 14), y: y0 + 12 };
}

/**
 * Someone sitting, seen from the front: the lap on the cushion, shins down the
 * sofa's front and shoes on the floor. (x, hip) is where the cropped standing
 * sprite ends.
 */
function seatedLegs(g: CanvasRenderingContext2D, x: number, hip: number, look: Look) {
  g.fillStyle = mix(look.pants, INK, 0.45);
  g.fillRect(x - 5, hip, 10, 7);
  // the lap
  g.fillStyle = look.pants;
  g.fillRect(x - 4, hip, 8, 2);
  g.fillStyle = mix(look.pants, "#ffffff", 0.15);
  g.fillRect(x - 4, hip, 8, 1);
  // shins, a gap between the knees
  g.fillStyle = look.pants;
  g.fillRect(x - 4, hip + 2, 3, 4);
  g.fillRect(x + 1, hip + 2, 3, 4);
  g.fillStyle = mix(look.pants, INK, 0.25);
  g.fillRect(x - 1, hip + 2, 2, 5);
  // shoes on the floor
  g.fillStyle = look.shoes;
  g.fillRect(x - 5, hip + 6, 4, 2);
  g.fillRect(x + 1, hip + 6, 4, 2);
  g.fillStyle = mix(look.shoes, INK, 0.4);
  g.fillRect(x - 5, hip + 7, 4, 1);
  g.fillRect(x + 1, hip + 7, 4, 1);
}

/** A takeaway coffee in hand, 3 x 4 with a lid. (x, y) = top-left. */
function cup(g: CanvasRenderingContext2D, x: number, y: number) {
  g.fillStyle = INK;
  g.fillRect(x - 1, y - 1, 5, 6);
  g.fillStyle = PAPER;
  g.fillRect(x, y + 1, 3, 3);
  g.fillStyle = COFFEE;
  g.fillRect(x, y, 3, 1);
  g.fillRect(x, y + 2, 3, 1);
}

/** The agent answers from the other side of its head, in its own colour. */
function agentBubble(g: CanvasRenderingContext2D, crew: Crew, w: Worker, now: number) {
  const h = crew.headPos(w);
  speechBubble(g, h.x - 16, h.y - 13, now, brandInk(w.agent));
}
