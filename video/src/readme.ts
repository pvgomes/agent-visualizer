/*
 * The README's media: a looping screen recording of the real app (demo.gif /
 * demo.mp4) and five stills at 2x. Same engine as the launch video: the real
 * web app in the iframe, the control mock on the virtual clock, a cursor that
 * clicks the app's own buttons and keys. No titles here; it is the product.
 */
import type { Cut, Engine, Shot } from "./stage.ts";
import { T } from "./script.ts";
import { INK, clamp, ease, ramp } from "./type.ts";
import { $, centerOf, cursor, full, keycap, mixUi, place, rectOf, ripple, type UiView } from "./uishots.ts";

type Target = string | ((e: Engine) => HTMLElement | null);

type Act =
  | { t: number; click: Target; fx?: number; fy?: number }
  | { t: number; type: string; into: string; rate?: number }
  | { t: number; key: string; code: string; cap?: { label: string; near: Target } }
  | { t: number; run: (e: Engine) => void };

const find = (e: Engine, t: Target) => (typeof t === "string" ? $(e, t) : t(e));

interface ScriptOpts {
  at?: number;
  /** Open the app (first shot). */
  open?: boolean;
  /** Close it at the end (last shot). */
  close?: boolean;
  cursor?: boolean;
  /** Where the camera holds on the app (default: the whole window). */
  view?: (e: Engine, lt: number) => UiView;
  still?: { at: number; clip?: (e: Engine) => { x: number; y: number; w: number; h: number } | null };
}

/** A shot of the app doing things: clicks, typing, keys at shot-local seconds, with a cursor that travels between them. */
function uiScript(name: string, dur: number, acts: Act[], o: ScriptOpts = {}): Shot & { stillAt?: number } {
  const clicks = acts.filter((a): a is Extract<Act, { click: Target }> => "click" in a);
  const keys = acts.filter((a): a is Extract<Act, { key: string }> => "key" in a);
  return {
    stillAt: o.still?.at,
    name,
    dur,
    at: o.at,
    ui: true,
    bed: 0,
    async enter(e) {
      if (o.open) {
        await e.openApp(e.app.w, e.app.h, e.W / e.app.w);
        place(e, full(e));
        await e.worldTo(e.wNow + 500);
      }
      e.s.from = (e.mem.cursor as { x: number; y: number } | undefined) ?? { x: e.W * 0.62, y: e.H * 0.86 };
    },
    update(e, lt) {
      place(e, o.view ? o.view(e, lt) : full(e));
      // each action fires once, on the first frame at or after its time (whatever the frame rate)
      const fired = (e.s.fired ??= new Set<Act>()) as Set<Act>;
      for (const a of acts) {
        if (!("type" in a)) {
          if (lt < a.t - 1e-6 || fired.has(a)) continue;
          fired.add(a);
        }
        if ("click" in a) {
          find(e, a.click)?.click();
          e.cue("click");
        } else if ("key" in a) {
          e.bridge?.doc?.dispatchEvent(new KeyboardEvent("keydown", { key: a.key, code: a.code, bubbles: true }));
          e.cue("keycap");
        } else if ("run" in a) a.run(e);
        else if ("type" in a) {
          const rate = a.rate ?? 0.026;
          if (lt < a.t || lt > a.t + a.type.length * rate + 0.1) continue;
          const el = $(e, a.into) as HTMLTextAreaElement | HTMLInputElement | null;
          if (!el) continue;
          if (e.bridge?.doc?.activeElement !== el) el.focus();
          const n = Math.min(a.type.length, Math.floor((lt - a.t) / rate) + 1);
          if (el.value.length !== n) {
            el.value = a.type.slice(0, n);
            el.dispatchEvent(new Event("input", { bubbles: true }));
          }
        }
      }
      // the still's frame is the one the renderer picks for it: same rounding
      e.clip = o.still && Math.round(e.t * e.fps) === Math.round((e.shotStart + o.still.at) * e.fps) ? (o.still.clip?.(e) ?? null) : null;
    },
    drawOver(e, g, lt) {
      if (o.cursor === false) return;
      const s = Math.max(2, Math.round(2 * (e.W / 1200)));
      // the cursor goes to each click's target in turn, arriving just before it; a target is
      // measured once, while its element is on screen, so a button that closes doesn't pull it away
      const targets = (e.s.targets ??= new Map<Act, { x: number; y: number }>()) as Map<Act, { x: number; y: number }>;
      let p = e.s.from as { x: number; y: number };
      let prevT = -1;
      for (const c of clicks) {
        if (!targets.has(c)) {
          const r = rectOf(e, find(e, c.click));
          if (r && r.w > 0 && r.h > 0) targets.set(c, { x: r.x + r.w * (c.fx ?? 0.5), y: r.y + r.h * (c.fy ?? 0.5) });
        }
        const to = targets.get(c) ?? p;
        if (lt <= prevT + 0.12) break;
        const k = ease.inOutCubic(ramp(lt, Math.max(prevT + 0.12, c.t - 0.55), c.t - 0.04));
        p = { x: p.x + (to.x - p.x) * k, y: p.y + (to.y - p.y) * k - Math.sin(k * Math.PI) * 24 };
        prevT = c.t;
        if (lt < c.t) break;
      }
      e.mem.cursor = p;
      const press = clicks.some((c) => lt >= c.t && lt < c.t + 0.1) ? 1 : 0;
      for (const c of clicks) ripple(g, p.x, p.y, ramp(lt, c.t, c.t + 0.4), INK.claude);
      // the cursor rests out of the way between clicks: it fades once its last click is done
      const last = clicks.length ? clicks[clicks.length - 1]!.t : -1;
      const a = clicks.length ? 1 - ramp(lt, last + 0.5, last + 0.9) : 0;
      e.mem.cursorAlpha = a;
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
        keycap(g, k.key, k.cap.label, r.x + r.w / 2, Math.min(r.y + r.h + 8 * s, e.H - 20 * s), Math.round(3 * (e.W / 1200)), lt, k.t, "center");
      }
    },
    exit(e) {
      if (o.close) e.closeApp();
    },
  };
}

const PROMPT = "add a --json flag to the table output";

/** Closer on the session panel, or back out: the panel's middle at `zoom` times the window's scale. */
function onPanel(zoom: number, inAt: number, outAt = Infinity, from = 1) {
  return (e: Engine, lt: number): UiView => {
    const r = $(e, ".session:not([hidden])")?.getBoundingClientRect();
    const c = r && r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : (e.s.panelC as { x: number; y: number } | undefined);
    if (r && r.width) e.s.panelC = c;
    const base = full(e);
    if (!c) return base;
    const at = (z: number): UiView => (z === 1 ? base : { cx: c.x, cy: c.y, s: base.s * z });
    const kIn = ease.inOutCubic(ramp(lt, inAt, inAt + 0.6));
    const kOut = ease.inOutCubic(ramp(lt, outAt, outAt + 0.6));
    return mixUi(mixUi(at(from), at(zoom), kIn), base, kOut);
  };
}
const lastDiffRow = (e: Engine) => {
  const rows = e.bridge?.doc?.querySelectorAll<HTMLElement>(".session .wrow.c-edit.has-detail .wrow-main");
  return rows && rows.length ? rows[rows.length - 1]! : null;
};
const approvalCard = (e: Engine) =>
  e.bridge?.doc?.querySelector<HTMLElement>(".session .is-actionable") ?? $(e, ".apbar:not([hidden])");

/* ------------------------------------------------------------- demo.gif / demo.mp4 */

/** About 20 s that loop: the office, Hire, the walk from the lift, the chat at work with a diff, an approval answered with 1, an intern, a flip. */
const demoShots = (): Shot[] => [
  uiScript("office", 2.4, [], { at: T.readme, open: true }),
  uiScript("hire", 3.4, [
    { t: 0.35, click: ".tb-hire" },
    { t: 0.95, click: '.hire-mode[data-mode="chat"]', fx: 0.3 },
    { t: 1.15, click: "textarea.hire-prompt", fx: 0.8, fy: 0.7 },
    { t: 1.25, type: PROMPT, into: "textarea.hire-prompt" },
    { t: 2.5, click: ".hire button[type=submit]", fx: 0.4 },
    { t: 3.0, click: ".session .ses-logo", fx: 0.5 },
    { t: 2.51, run: (e) => (e.mem.hiredAt = e.wNow) },
  ]),
  uiScript("work", 3.6, [{ t: 2.45, click: lastDiffRow, fx: 0.3 }], { view: onPanel(1.3, 0.1) }),
  uiScript("approve", 2.6, [{ t: 0.55, key: "1", code: "Digit1", cap: { label: "allow", near: approvalCard } }], { view: onPanel(1.3, -1, Infinity, 1.3) }),
  uiScript("close", 1.1, [{ t: 0.5, click: ".session .ses-close" }], { view: onPanel(1.3, -1, 0.0, 1.3) }),
  uiScript("intern", 2.8, []),
  uiScript("flip", 4.6, [], { close: true }),
];

/** About 20 s that loop: the office, Hire, the walk from the lift, the chat at work with a diff, an approval answered with 1, an intern, a flip. demo.mp4. */
export const readme: Cut = { name: "readme", w: 1200, h: 750, app: { w: 1000, h: 625 }, shots: demoShots() };

/** The same clip for demo.gif: 960 wide, the app at 1:1 so the office's pixels stay whole, 10 fps. */
export const readmeGif: Cut = { name: "readme-gif", w: 960, h: 600, app: { w: 960, h: 600 }, gif: { every: 3 }, shots: demoShots() };

/* ------------------------------------------------------------- stills at 2x */

/** The office canvas on its own (the stage's scene, not the app's), close on the cloud wing. */
function cloudStill(dur: number, at: number): Shot & { stillAt: number } {
  return {
    name: "cloud",
    dur,
    stillAt: at,
    office: true,
    bed: 0,
    update(e) {
      const pods = e.cloudPods();
      const { wing } = e.geo();
      if (!pods || !wing) return;
      // the wing and its three pods on the right, the glass and the office's edge on the left
      const cw = 2400, ch = 1500, z = 5;
      const x = wing.x + wing.w + 8 - cw / 2 / z;
      const y = pods.y + pods.h / 2 - 4;
      e.view({ x, y, z });
      e.clip = Math.round(e.t * e.fps) === Math.round((e.shotStart + at) * e.fps) ? { x: (e.W - cw) / 2, y: (e.H - ch) / 2, w: cw, h: ch } : null;
    },
  };
}

const css = (e: Engine, x: number, y: number, w: number, h: number) => {
  const k = e.W / e.app.w;
  const cx = clamp(x, 0, e.app.w - w), cy = clamp(y, 0, e.app.h - h);
  return { x: Math.round(cx * k), y: Math.round(cy * k), w: Math.round(w * k), h: Math.round(h * k) };
};

const stillShots: (Shot & { stillAt?: number })[] = [
  // the whole window: the office with its chrome, every desk busy, the cloud wing lit
  uiScript("hero", 1.0, [], { at: T.cloud + 5_000, open: true, cursor: false, still: { at: 0.9 } }),
  // the cloud wing: the same renderer, framed on the three sandbox pods at a whole zoom
  cloudStill(1.0, 0.9),
  // the hire dialog, filled in
  uiScript("hire", 1.9, [
    { t: 0.1, run: (e) => $(e, '.inspector [aria-label="Close inspector"]')?.click() },
    { t: 0.2, click: ".tb-hire" },
    { t: 0.8, click: '.hire-mode[data-mode="chat"]' },
    { t: 1.0, type: PROMPT, into: "textarea.hire-prompt", rate: 0.012 },
  ], {
    at: T.readme,
    cursor: false,
    still: { at: 1.8, clip: (e) => { const c = centerOf($(e, "dialog.hire")); return c ? css(e, c.x - 600, 0, 1200, 900) : null; } },
  }),
  // the chat mid-turn, a diff open
  uiScript("chat", 3.9, [
    { t: 0.05, click: ".hire button[type=submit]" },
    { t: 0.4, click: ".session .ses-logo" },
    { t: 3.45, click: lastDiffRow },
  ], { cursor: false, still: { at: 3.85, clip: (e) => css(e, e.app.w - 1200, 0, 1200, 900) } }),
  // the inline approval card
  uiScript("approval", 0.8, [], {
    cursor: false,
    close: true,
    still: { at: 0.7, clip: (e) => { const c = centerOf(approvalCard(e)); return c ? css(e, c.x - 600, c.y - 420, 1200, 750) : null; } },
  }),
];

/** Each shot's still moment, offset by where the shot starts in the cut. */
const stills: { t: number; name: string }[] = [];
{
  let t0 = 0;
  for (const s of stillShots) {
    if (s.stillAt !== undefined) stills.push({ t: t0 + s.stillAt, name: s.name });
    t0 += s.dur;
  }
}

export const stillsCut: Cut = {
  name: "stills",
  w: 2880,
  h: 1800,
  app: { w: 1440, h: 900 },
  shots: stillShots,
  stills,
};
