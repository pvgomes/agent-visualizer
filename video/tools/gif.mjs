// A GIF from rendered PNG frames, for the README.
//
// One global palette for the whole clip (so nothing flickers between frames), built by
// median cut over the clip's own colours at full 8-bit precision and refined with a few
// k-means passes: the night's dark blues and purples cover a lot of the frame, so they
// get most of the 255 entries and the void's gradient doesn't band. No dithering, so the
// pixel art stays hard-edged and unchanged pixels stay identical: every frame after the
// first only carries what changed (the rest is the transparent index, "do not dispose").
// "Changed" has a small tolerance: a lamp's flicker that moves a pixel to the next palette
// entry over is left alone, which is most of what a still office does between frames.
import gifenc from "gifenc";
import pngjs from "pngjs";
import { writeFileSync } from "node:fs";

const { GIFEncoder } = gifenc;
const { PNG } = pngjs;

const WR = 2, WG = 4, WB = 3;
/** Per-channel difference under which a pixel counts as unchanged between frames. */
const TOL = 7;
const R = (c) => c >>> 16, G = (c) => (c >>> 8) & 255, B = (c) => c & 255;
const dist = (r1, g1, b1, r2, g2, b2) => WR * (r1 - r2) ** 2 + WG * (g1 - g2) ** 2 + WB * (b1 - b2) ** 2;

function medianCut(colors, counts, n) {
  const boxes = [];
  const stat = (lo, hi) => {
    let w = 0, sr = 0, sg = 0, sb = 0;
    for (let i = lo; i < hi; i++) {
      const c = colors[i], k = counts[c];
      w += k; sr += k * R(c); sg += k * G(c); sb += k * B(c);
    }
    const mr = sr / w, mg = sg / w, mb = sb / w;
    let vr = 0, vg = 0, vb = 0;
    for (let i = lo; i < hi; i++) {
      const c = colors[i], k = counts[c];
      vr += k * (R(c) - mr) ** 2; vg += k * (G(c) - mg) ** 2; vb += k * (B(c) - mb) ** 2;
    }
    return { lo, hi, w, mean: [mr, mg, mb], sse: WR * vr + WG * vg + WB * vb, axis: WR * vr >= WG * vg && WR * vr >= WB * vb ? 0 : WG * vg >= WB * vb ? 1 : 2 };
  };
  boxes.push(stat(0, colors.length));
  while (boxes.length < n) {
    let bi = -1, best = 0;
    boxes.forEach((b, i) => {
      if (b.hi - b.lo > 1 && b.sse > best) { best = b.sse; bi = i; }
    });
    if (bi < 0) break;
    const b = boxes[bi];
    const ch = [R, G, B][b.axis];
    colors.subarray(b.lo, b.hi).sort((x, y) => ch(x) - ch(y));
    let acc = 0, cut = b.lo + 1;
    for (let i = b.lo; i < b.hi - 1; i++) {
      acc += counts[colors[i]];
      if (acc >= b.w / 2) { cut = i + 1; break; }
    }
    boxes.splice(bi, 1, stat(b.lo, cut), stat(cut, b.hi));
  }
  return boxes.map((b) => b.mean);
}

function nearest(pal, r, g, b) {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < pal.length; i++) {
    const p = pal[i];
    const d = dist(r, g, b, p[0], p[1], p[2]);
    if (d < bd) { bd = d; bi = i; }
  }
  return bi;
}

/** `pngs`: PNG buffers, all the same size. `delayMs(i)`: frame i's delay. */
export function encodeGif(pngs, out, delayMs) {
  const frames = pngs.map((b) => PNG.sync.read(b));
  const { width: W, height: H } = frames[0];
  const counts = new Uint32Array(1 << 24);
  for (let f = 0; f < frames.length; f += 2) {
    const d = frames[f].data;
    for (let i = 0; i < d.length; i += 4) counts[(d[i] << 16) | (d[i + 1] << 8) | d[i + 2]]++;
  }
  let n = 0;
  for (let c = 0; c < counts.length; c++) if (counts[c]) n++;
  const colors = new Uint32Array(n);
  for (let c = 0, j = 0; c < counts.length; c++) if (counts[c]) colors[j++] = c;
  let pal = medianCut(colors, counts, 255);
  // k-means: move each entry to the weighted mean of the colours nearest to it
  for (let it = 0; it < 4; it++) {
    const acc = pal.map(() => [0, 0, 0, 0]);
    for (const c of colors) {
      const k = counts[c];
      const a = acc[nearest(pal, R(c), G(c), B(c))];
      a[0] += k * R(c); a[1] += k * G(c); a[2] += k * B(c); a[3] += k;
    }
    pal = pal.map((p, i) => (acc[i][3] ? [acc[i][0] / acc[i][3], acc[i][1] / acc[i][3], acc[i][2] / acc[i][3]] : p));
  }
  const palette = pal.map((p) => p.map((v) => Math.round(v)));
  const T = palette.length; // the transparent index, past the colours
  palette.push([0, 0, 0]);
  const lut = new Int16Array(1 << 24).fill(-1);
  const gif = GIFEncoder();
  /** What the viewer sees now, per pixel. */
  let shown = null;
  const near = (a, b) => {
    const p = palette[a], q = palette[b];
    return Math.abs(p[0] - q[0]) <= TOL && Math.abs(p[1] - q[1]) <= TOL && Math.abs(p[2] - q[2]) <= TOL;
  };
  frames.forEach((fr, f) => {
    const d = fr.data;
    const idx = new Uint8Array(W * H);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      const c = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
      let k = lut[c];
      if (k < 0) k = lut[c] = nearest(pal, d[i], d[i + 1], d[i + 2]);
      idx[p] = k;
    }
    let outIdx = idx;
    if (shown) {
      outIdx = new Uint8Array(idx.length);
      for (let i = 0; i < idx.length; i++) {
        const v = idx[i];
        if (v === shown[i] || near(v, shown[i])) outIdx[i] = T;
        else { outIdx[i] = v; shown[i] = v; }
      }
    } else shown = idx.slice();

    gif.writeFrame(outIdx, W, H, {
      palette: f === 0 ? palette : undefined,
      delay: delayMs(f),
      repeat: 0,
      transparent: f > 0,
      transparentIndex: T,
      dispose: 1,
    });
  });
  gif.finish();
  const bytes = gif.bytes();
  writeFileSync(out, bytes);
  return { width: W, height: H, frames: frames.length, bytes: bytes.length, colors: n };
}
