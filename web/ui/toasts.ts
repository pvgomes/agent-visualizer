/*
 * Toasts for the big moments (a flipped table, a passing suite, an agent
 * waiting on you). Top centre, stacked, auto-dismissed, and rate-limited so a
 * busy office reads as a heartbeat rather than a slot machine.
 */
import type { AgentKind } from "../../src/shared/events.ts";
import { h } from "./dom.ts";
import { glyph, type Glyph } from "./icons.ts";
import { logo } from "./logos.ts";
import type { Tone } from "./format.ts";

export interface ToastOpts {
  text: string;
  tone: Tone;
  agent?: AgentKind;
  glyph?: Glyph;
  /** Same key within `every` ms is dropped. */
  key?: string;
  every?: number;
  ttl?: number;
}

const MAX_VISIBLE = 2;
const GAP_MS = 900;
const MAX_QUEUE = 3;

export class Toasts {
  readonly el = h("div", { class: "toasts", attrs: { role: "status", "aria-live": "polite" } });
  private seen = new Map<string, number>();
  private queue: ToastOpts[] = [];
  private lastShown = 0;
  private timer = 0;

  show(t: ToastOpts): void {
    const now = Date.now();
    const key = t.key ?? t.text;
    const last = this.seen.get(key);
    if (last !== undefined && now - last < (t.every ?? 8000)) return;
    this.seen.set(key, now);
    if (this.seen.size > 200) this.seen.clear();
    if (this.queue.length >= MAX_QUEUE) this.queue.shift();
    this.queue.push(t);
    this.flush();
  }

  clear(): void {
    this.queue = [];
    this.el.replaceChildren();
  }

  private flush(): void {
    clearTimeout(this.timer);
    if (!this.queue.length) return;
    const wait = this.lastShown + GAP_MS - Date.now();
    if (wait > 0) {
      this.timer = window.setTimeout(() => this.flush(), wait);
      return;
    }
    this.render(this.queue.shift()!);
    this.lastShown = Date.now();
    if (this.queue.length) this.timer = window.setTimeout(() => this.flush(), GAP_MS);
  }

  private render(t: ToastOpts): void {
    const ttl = t.ttl ?? 4600;
    const toast = h(
      "div",
      { class: `toast glass tone-${t.tone}` },
      t.agent ? logo(t.agent, "toast-logo") : null,
      t.glyph ? h("span", { class: "toast-glyph" }, glyph(t.glyph, 2)) : null,
      h("span", { class: "toast-text", text: t.text }),
      h("span", { class: "toast-timer" }),
    );
    toast.style.setProperty("--ttl", `${ttl}ms`);
    this.el.prepend(toast);
    while (this.el.childElementCount > MAX_VISIBLE) this.el.lastElementChild?.remove();
    window.setTimeout(() => {
      toast.classList.add("leave");
      window.setTimeout(() => toast.remove(), 260);
    }, ttl);
  }
}
