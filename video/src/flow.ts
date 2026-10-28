/*
 * A shot of the real web app doing things: clicks, typing, keys and scrolls
 * at shot-local seconds, a cursor that travels to each click, and a camera
 * that eases between parts of the app (a dialog's section, a card, the
 * panel). The app is the real one (web/main.ts) in the stage's iframe; every
 * act is a DOM event on its own elements.
 */
import type { Engine, Shot } from "./stage.ts";
import type { Feature } from "./band.ts";
import { INK, clamp, ease, ramp } from "./type.ts";
import { $, cursor, keycap, rectOf, ripple, spotlight, type UiView } from "./uishots.ts";

export type Target = string | ((e: Engine) => HTMLElement | null);

export type Act =
  | { t: number; click: Target; fx?: number; fy?: number; hide?: boolean }
  | { t: number; type: string; into: Target; rate?: number }
  | { t: number; key: string; code: string; on?: Target; cap?: { label: string; near: Target; above?: boolean } }
  | { t: number; scroll: Target; dur?: number }
  | { t: number; run: (e: Engine) => void };

export const find = (e: Engine, t: Target) => (typeof t === "string" ? $(e, t) : t(e));
export const all = (e: Engine, sel: string) => [...(e.bridge?.doc?.querySelectorAll<HTMLElement>(sel) ?? [])];
export const withText = (sel: string, text: string | RegExp) => (e: Engine) =>
  all(e, sel).find((el) => (typeof text === "string" ? (el.textContent ?? "").includes(text) : text.test(el.textContent ?? ""))) ?? null;

/** The rect (app CSS px) around one or more elements. */
function rectAround(e: Engine, targets: Target[]): DOMRect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const t of targets) {
    const el = find(e, t);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    x0 = Math.min(x0, r.left);
    y0 = Math.min(y0, r.top);
    x1 = Math.max(x1, r.right);
    y1 = Math.max(y1, r.bottom);
  }
  return Number.isFinite(x0) ? new DOMRect(x0, y0, x1 - x0, y1 - y0) : null;
}

/** Frame these elements in the part of the frame above the band, as big as fits (up to `max`x the app's own size). */
export function frame(targets: Target | Target[], o: { pad?: number; max?: number; min?: number; dx?: number; dy?: number } = {}) {
  return (e: Engine): UiView | null => {
    const r = rectAround(e, Array.isArray(targets) ? targets : [targets]);
    if (!r) return null;
    const pad = (o.pad ?? 0.06) * Math.min(e.W, e.regionH);
    const s = clamp(Math.min((e.W - pad * 2) / r.width, (e.regionH - pad * 2) / r.height), o.min ?? 0, o.max ?? 2.4);
    return { cx: r.left + r.width / 2 + (o.dx ?? 0), cy: r.top + r.height / 2 + (o.dy ?? 0), s };
  };
}

/** The whole app window. */
export const whole = (e: Engine): UiView => ({ cx: e.app.w / 2, cy: e.app.h / 2, s: Math.max(e.W / e.app.w, e.regionH / e.app.h) });

export interface FlowOpts {
  at?: number | ((e: Engine) => number);
  feature?: Feature;
  /** Open the app first (the first flow of a cut); `then` runs once it's loaded. */
  open?: { then?: (e: Engine) => void };
  close?: boolean;
  speed?: (lt: number) => number;
  /** Where the camera should be at lt; null: the whole window. Cuts (no easing) at the times in `snap`. */
  cam?: (e: Engine, lt: number) => UiView | null;
  snap?: number[];
  /** Camera ease rate (1/s). */
  rate?: number;
  cursor?: boolean;
  bed?: number;
  /** What to light up (the rest is dimmed), over [from, to) shot seconds. */
  spots?: { from: number; to: number; on: Target | Target[] }[];
  /** How long the cursor takes to reach each click (s); it arrives 0.2 s early and rests there. */
  move?: number;
  draw?: (e: Engine, g: CanvasRenderingContext2D, lt: number) => void;
}

export function placeUi(e: Engine, v: UiView) {
  const APP = e.app;
  const RH = e.regionH;
  const s = Math.max(v.s, e.W / APP.w, RH / APP.h);
  let tx = e.W / 2 - v.cx * s;
  let ty = RH / 2 - v.cy * s;
  tx = clamp(tx, e.W - APP.w * s, 0);
  ty = clamp(ty, RH - APP.h * s, 0);
  e.appEl.style.transform = `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${s.toFixed(4)})`;
  e.mem.ui = { tx, ty, s };
}

/** The scrollable box an element sits in. */
function scroller(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const cs = p.ownerDocument.defaultView?.getComputedStyle(p);
    if (cs && /(auto|scroll)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 2) return p;
  }
  return null;
}

export function flow(name: string, dur: number, acts: Act[], o: FlowOpts = {}): Shot {
  const clicks = acts.filter((a): a is Extract<Act, { click: Target }> => "click" in a && !a.hide);
  const keys = acts.filter((a): a is Extract<Act, { key: string }> => "key" in a);
  return {
    name,
    dur,
    at: o.at,
    ui: true,
    bed: o.bed,
    feature: o.feature,
    speed: o.speed,
    async enter(e) {
      if (o.open) {
        await e.openApp(e.app.w, e.app.h, 2);
        e.mem.uiCam = whole(e);
        placeUi(e, whole(e));
        await e.worldTo(e.wNow + 400);
        o.open.then?.(e);
      }
      e.s.from = (e.mem.cursor as { x: number; y: number } | undefined) ?? { x: e.W * 0.66, y: e.regionH * 0.8 };
      e.s.fired = new Set<Act>();
      e.s.scrolls = new Map<Act, { el: HTMLElement; from: number; to: number }>();
    },
    update(e, lt) {
      const fired = e.s.fired as Set<Act>;
      for (const a of acts) {
        if ("type" in a) {
          const rate = a.rate ?? 0.03;
          if (lt < a.t || lt > a.t + a.type.length * rate + 0.1) continue;
          const el = find(e, a.into) as HTMLTextAreaElement | HTMLInputElement | null;
          if (!el) continue;
          if (e.bridge?.doc?.activeElement !== el) el.focus();
          const n = Math.min(a.type.length, Math.floor((lt - a.t) / rate) + 1);
          if (el.value.length !== n) {
            el.value = a.type.slice(0, n);
            el.dispatchEvent(new Event("input", { bubbles: true }));
            e.cue("key", { vol: 0.35 });
          }
          continue;
        }
        if ("scroll" in a) {
          const sc = e.s.scrolls as Map<Act, { el: HTMLElement; from: number; to: number }>;
          if (lt < a.t) continue;
          if (!sc.has(a)) {
            const target = find(e, a.scroll);
            const box = target && scroller(target);
            if (!target || !box) continue;
            const to = clamp(box.scrollTop + target.getBoundingClientRect().top - box.getBoundingClientRect().top - 12, 0, box.scrollHeight - box.clientHeight);
            sc.set(a, { el: box, from: box.scrollTop, to });
          }
          const s = sc.get(a)!;
          s.el.scrollTop = s.from + (s.to - s.from) * ease.inOutCubic(ramp(lt, a.t, a.t + (a.dur ?? 0.5)));
          continue;
        }
        if (lt < a.t - 1e-6 || fired.has(a)) continue;
        fired.add(a);
        if ("click" in a) {
          find(e, a.click)?.click();
          e.cue("click", { vol: a.hide ? 0.4 : 0.8 });
        } else if ("key" in a) {
          const target = a.on ? find(e, a.on) : null;
          (target ?? e.bridge?.doc)?.dispatchEvent(new KeyboardEvent("keydown", { key: a.key, code: a.code, bubbles: true, cancelable: true }));
          e.cue("keycap");
        } else if ("run" in a) a.run(e);
      }
      // the camera eases to where the shot wants it, or cuts there
      const want = o.cam?.(e, lt) ?? whole(e);
      const cur = (e.mem.uiCam as UiView | undefined) ?? want;
      const snap = (o.snap ?? []).some((t) => Math.abs(lt - t) < 0.5 / e.fps) || !e.mem.uiCam;
      const k = snap ? 1 : 1 - Math.exp(-(1 / e.fps) * (o.rate ?? 6));
      const next: UiView = {
        cx: cur.cx + (want.cx - cur.cx) * k,
        cy: cur.cy + (want.cy - cur.cy) * k,
        s: Math.exp(Math.log(cur.s) + (Math.log(want.s) - Math.log(cur.s)) * k),
      };
      e.mem.uiCam = next;
      placeUi(e, next);
    },
    drawOver(e, g, lt) {
      // the spotlight: everything but the element in use dims, eased in and out
      for (const sp of o.spots ?? []) {
        const k = ease.inOutCubic(ramp(lt, sp.from, sp.from + 0.35)) * (1 - ease.inOutCubic(ramp(lt, sp.to - 0.3, sp.to)));
        if (k <= 0) continue;
        const list = Array.isArray(sp.on) ? sp.on : [sp.on];
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const t of list) {
          const r = rectOf(e, find(e, t));
          if (!r || !r.w) continue;
          x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
        }
        if (Number.isFinite(x0)) spotlight(g, e.W, e.regionH, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, k);
      }
      o.draw?.(e, g, lt);
      if (o.cursor === false) return;
      const s = Math.max(2, Math.round(3 * (Math.min(e.W, e.H) / 1080)));
      const targets = (e.s.targets ??= new Map<Act, { x: number; y: number }>()) as Map<Act, { x: number; y: number }>;
      let p = e.s.from as { x: number; y: number };
      let prevT = -1;
      for (const c of clicks) {
        // measured while the element is on screen, once the camera has settled on it
        if (!targets.has(c) || lt < c.t - 0.05) {
          const r = rectOf(e, find(e, c.click));
          if (r && r.w > 0 && r.h > 0) targets.set(c, { x: r.x + r.w * (c.fx ?? 0.5), y: r.y + r.h * (c.fy ?? 0.5) });
        }
        const to = targets.get(c) ?? p;
        if (lt <= prevT + 0.1) break;
        const mv = o.move ?? 0.75;
        const k = ease.inOutCubic(ramp(lt, Math.max(prevT + 0.15, c.t - 0.2 - mv), c.t - 0.2));
        p = { x: p.x + (to.x - p.x) * k, y: p.y + (to.y - p.y) * k - Math.sin(k * Math.PI) * 14 };
        prevT = c.t;
        if (lt < c.t) break;
      }
      e.mem.cursor = p;
      const press = clicks.some((c) => lt >= c.t && lt < c.t + 0.1) ? 1 : 0;
      for (const c of clicks) ripple(g, p.x, p.y, ramp(lt, c.t, c.t + 0.4), INK.amber);
      const last = clicks.length ? clicks[clicks.length - 1]!.t : -1;
      const first = clicks.length ? clicks[0]!.t : 0;
      const mv = o.move ?? 0.75;
      const a = clicks.length ? ramp(lt, first - 0.25 - mv - 0.25, first - 0.25 - mv) * (1 - ramp(lt, last + 0.7, last + 1.0)) : 0;
      if (a > 0.01) {
        g.save();
        g.globalAlpha = a;
        cursor(g, p.x, p.y, s, press);
        g.restore();
      }
      for (const k of keys) {
        if (!k.cap) continue;
        const r = rectOf(e, find(e, k.cap.near)) ?? (e.s.capR as ReturnType<typeof rectOf>);
        if (r) e.s.capR = r;
        if (!r) continue;
        const ks = Math.round(8 * (Math.min(e.W, e.H) / 1080));
        const ky = k.cap.above ? Math.max(8 * ks, r.y - 20 * ks) : Math.min(r.y + r.h + 6 * ks, e.regionH - 16 * ks);
        keycap(g, k.key, k.cap.label, r.x + r.w / 2, ky, ks, lt, k.t, "center", 1.0);
      }
    },
    exit(e) {
      if (o.close) e.closeApp();
    },
  };
}
