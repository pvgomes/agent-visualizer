/*
 * The office cat. Purely decorative: it wanders between pods (it never goes
 * into the cloud wing, too cold), sits a while,
 * naps in a loaf on the rugs, and bolts when a desk gets flipped nearby.
 * Seeded per page load so every screen recording gets its own cat.
 */
import { catSprite, SPRITE_FOOT, SPRITE_W } from "./sprites.ts";
import { CORRIDOR_Y, LANE_DY, DESK_DY, type Block } from "./layout.ts";
import type { DrawCall } from "./workers.ts";

type State = "walk" | "sit" | "loaf";

export class Cat {
  x = 0;
  y = CORRIDOR_Y;
  private tx = 0;
  private ty = 0;
  private state: State = "sit";
  private until = 0;
  private left = false;
  private dist = 0;
  private hop = 0;
  private placed = false;
  private coat = Math.floor(Math.random() * 3);
  private speed = 24;

  private pickTarget(room: { x: number; w: number }, blocks: Block[]) {
    const r = Math.random();
    const local = blocks.filter((b) => b.zone === "local");
    if (local.length && r < 0.65) {
      const b = local[Math.floor(Math.random() * local.length)];
      this.tx = b.tx + 10 + Math.random() * Math.max(4, b.w - 20);
      this.ty = b.ty + DESK_DY + LANE_DY + 2 + Math.random() * 4;
    } else {
      this.tx = room.x + 30 + Math.random() * (room.w - 60);
      this.ty = CORRIDOR_Y + (Math.random() - 0.5) * 8;
    }
  }

  /** Spook the cat: it hops and runs somewhere else. */
  startle(now: number) {
    if (this.state === "walk" && this.speed > 40) return;
    this.hop = now;
    this.state = "walk";
    this.speed = 70;
    this.tx = this.x + (Math.random() < 0.5 ? -1 : 1) * (60 + Math.random() * 60);
  }

  update(dt: number, now: number, room: { x: number; y: number; w: number; h: number }, blocks: Block[]) {
    if (!this.placed) {
      this.placed = true;
      this.x = room.x + room.w * 0.6;
      this.until = now + 3000;
    }
    this.tx = Math.max(room.x + 12, Math.min(room.x + room.w - 12, this.tx));
    if (this.state !== "walk") {
      if (now > this.until) {
        this.pickTarget(room, blocks);
        this.state = "walk";
        this.speed = 22 + Math.random() * 8;
      }
      return;
    }
    const step = (this.speed * dt) / 1000;
    const dx = this.tx - this.x, dy = this.ty - this.y;
    // horizontal first, then vertical: tidy pixel-art movement
    if (Math.abs(dx) > 0.5) {
      this.left = dx < 0;
      this.x += Math.sign(dx) * Math.min(step, Math.abs(dx));
      this.dist += step;
    } else if (Math.abs(dy) > 0.5) {
      this.y += Math.sign(dy) * Math.min(step, Math.abs(dy));
      this.dist += step;
    } else {
      const nap = Math.random() < 0.35;
      this.state = nap ? "loaf" : "sit";
      this.until = now + (nap ? 12000 + Math.random() * 14000 : 2500 + Math.random() * 4000);
    }
  }

  draw(out: DrawCall[], now: number) {
    const pose = this.state === "walk" ? (Math.floor(this.dist / 3) % 2 ? "walk1" : "walk0") : this.state;
    const spr = catSprite(pose, this.left, this.coat);
    const hopY = now - this.hop < 300 ? Math.round(Math.sin(((now - this.hop) / 300) * Math.PI) * 6) : 0;
    const x = Math.round(this.x) - (SPRITE_W >> 1), y = Math.round(this.y) - SPRITE_FOOT - hopY;
    out.push({
      y: this.y,
      fn: (g) => {
        g.fillStyle = "rgba(14,13,22,0.3)";
        g.fillRect(Math.round(this.x) - 5, Math.round(this.y) + 1, 10, 1);
        g.drawImage(spr.c, x, y);
        if (this.state === "loaf" && Math.floor(now / 1400) % 3 === 0) {
          g.fillStyle = "rgba(201,199,216,0.8)";
          g.fillRect(Math.round(this.x) + 6, y + 14 - (Math.floor(now / 350) % 3), 1, 1);
        }
      },
    });
  }
}
