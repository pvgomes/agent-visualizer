/*
 * The activity feed: the right-hand sidebar on desktop, a bottom sheet on
 * phones. Newest first, capped at MAX_ROWS, repeated actions coalesce into
 * one row with a ×n count. Clicking a row selects and focuses that worker.
 */
import type { OfficeEvent } from "../../src/shared/events.ts";
import { h, setText, svgEl } from "./dom.ts";
import { ago, describe, parseTs } from "./format.ts";
import { glyph, icon } from "./icons.ts";
import { agentName, hostBadge, hostName, isRemote, logo } from "./logos.ts";
import type { OfficeModel } from "./state.ts";

const MAX_ROWS = 150;
const BUCKETS = 30;
const BUCKET_MS = 4000;

interface RowMeta {
  el: HTMLLIElement;
  workerId: string;
  key: string;
  ts: number;
  count: number;
  agoEl: HTMLElement;
  countEl: HTMLElement;
}

export interface Feed {
  el: HTMLElement;
  tab: HTMLElement;
  reset(events: OfficeEvent[], model: OfficeModel): void;
  push(e: OfficeEvent, model: OfficeModel): void;
  highlight(workerId: string | null): void;
  /** OfficeEvent.replaces: rows of `from` now belong to `to`. */
  rename(from: string, to: string): void;
  setOpen(open: boolean): void;
  isOpen(): boolean;
  tick(now: number): void;
}

export function createFeed(opts: { onPick(workerId: string): void; onToggle(): void }): Feed {
  const list = h("ol", { class: "feed-list", attrs: { "aria-label": "Recent activity" } });
  const empty = h("p", { class: "feed-empty", text: "Quiet for now. Every tool call lands here the moment it happens." });
  const rate = h("span", { class: "feed-rate", text: "0/min" });

  const spark = svgEl("svg", { class: "spark", viewBox: `0 0 ${BUCKETS * 3 - 1} 12`, width: BUCKETS * 3 - 1, height: 12, "aria-hidden": "true", "shape-rendering": "crispEdges" });
  const bars: SVGRectElement[] = [];
  for (let i = 0; i < BUCKETS; i++) {
    const r = svgEl("rect", { x: i * 3, y: 11, width: 2, height: 1 });
    bars.push(r);
    spark.append(r);
  }
  const buckets = new Array<number>(BUCKETS).fill(0);
  let bucketStart = Date.now();

  const collapse = h(
    "button",
    { class: "icon-btn feed-collapse", attrs: { type: "button", "aria-label": "Hide activity", "aria-keyshortcuts": "\\", title: "Hide activity  \\" }, on: { click: () => opts.onToggle() } },
    glyph("close", 1),
  );
  const head = h(
    "div",
    { class: "feed-head" },
    h("span", { class: "grabber", attrs: { "aria-hidden": "true" } }),
    h("span", { class: "panel-label", text: "activity" }),
    spark,
    rate,
    collapse,
  );
  // On phones the header is the sheet's handle.
  head.addEventListener("click", (ev) => {
    if (ev.target instanceof Element && ev.target.closest(".feed-collapse")) return;
    if (matchMedia("(max-width: 640px)").matches) opts.onToggle();
  });

  const el = h("aside", { class: "feed glass is-empty", attrs: { "aria-label": "Activity feed" } }, head, h("div", { class: "feed-scroll" }, list, empty));

  const badge = h("span", { class: "tab-badge", text: "" });
  const tab = h(
    "button",
    { class: "feed-tab glass", attrs: { type: "button", "aria-label": "Show activity", "aria-keyshortcuts": "\\" }, on: { click: () => opts.onToggle() } },
    icon("feed", 1),
    h("span", { class: "panel-label", text: "activity" }),
    badge,
  );

  const rows: RowMeta[] = [];
  let open = true;
  let unread = 0;
  let selected: string | null = null;

  function roll(now: number): void {
    if (now - bucketStart >= BUCKET_MS * BUCKETS) {
      buckets.fill(0);
      bucketStart = now - (now % BUCKET_MS);
      return;
    }
    while (now - bucketStart >= BUCKET_MS) {
      buckets.shift();
      buckets.push(0);
      bucketStart += BUCKET_MS;
    }
  }

  function drawSpark(): void {
    const max = Math.max(4, ...buckets);
    buckets.forEach((v, i) => {
      const hgt = v === 0 ? 1 : Math.max(2, Math.round((v / max) * 12));
      bars[i].setAttribute("y", String(12 - hgt));
      bars[i].setAttribute("height", String(hgt));
      bars[i].setAttribute("class", v === 0 ? "off" : i >= BUCKETS - 2 ? "hot" : "");
    });
    const perMin = buckets.slice(-15).reduce((a, b) => a + b, 0);
    setText(rate, `${perMin}/min`);
  }

  function makeRow(e: OfficeEvent, model: OfficeModel, animate: boolean): RowMeta | null {
    const line = describe(e);
    if (!line) return null;
    const w = model.get(e.workerId);
    const intern = !!(e.parentId || w?.parentId);
    const offlineNotice = !w && isRemote(e.host) && e.kind === "error";
    const who = offlineNotice && isRemote(e.host) ? hostName(e.host.kind) : intern ? e.role || w?.role || "intern" : e.project || w?.project || "unknown";
    const ts = parseTs(e.ts);
    const agoEl = h("time", { class: "ago", text: ago(ts), attrs: { datetime: new Date(ts).toISOString() } });
    const countEl = h("span", { class: "row-count", text: "" });
    const top = h("span", { class: "row-top" }, h("span", { class: "who", text: who }));
    const host = e.host ?? w?.host;
    if (isRemote(host)) top.append(hostBadge(host, "row-host"));
    if (intern && e.kind !== "subagent_start") top.append(h("span", { class: "chip chip-intern", text: "intern" }));
    if (line.tag) top.append(h("span", { class: `chip chip-${line.tone}`, text: line.tag }));
    top.append(countEl, agoEl);
    const meta = { workerId: e.workerId };
    const btn = h(
      "button",
      {
        class: "row-btn",
        attrs: { type: "button", "aria-label": `${agentName(e.agent)}, ${who}: ${line.text}` },
        on: { click: () => opts.onPick(meta.workerId) },
      },
      logo(e.agent, "row-logo"),
      h("span", { class: "row-main" }, top, h("span", { class: "row-what" }, glyph(line.glyph, 2), h("span", { class: "what", text: line.text }))),
    );
    const li = h("li", { class: `row tone-${line.tone}${animate ? " enter" : ""}${e.workerId === selected ? " is-selected" : ""}`, attrs: { "data-agent": e.agent } }, btn);
    if (animate) li.addEventListener("animationend", () => li.classList.remove("enter"), { once: true });
    return Object.assign(meta, { el: li, key: `${e.workerId}|${e.kind}|${line.text}`, ts, count: 1, agoEl, countEl });
  }

  function add(e: OfficeEvent, model: OfficeModel, animate: boolean): boolean {
    const line = describe(e);
    if (!line) return false;
    const key = `${e.workerId}|${e.kind}|${line.text}`;
    const top = rows[0];
    const ts = parseTs(e.ts);
    if (top && top.key === key && ts - top.ts < 90_000) {
      top.count++;
      top.ts = ts;
      setText(top.countEl, `×${top.count}`);
      setText(top.agoEl, ago(ts));
      if (animate) {
        top.el.classList.remove("pulse");
        void top.el.offsetWidth;
        top.el.classList.add("pulse");
      }
      return true;
    }
    const row = makeRow(e, model, animate);
    if (!row) return false;
    rows.unshift(row);
    list.prepend(row.el);
    while (rows.length > MAX_ROWS) rows.pop()?.el.remove();
    return true;
  }

  return {
    el,
    tab,
    reset(events, model) {
      rows.length = 0;
      list.replaceChildren();
      buckets.fill(0);
      bucketStart = Date.now() - BUCKET_MS * (BUCKETS - 1);
      const now = Date.now();
      for (const e of events) {
        if (!add(e, model, false)) continue;
        const t = parseTs(e.ts);
        const idx = BUCKETS - 1 - Math.floor((now - t) / BUCKET_MS);
        if (idx >= 0 && idx < BUCKETS) buckets[idx]++;
      }
      bucketStart = now - (now % BUCKET_MS);
      el.classList.toggle("is-empty", rows.length === 0);
      drawSpark();
    },
    push(e, model) {
      if (!add(e, model, true)) return;
      roll(Date.now());
      buckets[BUCKETS - 1]++;
      drawSpark();
      el.classList.remove("is-empty");
      if (!open) {
        unread++;
        setText(badge, unread > 99 ? "99+" : String(unread));
        tab.classList.add("has-unread");
      }
    },
    rename(from, to) {
      for (const r of rows) {
        if (r.workerId !== from) continue;
        r.workerId = to;
        r.key = to + r.key.slice(from.length);
        r.el.classList.toggle("is-selected", selected === to);
      }
    },
    highlight(id) {
      selected = id;
      for (const r of rows) r.el.classList.toggle("is-selected", id !== null && r.workerId === id);
    },
    setOpen(o) {
      open = o;
      document.body.classList.toggle("feed-closed", !o);
      if (o) {
        unread = 0;
        setText(badge, "");
        tab.classList.remove("has-unread");
      }
    },
    isOpen: () => open,
    tick(now) {
      for (const r of rows) setText(r.agoEl, ago(r.ts, now));
      const before = bucketStart;
      roll(now);
      if (bucketStart !== before) drawSpark();
    },
  };
}
