// Builds the landing page (site/) into site/dist, a static folder for any host.
//
//   node scripts/build-site.mjs           build once (npm run site)
//   node scripts/build-site.mjs --dev     build, serve on 127.0.0.1:5040 and rebuild + reload on change (npm run site:dev)
//
// No framework: esbuild for the TypeScript and the CSS, and the live office is site/office.ts, which
// bundles the app's own scene (web/scene), demo (src/demo) and state (src/server/state.ts) for the
// browser, with node built-ins aliased to site/shims/node.ts. The bitmap font, brand mark, pixel
// glyphs, palette and agent colours are read from web/scene, web/ui and src/shared at build time and
// inlined as SVG, so the page and the office stay one thing.
//
//   SITE_URL=https://example.com   makes og:image, og:url and the canonical link absolute
//   GITHUB_STARS=<n>               the star count, instead of asking the GitHub API ("" hides it)
//   STARS_MIN=<n>                  hide the count below this many stars (default 50)
//   TOUR_VIDEO=<path>              the launch video (.mp4 or .webm); site/assets/tour.{mp4,webm} is
//                                  picked up on its own. With neither, the "watch the tour" button and
//                                  its player are left out of the page.
//   SITE_OUT=<dir>                 build somewhere other than site/dist
//   PORT=<n>                       the dev server's port (default: the first free one from 5040)
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");
const OUT = resolve(process.env.SITE_OUT || join(SITE, "dist"));
const DEV = process.argv.includes("--dev");
const SITE_URL = (process.env.SITE_URL ?? "").replace(/\/+$/, "");
const REPO = "pvgomes/agent-visualizer";
const STARS_MIN = Number(process.env.STARS_MIN ?? 50);
/** The dev server takes the first free port in 5040-5049 unless PORT says otherwise. */
const PORTS = [5040, 5049];

/* ------------------------------------------------------------------ office data */

// font.ts draws its glyph atlas into a canvas from util.ts, icons.ts builds SVG through dom.ts:
// in node both get a stub that records the pixels instead.
const STUBS = {
  // for sprites.ts: the real helpers, with a bitmap whose putImageData keeps the pixels
  spriteUtil: `
    export * from ${JSON.stringify(join(ROOT, "web/scene/util.ts"))};
    export function bitmap(w, h) {
      let img = null;
      const g = { createImageData: (W, H) => ({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4) }), putImageData: (d) => { img = d; }, fillStyle: "", globalCompositeOperation: "", fillRect() {}, drawImage() {} };
      return { w, h, c: { get img() { return img; } }, g };
    }`,
  util: `
    export function bitmap(w, h) {
      const px = new Set();
      return { w, h, c: { px }, g: { fillStyle: "", globalCompositeOperation: "", fillRect(x, y, fw, fh) { for (let j = 0; j < fh; j++) for (let i = 0; i < fw; i++) px.add((x + i) + "," + (y + j)); }, drawImage() {} } };
    }`,
  dom: `export function pixels(rows, scale, cls) { return { rows, cls }; }`,
};

async function officeData() {
  const entry = `
    export { FONT, MICRO } from ${JSON.stringify(join(ROOT, "web/scene/font.ts"))};
    export { sprite, lookFor } from ${JSON.stringify(join(ROOT, "web/scene/sprites.ts"))};
    export { glyph, icon, mark } from ${JSON.stringify(join(ROOT, "web/ui/icons.ts"))};
    export { C } from ${JSON.stringify(join(ROOT, "web/scene/palette.ts"))};
    export { BRAND, HOST_BRAND } from ${JSON.stringify(join(ROOT, "src/shared/events.ts"))};`;
  const res = await build({
    stdin: { contents: entry, resolveDir: ROOT, loader: "js" },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    logLevel: "silent",
    plugins: [
      {
        name: "stubs",
        setup(b) {
          b.onResolve({ filter: /^\.\/util\.ts$/ }, (a) => (a.importer.endsWith("font.ts") ? { path: "util", namespace: "stub" } : a.importer.endsWith("sprites.ts") ? { path: "spriteUtil", namespace: "stub" } : undefined));
          b.onResolve({ filter: /^\.\/dom\.ts$/ }, (a) => (a.importer.endsWith("icons.ts") ? { path: "dom", namespace: "stub" } : undefined));
          b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: STUBS[a.path], loader: "js", resolveDir: ROOT }));
        },
      },
    ],
  });
  const code = res.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}#${Date.now()}`);
}

/* ------------------------------------------------------------------ svg helpers */

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unesc = (s) => s.replace(/&apos;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Horizontal runs of a pixel set as one path. */
function runsPath(points) {
  const rows = new Map();
  for (const [x, y] of points) {
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push(x);
  }
  let d = "";
  for (const [y, xs] of [...rows].sort((a, b) => a[0] - b[0])) {
    xs.sort((a, b) => a - b);
    for (let i = 0; i < xs.length; ) {
      let j = i;
      while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1) j++;
      d += `M${xs[i]} ${y}h${j - i + 1}v1h${i - j - 1}z`;
      i = j + 1;
    }
  }
  return d;
}

/** Pixel rows as an inline SVG at an integer scale: "#" is currentColor, any other letter its own classed layer. */
function pixelArt(rows, cls, scale = 2) {
  const layers = new Map();
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === "." || ch === " ") continue;
      if (!layers.has(ch)) layers.set(ch, []);
      layers.get(ch).push([x, y]);
    }
  });
  const w = Math.max(...rows.map((r) => r.length));
  const paths = [...layers].map(([ch, pts]) => `<path${ch === "#" ? "" : ` class="px-${/[a-z]/.test(ch) ? ch : "x"}"`} d="${runsPath(pts)}"/>`).join("");
  return `<svg class="${cls}" viewBox="0 0 ${w} ${rows.length}" width="${w * scale}" height="${rows.length * scale}" fill="currentColor" shape-rendering="crispEdges" aria-hidden="true" focusable="false">${paths}</svg>`;
}

function textPixels(font, text) {
  const px = font.atlas.c.px;
  const pts = [];
  let cx = 0;
  for (const ch of text) {
    const gl = font.glyphs.get(ch) ?? font.glyphs.get("?");
    for (let y = 0; y < font.cellH; y++) for (let x = 0; x < gl.w; x++) if (px.has(`${gl.ax + x},${y}`)) pts.push([cx + x, y]);
    cx += gl.adv;
  }
  return { pts, w: Math.max(1, cx - font.gap) };
}

/**
 * Text in the office's bitmap font: one SVG per word so it wraps like text. --w and --h carry the
 * size in font pixels, so CSS can scale it by an integer (or by the em, where crispness can give).
 */
let gradId = 0;
function pixelText(font, text, { grad = false } = {}) {
  const words = text.split(/ +/);
  return words
    .map((word) => {
      const { pts, w } = textPixels(font, word);
      const id = `pxg${gradId++}`;
      // a vertical gradient in font pixels, coloured by CSS (.ga / .gb)
      const defs = grad ? `<defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="${font.cellH}"><stop offset="0" class="ga"/><stop offset="1" class="gb"/></linearGradient></defs>` : "";
      return `<svg viewBox="0 0 ${w} ${font.cellH}" width="${w}" height="${font.cellH}" style="--w:${w};--h:${font.cellH}" shape-rendering="crispEdges" fill="currentColor" focusable="false">${defs}<path${grad ? ` fill="url(#${id})"` : ""} d="${runsPath(pts)}"/></svg>`;
    })
    .join(" ");
}

/** A deterministic random stream for the build's generated art. */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/* ------------------------------------------------------------------ the night: city, moon, workers */

/** An RGBA pixel buffer (a sprite from web/scene/sprites.ts) as an SVG at an integer scale, one path per colour. */
function rgbaSvg(img, cls, scale = 2, attrs = "") {
  const byColour = new Map();
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      if (!img.data[i + 3]) continue;
      const hex = "#" + [img.data[i], img.data[i + 1], img.data[i + 2]].map((v) => v.toString(16).padStart(2, "0")).join("");
      if (!byColour.has(hex)) byColour.set(hex, []);
      byColour.get(hex).push([x, y]);
    }
  const paths = [...byColour].map(([c, pts]) => `<path fill="${c}" d="${runsPath(pts)}"/>`).join("");
  return `<svg class="${cls}" viewBox="0 0 ${img.width} ${img.height}" width="${img.width * scale}" height="${img.height * scale}" shape-rendering="crispEdges" aria-hidden="true" focusable="false"${attrs}>${paths}</svg>`;
}

/** Several RGBA frames side by side in one SVG: a sprite strip that CSS steps through with a transform. */
function stripSvg(frames, cls, scale = 2) {
  const fw = frames[0].width, fh = frames[0].height;
  const byColour = new Map();
  frames.forEach((img, f) => {
    for (let y = 0; y < fh; y++)
      for (let x = 0; x < fw; x++) {
        const i = (y * fw + x) * 4;
        if (!img.data[i + 3]) continue;
        const hex = "#" + [img.data[i], img.data[i + 1], img.data[i + 2]].map((v) => v.toString(16).padStart(2, "0")).join("");
        if (!byColour.has(hex)) byColour.set(hex, []);
        byColour.get(hex).push([f * fw + x, y]);
      }
  });
  const paths = [...byColour].map(([c, pts]) => `<path fill="${c}" d="${runsPath(pts)}"/>`).join("");
  const W = fw * frames.length;
  return `<svg class="${cls}" viewBox="0 0 ${W} ${fh}" width="${W * scale}" height="${fh * scale}" style="--fw:${fw * scale}px;--frames:${frames.length}" shape-rendering="crispEdges" aria-hidden="true" focusable="false">${paths}</svg>`;
}

/** A pixel moon, 15 px across, with a few craters. */
function moonSvg() {
  const R = 7, pts = [], dark = [];
  const craters = [[-2, -2, 1.6], [3, 1, 1.2], [-1, 3, 1]];
  for (let y = -R; y <= R; y++)
    for (let x = -R; x <= R; x++) {
      if (x * x + y * y > R * R + 2) continue;
      (craters.some(([cx, cy, r]) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r) ? dark : pts).push([x + R, y + R]);
    }
  return `<svg class="moon-px" viewBox="0 0 15 15" width="15" height="15" shape-rendering="crispEdges" aria-hidden="true" focusable="false"><path class="m-lit" d="${runsPath(pts)}"/><path class="m-crater" d="${runsPath(dark)}"/></svg>`;
}

/**
 * The footer's city, in the office's own night colours, 640 x 150 art pixels drawn at an integer
 * scale: a far and a near row of towers with lit windows (a few switch on and off, a few are
 * screens in an agent's colour), street lamps, and in the middle the office's own building: one
 * floor per agent with its colour on the sill, a lift going up and down its glass shaft, a beacon,
 * and its neon NPX AGENT-VISUALIZER sign. The far row goes behind the wordmark, the near row in
 * front; a link over the building goes back to the top.
 */
function city(d) {
  const { C, BRAND } = d;
  const micro = d.MICRO();
  const W = 640, H = 150, r = rng(42);
  const brands = Object.values(BRAND).map((b) => b.color);
  // the office: centred, the tallest thing in town
  const hw = 84, hh = 116, hx = Math.round(W / 2 - hw / 2), hy = H - hh;
  const avoid = (x, w) => x + w > hx - 3 && x < hx + hw + 3;
  const towers = (minH, maxH, minW, maxW, skipHQ) => {
    const out = [];
    for (let x = -6; x < W; ) {
      const w = Math.round(minW + r() * (maxW - minW));
      const h = Math.round(minH + r() * (maxH - minH));
      if (!(skipHQ && avoid(x, w))) out.push({ x, w, h });
      x += w + (r() < 0.3 ? 2 : 0);
    }
    return out;
  };
  const rect = (x, y, w = 1, h = 1) => `M${x} ${y}h${w}v${h}h${-w}z`;
  const flick = Array.from({ length: 6 }, () => "");
  const layer = (list, fill, lit, cls) => {
    let body = "", win = "", screen = "";
    for (const t of list) {
      const top = H - t.h;
      body += rect(t.x, top, t.w, t.h);
      if (r() < 0.22 && t.w > 8) body += rect(t.x + Math.floor(t.w / 2), top - 5, 1, 5);
      for (let wy = top + 3; wy < H - 5; wy += 4)
        for (let wx = t.x + 2; wx < t.x + t.w - 2; wx += 3) {
          const p = r();
          if (p >= lit) continue;
          if (p < lit * 0.14) flick[Math.floor(r() * 6)] += rect(wx, wy, 1, 2);
          else if (p < lit * 0.2) screen += rect(wx, wy, 1, 2);
          else win += rect(wx, wy, 1, 2);
        }
    }
    return `<path class="${cls}" fill="${fill}" d="${body}"/><path class="win" d="${win}"/><path class="win scr" d="${screen}"/>`;
  };
  const far = layer(towers(34, 92, 10, 26, false), C.blue2, 0.07, "bld");
  const near = layer(towers(14, 58, 12, 30, true), C.blue1, 0.1, "bld");
  const flicker = flick.map((p, i) => `<path class="win fl fl${i}" d="${p}"/>`).join("");

  // the office's building
  const floorH = 9, top = hy + 6, shaftX = hx + hw - 11;
  let body = rect(hx, hy, hw, hh), trim = rect(hx - 1, hy - 1, hw + 2, 2), lit = "", screens = "", sills = "", dim = "";
  const floors = Math.floor((H - 16 - top) / floorH);
  for (let f = 0; f < floors; f++) {
    const y = top + f * floorH;
    const colour = brands[f % brands.length];
    // each floor is one agent's: its colour on the sill, a few of its screens, a dark stretch where nobody's in
    sills += `<path fill="${colour}" d="${rect(hx + 4, y + 6, shaftX - hx - 6, 1)}"/>`;
    const gapAt = Math.floor(r() * 12), gapLen = r() < 0.5 ? 2 + Math.floor(r() * 3) : 0;
    let i = 0;
    for (let x = hx + 5; x + 3 <= shaftX - 3; x += 5, i++) {
      const p = r();
      if ((i >= gapAt && i < gapAt + gapLen) || p < 0.12) dim += rect(x, y + 1, 3, 4);
      else if (p < 0.3) screens += `<path fill="${colour}" d="${rect(x, y + 2, 3, 3)}"/>`;
      else lit += rect(x, y + 1, 3, 4);
    }
  }
  // depth: a lit left edge and a shaded right face
  trim += rect(hx, hy + 1, 1, hh - 1);
  const shade = rect(hx + hw - 4, hy + 1, 4, hh - 1);
  const lobbyY = top + floors * floorH;
  const shaft = rect(shaftX, hy + 4, 5, lobbyY - hy - 4);
  const car = rect(shaftX + 1, lobbyY - floorH + 1, 3, 6);
  const door = rect(hx + Math.round(hw / 2) - 6, H - 9, 5, 9) + rect(hx + Math.round(hw / 2) + 1, H - 9, 5, 9);
  const awning = rect(hx + Math.round(hw / 2) - 9, H - 11, 18, 2);
  // the sign: a plate on two posts, the text in the office's micro font
  const text = "NPX AGENT-VISUALIZER";
  const tp = textPixels(micro, text);
  const pw = Math.max(hw - 4, tp.w + 8), px = Math.round(W / 2 - pw / 2), py = hy - 14;
  const posts = rect(px + 6, py + 11, 1, 3) + rect(px + pw - 7, py + 11, 1, 3);
  const glyphs = runsPath(tp.pts.map(([x, y]) => [x + Math.round(W / 2 - tp.w / 2), y + py + 3]));
  const antenna = rect(hx + 12, hy - 22, 1, 21);
  const beacon = rect(hx + 11, hy - 24, 3, 2);
  const hq = `<g class="hq">
<path class="bld hq-body" fill="${mix(C.blue1, C.blue2, 0.5)}" d="${body}"/><path class="hq-trim" d="${trim}"/>
<path class="hq-dim" d="${dim}"/><path class="win hq-lit" d="${lit}"/><g class="hq-screens">${screens}</g>${sills}
<path class="hq-shade" d="${shade}"/><path class="hq-shaft" d="${shaft}"/><path class="hq-car" d="${car}"/><path class="hq-door" d="${door}"/><path class="hq-awning" d="${awning}"/>
<path class="hq-post" d="${posts}${antenna}"/><path class="hq-beacon" d="${beacon}"/>
<path class="hq-plate" d="${rect(px, py, pw, 11)}"/><path class="hq-sign" d="${glyphs}"/><path class="hq-sign hq-glow" d="${glyphs}"/>
</g>`;

  // street lamps along the kerb, clear of the office's door
  let lamps = "", heads = "";
  for (let x = 24; x < W; x += 58 + Math.floor(r() * 18)) {
    if (Math.abs(x - W / 2) < 20) continue;
    lamps += rect(x, H - 15, 1, 15) + rect(x, H - 15, 3, 1);
    heads += rect(x + 2, H - 14, 2, 1);
  }
  let stars = "", twinkle = "";
  for (let i = 0; i < 70; i++) {
    const s = rect(Math.floor(r() * W), Math.floor(r() * 50));
    if (i % 5 === 0) twinkle += s;
    else stars += s;
  }
  const svg = (cls, inner) => `<svg class="${cls}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" shape-rendering="crispEdges" aria-hidden="true" focusable="false">${inner}</svg>`;
  const defs = `<defs><radialGradient id="lampglow"><stop offset="0" stop-color="#ffd36c" stop-opacity=".55"/><stop offset="1" stop-color="#ffd36c" stop-opacity="0"/></radialGradient></defs>`;
  const glows = heads.match(/M(\d+) (\d+)/g).map((m) => { const [, x, y] = /M(\d+) (\d+)/.exec(m); return `<circle cx="${+x + 1}" cy="${+y + 2}" r="9" fill="url(#lampglow)"/>`; }).join("");
  return `<div class="city" style="--W:${W};--H:${H};--hx:${hx};--hy:${py};--hw:${hw}">
  ${svg("far", `<path class="stars" d="${stars}"/><path class="stars tw" d="${twinkle}"/>${far}`)}
  ${svg("near", `${defs}${near}${flicker}${hq}<g class="lamps">${glows}<path class="lamp" d="${lamps}"/><path class="lamp-head" d="${heads}"/></g>`)}
  <a class="hq-link" href="#top" aria-label="agent-visualizer: back to the top"></a>
</div>`;
}

/** Hex colour blend, for the few build-time tints. */
function mix(a, b, t) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return "#" + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join("");
}

/** The brand mark as a standalone SVG file (the favicon): monochrome, one line in the accent. */
function markFile(rows) {
  const fills = { "#": "#EDEDED", a: "#8E75FF", b: "#8F8F8F", c: "#8F8F8F", "*": "#EDEDED" };
  const w = Math.max(...rows.map((r) => r.length));
  const pad = 1, W = w + pad * 2, H = rows.length + pad * 2 + (w - rows.length);
  const oy = pad + Math.floor((w - rows.length) / 2);
  const layers = new Map();
  rows.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch === "." || ch === " ") return;
    if (!layers.has(ch)) layers.set(ch, []);
    layers.get(ch).push([x + pad, y + oy]);
  }));
  const paths = [...layers].map(([ch, pts]) => `<path fill="${fills[ch] ?? "#EDEDED"}" d="${runsPath(pts)}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges"><rect width="${W}" height="${H}" rx="2" fill="#0A0A0A"/>${paths}</svg>\n`;
}

/** assets/logos/<name>.svg as a <symbol>: the root's presentation attributes move onto a <g>. */
function logoSymbol(name) {
  const src = readFileSync(join(ROOT, "assets/logos", `${name}.svg`), "utf8")
    .replace(/<\?xml[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<title>[\s\S]*?<\/title>/g, "")
    .replace(/<metadata>[\s\S]*?<\/metadata>/g, "");
  const open = /<svg\b([^>]*)>/.exec(src);
  const attrs = open[1];
  const inner = src.slice(open.index + open[0].length, src.lastIndexOf("</svg>")).trim();
  const get = (k) => new RegExp(`\\s${k}="([^"]*)"`).exec(attrs)?.[1];
  const keep = ["fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "fill-rule", "clip-rule"]
    .map((k) => (get(k) ? ` ${k}="${get(k)}"` : ""))
    .join("");
  return `<symbol id="lg-${name}" viewBox="${get("viewBox") ?? "0 0 24 24"}"><g${keep || ' fill="currentColor"'}>${inner}</g></symbol>`;
}

/** Relative luminance of #rrggbb, to tell which brand colours vanish on a white page. */
function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

/* ------------------------------------------------------------------ github stars */

let starsCache;
async function stars() {
  if (process.env.GITHUB_STARS !== undefined) return process.env.GITHUB_STARS === "" ? null : Number(process.env.GITHUB_STARS);
  if (starsCache !== undefined) return starsCache;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "agent-visualizer-site" },
      signal: AbortSignal.timeout(4000),
    });
    starsCache = res.ok ? Number((await res.json()).stargazers_count) : null;
  } catch {
    starsCache = null;
  }
  if (starsCache === null) console.log("  note: couldn't read the star count from GitHub, so the page shows none (GITHUB_STARS=<n> sets it)");
  return starsCache;
}
const short = (n) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n));

/* ------------------------------------------------------------------ the tour video */

function tourVideo() {
  const cands = [process.env.TOUR_VIDEO, join(SITE, "assets/tour.mp4"), join(SITE, "assets/tour.webm")].filter(Boolean);
  const file = cands.find((f) => existsSync(f) && statSync(f).isFile());
  if (!file) return null;
  const ext = extname(file).toLowerCase();
  if (ext !== ".mp4" && ext !== ".webm") throw new Error(`site: TOUR_VIDEO must be .mp4 or .webm, not ${ext}`);
  const poster = ["tour-poster.webp", "tour-poster.jpg"].map((p) => join(dirname(file), p)).find((p) => existsSync(p));
  return { file, name: `tour${ext}`, type: ext === ".mp4" ? "video/mp4" : "video/webm", seconds: ext === ".mp4" ? mp4Seconds(file) : null, poster };
}

/** The duration in an mp4's mvhd box (in its first 4 MB), for the button's "40-second" label. */
function mp4Seconds(file) {
  const fd = openSync(file, "r");
  const buf = Buffer.alloc(Math.min(statSync(file).size, 4 << 20));
  readSync(fd, buf, 0, buf.length, 0);
  closeSync(fd);
  const i = buf.indexOf("mvhd");
  if (i < 0) return null;
  const v = buf[i + 4];
  const scale = v === 1 ? buf.readUInt32BE(i + 24) : buf.readUInt32BE(i + 16);
  const dur = v === 1 ? Number(buf.readBigUInt64BE(i + 28)) : buf.readUInt32BE(i + 20);
  return scale ? dur / scale : null;
}

/* ------------------------------------------------------------------ page */

function attrsOf(s) {
  const out = {};
  for (const m of s.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) out[m[1]] = m[2] ?? true;
  return out;
}

async function page(tour) {
  const d = await officeData();
  const font = d.FONT();
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const usedLogos = new Set();
  const colour = (n) => d.BRAND[n]?.color ?? d.HOST_BRAND[n]?.color;
  let html = readFileSync(join(SITE, "index.html"), "utf8");

  html = html
    .replace(/<px-text([^>]*)>([\s\S]*?)<\/px-text>/g, (_, a, text) => {
      const at = attrsOf(a);
      const t = unesc(text.trim());
      const sr = at.decorative ? "" : `<span class="sr-only">${esc(t)}</span>`;
      return `${sr}<span class="px${at.class ? ` ${at.class}` : ""}" aria-hidden="true">${pixelText(font, t, { grad: at.grad === true })}</span>`;
    })
    .replace(/<i-city><\/i-city>/g, () => city(d))
    .replace(/<i-moon><\/i-moon>/g, () => moonSvg())
    .replace(/<i-worker([^>]*)><\/i-worker>/g, (_, a) => {
      // the agent's own worker, as the office draws it: a look fixed per agent, cheering
      const at = attrsOf(a);
      const img = d.sprite(d.lookFor(`site-${at.n}`, at.n, false), at.pose ?? "cheer", "down", Number(at.frame ?? 0)).c.img;
      return rgbaSvg(img, `worker${at.class ? ` ${at.class}` : ""}`, Number(at.scale ?? 2));
    })
    .replace(/<i-walker([^>]*)><\/i-walker>/g, (_, a) => {
      const at = attrsOf(a);
      const look = d.lookFor(`site-walker-${at.n}`, at.n, false);
      const frames = [0, 1, 2, 3].map((f) => d.sprite(look, "walk", "right", f).c.img);
      return stripSvg(frames, "walker-strip", 2);
    })
    .replace(/<i-logo([^>]*)><\/i-logo>/g, (_, a) => {
      const at = attrsOf(a);
      usedLogos.add(at.n);
      const c = at.c ?? colour(at.n) ?? "currentColor";
      // near-white brand colours (Command Code, Cursor, Vercel) hover to the text colour on a light page
      const pale = c.startsWith("#") && luminance(c) > 0.7 ? " is-pale" : "";
      const label = at.label ? ` role="img" aria-label="${esc(at.label)}"` : ` aria-hidden="true"`;
      return `<svg class="logo${pale}${at.class ? ` ${at.class}` : ""}" style="--c:${c}"${label} focusable="false"><use href="#lg-${at.n}"/></svg>`;
    })
    .replace(/<i-glyph([^>]*)><\/i-glyph>/g, (_, a) => {
      const at = attrsOf(a);
      const r = d.glyph(at.n);
      if (!r?.rows) throw new Error(`site: no glyph "${at.n}" in web/ui/icons.ts`);
      return pixelArt(r.rows, `glyph${at.class ? ` ${at.class}` : ""}`);
    })
    .replace(/<i-icon([^>]*)><\/i-icon>/g, (_, a) => {
      const at = attrsOf(a);
      const r = d.icon(at.n);
      if (!r?.rows) throw new Error(`site: no icon "${at.n}" in web/ui/icons.ts`);
      return pixelArt(r.rows, `icon${at.class ? ` ${at.class}` : ""}`);
    })
    .replace(/<i-mark([^>]*)><\/i-mark>/g, (_, a) => pixelArt(d.mark().rows, `mark${attrsOf(a).class ? ` ${attrsOf(a).class}` : ""}`));

  // a count of 1 reads weaker than none: below STARS_MIN the button is just "GitHub"
  const n = await stars();
  html = n === null || Number.isNaN(n) || n < STARS_MIN
    ? html.replace(/<!--stars-->[\s\S]*?<!--\/stars-->/g, "").replaceAll("{{gh-label}}", "GitHub")
    : html.replace(/<!--\/?stars-->/g, "").replaceAll("{{stars}}", esc(short(n))).replaceAll("{{gh-label}}", `GitHub, ${n} stars`);

  if (tour) {
    const secs = tour.seconds ? (tour.seconds > 20 ? Math.round(tour.seconds / 5) * 5 : Math.round(tour.seconds)) : null;
    html = html
      .replace(/<!--\/?tour-->/g, "")
      .replaceAll("{{tour-label}}", secs ? `Watch the ${secs}-second tour` : "Watch the tour")
      .replaceAll("{{tour-src}}", `assets/${tour.name}`)
      .replaceAll("{{tour-type}}", tour.type)
      .replaceAll("{{tour-poster}}", tour.poster ? ` poster="assets/${relative(dirname(tour.file), tour.poster)}"` : "");
  } else {
    html = html.replace(/<!--tour-->[\s\S]*?<!--\/tour-->/g, "");
  }

  const sprite = `<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>${[...usedLogos].map(logoSymbol).join("")}</defs></svg>`;
  const abs = (p) => (SITE_URL ? `${SITE_URL}/${p}` : p);
  html = html
    .replace("<!--logo-sprite-->", sprite)
    .replaceAll("{{version}}", esc(pkg.version))
    .replaceAll("{{url}}", esc(SITE_URL ? `${SITE_URL}/` : ""))
    .replace(/\{\{abs:([^}]+)\}\}/g, (_, p) => esc(abs(p.trim())))
    .replace(/[ \t]*<link rel="canonical" href="">\n?/, "")
    .replace(/[ \t]*<meta property="og:url" content="">\n?/, "");
  if (DEV) html = html.replace("</body>", `<script>new EventSource("/__reload").onmessage = () => location.reload();</script>\n</body>`);
  return { html, favicon: markFile(d.mark().rows) };
}

/* ------------------------------------------------------------------ build */

const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 10);
// the office's state module imports node built-ins it never calls in the browser: the shims stand in
const nodeShim = {
  name: "node-shim",
  setup(b) {
    b.onResolve({ filter: /^node:/ }, () => ({ path: join(SITE, "shims/node.ts") }));
  },
};

async function buildSite() {
  const t0 = Date.now();
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, "assets"), { recursive: true });

  const js = await build({
    entryPoints: [join(SITE, "main.ts")],
    outdir: join(OUT, "assets"),
    entryNames: "[name]-[hash]",
    chunkNames: "[name]-[hash]",
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: !DEV,
    sourcemap: DEV ? "inline" : false,
    metafile: true,
    legalComments: "none",
    loader: { ".svg": "text" },
    plugins: [nodeShim],
    logLevel: "warning",
  });
  const outputs = Object.keys(js.metafile.outputs);
  const entry = outputs.find((o) => js.metafile.outputs[o].entryPoint?.endsWith("site/main.ts"));
  const jsName = relative(OUT, resolve(process.cwd(), entry));

  // the tour video is copied on its own (below), never as part of assets/
  if (existsSync(join(SITE, "assets"))) cpSync(join(SITE, "assets"), join(OUT, "assets"), { recursive: true, filter: (src) => !/[\\/]tour\.(mp4|webm)$/.test(src) });
  const tour = tourVideo();
  if (tour) {
    cpSync(tour.file, join(OUT, "assets", tour.name));
    if (tour.poster) cpSync(tour.poster, join(OUT, "assets", relative(dirname(tour.file), tour.poster)));
  }
  const { html: tpl, favicon } = await page(tour);
  const css = (await build({
    stdin: { contents: readFileSync(join(SITE, "styles.css"), "utf8"), loader: "css", resolveDir: SITE },
    write: false,
    bundle: true,
    minify: !DEV,
    // url()s point at files next to the stylesheet in dist/assets
    external: ["*.webp", "*.png", "*.jpg", "*.svg"],
    logLevel: "warning",
  })).outputFiles[0].text;
  const cssName = `assets/site-${hash(css)}.css`;
  writeFileSync(join(OUT, cssName), css);
  writeFileSync(join(OUT, "favicon.svg"), favicon);
  writeFileSync(join(OUT, "index.html"), tpl.replace("{{css}}", cssName).replace("{{js}}", jsName));
  writeFileSync(join(OUT, ".nojekyll"), "");

  const size = (p) => {
    const b = readFileSync(p);
    return { raw: b.length, gz: gzipSync(b, { level: 9 }).length };
  };
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  const rows = [["index.html", join(OUT, "index.html")], [cssName, join(OUT, cssName)], ...outputs.filter((o) => o.endsWith(".js")).map((o) => [relative(OUT, resolve(process.cwd(), o)), resolve(process.cwd(), o)])];
  let total = 0;
  for (const [name, p] of rows) {
    const s = size(p);
    total += s.gz;
    console.log(`  ${name.padEnd(36)} ${kb(s.raw).padStart(10)}  ${kb(s.gz).padStart(9)} gz`);
  }
  console.log(`  ${"html + css + js".padEnd(36)} ${"".padStart(10)}  ${kb(total).padStart(9)} gz`);
  console.log(`  tour video: ${tour ? `${relative(ROOT, tour.file)}${tour.seconds ? ` (${tour.seconds.toFixed(1)} s)` : ""}` : "none, so the page leaves the button out"}`);
  if (!SITE_URL && !DEV) console.log("  note: SITE_URL is not set, so og:image is relative; set it for production");
  console.log(`site built in ${Date.now() - t0} ms -> ${relative(ROOT, OUT) || OUT}/`);
}

/* ------------------------------------------------------------------ dev server */

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".json": "application/json", ".txt": "text/plain", ".ico": "image/x-icon", ".mp4": "video/mp4", ".webm": "video/webm" };

function serve() {
  const clients = new Set();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/__reload") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      res.write(": hi\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    let p = join(OUT, decodeURIComponent(url.pathname));
    if (!p.startsWith(OUT)) return void res.writeHead(403).end();
    if (existsSync(p) && statSync(p).isDirectory()) p = join(p, "index.html");
    if (!existsSync(p)) return void res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    res.writeHead(200, { "content-type": TYPES[extname(p)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(readFileSync(p));
  });
  // PORT is taken as given (and fails if it's busy); without it, the first free port in the range
  const want = Number(process.env.PORT);
  const fixed = Number.isInteger(want) && want > 0 && want < 65536;
  let port = fixed ? want : PORTS[0];
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && !fixed && port < PORTS[1]) server.listen(++port, "127.0.0.1");
    else throw err;
  });
  server.on("listening", () => console.log(`site: http://127.0.0.1:${port}/  (pid ${process.pid}, watching for changes)`));
  server.listen(port, "127.0.0.1");
  return () => {
    for (const c of clients) c.write("data: reload\n\n");
  };
}

await buildSite();
if (DEV) {
  const reload = serve();
  let timer;
  let busy = false;
  const again = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (busy) return again();
      busy = true;
      try {
        await buildSite();
        reload();
      } catch (err) {
        console.error(err.message ?? err);
      }
      busy = false;
    }, 120);
  };
  const WATCH = { site: null, "web/scene": null, "web/ui": null, "src/demo": null, "src/server": null, "src/shared": null, "assets/logos": null };
  for (const [dir, only] of Object.entries(WATCH)) {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) continue;
    watch(abs, { recursive: true }, (_, file) => {
      const f = String(file ?? "");
      if (/(^|[\\/])dist([\\/]|$)/.test(f)) return;
      if (only && !only.test(f)) return;
      again();
    });
  }
}
