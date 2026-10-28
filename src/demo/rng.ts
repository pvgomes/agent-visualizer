/*
 * Seeded randomness for the demo (mulberry32). Every choice the simulator
 * makes goes through one of these, so a seed replays the same office.
 */
export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = (Math.floor(seed) ^ 0x9e3779b9) >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Float in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Integer in [min, max], inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }

  weighted<T>(items: readonly (readonly [T, number])[]): T {
    const total = items.reduce((n, [, w]) => n + w, 0);
    let r = this.next() * total;
    for (const [v, w] of items) if ((r -= w) < 0) return v;
    return items[items.length - 1]![0];
  }

  hex(n: number): string {
    let out = "";
    while (out.length < n) out += Math.floor(this.next() * 16).toString(16);
    return out;
  }

  uuid(): string {
    const h = this.hex(32);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${"89ab"[this.int(0, 3)]}${h.slice(17, 20)}-${h.slice(20)}`;
  }

  /** An independent stream, so one worker's choices don't shift another's. */
  fork(): Rng {
    return new Rng(Math.floor(this.next() * 4294967296));
  }
}
