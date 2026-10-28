/*
 * The top HUD: wordmark + LIVE/DEMO pill on the left, the office totals in
 * the middle, and the legend on the right: a chip (real logo + count) for
 * every agent that has someone in the office (the three originals, dimmed,
 * when it is empty), then the remote hosts by provider, "Daytona 2 · boat 1
 * · ssh shubham", with a pulled-plug look for any that are down.
 */
import { BRAND, type AgentKind } from "../../src/shared/events.ts";
import { h, setText } from "./dom.ts";
import { fmtCount } from "./format.ts";
import { glyph, mark } from "./icons.ts";
import { agentName, hostLogo, hostName, logo, type RemoteKind } from "./logos.ts";
import type { HostSummary, OfficeModel } from "./state.ts";
import { Ticker } from "./ticker.ts";

const AGENTS = Object.keys(BRAND) as AgentKind[];
const ORIGINALS: AgentKind[] = ["claude", "commandcode", "codex"];
const HOST_ORDER: RemoteKind[] = ["daytona", "boat", "railway", "vercel", "ssh"];

interface Stat {
  el: HTMLElement;
  ticker: Ticker;
  label: string;
}

export interface Topbar {
  el: HTMLElement;
  setDemo(demo: boolean): void;
  setConnected(ok: boolean): void;
  update(model: OfficeModel, animate: boolean): void;
}

export function createTopbar(opts: { onNeedsYou?: () => void } = {}): Topbar {
  const liveText = h("span", { class: "pill-text", text: "live" });
  const pill = h("span", { class: "pill pill-live", attrs: { role: "status" } }, h("span", { class: "pill-dot" }), liveText);

  const brand = h(
    "div",
    { class: "island brand glass" },
    h("span", { class: "brand-mark" }, mark(2)),
    h("span", { class: "wordmark", text: "agent-visualizer" }),
    pill,
  );

  const stat = (key: string, label: string, short: string, extra?: Node): Stat => {
    const ticker = new Ticker(fmtCount);
    const el = h(
      "div",
      { class: `stat stat-${key}`, attrs: { role: "img", "aria-label": `0 ${label}` } },
      extra ?? null,
      ticker.el,
      h("span", { class: "stat-label" }, h("span", { class: "long", text: label }), h("span", { class: "short", text: short })),
    );
    return { el, ticker, label };
  };

  const stats = {
    workers: stat("workers", "workers", "workers"),
    calls: stat("calls", "tool calls", "calls"),
    tokens: stat("tokens", "tokens", "tokens"),
    flips: stat("flips", "tables flipped", "flips", h("span", { class: "flip-glyph" }, glyph("flip", 2))),
  };

  // Who is waiting on you, as a button: each click takes you to the next one.
  const needsTicker = new Ticker(String);
  const needs = h(
    "button",
    { class: "stat stat-needs", attrs: { type: "button", hidden: true, title: "Show who needs you" } },
    h("span", { class: "needs-dot" }),
    needsTicker.el,
    h("span", { class: "stat-label" }, h("span", { class: "long", text: "needs you" }), h("span", { class: "short", text: "need you" })),
  );
  needs.addEventListener("click", () => opts.onNeedsYou?.());
  const needsSep = h("span", { class: "vsep", attrs: { hidden: true } });

  const statsEl = h(
    "div",
    { class: "island stats glass", attrs: { role: "group", "aria-label": "Office totals" } },
    stats.workers.el,
    h("span", { class: "vsep" }),
    stats.calls.el,
    h("span", { class: "vsep" }),
    stats.tokens.el,
    h("span", { class: "vsep" }),
    stats.flips.el,
    needsSep,
    needs,
  );

  const chips = new Map<AgentKind, { el: HTMLElement; ticker: Ticker }>();
  const agentsEl = h("div", { class: "legend-agents", attrs: { role: "group", "aria-label": "Agents in the office" } });
  for (const a of AGENTS) {
    const ticker = new Ticker(String);
    const el = h(
      "span",
      { class: `agent-chip agent-${a} is-zero`, attrs: { role: "img", "aria-label": `${agentName(a)}: 0` } },
      logo(a),
      h("span", { class: "agent-name", text: agentName(a) }),
      ticker.el,
    );
    ticker.set(0, false);
    el.hidden = !ORIGINALS.includes(a);
    chips.set(a, { el, ticker });
    agentsEl.append(el);
  }
  const hostsEl = h("div", { class: "legend-hosts", attrs: { role: "group", "aria-label": "Remote hosts", hidden: true } });
  const more = h("span", { class: "agent-chip legend-more", attrs: { hidden: true, "aria-label": "more agents and hosts" } });
  const legend = h("div", { class: "island legend glass", attrs: { hidden: true } }, agentsEl, hostsEl, more);
  let hostKey = "";

  function renderHosts(list: HostSummary[]): void {
    const key = list.map((x) => `${x.host.id}:${x.workers}:${x.offline}`).sort().join("|");
    if (key === hostKey) return;
    hostKey = key;
    hostsEl.replaceChildren();
    hostsEl.hidden = list.length === 0;
    for (const kind of HOST_ORDER) {
      const of = list.filter((x) => x.host.kind === kind);
      if (!of.length) continue;
      const down = of.filter((x) => x.offline).length;
      const names = of.map((x) => x.host.name || x.host.id);
      // ssh boxes are named, sandboxes are counted
      const value = kind === "ssh" && of.length <= 2 ? names.join(", ") : String(of.length);
      const title = of.map((x) => `${x.host.name || x.host.id}: ${x.offline ? "offline" : `${x.workers} working`}`).join("\n");
      hostsEl.append(
        h(
          "span",
          { class: `host-chip host-${kind}${down ? " is-down" : ""}`, attrs: { title, role: "img", "aria-label": `${hostName(kind)}: ${value}${down ? `, ${down} offline` : ""}` } },
          hostLogo(kind),
          h("span", { class: "host-kind", text: kind === "ssh" ? "ssh" : hostName(kind).replace(/ Sandbox$/, "") }),
          h("span", { class: "host-count", text: value }),
          down ? h("span", { class: "host-down", text: of.length > 1 ? `${down} offline` : "offline" }) : null,
        ),
      );
    }
  }

  /* Too many agents and hosts for the space beside the totals: drop the names,
   * then fold chips from the end (hosts first) into "+N", never off-screen. */
  let lastFold = "";
  let foldedEls: HTMLElement[] = [];
  let foldCompact = false;
  function fold(present: AgentKind[]): void {
    foldedEls = [];
    foldCompact = false;
    for (const c of hostsEl.children) (c as HTMLElement).hidden = false;
    hostsEl.hidden = hostsEl.childElementCount === 0;
    const fits = () => legend.scrollWidth <= legend.clientWidth + 1;
    if (fits()) return;
    legend.classList.add("is-compact");
    foldCompact = true;
    if (fits()) return;
    const queue: [HTMLElement, string][] = [
      ...[...hostsEl.children].reverse().map((c) => [c as HTMLElement, (c as HTMLElement).getAttribute("aria-label") ?? ""] as [HTMLElement, string]),
      ...present.slice(1).reverse().map((a) => [chips.get(a)!.el, agentName(a)] as [HTMLElement, string]),
    ];
    const folded: string[] = [];
    more.hidden = false;
    for (const [chip, name] of queue) {
      chip.hidden = true;
      foldedEls.push(chip);
      folded.push(name);
      setText(more, `+${folded.length}`);
      if (fits()) break;
    }
    hostsEl.hidden = ![...hostsEl.children].some((c) => !(c as HTMLElement).hidden);
    more.title = folded.reverse().join("\n");
  }

  const el = h("header", { class: "topbar" }, brand, statsEl, legend);
  let flipTimer = 0;
  let lastFlips = 0;

  return {
    el,
    setDemo(demo) {
      pill.classList.toggle("pill-demo", demo);
      pill.classList.toggle("pill-live", !demo);
      setText(liveText, demo ? "demo" : "live");
      pill.setAttribute("aria-label", demo ? "Demo office" : "Live");
    },
    setConnected(ok) {
      pill.classList.toggle("is-offline", !ok);
    },
    update(model, animate) {
      const set = (s: Stat, n: number) => {
        const changed = s.ticker.set(n, animate);
        if (changed) s.el.setAttribute("aria-label", `${s.ticker.text} ${s.label}`);
        return changed;
      };
      set(stats.workers, model.workers.size);
      set(stats.calls, model.toolCalls);
      set(stats.tokens, model.tokens);
      if (set(stats.flips, model.flips) && animate && model.flips > lastFlips) {
        stats.flips.el.classList.remove("bump");
        void stats.flips.el.offsetWidth;
        stats.flips.el.classList.add("bump");
        clearTimeout(flipTimer);
        flipTimer = window.setTimeout(() => stats.flips.el.classList.remove("bump"), 1600);
      }
      lastFlips = model.flips;
      stats.flips.el.classList.toggle("has-flips", model.flips > 0);
      let waiting = 0;
      for (const w of model.workers.values()) if (w.status === "waiting" && !w.parentId) waiting++;
      needsTicker.set(waiting, animate);
      needs.hidden = needsSep.hidden = waiting === 0;
      needs.setAttribute("aria-label", `${waiting} need${waiting === 1 ? "s" : ""} you: show`);
      const counts = model.byAgent();
      const present = AGENTS.filter((a) => (counts[a] ?? 0) > 0);
      // Only who is here: an empty office shows no row of zeros (the empty card lists every agent).
      const shown = new Set(present);
      const hosts = model.hosts();
      // A phone fits two or three chips; the rest fold into "+N" rather than being cut off mid-logo.
      const room = window.innerWidth <= 420 ? 2 : window.innerWidth <= 640 ? 3 : Infinity;
      const fits = new Set(present.slice(0, room));
      for (const [a, c] of chips) {
        const n = counts[a] ?? 0;
        c.ticker.set(n, animate);
        c.el.hidden = !fits.has(a);
        c.el.classList.toggle("is-zero", n === 0);
        c.el.setAttribute("aria-label", `${agentName(a)}: ${n}`);
      }
      const hidden = present.length - fits.size + (room === Infinity ? 0 : hosts.length);
      more.hidden = hidden <= 0;
      if (hidden > 0) setText(more, `+${hidden}`);
      renderHosts(room === Infinity ? hosts : []);
      legend.hidden = !present.length && !hosts.length;
      // a crowded legend drops the names and keeps the logos
      legend.classList.toggle("is-compact", shown.size + hosts.length > 4);
      const foldKey = `${present.join()}|${hostKey}|${window.innerWidth}|${waiting > 0}|${String(model.workers.size).length}${String(model.toolCalls).length}${String(model.flips).length}`;
      if (room === Infinity && !legend.hidden) {
        if (foldKey !== lastFold) {
          lastFold = foldKey;
          fold(present);
        } else {
          // same crowd, same width: re-apply the last fold without measuring again
          if (foldCompact) legend.classList.add("is-compact");
          if (foldedEls.length) {
            for (const c of foldedEls) c.hidden = true;
            more.hidden = false;
            setText(more, `+${foldedEls.length}`);
            hostsEl.hidden = ![...hostsEl.children].some((c) => !(c as HTMLElement).hidden);
          }
        }
      }
    },
  };
}
