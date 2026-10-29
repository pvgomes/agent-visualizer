/*
 * The office scene: owns the canvas and implements OfficeScene from
 * web/contract.ts. Each frame the world is painted at art resolution into an
 * offscreen buffer (sky, cached room layer, pod rugs, y-sorted desks and
 * workers, fx, lighting), blitted to the canvas with sharp nearest-neighbour
 * scaling, then the screen-resolution label pass and the CRT post-pass run
 * on the same canvas so captureStream()/toDataURL() see it all.
 */
import type { CreateOfficeScene, OfficeEvent, OfficeScene, Snapshot } from "../contract.ts";
import { C, rgba } from "./palette.ts";
import { Crew, brandInk, type DrawCall } from "./workers.ts";
import { Visitors } from "./visitors.ts";
import { Kicker } from "./kicker.ts";
import { Sky, skyAt, weatherToday, type Weather } from "./sky.ts";
import { DEFAULT_CITY, cityDate, cityHour, cityOf, type CityId } from "../cities.ts";
import { Lighting, shaft, type Light } from "./lighting.ts";
import { Camera, type Insets } from "./camera.ts";
import { drawLabels } from "./labels.ts";
import { Crt } from "./crt.ts";
import * as R from "./room.ts";
import * as P from "./props.ts";
import { DESK_W, POD_H, WALL_H, deskTop } from "./layout.ts";
import { BRAND } from "../../src/shared/events.ts";
import { FONT, fit, textBitmap } from "./font.ts";
import { drawMark } from "./logos.ts";
import { bitmap, clamp, ctx2d, makeCanvas, type Bitmap } from "./util.ts";

const VOID = "#0b0a13";
/** Night is a cool indigo, so warm lamp pools and screen glow pop against it. */
const NIGHT = "#0a0d2c";
const NIGHT_K = 0.84;
const WIN_TOP = R.WIN_TOP;
const WIN_H = R.WIN_BOTTOM - R.WIN_TOP;
/** A camera zoom rounded to whole device px per art px (crisp), once it is at least 1. */
const whole = (z: number) => (z >= 1 ? Math.round(z) : z);

export interface OfficeSceneExtras extends OfficeScene {
  /** Pin the sky to an hour (0-24) instead of the clock in the office's city; null = live. */
  setHour(hour: number | null): void;
  /** Force the weather (clear, a sandy shamal, drizzle); null follows today's date in the city. */
  setWeather(w: Weather | null): void;
  setCity(city: CityId): void;
  getCity(): CityId;
  previewCity(city: CityId, w: number, h: number): HTMLCanvasElement;
  /** Keep auto-fit clear of UI panels (CSS px); `overlay` panels are framed around but never re-pack the office. */
  setInsets(insets: Partial<Insets>, overlay?: Partial<Insets>): void;
  stats(): { fps: number; workers: number; particles: number; drawMs: number };
  /** Jump the camera (world px, zoom in device px per art px). For tooling. */
  view(x: number, y: number, zoom: number, snap?: boolean): void;
  workerAt(id: string): { x: number; y: number } | null;
}

export const createOfficeScene: CreateOfficeScene = (mount: HTMLElement) => create(mount);

/** A still of a city's view at its hour right now, `w` x `h` art px: the location picker's postcards. */
function postcard(id: CityId, w: number, h: number): HTMLCanvasElement {
  const view = new Sky(7);
  view.city = id;
  const c = makeCanvas(w, h);
  const g = ctx2d(c);
  const room = { x: 0, w };
  view.draw(g, [{ x: 0, y: 0, w, h }], room, 0, h, skyAt(cityHour(id)), performance.now(), 0, weatherToday(id), { x: 4, w: w - 8 });
  return c;
}

export function create(mount: HTMLElement): OfficeSceneExtras {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;outline:none;";
  /* Drags and pinches are the camera's, unless the page around the office
   * scrolls: then a vertical drag scrolls the page (touch-action pan-y) and a
   * plain wheel does too. An embedder's own touch-action is left alone. */
  let touchAction = "none";
  const pageScrolls = () => {
    const se = document.scrollingElement;
    return !!se && se.scrollHeight > se.clientHeight + 1;
  };
  canvas.setAttribute("aria-label", "agent-visualizer: a live pixel-art view of your coding agents");
  canvas.tabIndex = -1;
  if (getComputedStyle(mount).position === "static") mount.style.position = "relative";
  mount.appendChild(canvas);
  const g = ctx2d(canvas, { alpha: false });

  let clock = 0;
  const crew = new Crew(() => clock);
  const visitors = new Visitors(crew, () => plan.coffee);
  const kicker = new Kicker();
  const sky = new Sky(7);
  const lighting = new Lighting();
  const cam = new Camera();
  const crt = new Crt();

  let dpr = 1;
  let crtOn = false;
  let hourOverride: number | null = null;
  let weather: Weather | null = null;
  let city: CityId = DEFAULT_CITY;
  let selectCb: ((id: string | null) => void) | null = null;
  let hoverCb: ((id: string | null) => void) | null = null;
  let labelBoxes: { x: number; y: number; w: number; h: number; id?: string }[] = [];

  // the world buffer and its cached static layer
  let layoutVersion = -1;
  let room = crew.layout.room();
  let plan = R.plan(crew.layout.main, room);
  let origin = { x: 0, y: 0 };
  let size = { w: 1, h: 1 };
  let world: Bitmap = bitmap(1, 1);
  let staticLayer: Bitmap = bitmap(1, 1);
  let inter: Bitmap = bitmap(1, 1);
  let bg: Bitmap | null = null;

  function rebuild() {
    layoutVersion = crew.layout.version;
    room = crew.layout.room();
    plan = R.plan(crew.layout.main, room);
    origin = { x: room.x - plan.pad, y: room.y - plan.pad };
    const ns = { w: room.w + plan.pad * 2, h: room.h + plan.pad * 2 };
    if (ns.w !== size.w || ns.h !== size.h) {
      size = ns;
      // CPU-backed: thousands of tiny fills rasterize fast in software
      const wc = makeCanvas(size.w, size.h);
      world = { c: wc, g: ctx2d(wc), w: size.w, h: size.h };
    }
    staticLayer = R.build(plan, origin, size, cityOf(city).plate, city);
    crew.setElevatorX(plan.elevator.doorX);
    crew.fx.seedDust(plan.windows.filter((w) => w.x < crew.layout.main.x + crew.layout.main.w).map((w) => ({ x: w.x, y: WALL_H, w: w.w + 30, h: 46 })));
  }

  /** x extent of the pods plus a margin, so auto-fit never crops a desk. */
  function podSpan(): { x0: number; x1: number } | undefined {
    let x0 = Infinity, x1 = -Infinity;
    for (const b of crew.layout.blocks.values()) { x0 = Math.min(x0, b.tx); x1 = Math.max(x1, b.tx + b.w); }
    return isFinite(x0) ? { x0: x0 - 26, x1: x1 + 26 } : undefined;
  }

  /* ---------------------------------------------------------------- sizing */
  let lastDpr = 0;
  /* Up to 3x: a phone's canvas at its real pixel ratio, so a whole zoom is a
   * whole number of screen pixels (at 2x a 3x phone resampled every frame). */
  const MAX_DPR = 3;
  function resize() {
    lastDpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const rect = mount.getBoundingClientRect();
    const cssW = Math.max(1, rect.width), cssH = Math.max(1, rect.height);
    dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    // cap the backing store around 6 MP so 4K screens stay smooth
    const maxPx = 6_000_000;
    if (cssW * cssH * dpr * dpr > maxPx) dpr = Math.sqrt(maxPx / (cssW * cssH));
    const w = Math.round(cssW * dpr), h = Math.round(cssH * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      g.imageSmoothingEnabled = false;
      bg = null;
    }
    cam.vw = w;
    cam.vh = h;
    cam.dpr = dpr;
    crew.layout.setAspect(cam.layoutAspect(), cssW / cssH < 0.8);
    if (canvas.style.touchAction === touchAction) canvas.style.touchAction = touchAction = pageScrolls() ? "pan-y" : "none";
  }
  /* The chrome can keep auto-fit clear of its panels without touching the
   * contract: set --scene-inset-{top,right,bottom,left} (px) on the mount,
   * or call setInsets(). CSS values are re-read about once a second. */
  let insetsFromCss = false;
  let insetsFromApi = false;
  let insetCheck = 0;
  function readCssInsets() {
    if (insetsFromApi) return;
    const cs = getComputedStyle(mount);
    const v = (k: string) => parseFloat(cs.getPropertyValue(`--scene-inset-${k}`)) || 0;
    const i = { top: v("top"), right: v("right"), bottom: v("bottom"), left: v("left") };
    if (i.top || i.right || i.bottom || i.left || insetsFromCss) {
      insetsFromCss = !!(i.top || i.right || i.bottom || i.left);
      cam.insets = i;
      relayoutSoon();
    }
  }
  /* A panel that slides in or out (the feed) re-packs the office once it has settled, not mid-slide. */
  let relayoutTimer = 0;
  function relayoutSoon() {
    clearTimeout(relayoutTimer);
    relayoutTimer = window.setTimeout(() => crew.layout.setAspect(cam.layoutAspect(), crew.layout.tall), 450);
  }
  const ro = new ResizeObserver(resize);
  ro.observe(mount);
  resize();

  /* ---------------------------------------------------------------- lights */
  function gatherLights(now: number, sunAmt: number): Light[] {
    const L: Light[] = [];
    const night = 1 - sunAmt;
    for (const b of crew.layout.blocks.values()) {
      if (b.alpha <= 0) continue;
      const bx = Math.round(b.x), by = Math.round(b.y);
      // a warm pendant pool over every desk, and one soft wash over the pod (cool glass light in the cloud-room)
      const cloud = b.zone === "cloud";
      L.push({ x: bx + b.w / 2, y: by + 46 + (b.h - POD_H) / 2, r: Math.max(56, Math.max(b.w, b.h) * 0.62), cut: 0.32 * night, color: cloud ? C.cyan3 : C.gold2, glow: (cloud || b.agent === "commandcode" || b.agent === "cursor" ? 0.035 : 0.06) * night, flat: 0.55 });
      for (const st of b.stations) {
        if (st.hot) continue;
        L.push({ x: bx + Math.round(st.x) + DESK_W / 2, y: deskTop(b, st) + 14, r: 34, cut: 0.42 * night, color: C.gold3, glow: 0.07 * night, flat: 0.6 });
      }
    }
    for (const d of crew.layout.decor) {
      if (d.kind === "lounge") L.push({ x: d.x + d.w - 4, y: d.y + 40, r: 40, cut: 0.5 * night, color: C.gold3, glow: 0.12 * night, flat: 0.6 });
      if (d.kind === "arcade") L.push({ x: d.x + d.w / 2, y: d.y + 34, r: 30, cut: 0.35 * night, color: C.plum3, glow: 0.16 * night, flat: 0.7 });
    }
    for (const w of crew.workers.values()) {
      if (w.gone || w.leaving) continue;
      const scr = crew.screenOf(w, now);
      const glow = P.screenGlow(scr, w.agent);
      if (!glow) continue;
      const m = crew.monitorPos(w);
      const main = w.seat.kind === "main";
      const flick = scr === "bash" || scr === "edit" ? 0.92 + 0.08 * Math.sin(now * 0.02 + w.seed) : 1;
      if (main) {
        L.push({ x: m.x + 12, y: m.y + 8, r: 34, cut: 0.85 * flick, color: glow, glow: (0.24 + 0.12 * night) * flick });
        L.push({ x: w.seat.deskX + DESK_W / 2, y: w.seat.deskY + 18, r: 30, cut: 0.6, color: glow, glow: (0.14 + 0.08 * night) * flick, flat: 0.8 });
      } else if (w.seat.kind === "intern") {
        L.push({ x: m.x + 5, y: m.y + 4, r: 18, cut: 0.6, color: glow, glow: 0.12 + 0.08 * night });
      }
      if (main && w.trinkets.includes("lamp")) {
        const lx = w.seat.deskX + 33;
        L.push({ x: lx, y: w.seat.deskY + 6, r: 30, cut: 0.8 * night + 0.1, color: C.gold3, glow: 0.18 });
      }
      if (main && w.trinkets.includes("lava")) {
        const lx = w.seat.deskX + 31;
        L.push({ x: lx, y: w.seat.deskY + 4, r: 14, cut: 0.4, color: C.pink, glow: 0.2 });
      }
      if (w.show?.kind === "alarm") {
        const on = Math.floor(now / 160) % 2 === 0;
        L.push({ x: w.seat.deskX + 32, y: w.seat.deskY + 2, r: 40, cut: 0.6, color: C.red3, glow: on ? 0.5 : 0.18 });
      }
      if (w.needsHuman && w.act === "waiting") {
        const p = 0.5 + 0.5 * Math.sin(now * 0.008);
        L.push({ x: w.x, y: w.y + 1, r: 24, cut: 0.5, color: brandInk(w.agent), glow: 0.18 + 0.32 * p, flat: 0.45 });
        const h = crew.headPos(w);
        L.push({ x: h.x + 8, y: h.y - 10, r: 18, cut: 0.6, color: brandInk(w.agent), glow: 0.2 + 0.25 * p });
      }
      if (w.show?.kind === "flip") {
        const t = now - w.show.t0;
        if (t > 600 && t < 900) L.push({ x: m.x + 12, y: m.y + 6, r: 50, cut: 1, color: C.gold3, glow: 0.6 * (1 - (t - 600) / 300) });
      }
      if (crew.selected === w.id) {
        L.push({ x: w.x, y: w.y - 8, r: 26, cut: 0.6, color: brandInk(w.agent), glow: 0.16 + 0.06 * Math.sin(now * 0.006) });
      }
      if (w.show?.kind === "cheer") {
        const t = now - w.show.t0;
        if (t < 700) L.push({ x: w.x, y: w.y - 20, r: 44, cut: 0.8, color: brandInk(w.agent), glow: 0.4 * (1 - t / 700) });
      }
    }
    // the room
    const tv = plan.tv;
    const shouting = crew.board.shouts.length && now - crew.board.shouts[crew.board.shouts.length - 1].t0 < R.SHOUT_MS;
    L.push({ x: tv.x + tv.w / 2, y: tv.y + tv.h / 2 + 8, r: 54, cut: 0.6, color: shouting ? C.red3 : C.blue4, glow: shouting ? 0.12 + 0.05 * Math.sin(now * 0.01) : 0.07 });
    L.push({ x: plan.rack.x + 10, y: plan.rack.y - 26, r: 24, cut: 0.4, color: C.green4, glow: 0.06 + crew.activity() * 0.12 });
    L.push({ x: plan.coffee.x + 9, y: plan.coffee.y - 18, r: 14, cut: 0.4, color: C.green4, glow: 0.05 });
    L.push({ x: plan.clock.x, y: plan.clock.y, r: 14, cut: 0.25 });
    // moonlight under the windows
    if (night > 0.3) for (const w of plan.windows) if (w.x < crew.layout.main.x + crew.layout.main.w) L.push({ x: w.x + w.w / 2, y: WALL_H + 16, r: Math.max(24, w.w * 0.7), cut: 0.18 * night, color: C.blue5, glow: 0.035 * night, flat: 0.35 });
    const op = crew.elevator.open;
    if (op > 0.02) L.push({ x: plan.elevator.doorX, y: WALL_H - 6, r: 44, cut: 0.85 * op, color: C.gold3, glow: 0.22 * op, flat: 0.8 });
    L.push({ x: plan.elevator.doorX, y: WALL_H - P.ELEV_H - 6, r: 12, cut: 0.4, color: C.red3, glow: 0.08 });
    return L;
  }

  /* ---------------------------------------------------------------- render */
  function hourNow() {
    if (hourOverride != null) return hourOverride;
    return cityHour(city);
  }

  /** The floor-level layer every frame: each pod's rug and sign. */
  function drawPods(wg: CanvasRenderingContext2D) {
    for (const b of crew.layout.blocks.values()) {
      if (b.alpha <= 0) continue;
      const bm = R.podBitmap(b);
      wg.globalAlpha = b.alpha;
      wg.drawImage(bm.c, Math.round(b.x) - R.POD_BM_PAD, Math.round(b.y) - R.POD_BM_PAD);
    }
    wg.globalAlpha = 1;
  }

  function decorCalls(calls: DrawCall[]) {
    for (const d of crew.layout.decor) {
      const { bm, oy } = P.decorBitmap(d.kind, d.w, d.seed);
      calls.push({ y: d.y + 58, fn: (g) => g.drawImage(bm.c, d.x - 4, d.y - oy + 10) });
    }
  }

  function renderWorld(now: number) {
    const st = skyAt(hourNow());
    const wg = world.g;
    wg.setTransform(1, 0, 0, 1, 0, 0);
    wg.globalAlpha = 1;
    wg.globalCompositeOperation = "source-over";
    wg.clearRect(0, 0, size.w, size.h);
    wg.translate(-origin.x, -origin.y);
    const pan = (cam.x - (room.x + room.w / 2)) * 1;
    sky.draw(wg, plan.windows, room, WIN_TOP, WIN_H, st, now, pan, weather ?? weatherToday(city), plan.vista);
    wg.drawImage(staticLayer.c, origin.x, origin.y);
    const y1 = room.y + room.h;
    wg.fillStyle = "#2f343b"; wg.fillRect(room.x, y1, room.w, 6);
    wg.fillStyle = C.wood4; wg.fillRect(room.x, y1, room.w, 1);
    wg.fillStyle = C.wood1; wg.fillRect(room.x, y1 + 4, room.w, 2);
    wg.fillStyle = rgba(C.ink, 0.5); wg.fillRect(room.x + 3, y1 + 6, room.w - 6, 3);
    wg.fillStyle = C.ink3; wg.fillRect(room.x - 2, 0, 2, y1 + 6); wg.fillRect(room.x + room.w, 0, 2, y1 + 6);
    wg.fillStyle = C.ink3; wg.fillRect(room.x - 2, -3, room.w + 4, 3);
    // the wall clock shows the city's time: a Date shifted by its UTC offset, read through its UTC fields
    R.drawLive(wg, plan, now, cityDate(city), crew.board, crew.activity());
    const el = plan.elevator;
    if (crew.elevator.open > 0.01) P.elevatorInside(wg, el.x, el.y);
    P.elevatorDoors(wg, el.x, el.y, crew.elevator.open, now, now - crew.elevator.ding < 1600 ? 1 : 0);
    const slant = clamp((12.5 - st.hour) / 7, -1, 1) * 0.6;
    const sunCol = st.hour < 8.5 || st.hour > 16.5 ? C.gold3 : C.gold4;
    for (const w of plan.windows) {
      const len = w.y < 10 ? 70 : 58;
      shaft(wg, w.x + 2, WALL_H, w.w - 4, len, slant, sunCol, 0.11 * st.sun);
      if (st.sun < 0.3 && st.stars > 0.3) shaft(wg, w.x + 2, WALL_H, w.w - 4, 34, slant * 0.5, C.blue5, 0.035 * st.stars);
    }
    drawPods(wg);
    const calls: DrawCall[] = [];
    const over: DrawCall[] = [];
    crew.draw(calls, over, now);
    decorCalls(calls);
    visitors.draw(calls, now);
    kicker.draw(calls, now);
    calls.sort((a, b) => a.y - b.y);
    for (const c of calls) c.fn(wg);
    const lights = gatherLights(now, st.sun);
    const holes = plan.windows;
    lighting.apply(wg, origin, size, st.dark * NIGHT_K * (1 - sky.flash * 0.45), NIGHT, lights, holes, { x: room.x - 2, y: room.y - 3, w: room.w + 4, h: room.h + 12 });
    crew.fx.drawDust(wg, Math.max(st.sun * 0.9, 0.15));
    over.sort((a, b) => a.y - b.y);
    for (const c of over) c.fn(wg);
    crew.fx.draw(wg, now);
    return st;
  }

  function background() {
    if (bg && bg.w === canvas.width && bg.h === canvas.height) return bg;
    bg = bitmap(canvas.width, canvas.height);
    const b = bg.g;
    const grad = b.createRadialGradient(bg.w / 2, bg.h * 0.45, 10, bg.w / 2, bg.h / 2, Math.hypot(bg.w, bg.h) * 0.6);
    grad.addColorStop(0, "#1a1730");
    grad.addColorStop(1, VOID);
    b.fillStyle = grad;
    b.fillRect(0, 0, bg.w, bg.h);
    // faint dot grid, the void is a blueprint
    const step = Math.round(24 * dpr);
    b.fillStyle = "rgba(255,255,255,0.035)";
    for (let y = step / 2; y < bg.h; y += step) for (let x = step / 2; x < bg.w; x += step) b.fillRect(Math.round(x), Math.round(y), Math.max(1, Math.round(dpr)), Math.max(1, Math.round(dpr)));
    return bg;
  }

  /** Nearest-neighbour upscale to an integer factor, then one smooth step to the exact zoom. */
  function blit(shakeX: number, shakeY: number) {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
    g.drawImage(background().c, 0, 0);
    const z = cam.z;
    const vx0 = cam.x - cam.vw / 2 / z, vy0 = cam.y - cam.vh / 2 / z;
    // visible part of the buffer, in buffer px
    let sx = Math.floor(vx0 - origin.x) - 1, sy = Math.floor(vy0 - origin.y) - 1;
    let sw = Math.ceil(cam.vw / z) + 3, sh = Math.ceil(cam.vh / z) + 3;
    if (sx < 0) { sw += sx; sx = 0; }
    if (sy < 0) { sh += sy; sy = 0; }
    sw = Math.min(sw, size.w - sx);
    sh = Math.min(sh, size.h - sy);
    if (sw <= 0 || sh <= 0) return;
    const dx = (sx + origin.x - vx0) * z + shakeX, dy = (sy + origin.y - vy0) * z + shakeY;
    const k = Math.ceil(z - 1e-3);
    if (Math.abs(z - Math.round(z)) < 0.01) {
      g.imageSmoothingEnabled = false;
      g.drawImage(world.c, sx, sy, sw, sh, Math.round(dx), Math.round(dy), sw * Math.round(z), sh * Math.round(z));
      return;
    }
    const iw = sw * k, ih = sh * k;
    if (inter.w < iw || inter.h < ih) inter = bitmap(Math.max(iw, inter.w), Math.max(ih, inter.h));
    inter.g.imageSmoothingEnabled = false;
    inter.g.clearRect(0, 0, iw, ih);
    inter.g.drawImage(world.c, sx, sy, sw, sh, 0, 0, iw, ih);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "low";
    g.drawImage(inter.c, 0, 0, iw, ih, dx, dy, sw * z, sh * z);
    g.imageSmoothingEnabled = false;
  }

  /* ------------------------------------------------------------------ loop */
  let raf = 0;
  let last = 0;
  let fps = 60;
  let drawMs = 0;
  let shake = 0;
  let running = true;
  let destroyed = false;
  /* The table flip is the moment people record: a short hit-stop at impact, a red pulse at the
   * edges, and (when the camera is on auto) a quick punch-in on the flipper, then back out. */
  let hitstop = 0;
  let pulseAt = -1e9;
  let cut: { id: string; until: number; caption: string; zoom: number } | null = null;
  let lastCut = -1e9;
  const CUT_MS = 2600;
  /* Director mode (stream mode): more moments get a cut, framed by letterbox bars and a caption. */
  let director = false;
  let bars = 0;
  let captionShown: { text: string; agent: string } | null = null;

  function frame(ts: number) {
    raf = 0;
    if (destroyed) return;
    const dt = last ? clamp(ts - last, 0, 50) : 16;
    last = ts;
    fps = fps * 0.95 + (1000 / Math.max(1, dt)) * 0.05;
    // Hit-stop: the world holds still for a beat at the moment of impact.
    const dtw = hitstop > 0 ? 0 : dt;
    hitstop = Math.max(0, hitstop - dt);
    clock += dtw;
    const t0 = performance.now();
    if (crew.layout.version !== layoutVersion) rebuild();
    crew.update(dtw);
    if (crew.layout.version !== layoutVersion) rebuild();
    crew.showFx(clock, (amt) => {
      shake = Math.max(shake, amt);
      if (amt > 6) {
        hitstop = 90;
        pulseAt = performance.now();
      }
    });
    // a side panel is open (inspector, session, settings): no punch-ins on other people's moments
    const panelOpen = !director && (cam.overlay.left > 0 || cam.overlay.right > 0 || cam.overlay.bottom > 0);
    if (!cut && cam.mode === "auto" && !panelOpen && clock - lastCut > (director ? 5000 : 7000)) {
      const c = nextCut();
      if (c) {
        cut = c;
        lastCut = clock;
        // the bitmap font is ASCII (plus the kaomoji): emoji and dashes are dropped from the caption
        captionShown = { text: R.asciiOnly(c.caption.replace(/—/g, "-")), agent: crew.workers.get(c.id)?.agent ?? "claude" };
      }
    }
    if (cut && (cam.mode !== "auto" || panelOpen || clock > cut.until || !crew.workers.has(cut.id))) cut = null;
    bars = clamp(bars + (cut && director ? 1 : -1) * dt / 350, 0, 1);
    visitors.update(dtw, clock);
    kicker.update(dtw, clock, crew.layout.main, city === "rio");
    // camera
    if (clock - insetCheck > 1000) {
      insetCheck = clock;
      readCssInsets();
      // moving the window to another screen changes DPR without a resize
      if (Math.min(window.devicePixelRatio || 1, MAX_DPR) !== lastDpr) resize();
    }
    cam.bounds = room;
    cam.minZ = Math.max(0.5, cam.fitZoom(room) * 0.8);
    if (cam.mode === "auto" && cut) {
      const w = crew.workers.get(cut.id)!;
      const fitZ = cam.fitZoom(room);
      cam.tz = whole(clamp(fitZ * cut.zoom, fitZ, 12 * dpr));
      cam.follow(w.seat.x, w.seat.deskY + 12);
      // keep the room filling the frame: a worker by the wall shouldn't put the void in shot
      const hw = cam.vw / 2 / cam.tz, hh = cam.vh / 2 / cam.tz;
      if (room.w > hw * 2) cam.tx = clamp(cam.tx, room.x + hw - 8, room.x + room.w - hw + 8);
      if (room.h > hh * 2) cam.ty = clamp(cam.ty, room.y + hh - 8, room.y + room.h - hh + 8);
    } else if (cam.mode === "auto") cam.fit(room, podSpan());
    else if (cam.mode === "follow" && cam.followId) {
      const w = crew.workers.get(cam.followId);
      if (w) cam.follow(w.x, w.y - 14);
      else cam.reset();
    }
    cam.update(dt);
    shake = Math.max(0, shake - dt * 0.03);
    const sAmt = shake * dpr;
    const shx = sAmt ? Math.round(Math.sin(clock * 0.09) * sAmt) : 0;
    const shy = sAmt ? Math.round(Math.cos(clock * 0.11) * sAmt * 0.7) : 0;
    renderWorld(clock);
    blit(shx, shy);
    redPulse();
    labelBoxes = drawLabels(g, crew, cam, { dpr, now: clock });
    letterbox();
    if (crtOn) crt.apply(g, canvas, dpr, clock);
    drawMs = drawMs * 0.9 + (performance.now() - t0) * 0.1;
    if (running) raf = requestAnimationFrame(frame);
  }

  /** The moment worth cutting to right now, if any: a flip always; in director mode also shouts. */
  function nextCut(): { id: string; until: number; caption: string; zoom: number } | null {
    for (const w of crew.workers.values()) {
      if (w.leaving || w.gone) continue;
      const who = `${w.project} · ${BRAND[w.agent]?.name ?? w.agent}`;
      if (w.show?.kind === "flip" && clock - w.show.t0 < 400) {
        return { id: w.id, until: clock + CUT_MS, zoom: 1.75, caption: `${who} flipped a table${w.flipReason ? ` — "${w.flipReason}"` : ""}` };
      }
      if (!director) continue;
      if (clock - w.shoutAt < 300) {
        const last = crew.board.shouts[crew.board.shouts.length - 1];
        return { id: w.id, until: clock + CUT_MS, zoom: 1.6, caption: `${who}: ${last?.text ?? "shouted"}` };
      }
    }
    return null;
  }

  /** Cinema bars and the moment's caption while director mode holds a cut. */
  function letterbox() {
    if (bars <= 0) return;
    const W = canvas.width, H = canvas.height;
    const k = bars * bars * (3 - 2 * bars);
    const bh = Math.round(H * 0.08 * k);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.fillStyle = "#000";
    g.fillRect(0, 0, W, bh);
    g.fillRect(0, H - bh, W, bh);
    if (!captionShown || bh < 14 * dpr) return;
    const fs = Math.max(1, Math.round(Math.min(bh * 0.42 / 8, 3 * dpr)));
    const text = fit(FONT(), captionShown.text, Math.floor((W * 0.8) / fs));
    const tb = textBitmap(FONT(), text, "#f4f1ea");
    const lw = 9 * fs;
    const total = lw + 4 * fs + tb.w * fs;
    const x = Math.round((W - total) / 2), y = Math.round(H - bh / 2 - 4 * fs);
    g.globalAlpha = k;
    drawMark(g, captionShown.agent as Parameters<typeof drawMark>[1], x, y - fs, lw, BRAND[captionShown.agent as keyof typeof BRAND]?.color ?? "#fff");
    g.drawImage(tb.c, x + lw + 4 * fs, y, tb.w * fs, tb.h * fs);
    g.globalAlpha = 1;
  }

  /** A red vignette that flares at a flip's impact and fades in about half a second. */
  function redPulse() {
    const k = 1 - (performance.now() - pulseAt) / 650;
    if (k <= 0) return;
    const W = canvas.width, H = canvas.height;
    const grad = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.32, W / 2, H / 2, Math.hypot(W, H) * 0.6);
    grad.addColorStop(0, "rgba(255,40,40,0)");
    grad.addColorStop(1, `rgba(255,40,40,${(0.38 * k * k).toFixed(3)})`);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
  }

  function start() {
    if (!raf && running && !destroyed) { last = 0; raf = requestAnimationFrame(frame); }
  }
  function onVis() {
    if (document.hidden) {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    } else {
      running = true;
      start();
    }
  }
  document.addEventListener("visibilitychange", onVis);

  /* ----------------------------------------------------------------- input */
  const pointers = new Map<number, { x: number; y: number }>();
  let downAt: { x: number; y: number } | null = null;
  let moved = false;
  let pinch: { d: number; mx: number; my: number; z0: number } | null = null;
  /** The last tap (touch): a second one close by and soon after puts the camera back on auto. */
  let lastTap: { x: number; y: number; t: number } | null = null;
  let wheelSettle = 0;
  /** The zoom a run of wheel events started from (null between runs). */
  let wheelZ0: number | null = null;
  const devXY = (e: { clientX: number; clientY: number }) => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * dpr, y: (e.clientY - r.top) * dpr };
  };
  function pickAt(x: number, y: number): string | null {
    for (const b of labelBoxes) if (b.id && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b.id;
    const [wx, wy] = cam.toWorld(x, y);
    return crew.hit(wx, wy);
  }
  function onWheel(e: WheelEvent) {
    // a page that scrolls keeps its wheel; a trackpad pinch (ctrl+wheel) still zooms the office
    if (!e.ctrlKey && pageScrolls()) return;
    e.preventDefault();
    const p = devXY(e);
    const k = e.ctrlKey ? 0.012 : 0.0016;
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    wheelZ0 ??= cam.tz;
    cam.zoomAt(p.x, p.y, Math.exp(-dy * k));
    clearTimeout(wheelSettle);
    wheelSettle = window.setTimeout(() => {
      cam.settle(p.x, p.y, wheelZ0 ?? cam.tz);
      wheelZ0 = null;
    }, 220);
  }
  function onDown(e: PointerEvent) {
    canvas.setPointerCapture?.(e.pointerId);
    const p = devXY(e);
    pointers.set(e.pointerId, p);
    if (pointers.size === 1) {
      downAt = p;
      moved = false;
      // a tap has no hover first: the chrome hears about the worker now, a beat before the click
      if (e.pointerType !== "mouse") hoverCb?.(pickAt(p.x, p.y));
    }
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, z0: cam.tz };
      moved = true;
    }
  }
  function onMove(e: PointerEvent) {
    const p = devXY(e);
    const prev = pointers.get(e.pointerId);
    if (!prev) {
      const id = pickAt(p.x, p.y);
      if (id !== crew.hovered) hoverCb?.(id);
      crew.hovered = id;
      canvas.style.cursor = id ? "pointer" : "grab";
      return;
    }
    pointers.set(e.pointerId, p);
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      cam.panBy(mx - pinch.mx, my - pinch.my);
      cam.zoomAt(mx, my, d / Math.max(1, pinch.d));
      pinch = { ...pinch, d, mx, my };
      return;
    }
    if (downAt && !moved && Math.hypot(p.x - downAt.x, p.y - downAt.y) > 4 * dpr) moved = true;
    if (moved) {
      cam.panBy(p.x - prev.x, p.y - prev.y);
      canvas.style.cursor = "grabbing";
    }
  }
  function onUp(e: PointerEvent) {
    const p = devXY(e);
    pointers.delete(e.pointerId);
    if (pinch && pointers.size < 2) {
      cam.settle(pinch.mx, pinch.my, pinch.z0);
      pinch = null;
    }
    if (pointers.size === 0) {
      // a cancelled pointer is the browser taking the gesture (a page scroll): not a tap
      if (downAt && !moved && e.type !== "pointercancel") {
        const t = performance.now();
        if (e.pointerType === "touch" && lastTap && t - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 30 * dpr) {
          cam.reset();
          lastTap = null;
        } else {
          const id = pickAt(p.x, p.y);
          crew.selected = id;
          selectCb?.(id);
          lastTap = { x: p.x, y: p.y, t };
        }
      }
      downAt = null;
      canvas.style.cursor = "grab";
    }
  }
  function onLeave() {
    crew.hovered = null;
  }
  function onDbl(e: MouseEvent) {
    e.preventDefault();
    cam.reset();
  }
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("dblclick", onDbl);
  canvas.style.cursor = "grab";

  start();

  const scene: OfficeSceneExtras = {
    canvas,
    load(snapshot: Snapshot) {
      crew.load(snapshot);
      if (crew.selected && !crew.workers.has(crew.selected)) crew.selected = null;
    },
    apply(event: OfficeEvent) {
      const was = event.replaces;
      crew.apply(event);
      // a hired worker renamed to its real session: the camera keeps following it
      if (was && cam.followId === was && crew.workers.has(event.workerId)) cam.followId = event.workerId;
      if (was && cut?.id === was) cut = { ...cut, id: event.workerId };
    },
    setCrt(on: boolean) {
      crtOn = !!on;
    },
    setDirector(on: boolean) {
      director = !!on;
    },
    onSelect(cb) {
      selectCb = cb;
    },
    onHover(cb) {
      hoverCb = cb;
    },
    select(id: string | null) {
      crew.selected = id && crew.workers.has(id) ? id : null;
      // letting go of a followed worker goes back to the whole office
      if (!crew.selected && cam.mode === "follow") cam.reset();
    },
    focus(id: string) {
      const w = crew.workers.get(id);
      if (!w) return;
      cam.mode = "follow";
      cam.followId = id;
      // close enough to see the pod and its interns, not just one face
      const fitZ = cam.fitZoom(room);
      cam.tz = whole(clamp(Math.max(cam.tz, fitZ * 1.8), fitZ, 12 * dpr));
    },
    destroy() {
      destroyed = true;
      clearTimeout(relayoutTimer);
      clearTimeout(wheelSettle);
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      canvas.remove();
    },
    setHour(h: number | null) {
      hourOverride = h;
    },
    setWeather(w: Weather | null) {
      weather = w;
    },
    setCity(id: CityId) {
      if (id === city) return;
      city = cityOf(id).id;
      sky.city = city;
      // the clock's plate is in the static layer
      layoutVersion = -1;
    },
    getCity() {
      return city;
    },
    previewCity(id: CityId, w: number, h: number) {
      return postcard(id, w, h);
    },
    setInsets(i: Partial<Insets>, overlay?: Partial<Insets>) {
      insetsFromApi = true;
      const before = cam.layoutAspect();
      cam.insets = { ...cam.insets, ...i };
      cam.overlay = { top: 0, right: 0, bottom: 0, left: 0, ...overlay };
      if (Math.abs(cam.layoutAspect() - before) > 1e-3) relayoutSoon();
    },
    view(x: number, y: number, zoom: number, snap = true) {
      cam.mode = "manual";
      cam.followId = null;
      cam.tx = x; cam.ty = y; cam.tz = zoom;
      if (snap) { cam.x = x; cam.y = y; cam.z = zoom; }
    },
    workerAt(id: string) {
      const w = crew.workers.get(id);
      return w ? { x: w.x, y: w.y } : null;
    },
    stats() {
      return { fps: Math.round(fps), workers: crew.workers.size, particles: crew.fx.ps.length, drawMs: Math.round(drawMs * 10) / 10 };
    },
  };
  return scene;
}
