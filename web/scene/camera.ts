/*
 * The camera: a world point at the centre of the canvas plus a zoom in device
 * pixels per art pixel. Auto mode keeps the whole room framed as it grows,
 * resting on a whole zoom when that only trims margins, so pixels stay crisp;
 * any wheel, pinch or drag switches to manual (within the floor plan, and
 * easing back to a whole zoom when the gesture ends); focus() flies to a
 * worker and keeps following it until the user takes over. Motion is
 * critically damped.
 */
import { clamp } from "./util.ts";

export interface Insets { top: number; right: number; bottom: number; left: number }
interface Box { x: number; y: number; w: number; h: number }

/** A crisp crop may trim this much room (art px): the side floor, the ceiling trim, the floor under the last row. */
const TRIM = { x: 10, top: 4, bottom: 10 };
/** How far past the room's edge a drag may go, in CSS px. */
const SLACK = 12;
export const MAX_ZOOM = 16;

export class Camera {
  x = 0;
  y = 0;
  z = 3;
  tx = 0;
  ty = 0;
  tz = 3;
  mode: "auto" | "manual" | "follow" = "auto";
  followId: string | null = null;
  /** canvas size in device px */
  vw = 1;
  vh = 1;
  /** CSS px insets (UI panels), scaled by dpr when fitting */
  insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  /** Panels that come and go with a selection: framed around, never laid out for. */
  overlay: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  dpr = 1;
  /** The floor plan: pans, pinches and follows stay over it. */
  bounds: Box | null = null;
  /** The farthest out a pinch or wheel goes (set a little under the auto fit). */
  minZ = 0.8;
  private snapped = false;

  /** The part of the canvas no UI panel covers, in device px. */
  private free(withOverlay = true) {
    const side = (k: keyof Insets) => (withOverlay ? Math.max(this.insets[k], this.overlay[k]) : this.insets[k]) * this.dpr;
    const il = side("left"), ir = side("right"), it = side("top"), ib = side("bottom");
    const aw = Math.max(50, this.vw - il - ir), ah = Math.max(50, this.vh - it - ib);
    return { aw, ah, cx: il + aw / 2, cy: it + ah / 2 };
  }

  /** Width / height of the area no panel covers. */
  freeAspect() {
    const { aw, ah } = this.free();
    return aw / ah;
  }

  /** The shape the office is packed for: the free area without the selection's panels. */
  layoutAspect() {
    const { aw, ah } = this.free(false);
    return aw / ah;
  }

  /** Zoom that frames the whole room in the free area. */
  fitZoom(room: { w: number; h: number }) {
    const pad = 10;
    const { aw, ah } = this.free();
    return clamp(Math.min(aw / (room.w + pad * 2), ah / (room.h + pad * 2)), 0.5, 14);
  }

  /**
   * Frame the room. On a screen narrower than the room (a phone held upright)
   * the empty floor at the sides is cropped, never the pods (`core`, their
   * x extent), so a small office fills the screen instead of a thin strip.
   * The zoom then settles on a whole number of device px per art px: one up
   * if only TRIM's margins leave the frame, else one down if that loses
   * little, so the art is drawn without the soft resampling step.
   */
  fit(room: { x: number; y: number; w: number; h: number }, core?: { x0: number; x1: number }) {
    const { aw, ah, cx: cxs, cy: cys } = this.free();
    const whole = room;
    if (core) {
      const pad = 10;
      const want = (aw / ah) * (room.h + pad * 2) - pad * 2;
      const w = clamp(want, core.x1 - core.x0, room.w);
      if (w < room.w - 1) {
        const mid = clamp((core.x0 + core.x1) / 2, room.x + w / 2, room.x + room.w - w / 2);
        room = { x: mid - w / 2, y: room.y, w, h: room.h };
      }
    }
    let z = this.fitZoom(room);
    const keep = { x: room.x + TRIM.x, y: room.y + TRIM.top, w: room.w - TRIM.x * 2, h: room.h - TRIM.top - TRIM.bottom };
    const up = Math.ceil(z - 1e-3), down = Math.floor(z + 1e-3);
    if (up * keep.w <= aw && up * keep.h <= ah && up <= 14) z = up;
    else if (down >= 1 && down >= z * 0.86) z = down;
    this.tz = z;
    // centre the whole room in the free area as far as `keep` stays in frame
    // (so a crop takes a sliver off both sides, and more off the floor than the wall)
    const hw = aw / 2 / z, hh = ah / 2 / z;
    let mx = whole.x + whole.w / 2, my = room.y + room.h / 2;
    if (hw * 2 < whole.w) mx = clamp(mx, keep.x + keep.w - hw, keep.x + hw);
    if (hh * 2 < room.h) my = clamp(my, keep.y + keep.h - hh, keep.y + hh);
    this.tx = mx - (cxs - this.vw / 2) / z;
    this.ty = my - (cys - this.vh / 2) / z;
    if (!this.snapped) {
      this.x = this.tx; this.y = this.ty; this.z = this.tz;
      this.snapped = true;
    }
  }

  get minZoom() {
    return this.minZ;
  }

  follow(x: number, y: number, zoom?: number) {
    if (zoom) this.tz = zoom;
    const { cx, cy } = this.free();
    this.tx = x - (cx - this.vw / 2) / this.tz;
    this.ty = y - (cy - this.vh / 2) / this.tz;
  }

  update(dt: number) {
    if (this.mode !== "auto") [this.tx, this.ty] = this.within(this.tx, this.ty, this.tz);
    const k = 1 - Math.exp(-dt / 1000 * (this.mode === "manual" ? 14 : 5));
    // zoom in log space so it feels even
    const lz = Math.log(this.z), ltz = Math.log(this.tz);
    this.z = Math.exp(lz + (ltz - lz) * k);
    this.x += (this.tx - this.x) * k;
    this.y += (this.ty - this.y) * k;
    // land exactly, so a whole zoom is drawn with the crisp blit
    if (Math.abs(this.z - this.tz) < 0.004) this.z = this.tz;
  }

  toScreen(wx: number, wy: number): [number, number] {
    return [(wx - this.x) * this.z + this.vw / 2, (wy - this.y) * this.z + this.vh / 2];
  }

  toWorld(sx: number, sy: number): [number, number] {
    return [(sx - this.vw / 2) / this.z + this.x, (sy - this.vh / 2) / this.z + this.y];
  }

  /** Zoom by `f` keeping the world point under (sx, sy) still. */
  zoomAt(sx: number, sy: number, f: number) {
    this.mode = "manual";
    this.followId = null;
    this.zoomTo(sx, sy, clamp(this.tz * f, this.minZ, MAX_ZOOM));
  }

  /**
   * After a pinch or a wheel zoom that started at zoom `from`: ease on to the
   * next whole zoom the way it was going, about (sx, sy), so the gesture ends
   * crisp and even one wheel notch always takes a step.
   */
  settle(sx: number, sy: number, from = this.tz) {
    if (this.mode !== "manual" || this.tz < 1) return;
    const dir = this.tz - from;
    const k = dir > 1e-3 ? Math.ceil(this.tz - 1e-3) : dir < -1e-3 ? Math.floor(this.tz + 1e-3) : Math.round(this.tz);
    const nz = clamp(k, Math.max(1, Math.ceil(this.minZ - 1e-3)), MAX_ZOOM);
    if (Math.abs(nz - this.tz) > 1e-3) this.zoomTo(sx, sy, nz);
  }

  private zoomTo(sx: number, sy: number, nz: number) {
    const [wx, wy] = [(sx - this.vw / 2) / this.tz + this.tx, (sy - this.vh / 2) / this.tz + this.ty];
    this.tz = nz;
    [this.tx, this.ty] = this.within(wx - (sx - this.vw / 2) / nz, wy - (sy - this.vh / 2) / nz, nz);
  }

  /**
   * Drag the view by device px. With the whole office already in frame there
   * is nothing to drag to, and the camera stays on auto (so it keeps framing
   * the office as it grows) instead of freezing where the finger left it.
   */
  panBy(dx: number, dy: number) {
    const [tx, ty] = this.within(this.tx - dx / this.tz, this.ty - dy / this.tz, this.tz);
    if (this.mode === "auto" && Math.abs(tx - this.tx) + Math.abs(ty - this.ty) < 0.5 / this.tz) return;
    this.mode = "manual";
    this.followId = null;
    this.tx = tx;
    this.ty = ty;
    // pans should feel attached to the pointer
    [this.x, this.y] = this.within(this.x - dx / this.z, this.y - dy / this.z, this.z);
  }

  /**
   * A camera centre (x, y) at zoom z, moved just enough to keep the floor
   * plan in the free area: a room the view can hold sits centred in it, a
   * bigger one can't be dragged more than SLACK past its edges.
   */
  within(x: number, y: number, z: number): [number, number] {
    const r = this.bounds;
    if (!r) return [x, y];
    const { aw, ah, cx, cy } = this.free();
    const ox = (cx - this.vw / 2) / z, oy = (cy - this.vh / 2) / z;
    const slack = (SLACK * this.dpr) / z;
    const axis = (c: number, lo: number, size: number, half: number) =>
      half * 2 >= size ? lo + size / 2 : clamp(c, lo + half - slack, lo + size - half + slack);
    return [axis(x + ox, r.x, r.w, aw / 2 / z) - ox, axis(y + oy, r.y, r.h, ah / 2 / z) - oy];
  }

  reset() {
    this.mode = "auto";
    this.followId = null;
  }
}
