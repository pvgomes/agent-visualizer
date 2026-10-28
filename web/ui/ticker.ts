/*
 * A rolling odometer for the HUD counters: each digit is a reel of 0-9 that
 * slides to its new value. Non-digit characters (",", ".", "k") are static.
 * Under prefers-reduced-motion the CSS drops the transition, so it just swaps.
 */
import { h } from "./dom.ts";
import { fmtCount } from "./format.ts";

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";

/** At most one roll per counter this often: faster updates would leave digits forever mid-roll. */
const ROLL_GAP_MS = 1_000;

export class Ticker {
  readonly el: HTMLSpanElement = h("span", { class: "ticker", attrs: { "aria-hidden": "true" } });
  private shown = "";
  private reels: (HTMLSpanElement | null)[] = [];
  private lastRoll = Number.NEGATIVE_INFINITY;
  private queued: number | null = null;
  private timer = 0;

  constructor(private readonly fmt: (n: number) => string = fmtCount) {}

  get text(): string {
    return this.shown;
  }

  /** Show n. A busy counter coalesces: the latest value rolls in once the previous roll has settled. */
  set(n: number, animate = true): boolean {
    const s = this.fmt(n);
    if (s === this.shown && this.queued === null) return false;
    if (!animate) {
      this.cancel();
      return this.render(n, false);
    }
    const now = performance.now();
    const wait = this.lastRoll + ROLL_GAP_MS - now;
    if (wait > 0) {
      this.queued = n;
      if (!this.timer) {
        this.timer = window.setTimeout(() => {
          this.timer = 0;
          const q = this.queued;
          this.queued = null;
          if (q !== null) this.set(q, true);
        }, wait);
      }
      return s !== this.shown;
    }
    this.queued = null;
    this.lastRoll = now;
    return this.render(n, true);
  }

  private cancel(): void {
    clearTimeout(this.timer);
    this.timer = 0;
    this.queued = null;
  }

  private render(n: number, animate: boolean): boolean {
    const s = this.fmt(n);
    if (s === this.shown) return false;
    const prev = this.shown;
    this.shown = s;
    const sameShape = prev.length === s.length && [...s].every((c, i) => isDigit(c) === isDigit(prev[i]));
    if (!sameShape) this.rebuild(s, prev);
    if (!animate) this.el.classList.add("still");
    const apply = () => {
      [...s].forEach((c, i) => {
        const reel = this.reels[i];
        if (reel && isDigit(c)) reel.style.transform = `translateY(${-Number(c) * 10}%)`;
      });
      if (!animate) requestAnimationFrame(() => this.el.classList.remove("still"));
    };
    // Fresh reels need one frame at their start digit before rolling.
    if (!sameShape && animate) requestAnimationFrame(() => requestAnimationFrame(apply));
    else apply();
    return true;
  }

  private rebuild(s: string, prev: string): void {
    this.el.replaceChildren();
    this.reels = [];
    const offset = prev.length - s.length;
    [...s].forEach((c, i) => {
      if (!isDigit(c)) {
        this.el.append(h("span", { class: "tick-static", text: c }));
        this.reels.push(null);
        return;
      }
      const strip = h("span", { class: "tick-strip" });
      for (let d = 0; d <= 9; d++) strip.append(h("span", { text: String(d) }));
      // Start from the digit that sat in this column (aligned right), so 99 -> 100 rolls naturally.
      const was = prev[i + offset];
      strip.style.transform = `translateY(${-(isDigit(was) ? Number(was) : 0) * 10}%)`;
      this.el.append(h("span", { class: "tick-reel" }, strip));
      this.reels.push(strip);
    });
  }
}
