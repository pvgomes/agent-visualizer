/*
 * The stage: one page that renders the launch video a frame at a time. It
 * owns the virtual clock's two meanings: video time (the frame index the
 * renderer asks for) and world time (vt time, what the office lives on). A
 * cut is a list of shots; each shot says where world time stands when it
 * starts (a jump forward is a cut: the office is fast-forwarded off camera)
 * and how fast it runs (slow motion is world time running slower than video
 * time). Office frames are the real scene (web/scene createOfficeScene) with
 * its camera driven through view(); type and transitions are drawn over it
 * on the same canvas.
 */
import { createOfficeScene, type OfficeSceneExtras } from "../../web/scene/index.ts";
import { Crew } from "../../web/scene/workers.ts";
import { Camera } from "../../web/scene/camera.ts";
import * as R from "../../web/scene/room.ts";
import { World } from "./world.ts";
import { script } from "./script.ts";
import { CUTS } from "./cuts.ts";
import { Bridge } from "./ui/bridge.ts";
import { synth, type Cue } from "./audio.ts";
import { bandGeo, drawBand, loadFonts, type Feature } from "./band.ts";

declare const __vt: {
  now: number;
  advance(t: number): void;
  raf(t: number): void;
  settle(n?: number): Promise<void>;
  syncAnimations(doc: Document | null | undefined): void;
  install(w: Window): void;
  uninstall(w: Window): void;
};

export interface View { x: number; y: number; z: number }
export interface Rect { x: number; y: number; w: number; h: number }

export interface Shot {
  name: string;
  /** Video seconds. */
  dur: number;
  /** World ms when the shot starts (jumping forward if needed). Omitted: world time carries on. */
  at?: number | ((e: Engine) => number);
  /** World speed at shot-local video time lt (1 = real time). Omitted: frozen for non-office shots, 1 otherwise. */
  speed?: (lt: number) => number;
  office?: boolean;
  ui?: boolean;
  /** Level of the pulse under this shot (default 1 for office and UI shots, 0 otherwise). */
  bed?: number;
  /** The feature this shot shows: the band names it, and the shot is framed above the band. */
  feature?: Feature;
  enter?(e: Engine): void | Promise<void>;
  /** Before the office renders: camera, triggers. */
  update?(e: Engine, lt: number): void | Promise<void>;
  /** After: draw on the stage (the office is already there for office shots). */
  draw?(e: Engine, g: CanvasRenderingContext2D, lt: number): void;
  /** Drawn above the UI iframe. */
  drawOver?(e: Engine, g: CanvasRenderingContext2D, lt: number): void;
  exit?(e: Engine): void;
}

export interface Cut {
  name: string;
  w: number;
  h: number;
  shots: Shot[];
  /** CSS size the real web app is laid out at in the iframe (default 1600x900). */
  app?: { w: number; h: number };
  /** Named stills to save (video seconds); a shot can set Engine.clip to crop them. */
  stills?: { t: number; name: string }[];
  /** Also write a GIF from every `every`-th frame. */
  gif?: { every: number };
  /** What happens in the office (default: script.ts). */
  script?: (w: World) => void;
}

const q = new URLSearchParams(location.search);
const FPS = Number(q.get("fps") ?? 60);
const cut: Cut = CUTS[q.get("cut") ?? "main"]!;
const W = cut.w, H = cut.h;

// The video's camera operator places the camera with view() every frame, already framed on the floor
// plan; the scene's own clamp for a hand-driven camera (Camera.within, keeping a dragged view on the
// room) would pull each move toward the middle and ease it there. The stage's scene skips it; the
// real app in the iframe is a separate bundle and keeps it.
Camera.prototype.within = function (x: number, y: number) {
  return [x, y];
};

// The office draws at twice its CSS size, so its labels come out at the scale a
// retina screen shows them; the canvas is composited 1:1 into the stage.
Object.defineProperty(window, "devicePixelRatio", { get: () => 2, configurable: true });

const stageEl = document.getElementById("stage") as HTMLCanvasElement;
const overEl = document.getElementById("over") as HTMLCanvasElement;
const mountEl = document.getElementById("office") as HTMLDivElement;
const appEl = document.getElementById("app") as HTMLIFrameElement;
for (const c of [stageEl, overEl]) {
  c.width = W;
  c.height = H;
  c.style.width = `${W}px`;
  c.style.height = `${H}px`;
}
mountEl.style.width = `${W / 2}px`;
mountEl.style.height = `${H / 2}px`;
const g = stageEl.getContext("2d", { alpha: false })!;
const og = overEl.getContext("2d")!;
g.imageSmoothingEnabled = false;
og.imageSmoothingEnabled = false;

export class Engine {
  readonly W = W;
  readonly H = H;
  readonly app = cut.app ?? { w: 1600, h: 900 };
  /** A crop (stage px) for the still taken on this frame. */
  clip: { x: number; y: number; w: number; h: number } | null = null;
  readonly fps = FPS;
  readonly world = new World();
  scene: OfficeSceneExtras | null = null;
  readonly shadow = new Crew(() => __vt.now);
  private shadowVersion = -1;
  readonly cues: Cue[] = [];
  /** Video seconds of the current frame. */
  t = 0;
  shot: Shot | null = null;
  shotStart = 0;
  bridge: Bridge | null = null;
  readonly appEl = appEl;
  readonly g = g;
  readonly og = og;
  /** Stage-level shake (screen px), on top of the office's own. */
  shake = 0;
  private state: Record<string, unknown> = {};
  /** Scratch that outlives a shot (a later shot reading when an earlier one clicked). */
  readonly mem: Record<string, unknown> = {};

  /** The band's height for this frame shape. */
  readonly bandH = bandGeo(W, H).h;
  private bandSince = -1;
  private featureKey = "";
  private featureSince = 0;

  constructor() {
    (cut.script ?? script)(this.world);
    this.world.on((e) => {
      this.scene?.apply(e);
      this.shadow.apply(e);
      // what the state calls a boss whose interns are still at work
      if (e.kind === "idle" && e.summary?.startsWith("supervising")) this.mem.supervising = e.summary;
    });
    this.shadow.layout.setAspect(W / H, W / H < 0.8);
  }

  get wNow() {
    return __vt.now;
  }

  /** Per-shot scratch state. */
  get s(): Record<string, unknown> {
    return this.state;
  }

  mountScene() {
    if (this.scene) return;
    const sc = createOfficeScene(mountEl) as OfficeSceneExtras;
    sc.setHour(21.6);
    sc.setWeather("clear");
    const snap = this.world.state.snapshot();
    sc.load(snap);
    // a scene that opens on a snapshot packs its pods in the snapshot's order: keep the geometry twin in step
    this.shadow.load(snap);
    this.shadowVersion = -1;
    this.scene = sc;
  }

  /* ------------------------------------------------------------ geometry */

  geo() {
    const L = this.shadow.layout;
    const room = L.room();
    const main = { ...L.main };
    const wing = L.wing ? { ...L.wing } : null;
    const plan = R.plan(L.main, L.wing, room);
    return { room, main, wing, plan };
  }

  /** The pods in the cloud wing, as one rect (where they are headed, not where they glide from). */
  cloudPods(): Rect | null {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const b of this.shadow.layout.blocks.values()) {
      if (b.zone !== "cloud") continue;
      x0 = Math.min(x0, b.tx);
      y0 = Math.min(y0, b.ty);
      x1 = Math.max(x1, b.tx + b.w);
      y1 = Math.max(y1, b.ty + 74);
    }
    return Number.isFinite(x0) ? { x: x0, y: y0 - 14, w: x1 - x0, h: y1 - y0 + 14 } : null;
  }

  id(name: string): string {
    return this.world.hands.get(name)!.id;
  }

  /** A worker the shadow crew knows, by a test (hired agents have no name in the world's cast). */
  findWorker(test: (w: { id: string; agent: string; project: string; host?: { kind: string }; intern: boolean }) => boolean) {
    for (const w of this.shadow.workers.values()) if (!w.gone && !w.leaving && test(w)) return { x: w.seat.x, y: w.seat.y, deskX: w.seat.deskX, deskY: w.seat.deskY, id: w.id };
    return null;
  }

  /** A worker's feet, in world px (the scene's own position). */
  at(name: string): { x: number; y: number } {
    const p = this.scene?.workerAt(this.id(name));
    if (p) return p;
    const w = this.shadow.workers.get(this.id(name));
    return w ? { x: w.x, y: w.y } : { x: 0, y: 0 };
  }

  /** Where the worker will sit (its desk), even while it's still walking there. */
  seat(name: string): { x: number; y: number; deskX: number; deskY: number } {
    const w = this.shadow.workers.get(this.id(name));
    if (!w) return { x: 0, y: 0, deskX: 0, deskY: 0 };
    return { x: w.seat.x, y: w.seat.y, deskX: w.seat.deskX, deskY: w.seat.deskY };
  }

  /** The zoom (device px per art px) that frames `r` with `pad` art px around it. */
  fitZoom(r: Rect, pad = 10) {
    return Math.min(W / (r.w + pad * 2), this.regionH / (r.h + pad * 2));
  }

  fit(r: Rect, pad = 10): View {
    return { x: r.x + r.w / 2, y: r.y + r.h / 2, z: this.fitZoom(r, pad) };
  }

  /** The frame's height above the band (all of it when the shot has no feature). */
  get regionH() {
    return this.shot?.feature ? H - this.bandH : H;
  }

  /** Put the camera on `v`, centred in the part of the frame above the band. */
  view(v: View) {
    const off = this.shot?.feature ? this.bandH / 2 / v.z : 0;
    this.scene?.view(v.x, v.y + off, v.z, true);
  }

  cue(kind: Cue["kind"], extra: Partial<Cue> = {}) {
    this.cues.push({ t: this.t, kind, ...extra });
  }

  /* ------------------------------------------------------------- the clock */

  /** Move world time to `to`, in steps the scene can follow (it clamps a frame to 50 ms). */
  async worldTo(to: number, draw = true) {
    const from = __vt.now;
    if (to <= from) return;
    if (to - from > 40) {
      // fast-forward off camera
      for (let w = from + 33; w < to; w += 33) {
        __vt.advance(w);
        this.world.step(w);
        this.shadowTick(33);
        // promise chains (the mock's chat turns, the app's stream reads) move on between steps, as they would in real time
        await __vt.settle(2);
        __vt.raf(w);
      }
    }
    const dt = to - __vt.now;
    __vt.advance(to);
    this.world.step(to);
    this.shadowTick(dt);
    await __vt.settle();
    void draw;
  }

  private shadowTick(dt: number) {
    const L = this.shadow.layout;
    if (L.version !== this.shadowVersion) {
      this.shadowVersion = L.version;
      const room = L.room();
      this.shadow.setElevatorX(R.plan(L.main, L.wing, room).elevator.doorX);
    }
    this.shadow.update(dt);
  }

  /* ------------------------------------------------------------- frames */

  private index = 0;
  private bounds: { shot: Shot; t0: number; t1: number }[] = [];

  async init() {
    await loadFonts();
    let t = 0;
    for (const shot of cut.shots) {
      this.bounds.push({ shot, t0: t, t1: t + shot.dur });
      t += shot.dur;
    }
    return { frames: Math.round(t * FPS), duration: t, w: W, h: H, fps: FPS, shots: this.bounds.map((b) => ({ name: b.shot.name, t0: b.t0, t1: b.t1 })), stills: cut.stills ?? [], gif: cut.gif ?? null };
  }

  async frame(i: number) {
    this.t = i / FPS;
    let b = this.bounds[this.index]!;
    while (this.t >= b.t1 - 1e-9 && this.index < this.bounds.length - 1) b = this.bounds[++this.index]!;
    const lt = this.t - b.t0;
    if (b.shot !== this.shot) {
      this.shot?.exit?.(this);
      this.shot = b.shot;
      this.shotStart = b.t0;
      this.state = {};
      const bed = b.shot.bed ?? (b.shot.office || b.shot.ui ? 1 : 0);
      if (bed > 0) this.cue("bed", { dur: b.shot.dur, level: bed });
      if (b.shot.office) this.mountScene();
      if (b.shot.at !== undefined) await this.worldTo(typeof b.shot.at === "function" ? b.shot.at(this) : b.shot.at);
      await b.shot.enter?.(this);
    } else {
      const sp = b.shot.speed ? b.shot.speed(lt) : b.shot.office || b.shot.ui ? 1 : 0;
      if (sp > 0) await this.worldTo(__vt.now + (1000 / FPS) * sp);
    }
    await b.shot.update?.(this, lt);
    __vt.raf(__vt.now);
    // compose
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.fillStyle = "#06050b";
    g.fillRect(0, 0, W, H);
    if (b.shot.office && this.scene) {
      const sx = this.shake ? Math.round((Math.sin(this.t * 91) * this.shake)) : 0;
      const sy = this.shake ? Math.round((Math.cos(this.t * 77) * this.shake * 0.7)) : 0;
      g.drawImage(this.scene.canvas, sx, sy);
    }
    b.shot.draw?.(this, g, lt);
    og.setTransform(1, 0, 0, 1, 0, 0);
    og.clearRect(0, 0, W, H);
    b.shot.drawOver?.(this, og, lt);
    this.band(og);
    // hidden, not removed from layout: the app's office keeps its size and its last frame between UI shots
    appEl.style.visibility = b.shot.ui ? "visible" : "hidden";
    __vt.syncAnimations(document);
    if (this.bridge?.doc) __vt.syncAnimations(this.bridge.doc);
    return { shot: b.shot.name, world: __vt.now, clip: this.clip };
  }

  /** The feature band over everything, sliding in with the first feature and out after the last. */
  private band(c: CanvasRenderingContext2D) {
    const f = this.shot?.feature;
    if (!f) {
      this.bandSince = -1;
      this.featureKey = "";
      return;
    }
    if (this.bandSince < 0) this.bandSince = this.t;
    if (f.title !== this.featureKey) {
      this.featureKey = f.title;
      this.featureSince = this.t;
      this.cue("tick", { vol: 0.6 });
    }
    drawBand(c, W, H, f, Math.min(1, (this.t - this.bandSince) / 0.3), this.t - this.featureSince);
  }

  async audio(): Promise<string> {
    const total = this.bounds[this.bounds.length - 1]!.t1;
    return synth(this.cues, total);
  }

  /** Open the real web app in the iframe, wired to this world. */
  async openApp(cssW: number, cssH: number, dpr: number) {
    if (!this.bridge) this.bridge = new Bridge(this.world);
    await this.bridge.open(appEl, cssW, cssH, dpr);
  }

  closeApp() {
    this.bridge?.close(appEl);
  }
}

const engine = new Engine();
(window as unknown as { __stage: unknown }).__stage = {
  init: () => engine.init(),
  frame: (i: number) => engine.frame(i),
  audio: () => engine.audio(),
  cues: () => engine.cues,
};
