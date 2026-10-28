/*
 * The list of agents the office started, as a popover over the toolbar: logo,
 * project, where, status. Picking one opens its session panel.
 */
import type { ControlSession } from "../../../src/shared/control.ts";
import { h } from "../dom.ts";
import { agentName, logo } from "../logos.ts";
import { placeBadge, statusWord } from "./format.ts";
import type { ControlStore } from "./store.ts";

export interface SessionList {
  el: HTMLElement;
  toggle(anchor: HTMLElement): void;
  close(): void;
  isOpen(): boolean;
  sync(): void;
}

export function createSessionList(store: ControlStore, opts: { onPick(s: ControlSession): void; onHire(): void; onHover?(s: ControlSession): void }): SessionList {
  const list = h("ul", { class: "sl-list" });
  const el = h(
    "div",
    { class: "sl glass", attrs: { hidden: true, role: "dialog", "aria-label": "Agents the office started" } },
    h("header", { class: "sl-head" }, h("span", { class: "panel-label", text: "Your agents" }), h("button", { class: "btn btn-quiet btn-sm", attrs: { type: "button" }, text: "Hire", on: { click: () => { close(); opts.onHire(); } } })),
    list,
  );
  let anchor: HTMLElement | null = null;

  function render(): void {
    list.replaceChildren();
    const all = store.list();
    if (!all.length) list.append(h("li", { class: "sl-empty", text: "Nobody yet. Hire an agent and it shows up here." }));
    for (const s of all) {
      const st = statusWord(s.status);
      list.append(
        h(
          "li",
          null,
          h(
            "button",
            { class: "sl-row", attrs: { type: "button", "aria-label": `${agentName(s.agent)}, ${s.title}: ${st.word}` }, on: { click: () => { close(); opts.onPick(s); }, pointerenter: () => opts.onHover?.(s), focus: () => opts.onHover?.(s) } },
            logo(s.agent),
            h("span", { class: "sl-main" }, h("span", { class: "sl-title", text: s.title || agentName(s.agent) }), h("span", { class: "sl-sub" }, placeBadge(s))),
            h("span", { class: `sl-status tone-${s.pendingApproval ? "wait" : st.tone}` }, h("span", { class: "ses-pill-dot" }), h("span", { text: s.pendingApproval ? "needs you" : st.word })),
          ),
        ),
      );
    }
  }

  function place(): void {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    el.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
    el.style.bottom = `${window.innerHeight - r.top + 12}px`;
  }

  function close(): void {
    el.hidden = true;
    anchor?.setAttribute("aria-expanded", "false");
  }

  document.addEventListener("pointerdown", (ev) => {
    if (el.hidden || !(ev.target instanceof Node)) return;
    if (el.contains(ev.target) || anchor?.contains(ev.target)) return;
    close();
  });
  document.addEventListener("keydown", (ev) => {
    if (!el.hidden && ev.key === "Escape") {
      ev.preventDefault();
      close();
      anchor?.focus();
    }
  });

  return {
    el,
    toggle(a) {
      anchor = a;
      if (!el.hidden) return close();
      render();
      el.hidden = false;
      a.setAttribute("aria-expanded", "true");
      place();
      el.querySelector<HTMLElement>(".sl-row")?.focus();
    },
    close,
    isOpen: () => !el.hidden,
    sync() {
      if (!el.hidden) {
        render();
        place();
      }
    },
  };
}
