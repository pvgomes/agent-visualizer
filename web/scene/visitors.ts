/*
 * People passing through: now and then someone who isn't an agent walks the
 * corridor in front of the glass, from one side of the office to the other.
 * When two of them meet they stop, turn to each other and chat a while
 * (speech bubbles, taking turns), then go on their way. Purely decorative.
 */
import { lookFor, sprite, SPRITE_FOOT, SPRITE_W, type Look } from "./sprites.ts";
import { CORRIDOR_Y } from "./layout.ts";
import { speechBubble } from "./props.ts";
import type { DrawCall } from "./workers.ts";

const MAX = 3;
const WALK = 26;
/** A new visitor every so often; the first soon after the page opens. */
const EVERY_MS = [14_000, 30_000], FIRST_MS = 6_000;
const CHAT_MS = [4_500, 8_000];
/** A chatter takes the word for this long before the other answers. */
const TURN_MS = 1_300;
/** Casual shirts: base, shadow, highlight (no logo, so the logo pixel is the shirt). */
const SHIRTS: [string, string, string][] = [
  ["#c9524a", "#9c3a34", "#e27a70"], ["#3f7fc4", "#2c5c94", "#6aa3dd"], ["#4fa36a", "#367a4d", "#78c48f"],
  ["#d9a23a", "#a87a24", "#ecc46a"], ["#8a6ac6", "#664c9c", "#ab92de"], ["#e6e1d6", "#bdb6a8", "#f6f3ec"],
  ["#3a3f4a", "#262a33", "#575e6c"],
];

interface Visitor {
  look: Look;
  x: number;
  /** a lane in the corridor, so two of them don't walk on one line */
  y: number;
  dir: 1 | -1;
  endX: number;
  dist: number;
  /** stopped to chat with this one until `until` */
  with: Visitor | null;
  until: number;
  /** starts every turn in the conversation it opened */
  t0: number;
  lead: boolean;
  /** when it may stop to chat again */
  free: number;
}

export class Visitors {
  private people: Visitor[] = [];
  private next = -1;

  private spawn(room: { x: number; w: number }, now: number, dir: 1 | -1) {
    const seed = `visitor-${Math.random()}`;
    const [o, O, p] = SHIRTS[Math.floor(Math.random() * SHIRTS.length)]!;
    const look: Look = { ...lookFor(seed, "claude", false), kit: { o, O, p, l: o } };
    look.key += `|v${o}`;
    this.people.push({
      look, dir, dist: 0, with: null, until: 0, t0: 0, lead: false, free: now,
      x: dir > 0 ? room.x - 10 : room.x + room.w + 10,
      endX: dir > 0 ? room.x + room.w + 12 : room.x - 12,
      y: CORRIDOR_Y + 2 + Math.floor(Math.random() * 7),
    });
  }

  update(dt: number, now: number, room: { x: number; w: number }) {
    if (this.next < 0) this.next = now + FIRST_MS;
    if (now >= this.next && this.people.length < MAX) {
      const dir = Math.random() < 0.5 ? 1 : -1;
      this.spawn(room, now, dir);
      // often a second one from the other side, so they meet somewhere in the middle
      if (this.people.length < MAX && Math.random() < 0.6) this.spawn(room, now, dir > 0 ? -1 : 1);
      this.next = now + EVERY_MS[0] + Math.random() * (EVERY_MS[1] - EVERY_MS[0]);
    }
    const step = (WALK * dt) / 1000;
    for (const v of this.people) {
      if (v.with) {
        if (now < v.until) continue;
        v.with = null;
        v.free = now + 15_000;
      }
      v.x += v.dir * step;
      v.dist += step;
    }
    // two coming at each other, close and both up for it: they stop and talk
    for (const a of this.people) {
      for (const b of this.people) {
        if (a === b || a.with || b.with || a.dir === b.dir || now < a.free || now < b.free) continue;
        const gap = (b.x - a.x) * a.dir;
        if (gap > 0 && gap < 22) {
          const until = now + CHAT_MS[0] + Math.random() * (CHAT_MS[1] - CHAT_MS[0]);
          Object.assign(a, { with: b, until, t0: now, lead: true });
          Object.assign(b, { with: a, until, t0: now, lead: false });
        }
      }
    }
    this.people = this.people.filter((v) => v.with || (v.x - v.endX) * v.dir < 0);
  }

  draw(out: DrawCall[], now: number) {
    for (const v of this.people) {
      const fx = Math.round(v.x);
      const talking = !!v.with;
      const dir = talking ? (v.with!.x > v.x ? "right" : "left") : v.dir > 0 ? "right" : "left";
      const spr = sprite(v.look, talking ? "stand" : "walk", dir, talking ? 0 : Math.floor(v.dist / 4) & 3);
      const speaking = talking && (Math.floor((now - v.t0) / TURN_MS) % 2 === 0) === v.lead;
      out.push({
        y: v.y,
        fn: (g) => {
          g.fillStyle = "rgba(14,13,22,0.3)";
          g.fillRect(fx - 4, v.y + 1, 9, 1);
          g.drawImage(spr.c, fx - (SPRITE_W >> 1), v.y - SPRITE_FOOT);
          if (speaking) speechBubble(g, dir === "right" ? fx + 1 : fx - 12, v.y - SPRITE_FOOT - 8, now, v.look.kit!.o);
        },
      });
    }
  }
}
