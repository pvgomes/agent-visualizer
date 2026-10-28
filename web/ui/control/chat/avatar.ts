/*
 * The agent's own office worker as its chat avatar: the same sprite code and
 * the same look (a hash of the worker id) the scene draws, cropped to head and
 * shoulders and scaled up with crisp pixels. Poses come from the office's
 * vocabulary: standing, a raised hand when it needs you, a cheer, a walk in
 * from the lift. Several frames cycle with a CSS animation (steps), which the
 * reduced-motion rule freezes on the first.
 */
import type { AgentKind } from "../../../../src/shared/events.ts";
import { lookFor, sprite, SPRITE_H, SPRITE_W, type Dir, type Pose } from "../../../scene/sprites.ts";
import { svgEl } from "../../dom.ts";

/** The worker id a session's look was first hashed from, so the avatar matches the desk even after a rename. */
const seeds = new Map<string, string>();

export function seedFor(sessionId: string, workerId: string): string {
  let s = seeds.get(sessionId);
  if (!s) {
    s = workerId || `ctl:${sessionId}`;
    seeds.set(sessionId, s);
  }
  return s;
}

export interface AvatarOpts {
  pose?: Pose;
  dir?: Dir;
  frames?: number[];
  /** "head": head and shoulders, square. "full": the whole worker. */
  crop?: "head" | "full";
  /** CSS pixels per sprite pixel. */
  scale?: number;
  cls?: string;
}

export function avatar(seed: string, agent: AgentKind, o: AvatarOpts = {}): HTMLElement {
  const pose = o.pose ?? "stand";
  const dir = o.dir ?? "down";
  const frames = o.frames?.length ? o.frames : [0];
  // whole device pixels per sprite pixel, so 1.5x is crisp on a retina screen and becomes 2x on a plain one
  const dpr = typeof window !== "undefined" && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  const scale = Math.max(1, Math.round((o.scale ?? 2) * dpr)) / dpr;
  const head = (o.crop ?? "head") === "head";
  const w = SPRITE_W;
  const hgt = head ? 18 : SPRITE_H;
  const box = document.createElement("span");
  box.className = `pxa${frames.length > 1 ? ` pxa-anim pxa-n${frames.length}` : ""}${o.cls ? ` ${o.cls}` : ""}`;
  box.setAttribute("aria-hidden", "true");
  box.style.width = `${w * scale}px`;
  box.style.height = `${hgt * scale}px`;
  try {
    const look = lookFor(seed, agent, false);
    frames.forEach((f, i) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = hgt;
      c.className = `pxa-f pxa-f${i}`;
      const g = c.getContext("2d");
      if (g) {
        g.imageSmoothingEnabled = false;
        g.drawImage(sprite(look, pose, dir, f).c, 0, 0, w, hgt, 0, 0, w, hgt);
      }
      box.append(c);
    });
  } catch {
    box.classList.add("pxa-none");
  }
  return box;
}

/** The office's thought bubble: three pixel dots that take turns. */
export function thoughtBubble(): SVGSVGElement {
  const svg = svgEl("svg", { viewBox: "0 0 13 10", width: 26, height: 20, class: "pxbubble", "shape-rendering": "crispEdges", "aria-hidden": "true", focusable: "false" });
  // outline and fill, drawn as runs of pixels
  const body = "M3 0h7v1h1v1h1v4h-1v1h-1v1h-7v-1h-1v-1h-1v-4h1v-1h1z";
  svg.append(svgEl("path", { d: body, class: "pxbubble-edge" }));
  svg.append(svgEl("path", { d: "M3 1h7v1h1v4h-1v1h-7v-1h-1v-4h1z", class: "pxbubble-fill" }));
  svg.append(svgEl("path", { d: "M1 8h1v1h-1z M0 9h1v1h-1z", class: "pxbubble-edge" }));
  for (let i = 0; i < 3; i++) svg.append(svgEl("rect", { x: 3 + i * 3, y: 4, width: 1, height: 1, class: `pxbubble-dot d${i}` }));
  return svg;
}
