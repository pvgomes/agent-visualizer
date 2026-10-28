/*
 * Particles and one-off flyers: confetti, monitor sparks, smoke puffs, loose
 * papers, keystroke sparkles, coffee steam, floating zZz, the elevator "ding",
 * ambient dust motes and paper airplanes carrying prompts. Everything lives in
 * world pixels and is drawn into the low-res buffer.
 */
import { C, rgba } from "./palette.ts";
import { MICRO, drawText } from "./font.ts";
import { planeSprite } from "./props.ts";

type Kind = "confetti" | "spark" | "smoke" | "paper" | "key" | "steam" | "zzz" | "ding" | "dust" | "star";

interface P {
  kind: Kind;
  x: number; y: number;
  vx: number; vy: number;
  g: number;
  drag: number;
  life: number; max: number;
  color: string;
  size: number;
  rot: number; vr: number;
  floor: number;
  text?: string;
}

interface Plane {
  x0: number; y0: number; c1x: number; c1y: number; c2x: number; c2y: number; x1: number; y1: number;
  t0: number; dur: number; done?: () => void;
}

const MAX = 2400;

export class Fx {
  ps: P[] = [];
  planes: Plane[] = [];
  private dust: { x: number; y: number; life: number; ph: number; rx: number; ry: number; rw: number; rh: number }[] = [];

  add(p: Partial<P> & { kind: Kind; x: number; y: number }) {
    if (this.ps.length >= MAX) this.ps.shift();
    this.ps.push({
      vx: 0, vy: 0, g: 0, drag: 0, life: 0, max: 1000, color: C.white, size: 1, rot: 0, vr: 0, floor: Infinity,
      ...p,
    });
  }

  confetti(x: number, y: number, colors: string[]) {
    for (let i = 0; i < 70; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
      const s = 40 + Math.random() * 90;
      this.add({
        kind: "confetti", x: x + (Math.random() - 0.5) * 6, y,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s, g: 120, drag: 1.6,
        max: 1800 + Math.random() * 1200, color: colors[i % colors.length],
        rot: Math.random() * 6, vr: (Math.random() - 0.5) * 18, floor: y + 18 + Math.random() * 10,
      });
    }
  }

  sparks(x: number, y: number, n = 26) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 30 + Math.random() * 110;
      this.add({
        kind: "spark", x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 40, g: 260, drag: 0.6,
        max: 300 + Math.random() * 500, color: Math.random() < 0.3 ? C.white : Math.random() < 0.5 ? C.gold3 : C.gold2,
        floor: y + 22 + Math.random() * 6,
      });
    }
  }

  smoke(x: number, y: number, n = 10, dark = false) {
    for (let i = 0; i < n; i++) {
      this.add({
        kind: "smoke", x: x + (Math.random() - 0.5) * 8, y: y + (Math.random() - 0.5) * 3,
        vx: (Math.random() - 0.5) * 10, vy: -8 - Math.random() * 14, drag: 0.8,
        max: 900 + Math.random() * 900, color: dark ? C.slate1 : Math.random() < 0.5 ? C.slate4 : C.slate5,
        size: 2 + Math.random() * 2,
      });
    }
  }

  papers(x: number, y: number, n = 8) {
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.6;
      const s = 40 + Math.random() * 70;
      this.add({
        kind: "paper", x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, g: 70, drag: 2.2,
        max: 2600 + Math.random() * 1400, color: Math.random() < 0.2 ? C.gold4 : C.white,
        rot: Math.random() * 6, vr: (Math.random() - 0.5) * 8, floor: y + 14 + Math.random() * 18,
      });
    }
  }

  key(x: number, y: number, color: string) {
    this.add({ kind: "key", x: x + (Math.random() - 0.5) * 12, y, vx: (Math.random() - 0.5) * 16, vy: -18 - Math.random() * 18, g: 60, max: 450, color });
  }

  steam(x: number, y: number) {
    this.add({ kind: "steam", x, y, vx: 0, vy: -5, max: 1600, color: C.white, rot: Math.random() * 6 });
  }

  zzz(x: number, y: number) {
    this.add({ kind: "zzz", x, y, vx: 4, vy: -7, max: 2600, color: C.slate5, text: "z" });
  }

  ding(x: number, y: number) {
    this.add({ kind: "ding", x, y, vx: 0, vy: -10, max: 1300, color: C.gold3, text: "DING" });
  }

  stars(x: number, y: number, color: string) {
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      this.add({ kind: "star", x, y, vx: Math.cos(a) * 26, vy: Math.sin(a) * 26 - 8, drag: 3, max: 500, color });
    }
  }

  plane(x0: number, y0: number, x1: number, y1: number, now: number, done?: () => void) {
    const dx = x1 - x0;
    this.planes.push({
      x0, y0, x1, y1,
      c1x: x0 + dx * 0.55, c1y: y0 + 90,
      c2x: x1 - dx * 0.1, c2y: y1 - 70,
      t0: now, dur: 1500, done,
    });
  }

  /** Ambient dust floating in light, seeded inside `rects`. */
  seedDust(rects: { x: number; y: number; w: number; h: number }[]) {
    this.dust = [];
    for (const r of rects) {
      const n = Math.round((r.w * r.h) / 500);
      for (let i = 0; i < n; i++) {
        this.dust.push({ x: r.x + Math.random() * r.w, y: r.y + Math.random() * r.h, life: Math.random() * 8000, ph: Math.random() * 6, rx: r.x, ry: r.y, rw: r.w, rh: r.h });
      }
    }
  }

  update(dt: number, now: number) {
    const s = dt / 1000;
    const out: P[] = [];
    for (const p of this.ps) {
      p.life += dt;
      if (p.life >= p.max) continue;
      p.vx -= p.vx * p.drag * s;
      p.vy -= p.vy * p.drag * s;
      p.vy += p.g * s;
      p.x += p.vx * s;
      p.y += p.vy * s;
      p.rot += p.vr * s;
      if (p.kind === "confetti" || p.kind === "paper") p.x += Math.sin(p.life * 0.01 + p.rot) * 0.25;
      if (p.y > p.floor) { p.y = p.floor; p.vy = 0; p.vx *= 0.8; p.vr = 0; p.g = 0; }
      out.push(p);
    }
    this.ps = out;
    for (const d of this.dust) {
      d.life += dt;
      d.x += Math.sin(d.life * 0.0007 + d.ph) * 0.0018 * dt;
      d.y += Math.cos(d.life * 0.0005 + d.ph * 2) * 0.0012 * dt - 0.0006 * dt;
      if (d.y < d.ry) d.y += d.rh;
      if (d.x < d.rx) d.x += d.rw;
      if (d.x > d.rx + d.rw) d.x -= d.rw;
    }
    this.planes = this.planes.filter((pl) => {
      if (now - pl.t0 >= pl.dur) { pl.done?.(); return false; }
      return true;
    });
  }

  draw(g: CanvasRenderingContext2D, now: number) {
    for (const p of this.ps) {
      const k = p.life / p.max;
      const x = Math.round(p.x), y = Math.round(p.y);
      switch (p.kind) {
        case "confetti": {
          g.globalAlpha = k > 0.8 ? (1 - k) * 5 : 1;
          g.fillStyle = p.color;
          const w = Math.abs(Math.cos(p.rot)) > 0.5 ? 2 : 1;
          g.fillRect(x, y, w, 3 - w);
          break;
        }
        case "spark":
          g.globalAlpha = 1 - k * k;
          g.fillStyle = p.color;
          g.fillRect(x, y, 1, 1);
          if (k < 0.4) { g.globalAlpha *= 0.5; g.fillRect(Math.round(p.x - p.vx * 0.015), Math.round(p.y - p.vy * 0.015), 1, 1); }
          break;
        case "smoke": {
          g.globalAlpha = (1 - k) * 0.75;
          g.fillStyle = p.color;
          const s = Math.round(p.size + k * 4);
          g.fillRect(x - (s >> 1), y - (s >> 1) + 1, s, s - 2);
          g.fillRect(x - (s >> 1) + 1, y - (s >> 1), s - 2, s);
          break;
        }
        case "paper": {
          g.globalAlpha = k > 0.85 ? (1 - k) / 0.15 : 1;
          g.fillStyle = p.color;
          const flat = p.g === 0;
          const w = flat ? 3 : Math.abs(Math.cos(p.rot)) > 0.5 ? 3 : 2;
          g.fillRect(x, y, w, flat ? 2 : 4 - w + 1);
          g.fillStyle = C.slate4;
          g.fillRect(x, y + (flat ? 1 : 2), w, 1);
          break;
        }
        case "key":
          g.globalAlpha = 1 - k;
          g.fillStyle = p.color;
          g.fillRect(x, y, 1, 1);
          break;
        case "steam": {
          g.globalAlpha = (1 - k) * 0.55;
          g.fillStyle = p.color;
          g.fillRect(Math.round(p.x + Math.sin(p.life * 0.006 + p.rot) * 1.5), y, 1, 2);
          break;
        }
        case "zzz":
          g.globalAlpha = 1 - k;
          drawText(g, MICRO(), k > 0.4 ? "Z" : "z", Math.round(p.x + Math.sin(p.life * 0.004) * 2), y, p.color);
          break;
        case "ding":
          g.globalAlpha = k > 0.7 ? (1 - k) / 0.3 : 1;
          drawText(g, MICRO(), p.text!, x - 7, y + 1, C.ink2);
          drawText(g, MICRO(), p.text!, x - 8, y, p.color);
          break;
        case "star":
          g.globalAlpha = 1 - k;
          g.fillStyle = p.color;
          g.fillRect(x, y, 1, 1);
          break;
      }
    }
    g.globalAlpha = 1;
    // airplanes with a dotted trail
    for (const pl of this.planes) {
      const u = Math.min(1, (now - pl.t0) / pl.dur);
      const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
      const at = (t: number) => {
        const m = 1 - t;
        return [
          m * m * m * pl.x0 + 3 * m * m * t * pl.c1x + 3 * m * t * t * pl.c2x + t * t * t * pl.x1,
          m * m * m * pl.y0 + 3 * m * m * t * pl.c1y + 3 * m * t * t * pl.c2y + t * t * t * pl.y1,
        ];
      };
      // swoosh trail
      for (let i = 1; i < 16; i++) {
        const tt = e - i * 0.018;
        if (tt <= 0) break;
        if (i % 2) continue;
        const [tx, ty] = at(tt);
        g.fillStyle = rgba(C.white, 0.75 - i * 0.045);
        g.fillRect(Math.round(tx), Math.round(ty), 1, 1);
      }
      const [px, py] = at(e);
      const [qx, qy] = at(Math.min(1, e + 0.015));
      const ang = Math.atan2(qy - py, qx - px);
      const left = Math.cos(ang) < 0;
      const sp = planeSprite();
      // shadow on the floor far below
      g.fillStyle = rgba(C.ink, 0.22);
      g.fillRect(Math.round(px) - 4, Math.round(py) + 16, 8, 1);
      g.save();
      g.translate(Math.round(px), Math.round(py));
      if (left) { g.scale(-1, 1); g.rotate(Math.PI - ang); } else g.rotate(ang);
      g.drawImage(sp.c, -7, -4);
      g.restore();
    }
  }

  drawDust(g: CanvasRenderingContext2D, alpha: number) {
    if (alpha <= 0.01) return;
    g.fillStyle = C.gold4;
    for (const d of this.dust) {
      const tw = 0.5 + 0.5 * Math.sin(d.life * 0.002 + d.ph * 5);
      g.globalAlpha = alpha * tw * 0.7;
      g.fillRect(Math.round(d.x), Math.round(d.y), 1, 1);
    }
    g.globalAlpha = 1;
  }
}
