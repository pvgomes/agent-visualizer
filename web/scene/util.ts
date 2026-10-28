/*
 * Small math helpers shared by the scene: hashing (so a worker looks the same
 * on every reload), a seeded PRNG, easing curves and canvas factories.
 */

/** FNV-1a, 32-bit. Stable across reloads and browsers. */
export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: tiny, fast, good enough for art. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOutBack = (t: number) => {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
export const easeInQuad = (t: number) => t * t;
export const easeOutQuad = (t: number) => 1 - (1 - t) * (1 - t);
/** 0..1 ramp of `t` inside [a, b]. */
export const ramp = (t: number, a: number, b: number) => clamp((t - a) / (b - a), 0, 1);

export function pick<T>(arr: readonly T[], n: number): T {
  return arr[((n % arr.length) + arr.length) % arr.length];
}

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

export function ctx2d(c: HTMLCanvasElement, opts?: CanvasRenderingContext2DSettings): CanvasRenderingContext2D {
  const g = c.getContext("2d", opts) as CanvasRenderingContext2D;
  g.imageSmoothingEnabled = false;
  return g;
}

/** A canvas plus its context, the unit every cached sprite is stored as. */
export interface Bitmap {
  c: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
  w: number;
  h: number;
}

export function bitmap(w: number, h: number): Bitmap {
  const c = makeCanvas(w, h);
  return { c, g: ctx2d(c), w: c.width, h: c.height };
}

/** "🧠 deep in the auth refactor" -> { emoji: "🧠", text: "deep in the auth refactor" }. */
export function splitMood(s: string | undefined | null): { emoji: string; text: string } {
  const v = (s ?? "").trim();
  if (!v) return { emoji: "", text: "" };
  const m = /^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*|\p{Regional_Indicator}{2})\s*/u.exec(v);
  return m ? { emoji: m[1], text: v.slice(m[0].length).trim() } : { emoji: "", text: v };
}

/** "5 interns · fork ×4 · general-purpose", shortened to "… · +2" past `maxChars`. */
export function internSummary(roles: string[], maxChars: number): string {
  const counts = new Map<string, number>();
  for (const r of roles) counts.set(r, (counts.get(r) ?? 0) + 1);
  const parts = [...counts].sort((a, b) => b[1] - a[1]).map(([r, n]) => (n > 1 ? `${r} ×${n}` : r));
  let out = `${roles.length} interns`;
  for (let i = 0; i < parts.length; i++) {
    const next = `${out} · ${parts[i]}`;
    const more = parts.length - i - 1;
    if ((more ? `${next} · +${more}` : next).length > maxChars) return `${out} · +${parts.length - i}`;
    out = next;
  }
  return out;
}
