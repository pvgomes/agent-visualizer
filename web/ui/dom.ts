/*
 * Tiny DOM helpers for the chrome. Strings only ever become text nodes or
 * attribute values, never markup: everything after the logos is
 * transcript-derived and treated as untrusted.
 */

type Child = Node | string | number | null | undefined | false;

export interface Props {
  class?: string;
  text?: string;
  attrs?: Record<string, string | number | boolean | undefined>;
  on?: Record<string, (ev: any) => void>;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    if (props.class) el.className = props.class;
    if (props.text != null) el.textContent = props.text;
    if (props.attrs) setAttrs(el, props.attrs);
    if (props.on) for (const [k, fn] of Object.entries(props.on)) el.addEventListener(k, fn);
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    el.append(typeof c === "object" ? c : String(c));
  }
  return el;
}

export function setAttrs(el: Element, attrs: Record<string, string | number | boolean | undefined>): void {
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) el.removeAttribute(k);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
}

/** Set text only when it changed, so per-second refreshes don't thrash layout. */
export function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

const NS = "http://www.w3.org/2000/svg";

export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/*
 * Pixel art from a bitmap: each row is a string, "." is empty, "#" is
 * currentColor and any other character becomes its own path with class
 * px-<char> so CSS can colour it. Runs of a character merge into one rect.
 */
const LAYER: Record<string, string> = { a: "claude", b: "cc", c: "codex", "*": "cursor", "+": "dim", r: "red" };

export function pixels(rows: string[], scale = 2, cls = "px"): SVGSVGElement {
  const w = Math.max(...rows.map((r) => r.length));
  const ht = rows.length;
  const svg = svgEl("svg", {
    viewBox: `0 0 ${w} ${ht}`,
    width: w * scale,
    height: ht * scale,
    fill: "currentColor",
    "shape-rendering": "crispEdges",
    "aria-hidden": "true",
    focusable: "false",
    class: cls,
  });
  const layers = new Map<string, string>();
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      if (ch === "." || ch === " ") {
        x++;
        continue;
      }
      let end = x;
      while (end < row.length && row[end] === ch) end++;
      layers.set(ch, (layers.get(ch) ?? "") + `M${x} ${y}h${end - x}v1h${x - end}z`);
      x = end;
    }
  });
  for (const [ch, d] of layers) {
    const p = svgEl("path", { d });
    if (ch !== "#") p.setAttribute("class", `px-${LAYER[ch] ?? "dim"}`);
    svg.append(p);
  }
  return svg;
}

export const reducedMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/* A constructed stylesheet is not inline CSS, so a strict CSP (no
 * 'unsafe-inline' for styles) still lets it apply. <style> is the fallback. */
export function adoptCss(text: string): void {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(text);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  } catch {
    const style = document.createElement("style");
    style.textContent = text;
    document.head.append(style);
  }
}
