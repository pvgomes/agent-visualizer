/*
 * Furniture and little things, painted pixel by pixel: desks, monitors (and
 * what is on their screens for each kind of work), chairs, the intern bench
 * and laptops, desk trinkets, plants, the coffee machine, server
 * rack, elevator, clock and the floating icons (paper airplane, globe, magnifier,
 * plug, bulb, bubbles). Furniture takes an ArtKey, so every agent brand has
 * its own desk, chair and keyboard. Also the props that fill a pod's spare
 * rug. Static pieces are cached as bitmaps; screens animate.
 */
import type { AgentKind } from "../../src/shared/events.ts";
import { BRAND_ART, C, art, mix, rgba, type ArtKey } from "./palette.ts";
import { MICRO, drawText } from "./font.ts";
import { pixelLogo } from "./logos.ts";
import { bitmap, rng, type Bitmap } from "./util.ts";
import { DESK_W, SEAT_W } from "./layout.ts";

export type Screen =
  | "off" | "idle" | "thinking" | "read" | "edit" | "bash" | "search" | "web" | "agent"
  | "todo" | "mcp" | "reply" | "waiting" | "error" | "fail" | "pass" | "other" | "boot";

type G = CanvasRenderingContext2D;
const r = (g: G, x: number, y: number, w: number, h: number, c: string) => {
  g.fillStyle = c;
  g.fillRect(x, y, w, h);
};
const dk = (c: string, t = 0.35) => mix(c, C.ink, t);
const lt = (c: string, t = 0.3) => mix(c, C.white, t);

/* ------------------------------------------------------------------ desks */

const deskCache = new Map<string, Bitmap>();
export const DESK_BM_H = 22;
/** Desk body (top, front, legs), origin = top-left of the surface. */
export function deskBody(key: ArtKey): Bitmap {
  const k = "desk" + key;
  let b = deskCache.get(k);
  if (b) return b;
  b = bitmap(DESK_W, DESK_BM_H);
  const g = b.g;
  const A = art(key);
  const [top, edge, front] = A.desk;
  const leg = A.leg;
  // legs + modesty panel
  r(g, 1, 14, 2, 8, leg); r(g, DESK_W - 3, 14, 2, 8, leg);
  r(g, 1, 21, 2, 1, dk(leg)); r(g, DESK_W - 3, 21, 2, 1, dk(leg));
  r(g, 3, 14, DESK_W - 6, 4, dk(front, 0.5));
  // surface
  r(g, 0, 0, DESK_W, 10, top);
  r(g, 0, 0, DESK_W, 1, edge);
  r(g, 1, 1, DESK_W - 2, 1, lt(top, 0.25));
  // a little wood grain / surface sheen
  const rr = rng(key.length * 31);
  for (let i = 0; i < 7; i++) r(g, 2 + Math.floor(rr() * (DESK_W - 10)), 2 + Math.floor(rr() * 7), 3 + Math.floor(rr() * 5), 1, mix(top, edge, 0.35));
  r(g, 0, 9, DESK_W, 1, lt(top, 0.45));
  // front face
  r(g, 0, 10, DESK_W, 4, front);
  r(g, 0, 13, DESK_W, 1, dk(front, 0.3));
  if (key === "claude") { r(g, 14, 11, 8, 1, dk(front, 0.25)); }
  if (key === "commandcode") { r(g, 0, 9, DESK_W, 1, mix(C.cc2, C.cc6, 0.4)); }
  if (A.trim) r(g, 0, 10, DESK_W, 1, A.trim);
  // outline sides
  r(g, 0, 0, 1, 14, dk(edge, 0.25)); r(g, DESK_W - 1, 0, 1, 14, dk(edge, 0.25));
  deskCache.set(k, b);
  return b;
}

/** The desk seen from below once flipped: underside up, legs in the air. ┻━┻ */
export function deskUnderside(key: ArtKey): Bitmap {
  const k = "under" + key;
  let b = deskCache.get(k);
  if (b) return b;
  b = bitmap(DESK_W, DESK_BM_H);
  const g = b.g;
  const A = art(key);
  const [top, edge, front] = A.desk;
  const leg = A.leg;
  // legs sticking up, outlined so they read against any rug
  for (const lx of [1, DESK_W - 4]) {
    r(g, lx - 1, 0, 5, 10, C.ink2);
    r(g, lx, 1, 3, 9, lt(leg, 0.15));
    r(g, lx, 1, 3, 1, lt(leg, 0.45));
    r(g, lx + 2, 2, 1, 8, dk(leg, 0.2));
  }
  // underside panel with braces
  const under = mix(front, top, 0.3);
  r(g, 0, 9, DESK_W, 9, under);
  r(g, 0, 9, DESK_W, 1, lt(under, 0.3));
  r(g, 0, 17, DESK_W, 1, dk(under, 0.3));
  r(g, 4, 11, DESK_W - 8, 1, dk(under, 0.3)); r(g, 4, 15, DESK_W - 8, 1, dk(under, 0.3));
  r(g, 10, 11, 1, 5, dk(under, 0.3)); r(g, DESK_W - 11, 11, 1, 5, dk(under, 0.3));
  // the top surface now faces the floor, its rim shows at the bottom
  r(g, 0, 18, DESK_W, 2, top);
  r(g, 0, 20, DESK_W, 1, edge);
  r(g, 0, 9, 1, 12, dk(edge, 0.3)); r(g, DESK_W - 1, 9, 1, 12, dk(edge, 0.3));
  deskCache.set(k, b);
  return b;
}

/**
 * Intern bench for `seats` laptops, SEAT_W each. `hot`: a pod's shared hot
 * desk, the same table in a lighter, communal finish with a centre leg.
 */
export function benchBody(key: ArtKey, seats: number, hot = false): Bitmap {
  const k = "bench" + key + seats + (hot ? "h" : "");
  let b = deskCache.get(k);
  if (b) return b;
  const BW = Math.max(1, seats) * SEAT_W;
  b = bitmap(BW, DESK_BM_H);
  const g = b.g;
  const A = art(key);
  let [top, edge, front] = A.desk;
  if (hot) { top = lt(top, 0.22); edge = lt(edge, 0.18); front = mix(front, top, 0.25); }
  const leg = A.leg;
  r(g, 1, 15, 2, 6, leg); r(g, BW - 3, 15, 2, 6, leg);
  if (hot && BW >= 48) r(g, (BW >> 1) - 1, 15, 2, 6, leg);
  r(g, 0, 3, BW, 8, top);
  r(g, 0, 3, BW, 1, edge);
  r(g, 0, 10, BW, 1, lt(top, 0.45));
  r(g, 0, 11, BW, 4, front);
  r(g, 0, 14, BW, 1, dk(front, 0.3));
  if (A.trim) r(g, 0, 11, BW, 1, A.trim);
  r(g, 0, 3, 1, 12, dk(edge, 0.25)); r(g, BW - 1, 3, 1, 12, dk(edge, 0.25));
  if (hot) {
    // a stripe of tape down the middle: anyone can sit here
    for (let x = 2; x < BW - 2; x += 4) r(g, x, 7, 2, 1, rgba(C.white, 0.22));
  }
  deskCache.set(k, b);
  return b;
}

/** Soft contact shadow under furniture. */
export function floorShadow(g: G, x: number, y: number, w: number, h: number, a = 0.28) {
  g.fillStyle = rgba(C.ink, a);
  g.fillRect(x + 1, y, w - 2, h);
  g.fillRect(x, y + 1, w, h - 2);
}

/* ---------------------------------------------------------------- monitor */
export const MON_W = 24, MON_H = 16;
export const SCR_W = 20, SCR_H = 11;

export function monitorFrame(g: G, x: number, y: number, key: ArtKey) {
  const A = art(key);
  const bez = A.bezel;
  // stand
  r(g, x + 10, y + 14, 4, 3, C.slate2);
  r(g, x + 7, y + 16, 10, 2, C.slate2);
  r(g, x + 7, y + 17, 10, 1, C.slate1);
  // bezel
  r(g, x + 1, y, MON_W - 2, 15, bez);
  r(g, x, y + 1, MON_W, 13, bez);
  r(g, x + 1, y, MON_W - 2, 1, mix(bez, C.slate3, 0.45));
  r(g, x + 1, y + 14, MON_W - 2, 1, mix(bez, C.ink, 0.5));
  // tiny power led
  r(g, x + MON_W - 3, y + 13, 1, 1, A.led);
}

/** Colour that the screen throws onto faces and desks, by screen kind. */
export function screenGlow(s: Screen, agent: AgentKind): string | null {
  switch (s) {
    case "off": return null;
    case "bash": return C.green4;
    case "edit": case "other": return C.blue4;
    case "read": case "search": return C.slate5;
    case "web": return C.blue5;
    case "error": case "fail": return C.red3;
    case "pass": return C.green4;
    case "waiting": return (BRAND_ART[agent] ?? BRAND_ART.claude).ink;
    case "idle": return C.blue3;
    default: return C.blue4;
  }
}

const CODE_COLS = [C.pink, C.blue5, C.gold3, C.green4, C.plum3, C.terra4, C.slate4];

/**
 * Screen content, (x, y) = top-left of the 20x11 screen. `t` is ms, `seed`
 * per worker so neighbours do not scroll in lockstep.
 */
export function drawScreen(g: G, x: number, y: number, w: number, h: number, s: Screen, agent: AgentKind, t: number, seed: number) {
  const ba = BRAND_ART[agent] ?? BRAND_ART.claude;
  const brand = ba.ink;
  const R = (dx: number, dy: number, ww: number, hh: number, c: string) => {
    if (dx >= w || dy >= h) return;
    r(g, x + dx, y + dy, Math.min(ww, w - dx), Math.min(hh, h - dy), c);
  };
  const line = (i: number) => {
    const v = Math.sin(i * 12.9898 + seed * 0.001) * 43758.5453;
    return v - Math.floor(v);
  };
  switch (s) {
    case "off": {
      R(0, 0, w, h, C.ink3);
      R(2, 1, 1, 1, C.slate1); R(1, 2, 1, 1, C.slate1);
      R(w - 6, h - 2, 4, 1, C.slate1);
      return;
    }
    case "boot":
    case "idle": {
      R(0, 0, w, h, C.blue1);
      // drifting brand mark screensaver
      const lg = pixelLogo(agent, 7, ba.main === ba.ink ? ba.main : mix(ba.ink, C.blue1, 0.25));
      const p = t * 0.004 + seed;
      const lx = Math.floor((Math.sin(p * 0.31) * 0.5 + 0.5) * (w - 7));
      const ly = Math.floor((Math.sin(p * 0.47 + 1) * 0.5 + 0.5) * (h - 7));
      g.globalAlpha = 0.85;
      g.drawImage(lg.c, x + lx, y + ly);
      g.globalAlpha = 1;
      return;
    }
    case "thinking": {
      R(0, 0, w, h, C.ink2);
      const ph = Math.floor(t / 260) % 4;
      for (let i = 0; i < 3; i++) R(5 + i * 4, 5, 2, 2, i < ph ? brand : C.slate1);
      R(2, 2, Math.floor(((t / 30 + seed) % 100) / 100 * (w - 4)), 1, mix(brand, C.ink2, 0.5));
      return;
    }
    case "read":
    case "search": {
      R(0, 0, w, h, C.white);
      R(0, 0, w, 2, C.slate5);
      R(1, 0, 1, 1, C.red3); R(3, 0, 1, 1, C.gold3); R(5, 0, 1, 1, C.green4);
      const scroll = Math.floor(t / 420 + seed) ;
      for (let i = 0; i < 4; i++) {
        const k = scroll + i;
        const len = 6 + Math.floor(line(k) * 11);
        R(2, 3 + i * 2, len, 1, line(k + 50) < 0.2 ? C.blue4 : C.slate3);
      }
      if (s === "search") {
        const hl = Math.floor(t / 300) % 4;
        R(2, 3 + hl * 2, 8, 1, C.gold2);
      }
      return;
    }
    case "edit":
    case "other": {
      R(0, 0, w, h, C.ink2);
      R(0, 0, 3, h, C.ink3);
      const speed = s === "edit" ? 140 : 320;
      const scroll = Math.floor(t / speed + seed);
      for (let i = 0; i < 5; i++) {
        const k = scroll + i;
        const ind = Math.floor(line(k * 3) * 3) * 2;
        let cx = 4 + ind;
        const n = 1 + Math.floor(line(k + 9) * 3);
        for (let j = 0; j < n && cx < w - 1; j++) {
          const len = 2 + Math.floor(line(k * 7 + j) * 5);
          R(cx, 1 + i * 2, len, 1, CODE_COLS[Math.floor(line(k + j * 13) * CODE_COLS.length)]);
          cx += len + 1;
        }
        R(1, 1 + i * 2, 1, 1, C.slate2);
      }
      if (Math.floor(t / 350) % 2) R(4 + Math.floor(line(scroll + 4) * 8), 9, 1, 1, C.white);
      return;
    }
    case "bash": {
      R(0, 0, w, h, C.ink);
      const scroll = Math.floor(t / 230 + seed);
      for (let i = 0; i < 5; i++) {
        const k = scroll + i;
        const len = 3 + Math.floor(line(k) * 13);
        if (i === 4) {
          R(1, 1 + i * 2, 1, 1, C.green4);
          R(3, 1 + i * 2, Math.min(len, Math.floor((t / 60) % 14)), 1, C.green5);
          if (Math.floor(t / 300) % 2) R(4 + Math.min(len, Math.floor((t / 60) % 14)), 1 + i * 2, 2, 1, C.green5);
        } else R(1, 1 + i * 2, len, 1, line(k + 3) < 0.15 ? C.gold3 : C.green3);
      }
      return;
    }
    case "web": {
      R(0, 0, w, h, C.white);
      R(0, 0, w, 2, C.slate4);
      R(1, 0, 6, 1, C.white);
      R(1, 3, 7, 4, C.blue5);
      R(2, 5, 3, 2, C.green4);
      R(9, 3, 9, 1, C.ink3);
      R(9, 5, 8, 1, C.slate4); R(9, 7, 6, 1, C.slate4);
      R(1, 8, 17, 1, C.slate5);
      const ld = Math.floor((t / 40) % w);
      R(0, 2, ld, 1, C.blue4);
      return;
    }
    case "agent": {
      R(0, 0, w, h, C.ink2);
      R(8, 1, 4, 2, brand);
      R(9, 3, 2, 1, C.slate3); R(4, 4, 12, 1, C.slate3);
      R(4, 5, 1, 1, C.slate3); R(10, 4, 1, 2, C.slate3); R(15, 5, 1, 1, C.slate3);
      const on = Math.floor(t / 300) % 3;
      for (let i = 0; i < 3; i++) R(2 + i * 6, 6, 4, 3, i === on ? C.gold3 : C.slate2);
      return;
    }
    case "todo": {
      R(0, 0, w, h, C.gold4);
      const done = Math.floor(t / 500 + seed) % 5;
      for (let i = 0; i < 4; i++) {
        R(2, 1 + i * 2 + 1, 2, 1, i < done ? C.green3 : C.slate3);
        R(5, 1 + i * 2 + 1, 6 + ((i * 5 + seed) % 7), 1, i < done ? C.slate4 : C.ink3);
      }
      return;
    }
    case "mcp": {
      R(0, 0, w, h, C.plum1);
      const p = Math.floor(t / 90) % 14;
      R(1, 5, 7, 1, C.plum3);
      R(12, 5, 7, 1, C.plum3);
      R(1 + (p % 7), 5, 1, 1, C.white);
      R(8, 3, 2, 5, C.slate4); R(10, 4, 2, 3, C.slate5);
      R(6, 4, 2, 1, C.gold3); R(6, 6, 2, 1, C.gold3);
      return;
    }
    case "reply": {
      R(0, 0, w, h, C.ink2);
      const n = Math.floor(t / 400 + seed) % 4;
      for (let i = 0; i <= n; i++) {
        const me = i % 2 === 0;
        R(me ? 2 : 8, 1 + i * 3 - (n > 2 ? 3 : 0), 10, 2, me ? mix(brand, C.ink2, 0.2) : C.slate2);
      }
      return;
    }
    case "waiting": {
      const blink = Math.floor(t / 450) % 2;
      R(0, 0, w, h, blink ? mix(brand, C.ink2, 0.15) : mix(brand, C.ink2, 0.45));
      R(9, 2, 2, 5, C.white);
      R(9, 8, 2, 2, C.white);
      return;
    }
    case "error":
    case "fail": {
      const blink = Math.floor(t / 180) % 2;
      R(0, 0, w, h, blink ? C.red2 : C.red1);
      // X
      for (let i = 0; i < 7; i++) { R(6 + i, 2 + i, 1, 1, C.white); R(12 - i, 2 + i, 1, 1, C.white); }
      for (let i = 0; i < 3; i++) R(Math.floor(line(t / 50 + i) * w), Math.floor(line(t / 70 + i) * h), 3, 1, C.red3);
      return;
    }
    case "pass": {
      R(0, 0, w, h, C.green2);
      const pts = [[5, 5], [6, 6], [7, 7], [8, 6], [9, 5], [10, 4], [11, 3], [12, 2], [13, 1]];
      for (const [px, py] of pts) R(px, py + 1, 2, 1, C.white);
      return;
    }
  }
}

/* ------------------------------------------------------------- keyboards */
export function keyboard(g: G, x: number, y: number, artKey: ArtKey, typing: boolean, t: number, seed: number) {
  const A = art(artKey);
  const [base, key, hot] = A.kbd;
  const light = artKey === "commandcode";
  r(g, x, y + 1, 14, 3, dk(base, 0.4));
  r(g, x, y, 14, 3, base);
  for (let i = 0; i < 6; i++) r(g, x + 1 + i * 2, y, 1, 1, key);
  for (let i = 0; i < 6; i++) r(g, x + 2 + i * 2, y + 1, 1, 1, key);
  r(g, x + 4, y + 2, 6, 1, key);
  if (typing) {
    const k = Math.floor(t / 70 + seed) % 12;
    r(g, x + 1 + (k % 6) * 2 + (k > 5 ? 1 : 0), y + (k > 5 ? 1 : 0), 1, 1, hot);
  }
  // mouse
  r(g, x + 17, y, 2, 3, light ? C.cc9 : key);
  if (light) r(g, x, y + 2, 14, 1, C.cc6);
  r(g, x + 17, y + 2, 2, 1, dk(C.slate4));
}

/* ----------------------------------------------------------------- chairs */
export function chair(g: G, cx: number, cy: number, key: ArtKey, empty: boolean) {
  const [main, acc] = art(key).chair;
  // base + wheels
  r(g, cx - 1, cy - 1, 2, 3, C.slate2);
  r(g, cx - 5, cy + 2, 10, 1, C.slate2);
  r(g, cx - 5, cy + 3, 1, 1, C.ink2); r(g, cx + 4, cy + 3, 1, 1, C.ink2); r(g, cx, cy + 3, 1, 1, C.ink2);
  if (empty) {
    // seat visible when nobody sits
    r(g, cx - 5, cy - 4, 10, 3, mix(main, C.slate3, 0.25));
  }
  // backrest
  const by = cy - 6;
  r(g, cx - 5, by, 10, 6, main);
  r(g, cx - 6, by + 1, 12, 4, main);
  r(g, cx - 4, by, 8, 1, lt(main, 0.2));
  r(g, cx - 4, by + 1, 8, 1, acc);
  r(g, cx - 5, by + 5, 10, 1, dk(main, 0.4));
  // outline so light chairs read on light rugs
  r(g, cx - 6, by, 1, 1, dk(main, 0.6)); r(g, cx + 5, by, 1, 1, dk(main, 0.6));
  r(g, cx - 7, by + 1, 1, 4, dk(main, 0.6)); r(g, cx + 6, by + 1, 1, 4, dk(main, 0.6));
}

export function stool(g: G, cx: number, cy: number, key: ArtKey) {
  const seat = art(key).stool;
  r(g, cx - 1, cy - 2, 2, 4, C.slate2);
  r(g, cx - 3, cy + 2, 6, 1, C.slate2);
  r(g, cx - 4, cy - 4, 8, 2, seat);
  r(g, cx - 3, cy - 5, 6, 1, lt(seat, 0.25));
}

/* ----------------------------------------------------------------- laptop */
export function laptop(g: G, x: number, y: number, key: ArtKey) {
  // (x,y) = top-left of the 10x7 lid
  const [shell, deck, shade] = art(key).laptop;
  r(g, x, y, 10, 7, shell);
  r(g, x - 1, y + 7, 12, 2, deck);
  r(g, x - 1, y + 8, 12, 1, shade);
}

/* ------------------------------------------------------------ desk items */
export type Trinket = "mug" | "plant" | "duck" | "books" | "photo" | "lamp" | "cactus" | "lava" | "cube" | "figure";
const TRINKETS: Trinket[] = ["mug", "plant", "duck", "books", "photo", "lamp", "cactus", "lava", "cube", "figure", "mug", "plant"];
/** Everyone gets a mug (left corner) and one personal thing (right corner). */
export function trinketsFor(seed: number): [Trinket, Trinket] {
  const rr = rng(seed ^ 0x5bd1e995);
  const others = TRINKETS.filter((t) => t !== "mug");
  return ["mug", others[Math.floor(rr() * others.length)]];
}

export function trinket(g: G, kind: Trinket, x: number, y: number, seed: number, t: number) {
  // (x, y) = bottom-left anchor on the desk surface
  const rr = rng(seed);
  switch (kind) {
    case "mug": {
      const c = [C.white, C.terra3, C.blue4, C.gold2, C.green3, C.pink][Math.floor(rr() * 6)];
      r(g, x, y - 4, 3, 4, c);
      r(g, x + 3, y - 3, 1, 2, c);
      r(g, x, y - 4, 3, 1, C.wood1);
      r(g, x, y - 1, 3, 1, dk(c, 0.25));
      return;
    }
    case "plant": {
      r(g, x, y - 2, 4, 2, C.terra2);
      r(g, x, y - 2, 4, 1, C.terra3);
      r(g, x - 1, y - 5, 2, 2, C.leaf3); r(g, x + 3, y - 5, 2, 2, C.leaf2);
      r(g, x + 1, y - 6, 2, 4, C.leaf3); r(g, x + 1, y - 7, 1, 1, C.leaf4);
      return;
    }
    case "cactus": {
      r(g, x, y - 2, 3, 2, C.wood4);
      r(g, x + 1, y - 6, 1, 4, C.leaf3); r(g, x, y - 5, 1, 2, C.leaf2); r(g, x + 2, y - 4, 1, 2, C.leaf2);
      r(g, x + 1, y - 7, 1, 1, C.pink);
      return;
    }
    case "duck": {
      r(g, x, y - 2, 4, 2, C.gold3); r(g, x + 2, y - 4, 2, 2, C.gold3); r(g, x + 4, y - 3, 1, 1, C.gold2);
      r(g, x + 3, y - 4, 1, 1, C.ink);
      return;
    }
    case "books": {
      const cs = [C.terra2, C.blue3, C.green2, C.plum2, C.gold1];
      for (let i = 0; i < 3; i++) r(g, x + (i % 2), y - 2 - i * 2, 6 - (i % 2), 2, cs[Math.floor(rr() * cs.length)]);
      return;
    }
    case "photo": {
      r(g, x, y - 5, 4, 5, C.wood2);
      r(g, x + 1, y - 4, 2, 3, C.blue5); r(g, x + 1, y - 2, 2, 1, C.leaf3);
      return;
    }
    case "lamp": {
      r(g, x, y - 1, 4, 1, C.slate2);
      r(g, x + 1, y - 5, 1, 4, C.slate2);
      r(g, x + 1, y - 6, 4, 2, C.gold2);
      r(g, x + 2, y - 4, 2, 1, C.gold4);
      return;
    }
    case "lava": {
      r(g, x, y - 1, 3, 1, C.slate2);
      r(g, x, y - 6, 3, 5, C.plum2);
      const b = Math.floor(t / 600 + seed) % 3;
      r(g, x + 1, y - 5 + b, 1, 2, C.pink);
      r(g, x, y - 7, 3, 1, C.slate2);
      return;
    }
    case "cube": {
      r(g, x, y - 3, 3, 3, C.red2); r(g, x + 1, y - 3, 1, 1, C.gold3); r(g, x, y - 2, 1, 1, C.blue4); r(g, x + 2, y - 1, 1, 1, C.green3);
      return;
    }
    case "figure": {
      r(g, x, y - 1, 3, 1, C.ink3);
      r(g, x, y - 4, 3, 3, C.plum3); r(g, x, y - 6, 3, 2, C.terra5);
      return;
    }
  }
}

/* ---------------------------------------------------------- room objects */

export function plantTall(g: G, x: number, y: number, seed: number) {
  // (x, y) = bottom-centre of the pot
  const rr = rng(seed);
  r(g, x - 5, y - 6, 10, 6, C.wood4);
  r(g, x - 6, y - 7, 12, 2, C.wood5);
  r(g, x - 5, y - 1, 10, 1, C.wood3);
  r(g, x - 4, y - 6, 2, 5, lt(C.wood4, 0.15));
  const leaves = [C.leaf1, C.leaf2, C.leaf3, C.leaf4];
  for (let i = 0; i < 26; i++) {
    const a = rr() * Math.PI - Math.PI;
    const len = 6 + rr() * 16;
    const lx = Math.round(x + Math.cos(a) * len * 0.55);
    const ly = Math.round(y - 8 + Math.sin(a) * len);
    const c = leaves[Math.min(3, Math.floor(rr() * 4))];
    r(g, lx - 1, ly, 3, 2, c);
    r(g, lx, ly - 1, 1, 1, lt(c, 0.2));
  }
  r(g, x, y - 20, 1, 13, C.leaf1);
}

export function plantSmall(g: G, x: number, y: number) {
  r(g, x - 3, y - 5, 6, 5, C.terra2);
  r(g, x - 4, y - 6, 8, 1, C.terra3);
  r(g, x - 4, y - 11, 3, 5, C.leaf2); r(g, x + 1, y - 12, 3, 6, C.leaf3); r(g, x - 1, y - 14, 2, 8, C.leaf3);
  r(g, x - 1, y - 14, 1, 2, C.leaf4); r(g, x + 2, y - 12, 1, 2, C.leaf4);
}

export function coffeeMachine(g: G, x: number, y: number) {
  // counter 26 wide with an espresso machine on top, (x, y) = bottom-left of the counter
  r(g, x, y - 12, 26, 12, C.wood3);
  r(g, x, y - 12, 26, 2, C.wood5);
  r(g, x, y - 10, 26, 1, C.wood2);
  r(g, x + 12, y - 9, 1, 8, C.wood2);
  r(g, x + 5, y - 6, 3, 1, C.wood5); r(g, x + 17, y - 6, 3, 1, C.wood5);
  // machine: steel body, a plate of dates on top, a display, the group head over a cup
  r(g, x + 2, y - 28, 16, 16, C.slate3);
  r(g, x + 2, y - 28, 16, 2, C.slate5);
  r(g, x + 2, y - 26, 1, 14, C.slate4);
  r(g, x + 4, y - 29, 12, 1, C.slate5);
  for (const [dx, c] of [[5, DATE_A], [8, DATE_B], [11, DATE_A], [13, DATE_B]] as const) {
    r(g, x + dx, y - 31, 2, 2, c);
    r(g, x + dx, y - 31, 1, 1, DATE_HI);
  }
  r(g, x + 4, y - 25, 12, 3, C.ink);
  r(g, x + 5, y - 24, 2, 1, C.green4); r(g, x + 9, y - 24, 1, 1, C.red3);
  r(g, x + 5, y - 21, 10, 8, C.ink3);
  r(g, x + 7, y - 21, 6, 2, C.slate5);
  r(g, x + 12, y - 19, 5, 1, C.ink);
  r(g, x + 8, y - 16, 4, 3, C.white); r(g, x + 12, y - 15, 1, 1, C.white);
  r(g, x + 5, y - 13, 10, 1, C.slate5);
  // a brass dallah of Arabic coffee, its beak spout to the right (steam drawn live by coffeeSteam())
  r(g, x + 19, y - 13, 6, 1, BRASS_DK);
  r(g, x + 19, y - 16, 6, 3, BRASS);
  r(g, x + 20, y - 16, 1, 2, BRASS_LT);
  r(g, x + 20, y - 18, 4, 2, BRASS_DK);
  r(g, x + 20, y - 20, 4, 2, BRASS);
  r(g, x + 21, y - 21, 2, 1, BRASS_LT);
  r(g, x + 21, y - 23, 1, 2, BRASS_LT);
  r(g, x + 18, y - 19, 1, 4, BRASS_DK);
  r(g, x + 25, y - 17, 1, 1, BRASS_DK); r(g, x + 26, y - 19, 1, 2, BRASS); r(g, x + 27, y - 20, 1, 1, BRASS_LT);
}

const BRASS = "#c99a3e", BRASS_LT = "#ecc56a", BRASS_DK = "#8d6726";
const DATE_A = "#6b3418", DATE_B = "#7d4020", DATE_HI = "#a0582c";

/** Steam curling off the dallah's spout. */
export function coffeeSteam(g: G, x: number, y: number, t: number) {
  for (let k = 0; k < 2; k++) {
    for (let i = 0; i < 7; i++) {
      const ph = t * 0.003 + k * 2.1 - i * 0.6;
      const a = (1 - i / 7) * (0.35 + 0.15 * Math.sin(ph));
      g.fillStyle = rgba(C.white, Math.max(0, a));
      g.fillRect(x + 27 + k + Math.round(Math.sin(ph) * 1.2), y - 22 - i, 1, 1);
    }
  }
}

const PLANTER = "#9aa0a7", PLANTER_LT = "#b4b9bf", PLANTER_DK = "#7b8188";
const FROND = "#4c8c3e", FROND_LT = "#74b04f", FROND_DK = "#2f5f2c", BARK = "#8a6a44", BARK_DK = "#6c4f30", DATES = "#c4762a", DATES_DK = "#9c4e1c";

/** A date palm in a concrete planter. (x, y) = bottom-centre of the planter. */
export function datePalm(g: G, x: number, y: number, seed: number) {
  r(g, x - 5, y - 8, 10, 8, PLANTER);
  r(g, x - 5, y - 8, 10, 1, PLANTER_LT);
  r(g, x - 5, y - 8, 1, 8, PLANTER_LT);
  r(g, x - 5, y - 1, 10, 1, PLANTER_DK);
  const rr = rng(seed);
  const H = 22 + Math.floor(rr() * 5), lean = rr() < 0.5 ? -1 : 1;
  for (let i = 0; i < H; i++) r(g, x - 1 + Math.round(lean * (i / H) ** 2 * 2), y - 9 - i, 2, 1, i % 2 ? BARK : BARK_DK);
  const cx = x + lean * 2, cy = y - 9 - H;
  r(g, cx - 2, cy + 2, 2, 2, DATES); r(g, cx + 1, cy + 2, 2, 2, DATES_DK);
  const fronds: [number, number][] = [[-1, -0.2], [1, -0.2], [-1, 0.3], [1, 0.3], [-0.6, -0.9], [0.6, -0.9], [0, -1]];
  for (const [dx, dy] of fronds) {
    const len = 8 + Math.floor(rr() * 4);
    for (let s2 = 1; s2 <= len; s2++) {
      const fx = cx + Math.round(dx * s2), fy = cy + Math.round(dy * s2 + (s2 * s2) / (len * 1.6));
      r(g, fx, fy, 1, 1, s2 < 3 ? FROND_DK : s2 > len - 3 ? FROND_LT : FROND);
      if (s2 % 2 === 0 && s2 > 2) r(g, fx, fy + 1, 1, 1, FROND_DK);
    }
  }
}

/** Server rack body; LEDs are drawn live by rackLeds(). */
export function rack(g: G, x: number, y: number) {
  // (x, y) = bottom-left, 20 x 52
  r(g, x, y - 52, 20, 52, C.ink2);
  r(g, x, y - 52, 20, 2, C.slate1);
  r(g, x + 1, y - 50, 1, 49, C.ink3);
  for (let i = 0; i < 9; i++) {
    const uy = y - 48 + i * 5;
    r(g, x + 3, uy, 14, 4, C.ink3);
    r(g, x + 3, uy, 14, 1, C.slate1);
    r(g, x + 12, uy + 2, 4, 1, C.ink);
  }
  r(g, x, y - 2, 20, 2, C.ink);
}

export function rackLeds(g: G, x: number, y: number, t: number, rate: number) {
  for (let i = 0; i < 9; i++) {
    const uy = y - 48 + i * 5;
    for (let j = 0; j < 3; j++) {
      const ph = Math.sin(t * (0.004 + rate * 0.03) * (1 + ((i * 7 + j * 3) % 5) * 0.3) + i * 1.7 + j * 2.3);
      const on = ph > 0.2 - rate * 0.6;
      const col = j === 2 ? (i % 3 === 0 ? C.gold3 : C.green4) : j === 1 ? C.blue5 : C.green4;
      r(g, x + 4 + j * 2, uy + 2, 1, 1, on ? col : C.ink);
    }
  }
}

/* ------------------------------------------------------------- elevator */
export const ELEV_W = 36, ELEV_H = 40;
/** Frame + inside; doors drawn by elevatorDoors(). (x, y) = bottom-left. */
export function elevatorFrame(g: G, x: number, y: number) {
  r(g, x, y - ELEV_H - 10, ELEV_W, ELEV_H + 10, C.slate2);
  r(g, x + 1, y - ELEV_H - 9, ELEV_W - 2, 1, C.slate4);
  r(g, x + 2, y - ELEV_H, ELEV_W - 4, ELEV_H, C.ink2);
  // floor indicator
  r(g, x + 11, y - ELEV_H - 8, 14, 6, C.ink);
  // call buttons
  r(g, x + ELEV_W - 1, y - 22, 3, 6, C.slate3);
  r(g, x + ELEV_W, y - 21, 1, 1, C.gold3);
  r(g, x + ELEV_W, y - 18, 1, 1, C.gold3);
}

export function elevatorInside(g: G, x: number, y: number) {
  r(g, x + 2, y - ELEV_H, ELEV_W - 4, ELEV_H, C.gold1);
  r(g, x + 4, y - ELEV_H + 2, ELEV_W - 8, ELEV_H - 4, mix(C.gold1, C.gold2, 0.4));
  r(g, x + 4, y - ELEV_H + 2, ELEV_W - 8, 2, C.gold4);
  r(g, x + 2, y - 4, ELEV_W - 4, 4, C.wood2);
}

export function elevatorDoors(g: G, x: number, y: number, open: number, t: number, ding: number) {
  const inner = ELEV_W - 4;
  const half = inner / 2;
  const gap = Math.round(open * half);
  const lw = half - gap;
  const door = C.slate4;
  if (lw > 0) {
    r(g, x + 2, y - ELEV_H, lw, ELEV_H, door);
    r(g, x + 2 + lw - 1, y - ELEV_H, 1, ELEV_H, C.slate3);
    r(g, x + 3, y - ELEV_H + 2, Math.max(0, lw - 3), 1, C.slate5);
    r(g, x + 2 + inner - lw, y - ELEV_H, lw, ELEV_H, door);
    r(g, x + 2 + inner - lw, y - ELEV_H, 1, ELEV_H, C.slate3);
    r(g, x + 3 + inner - lw, y - ELEV_H + 2, Math.max(0, lw - 3), 1, C.slate5);
  }
  // indicator: the floor the car is on, and which way it's going (here, on 21, while the doors work)
  const here = open > 0.02 || ding > 0;
  const { floor, dir } = here ? { floor: OFFICE_FLOOR, dir: 0 } : liftFloor(t);
  const lit = ding > 0 && Math.floor(t / 150) % 2 === 0;
  const ax = x + 13, ay = y - ELEV_H - 7;
  const ac = lit ? C.gold3 : dir ? C.gold2 : C.gold1;
  if (dir >= 0) { r(g, ax + 1, ay, 1, 1, ac); r(g, ax, ay + 1, 3, 1, ac); r(g, ax + 1, ay + 2, 1, 2, ac); }
  else { r(g, ax + 1, ay, 1, 2, ac); r(g, ax, ay + 2, 3, 1, ac); r(g, ax + 1, ay + 3, 1, 1, ac); }
  drawText(g, MICRO(), String(floor), ax + 5, ay - 0, lit ? C.gold3 : C.red3);
}

const OFFICE_FLOOR = 21, TOP_FLOOR = 42;
/** One trip: TRIP_MS long, travelling a floor every FLOOR_MS (top to bottom fits), then standing still for the rest. */
const TRIP_MS = 9_000, FLOOR_MS = 200;

/** Where the car is when nobody here is using it: random trips between floors 1 and TOP_FLOOR. */
export function liftFloor(t: number): { floor: number; dir: -1 | 0 | 1 } {
  const k = Math.floor(t / TRIP_MS);
  const stop = (n: number) => 1 + Math.floor(rng(n * 7919 + 11)() * TOP_FLOOR);
  const from = stop(k), to = stop(k + 1);
  const moved = Math.min(Math.abs(to - from), Math.floor((t - k * TRIP_MS) / FLOOR_MS));
  const dir = moved < Math.abs(to - from) ? (Math.sign(to - from) as -1 | 1) : 0;
  return { floor: from + Math.sign(to - from) * moved, dir };
}

/* ----------------------------------------------------------------- clock */
/** Wall clock: a digital HH:MM panel, 25 x 11 around (cx, cy). Digits are drawn live by clockDigits(). */
export function clockFace(g: G, cx: number, cy: number) {
  const x = cx - 12, y = cy - 5;
  r(g, x, y, 25, 11, C.ink3);
  r(g, x + 1, y + 1, 23, 9, C.ink);
  r(g, x, y, 25, 1, C.slate2);
}

// Seven segments on a 4 x 7 cell: a top, b/c right, d bottom, e/f left, g middle.
const SEG: Record<string, [number, number, number, number]> = {
  a: [1, 0, 2, 1], b: [3, 1, 1, 2], c: [3, 4, 1, 2], d: [1, 6, 2, 1], e: [0, 4, 1, 2], f: [0, 1, 1, 2], g: [1, 3, 2, 1],
};
const DIGIT_SEGS = ["abcdef", "bc", "abdeg", "abcdg", "bcfg", "acdfg", "acdefg", "abc", "abcdefg", "abcdfg"];
const LED_ON = "#ff4d5e", LED_OFF = "#2a1a22";

/** The clock panel's 24h time, colon blinking each second. `d` is already shifted to the city's time, so it reads its UTC fields. */
export function clockDigits(g: G, cx: number, cy: number, d: Date) {
  const hh = String(d.getUTCHours()).padStart(2, "0"), mm = String(d.getUTCMinutes()).padStart(2, "0");
  const x0 = cx - 10, y0 = cy - 3;
  const digit = (ch: string, x: number) => {
    const on = DIGIT_SEGS[+ch]!;
    for (const [k, [sx, sy, w, h]] of Object.entries(SEG)) r(g, x + sx, y0 + sy, w, h, on.includes(k) ? LED_ON : LED_OFF);
  };
  digit(hh[0]!, x0); digit(hh[1]!, x0 + 5);
  const colon = d.getUTCSeconds() % 2 === 0 ? LED_ON : LED_OFF;
  r(g, x0 + 10, y0 + 2, 1, 1, colon); r(g, x0 + 10, y0 + 4, 1, 1, colon);
  digit(mm[0]!, x0 + 12); digit(mm[1]!, x0 + 17);
}

/* ------------------------------------------------------------- icons */

const PLANE = [
  "ww..........",
  ".wwww.......",
  "..wwwwwww...",
  "...dddddddww",
  "..ssssss....",
  ".sss........",
];
let planeBm: Bitmap | null = null;
/** A folded paper dart pointing right, 12 x 6. */
export function planeSprite(): Bitmap {
  if (planeBm) return planeBm;
  const b = bitmap(14, 8);
  const map: Record<string, string> = { w: C.white, s: C.slate5, d: C.slate4 };
  PLANE.forEach((row, y) => [...row].forEach((ch, x) => { if (map[ch]) r(b.g, x + 1, y + 1, 1, 1, map[ch]); }));
  // outline
  const img = b.g.getImageData(0, 0, 14, 8);
  const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < 14 && y < 8 && img.data[(y * 14 + x) * 4 + 3] > 0;
  const edge: [number, number][] = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 14; x++) if (!solid(x, y) && (solid(x + 1, y) || solid(x - 1, y) || solid(x, y + 1) || solid(x, y - 1))) edge.push([x, y]);
  for (const [x, y] of edge) r(b.g, x, y, 1, 1, C.ink2);
  planeBm = b;
  return b;
}

export function globe(g: G, x: number, y: number, t: number) {
  // 9x9 spinning globe, (x, y) top-left
  const rows = [3, 5, 7, 7, 7, 7, 7, 5, 3];
  const off = Math.floor(t / 140);
  for (let j = 0; j < 9; j++) {
    const w = rows[j];
    const sx = x + Math.floor((9 - w) / 2);
    for (let i = 0; i < w; i++) {
      const u = (i + off + j * 2) % 9;
      const land = (u < 3 && j > 1 && j < 6) || (u === 6 && j > 3 && j < 8) || (u === 7 && j === 2);
      r(g, sx + i, y + j, 1, 1, land ? C.green3 : C.blue4);
    }
  }
  r(g, x + 2, y + 1, 1, 1, C.blue5); r(g, x + 1, y + 2, 1, 2, C.blue5);
}

export function wifi(g: G, x: number, y: number, t: number) {
  const k = Math.floor(t / 250) % 4;
  const arcs = [
    [[0, 0]],
    [[-2, -2], [-1, -3], [0, -3], [1, -3], [2, -2]],
    [[-4, -4], [-3, -5], [-2, -6], [-1, -6], [0, -6], [1, -6], [2, -6], [3, -5], [4, -4]],
  ];
  arcs.forEach((pts, i) => {
    if (i > k) return;
    for (const [dx, dy] of pts) r(g, x + dx, y + dy, 1, 1, i === 0 ? C.white : C.blue5);
  });
}

export function magnifier(g: G, x: number, y: number) {
  // (x, y) centre of the lens
  const ring = [[-1, -3], [0, -3], [1, -3], [-3, -1], [-3, 0], [-3, 1], [3, -1], [3, 0], [3, 1], [-1, 3], [0, 3], [1, 3], [-2, -2], [2, -2], [-2, 2], [2, 2]];
  g.fillStyle = rgba(C.blue5, 0.55);
  g.fillRect(x - 2, y - 2, 5, 5);
  for (const [dx, dy] of ring) r(g, x + dx, y + dy, 1, 1, C.ink2);
  r(g, x - 1, y - 1, 1, 1, C.white);
  r(g, x + 3, y + 3, 2, 2, C.wood3); r(g, x + 5, y + 5, 2, 2, C.wood2);
}

export function plug(g: G, x: number, y: number, t: number) {
  const j = Math.floor(t / 200) % 2;
  r(g, x, y, 4, 4, C.plum3);
  r(g, x + 1, y - 2, 1, 2, C.slate5); r(g, x + 3, y - 2, 1, 2, C.slate5);
  r(g, x + 1, y + 4, 2, 2 + j, C.plum2);
  r(g, x, y, 4, 1, lt(C.plum3, 0.3));
  if (j) { r(g, x - 2, y - 3, 1, 1, C.gold3); r(g, x + 6, y - 3, 1, 1, C.gold3); }
}

export function bulb(g: G, x: number, y: number, t: number) {
  r(g, x + 1, y, 3, 1, C.gold3);
  r(g, x, y + 1, 5, 3, C.gold3);
  r(g, x + 1, y + 1, 1, 2, C.gold4);
  r(g, x + 1, y + 4, 3, 1, C.gold2);
  r(g, x + 1, y + 5, 3, 1, C.slate4);
  r(g, x + 2, y + 6, 1, 1, C.slate3);
  if (Math.floor(t / 160) % 2) {
    r(g, x - 2, y + 2, 1, 1, C.gold4); r(g, x + 6, y + 2, 1, 1, C.gold4);
    r(g, x + 2, y - 2, 1, 1, C.gold4);
    r(g, x - 1, y - 1, 1, 1, C.gold3); r(g, x + 5, y - 1, 1, 1, C.gold3);
  }
}

/** A puffy pixel thought cloud, (x, y) top-left, 13 x 9. */
export function thoughtBubble(g: G, x: number, y: number, t: number, accent: string) {
  const W = C.white, O = C.ink2;
  // outline then fill
  r(g, x + 2, y, 9, 1, O); r(g, x + 1, y + 1, 11, 1, O); r(g, x, y + 2, 13, 5, O); r(g, x + 1, y + 7, 11, 1, O); r(g, x + 2, y + 8, 9, 1, O);
  r(g, x + 2, y + 1, 9, 1, W); r(g, x + 1, y + 2, 11, 5, W); r(g, x + 2, y + 7, 9, 1, W);
  r(g, x + 3, y + 1, 3, 1, C.slate5);
  // trailing puffs
  r(g, x + 2, y + 10, 2, 2, W); r(g, x + 1, y + 10, 1, 2, O); r(g, x + 4, y + 10, 1, 2, O); r(g, x + 2, y + 9, 2, 1, O); r(g, x + 2, y + 12, 2, 1, O);
  r(g, x + 1, y + 13, 1, 1, W);
  const k = Math.floor(t / 280) % 4;
  for (let i = 0; i < 3; i++) r(g, x + 3 + i * 3, y + 4, 2, 2, i < k ? accent : C.slate5);
}

/** The "the human is needed" flag: brand-coloured box with a white "!". */
export function alertBubble(g: G, x: number, y: number, color: string, ink: string, t: number) {
  const bob = Math.floor(t / 220) % 2;
  const yy = y - bob;
  r(g, x + 1, yy, 7, 11, C.ink); r(g, x, yy + 1, 9, 9, C.ink);
  r(g, x + 1, yy + 1, 7, 9, color);
  r(g, x + 1, yy + 1, 7, 1, lt(color, 0.35));
  r(g, x + 4, yy + 2, 1, 4, ink); r(g, x + 3, yy + 2, 3, 3, ink); r(g, x + 4, yy + 7, 1, 2, ink); r(g, x + 3, yy + 7, 3, 2, ink);
  r(g, x + 3, yy + 11, 3, 1, C.ink); r(g, x + 4, yy + 12, 1, 1, C.ink);
  r(g, x + 4, yy + 11, 1, 1, color);
}

/** Sonar ping rings around the "!" so a waiting worker is impossible to miss. */
export function ping(g: G, cx: number, cy: number, t: number, color: string) {
  for (let k = 0; k < 2; k++) {
    const ph = ((t + k * 550) % 1100) / 1100;
    const rad = 5 + ph * 13;
    g.globalAlpha = (1 - ph) * 0.9;
    g.fillStyle = color;
    const n = Math.ceil(rad * 6.3);
    let lx = 1e9, ly = 1e9;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const x = Math.round(cx + Math.cos(a) * rad), y = Math.round(cy + Math.sin(a) * rad * 0.8);
      if (x !== lx || y !== ly) g.fillRect(x, y, 1, 1);
      lx = x; ly = y;
    }
  }
  g.globalAlpha = 1;
}

export function speechBubble(g: G, x: number, y: number, t: number, accent: string) {
  const W = C.white, O = C.ink2;
  r(g, x + 1, y, 11, 1, O); r(g, x, y + 1, 13, 6, O); r(g, x + 1, y + 7, 11, 1, O);
  r(g, x + 1, y + 1, 11, 6, W);
  r(g, x + 2, y + 8, 2, 1, O); r(g, x + 2, y + 7, 2, 1, W); r(g, x + 2, y + 9, 1, 1, O);
  const k = Math.floor(t / 200) % 3;
  r(g, x + 3, y + 2, 7 - (k === 0 ? 2 : 0), 1, accent);
  r(g, x + 3, y + 4, 5 + k, 1, C.slate4);
}

/** Sticky notes stuck to a monitor bezel. */
export function stickies(g: G, mx: number, my: number, n: number) {
  const cols = [C.gold3, C.pink, C.green4, C.blue5];
  const spots = [[-2, 1], [MON_W - 3, 2], [-1, 7], [MON_W - 2, 8]];
  for (let i = 0; i < Math.min(n, 4); i++) {
    const [dx, dy] = spots[i];
    r(g, mx + dx, my + dy, 4, 4, cols[i]);
    r(g, mx + dx, my + dy + 3, 4, 1, dk(cols[i], 0.2));
    r(g, mx + dx + 1, my + dy + 1, 2, 1, dk(cols[i], 0.35));
  }
}

export function alarmLight(g: G, x: number, y: number, t: number) {
  const on = Math.floor(t / 160) % 2 === 0;
  r(g, x, y - 1, 5, 1, C.slate2);
  r(g, x + 1, y - 4, 3, 3, on ? C.red3 : C.red2);
  r(g, x + 2, y - 5, 1, 1, on ? C.red3 : C.red2);
  r(g, x + 1, y - 4, 1, 1, on ? C.white : C.red3);
}

export function box(g: G, x: number, y: number) {
  // cardboard box carried out on session_end, (x,y) top-left, 10x7
  r(g, x, y, 10, 7, C.wood5);
  r(g, x, y, 10, 1, C.wood6);
  r(g, x + 4, y, 2, 7, C.wood4);
  r(g, x, y + 6, 10, 1, C.wood3);
  r(g, x + 1, y - 2, 3, 2, C.leaf3); r(g, x + 6, y - 1, 2, 1, C.white);
}

/* ------------------------------------------------- decor for empty floor */

export function sofa(g: G, x: number, y: number, col: string) {
  // (x, y) = top-left, 48 x 20, seen from the front
  const d = dk(col, 0.3), l = lt(col, 0.18);
  r(g, x + 1, y + 19, 46, 2, rgba(C.ink, 0.3));
  r(g, x + 4, y, 40, 9, d);
  r(g, x + 4, y, 40, 1, col);
  r(g, x + 4, y + 8, 40, 7, col);
  r(g, x + 4, y + 8, 40, 1, l);
  r(g, x + 23, y + 8, 1, 7, d);
  r(g, x, y + 4, 5, 13, col); r(g, x + 43, y + 4, 5, 13, col);
  r(g, x, y + 4, 5, 1, l); r(g, x + 43, y + 4, 5, 1, l);
  r(g, x + 4, y + 15, 40, 2, d);
  r(g, x + 2, y + 17, 2, 2, C.wood1); r(g, x + 44, y + 17, 2, 2, C.wood1);
  // cushions
  r(g, x + 8, y + 3, 7, 5, C.gold3); r(g, x + 8, y + 3, 7, 1, C.gold4);
  r(g, x + 34, y + 3, 7, 5, C.terra4); r(g, x + 34, y + 3, 7, 1, C.terra5);
}

export function coffeeTable(g: G, x: number, y: number) {
  r(g, x + 1, y + 9, 26, 2, rgba(C.ink, 0.3));
  r(g, x, y, 28, 6, C.wood4);
  r(g, x, y, 28, 1, C.wood6);
  r(g, x, y + 6, 28, 2, C.wood2);
  r(g, x + 2, y + 8, 2, 2, C.wood1); r(g, x + 24, y + 8, 2, 2, C.wood1);
  r(g, x + 4, y + 2, 7, 3, C.blue4); r(g, x + 5, y + 2, 7, 3, C.white); r(g, x + 6, y + 3, 4, 1, C.slate4);
  r(g, x + 19, y + 1, 3, 3, C.white); r(g, x + 19, y + 1, 3, 1, C.wood1);
}

export function floorLamp(g: G, x: number, y: number) {
  // (x, y) = base centre
  r(g, x - 3, y - 1, 7, 2, C.ink3);
  r(g, x, y - 30, 1, 29, C.slate2);
  r(g, x - 4, y - 36, 9, 6, C.gold2);
  r(g, x - 3, y - 37, 7, 1, C.gold3);
  r(g, x - 4, y - 31, 9, 1, C.gold4);
}

export function pingPong(g: G, x: number, y: number) {
  // (x, y) = top-left, 64 x 34
  r(g, x + 2, y + 33, 60, 3, rgba(C.ink, 0.3));
  r(g, x + 3, y + 26, 2, 8, C.slate2); r(g, x + 59, y + 26, 2, 8, C.slate2);
  r(g, x, y, 64, 26, C.green2);
  r(g, x, y + 26, 64, 3, C.green1);
  r(g, x, y, 64, 1, C.white); r(g, x, y + 25, 64, 1, C.white);
  r(g, x, y, 1, 26, C.white); r(g, x + 63, y, 1, 26, C.white);
  r(g, x + 1, y + 12, 62, 1, rgba(C.white, 0.6));
  // net
  r(g, x + 31, y - 3, 2, 30, C.slate5);
  r(g, x + 33, y - 2, 1, 29, rgba(C.ink, 0.35));
  r(g, x + 31, y - 4, 2, 1, C.white);
  // paddles + ball
  r(g, x + 10, y + 6, 5, 5, C.red2); r(g, x + 12, y + 11, 1, 3, C.wood3);
  r(g, x + 50, y + 15, 5, 5, C.blue3); r(g, x + 52, y + 20, 1, 3, C.wood3);
  r(g, x + 22, y + 9, 2, 2, C.white);
}

export function arcade(g: G, x: number, y: number, screen: string) {
  // (x, y) = top-left, 16 x 32
  r(g, x + 1, y + 31, 15, 2, rgba(C.ink, 0.35));
  r(g, x, y, 16, 32, C.plum2);
  r(g, x, y, 16, 3, C.plum3);
  r(g, x + 1, y + 1, 14, 1, C.pink);
  r(g, x + 2, y + 5, 12, 10, C.ink);
  r(g, x + 3, y + 6, 10, 8, screen);
  r(g, x + 4, y + 8, 2, 2, C.gold3); r(g, x + 9, y + 10, 3, 1, C.white); r(g, x + 5, y + 12, 6, 1, C.green4);
  r(g, x - 1, y + 16, 18, 4, C.plum1);
  r(g, x + 2, y + 17, 1, 2, C.ink); r(g, x + 2, y + 16, 2, 1, C.red3);
  r(g, x + 8, y + 17, 2, 2, C.gold3); r(g, x + 11, y + 17, 2, 2, C.blue4);
  r(g, x + 2, y + 21, 12, 10, C.plum1);
  r(g, x + 5, y + 24, 6, 3, C.ink2); r(g, x + 7, y + 25, 2, 1, C.gold2);
}

export function beanBag(g: G, x: number, y: number, col: string) {
  // (x, y) = top-left, 14 x 10
  r(g, x + 1, y + 9, 13, 2, rgba(C.ink, 0.3));
  r(g, x + 2, y, 10, 10, col);
  r(g, x, y + 3, 14, 6, col);
  r(g, x + 3, y + 1, 5, 2, lt(col, 0.25));
  r(g, x + 1, y + 8, 12, 1, dk(col, 0.3));
  r(g, x + 5, y + 4, 4, 2, dk(col, 0.15));
}

export function bookshelf(g: G, x: number, y: number, seed: number) {
  // (x, y) = top-left, 32 x 30
  const rr = rng(seed);
  r(g, x + 1, y + 29, 31, 2, rgba(C.ink, 0.3));
  r(g, x, y, 32, 30, C.wood2);
  r(g, x, y, 32, 2, C.wood4);
  const cs = [C.terra2, C.blue3, C.green2, C.plum2, C.gold1, C.red2, C.slate2, C.terra4, C.blue4];
  for (let s = 0; s < 3; s++) {
    const sy = y + 3 + s * 9;
    r(g, x + 2, sy, 28, 8, C.wood1);
    let bx = x + 3;
    while (bx < x + 28) {
      const bw = 1 + Math.floor(rr() * 3);
      const bh = 5 + Math.floor(rr() * 3);
      if (rr() < 0.1) { bx += 3; continue; }
      r(g, bx, sy + 8 - bh, bw, bh, cs[Math.floor(rr() * cs.length)]);
      bx += bw + (rr() < 0.3 ? 1 : 0);
    }
    r(g, x + 2, sy + 8, 28, 1, C.wood4);
  }
}

export function roundRug(g: G, cx: number, cy: number, rx: number, ry: number, fill: string, edge: string) {
  for (let y = -ry; y <= ry; y++) {
    const w = Math.round(rx * Math.sqrt(1 - (y * y) / (ry * ry)));
    r(g, cx - w, cy + y, w * 2, 1, Math.abs(y) > ry - 2 || w < 3 ? edge : fill);
    r(g, cx - w, cy + y, 1, 1, edge); r(g, cx + w - 1, cy + y, 1, 1, edge);
  }
  for (let y = -ry + 4; y <= ry - 4; y += 4) {
    const w = Math.round((rx - 6) * Math.sqrt(1 - (y * y) / ((ry - 2) * (ry - 2))));
    for (let x = -w; x < w; x += 4) r(g, cx + x + ((y / 4) % 2 ? 2 : 0), cy + y, 1, 1, edge);
  }
}

/* ------------------------------------------------- pod props (spare rug) */

export function filingCabinet(g: G, x: number, y: number) {
  // (x, y) = bottom-left, 12 x 20
  floorShadow(g, x, y - 1, 12, 3);
  r(g, x, y - 20, 12, 20, C.slate3);
  r(g, x, y - 20, 12, 1, C.slate4);
  r(g, x + 11, y - 19, 1, 19, C.slate2);
  for (let i = 0; i < 3; i++) {
    const dy = y - 18 + i * 6;
    r(g, x + 1, dy, 10, 5, C.slate4);
    r(g, x + 1, dy + 4, 10, 1, C.slate2);
    r(g, x + 4, dy + 1, 4, 1, C.slate2);
  }
  r(g, x + 2, y - 23, 4, 3, C.gold3); r(g, x + 6, y - 22, 4, 2, C.white);
}

export function whiteboard(g: G, x: number, y: number, seed: number) {
  // (x, y) = bottom-left, 22 x 30, a rolling whiteboard covered in plans
  const rr = rng(seed);
  floorShadow(g, x, y - 1, 22, 3);
  r(g, x + 2, y - 10, 1, 10, C.slate2); r(g, x + 19, y - 10, 1, 10, C.slate2);
  r(g, x + 1, y - 1, 4, 1, C.ink3); r(g, x + 17, y - 1, 4, 1, C.ink3);
  r(g, x, y - 30, 22, 20, C.slate4);
  r(g, x + 1, y - 29, 20, 18, C.white);
  const cols = [C.blue3, C.red2, C.green2, C.ink3];
  for (let i = 0; i < 5; i++) {
    const c = cols[Math.floor(rr() * cols.length)];
    r(g, x + 3, y - 27 + i * 3, 4 + Math.floor(rr() * 12), 1, c);
  }
  r(g, x + 14, y - 26, 5, 5, C.gold4); r(g, x + 14, y - 26, 5, 1, C.gold3);
  r(g, x + 1, y - 11, 20, 1, C.slate3);
}

export function printer(g: G, x: number, y: number, t: number) {
  // (x, y) = bottom-left, 16 x 18 on a little stand
  floorShadow(g, x, y - 1, 16, 3);
  r(g, x + 2, y - 8, 12, 8, C.slate2); r(g, x + 2, y - 8, 12, 1, C.slate3);
  r(g, x, y - 16, 16, 8, C.slate5);
  r(g, x, y - 16, 16, 1, C.white);
  r(g, x + 2, y - 13, 12, 1, C.slate3);
  r(g, x + 3, y - 19, 10, 3, C.white);
  r(g, x + 12, y - 11, 2, 1, Math.floor(t / 700) % 2 ? C.green4 : C.green2);
}

/** Draws whatever prop sits on a pod's spare rug. (x, y) = bottom-left. */
export function podProp(g: G, kind: string, x: number, y: number, seed: number, t: number) {
  switch (kind) {
    case "plant": plantSmall(g, x + 7, y); return;
    case "cabinet": filingCabinet(g, x, y); return;
    case "board": whiteboard(g, x, y, seed); return;
    case "printer": printer(g, x, y, t); return;
  }
}

const decorCache = new Map<string, Bitmap>();
/** Lounge furniture for floor that no pod uses, cached as a bitmap. Origin = top-left of the box. */
export function decorBitmap(kind: string, w: number, seed: number): { bm: Bitmap; oy: number } {
  const key = `${kind}|${w}|${seed % 21}`;
  let bm = decorCache.get(key);
  const H = 70, oy = 6;
  if (!bm) {
    bm = bitmap(w + 8, H);
    const g = bm.g;
    g.translate(4, oy);
    const cx = Math.round(w / 2);
    switch (kind) {
      case "lounge":
        roundRug(g, cx, 40, Math.min(46, cx - 2), 20, C.plum2, C.plum1);
        sofa(g, cx - 24, 18, [C.blue3, C.green2, C.terra2][seed % 3]);
        coffeeTable(g, cx - 14, 44);
        floorLamp(g, w - 4, 44);
        break;
      case "pingpong":
        pingPong(g, cx - 32, 16);
        break;
      case "arcade":
        arcade(g, cx - 18, 10, C.blue2);
        arcade(g, cx + 2, 10, C.green1);
        break;
      case "books":
        bookshelf(g, cx - 16, 8, seed);
        plantSmall(g, cx, 56);
        break;
      case "beanbags":
        beanBag(g, cx - 17, 30, C.terra3);
        beanBag(g, cx + 1, 36, C.gold2);
        break;
      case "plants":
        plantTall(g, cx, 52, seed);
        break;
    }
    decorCache.set(key, bm);
  }
  return { bm, oy };
}

