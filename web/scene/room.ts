/*
 * The room itself. build() paints what only changes with the floor plan into
 * one cached layer: the office (a glass curtain wall onto its city with the
 * lift in a stone core, polished concrete underfoot). Pods are not in that
 * layer: each pod's rug and sign is its own cached bitmap (podBitmap) so pods
 * can glide when the rows reflow; the cloud-room, where remote workers sit, is
 * a pod drawn as a glass-walled meeting room. drawLive() paints the moving
 * parts every frame: the clock, rack LEDs and the TV scoreboard (with a
 * scrolling ticker when an agent shouts).
 */
import type { AgentKind } from "../../src/shared/events.ts";
import { BRAND_ART, C, mix, rgba, type BrandArt } from "./palette.ts";
import { FONT, MICRO, drawText, fit, measure } from "./font.ts";
import { pixelLogo, type LogoKind } from "./logos.ts";
import { MARK_STEP, RUG_TOP, WALL_H, PROP_W, type Block, type Rect } from "./layout.ts";
import * as P from "./props.ts";
import { bitmap, rng, type Bitmap } from "./util.ts";
import type { CityId } from "../cities.ts";

export type { Rect };

export interface RoomPlan {
  room: Rect;
  main: Rect;
  /** every hole the sky shows through */
  windows: Rect[];
  elevator: { x: number; y: number; doorX: number };
  tv: Rect;
  clock: { x: number; y: number };
  /** Where the sky puts the landmarks: from the lift's core to the TV (else the widest clear glass). */
  vista: { x: number; w: number };
  rack: { x: number; y: number };
  coffee: { x: number; y: number };
  plants: { x: number; y: number; seed: number }[];
  /** extra pad around the room in the buffer, for things flying in */
  pad: number;
}

/** The glass runs from the ceiling band down to the sill. */
export const WIN_TOP = 6;
export const WIN_BOTTOM = WALL_H - 6;

export function plan(main: Rect, room: Rect): RoomPlan {
  const x0 = main.x, x1 = main.x + main.w;
  const elevator = { x: x0 + 12, y: WALL_H, doorX: x0 + 12 + P.ELEV_W / 2 };
  const liftEnd = elevator.x + P.ELEV_W;
  // Back wall, left to right: the lift, the coffee counter, then the TV hung right by the
  // server rack (the clock above the rack), so the glass from the lift to the TV is clear view.
  const TV_MIN = 96;
  const rackX = x1 - 34;
  const tvTo = rackX - 4;
  const tvFrom = liftEnd + 44;
  const tvW = Math.max(TV_MIN, Math.min(main.w >= 460 ? 132 : 108, tvTo - tvFrom));
  const tv = { x: Math.max(tvFrom, tvTo - tvW), y: 10, w: tvW, h: 40 };
  // the coffee counter stands just left of the TV, under the glass
  const coffee = { x: tv.x - 32, y: WALL_H + 9 };
  // the clock hangs above the rack with a gap: its panel ends 5px over the rack's top (WALL_H - 42)
  const clock = { x: rackX + 10, y: WALL_H - 52 };
  // The back wall is glass from the lift's core to the corner: panes between slim steel mullions.
  const coreEnd = liftEnd + 6;
  const windows: Rect[] = [];
  const glassW = x1 - 2 - coreEnd, n = Math.max(1, Math.round(glassW / 26));
  for (let i = 0; i < n; i++) {
    const a = coreEnd + Math.round((glassW * i) / n) + (i ? 1 : 0), b = coreEnd + Math.round((glassW * (i + 1)) / n) - 1;
    windows.push({ x: a, y: WIN_TOP, w: b - a, h: WIN_BOTTOM - WIN_TOP });
  }
  // from the core to the TV, else between the TV and the rack
  const left = { x: coreEnd, w: 0 }, right = { x: tv.x + tv.w + 3, w: 0 };
  left.w = tv.x - 3 - left.x;
  right.w = rackX - right.x;
  const vista = left.w >= right.w ? left : right;
  // date palms in planters: one by the lift, one by the coffee counter (under the TV, hiding no view)
  const plants: RoomPlan["plants"] = [{ x: coreEnd + 12, y: WALL_H + 8, seed: 3 }];
  if (coffee.x - 7 - (coreEnd + 12) > 30) plants.push({ x: coffee.x - 7, y: WALL_H + 8, seed: 11 });
  return {
    room, main, windows, elevator, tv, clock, vista,
    rack: { x: rackX, y: WALL_H + 10 },
    coffee,
    plants,
    pad: 120,
  };
}

const r = (g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: string) => {
  g.fillStyle = c;
  g.fillRect(x, y, w, h);
};

/* ------------------------------------------------------------- the floors */

const CONCRETE = "#7d838a", CONCRETE_LT = "#878d94", CONCRETE_DK = "#757b82", JOINT = "#6c7279";
const STEEL = "#4a5058", STEEL_LT = "#6c737c", CEILING = "#22252b", SILL = "#33383f";
const CORE = "#3e4148", CORE_DK = "#34373d", CORE_LT = "#51555d";

/** Polished concrete: big slabs with faint joints and a little mottling. */
function concrete(g: CanvasRenderingContext2D, X0: number, Y0: number, W: number, H: number) {
  const rr = rng(1234);
  r(g, X0, Y0, W, H, CONCRETE);
  for (let i = 0; i < (W * H) / 9; i++) r(g, X0 + Math.floor(rr() * W), Y0 + Math.floor(rr() * H), rr() < 0.3 ? 2 : 1, 1, rr() < 0.5 ? CONCRETE_LT : CONCRETE_DK);
  const T = 32;
  for (let y = Y0 + T; y < Y0 + H; y += T) r(g, X0, y, W, 1, JOINT);
  for (let x = X0 + T; x < X0 + W; x += T) r(g, x, Y0, 1, H, JOINT);
}

/* ---------------------------------------------------------- static layer */

/** Static layer in buffer coordinates (world - origin). `plate` names the city on the wall clock; some cities dress the office up. */
export function build(p: RoomPlan, origin: { x: number; y: number }, size: { w: number; h: number }, plate: string, city?: CityId): Bitmap {
  const b = bitmap(size.w, size.h);
  const g = b.g;
  g.save();
  g.translate(-origin.x, -origin.y);
  buildOffice(g, p, plate);
  if (city === "rio") rioColours(g, p);
  g.restore();
  return b;
}

const BR_GREEN = "#1f9a4a", BR_YELLOW = "#f7d417", BR_BLUE = "#1f4fa8";

/**
 * Rio dresses the office in Brazil's colours: bandeirinhas (little green, yellow, blue and white
 * flags) strung across the top of the glass, clear of the TV and the clock.
 */
function rioColours(g: CanvasRenderingContext2D, p: RoomPlan) {
  const m = p.main;
  const X0 = p.elevator.x + P.ELEV_W + 6, X1 = m.x + m.w - 2;
  const skip = [[p.tv.x - 4, p.tv.x + p.tv.w + 4], [p.clock.x - 22, p.clock.x + 22]];
  const flags = [BR_GREEN, BR_YELLOW, BR_BLUE, C.white];
  const SPAN = 36;
  let n = 0;
  for (let x = X0; x < X1; x++) {
    if (skip.some(([a, b]) => x >= a! && x <= b!)) continue;
    // the string sags between hooks every SPAN px
    const u = ((x - X0) % SPAN) / SPAN;
    const y = WIN_TOP + 1 + Math.round(Math.sin(u * Math.PI) * 5);
    r(g, x, y, 1, 1, C.slate2);
    if ((x - X0) % 5 === 2 && x + 3 < X1 && !skip.some(([a, b]) => x + 3 >= a! && x <= b!)) {
      const c = flags[n++ % flags.length]!;
      r(g, x, y + 1, 4, 1, c); r(g, x, y + 2, 4, 1, c); r(g, x + 1, y + 3, 2, 1, c);
      r(g, x + 3, y + 1, 1, 2, mix(c, C.ink, 0.25));
    }
  }
}

function buildOffice(g: CanvasRenderingContext2D, p: RoomPlan, plate: string) {
  const m = p.main;
  const X0 = m.x, X1 = m.x + m.w, Y1 = m.y + m.h;
  const rr = rng(4321);
  g.save();
  g.beginPath();
  g.rect(X0, WALL_H, m.w, Y1 - WALL_H);
  g.clip();
  concrete(g, X0, WALL_H, m.w, Y1 - WALL_H);
  // the glass wall's sheen on the polished floor, fading out from the sill
  for (const w of p.windows) {
    for (let i = 0; i < 16; i++) {
      g.fillStyle = rgba(C.white, 0.06 * (1 - i / 16));
      g.fillRect(w.x + 2, WALL_H + i, Math.max(0, w.w - 4), 1);
    }
  }
  // soft depth: the floor darkens toward the walls, brightest mid-room
  for (let i = 0; i < 8; i++) {
    g.fillStyle = rgba(C.ink, 0.04);
    g.fillRect(X0, WALL_H, m.w, 12 - i);
    g.fillRect(X0, WALL_H, 12 - i * 1.4, Y1 - WALL_H);
    g.fillRect(X1 - 12 + i * 1.4, WALL_H, 12 - i * 1.4, Y1 - WALL_H);
    g.fillRect(X0, Y1 - 8 + i, m.w, 8 - i);
  }
  // the corridor along the glass: a darker band edged with LED strips set in the floor
  r(g, X0, WALL_H + 11, m.w, 15, rgba(C.ink, 0.12));
  r(g, X0, WALL_H + 11, m.w, 1, rgba(C.cyan3, 0.35));
  r(g, X0, WALL_H + 25, m.w, 1, rgba(C.cyan3, 0.2));
  g.restore();

  // ---- back wall: steel behind everything, then the panes are punched through it
  r(g, X0, 0, m.w, WALL_H, STEEL);
  for (const w of p.windows) {
    if (w.x > X1) continue;
    g.clearRect(w.x, w.y, w.w, w.h);
    glassSheen(g, w);
    r(g, w.x - 1, w.y, 1, w.h, STEEL_LT);
    g.fillStyle = rgba(STEEL_LT, 0.7);
    g.fillRect(w.x, WALL_H - 20, w.w, 1);
  }
  // the ceiling band with its light strip, and the sill the glass stands on
  r(g, X0, 0, m.w, WIN_TOP - 1, CEILING);
  r(g, X0, WIN_TOP - 1, m.w, 1, mix(CEILING, C.cyan4, 0.5));
  r(g, X0, WIN_BOTTOM, m.w, WALL_H - WIN_BOTTOM, SILL);
  r(g, X0, WIN_BOTTOM, m.w, 1, STEEL_LT);
  // the lift's core: dark stone panels
  const coreEnd = p.windows.length ? p.windows[0]!.x - 1 : p.elevator.x + P.ELEV_W + 6;
  r(g, X0, WIN_TOP - 1, coreEnd - X0, WALL_H - WIN_TOP + 1, CORE);
  for (let i = 0; i < (coreEnd - X0) * 6; i++) r(g, X0 + Math.floor(rr() * (coreEnd - X0)), WIN_TOP + Math.floor(rr() * (WALL_H - WIN_TOP)), 1, 1, rr() < 0.5 ? CORE_DK : CORE_LT);
  for (let x = X0 + 14; x < coreEnd - 2; x += 14) r(g, x, WIN_TOP, 1, WALL_H - WIN_TOP, CORE_DK);
  r(g, X0, 30, coreEnd - X0, 1, CORE_DK);
  r(g, coreEnd - 1, WIN_TOP - 1, 1, WALL_H - WIN_TOP + 1, CORE_LT);
  // the TV and the clock hang from the ceiling on thin rods
  const rod = (x: number, to: number) => r(g, x, WIN_TOP - 1, 1, to - WIN_TOP + 1, STEEL_LT);

  // ---- TV frame (screen drawn live)
  const tv = p.tv;
  rod(tv.x + 10, tv.y - 3); rod(tv.x + tv.w - 11, tv.y - 3);
  r(g, tv.x - 3, tv.y - 3, tv.w + 6, tv.h + 6, C.ink);
  r(g, tv.x - 2, tv.y - 2, tv.w + 4, 1, C.slate1);

  // the clock, with a small plate naming the city hung on the same rods above it
  rod(p.clock.x - 8, p.clock.y - 5); rod(p.clock.x + 8, p.clock.y - 5);
  const pw = Math.max(21, measure(MICRO(), plate) + 4), px0 = p.clock.x - Math.floor(pw / 2);
  r(g, px0 - 1, p.clock.y - 14, pw + 2, 7, C.ink3);
  r(g, px0, p.clock.y - 13, pw, 5, C.ink);
  drawText(g, MICRO(), plate, px0 + Math.floor((pw - measure(MICRO(), plate)) / 2), p.clock.y - 13, C.slate5);
  P.clockFace(g, p.clock.x, p.clock.y);

  P.elevatorFrame(g, p.elevator.x, p.elevator.y);
  drawText(g, MICRO(), "LIFT", p.elevator.x + 2, p.elevator.y - P.ELEV_H - 17, C.slate4);

  P.coffeeMachine(g, p.coffee.x, p.coffee.y);
  P.rack(g, p.rack.x, p.rack.y);
  for (const pl of p.plants) P.datePalm(g, pl.x, pl.y, pl.seed);
  g.fillStyle = rgba(C.ink, 0.22);
  g.fillRect(p.coffee.x - 1, p.coffee.y, 28, 2);
  g.fillRect(p.rack.x - 1, p.rack.y, 22, 2);
}

function glassSheen(g: CanvasRenderingContext2D, w: Rect) {
  g.fillStyle = rgba(C.white, 0.08);
  for (let i = 0; i < w.h; i++) {
    const sx = w.x + 4 + Math.floor(i * 0.6);
    if (sx + 3 < w.x + w.w) g.fillRect(sx, w.y + w.h - 1 - i, 3, 1);
  }
  g.fillStyle = rgba(C.white, 0.05);
  for (let i = 0; i < w.h; i++) {
    const sx = w.x + 12 + Math.floor(i * 0.6);
    if (sx + 1 < w.x + w.w) g.fillRect(sx, w.y + w.h - 1 - i, 1, 1);
  }
}

/** A tiny pixel cloud, 9 x 5. */
function cloudGlyph(g: CanvasRenderingContext2D, x: number, y: number, col: string) {
  r(g, x + 3, y, 3, 1, col); r(g, x + 1, y + 1, 6, 1, col); r(g, x + 2, y + 1, 1, 1, col);
  r(g, x, y + 2, 9, 2, col); r(g, x + 1, y + 4, 7, 1, col);
}

/* ----------------------------------------------------------------- pods */

const podCache = new WeakMap<Block, { key: string; bm: Bitmap }>();
/** Overhang around a pod's box in its bitmap (tassels, shadow, sign). */
export const POD_BM_PAD = 4;

/** A pod's rug (the cloud-room's glass walls and carpet) and hanging sign, cached until it changes. */
export function podBitmap(b: Block): Bitmap {
  const key = `${b.rev}|${b.w}x${b.h}|${b.label}|${b.mix.join()}`;
  const have = podCache.get(b);
  if (have && have.key === key) return have.bm;
  const bm = bitmap(b.w + POD_BM_PAD * 2, b.h + POD_BM_PAD * 2);
  const g = bm.g;
  g.translate(POD_BM_PAD, POD_BM_PAD);
  if (b.zone === "cloud") meetingRoom(g, b);
  else rug(g, b);
  sign(g, b);
  podCache.set(b, { key, bm });
  return bm;
}

function rug(g: CanvasRenderingContext2D, b: Block) {
  const A = BRAND_ART[b.agent] ?? BRAND_ART.claude;
  const [fill, border, pat] = A.rug;
  const x = 0, y = RUG_TOP, w = b.w, h = b.h - RUG_TOP - 1;
  g.fillStyle = rgba(C.ink, 0.28);
  g.fillRect(x + 1, y + 2, w, h);
  r(g, x, y, w, h, fill);
  const frame = (inset: number, c: string) => {
    r(g, x + inset, y + inset, w - inset * 2, 1, c); r(g, x + inset, y + h - 1 - inset, w - inset * 2, 1, c);
    r(g, x + inset, y + inset, 1, h - inset * 2, c); r(g, x + w - 1 - inset, y + inset, 1, h - inset * 2, c);
  };
  const inner = { x0: x + 6, y0: y + 6, x1: x + w - 6, y1: y + h - 6 };
  const each = (sx: number, sy: number, fn: (xx: number, yy: number, i: number, j: number) => void) => {
    for (let yy = inner.y0, j = 0; yy < inner.y1; yy += sy, j++) for (let xx = inner.x0, i = 0; xx < inner.x1; xx += sx, i++) fn(xx, yy, i, j);
  };
  switch (A.pattern) {
    case "checker": {
      // crisp monochrome: black/white checker border, fine dot grid
      const lite = "#c4c4ca";
      for (let i = 0; i < w; i += 2) { r(g, x + i, y, 2, 2, (i / 2) % 2 ? lite : C.cc0); r(g, x + i, y + h - 2, 2, 2, (i / 2) % 2 ? C.cc0 : lite); }
      for (let j = 0; j < h; j += 2) { r(g, x, y + j, 2, 2, (j / 2) % 2 ? lite : C.cc0); r(g, x + w - 2, y + j, 2, 2, (j / 2) % 2 ? C.cc0 : lite); }
      frame(4, C.cc0);
      each(5, 5, (xx, yy) => r(g, xx + 2, yy + 2, 1, 1, pat));
      break;
    }
    case "diamond": {
      frame(2, border); frame(4, pat);
      each(8, 8, (xx, yy, i, j) => { const ox = j % 2 ? 4 : 0; if (xx + ox + 2 < inner.x1) { r(g, xx + ox + 1, yy, 1, 1, pat); r(g, xx + ox, yy + 1, 3, 1, pat); r(g, xx + ox + 1, yy + 2, 1, 1, pat); } void i; });
      for (let i = 4; i < w - 4; i += 3) { r(g, x + i, y - 1, 1, 1, border); r(g, x + i, y + h, 1, 1, border); }
      break;
    }
    case "hex": {
      frame(2, border);
      each(10, 7, (xx, yy, i, j) => { const ox = j % 2 ? 5 : 0; if (xx + ox + 4 < inner.x1) { r(g, xx + ox + 1, yy, 3, 1, pat); r(g, xx + ox, yy + 1, 1, 2, pat); r(g, xx + ox + 4, yy + 1, 1, 2, pat); r(g, xx + ox + 1, yy + 3, 3, 1, pat); } void i; });
      break;
    }
    case "blocks": {
      // opencode: a terminal-block weave, peach squares on charcoal
      frame(1, border); frame(3, mix(fill, border, 0.25));
      each(7, 7, (xx, yy, i, j) => { if ((i + j) % 3 === 0) { r(g, xx, yy, 4, 4, pat); r(g, xx + 1, yy + 1, 2, 2, fill); } });
      break;
    }
    case "chevron": {
      // droid: hazard chevrons at the ends, a steel deck between
      frame(1, border);
      for (let i = 0; i < w - 2; i++) for (let j = 0; j < 4; j++) if (((i + j) >> 2) % 2 === 0) { r(g, x + 1 + i, y + 1 + j, 1, 1, border); r(g, x + 1 + i, y + h - 5 + j, 1, 1, border); }
      each(6, 6, (xx, yy) => r(g, xx + 2, yy + 2, 1, 1, pat));
      break;
    }
    case "sparkle": {
      // gemini: four-point sparkles in blue, violet and pink on deep indigo
      frame(2, border);
      const cols = [C.gmBlue, C.gm4, C.gmPink];
      each(12, 10, (xx, yy, i, j) => {
        const ox = j % 2 ? 6 : 0, c = cols[(i + j) % 3];
        if (xx + ox + 3 > inner.x1) return;
        r(g, xx + ox + 1, yy, 1, 3, c); r(g, xx + ox, yy + 1, 3, 1, c);
      });
      break;
    }
    case "tri": {
      // qwen: interlocking triangles
      frame(2, border);
      each(8, 6, (xx, yy, i, j) => { const ox = j % 2 ? 4 : 0; if (xx + ox + 4 < inner.x1) { r(g, xx + ox + 2, yy, 1, 1, pat); r(g, xx + ox + 1, yy + 1, 3, 1, pat); r(g, xx + ox, yy + 2, 5, 1, pat); } void i; });
      break;
    }
    case "cube": {
      // cursor: isometric cubes in graphite
      frame(1, border); frame(3, pat);
      each(8, 8, (xx, yy, i, j) => { const ox = j % 2 ? 4 : 0; if (xx + ox + 4 < inner.x1) { r(g, xx + ox + 1, yy, 2, 1, border); r(g, xx + ox, yy + 1, 4, 2, pat); r(g, xx + ox + 2, yy + 1, 2, 2, mix(pat, C.ink, 0.35)); } void i; });
      break;
    }
    case "goggles": {
      // copilot: rows of little flight goggles
      frame(2, border);
      each(10, 7, (xx, yy, i, j) => { const ox = j % 2 ? 5 : 0; if (xx + ox + 6 < inner.x1) { r(g, xx + ox, yy + 1, 2, 2, pat); r(g, xx + ox + 2, yy + 1, 1, 1, border); r(g, xx + ox + 3, yy + 1, 2, 2, pat); } void i; });
      break;
    }
    default:
      frame(2, border);
  }
  // brand emblem woven into the rug, bottom-right
  const em = pixelLogo(b.agent as LogoKind, 11, b.agent === "commandcode" ? C.cc6 : mix(pat, A.light, 0.3));
  g.globalAlpha = 0.85;
  g.drawImage(em.c, w - 18, b.h - 15);
  g.globalAlpha = 1;
}

/** The cloud-room: a meeting room on the office floor, low carpet inside glass walls with steel posts. */
function meetingRoom(g: CanvasRenderingContext2D, b: Block) {
  const x = 0, y = RUG_TOP - 4, w = b.w, h = b.h - RUG_TOP + 3;
  g.fillStyle = rgba(C.ink, 0.28);
  g.fillRect(x + 1, y + 2, w, h);
  r(g, x, y, w, h, CARPET);
  for (let yy = y + 3; yy < y + h - 2; yy += 4) for (let xx = x + 3 + ((yy >> 2) % 2) * 2; xx < x + w - 3; xx += 4) r(g, xx, yy, 1, 1, CARPET_LT);
  // glass: a frosted band along the back, clear panes down the sides, a sill along the front
  g.fillStyle = rgba(C.cyan4, 0.22);
  g.fillRect(x, y, w, 3);
  g.fillRect(x, y, 2, h);
  g.fillRect(x + w - 2, y, 2, h);
  r(g, x, y + h - 2, w, 2, rgba(C.cyan4, 0.35));
  r(g, x, y, w, 1, rgba(C.white, 0.35));
  // steel posts at the corners and every few desks along the back
  for (const px of [x, x + w - 2]) { r(g, px, y, 2, h, STEEL_LT); r(g, px, y, 1, h, C.slate5); }
  for (let px = x + 46; px < x + w - 20; px += 46) r(g, px, y, 1, 3, STEEL_LT);
  cloudGlyph(g, w - 14, b.h - 9, rgba(C.cyan4, 0.55));
}

const CARPET = "#2b3446", CARPET_LT = "#33405a";

function sign(g: CanvasRenderingContext2D, b: Block) {
  const f = FONT();
  const cloud = b.zone === "cloud";
  const A: BrandArt = BRAND_ART[b.agent] ?? BRAND_ART.claude;
  // A pod two agents share carries both marks, stepped like a stack of badges.
  const marks = cloud ? [] : b.mix.slice(0, 3);
  const extra = Math.max(0, marks.length - 1) * MARK_STEP;
  const label = fit(f, b.label, Math.max(24, b.w - 23 - extra));
  const w = measure(f, label) + extra + 21;
  const x = 2, y = 2;
  const plate = cloud ? C.ink2 : A.plate;
  const edge = cloud ? C.cyan3 : A.ink;
  r(g, x + 4, y - 5, 1, 5, C.slate2); r(g, x + w - 5, y - 5, 1, 5, C.slate2);
  g.fillStyle = rgba(C.ink, 0.25);
  g.fillRect(x + 2, y + 13, w, 3);
  r(g, x + 1, y, w - 2, 13, plate); r(g, x, y + 1, w, 11, plate);
  r(g, x + 1, y + 12, w - 2, 1, edge);
  r(g, x + 1, y, w - 2, 1, mix(plate, C.slate3, 0.4));
  if (cloud) cloudGlyph(g, x + 3, y + 4, C.cyan4);
  else if (marks.length > 1) {
    // back to front, so the pod's own mark is on top
    for (let i = marks.length - 1; i >= 0; i--) {
      const a = marks[i]!;
      const lg = pixelLogo(a as LogoKind, 9, (BRAND_ART[a] ?? BRAND_ART.claude).ink);
      r(g, x + 2 + i * MARK_STEP, y + 1, 11, 11, plate);
      g.drawImage(lg.c, x + 3 + i * MARK_STEP, y + 2);
    }
  } else g.drawImage(pixelLogo(b.agent as LogoKind, 9, A.ink).c, x + 3, y + 2);
  drawText(g, f, label, x + 15 + extra, y + 3, cloud ? C.cyan4 : C.white);
}

/** Where a pod's sign sits, relative to the pod's top-left (for the vector overlay). */
export const SIGN_LOGO = { x: 5, y: 4, size: 9 };

/** Props on the spare end of a pod's rug, drawn in the y-sorted pass. */
export function podProps(b: Block): { kind: string; x: number; y: number }[] {
  const out: { kind: string; x: number; y: number }[] = [];
  let x = b.x + b.w - 6;
  for (const p of b.props) {
    const pw = PROP_W[p];
    x -= pw;
    out.push({ kind: p, x: Math.round(x), y: Math.round(b.y) + b.propY + 52 });
    x -= 3;
  }
  return out;
}

/* ---------------------------------------------------------- live pieces */

export interface Shout { text: string; agent: AgentKind; t0: number }

/** TV, clock, rack LEDs. Elevator doors are drawn by the scene (they need y-order). */
export interface Board {
  workers: number;
  tools: number;
  flips: number;
  spark: number[];
  /** Sessions waiting on their human right now. */
  waiting?: number;
  live: boolean;
  /** latest agent shouts, newest last; the TV runs the newest as a ticker */
  shouts: Shout[];
  /** the office's name across the top of the TV (--name) */
  title?: string;
}

export const SHOUT_MS = 16_000;
/** A shout fills the whole TV this long before it shrinks to a band. */
export const SHOUT_HOLD_MS = 3_200;

/** Up to `max` lines of `text` within `maxW` font px, the last one trimmed with an ellipsis. */
function wrap(f: ReturnType<typeof FONT>, text: string, maxW: number, max: number): string[] {
  const words = text.split(" ");
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (measure(f, next) <= maxW || !cur) cur = next;
    else {
      out.push(cur);
      cur = w;
    }
  }
  if (cur) out.push(cur);
  if (out.length > max) out.splice(max - 1, out.length, out.slice(max - 1).join(" "));
  return out.map((l) => fit(f, l, maxW));
}

/** An agent's mark for the TV: the hand-pixelled one at TV sizes. */
function logoMark(agent: AgentKind, px: number): Bitmap {
  return pixelLogo(agent as LogoKind, px, (BRAND_ART[agent] ?? BRAND_ART.claude).ink);
}

export function drawLive(g: CanvasRenderingContext2D, p: RoomPlan, t: number, now: Date, board: Board, activity: number) {
  P.clockDigits(g, p.clock.x, p.clock.y, now);
  // the viewer's own time on a strip hung under the TV, next to the office's city clock
  const mine = new Date();
  const label = `YOUR TIME: ${String(mine.getHours()).padStart(2, "0")}:${String(mine.getMinutes()).padStart(2, "0")}`;
  const m = MICRO(), lw = measure(m, label) + 6;
  const lx = p.tv.x + Math.floor((p.tv.w - lw) / 2), ly = p.tv.y + p.tv.h + 6;
  r(g, lx + 4, ly - 3, 1, 3, C.slate3); r(g, lx + lw - 5, ly - 3, 1, 3, C.slate3);
  r(g, lx, ly, lw, 9, C.ink);
  drawText(g, m, label, lx + 3, ly + 2, "#7ef6ff");
  P.rackLeds(g, p.rack.x, p.rack.y, t, activity);
  P.coffeeSteam(g, p.coffee.x, p.coffee.y, t);
  tvScreen(g, p.tv, t, board);
}

function tvScreen(g: CanvasRenderingContext2D, tv: Rect, t: number, b: Board) {
  const m = MICRO(), f = FONT();
  const shout = b.shouts.length ? b.shouts[b.shouts.length - 1] : null;
  const live = shout && t - shout.t0 < SHOUT_MS ? shout : null;
  r(g, tv.x, tv.y, tv.w, tv.h, C.ink2);
  for (let y = 0; y < tv.h; y += 2) r(g, tv.x, tv.y + y, tv.w, 1, mix(C.ink2, C.blue1, 0.5));
  drawText(g, m, fit(m, asciiOnly(b.title ?? "").toUpperCase() || "AGENT VIZ", tv.w - 12), tv.x + 3, tv.y + 2, C.gold3);
  if (Math.floor(t / 600) % 2 === 0) r(g, tv.x + tv.w - 6, tv.y + 3, 3, 3, C.red3);
  const cols: [number, string, string][] = [[b.workers, "CREW", C.white], [b.tools, "TOOLS", C.blue5], [b.flips, "FLIPS", C.terra4]];
  const cw = Math.floor((tv.w - 4) / 3);
  cols.forEach(([n, label, c], i) => {
    const x = tv.x + 2 + i * cw;
    const s = n > 9999 ? (n / 1000).toFixed(0) + "K" : String(n);
    const big = measure(f, s) <= cw - 2;
    if (big) drawText(g, f, s, x + Math.floor((cw - measure(f, s)) / 2), tv.y + 9, c);
    else drawText(g, m, s, x + Math.floor((cw - measure(m, s)) / 2), tv.y + 11, c);
    drawText(g, m, label, x + Math.floor((cw - measure(m, label)) / 2), tv.y + 18, C.slate3);
  });
  const by = tv.y + tv.h - 13;
  const ink = live ? (BRAND_ART[live.agent] ?? BRAND_ART.claude).ink : C.ink;
  const text = live ? asciiOnly(live.text) || "!" : "";
  const age = live ? t - live.t0 : 0;
  if (live && age < SHOUT_HOLD_MS) {
    // The shout takes the whole screen first: the agent's mark and its words, still and centred.
    const flash = age < 900 && Math.floor(age / 150) % 2 === 0;
    r(g, tv.x, tv.y, tv.w, tv.h, flash ? mix(C.ink2, ink, 0.35) : C.ink2);
    for (let y = 0; y < tv.h; y += 2) r(g, tv.x, tv.y + y, tv.w, 1, rgba(C.blue1, 0.35));
    r(g, tv.x, tv.y, tv.w, 9, C.red1);
    drawText(g, m, "LIVE", tv.x + 3, tv.y + 2, C.white);
    if (Math.floor(t / 400) % 2 === 0) r(g, tv.x + 21, tv.y + 3, 3, 3, C.white);
    const lines = wrap(f, text, tv.w - 8, 2);
    const lg = logoMark(live.agent, 9);
    const top = tv.y + 12 + (lines.length === 1 ? 4 : 0);
    g.drawImage(lg.c, tv.x + Math.floor((tv.w - 9) / 2), top);
    lines.forEach((l, i) => drawText(g, f, l, tv.x + Math.floor((tv.w - measure(f, l)) / 2), top + 11 + i * 9, C.white));
    g.fillStyle = rgba(C.white, 0.05);
    g.fillRect(tv.x + tv.w - 24, tv.y, 9, tv.h);
    return;
  }
  if (live) {
    // then a red band under the counters: still if it fits, a ticker if it doesn't
    r(g, tv.x, by - 2, tv.w, 12, C.red1);
    r(g, tv.x, by - 2, 12, 12, C.red2);
    g.drawImage(logoMark(live.agent, 7).c, tv.x + 3, by);
    const tw = measure(f, text);
    const span = tv.w - 15;
    const x = tw <= span - 2 ? tv.x + 14 + Math.floor((span - tw) / 2) : tv.x + 14 + span - (((age - SHOUT_HOLD_MS) * 0.03) % (tw + span));
    g.save();
    g.beginPath();
    g.rect(tv.x + 13, by - 2, span, 12);
    g.clip();
    drawText(g, f, text, x, by, C.white);
    g.restore();
  } else {
    // who needs the viewer, else the activity sparkline (who's in is on the page already)
    if (b.waiting) {
      // who is waiting on a human, instead of the sparkline: the office's to-do for the viewer
      const msg = `${b.waiting} NEED${b.waiting === 1 ? "S" : ""} YOU`;
      const mx = tv.x + tv.w - 4 - measure(m, msg);
      if (Math.floor(t / 700) % 2 === 0) r(g, mx - 5, by + 1, 3, 3, C.gold3);
      drawText(g, m, msg, mx, by, C.gold3);
      g.fillStyle = rgba(C.white, 0.05);
      g.fillRect(tv.x + tv.w - 24, tv.y, 9, tv.h);
      return;
    }
    const sx = tv.x + 3, sw = tv.w - 6, sy = tv.y + tv.h - 5;
    const n = Math.min(b.spark.length, sw);
    const max = Math.max(3, ...b.spark.slice(-n));
    for (let i = 0; i < n; i++) {
      const v = b.spark[b.spark.length - n + i];
      const hgt = Math.max(v > 0 ? 1 : 0, Math.round((v / max) * 9));
      r(g, sx + i, sy - hgt, 1, hgt, i === n - 1 ? C.gold3 : C.green3);
    }
  }
  g.fillStyle = rgba(C.white, 0.05);
  g.fillRect(tv.x + tv.w - 24, tv.y, 9, tv.h);
}

/** The bitmap fonts are ASCII plus a few symbols; emoji and the like are dropped. */
export function asciiOnly(s: string): string {
  return s.replace(/[^\x20-\x7e·…→✓✗♥⌘]/gu, "").replace(/\s+/g, " ").trim();
}
