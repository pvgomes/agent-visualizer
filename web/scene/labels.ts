/*
 * The screen-resolution pass: crisp pod signs, mood chips and name tags above
 * heads, status chips under chairs, and the big kaomoji speech bubble during a
 * table flip. Text uses the same bitmap font as the room, scaled by a whole
 * number of device pixels so it stays crisp at any zoom; emoji moods are the
 * only system-font glyphs. The project lives on the pod sign, so a worker's
 * tag names its agent (or role, for interns) or wears the mood it set. Labels
 * are placed greedily by priority (selected, needs-you, flipping, moods,
 * recently active), tried at a few offsets before giving up, and a budget
 * scaled to the screen keeps a crowded office down to the labels that matter.
 * A busy pod's interns (more than CROWD) fold their role tags into one summary
 * chip under the bench ("5 interns · fork ×4 · general-purpose"); each role
 * still shows on hover or when selected. Chips under the chairs stay on the rug.
 * "needs you" chips never pile up: one that finds no free spot (a crowded pod
 * on a phone) joins its pod's "3 need you" chip; the raised hands say who.
 */
import type { AgentKind } from "../../src/shared/events.ts";
import { BRAND } from "../../src/shared/events.ts";
import { C, mix, rgba } from "./palette.ts";
import { FONT, fit, textBitmap } from "./font.ts";
import { drawMark, pixelLogo, type LogoKind } from "./logos.ts";
import type { Camera } from "./camera.ts";
import { brandInk, type Act, type Crew, type Worker } from "./workers.ts";
import { asciiOnly, SIGN_LOGO } from "./room.ts";
import { MARK_STEP, cloudLabel, type Block } from "./layout.ts";
import { bitmap, clamp, internSummary, type Bitmap } from "./util.ts";

const ACT_COL: Record<Act, string> = {
  idle: C.slate3, thinking: C.slate4, read: C.slate5, edit: C.blue4, bash: C.green4, search: C.gold3,
  web: C.blue5, agent: C.plum3, todo: C.gold3, mcp: C.plum3, other: C.blue5, reply: C.white,
  waiting: C.gold3, error: C.red3,
};

/** Short agent names for tags. */
const SHORT: Record<string, string> = {
  claude: "Claude", commandcode: "Command", codex: "Codex", opencode: "opencode", droid: "Droid",
  gemini: "Gemini", qwen: "Qwen", cursor: "Cursor", copilot: "Copilot", other: "Agent",
};

interface Box { x: number; y: number; w: number; h: number; id?: string }
/** More interns than this in one pod and their role tags fold into a summary chip. */
const CROWD = 2;

const hit = (a: Box, b: Box) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/** Pixel pill: a rect with its corners nibbled off. */
function pill(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, s: number, bg: string, edge?: string) {
  if (edge) {
    g.fillStyle = edge;
    g.fillRect(x + s, y - s, w - 2 * s, h + 2 * s);
    g.fillRect(x, y, w, h);
    g.fillRect(x - s, y + s, w + 2 * s, h - 2 * s);
  }
  g.fillStyle = bg;
  g.fillRect(x + s, y, w - 2 * s, h);
  g.fillRect(x, y + s, w, h - 2 * s);
}

function text(g: CanvasRenderingContext2D, s: string, color: string, x: number, y: number, fs: number) {
  const b = textBitmap(FONT(), s, color);
  g.drawImage(b.c, Math.round(x), Math.round(y), b.w * fs, b.h * fs);
  return b.w * fs;
}

function textW(s: string, fs: number) {
  return textBitmap(FONT(), s, C.white).w * fs;
}

const emojiCache = new Map<string, Bitmap>();
/** A colour emoji rendered by the system font, cached per size. */
function emojiBitmap(e: string, px: number): Bitmap {
  const key = e + "|" + px;
  let b = emojiCache.get(key);
  if (!b) {
    if (emojiCache.size > 200) emojiCache.clear();
    b = bitmap(Math.ceil(px * 1.3), Math.ceil(px * 1.3));
    const g = b.g;
    g.imageSmoothingEnabled = true;
    g.font = `${px}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
    g.textBaseline = "middle";
    g.textAlign = "center";
    g.fillText(e, b.w / 2, b.h / 2 + px * 0.06);
    emojiCache.set(key, b);
  }
  return b;
}

export interface LabelOpts {
  dpr: number;
  now: number;
}

export function drawLabels(g: CanvasRenderingContext2D, crew: Crew, cam: Camera, o: LabelOpts): Box[] {
  const { dpr, now } = o;
  const z = cam.z;
  // on a phone, never under ~1.33 CSS px a font pixel: chips have to read at arm's length
  const base = clamp(Math.round(Math.min(1.5 * dpr, Math.max(1.1 * dpr, z * 0.75)) + (z > 7 * dpr ? dpr * 0.5 : 0)), 1, 6);
  const fs = clamp(Math.max(cam.vw / dpr < 640 ? Math.round(dpr * 1.34) : 1, base), 1, 6);
  const edge = 4 * dpr;
  const inX = (x: number, w: number) => Math.round(clamp(x, edge, Math.max(edge, cam.vw - w - edge)));
  const pad = 2 * fs;
  const lineH = 8 * fs;
  const placed: Box[] = [];
  const signs: Box[] = [];
  const hitboxes: Box[] = [];

  /* ---- pod signs: the real vector mark over the pixel one */
  for (const b of crew.layout.blocks.values()) {
    if (b.alpha < 0.3) continue;
    const cloud = b.zone === "cloud";
    const [sx, sy] = cam.toScreen(b.x + SIGN_LOGO.x, b.y + SIGN_LOGO.y);
    if (sx < -200 || sy < -40 || sx > cam.vw + 20 || sy > cam.vh + 20) continue;
    // tags steer clear of the sign; moods and VIPs may still cover it
    const marks = b.mix.slice(0, 3);
    const extra = cloud ? 0 : Math.max(0, marks.length - 1) * MARK_STEP;
    signs.push({ x: sx - 4 * z, y: sy - 3 * z, w: Math.min(b.w, 22 + [...b.label].length * 6 + extra) * z, h: 14 * z });
    const size = SIGN_LOGO.size * z;
    // the cloud-room's sign keeps its pixel cloud
    if (size >= 12 && !cloud) {
      g.globalAlpha = 0.95 * b.alpha;
      if (marks.length > 1) {
        for (let i = marks.length - 1; i >= 0; i--) {
          const a = marks[i]!;
          g.fillStyle = "#14121c";
          g.fillRect(sx + i * MARK_STEP * z - z, sy - z, size + 2 * z, size + 2 * z);
          drawMark(g, a, sx + i * MARK_STEP * z, sy, size, BRAND[a]?.color ?? C.slate4);
        }
      } else drawMark(g, b.agent as LogoKind, sx, sy, size, BRAND[b.agent]?.color ?? C.slate4);
      g.globalAlpha = 1;
    }
  }

  const ws = [...crew.workers.values()].filter((w) => !w.gone && w.alpha > 0.4);
  const crowds = new Map<Block, Worker[]>();
  for (const w of ws) {
    if (!w.intern || w.leaving) continue;
    const list = crowds.get(w.seat.block);
    if (list) list.push(w);
    else crowds.set(w.seat.block, [w]);
  }
  for (const [b, list] of crowds) if (list.length <= CROWD) crowds.delete(b);
  const folded = (w: Worker) => w.intern && crowds.has(w.seat.block);
  /** A chip under the chairs stays on its pod's rug: never below it, never past its ends when it fits. */
  const onRug = (b: Block, c: Box): Box => {
    const [x0, y0] = cam.toScreen(b.x + 1, b.y);
    const [x1, y1] = cam.toScreen(b.x + b.w - 1, b.y + b.h - 2);
    const x = x1 - x0 >= c.w ? clamp(c.x, x0, x1 - c.w) : c.x;
    const y = Math.min(c.y, y1 - c.h);
    return { ...c, x: Math.round(x), y: Math.round(Math.max(y, y0)) };
  };
  const prio = (w: Worker) =>
    (crew.selected === w.id ? 1000 : 0) + (crew.hovered === w.id ? 500 : 0) + (w.show?.kind === "flip" ? 400 : 0) +
    (w.needsHuman ? 300 : 0) + (w.show ? 100 : 0) + (w.mood ? 80 + Math.max(0, 40 - (now - w.mood.at) / 1000) : 0) +
    Math.max(0, 60 - (now - w.summaryAt) / 200) + (w.intern ? 0 : 10);
  ws.sort((a, b) => prio(b) - prio(a));
  /** Pod -> waiting workers whose own "needs you" chip had no free spot, and whether one of the pod's did. */
  const waitFold = new Map<Block, { n: number; shown: boolean; at: Worker }>();
  const waitText = (w: Worker) => (w.summary && !/^(needs you|waiting)$/i.test(w.summary) ? `needs you · ${w.summary}` : "needs you");
  /** Pods too narrow on screen for each waiting worker's chip side by side: one "N need you" chip instead. */
  const foldAll = new Set<Block>();
  {
    const waiting = new Map<Block, Worker[]>();
    for (const w of ws) {
      if (!w.needsHuman || w.leaving || w.show?.kind === "flip" || crew.selected === w.id || crew.hovered === w.id) continue;
      const list = waiting.get(w.seat.block);
      if (list) list.push(w);
      else waiting.set(w.seat.block, [w]);
    }
    for (const [b, list] of waiting) {
      if (list.length < 2) continue;
      const need = list.reduce((sum, w) => sum + textW(fit(FONT(), waitText(w), 26 * 6), fs) + pad * 2 + 6 * fs, 0);
      if (need > (b.w - 4) * z) foldAll.add(b);
    }
  }

  // how many free-floating labels the screen can take before it turns to soup
  const onScreen = ws.filter((w) => { const [x, y] = cam.toScreen(w.x, w.y); return x > -20 && y > -20 && x < cam.vw + 20 && y < cam.vh + 20; }).length;
  const budget = Math.max(4, Math.floor((cam.vw * cam.vh) / (lineH * lineH * 90)));
  const crowded = onScreen * 2 > budget;
  let spent = 0;
  const tryPlace = (cands: Box[], force: boolean): Box | null => {
    for (const c of cands) if (!placed.some((p) => hit(p, c)) && !signs.some((p) => hit(p, c))) return c;
    for (const c of cands) if (force && !placed.some((p) => hit(p, c))) return c;
    return force ? cands[0] : null;
  };
  /* Labels stay inside the office. */
  const inZone = (_w: Worker, b: Box): Box => {
    const r = crew.layout.main;
    const [x0] = cam.toScreen(r.x + 4, 0);
    const [x1] = cam.toScreen(r.x + r.w - 4, 0);
    const zn = { x0: Math.max(edge, x0), x1: Math.min(cam.vw - edge, x1) };
    if (zn.x1 - zn.x0 < b.w) return b;
    return { ...b, x: Math.round(clamp(b.x, zn.x0, zn.x1 - b.w)) };
  };

  for (const w of ws) {
    const sel = crew.selected === w.id;
    const hov = crew.hovered === w.id;
    // Waiting is drawn in the world (raised hand, a bobbing "!") and always gets its chip below; it doesn't force the name tag.
    const vip = sel || hov || w.show?.kind === "flip";
    const h = crew.headPos(w);
    const [hx, hy] = cam.toScreen(h.x, h.y);
    const [, fy] = cam.toScreen(w.x, w.y);
    if (hx < -100 || hx > cam.vw + 100 || hy < -100 || fy > cam.vh + 100) continue;
    const ink = brandInk(w.agent);

    // --- flip speech bubble (the money shot)
    if (w.show?.kind === "flip") {
      const t = now - w.show.t0;
      let say = "";
      if (t > 900 && t < 3900) say = "(╯°□°)╯︵ ┻━┻";
      else if (t >= 4000 && t < 6300) say = "┬─┬ノ( º _ ºノ)";
      if (say) {
        const bs = clamp(Math.max(fs + Math.max(1, Math.round(dpr * 0.5)), Math.round(z * 0.55)), 1, 8);
        const reason = t < 3900 && w.flipReason ? fit(FONT(), asciiOnly(w.flipReason) || w.flipReason, 34 * 6) : "";
        const rs = Math.max(1, bs - 1);
        const tw = Math.max(textW(say, bs), reason ? textW(reason, rs) : 0);
        const bw = tw + 6 * bs, bh = 8 * bs + 6 * bs + (reason ? 9 * rs + bs : 0);
        const pop = clamp((t - (t < 3900 ? 900 : 4000)) / 160, 0, 1);
        // Beside the head, not above it: above is the pod sign, and the sign should stay readable.
        // Right of the worker unless that runs off screen; the tail points back at the face.
        let right = hx + 9 * z + bw < cam.vw - edge;
        if (!right && hx - 9 * z - bw < edge) right = true;
        const bx = inX(right ? hx + 7 * z : hx - 7 * z - bw, bw);
        const by = Math.round(clamp(hy - bh * 0.55 - 2 * bs * pop, edge, cam.vh - bh - edge));
        g.globalAlpha = pop;
        pill(g, bx, by, bw, bh, bs, C.white, C.ink);
        const ty = Math.round(by + bh * 0.55);
        const tx = right ? bx - 2 * bs : bx + bw;
        g.fillStyle = C.ink;
        g.fillRect(tx, ty - bs, 2 * bs, 3 * bs);
        g.fillRect(right ? tx - 2 * bs : tx + 2 * bs, ty, 2 * bs, bs);
        g.fillStyle = C.white;
        g.fillRect(right ? bx - bs : bx + bw - bs, ty, 2 * bs, bs);
        text(g, say, t < 3900 ? C.red2 : C.ink2, bx + 3 * bs, by + 4 * bs, bs);
        if (reason) {
          g.fillStyle = mix(C.white, C.slate4, 0.5);
          g.fillRect(bx + 3 * bs, by + 13 * bs, bw - 6 * bs, Math.max(1, Math.round(bs / 2)));
          text(g, reason, C.ink2, bx + 3 * bs, by + 14 * bs + Math.round(bs / 2), rs);
        }
        g.globalAlpha = 1;
        placed.push({ x: bx, y: by, w: bw, h: bh });
      }
    }
    const flipping = w.show?.kind === "flip";

    // --- the tag above the head: mood if set, else agent / role
    const mood = w.mood;
    const moodText = mood ? asciiOnly(mood.text) || (mood.emoji ? "" : mood.text) : "";
    // in the cloud-room a worker goes by its sandbox's name; an agent known only through herdr, by herdr's name for it
    let name = w.intern ? (w.role || "intern") : w.host && w.host.kind !== "local" ? cloudLabel(w.host) : w.agent === "other" && w.model ? w.model : SHORT[w.agent] ?? BRAND[w.agent]?.name ?? w.agent;
    if (sel || hov) name = `${w.intern ? name : BRAND[w.agent]?.name ?? name}${w.model ? " · " + shortModel(w.model) : ""}`;
    const showMood = !!mood && !flipping;
    const label = showMood && !sel && !hov ? fit(FONT(), moodText, 30 * 6) : fit(FONT(), name, sel || hov ? 40 * 6 : 16 * 6);
    const emojiPx = Math.round(9 * fs);
    const lead = showMood && mood!.emoji && !sel && !hov ? emojiPx + fs * 2 : 7 * fs + 3 * fs;
    const tw = label ? textW(label, fs) : 0;
    const tagW = lead + tw + pad * 2 - (label ? 0 : fs * 2);
    const tagH = lineH + pad + (showMood ? fs * 2 : 0);
    const zoomedIn = 74 * z > 520;
    // the cloud-room mixes agents and sandboxes, so its people carry a name tag when there is room
    const wantTag = !flipping && (vip || showMood || (!folded(w) && (((w.intern || w.remote) && !crowded) || zoomedIn)));
    if (wantTag && (vip || spent < budget)) {
      const lift = (w.needsHuman || (w.seated && w.act === "thinking" && !mood)) ? 20 * z : 4 * z;
      const ty = Math.round(hy - tagH - lift);
      const cands: Box[] = [0, -1, 1, -2].map((k) => inZone(w, {
        x: inX(hx - tagW / 2 + (k === -2 ? 0 : k * tagW * 0.55), tagW),
        y: ty - (k === -2 ? tagH + fs * 2 : 0),
        w: tagW, h: tagH,
      }));
      let tag = tryPlace(cands, false);
      // A mood with no free spot shrinks to its emoji beside the head rather
      // than covering a pod sign or a neighbour's mood; the text stays in the
      // feed and the inspector.
      let compact = false;
      if (!tag && showMood && !sel && !hov && mood!.emoji) {
        const cw = emojiPx + pad * 2;
        const side = 5 * z;
        tag = tryPlace([
          { x: inX(hx - cw / 2, cw), y: ty, w: cw, h: tagH },
          { x: inX(hx + side, cw), y: Math.round(hy - fs), w: cw, h: tagH },
          { x: inX(hx - side - cw, cw), y: Math.round(hy - fs), w: cw, h: tagH },
        ].map((b) => inZone(w, b)), !crowded);
        compact = !!tag;
      }
      if (!tag) tag = tryPlace(cands, sel || hov || (showMood && !crowded && !mood!.emoji));
      if (tag) {
        spent++;
        const rank = Math.max(0, spent - budget * 0.6);
        const fade = vip ? 1 : clamp(1 - rank / Math.max(1, budget), 0.55, 1);
        if (showMood && !sel && !hov) {
          // the agent's own status: brand-tinted, a speech tail down to the head
          const bg = mix(C.ink, ink === C.cc9 || ink === C.cu9 ? C.slate1 : ink, 0.32);
          g.globalAlpha = 0.95 * fade;
          pill(g, tag.x, tag.y, tag.w, tag.h, fs, bg, mix(ink, C.white, 0.2));
          g.fillStyle = mix(ink, C.white, 0.2);
          const tx = clamp(Math.round(hx - fs), tag.x + 2 * fs, tag.x + tag.w - 4 * fs);
          if (!compact) g.fillRect(tx, tag.y + tag.h, 2 * fs, fs * 2);
          g.globalAlpha = fade;
          let x = tag.x + pad;
          if (mood!.emoji) {
            const eb = emojiBitmap(mood!.emoji, emojiPx);
            g.drawImage(eb.c, Math.round(x - (eb.w - emojiPx) / 2), Math.round(tag.y + (tag.h - eb.h) / 2));
            x += emojiPx + fs * 2;
          }
          if (label && !compact) text(g, label, C.white, x, tag.y + Math.round((tag.h - 7 * fs) / 2) - fs, fs);
        } else if (w.intern && !sel && !hov) {
          // an intern's role: a quiet chip, nothing like a pod sign
          g.globalAlpha = 0.78 * fade;
          pill(g, tag.x, tag.y, tag.w, tag.h, fs, mix(C.ink, C.blue2, 0.25));
          g.globalAlpha = fade;
          text(g, label, C.blue5, tag.x + pad + 10 * fs, tag.y + fs, fs);
          g.fillStyle = C.blue5;
          g.fillRect(tag.x + pad + 2 * fs, tag.y + Math.round(tag.h / 2) - fs, 4 * fs, 2 * fs);
        } else {
          const bg = sel ? mix(C.ink, ink === C.cc9 ? C.slate1 : ink, 0.18) : C.ink;
          g.globalAlpha = (sel || hov ? 0.96 : 0.84) * fade;
          pill(g, tag.x, tag.y, tag.w, tag.h, fs, bg, sel ? ink : undefined);
          g.globalAlpha = fade;
          const ly = tag.y + Math.round((tag.h - 7 * fs) / 2);
          if (7 * fs >= 12) drawMark(g, w.agent, tag.x + pad, ly, 7 * fs, BRAND[w.agent]?.color ?? C.slate4);
          else g.drawImage(pixelLogo(w.agent as AgentKind, 7, ink).c, tag.x + pad, ly, 7 * fs, 7 * fs);
          text(g, label, sel ? C.white : C.slate5, tag.x + pad + 10 * fs, tag.y + fs, fs);
          g.fillStyle = ink;
          g.fillRect(tag.x + fs * 2, tag.y + tag.h - fs, tag.w - fs * 4, fs);
        }
        g.globalAlpha = 1;
        tag.id = w.id;
        placed.push(tag);
        hitboxes.push(tag);
      }
    }

    // --- status chip under the chair
    const fresh = now - w.summaryAt < 9000;
    // A waiting worker always gets its chip: it is the one thing on screen the viewer has to act on.
    const wantChip = !w.leaving && !flipping && (w.needsHuman || (w.summary && (vip || (!folded(w) && ((fresh && (!crowded || spent < budget * 0.7)) || zoomedIn)))));
    if (wantChip && (vip || w.needsHuman || spent < budget)) {
      const raw = w.needsHuman ? waitText(w) : w.summary;
      const s = fit(FONT(), raw, (sel ? 44 : 26) * 6);
      const cw = textW(s, fs) + pad * 2 + 4 * fs;
      const cy = Math.round(fy + 6 * z);
      const cands: Box[] = [0, 1, -1].map((k) => onRug(w.seat.block, inZone(w, { x: inX(hx - cw / 2 + k * cw * 0.6, cw), y: cy + (k ? Math.round(lineH * 0.6) : 0), w: cw, h: lineH + pad })));
      // A waiting worker's chip may cover a pod sign, never another label: with no such spot, or in a pod
      // too narrow for them all, it joins the pod's "N need you" chip below instead.
      const pooled = w.needsHuman && !sel && !hov && foldAll.has(w.seat.block);
      const chip = pooled ? null : tryPlace(cands, sel || hov) ?? (w.needsHuman ? cands.find((c) => !placed.some((p) => hit(p, c))) ?? null : null);
      if (w.needsHuman && !sel && !hov) {
        const f = waitFold.get(w.seat.block) ?? { n: 0, shown: false, at: w };
        if (chip) f.shown = true;
        else f.n++;
        waitFold.set(w.seat.block, f);
      }
      if (chip) {
        spent++;
        const pulse = w.needsHuman ? 0.5 + 0.5 * Math.sin(now * 0.008) : 0;
        const bg = w.needsHuman ? mix(ink === C.cc9 ? C.slate2 : ink, C.ink, 0.25 + 0.2 * (1 - pulse)) : C.ink2;
        const age = clamp((now - w.summaryAt) / 9000, 0, 1);
        g.globalAlpha = vip || w.needsHuman ? 0.95 : 0.88 - age * 0.3;
        pill(g, chip.x, chip.y, chip.w, chip.h, fs, bg, w.needsHuman ? rgba(C.white, 0.5 + pulse * 0.5) : undefined);
        g.fillStyle = w.needsHuman ? C.white : ACT_COL[w.act];
        g.fillRect(chip.x + pad, chip.y + pad, 2 * fs, lineH - pad);
        text(g, s, w.needsHuman ? C.white : C.slate5, chip.x + pad + 4 * fs, chip.y + fs, fs);
        g.globalAlpha = 1;
        placed.push(chip);
      }
    }
  }

  /* ---- one "N need you" chip per pod for the waiting workers that had no room of their own */
  for (const [b, f] of waitFold) {
    if (!f.n || b.alpha < 0.5) continue;
    const s = f.shown ? `+${f.n} more need${f.n === 1 ? "s" : ""} you` : f.n === 1 ? "needs you" : `${f.n} need you`;
    const cw = textW(s, fs) + pad * 2 + 4 * fs;
    const [, fy] = cam.toScreen(f.at.x, f.at.y);
    const [px0] = cam.toScreen(b.x + 2, 0);
    const [px1] = cam.toScreen(b.x + b.w - 2, 0);
    const mid = (px0 + px1) / 2;
    const ch = lineH + pad;
    const cy = Math.round(fy + 6 * z);
    const cands: Box[] = [
      { x: Math.round(mid - cw / 2), y: cy, w: cw, h: ch },
      { x: Math.round(px1 - cw), y: cy, w: cw, h: ch },
      { x: Math.round(px0), y: cy, w: cw, h: ch },
      { x: Math.round(mid - cw / 2), y: cy + ch + fs, w: cw, h: ch },
    ].map((c) => onRug(b, { ...c, x: inX(c.x, cw) }));
    // Over a sign if it must, never over another label (the raised hands still say who waits).
    const chip = tryPlace(cands, false) ?? cands.find((c) => !placed.some((p) => hit(p, c)));
    if (!chip) continue;
    const pulse = 0.5 + 0.5 * Math.sin(now * 0.008);
    g.globalAlpha = 0.95 * b.alpha;
    pill(g, chip.x, chip.y, chip.w, chip.h, fs, mix(C.gold2, C.ink, 0.25 + 0.2 * (1 - pulse)), rgba(C.white, 0.5 + pulse * 0.5));
    g.fillStyle = C.white;
    g.fillRect(chip.x + pad, chip.y + pad, 2 * fs, lineH - pad);
    text(g, s, C.white, chip.x + pad + 4 * fs, chip.y + fs, fs);
    g.globalAlpha = 1;
    placed.push(chip);
  }

  /* ---- one summary chip per busy pod, under its interns' bench */
  for (const [b, list] of crowds) {
    if (b.alpha < 0.5) continue;
    let wx0 = Infinity, wx1 = -Infinity, wy = -Infinity;
    for (const w of list) { wx0 = Math.min(wx0, w.seat.x - 7); wx1 = Math.max(wx1, w.seat.x + 7); wy = Math.max(wy, w.seat.y); }
    const [sx0, sy] = cam.toScreen(wx0, wy);
    const [sx1] = cam.toScreen(wx1, wy);
    if (sx1 < -50 || sx0 > cam.vw + 50 || sy < -50 || sy > cam.vh + 50) continue;
    const roles = list.map((w) => asciiOnly(w.role || "") || "intern");
    const chars = (px: number) => Math.max(12, Math.floor((px - pad * 2 - 12 * fs) / (6 * fs)));
    // the whole story if the pod has room, a shorter one that fits under the bench otherwise
    const long = internSummary(roles, chars(b.w * z - 4 * z));
    const short = internSummary(roles, chars(Math.max(sx1 - sx0, 1)));
    const ch = lineH + pad;
    const mid = (sx0 + sx1) / 2;
    const cy = Math.round(sy + 6 * z);
    const [, rugTop] = cam.toScreen(0, b.y + 18);
    const [podR] = cam.toScreen(b.x + b.w - 2, 0);
    const box = (txt: string, x: number | "mid" | "right", y: number) => {
      const w = textW(txt, fs) + pad * 2 + 12 * fs;
      const bx = x === "mid" ? mid - w / 2 : x === "right" ? podR - w : x;
      return { ...onRug(b, { x: Math.round(bx), y, w, h: ch }), text: txt };
    };
    // longest text first, shortened step by step ("… · fork ×4 · +1"), centred under the bench or at the pod's end
    const texts = [long];
    for (let n = long.length - 1; n >= short.length; n--) {
      const t = internSummary(roles, n);
      if (t !== texts[texts.length - 1]) texts.push(t);
    }
    if (texts[texts.length - 1] !== short) texts.push(short);
    const cands = [
      ...texts.flatMap((t) => [box(t, "mid", cy), box(t, "right", cy)]),
      box(long, "mid", cy - ch - fs),
      box(short, "mid", cy - ch - fs),
      // last resort: above the bench, on the rug's top edge, clear of the sign
      box(short, "mid", Math.round(rugTop - ch / 2)),
    ];
    const chip = (tryPlace(cands, false) ?? tryPlace([box(short, "mid", cy)], true)) as (Box & { text?: string }) | null;
    if (!chip) continue;
    g.globalAlpha = 0.9 * b.alpha;
    pill(g, chip.x, chip.y, chip.w, chip.h, fs, mix(C.ink, C.blue2, 0.3), mix(C.blue5, C.ink, 0.45));
    g.globalAlpha = b.alpha;
    // three little heads: a crew, not one person
    g.fillStyle = C.blue5;
    for (let i = 0; i < 3; i++) g.fillRect(chip.x + pad + i * 3 * fs, chip.y + Math.round(chip.h / 2) - fs, 2 * fs, 2 * fs);
    text(g, chip.text ?? short, C.blue5, chip.x + pad + 10 * fs, chip.y + fs, fs);
    g.globalAlpha = 1;
    placed.push(chip);
  }
  return hitboxes;
}

function shortModel(m: string): string {
  const s = m.replace(/^claude-/, "").replace(/-\d{8}$/, "").replace(/^.*\//, "");
  return s.length > 18 ? s.slice(0, 18) : s;
}
