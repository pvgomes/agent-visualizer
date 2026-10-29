/*
 * The shots, as builders every cut shares. Office shots drive the real
 * scene's camera through view() (integer zooms when the camera rests, so
 * the pixel art stays hard-edged) and only add type on top.
 */
import type { Engine, Rect, Shot, View } from "./stage.ts";
import { T } from "./script.ts";
import { BRAND, type AgentKind } from "../../src/shared/events.ts";
import { INK, clamp, dropIn, ease, lerp, px, ramp, textW } from "./type.ts";
import { COMMAND, caption, commandLine, endCard, glitch, night, noise, scrim, sideScrim, terminals, vignette } from "./titles.ts";
import { hash } from "../../web/scene/util.ts";

/* ------------------------------------------------------------ camera */

export const mixView = (a: View, b: View, k: number): View => ({
  x: lerp(a.x, b.x, k),
  y: lerp(a.y, b.y, k),
  z: Math.exp(lerp(Math.log(a.z), Math.log(b.z), k)),
});

/** Keep the frame on the floor plan: no void at the edges unless the room is smaller than the frame. */
export function inside(e: Engine, v: View, r: Rect = e.geo().room, pad = -2): View {
  const hw = e.W / 2 / v.z, hh = e.regionH / 2 / v.z;
  const x = r.w + pad * 2 > hw * 2 ? clamp(v.x, r.x - pad + hw, r.x + r.w + pad - hw) : r.x + r.w / 2;
  const y = r.h + pad * 2 > hh * 2 ? clamp(v.y, r.y - pad + hh, r.y + r.h + pad - hh) : r.y + r.h / 2;
  return { x, y, z: v.z };
}

/** The desk and its worker, framed: monitor above, chair and status chip below. */
export function deskView(e: Engine, name: string, z: number, dx = 0, dy = 0): View {
  const s = e.seat(name);
  return { x: s.deskX + 18 + dx, y: s.deskY + 12 + dy, z };
}

/** Units: 1 at 1080 px on the short side. */
const unit = (e: Engine) => Math.min(e.W, e.H) / 1080;
const tall = (e: Engine) => e.H > e.W * 1.2;
const remember = <T>(e: Engine, key: string, make: () => T): T => (e.s[key] ??= make()) as T;

/* ------------------------------------------------------------ type */

/** A big word on the left (landscape) or the top (portrait), dropping in letter by letter. */
function bigWord(e: Engine, g: CanvasRenderingContext2D, word: string, color: string, lt: number, right = false) {
  const u = unit(e);
  const portrait = tall(e);
  let s = Math.round((portrait ? 15 : 17) * u);
  while (s > 4 && textW(word, s) > e.W * (portrait ? 0.9 : 0.46)) s--;
  const x = portrait ? e.W / 2 : right ? Math.round(e.W * 0.94) : Math.round(e.W * 0.06);
  const y = portrait ? Math.round(e.H * 0.12) : Math.round(e.H * 0.5 - 4.5 * s);
  dropIn(g, word, x, y, s, lt, { color, align: portrait ? "center" : right ? "right" : "left", stagger: 0.026, dur: 0.24, depth: 1 });
}

/** A caption at the bottom; on a narrow frame it breaks into two lines rather than shrinking past legible. */
function lowerThird(e: Engine, g: CanvasRenderingContext2D, text: string, k: number, color: string = INK.white, accent?: string) {
  const u = unit(e);
  const s0 = Math.round((e.W < 1300 ? 6 : 5) * u);
  let lines = [text];
  if (textW(text, s0) > e.W * 0.86) {
    const words = text.split(" ");
    let best = 1, bestD = Infinity;
    for (let i = 1; i < words.length; i++) {
      const d = Math.abs(textW(words.slice(0, i).join(" "), s0) - textW(words.slice(i).join(" "), s0));
      if (d < bestD) { bestD = d; best = i; }
    }
    lines = [words.slice(0, best).join(" "), words.slice(best).join(" ")];
  }
  let s = s0;
  while (s > 2 && Math.max(...lines.map((l) => textW(l, s))) > e.W * 0.86) s--;
  const lineH = 16 * s;
  const y0 = (tall(e) ? e.H * 0.83 : e.H - 21 * s) - (lines.length - 1) * lineH;
  scrim(g, e.W, e.H, clamp(k * 1.5, 0, 1), tall(e) ? 0.26 : lines.length > 1 ? 0.4 : 0.3);
  lines.forEach((l, i) => caption(g, l, e.W / 2, y0 + i * lineH, s, ramp(k, i * 0.15, 1), color, accent));
}

/** Cinema bars, the office's own stream-mode look. Returns the bar height. */
function bars(e: Engine, g: CanvasRenderingContext2D, k: number, frac = tall(e) ? 0.1 : 0.14): number {
  const h = Math.round(e.H * frac * k);
  if (h <= 0) return 0;
  g.fillStyle = "#000";
  g.fillRect(0, 0, e.W, h);
  g.fillRect(0, e.H - h, e.W, h);
  return h;
}

/** Text centred in a bar of height `h` whose top is at `y`, as big as fits. */
function barText(e: Engine, g: CanvasRenderingContext2D, text: string, y: number, h: number, color: string, alpha = 1, maxS = 99) {
  let s = Math.min(maxS, Math.floor((h * 0.6) / 8));
  while (s > 2 && textW(text, s) > e.W * 0.9) s--;
  if (s < 2) return;
  px(g, text, e.W / 2, Math.round(y + (h - 8 * s) / 2 + s * 0.5), s, { align: "center", color, alpha, shadow: null });
}

const at = (e: Engine, lt: number, t: number) => Math.abs(lt - t) < 0.5 / e.fps;

/* ------------------------------------------------------------ shots */

/** "your agents are working." / "where?" over a wall of scrolling terminals. */
export function hook(dur: number, o: { line1At?: number; line2At?: number; outAt?: number; line1?: string; line2?: string } = {}): Shot {
  const l1 = o.line1At ?? 0.25, l2 = o.line2At ?? 1.75, out = o.outAt ?? dur - 0.5;
  return {
    name: "hook",
    dur,
    enter(e) {
      e.cue("hum", { dur: out + 0.3 });
    },
    update(e, lt) {
      if (at(e, lt, l2)) e.cue("thud");
      if (at(e, lt, out)) e.cue("whoosh", { dur: 0.5 });
    },
    draw(e, g, lt) {
      const u = unit(e);
      night(g, e.W, e.H);
      const away = ramp(lt, out, dur);
      terminals(g, e.W, e.H, lt + 3, away, 0.15 + 0.55 * ramp(lt, l2 - 0.1, l2 + 0.15) * (1 - away));
      // line one types on, then is knocked out by line two
      const line1 = o.line1 ?? "your agents are working.";
      // on a tall frame a long line breaks in two rather than shrinking
      const split = (t: string) => {
        const w = t.split(" ");
        const h = Math.ceil(w.length / 2);
        return tall(e) && t.length > 14 ? [w.slice(0, h).join(" "), w.slice(h).join(" ")] : [t];
      };
      const l1s = split(line1);
      let s1 = Math.round((tall(e) ? 9 : 9) * u);
      while (Math.max(...l1s.map((t) => textW(t, s1))) > e.W * 0.86) s1--;
      const k1 = ramp(lt, l1, l1 + 0.9) * (1 - ramp(lt, l2 - 0.04, l2));
      if (k1 > 0) l1s.forEach((t, i) => caption(g, t, e.W / 2, Math.round(e.H / 2 - 6 * s1 + (i - (l1s.length - 1) / 2) * 17 * s1), s1, ease.outCubic(ramp(k1, i * 0.15, 1))));
      // line two slams in
      const line2 = o.line2 ?? "where?";
      const l2s = split(line2);
      const k2 = ramp(lt, l2, l2 + 0.2);
      if (k2 > 0 && away < 0.95 && l2s.length > 1) {
        // two lines on a tall frame
        let s2 = Math.round(16 * u);
        while (Math.max(...l2s.map((t) => textW(t, s2))) > e.W * 0.86) s2--;
        const land = ease.outBack(k2);
        g.fillStyle = `rgba(6,5,11,${0.7 * clamp(k2 * 2, 0, 1) * (1 - ramp(away, 0.4, 0.95))})`;
        g.fillRect(0, Math.round(e.H / 2 - 14 * s2), e.W, 26 * s2);
        l2s.forEach((t, i) => px(g, t, e.W / 2, Math.round(e.H / 2 - 10 * s2 + i * 11 * s2 - Math.round((1 - land) * 3) * s2), s2, { align: "center", color: INK.claude, depth: 1, alpha: 1 - ramp(away, 0.4, 0.95) }));
      } else if (k2 > 0 && away < 0.95) {
        let s2 = Math.round((line2.length > 8 ? (tall(e) ? 12 : 14) : 26) * u);
        while (textW(line2, s2) > e.W * 0.86) s2--;
        const land = ease.outBack(k2);
        const yy = Math.round(e.H / 2 - 4 * s2 - Math.round((1 - land) * 3) * s2);
        const jit = lt - l2 < 0.25 ? Math.round((noise(Math.floor(lt * 60), 3) - 0.5) * 2) * Math.round(s2 / 3) : 0;
        if (line2.length > 8) {
          g.fillStyle = `rgba(6,5,11,${0.7 * clamp(k2 * 2, 0, 1) * (1 - ramp(away, 0.4, 0.95))})`;
          g.fillRect(0, yy - 4 * s2, e.W, 16 * s2);
        }
        px(g, line2, e.W / 2 + jit, yy, s2, { align: "center", color: INK.claude, depth: 1, alpha: 1 - ramp(away, 0.4, 0.95) });
      }
      glitch(g, e.W, e.H, Math.max(0, 1 - Math.abs(lt - l2 - 0.03) / 0.14) * 0.9 + away * 0.5, Math.floor(lt * 30), "#d97757");
      vignette(g, e.W, e.H, 0.55);
    },
  };
}

/** `$ npx @pvgomes/agent-visualizer`, typed, Enter. */
export function command(dur: number, o: { typeAt?: number; enterAt?: number } = {}): Shot {
  const typeAt = o.typeAt ?? 0.25, enterAt = o.enterAt ?? dur - 0.4;
  // a human typist: slightly uneven gaps, deterministic
  const times: number[] = [];
  let acc = typeAt;
  for (let i = 0; i < COMMAND.length; i++) {
    times.push(acc);
    acc += 0.04 + noise(i, 77) * 0.028 + (COMMAND[i] === " " ? 0.05 : 0);
  }
  return {
    name: "command",
    dur,
    update(e, lt) {
      for (const t of times) if (at(e, lt, t)) e.cue("key");
      if (at(e, lt, enterAt)) e.cue("enter");
    },
    draw(e, g, lt) {
      const u = unit(e);
      night(g, e.W, e.H);
      const typed = times.filter((t) => lt >= t).length;
      const pressed = lt >= enterAt;
      let sc = Math.round((tall(e) ? 9 : 12) * u);
      while (textW(`$ ${COMMAND}`, sc) + 8 * sc > e.W * 0.92) sc--;
      const blink = typed < COMMAND.length || Math.floor(lt * 2.4) % 2 === 0;
      const flash = pressed ? 1 - ramp(lt, enterAt, enterAt + 0.3) : 0;
      commandLine(g, e.W / 2, e.H / 2, sc, typed, !pressed && blink, 0.55 + 0.45 * ease.outCubic(ramp(lt, 0, 0.4)) + flash, pressed && flash > 0.5 ? INK.white : INK.cyan);
      vignette(g, e.W, e.H, 0.5);
    },
  };
}

/** The office powers on, tight on the lift; the cast walks out and the camera pulls back to the whole floor. */
export function boot(dur: number, o: { at?: number; holdTight?: number; caption?: string } = {}): Shot {
  const hold = o.holdTight ?? 1.8;
  const pullEnd = dur - 0.9;
  return {
    name: "boot",
    dur,
    at: o.at ?? 0,
    office: true,
    enter(e) {
      e.cue("power");
    },
    update(e, lt) {
      const { main, plan } = e.geo();
      const tz = tall(e) ? 9 : 8;
      const door = plan.elevator;
      const tight = inside(e, { x: door.doorX + (tall(e) ? 0 : 70), y: 62, z: tz }, main);
      // the whole floor, with room under it for the caption; it grows as pods open, so follow it smoothly
      const pad = tall(e) ? 6 : 10;
      const target: View = { ...e.fit({ x: main.x, y: main.y, w: main.w, h: main.h + (o.caption ? 26 : 0) }, pad) };
      const wide = remember(e, "wide", () => ({ ...target }));
      const kf = 1 - Math.exp(-(1 / e.fps) * 4);
      wide.x += (target.x - wide.x) * kf;
      wide.y += (target.y - wide.y) * kf;
      wide.z = Math.exp(Math.log(wide.z) + (Math.log(target.z) - Math.log(wide.z)) * kf);
      const k = ease.inOutCubic(ramp(lt, hold, pullEnd));
      e.view(k <= 0 ? tight : k >= 1 ? wide : mixView(tight, wide, k));
      for (let i = 0; i < 8; i++) if (Math.abs(e.wNow - (T.arrive + i * T.gap)) < 500 / e.fps) e.cue("ding", { vol: i === 0 ? 1 : 0.4 });
      if (at(e, lt, hold)) e.cue("whoosh", { dur: pullEnd - hold, soft: true });
    },
    draw(e, g, lt) {
      // CRT power-on: a bright line opens into the picture
      const k = ease.outExpo(ramp(lt, 0, 0.3));
      if (k < 1) {
        const h = Math.max(2, Math.round(e.H * k));
        const y0 = Math.round((e.H - h) / 2);
        g.save();
        g.fillStyle = "#06050b";
        g.fillRect(0, 0, e.W, y0);
        g.fillRect(0, y0 + h, e.W, e.H - y0 - h);
        g.globalAlpha = 0.85 * (1 - k);
        g.fillStyle = INK.cyan;
        g.fillRect(0, y0, e.W, h);
        g.restore();
      }
      vignette(g, e.W, e.H, 0.35);
      if (o.caption) lowerThird(e, g, o.caption, ramp(lt, pullEnd - 0.7, pullEnd - 0.2));
    },
  };
}

/** One worker, one pose, one word: close on the desk. */
export function pose(dur: number, o: { at?: number; who: string; word: string; color: string; z?: number }): Shot {
  return {
    name: `pose-${o.word}`,
    dur,
    at: o.at,
    office: true,
    enter(e) {
      e.cue("tick");
    },
    update(e, lt) {
      const z = o.z ?? (tall(e) ? 9 : 10);
      // the desk sits off centre, the word gets the other side (whichever the room's walls allow)
      const off = tall(e) ? 0 : (e.W * 0.2) / z;
      const dy = tall(e) ? -(e.H * 0.08) / z : 0;
      const room = e.geo().room;
      const s = e.seat(o.who);
      const right = !tall(e) && s.deskX + 18 - room.x < (e.W / 2 + e.W * 0.2) / z;
      e.s.right = right;
      const sign = right ? 1 : -1;
      const a = deskView(e, o.who, z, sign * off + 3, dy);
      const b = deskView(e, o.who, z, sign * off - 3, dy);
      e.view(inside(e, mixView(a, b, ease.inOutCubic(lt / dur))));
    },
    draw(e, g, lt) {
      vignette(g, e.W, e.H, 0.4);
      if (!o.word) return;
      const right = !!e.s.right;
      if (tall(e)) {
        const grad = g.createLinearGradient(0, 0, 0, e.H * 0.34);
        grad.addColorStop(0, "rgba(6,5,11,0.9)");
        grad.addColorStop(1, "rgba(6,5,11,0)");
        g.fillStyle = grad;
        g.fillRect(0, 0, e.W, e.H * 0.34);
      } else if (right) {
        g.save();
        g.translate(e.W, 0);
        g.scale(-1, 1);
        sideScrim(g, e.W, e.H, 1, 0.58);
        g.restore();
      } else sideScrim(g, e.W, e.H, 1, 0.58);
      bigWord(e, g, o.word, o.color, lt, right);
    },
  };
}

/** The boss points; three interns walk out of the lift to its bench. */
export function interns(dur: number, o: { at: number; text?: string }): Shot {
  return {
    name: "interns",
    dur,
    at: o.at,
    office: true,
    update(e, lt) {
      const { main, plan } = e.geo();
      const s = e.seat("hero");
      const z = tall(e) ? 6 : 6;
      // the lift and the boss's pod in one frame
      const x0 = plan.elevator.x - 6, x1 = s.deskX + 70;
      const a: View = { x: (x0 + x1) / 2 + 8, y: (36 + s.y) / 2 + 10, z };
      const b: View = { ...a, x: a.x - 8 };
      e.view(inside(e, mixView(a, b, ease.inOutCubic(lt / dur)), main));
      for (let i = 0; i < 3; i++) if (Math.abs(e.wNow - (T.interns + 150 + i * 700)) < 500 / e.fps) e.cue("ding", { vol: 0.35 });
    },
    draw(e, g, lt) {
      if (o.text) lowerThird(e, g, o.text, ramp(lt, 0.5, 1.0), INK.white, BRAND.claude.color);
    },
  };
}

/** The boss leans back while its interns work. The caption is the state's own words for it. */
export function supervise(dur: number, o: { at: number }): Shot {
  return {
    name: "supervise",
    dur,
    at: o.at,
    office: true,
    update(e, lt) {
      const z = tall(e) ? 8 : 9;
      const a = deskView(e, "hero", z, 30, 10);
      const b = deskView(e, "hero", z, 22, 10);
      e.view(inside(e, mixView(a, b, ease.inOutCubic(lt / dur))));
    },
    draw(e, g, lt) {
      vignette(g, e.W, e.H, 0.4);
      const text = (e.mem.supervising as string | undefined) ?? "supervising 3 interns";
      lowerThird(e, g, text, ramp(lt, 0.25, 0.7), INK.white, BRAND.claude.color);
    },
  };
}

/** Which way the hero's desk goes over: the scene's own rule (workers.ts startShow), from the worker's id hash. */
const flipSide = (e: Engine) => (hash(e.id("hero")) & 2 ? 1 : -1);

/**
 * The money shot. `$ pnpm test` runs and fails: hit-stop, the camera punches in, bars slam in,
 * the desk goes over in slow motion, (╯°□°)╯︵ ┻━┻. `impact` is the shot-local second the desk leaves the floor.
 */
export function flip(dur: number, o: { impact: number; slow?: number; flipAt?: number; band?: boolean }): Shot {
  const impact = o.impact;
  const slowTo = impact + (o.slow ?? 1.9);
  const flipAt = o.flipAt ?? T.flip;
  return {
    name: "flip",
    dur,
    bed: 0,
    at: flipAt + 600 - impact * 1000,
    office: true,
    speed: (lt) => (lt < impact ? 1 : lt < slowTo ? lerp(0.18, 1, ease.inCubic(ramp(lt, impact, slowTo))) : 1),
    update(e, lt) {
      const s = e.seat("hero");
      const side = flipSide(e);
      // tight on the desk while the suite runs, a punch at the impact, then out wide enough for the arc
      const tightC: View = { x: s.deskX + 18, y: s.deskY + 10, z: tall(e) ? 9 : 9 };
      const wideC: View = { x: s.deskX + 18 + side * 14, y: s.deskY + 4, z: tall(e) ? 6 : 6 };
      let c: View;
      if (lt < impact) {
        const k1 = ease.inOutCubic(ramp(lt, 0, impact - 0.6));
        const k2 = ease.inExpo(ramp(lt, impact - 0.6, impact));
        c = { ...tightC, z: tightC.z * lerp(1, 1.08, k1) * lerp(1, 1.18, k2) };
      } else {
        const k = ease.outCubic(ramp(lt, impact + 0.06, impact + 0.75));
        c = mixView({ ...tightC, z: tightC.z * 1.3 }, wideC, k);
      }
      const z = c.z;
      e.view(inside(e, { ...c, z }));
      e.shake = lt >= impact && lt < impact + 0.4 ? Math.round(16 * (1 - (lt - impact) / 0.4)) : 0;
      if (at(e, lt, impact - 1.0)) e.cue("riser", { dur: 1.0 });
      if (at(e, lt, impact)) {
        e.cue("impact");
        e.cue("slowmo", { dur: slowTo - impact });
      }
      if (at(e, lt, impact + 1.92)) e.cue("crash");
    },
    draw(e, g, lt) {
      // one white frame at impact
      if (lt >= impact && lt < impact + 1 / e.fps) {
        g.fillStyle = "rgba(255,244,230,0.8)";
        g.fillRect(0, 0, e.W, e.H);
      }
      vignette(g, e.W, e.H, lt < impact ? 0.3 + 0.35 * ramp(lt, 0, impact) : 0.45, lt < impact ? "0,0,0" : "70,0,0");
      const kb = o.band ? 0 : ease.outExpo(ramp(lt, impact - 0.02, impact + 0.16));
      const h = bars(e, g, kb);
      if (h > 10) {
        // top: what failed; bottom: the kaomoji, as big as the bar takes
        barText(e, g, "✗  $ pnpm test", 0, h, INK.red, ramp(lt, impact + 0.1, impact + 0.3), Math.round(4 * unit(e)));
        const jx = lt < impact + 0.5 ? Math.round((noise(Math.floor(lt * 60), 11) - 0.5) * 2) * 4 : 0;
        g.save();
        g.translate(jx, 0);
        barText(e, g, "(╯°□°)╯︵ ┻━┻", e.H - h, h, INK.claude, ramp(lt, impact + 0.04, impact + 0.12));
        g.restore();
      }
    },
    exit(e) {
      e.shake = 0;
    },
  };
}

/** Later: the desk is set back, ┬─┬ノ( º _ºノ). The bars stay a moment, then open. */
export function setBack(dur: number, o: { text?: string; from?: number; flipAt?: number } = {}): Shot {
  return {
    name: "set-back",
    dur,
    at: (o.flipAt ?? T.flip) + (o.from ?? 3_700),
    office: true,
    update(e, lt) {
      const z = tall(e) ? 7 : 7;
      const s = e.seat("hero");
      const a: View = { x: s.deskX + 18, y: s.deskY + 16, z };
      const b: View = { ...a, y: a.y - 4 };
      e.view(inside(e, mixView(a, b, ease.inOutCubic(lt / dur))));
      if (at(e, lt, 0.5)) e.cue("thud", { vol: 0.3 });
    },
    draw(e, g, lt) {
      vignette(g, e.W, e.H, 0.4);
      const h = bars(e, g, 1 - ease.inOutCubic(ramp(lt, dur - 0.35, dur)));
      if (o.text && h > 10) barText(e, g, o.text, e.H - h, h, INK.white, ramp(lt, 0.15, 0.45), Math.round(5 * unit(e)));
    },
  };
}

/** Sandboxes join the office's glass cloud-room; the camera pulls back to take it all in. */
export function cloud(dur: number, o: { at?: number; text?: string; beamAt?: number } = {}): Shot {
  const beamAt = o.beamAt ?? 0.5;
  const atW = o.at ?? T.cloud - beamAt * 1000;
  return {
    name: "cloud",
    dur,
    at: atW,
    office: true,
    update(e, lt) {
      const { room, main } = e.geo();
      const pad = tall(e) ? 6 : 10;
      const fitR = (r: Rect) => e.fit({ x: r.x, y: r.y, w: r.w, h: r.h + (o.text ? 24 : 0) }, pad);
      const start = remember(e, "start", () => fitR(main));
      const cur = remember(e, "cur", () => ({ ...start }));
      // the arrivals, close: the cloud-room; then out to the whole floor
      const pods = e.cloudPods();
      const close = pods ? inside(e, { ...e.fit(pods, 18), z: Math.min(e.fit(pods, 18).z, tall(e) ? 6 : 5) }, room, 0) : null;
      const target = lt < beamAt ? start : lt < dur - 1.7 && close ? close : fitR(room);
      // critically damped follow, so the growing room never jerks the frame
      const k = 1 - Math.exp(-(1 / e.fps) * (lt < dur - 1.7 ? 4.5 : 3.2));
      cur.x += (target.x - cur.x) * k;
      cur.y += (target.y - cur.y) * k;
      cur.z = Math.exp(Math.log(cur.z) + (Math.log(target.z) - Math.log(cur.z)) * k);
      e.view(cur);
      for (let i = 0; i < 3; i++) if (Math.abs(e.wNow - (T.cloud + i * T.cloudGap)) < 500 / e.fps) e.cue("beam", { pitch: i });
    },
    draw(e, g, lt) {
      vignette(g, e.W, e.H, 0.35);
      if (o.text) lowerThird(e, g, o.text, ramp(lt, beamAt + 0.9, beamAt + 1.4), INK.white, INK.cyan);
    },
  };
}

/** The whole floor; press C for the CRT. */
export function crtShot(dur: number, o: { at?: number; crtAt?: number } = {}): Shot {
  const cAt = o.crtAt ?? 0.8;
  let crt = false;
  return {
    name: "crt",
    dur,
    at: o.at,
    office: true,
    enter() {
      crt = false;
    },
    update(e, lt) {
      const { room } = e.geo();
      const v = e.fit(room, 6);
      e.view({ ...v, z: v.z * lerp(1, 1.06, ease.inOutCubic(lt / dur)) });
      if (lt >= cAt && !crt) {
        crt = true;
        e.scene?.setCrt(true);
        e.cue("crt");
        e.cue("keycap");
      }
    },
    draw(e, g, lt) {
      const u = unit(e);
      const s = Math.max(2, Math.round(5 * u));
      const keys: [string, string, number][] = [["C", "crt", cAt]];
      const y = tall(e) ? e.H * 0.82 : e.H - 22 * s;
      const gapX = 8 * s;
      const items = keys.map(([k, label]) => ({ k, label, w: 13 * s + 4 * s + textW(label, s) }));
      const total = items.reduce((n, it) => n + it.w, 0) + gapX * (items.length - 1);
      let x = e.W / 2 - total / 2;
      keys.forEach(([k, label, at], i) => {
        const kk = ease.outBack(ramp(lt, at - 0.12, at + 0.12));
        if (kk > 0) {
          const down = lt >= at && lt < at + 0.12 ? s : 0;
          const a = clamp(kk, 0, 1);
          g.globalAlpha = a;
          g.fillStyle = "#06050b";
          g.fillRect(Math.round(x), Math.round(y + s), 13 * s, 13 * s);
          g.fillStyle = "#f5f1e8";
          g.fillRect(Math.round(x), Math.round(y + down), 13 * s, 12 * s);
          g.fillStyle = "#c9c7d8";
          g.fillRect(Math.round(x), Math.round(y + down + 11 * s), 13 * s, s);
          g.globalAlpha = 1;
          px(g, k, x + 6.5 * s, y + down + 2 * s, s, { align: "center", color: "#0e0d16", shadow: null, alpha: a });
          px(g, label, x + 17 * s, y + 3 * s, s, { color: INK.white, alpha: a });
        }
        x += items[i]!.w + gapX;
      });
    },
  };
}

/** The end card: the wordmark, the command, the repo. */
export function end(dur: number): Shot {
  return {
    name: "end",
    dur,
    enter(e) {
      e.cue("chord", { dur });
    },
    draw(e, g, lt) {
      night(g, e.W, e.H);
      endCard(g, e.W, e.H, lt, unit(e));
      vignette(g, e.W, e.H, 0.5);
      // fade in from the last shot, and out at the very end
      const fin = ramp(lt, 0, 0.18);
      if (fin < 1) {
        g.fillStyle = `rgba(6,5,11,${1 - fin})`;
        g.fillRect(0, 0, e.W, e.H);
      }
    },
  };
}

export const COLORS: Record<string, string> = { ...Object.fromEntries((Object.keys(BRAND) as AgentKind[]).map((a) => [a, BRAND[a].color])) };
