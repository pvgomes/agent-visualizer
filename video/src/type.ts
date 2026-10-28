/*
 * Kinetic type in the office's own bitmap font (web/scene/font.ts): every
 * glyph is drawn at a whole-number scale with nearest-neighbour sampling, so
 * a 5x7 letter at scale 12 is 60x84 hard-edged pixels, never a blurred one.
 */
import { FONT, drawText, measure } from "../../web/scene/font.ts";
import { pixelLogo, type LogoKind } from "../../web/scene/logos.ts";
import { mark } from "../../web/ui/icons.ts";

export const INK = {
  night: "#0b0a13",
  void: "#0a0d2c",
  white: "#f5f1e8",
  dim: "#8f8aa8",
  claude: "#d97757",
  violet: "#8e75ff",
  cyan: "#7ef6ff",
  amber: "#ffb648",
  red: "#f2625a",
  green: "#52d6a0",
  shadow: "#05040a",
};

export const ease = {
  linear: (t: number) => t,
  outCubic: (t: number) => 1 - Math.pow(1 - t, 3),
  inCubic: (t: number) => t * t * t,
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outQuint: (t: number) => 1 - Math.pow(1 - t, 5),
  inOutQuint: (t: number) => (t < 0.5 ? 16 * t ** 5 : 1 - Math.pow(-2 * t + 2, 5) / 2),
  outExpo: (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  inExpo: (t: number) => (t <= 0 ? 0 : Math.pow(2, 10 * t - 10)),
  inOutExpo: (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2),
  outBack: (t: number) => {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
};

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const ramp = (t: number, a: number, b: number) => clamp((t - a) / (b - a), 0, 1);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Width in screen px of `text` at whole-number `scale`. */
export const textW = (text: string, scale: number) => measure(FONT(), text) * scale;
/** Cap height (7 rows) and full cell (8 rows, with the descender). */
export const CAP = 7;

export interface PxOpts {
  color?: string;
  shadow?: string | null;
  /** Shadow offset in font pixels. */
  depth?: number;
  align?: "left" | "center" | "right";
  /** 0..1: how many characters show (typewriter). */
  reveal?: number;
  alpha?: number;
}

/** Draw `text` with its top-left (or top-centre / top-right) at x, y. Returns the width drawn. */
export function px(g: CanvasRenderingContext2D, text: string, x: number, y: number, scale: number, o: PxOpts = {}): number {
  const s = Math.max(1, Math.round(scale));
  const full = textW(text, s);
  const shown = o.reveal === undefined ? text : [...text].slice(0, Math.round([...text].length * clamp(o.reveal, 0, 1))).join("");
  const x0 = Math.round(o.align === "center" ? x - full / 2 : o.align === "right" ? x - full : x);
  const y0 = Math.round(y);
  g.save();
  g.imageSmoothingEnabled = false;
  g.globalAlpha = o.alpha ?? 1;
  if (o.shadow !== null) {
    const d = (o.depth ?? 1) * s;
    drawText(g, FONT(), shown, x0 + d, y0 + d, o.shadow ?? INK.shadow, s);
  }
  drawText(g, FONT(), shown, x0, y0, o.color ?? INK.white, s);
  g.restore();
  return full;
}

/** Per-letter drop-in: each glyph falls into place `stagger` s after the one before. */
export function dropIn(g: CanvasRenderingContext2D, text: string, x: number, y: number, scale: number, t: number, o: PxOpts & { stagger?: number; dur?: number; rise?: number } = {}) {
  const s = Math.round(scale);
  const chars = [...text];
  const full = textW(text, s);
  let cx = Math.round(o.align === "center" ? x - full / 2 : o.align === "right" ? x - full : x);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const k = ease.outBack(ramp(t, i * (o.stagger ?? 0.03), i * (o.stagger ?? 0.03) + (o.dur ?? 0.32)));
    const w = textW(ch, s) + (i < chars.length - 1 ? s : 0);
    if (k > 0 && ch !== " ") {
      // whole-font-pixel steps, so the motion is as chunky as the glyphs
      const dy = Math.round(((1 - k) * (o.rise ?? 6)) ) * s;
      px(g, ch, cx, y + dy, s, { ...o, align: "left", alpha: (o.alpha ?? 1) * clamp(k * 1.6, 0, 1) });
    }
    cx += w;
  }
}

/** A brand logo, rasterised to the office's pixel grid then scaled up hard-edged. */
const logoCache = new Map<string, HTMLCanvasElement>();
export function logo(g: CanvasRenderingContext2D, kind: LogoKind, x: number, y: number, cells: number, scale: number, color: string, alpha = 1) {
  const key = `${kind}|${cells}|${color}`;
  let c = logoCache.get(key);
  if (!c) {
    c = pixelLogo(kind, cells, color).c;
    logoCache.set(key, c);
  }
  g.save();
  g.imageSmoothingEnabled = false;
  g.globalAlpha = alpha;
  g.drawImage(c, Math.round(x), Math.round(y), c.width * scale, c.height * scale);
  g.restore();
}

/** The agent-visualizer wordmark (web/ui/icons.ts mark()): a monitor whose three lines of code are the three brands. */
let markRects: { x: number; y: number; w: number; fill: string }[] | null = null;
export function brandMark(g: CanvasRenderingContext2D, x: number, y: number, scale: number, alpha = 1) {
  if (!markRects) {
    const fills: Record<string, string> = { claude: "#D97757", cc: "#F2F2F2", codex: "#10A37F", cursor: "#ECEAE4" };
    markRects = [];
    for (const p of mark(1).querySelectorAll("path")) {
      const cls = (p.getAttribute("class") ?? "").replace(/^px-/, "");
      const fill = fills[cls] ?? "#ECEAE4";
      for (const m of (p.getAttribute("d") ?? "").matchAll(/M(\d+) (\d+)h(\d+)/g)) markRects.push({ x: +m[1]!, y: +m[2]!, w: +m[3]!, fill });
    }
  }
  g.save();
  g.globalAlpha = alpha;
  for (const r of markRects) {
    g.fillStyle = r.fill;
    g.fillRect(Math.round(x + r.x * scale), Math.round(y + r.y * scale), r.w * scale, scale);
  }
  g.restore();
}
