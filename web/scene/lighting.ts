/*
 * Pixel-art lighting. A darkness layer (strength from the local time of day)
 * is laid over the room with light pools punched out of it, then coloured
 * glows are added on top. Light stamps are radial falloffs quantized into
 * soft bands at art-pixel resolution, so light steps like painted pixels.
 */
import { rgb } from "./palette.ts";
import { bitmap, type Bitmap } from "./util.ts";

export interface Light {
  x: number;
  y: number;
  r: number;
  /** how much darkness it removes, 0..1 */
  cut: number;
  /** additive tint (null = only cuts darkness) */
  color?: string | null;
  glow?: number;
  /** squash vertically (floor pools are ellipses in 3/4 view) */
  flat?: number;
}

const stampCache = new Map<number, Bitmap>();
function stamp(radius: number): Bitmap {
  const r = Math.max(4, Math.round(radius / 4) * 4);
  let b = stampCache.get(r);
  if (b) return b;
  const size = r * 2;
  b = bitmap(size, size);
  const img = b.g.createImageData(size, size);
  const LEVELS = 9;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - r, dy = y + 0.5 - r;
      const d = Math.sqrt(dx * dx + dy * dy) / r;
      if (d >= 1) continue;
      let f = 1 - d;
      f = f * f * (3 - 2 * f);
      const a = Math.min(1, Math.round(f * LEVELS) / LEVELS);
      const i = (y * size + x) * 4;
      img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  b.g.putImageData(img, 0, 0);
  stampCache.set(r, b);
  return b;
}

const tintCache = new Map<string, Bitmap>();
function tinted(radius: number, color: string): Bitmap {
  const s = stamp(radius);
  const key = s.w + color;
  let b = tintCache.get(key);
  if (!b) {
    b = bitmap(s.w, s.h);
    b.g.drawImage(s.c, 0, 0);
    b.g.globalCompositeOperation = "source-in";
    b.g.fillStyle = color;
    b.g.fillRect(0, 0, b.w, b.h);
    tintCache.set(key, b);
  }
  return b;
}

export class Lighting {
  private dark: Bitmap | null = null;

  /**
   * `g` is the world buffer context with its world->buffer transform already
   * applied; origin/size describe the buffer.
   */
  apply(
    g: CanvasRenderingContext2D, origin: { x: number; y: number }, size: { w: number; h: number },
    darkness: number, darkColor: string, lights: Light[], holes: { x: number; y: number; w: number; h: number }[],
    clip: { x: number; y: number; w: number; h: number },
  ) {
    g.save();
    g.beginPath();
    g.rect(clip.x, clip.y, clip.w, clip.h);
    g.clip();
    if (darkness > 0.01) {
      if (!this.dark || this.dark.w !== size.w || this.dark.h !== size.h) this.dark = bitmap(size.w, size.h);
      const d = this.dark.g;
      d.setTransform(1, 0, 0, 1, 0, 0);
      d.globalCompositeOperation = "source-over";
      d.globalAlpha = 1;
      d.clearRect(0, 0, size.w, size.h);
      const [r, gg, b] = rgb(darkColor);
      d.fillStyle = `rgba(${r},${gg},${b},${darkness})`;
      d.translate(-origin.x, -origin.y);
      d.fillRect(clip.x, clip.y, clip.w, clip.h);
      d.globalCompositeOperation = "destination-out";
      for (const h of holes) d.fillRect(h.x, h.y, h.w, h.h);
      for (const l of lights) {
        if (l.cut <= 0) continue;
        const s = stamp(l.r);
        d.globalAlpha = Math.min(1, l.cut);
        const fh = s.h * (l.flat ?? 1);
        d.drawImage(s.c, Math.round(l.x - s.w / 2), Math.round(l.y - fh / 2), s.w, Math.round(fh));
      }
      d.globalAlpha = 1;
      g.drawImage(this.dark.c, origin.x, origin.y);
    }
    // coloured glow, additive
    g.save();
    g.globalCompositeOperation = "lighter";
    for (const l of lights) {
      if (!l.color || !l.glow) continue;
      const s = tinted(l.r, l.color);
      g.globalAlpha = Math.min(1, l.glow);
      const fh = s.h * (l.flat ?? 1);
      g.drawImage(s.c, Math.round(l.x - s.w / 2), Math.round(l.y - fh / 2), s.w, Math.round(fh));
    }
    g.restore();
    g.restore();
  }
}

/** A daylight shaft: a slanted quad from a window down across the floor. */
export function shaft(g: CanvasRenderingContext2D, x: number, y: number, w: number, len: number, slant: number, color: string, alpha: number) {
  if (alpha <= 0.01) return;
  g.save();
  g.globalCompositeOperation = "lighter";
  g.fillStyle = color;
  // stepped bands so the edge fades in pixel steps
  for (let i = 0; i < len; i++) {
    const t = i / len;
    const a = alpha * (1 - t) * (i % 2 === 0 ? 1 : 0.85);
    if (a < 0.004) break;
    g.globalAlpha = a;
    g.fillRect(Math.round(x + slant * i), y + i, w, 1);
  }
  g.restore();
}
