/*
 * The feature band: a solid panel along the bottom of the frame that names
 * the feature on screen, big enough to read on a phone. The title is the
 * office's bitmap font at a whole-number scale (about 6.5% of the frame's
 * height in 16:9); the line under it is Geist (src/fonts, OFL), about 4%.
 * Text inside ‹ › in a line is set in the bitmap font (commands, tool
 * names, the kaomoji). The band keeps its place while features change; only
 * its text moves.
 */
import { BRAND, HOST_BRAND, type AgentKind } from "../../src/shared/events.ts";
import { INK, clamp, ease, logo, px, ramp, textW } from "./type.ts";

export interface Feature {
  /** Short and bold, in the pixel font. */
  title: string;
  /** One line, in Geist; ‹…› runs are set in the pixel font. */
  line: string;
  /** The accent: the top edge of the band and the title's first word. */
  accent?: string;
  /** Logos on the right of the title (landscape) or under the line (portrait). */
  logos?: (AgentKind | "daytona" | "vercel" | "railway" | "ssh")[];
  /** A small tag in the band's corner, for an honest time-lapse ("×8 · about a minute"). */
  tag?: string;
  /** A multi-step flow: the steps, shown in place of the line, with `step` (0-based) lit. */
  steps?: string[];
  step?: number;
}

export const SANS = "Geist";

export interface BandGeo {
  h: number;
  pad: number;
  titleS: number;
  lineFont: number;
  /** Lines a title or a sentence may wrap to. */
  titleLines: number;
  lineLines: number;
}

export function bandGeo(W: number, H: number): BandGeo {
  const portrait = H > W * 1.2;
  const square = !portrait && W / H < 1.2;
  if (portrait) return { h: Math.round(H * 0.28), pad: 64, titleS: 12, lineFont: 46, titleLines: 2, lineLines: 3 };
  if (square) return { h: Math.round(H * 0.31), pad: 56, titleS: 9, lineFont: 38, titleLines: 2, lineLines: 2 };
  return { h: Math.round(H * 0.232), pad: Math.round(W * 0.05), titleS: Math.max(4, Math.round(H * 0.0093)), lineFont: Math.round(H * 0.039), titleLines: 1, lineLines: 2 };
}

/** Split `text` into lines no wider than `max`, by words. */
function wrap(words: string[], measure: (s: string) => number, max: number, lines: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (measure(next) <= max || !cur) cur = next;
    else {
      out.push(cur);
      cur = w;
    }
  }
  if (cur) out.push(cur);
  return out.slice(0, lines);
}

/** Width of a line with ‹pixel› runs, and a drawer for it. */
function richLine(g: CanvasRenderingContext2D, text: string, size: number) {
  const parts = text.split(/(‹[^›]*›)/).filter(Boolean).map((p) => (p.startsWith("‹") ? { px: true, t: p.slice(1, -1) } : { px: false, t: p }));
  const pxS = Math.max(2, Math.round(size / 9));
  g.font = `600 ${size}px ${SANS}, sans-serif`;
  const w = parts.reduce((n, p) => n + (p.px ? textW(p.t, pxS) : g.measureText(p.t).width), 0);
  return {
    w,
    draw(x: number, y: number, alpha: number) {
      let cx = x;
      g.font = `600 ${size}px ${SANS}, sans-serif`;
      g.textBaseline = "alphabetic";
      for (const p of parts) {
        if (p.px) {
          px(g, p.t, cx, y - 7 * pxS, pxS, { color: INK.cyan, shadow: null, alpha });
          cx += textW(p.t, pxS);
        } else {
          g.globalAlpha = alpha;
          g.fillStyle = "#e9e6f2";
          g.fillText(p.t, cx, y);
          g.globalAlpha = 1;
          cx += g.measureText(p.t).width;
        }
      }
    },
  };
}

/**
 * Draw the band. `k` 0..1 slides the panel in; `tf` is seconds since this
 * feature came up (its text animates in over the first half second); `gone`
 * 0..1 fades the text out (the next feature replacing it).
 */
export function drawBand(g: CanvasRenderingContext2D, W: number, H: number, f: Feature, k: number, tf: number, gone = 0) {
  if (k <= 0) return;
  const geo = bandGeo(W, H);
  const portrait = H > W * 1.2;
  const y0 = Math.round(H - geo.h * ease.outCubic(k));
  const accent = f.accent ?? INK.claude;
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.fillStyle = "rgba(9,8,16,0.97)";
  g.fillRect(0, y0, W, H - y0);
  g.fillStyle = accent;
  g.fillRect(0, y0, W, Math.max(4, Math.round(H * 0.0045)));
  const a = clamp(1 - gone, 0, 1);
  // the title never loses a word: it shrinks a step instead; logos move to the line's row when the title needs the width
  let ts = geo.titleS;
  const ls = Math.round(geo.titleS * 0.62);
  const lw = f.logos?.length ? logosW(f.logos.length, geo.titleS) : 0;
  const full = W - geo.pad * 2;
  let logosBeside = !portrait && !!f.logos?.length && textW(f.title, ts) + lw + 48 <= full;
  const fits = (sc: number, max: number) => wrap(f.title.split(" "), (t) => textW(t, sc), max, 99).length <= geo.titleLines;
  while (ts > 5 && !fits(ts, logosBeside ? full - lw - 48 : full)) ts--;
  const tLines = wrap(f.title.split(" "), (t) => textW(t, ts), logosBeside ? full - lw - 48 : full, geo.titleLines);
  g.font = `600 ${geo.lineFont}px ${SANS}, sans-serif`;
  const logosOnLine = !portrait && !!f.logos?.length && !logosBeside;
  const lmax = full - (logosOnLine ? lw + 48 : 0);
  const lLines = f.steps ? [] : wrap(f.line.split(" "), (t) => richLine(g, t, geo.lineFont).w, lmax, geo.lineLines);
  const stepRows = f.steps ? layoutSteps(g, f.steps, Math.round(geo.lineFont * 0.92), full) : null;
  // centre the block in the band
  const lineH = Math.round(geo.lineFont * 1.28);
  const gap = Math.round(geo.lineFont * (portrait ? 0.9 : 0.75));
  const logoRow = portrait && f.logos?.length ? 9 * ls + Math.round(geo.lineFont * 0.7) : 0;
  const block = tLines.length * 10 * ts - 2 * ts + gap + (stepRows ? stepRows.h : lLines.length * lineH) + logoRow;
  const top = y0 + Math.max(Math.round(geo.h * 0.1), Math.round((geo.h - block) / 2) - Math.round(geo.lineFont * 0.15));
  let y = top;
  const kt = ease.outCubic(ramp(tf, 0.02, 0.32));
  const rise = Math.round((1 - kt) * 3) * ts;
  for (const [i, line] of tLines.entries()) {
    const words = line.split(" ");
    let x = geo.pad;
    for (const [j, w] of words.entries()) {
      const isFirst = i === 0 && j === 0 && words.length > 1;
      px(g, w, x, y + rise, ts, { color: isFirst ? accent : INK.white, alpha: a * kt, depth: 1 });
      x += textW(`${w} `, ts);
    }
    y += 10 * ts;
  }
  y += gap - 2 * ts + Math.round(geo.lineFont * 0.78);
  const lineTop = y;
  for (const [i, line] of lLines.entries()) {
    const kl = ease.outCubic(ramp(tf, 0.18 + i * 0.08, 0.5 + i * 0.08));
    richLine(g, line, geo.lineFont).draw(geo.pad, y + Math.round((1 - kl) * 8), a * kl);
    y += lineH;
  }
  if (stepRows) {
    const kl = ease.outCubic(ramp(tf, 0.15, 0.45));
    drawSteps(g, stepRows, geo.pad, y - Math.round(geo.lineFont * 0.78), f.step ?? 0, accent, a * kl);
    y += stepRows.h;
  }
  // logos: beside the title, at the end of the line's row, or under the line (portrait)
  if (f.logos?.length) {
    const step = 9 * ls + 6 * ls;
    const total = f.logos.length * step - 6 * ls;
    const lx0 = portrait ? Math.round((W - total) / 2) : W - geo.pad - total;
    const ly = portrait
      ? y - lineH + Math.round(geo.lineFont * 0.7) + Math.round(geo.lineFont * 0.3)
      : logosBeside
        ? top + Math.round((8 * ts - 9 * ls) / 2)
        : lineTop - Math.round(geo.lineFont * 0.78) + Math.round((geo.lineFont * 1.0 - 9 * ls) / 2);
    f.logos.forEach((kind, i) => {
      const kk = ease.outBack(ramp(tf, 0.25 + i * 0.05, 0.55 + i * 0.05));
      if (kk <= 0) return;
      const col = (BRAND as Record<string, { color: string }>)[kind]?.color ?? (HOST_BRAND as Record<string, { color: string }>)[kind]?.color ?? "#ccc";
      logo(g, kind as Parameters<typeof logo>[1], lx0 + i * step, ly + Math.round((1 - kk) * 3) * ls, 9, ls, col, a * clamp(kk, 0, 1));
    });
  }
  const s = ts;
  if (f.tag) {
    let ts = Math.max(3, Math.round(s * 0.45));
    let tag = f.tag;
    while (ts > 3 && textW(tag, ts) > W - geo.pad * 2) ts--;
    // too long for a narrow frame: just the speed-up
    if (textW(tag, ts) > W - geo.pad * 2) tag = tag.split(" · ")[0]! + " time-lapse";
    const tw = textW(tag, ts);
    const tx = W - geo.pad - tw, ty = y0 - 13 * ts;
    g.fillStyle = "rgba(9,8,16,0.92)";
    g.fillRect(tx - 3 * ts, ty - 3 * ts, tw + 6 * ts, 13 * ts);
    px(g, tag, tx, ty, ts, { color: INK.amber, shadow: null, alpha: a * ease.outCubic(ramp(tf, 0.1, 0.4)) });
  }
  g.restore();
}

interface StepLayout {
  items: { n: number; text: string; x: number; row: number; w: number }[];
  font: number;
  chipH: number;
  rowH: number;
  h: number;
}

/** The steps as chips in rows that fit `max`: "1 Pick Command Code", "2 Daytona, new sandbox", ... */
function layoutSteps(g: CanvasRenderingContext2D, steps: string[], font: number, max: number): StepLayout {
  g.font = `600 ${font}px ${SANS}, sans-serif`;
  const chipH = Math.round(font * 1.55);
  const num = chipH;
  const padX = Math.round(font * 0.5);
  const gap = Math.round(font * 0.9);
  const items: StepLayout["items"] = [];
  let x = 0, row = 0;
  steps.forEach((text, i) => {
    const w = num + padX + g.measureText(text).width + padX;
    if (x > 0 && x + w > max) {
      x = 0;
      row++;
    }
    items.push({ n: i + 1, text, x, row, w });
    x += w + gap;
  });
  const rowH = chipH + Math.round(font * 0.35);
  return { items, font, chipH, rowH, h: (row + 1) * rowH };
}

function drawSteps(g: CanvasRenderingContext2D, L: StepLayout, x0: number, y0: number, cur: number, accent: string, alpha: number) {
  g.save();
  g.font = `600 ${L.font}px ${SANS}, sans-serif`;
  g.textBaseline = "middle";
  for (const it of L.items) {
    const i = it.n - 1;
    const done = i < cur, now = i === cur;
    const x = x0 + it.x, y = y0 + it.row * L.rowH;
    g.globalAlpha = alpha * (now ? 1 : done ? 0.75 : 0.45);
    // chip
    g.fillStyle = now ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.04)";
    g.fillRect(x, y, it.w, L.chipH);
    if (now) {
      g.fillStyle = accent;
      g.fillRect(x, y + L.chipH - 4, it.w, 4);
    }
    // the number (a tick once done)
    g.fillStyle = now ? accent : done ? "#52d6a0" : "#3a3850";
    g.fillRect(x, y, L.chipH, L.chipH);
    g.fillStyle = now || done ? "#0b0a13" : "#c9c7d8";
    g.textAlign = "center";
    g.fillText(done ? "✓" : String(it.n), x + L.chipH / 2, y + L.chipH / 2 + 1);
    g.textAlign = "left";
    g.fillStyle = now ? "#ffffff" : "#d8d5e6";
    g.fillText(it.text, x + L.chipH + Math.round(L.font * 0.5), y + L.chipH / 2 + 1);
  }
  g.restore();
}

function logosW(n: number, s: number) {
  const ls = Math.round(s * 0.62);
  return n * 15 * ls - 6 * ls;
}

/** Load the sans weights before the first frame. */
export async function loadFonts() {
  const faces = [
    new FontFace(SANS, "url(fonts/Geist-SemiBold.woff2)", { weight: "600" }),
    new FontFace(SANS, "url(fonts/Geist-Bold.woff2)", { weight: "700" }),
    new FontFace(SANS, "url(fonts/Geist-Medium.woff2)", { weight: "500" }),
  ];
  for (const f of faces) document.fonts.add(await f.load());
}
