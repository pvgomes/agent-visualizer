/*
 * The shots that aren't the office: the terminal wall of the hook, the
 * command being typed, the end card. Drawn on the stage canvas in the
 * office's bitmap font and palette; nothing here pretends to be the office.
 */
import { BRAND, HOST_BRAND, type AgentKind } from "../../src/shared/events.ts";
import { INK, brandMark, clamp, dropIn, ease, logo, px, ramp, textW } from "./type.ts";

/* -------------------------------------------------------------- helpers */

/** Deterministic hash noise in [0, 1). */
export const noise = (a: number, b = 0) => {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return ((h >>> 0) % 100000) / 100000;
};

export function night(g: CanvasRenderingContext2D, W: number, H: number, alpha = 1) {
  g.save();
  g.globalAlpha = alpha;
  const grad = g.createRadialGradient(W / 2, H * 0.45, 10, W / 2, H / 2, Math.hypot(W, H) * 0.6);
  grad.addColorStop(0, "#1a1730");
  grad.addColorStop(1, INK.night);
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  // the office's void is a blueprint: a faint dot grid
  g.fillStyle = "rgba(255,255,255,0.035)";
  const step = 48;
  for (let y = step / 2; y < H; y += step) for (let x = step / 2; x < W; x += step) g.fillRect(Math.round(x), Math.round(y), 2, 2);
  g.restore();
}

/** Horizontal slices of the canvas pushed sideways: a glitch, at stage size. */
export function glitch(g: CanvasRenderingContext2D, W: number, H: number, amt: number, seed: number, tint?: string) {
  if (amt < 0.02) return;
  const c = g.canvas;
  for (let i = 0; i < 9; i++) {
    const y = Math.floor(noise(seed, i) * H);
    const h = Math.max(4, Math.floor((6 + noise(seed + 7, i) * 40) * amt));
    const off = Math.round((noise(seed + 3, i) - 0.5) * 140 * amt);
    g.drawImage(c, 0, y, W, h, off, y, W, h);
  }
  if (tint) {
    g.fillStyle = tint;
    g.globalAlpha = 0.08 * amt;
    g.fillRect(0, 0, W, H);
    g.globalAlpha = 1;
  }
}

export function vignette(g: CanvasRenderingContext2D, W: number, H: number, k: number, color = "0,0,0") {
  if (k <= 0) return;
  const grad = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.hypot(W, H) * 0.62);
  grad.addColorStop(0, `rgba(${color},0)`);
  grad.addColorStop(1, `rgba(${color},${k})`);
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
}

/** A dark gradient up from the bottom edge, so a caption reads over a busy floor. */
export function scrim(g: CanvasRenderingContext2D, W: number, H: number, k: number, frac = 0.3) {
  if (k <= 0) return;
  const y0 = H * (1 - frac);
  const grad = g.createLinearGradient(0, y0, 0, H);
  grad.addColorStop(0, "rgba(6,5,11,0)");
  grad.addColorStop(0.55, `rgba(6,5,11,${0.62 * k})`);
  grad.addColorStop(1, `rgba(6,5,11,${0.9 * k})`);
  g.fillStyle = grad;
  g.fillRect(0, y0, W, H - y0);
}

/** The same from one side (the left in landscape), for a big word over the office. */
export function sideScrim(g: CanvasRenderingContext2D, W: number, H: number, k: number, frac = 0.55) {
  if (k <= 0) return;
  const grad = g.createLinearGradient(0, 0, W * frac, 0);
  grad.addColorStop(0, `rgba(6,5,11,${0.9 * k})`);
  grad.addColorStop(0.6, `rgba(6,5,11,${0.7 * k})`);
  grad.addColorStop(1, "rgba(6,5,11,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, W * frac, H);
}

/** A dark plate behind type, with the office's nibbled pixel corners. */
export function plate(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, s: number, fill = "rgba(11,10,19,0.88)", edge?: string) {
  x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
  if (edge) {
    g.fillStyle = edge;
    g.fillRect(x + s, y - s, w - 2 * s, h + 2 * s);
    g.fillRect(x - s, y + s, w + 2 * s, h - 2 * s);
    g.fillRect(x, y, w, h);
  }
  g.fillStyle = fill;
  g.fillRect(x + s, y, w - 2 * s, h);
  g.fillRect(x, y + s, w, h - 2 * s);
}

/** A caption on a plate, centred at (cx, y). */
export function caption(g: CanvasRenderingContext2D, text: string, cx: number, y: number, scale: number, k: number, color: string = INK.white, accent?: string) {
  if (k <= 0) return;
  const s = Math.round(scale);
  const w = textW(text, s);
  const padX = 5 * s, padY = 4 * s;
  const rise = Math.round((1 - ease.outCubic(k)) * 4) * s;
  g.save();
  g.globalAlpha = clamp(k * 1.5, 0, 1);
  plate(g, cx - w / 2 - padX, y + rise, w + padX * 2, 8 * s + padY * 2 - s, s, "rgba(11,10,19,0.9)", accent);
  g.restore();
  px(g, text, cx, y + rise + padY, s, { align: "center", color, reveal: ease.outCubic(clamp(k * 1.4, 0, 1)), alpha: clamp(k * 2, 0, 1) });
}

/* -------------------------------------------------------------- the hook */

const PANES: { agent: AgentKind; title: string; lines: string[] }[] = [
  { agent: "claude", title: "claude  api-gateway", lines: ["Read router.ts", "Search src/routes/**", "Edit rate-limit.ts", "Edit middleware.ts", "$ pnpm lint", "Thinking...", "Read upstream.ts", "Edit auth.ts", "$ pnpm test"] },
  { agent: "cursor", title: "cursor  payments-svc", lines: ["read_file ledger.go", "edit_file refund.go", "grep *.go", "$ go build", "Thinking...", "todo_write 4 items", "edit_file webhook.go", "$ go test"] },
  { agent: "cursor", title: "cursor  Onboarding", lines: ["read_file train.py", "read_file features.py", "edit_file loader.py", "$ uv run", "Thinking...", "web_search pytorch.org", "edit_file eval.py", "$ pytest"] },
  { agent: "cursor", title: "cursor  docs-site", lines: ["read_file index.mdx", "grep *.mdx", "edit_file sidebar.ts", "$ npx astro", "Thinking...", "web_search docs.astro.build", "edit_file search.ts", "$ npm test"] },
  { agent: "claude", title: "claude  portfolio", lines: ["Read page.tsx", "Edit Hero.tsx", "Search components/**", "$ pnpm build", "Thinking...", "Edit globals.css", "$ pnpm lint", "$ pnpm test"] },
  { agent: "cursor", title: "cursor  GA-task", lines: ["read_file convert.py", "grep *.py", "edit_file dither.py", "$ ruff check", "Thinking...", "edit_file palette.py", "$ pytest"] },
  { agent: "claude", title: "claude  data-etl", lines: ["Read extract.py", "Search dags/**", "Edit transform.py", "$ dbt run", "Thinking...", "Edit load.py", "$ pytest"] },
  { agent: "claude", title: "claude  auth-svc", lines: ["Read session.go", "Search *.go", "Edit jwt.go", "$ go vet", "Thinking...", "Edit oauth.go", "$ go test"] },
  { agent: "claude", title: "claude  search-api  (devops)", lines: ["Read ranker.ts", "Search *.ts", "Edit tokenizer.ts", "$ bunx tsc", "Thinking...", "Edit cache.ts", "$ bun test"] },
];

const RESULT = ["  41 passed", "  1 failed", "  (no output)", "  3 files changed", "  waiting for you", "  ok"];

function paneLine(p: number, i: number): { text: string; color: string } {
  const pane = PANES[p % PANES.length]!;
  const n = noise(p * 131 + 7, i);
  if (n < 0.18) {
    const r = RESULT[Math.floor(noise(p, i * 3) * RESULT.length)]!;
    return { text: r, color: r.includes("failed") ? INK.red : r.includes("passed") || r === "  ok" ? INK.green : r.includes("waiting") ? INK.amber : "#6f6a86" };
  }
  const text = pane.lines[Math.floor(noise(p + 3, i) * pane.lines.length)]!;
  return { text, color: text.startsWith("$") ? "#c9c7d8" : text.startsWith("Thinking") ? "#706e8a" : "#9b99b2" };
}

/** The wall of terminals: nine agents, every one scrolling. `t` in seconds; `out` 0..1 slides the panes away. */
export function terminals(g: CanvasRenderingContext2D, W: number, H: number, t: number, out: number, dim: number) {
  const tall = H > W * 1.2;
  const cols = tall ? 2 : 3, rows = tall ? 5 : 3;
  const gap = 10;
  const pw = (W - gap * (cols + 1)) / cols;
  const ph = (H - gap * (rows + 1)) / rows;
  const s = 2;
  const lh = 11 * s;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const p = r * cols + c;
      const pane = PANES[p % PANES.length]!;
      const col = BRAND[pane.agent].color;
      // each pane leaves the frame the way it is nearest to
      const dx = (c - (cols - 1) / 2) || (r % 2 ? 0.6 : -0.6);
      const dy = (r - (rows - 1) / 2) * 0.6;
      const k = ease.inExpo(clamp(out * 1.15 - noise(p, 99) * 0.15, 0, 1));
      const x = Math.round(gap + c * (pw + gap) + dx * W * 0.9 * k);
      const y = Math.round(gap + r * (ph + gap) + dy * H * 0.9 * k);
      g.save();
      g.beginPath();
      g.rect(x, y, Math.round(pw), Math.round(ph));
      g.clip();
      g.fillStyle = "#0e0d16";
      g.fillRect(x, y, pw, ph);
      // title bar
      g.fillStyle = "#1a1926";
      g.fillRect(x, y, pw, 13 * s);
      for (let d = 0; d < 3; d++) {
        g.fillStyle = ["#f2625a", "#ffd36c", "#52d6a0"][d]!;
        g.fillRect(x + 5 * s + d * 5 * s, y + 5 * s, 3 * s, 3 * s);
      }
      logo(g, pane.agent, x + 22 * s, y + 3 * s, 7, s, col);
      px(g, pane.title, x + 32 * s, y + 3 * s, s, { color: "#c9c7d8", shadow: null });
      // the log, scrolling at its own pace
      const speed = 70 + noise(p, 5) * 140;
      const scroll = t * speed + noise(p, 1) * 400;
      const first = Math.floor(scroll / lh);
      const off = scroll - first * lh;
      const visible = Math.ceil((ph - 15 * s) / lh) + 1;
      for (let i = 0; i < visible; i++) {
        const li = first + i;
        const ln = paneLine(p, li);
        const ly = Math.round(y + 16 * s + i * lh - off);
        const flick = noise(p * 13 + li, Math.floor(t * 20)) < 0.04 ? 0.35 : 1;
        px(g, ln.text, x + 6 * s, ly, s, { color: ln.color, shadow: null, alpha: flick });
      }
      // a blinking cursor at the bottom
      if (Math.floor(t * 3 + p) % 2 === 0) {
        g.fillStyle = col;
        g.fillRect(x + 6 * s, y + ph - 10 * s, 5 * s, 7 * s);
      }
      g.restore();
      // pane edge in the agent's colour
      g.strokeStyle = col;
      g.globalAlpha = 0.45;
      g.lineWidth = 2;
      g.strokeRect(x + 1, y + 1, pw - 2, ph - 2);
      g.globalAlpha = 1;
    }
  }
  if (dim > 0) {
    g.fillStyle = `rgba(6,5,11,${dim})`;
    g.fillRect(0, 0, W, H);
  }
}

/* -------------------------------------------------------------- the command */

export const COMMAND = "npx @pvgomes/agent-visualizer";

/** `$ npx @pvgomes/agent-visualizer`, typed in neon cyan. `typed` is how many characters show; `glow` 0..1. */
export function commandLine(g: CanvasRenderingContext2D, cx: number, cy: number, scale: number, typed: number, cursorOn: boolean, glow: number, color: string = INK.cyan) {
  const s = Math.round(scale);
  const full = `$ ${COMMAND}`;
  const w = textW(full, s) + 7 * s;
  const x = Math.round(cx - w / 2);
  const y = Math.round(cy - 4 * s);
  const shown = full.slice(0, 2 + Math.max(0, Math.min(COMMAND.length, Math.floor(typed))));
  g.save();
  if (glow > 0) {
    g.shadowColor = color;
    g.shadowBlur = 28 * glow;
    px(g, shown, x, y, s, { color, shadow: null, alpha: 0.55 * glow });
    g.shadowBlur = 0;
  }
  g.restore();
  px(g, "$ ", x, y, s, { color: INK.dim, shadow: null });
  const typedW = px(g, shown.slice(2), x + textW("$ ", s) + s, y, s, { color, shadow: null });
  if (cursorOn) {
    g.fillStyle = color;
    g.fillRect(x + textW("$ ", s) + s + (shown.length > 2 ? typedW + s : 0), y, 5 * s, 8 * s);
  }
  return { x, y, w };
}

/* -------------------------------------------------------------- the end card */

const AGENTS: AgentKind[] = ["claude", "cursor"];
const HOSTS = ["vercel", "railway"] as const;

export function endCard(g: CanvasRenderingContext2D, W: number, H: number, t: number, u: number, o: { tagline?: string; agents?: AgentKind[]; tagScale?: number; tagColor?: string } = {}) {
  const agents = o.agents ?? AGENTS;
  const tall = H > W * 1.2;
  const narrow = W < 1300;
  const cx = W / 2;
  const big = Math.round((tall ? 11 : narrow ? 10 : 13) * u);
  const mid = Math.round((tall ? 7 : narrow ? 6 : 8) * u);
  const small = Math.max(2, Math.round((tall ? 6 : narrow ? 5 : 5.5) * u));
  const ls = Math.max(2, Math.round((tall ? 5 : 4) * u));
  const tagS = o.tagScale ? Math.max(2, Math.round(o.tagScale * u)) : small;
  const tag = o.tagline ?? "your coding agents, working in a pixel office";
  const words = tag.split(" ");
  const half = Math.ceil(words.length / 2);
  const tagLines = textW(tag, tagS) < W * 0.92 ? [tag] : [words.slice(0, half).join(" "), words.slice(half).join(" ")];
  let cs = Math.round((tall ? 7 : narrow ? 6 : 8) * u);
  while (cs > 3 && textW(`$ ${COMMAND}`, cs) + 8 * cs > W * 0.92) cs--;
  // stack it all, then centre the stack
  const hTitle = 8 * big, hTag = tagLines.length * 11 * tagS, hCmd = 8 * mid, hRepo = 8 * small, hLogo = 9 * ls;
  const gaps = [3 * big, 5 * mid, 6 * mid, 5 * small, 10 * small];
  const total = hTitle + hTag + hCmd + hRepo * 2 + hLogo + gaps.reduce((a, b) => a + b, 0);
  let y = Math.round((H - total) / 2 - (tall ? H * 0.03 : 0));
  // the wordmark: the brand mark, then "agent-visualizer"
  const markS = Math.round(big * 0.9);
  const titleW = textW("agent-visualizer", big);
  const rowW = 12 * markS + 5 * big + titleW;
  const kT = ease.outCubic(ramp(t, 0.0, 0.5));
  const x0 = cx - rowW / 2;
  brandMark(g, x0, y - Math.round(markS * 0.5) + Math.round((1 - kT) * 6) * markS, markS, kT);
  dropIn(g, "agent-visualizer", x0 + 12 * markS + 5 * big, y, big, t - 0.08, { color: INK.white, stagger: 0.025, depth: 1 });
  y += hTitle + gaps[0]!;
  tagLines.forEach((l, i) => px(g, l, cx, y + i * 11 * tagS, tagS, { align: "center", color: o.tagColor ?? INK.dim, alpha: ease.outCubic(ramp(t, 0.5, 1.0)), reveal: ease.outCubic(ramp(t, 0.45 + i * 0.1, 1.1 + i * 0.1)) }));
  y += hTag + gaps[1]!;
  // the command, in neon, with the cursor from the opening
  const typed = ramp(t, 0.7, 1.5) * COMMAND.length;
  commandLine(g, cx, y + 4 * mid, Math.min(mid, cs), typed, Math.floor(t * 2.2) % 2 === 0 || t < 1.6, ease.outCubic(ramp(t, 1.4, 2.0)));
  y += hCmd + gaps[2]!;
  // the repository and the tagline under it
  let rs = small;
  while (rs > 2 && textW("github.com/pvgomes/agent-visualizer", rs) > W * 0.9) rs--;
  px(g, "github.com/pvgomes/agent-visualizer", cx, y, rs, { align: "center", color: INK.white, alpha: ease.outCubic(ramp(t, 1.5, 2.0)) });
  y += hRepo + gaps[3]!;
  px(g, "no required dependencies", cx, y, rs, { align: "center", color: INK.dim, alpha: ease.outCubic(ramp(t, 1.75, 2.25)) });
  y += hRepo + gaps[4]!;
  // every agent and platform it watches, in their own colours
  const cell = 9;
  const step = cell * ls + 7 * ls;
  const n = agents.length + HOSTS.length;
  let lx = Math.round(cx - (n * step + 10 * ls - 7 * ls) / 2);
  agents.forEach((a, i) => {
    const k = ease.outBack(ramp(t, 2.0 + i * 0.05, 2.35 + i * 0.05));
    if (k > 0) logo(g, a, lx, y + Math.round((1 - k) * 4) * ls, cell, ls, BRAND[a].color, clamp(k, 0, 1));
    lx += step;
  });
  lx += 10 * ls;
  HOSTS.forEach((h, i) => {
    const k = ease.outBack(ramp(t, 2.45 + i * 0.05, 2.8 + i * 0.05));
    if (k > 0) logo(g, h, lx, y + Math.round((1 - k) * 4) * ls, cell, ls, HOST_BRAND[h].color, clamp(k, 0, 1));
    lx += step;
  });
}
