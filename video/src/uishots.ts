/*
 * The control shots: the real web app (web/main.ts) in the stage's iframe,
 * served by the control mock on the virtual clock. The stage moves a cursor
 * and clicks the app's own buttons, types into its own fields and presses
 * its own keys; the iframe is scaled for the camera (text re-rasterises crisp).
 */
import type { Engine, Shot } from "./stage.ts";
import { T } from "./script.ts";
import { INK, clamp, ease, lerp, px, ramp, textW } from "./type.ts";
import { caption } from "./titles.ts";

export interface UiView { cx: number; cy: number; s: number }

export const full = (e: Engine): UiView => ({ cx: e.app.w / 2, cy: e.app.h / 2, s: e.W / e.app.w });

export function place(e: Engine, v: UiView) {
  const APP = e.app;
  // keep the app covering the frame above the band
  const RH = e.regionH;
  const s = Math.max(v.s, e.W / APP.w, RH / APP.h);
  let tx = e.W / 2 - v.cx * s;
  let ty = RH / 2 - v.cy * s;
  tx = clamp(tx, e.W - APP.w * s, 0);
  ty = clamp(ty, RH - APP.h * s, 0);
  e.appEl.style.transform = `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${s.toFixed(4)})`;
  e.mem.ui = { tx, ty, s };
}

export const mixUi = (a: UiView, b: UiView, k: number): UiView => ({ cx: lerp(a.cx, b.cx, k), cy: lerp(a.cy, b.cy, k), s: Math.exp(lerp(Math.log(a.s), Math.log(b.s), k)) });

/** An element's rect in stage px. */
export function rectOf(e: Engine, el: Element | null | undefined): { x: number; y: number; w: number; h: number } | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const u = (e.mem.ui as { tx: number; ty: number; s: number }) ?? { tx: 0, ty: 0, s: 1 };
  return { x: u.tx + r.left * u.s, y: u.ty + r.top * u.s, w: r.width * u.s, h: r.height * u.s };
}

/** An element's centre in app CSS px. */
export function centerOf(el: Element | null | undefined): { x: number; y: number } | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

export const $ = (e: Engine, sel: string) => e.bridge?.doc?.querySelector<HTMLElement>(sel) ?? null;

/* ------------------------------------------------------------- cursor */

const ARROW = [
  "X...........",
  "XX..........",
  "XoX.........",
  "XooX........",
  "XoooX.......",
  "XooooX......",
  "XoooooX.....",
  "XooooooX....",
  "XoooooooX...",
  "XooooooooX..",
  "XoooooXXXXX.",
  "XooXooX.....",
  "XoX.XooX....",
  "XX..XooX....",
  "X....XooX...",
  ".....XooX...",
  "......XX....",
];

export function cursor(g: CanvasRenderingContext2D, x: number, y: number, s: number, press: number) {
  const k = 1 - 0.18 * press;
  const ps = Math.max(2, Math.round(s * k));
  g.save();
  g.fillStyle = "rgba(0,0,0,0.35)";
  ARROW.forEach((row, j) => {
    for (let i = 0; i < row.length; i++) if (row[i] !== ".") g.fillRect(Math.round(x + (i + 1) * ps), Math.round(y + (j + 1) * ps), ps, ps);
  });
  ARROW.forEach((row, j) => {
    for (let i = 0; i < row.length; i++) {
      if (row[i] === ".") continue;
      g.fillStyle = row[i] === "X" ? "#0e0d16" : "#f5f1e8";
      g.fillRect(Math.round(x + i * ps), Math.round(y + j * ps), ps, ps);
    }
  });
  g.restore();
}

/** A ring that opens where the cursor clicked. */
export function ripple(g: CanvasRenderingContext2D, x: number, y: number, k: number, color: string) {
  if (k <= 0 || k >= 1) return;
  g.save();
  g.strokeStyle = color;
  g.globalAlpha = 1 - k;
  g.lineWidth = 4;
  g.beginPath();
  g.arc(x, y, 10 + 46 * ease.outCubic(k), 0, Math.PI * 2);
  g.stroke();
  g.restore();
}

/** Dim everything but `r`. */
export function spotlight(g: CanvasRenderingContext2D, W: number, H: number, r: { x: number; y: number; w: number; h: number } | null, k: number) {
  if (!r || k <= 0) return;
  const pad = 10;
  g.save();
  g.fillStyle = `rgba(6,5,11,${0.62 * k})`;
  g.beginPath();
  g.rect(0, 0, W, H);
  g.rect(r.x - pad, r.y - pad, r.w + pad * 2, r.h + pad * 2);
  g.fill("evenodd");
  g.strokeStyle = INK.amber;
  g.globalAlpha = k;
  g.lineWidth = 3;
  g.strokeRect(Math.round(r.x - pad), Math.round(r.y - pad), Math.round(r.w + pad * 2), Math.round(r.h + pad * 2));
  g.restore();
}

/** A keycap with a label beside it, pressed at `at`. */
export function keycap(g: CanvasRenderingContext2D, key: string, label: string, x: number, y: number, s: number, lt: number, at: number, align: "left" | "center" = "left", hold = 0.55) {
  const kk = ease.outBack(ramp(lt, at - 0.45, at - 0.2));
  const gone = ramp(lt, at + hold, at + hold + 0.3);
  if (kk <= 0 || gone >= 1) return;
  const a = clamp(kk, 0, 1) * (1 - gone);
  // the cap fits its key: a square for "1", wider for "Enter"
  const kw = Math.max(13, textW(key, 1) + 8) * s;
  const w = kw + 4 * s + (label ? textW(label, s) : 0);
  const x0 = Math.round(align === "center" ? x - w / 2 : x);
  const y0 = Math.round(y + (1 - kk) * 3 * s);
  const down = lt >= at && lt < at + 0.16 ? s : 0;
  g.save();
  g.globalAlpha = a;
  g.fillStyle = "#06050b";
  g.fillRect(x0, y0 + s, kw, 13 * s);
  g.fillStyle = down ? INK.amber : "#f5f1e8";
  g.fillRect(x0, y0 + down, kw, 12 * s);
  g.fillStyle = "#c9c7d8";
  g.fillRect(x0, y0 + down + 11 * s, kw, s);
  g.restore();
  px(g, key, x0 + kw / 2, y0 + down + 2 * s, s, { align: "center", color: "#0e0d16", shadow: null, alpha: a });
  if (label) px(g, label, x0 + kw + 4 * s, y0 + 3 * s, s, { color: INK.white, alpha: a });
}

function uiCaption(e: Engine, g: CanvasRenderingContext2D, text: string, k: number, accent: string) {
  const s = Math.round(5 * (e.W / 1920));
  caption(g, text, e.W / 2, e.H - 20 * s, s, k, INK.white, accent);
}

/** The cursor's path: from a to b over [t0, t1], eased; then it stays. */
export function path(lt: number, t0: number, t1: number, a: { x: number; y: number }, b: { x: number; y: number }) {
  const k = ease.inOutCubic(ramp(lt, t0, t1));
  // a slight arc, like a hand
  const arc = Math.sin(k * Math.PI) * 40;
  return { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k) - arc };
}

/* ------------------------------------------------------------- shots */

/** A hand goes up; the amber "needs you" in the top bar takes you to it. */
export function uiNeedsYou(dur: number, o: { at?: number; clickAt?: number } = {}): Shot {
  const clickAt = o.clickAt ?? 1.55;
  return {
    name: "ui-needs-you",
    dur,
    at: o.at ?? T.waiting - 900,
    ui: true,
    async enter(e) {
      await e.openApp(e.app.w, e.app.h, e.W / e.app.w);
      place(e, full(e));
      await e.worldTo(e.wNow + 500);
      e.mem.cursor = { x: e.W * 0.72, y: e.H * 0.86 };
    },
    update(e, lt) {
      // a slow push toward the top bar while the chip lights up, then out for the camera jump
      const btn = $(e, ".stat-needs");
      const c = centerOf(btn) ?? { x: e.app.w / 2, y: 40 };
      const push: UiView = { cx: lerp(e.app.w / 2, c.x, 0.6), cy: lerp(e.app.h / 2, c.y, 0.75), s: (e.W / e.app.w) * 1.22 };
      const kIn = ease.inOutCubic(ramp(lt, 0.3, 1.3));
      const kOut = ease.inOutCubic(ramp(lt, clickAt + 0.15, clickAt + 0.95));
      place(e, mixUi(mixUi(full(e), push, kIn), full(e), kOut));
      if (Math.abs(lt - clickAt) < 0.5 / e.fps) {
        btn?.click();
        e.cue("click");
        e.cue("whoosh", { dur: 0.8, soft: true });
      }
      if (btn && !btn.hidden && !e.s.chimed) {
        e.s.chimed = true;
        e.cue("chime");
      }
    },
    drawOver(e, g, lt) {
      const btn = $(e, ".stat-needs");
      const r = btn && !btn.hidden ? rectOf(e, btn) : null;
      spotlight(g, e.W, e.H, r, ramp(lt, 0.7, 1.0) * (1 - ramp(lt, clickAt + 0.05, clickAt + 0.35)));
      const from = e.mem.cursor as { x: number; y: number };
      const to = r ? { x: r.x + r.w * 0.45, y: r.y + r.h * 0.55 } : from;
      const p = path(lt, 0.55, clickAt - 0.1, from, to);
      const press = lt >= clickAt && lt < clickAt + 0.12 ? 1 : 0;
      ripple(g, p.x, p.y, ramp(lt, clickAt, clickAt + 0.45), INK.amber);
      if (lt < clickAt + 0.9) cursor(g, p.x, p.y, Math.round(3 * (e.W / 1920)), press);
      uiCaption(e, g, "needs you? one click and you're there", ramp(lt, clickAt + 0.3, clickAt + 0.8), INK.amber);
    },
  };
}

/** Hire from the page: Claude Code, chat mode, a first prompt; a worker walks out of the lift. */
export function uiHire(dur: number, o: { at?: number; prompt?: string } = {}): Shot {
  const prompt = o.prompt ?? "add a --json flag to the table output";
  const tHire = 0.45, tChat = 1.0, tType = 1.3, tSubmit = 2.7, tShow = 3.05;
  const typeEnd = tType + prompt.length * 0.028;
  return {
    name: "ui-hire",
    dur,
    at: o.at,
    ui: true,
    enter(e) {
      e.mem.cursor = { x: e.W * 0.62, y: e.H * 0.55 };
    },
    update(e, lt) {
      const f = 0.5 / e.fps;
      const doc = e.bridge?.doc;
      if (Math.abs(lt - tHire) < f) {
        $(e, ".tb-hire")?.click();
        e.cue("click");
      }
      if (Math.abs(lt - tChat) < f) {
        $(e, '.hire-mode[data-mode="chat"]')?.click();
        e.cue("click");
      }
      if (lt >= tType && lt < typeEnd + 0.1 && doc) {
        const ta = $(e, "textarea.hire-prompt") as HTMLTextAreaElement | null;
        if (ta) {
          if (!e.s.focused) {
            e.s.focused = true;
            ta.focus();
          }
          const n = Math.min(prompt.length, Math.floor((lt - tType) / 0.028) + 1);
          if (ta.value.length !== n) {
            ta.value = prompt.slice(0, n);
            ta.dispatchEvent(new Event("input", { bubbles: true }));
            e.cue("key", { vol: 0.5 });
          }
        }
      }
      if (Math.abs(lt - tSubmit) < f) {
        const btn = $(e, ".hire button[type=submit]");
        btn?.click();
        e.mem.hiredAt = e.wNow;
        e.cue("click");
      }
      if (Math.abs(lt - tShow) < f) {
        // "Show this worker in the office": the office's camera follows the new hire out of the lift
        $(e, ".session .ses-logo")?.click();
        e.cue("click", { vol: 0.5 });
      }
      // camera: the whole dialog while it's filled in, back out as it closes
      const dlg = $(e, "dialog.hire") as HTMLDialogElement | null;
      if (dlg?.open) {
        const r = dlg.getBoundingClientRect();
        e.s.dlg = { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
      }
      const d = (e.s.dlg as { x: number; y: number; w: number; h: number } | undefined) ?? { x: e.app.w / 2, y: e.app.h / 2, w: e.app.w, h: e.app.h };
      const zoom: UiView = { cx: d.x, cy: d.y, s: Math.min((e.H * 0.97) / d.h, (e.W * 0.9) / d.w) };
      const kIn = ease.inOutCubic(ramp(lt, tHire + 0.12, tHire + 0.7));
      const kOut = ease.inOutCubic(ramp(lt, tSubmit + 0.05, tSubmit + 0.6));
      place(e, mixUi(mixUi(full(e), zoom, kIn), full(e), kOut));
    },
    drawOver(e, g, lt) {
      const s = Math.round(3 * (e.W / 1920));
      const hireBtn = rectOf(e, $(e, ".tb-hire"));
      const chatBtn = rectOf(e, $(e, '.hire-mode[data-mode="chat"]'));
      const ta = rectOf(e, $(e, "textarea.hire-prompt"));
      const sub = rectOf(e, $(e, ".hire button[type=submit]"));
      const from = e.mem.cursor as { x: number; y: number };
      const at = (r: typeof hireBtn, fx = 0.5, fy = 0.5) => (r ? { x: r.x + r.w * fx, y: r.y + r.h * fy } : from);
      let p = path(lt, 0.0, tHire - 0.05, from, at(hireBtn));
      if (lt > tHire) p = path(lt, tHire + 0.2, tChat - 0.05, at(hireBtn), at(chatBtn, 0.3));
      if (lt > tChat) p = path(lt, tChat + 0.05, tType - 0.05, at(chatBtn, 0.3), at(ta, 0.75, 0.75));
      if (lt > typeEnd) p = path(lt, typeEnd, tSubmit - 0.05, at(ta, 0.75, 0.75), at(sub, 0.4));
      const logoBtn = rectOf(e, $(e, ".session .ses-logo"));
      if (lt > tSubmit + 0.1) p = path(lt, tSubmit + 0.1, tShow - 0.03, at(sub, 0.4), at(logoBtn));
      const clicks = [tHire, tChat, tSubmit, tShow];
      const press = clicks.some((t) => lt >= t && lt < t + 0.12) ? 1 : 0;
      for (const t of clicks) ripple(g, p.x, p.y, ramp(lt, t, t + 0.45), INK.claude);
      if (lt < tShow + 0.35) cursor(g, p.x, p.y, s, press);
      uiCaption(e, g, "hire an agent from the office", ramp(lt, tSubmit + 0.2, tSubmit + 0.6), INK.claude);
    },
  };
}

/** The agent asks to run the tests; one key allows it. */
export function uiApprove(dur: number, o: { after?: number; keyAt?: number } = {}): Shot {
  const keyAt = o.keyAt ?? 0.95;
  return {
    name: "ui-approve",
    dur,
    at: (e) => (e.mem.hiredAt as number) + (o.after ?? 4_700),
    ui: true,
    update(e, lt) {
      if (Math.abs(lt - keyAt) < 0.5 / e.fps) {
        e.bridge?.doc?.dispatchEvent(new KeyboardEvent("keydown", { key: "1", code: "Digit1", bubbles: true }));
        e.cue("keycap");
      }
      // in on the approval bar and the chat above it, out to the office for the green run
      const bar = $(e, ".apbar:not([hidden])");
      const c = centerOf(bar) ?? (e.s.barC as { x: number; y: number } | undefined) ?? { x: e.app.w * 0.8, y: e.app.h * 0.85 };
      if (bar) e.s.barC = c;
      const zoom: UiView = { cx: c.x - 120, cy: c.y - 120, s: (e.W / e.app.w) * 1.6 };
      const kIn = ease.inOutCubic(ramp(lt, 0, 0.7));
      const kOut = ease.inOutCubic(ramp(lt, keyAt + 0.5, keyAt + 1.2));
      place(e, mixUi(mixUi(full(e), zoom, kIn), full(e), kOut));
    },
    drawOver(e, g, lt) {
      const s = Math.round(6 * (e.W / 1920));
      const card = rectOf(e, $(e, ".apbar:not([hidden])")) ?? (e.s.card as ReturnType<typeof rectOf>);
      if (card) e.s.card = card;
      const allow = rectOf(e, $(e, ".apbar:not([hidden]) .ap-allow, .apbar:not([hidden]) .ap-btn"));
      if (allow) e.s.allow = allow;
      const a = (e.s.allow as ReturnType<typeof rectOf>) ?? null;
      if (a) {
        const k = ramp(lt, keyAt - 0.35, keyAt) * (1 - ramp(lt, keyAt + 0.25, keyAt + 0.6));
        if (k > 0) {
          g.save();
          g.strokeStyle = INK.amber;
          g.globalAlpha = k;
          g.lineWidth = 4;
          const pad = 8 + 6 * Math.sin(lt * 18) * (lt < keyAt ? 1 : 0);
          g.strokeRect(Math.round(a.x - pad), Math.round(a.y - pad), Math.round(a.w + pad * 2), Math.round(a.h + pad * 2));
          g.restore();
        }
        ripple(g, a.x + a.w / 2, a.y + a.h / 2, ramp(lt, keyAt, keyAt + 0.5), INK.amber);
      }
      const c = (e.s.card as ReturnType<typeof rectOf>) ?? null;
      const ky = c ? c.y + c.h + 14 * s * 0.5 : e.H * 0.7;
      keycap(g, "1", "allow", c ? c.x + c.w / 2 : e.W / 2, Math.min(ky, e.H - 40 * s), s, lt, keyAt, "center");
      uiCaption(e, g, "approve with one key", ramp(lt, 0.2, 0.6), INK.green);
    },
    exit(e) {
      e.closeApp();
    },
  };
}
