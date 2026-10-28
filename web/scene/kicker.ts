/*
 * Rio's passer-by: every five minutes someone in the yellow shirt walks along
 * the corridor in front of the glass, stops in the middle of the office and
 * does keepie-uppies (embaixadinha): foot, foot, knee, foot, head, then one
 * big kick up and a catch, and walks on out the other side. Purely
 * decorative, like the cat.
 */
import { lookFor, sprite, SPRITE_FOOT, SPRITE_W, type Look } from "./sprites.ts";
import { CORRIDOR_Y } from "./layout.ts";
import type { DrawCall } from "./workers.ts";

/** How often someone comes through, and how soon the first one does. */
const EVERY_MS = 5 * 60_000, FIRST_MS = 20_000;
const WALK = 28;
const TOUCH_MS = 520;
/** Touches before the big finish: where the ball meets the body, in px above the feet. */
const TOUCHES: { at: number; leg?: 0 | 2 }[] = [
  { at: 1, leg: 0 }, { at: 1, leg: 2 }, { at: 8 }, { at: 1, leg: 0 }, { at: 1, leg: 2 }, { at: 22 },
  { at: 1, leg: 2 }, { at: 8 }, { at: 1, leg: 0 }, { at: 22 }, { at: 1, leg: 2 },
];

type Phase = "off" | "in" | "juggle" | "out";

export class Kicker {
  private phase: Phase = "off";
  private x = 0;
  private stopX = 0;
  private endX = 0;
  private dir: 1 | -1 = 1;
  private t0 = 0;
  private next = -1;
  private dist = 0;
  private look: Look;

  constructor() {
    this.look = { ...lookFor(`kicker-${Math.random()}`, "claude", false), pants: "#1f4fa8", shoes: "#f4f1ea", acc: "none" };
    this.look.kit = { o: "#f7d417", O: "#d4a90c", p: "#ffe866", l: "#1f9a4a" };
    this.look.key += "|br";
  }

  /** Nobody comes through outside Rio; back in Rio the next one is a little way off. */
  update(dt: number, now: number, room: { x: number; w: number }, on: boolean) {
    if (!on) {
      if (this.phase === "off") this.next = -1;
      else this.phase = "out";
    } else if (this.next < 0) this.next = now + FIRST_MS;
    if (this.phase === "off") {
      if (on && now >= this.next) {
        this.dir = Math.random() < 0.5 ? 1 : -1;
        this.x = this.dir > 0 ? room.x - 10 : room.x + room.w + 10;
        this.endX = this.dir > 0 ? room.x + room.w + 12 : room.x - 12;
        this.stopX = room.x + room.w * (0.4 + Math.random() * 0.2);
        this.phase = "in";
        this.next = now + EVERY_MS;
      }
      return;
    }
    if (this.phase === "juggle") {
      if (now - this.t0 > (TOUCHES.length + 2) * TOUCH_MS) this.phase = "out";
      return;
    }
    const step = (WALK * dt) / 1000;
    this.x += this.dir * step;
    this.dist += step;
    if (this.phase === "in" && (this.x - this.stopX) * this.dir >= 0) {
      this.phase = "juggle";
      this.t0 = now;
    } else if (this.phase === "out" && (this.x - this.endX) * this.dir >= 0) this.phase = "off";
  }

  draw(out: DrawCall[], now: number) {
    if (this.phase === "off") return;
    const y = CORRIDOR_Y + 6;
    const fx = Math.round(this.x);
    let pose: "walk" | "stand" | "cheer" = "walk", dir: "left" | "right" | "down" = this.dir > 0 ? "right" : "left", frame = Math.floor(this.dist / 4) & 3;
    // the ball: bounced along at the feet while walking, juggled while stopped
    let bx = fx + this.dir * 5, by = y - 2 - Math.round(Math.abs(Math.sin(this.dist * 0.35)) * 3);
    if (this.phase === "juggle") {
      dir = "down";
      const t = now - this.t0, i = Math.floor(t / TOUCH_MS), u = (t % TOUCH_MS) / TOUCH_MS;
      bx = fx + (i % 2 ? 2 : -2);
      if (i < TOUCHES.length) {
        const a = TOUCHES[i]!, b = TOUCHES[i + 1] ?? { at: 1 };
        const from = a.at, to = b.at;
        by = y - Math.round(from + (to - from) * u + Math.sin(u * Math.PI) * (a.at > 20 || b.at > 20 ? 8 : 10));
        // a foot comes up for a foot touch, the walk frames have one leg lifted
        if (a.leg !== undefined && u < 0.35) { pose = "walk"; frame = a.leg; }
        else pose = "stand";
        if (a.at > 20 && u < 0.3) pose = "stand";
      } else {
        // the big finish: one kick sky-high, then caught with both hands
        const k = (t - TOUCHES.length * TOUCH_MS) / (2 * TOUCH_MS);
        by = y - Math.round(1 + Math.sin(Math.min(1, k) * Math.PI) * 34 + (k > 0.85 ? 14 : 0));
        bx = fx;
        pose = k > 0.85 ? "cheer" : "stand";
        frame = 0;
      }
    }
    const spr = sprite(this.look, pose, dir, frame);
    out.push({
      y,
      fn: (g) => {
        g.fillStyle = "rgba(14,13,22,0.3)";
        g.fillRect(fx - 4, y + 1, 9, 1);
        g.drawImage(spr.c, fx - (SPRITE_W >> 1), y - SPRITE_FOOT);
        // the ball's shadow on the floor, then the ball: white with black patches
        g.fillStyle = "rgba(14,13,22,0.25)";
        g.fillRect(bx - 1, y + 1, 3, 1);
        g.fillStyle = "#f4f1ea";
        g.fillRect(bx - 1, by - 2, 3, 3);
        g.fillStyle = "#1a1820";
        g.fillRect(bx, by - 1, 1, 1);
        g.fillRect(bx - 1, by - 2, 1, 1);
      },
    });
  }
}
