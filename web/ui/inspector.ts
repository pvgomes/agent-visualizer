/*
 * The inspector card for the selected worker: who it is, where it works
 * (this machine, or which sandbox / ssh box), the mood it set for itself,
 * what it is doing right now and its last few actions. Framed with corner
 * brackets in the worker's brand colour, like a HUD target lock.
 */
import { h, setText } from "./dom.ts";
import { ago, describe, fmtCount, statusOf, tidyPath, truncateMiddle } from "./format.ts";
import { glyph, icon } from "./icons.ts";
import { agentColor, agentName, hostBadge, hostLabel, isRemote, logo } from "./logos.ts";
import type { Worker } from "./state.ts";

export interface Inspector {
  el: HTMLElement;
  open(w: Worker): void;
  update(w: Worker): void;
  gone(): void;
  close(): void;
  current(): string | null;
  tick(now: number): void;
  /** "Started outside the office · watch only", or null to hide the line. */
  setOrigin(text: string | null): void;
}

export function createInspector(opts: { onClose(): void; onFocus(workerId: string): void }): Inspector {
  const logoSlot = h("span", { class: "ins-logo" });
  const agentEl = h("span", { class: "ins-agent" });
  const projectEl = h("h2", { class: "ins-project" });
  const internChip = h("span", { class: "chip chip-intern", text: "intern" });
  const dot = h("span", { class: "status-dot" });
  const statusWord = h("span", { class: "status-word" });
  const statusWhat = h("span", { class: "status-what" });
  const moodEl = h("div", { class: "ins-mood", attrs: { hidden: true } });
  const hostSlot = h("span", { class: "ins-host" });
  const metaList = h("dl", { class: "ins-meta" });
  const calls = h("b", { text: "0" });
  const tokens = h("b", { text: "0" });
  const files = h("b", { text: "0" });
  const timeline = h("ol", { class: "ins-timeline" });
  const origin = h("p", { class: "ins-origin", attrs: { hidden: true } });

  const focusBtn = h(
    "button",
    { class: "icon-btn", attrs: { type: "button", "aria-label": "Center the camera on this worker", title: "Center camera" }, on: { click: () => id && opts.onFocus(id) } },
    icon("target", 1),
  );
  const closeBtn = h(
    "button",
    { class: "icon-btn", attrs: { type: "button", "aria-label": "Close inspector", "aria-keyshortcuts": "Escape", title: "Close  Esc" }, on: { click: () => opts.onClose() } },
    glyph("close", 1),
  );

  const el = h(
    "section",
    { class: "inspector glass", attrs: { "aria-label": "Worker details", hidden: true } },
    h("span", { class: "bracket tl" }),
    h("span", { class: "bracket tr" }),
    h("span", { class: "bracket bl" }),
    h("span", { class: "bracket br" }),
    h(
      "header",
      { class: "ins-head" },
      logoSlot,
      h("div", { class: "ins-title" }, h("div", { class: "ins-agent-row" }, agentEl, internChip, hostSlot), projectEl),
      h("div", { class: "ins-actions" }, focusBtn, closeBtn),
    ),
    moodEl,
    h("div", { class: "ins-status" }, dot, statusWord, statusWhat),
    origin,
    metaList,
    h(
      "div",
      { class: "ins-stats" },
      h("div", null, calls, h("span", { text: "tool calls" })),
      h("div", null, tokens, h("span", { text: "tokens" })),
      h("div", null, files, h("span", { text: "files touched" })),
    ),
    h("div", { class: "ins-section" }, h("span", { class: "panel-label", text: "recent" }), timeline),
  );

  let id: string | null = null;
  let agent = "";
  let lastSeq = -1;

  function meta(rows: [string, string | undefined, string?][]): void {
    metaList.replaceChildren();
    for (const [k, v, title] of rows) {
      if (!v) continue;
      const dd = h("dd", { text: v });
      if (title) dd.title = title;
      metaList.append(h("div", null, h("dt", { text: k }), dd));
    }
  }

  function fill(w: Worker): void {
    if (agent !== w.agent) {
      agent = w.agent;
      logoSlot.replaceChildren(logo(w.agent));
      el.style.setProperty("--accent", agentColor(w.agent));
      el.dataset.agent = w.agent;
    }
    setText(agentEl, agentName(w.agent));
    setText(projectEl, w.parentId ? w.role || "intern" : w.project);
    internChip.hidden = !w.parentId;
    const st = statusOf(w.status, w.category);
    dot.dataset.activity = st.activity;
    setText(statusWord, st.word);
    setText(statusWhat, w.status === "tool_start" && w.summary ? w.summary : "");
    const cwd = w.cwd ? tidyPath(w.cwd) : undefined;
    const remote = isRemote(w.host) ? w.host : undefined;
    const hostKey = remote ? remote.id : "";
    if (hostSlot.dataset.host !== hostKey) {
      hostSlot.dataset.host = hostKey;
      hostSlot.replaceChildren(...(remote ? [hostBadge(remote)] : []));
    }
    if (w.mood) {
      moodEl.hidden = false;
      setText(moodEl, w.mood);
    } else moodEl.hidden = true;
    meta([
      ["project", w.parentId ? w.project : undefined],
      ["host", remote ? hostLabel(remote) : undefined],
      ["model", w.model],
      ["role", w.parentId ? w.role : undefined],
      ["cwd", cwd ? truncateMiddle(cwd, 34) : undefined, cwd],
    ]);
    setText(calls, fmtCount(w.toolCalls));
    setText(tokens, fmtCount(w.tokens));
    setText(files, fmtCount(w.filesTouched));

    const newest = w.history[w.history.length - 1]?.seq ?? -1;
    if (newest !== lastSeq || timeline.childElementCount === 0) {
      lastSeq = newest;
      timeline.replaceChildren();
      const items = w.history.slice(-10).reverse();
      for (const a of items) {
        const line = describe(a);
        if (!line) continue;
        timeline.append(
          h(
            "li",
            { class: `tl-item tone-${line.tone}`, attrs: { "data-ts": a.ts } },
            h("span", { class: "tl-node" }, glyph(line.glyph, 1)),
            h("span", { class: "tl-text", text: line.text }),
            h("time", { class: "ago", text: ago(a.ts) }),
          ),
        );
      }
      if (!timeline.childElementCount) timeline.append(h("li", { class: "tl-empty", text: "No actions yet." }));
    }
  }

  return {
    el,
    open(w) {
      const fresh = id !== w.workerId;
      id = w.workerId;
      lastSeq = -1;
      el.classList.remove("is-gone");
      fill(w);
      if (el.hidden) {
        el.hidden = false;
        el.classList.remove("enter");
        void el.offsetWidth;
        el.classList.add("enter");
      } else if (fresh) {
        el.classList.remove("swap");
        void el.offsetWidth;
        el.classList.add("swap");
      }
      document.body.classList.add("inspecting");
    },
    update(w) {
      if (w.workerId === id) fill(w);
    },
    gone() {
      el.classList.add("is-gone");
      dot.dataset.activity = "gone";
      setText(statusWord, "left the office");
      setText(statusWhat, "");
    },
    close() {
      id = null;
      el.hidden = true;
      document.body.classList.remove("inspecting");
    },
    current: () => id,
    setOrigin(text) {
      origin.hidden = !text;
      setText(origin, text ?? "");
    },
    tick(now) {
      if (el.hidden) return;
      for (const li of timeline.querySelectorAll<HTMLElement>(".tl-item")) {
        const t = Number(li.dataset.ts);
        const a = li.querySelector(".ago");
        if (a && t) setText(a, ago(t, now));
      }
    },
  };
}
