/*
 * The chrome's smaller pieces: the empty-office card, the reconnecting pill,
 * the keyboard-shortcut sheet, the stream-mode hint and the camera flash.
 */
import { h, setText } from "./dom.ts";
import { icon, mark } from "./icons.ts";
import { logo } from "./logos.ts";

export interface EmptyCard {
  el: HTMLElement;
  show(kind: "empty" | "offline"): void;
  hide(): void;
  /** Whether "Add your first agent" can be used here (locked: shown with the reason). */
  setControl(state: "enabled" | "locked" | "off" | "unknown", lockedTip: string): void;
}

const DEMO_CMD = "npx @pvgomes/agent-visualizer --demo";

export function createEmpty(opts: { onHire(): void } = { onHire: () => undefined }): EmptyCard {
  const title = h("h1", { class: "empty-title" });
  const body = h("p", { class: "empty-body" });
  const cmd = h("code", { class: "cmd-text", text: DEMO_CMD });
  const copyLabel = h("span", { text: "Copy" });
  const copy = h(
    "button",
    { class: "copy-btn", attrs: { type: "button", "aria-label": `Copy ${DEMO_CMD}` }, on: { click: () => void doCopy() } },
    icon("copy", 1),
    copyLabel,
  );
  const hint = h("p", { class: "empty-hint", text: "or watch a demo office" });
  const hireBtn = h("button", { class: "btn btn-primary empty-hire", attrs: { type: "button" }, on: { click: () => opts.onHire() } }, icon("hire", 1), h("span", { text: "Add your first agent" }), h("kbd", { text: "N" }));
  const lockNote = h("p", { class: "empty-lock", attrs: { hidden: true } }, icon("lock", 1), h("span"));
  const hireBox = h("div", { class: "empty-cta", attrs: { hidden: true } }, hireBtn, lockNote);
  const el = h(
    "div",
    { class: "empty-wrap", attrs: { hidden: true } },
    h(
      "section",
      { class: "empty glass", attrs: { "aria-labelledby": "ao-empty-title" } },
      h("div", { class: "empty-mark" }, mark(4)),
      title,
      body,
      h("div", { class: "empty-agents", attrs: { "aria-hidden": "true" } }, ...(["claude", "codex", "commandcode", "opencode", "gemini", "qwen", "droid", "cursor"] as const).map((a) => logo(a))),
      hireBox,
      hint,
      h("div", { class: "cmd" }, h("span", { class: "cmd-prompt", text: "$" }), cmd, copy),
    ),
  );
  title.id = "ao-empty-title";

  async function doCopy(): Promise<void> {
    let ok = false;
    try {
      await navigator.clipboard.writeText(DEMO_CMD);
      ok = true;
    } catch {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(cmd);
      sel?.removeAllRanges();
      sel?.addRange(range);
      ok = document.execCommand?.("copy") ?? false;
    }
    setText(copyLabel, ok ? "Copied" : "Press ⌘C");
    copy.classList.toggle("is-done", ok);
    setTimeout(() => {
      setText(copyLabel, "Copy");
      copy.classList.remove("is-done");
    }, 1800);
  }

  return {
    el,
    show(kind) {
      if (kind === "empty") {
        setText(title, "The office is empty.");
        setText(body, "Start Claude Code, Codex, Command Code, opencode, Gemini, Qwen, Droid or Cursor in any terminal, here or in a sandbox — they'll walk in.");
      } else {
        setText(title, "No office server here.");
        setText(body, "This page talks to the agent-visualizer CLI. Run it in a terminal and this tab connects on its own.");
      }
      el.dataset.kind = kind;
      el.hidden = false;
    },
    hide() {
      el.hidden = true;
    },
    setControl(state, lockedTip) {
      hireBox.hidden = state === "unknown" || state === "off";
      hireBtn.disabled = state !== "enabled";
      lockNote.hidden = state !== "locked";
      setText(lockNote.lastElementChild!, lockedTip);
      el.classList.toggle("can-hire", state === "enabled");
      setText(hint, state === "enabled" ? "or start one in any terminal, or watch a demo office" : "or watch a demo office");
    },
  };
}

export interface ConnPill {
  el: HTMLElement;
  set(state: "live" | "connecting" | "retrying" | "offline", retryInMs?: number): void;
}

export function createConnPill(): ConnPill {
  const text = h("span", { class: "conn-text" });
  const el = h("div", { class: "conn glass", attrs: { role: "status", hidden: true } }, h("span", { class: "conn-spin", attrs: { "aria-hidden": "true" } }), text);
  let timer = 0;
  let until = 0;
  const render = (label: string) => {
    const s = Math.ceil((until - Date.now()) / 1000);
    setText(text, s > 0 ? `${label} in ${s}s` : `${label}…`);
  };
  return {
    el,
    set(state, retryInMs = 0) {
      clearInterval(timer);
      if (state === "live") {
        el.hidden = true;
        return;
      }
      el.hidden = false;
      el.dataset.state = state;
      if (state === "connecting") {
        setText(text, "connecting…");
        return;
      }
      if (state === "offline" && !retryInMs) {
        setText(text, "not connected to agent-visualizer");
        return;
      }
      const label = state === "offline" ? "server not reachable · retrying" : "reconnecting";
      until = Date.now() + retryInMs;
      render(label);
      timer = window.setInterval(() => render(label), 500);
    },
  };
}

export interface HelpSheet {
  el: HTMLDialogElement;
  toggle(): void;
  isOpen(): boolean;
}

const KEYS: [string, string][] = [
  ["N", "Add an agent"],
  ["L", "Change location: Rio, Dubai, London, New York, Tokyo, Warsaw"],
  ["1 2 3", "Allow · always allow · deny, when an agent asks"],
  ["C", "CRT scanlines"],
  ["S", "Save a PNG screenshot"],
  ["R", "Clip that: save the last ~15 seconds"],
  ["⇧R", "Record the next 10 seconds"],
  ["F", "Fullscreen"],
  ["H", "Stream mode: hide all controls"],
  ["M", "Sound on / off"],
  ["\\", "Show / hide the activity feed"],
  ["Esc", "Close the panel or the inspector"],
  ["?", "This sheet"],
];

export function createHelp(): HelpSheet {
  const list = h("dl", { class: "keys" });
  for (const [k, v] of KEYS) list.append(h("div", null, h("dt", null, h("kbd", { text: k })), h("dd", { text: v })));
  const close = h("button", { class: "icon-btn help-close", attrs: { type: "button", "aria-label": "Close shortcuts" }, text: "Esc" });
  const el = h(
    "dialog",
    { class: "help glass", attrs: { "aria-labelledby": "ao-help-title", autofocus: true, tabindex: -1 } },
    h("header", { class: "help-head" }, h("h2", { class: "help-title", text: "Keyboard", attrs: { id: "ao-help-title" } }), close),
    list,
    h("p", { class: "help-foot", text: "Click a worker or a feed row to inspect it; an agent the office started opens its session." }),
  );
  close.addEventListener("click", () => el.close());
  el.addEventListener("click", (ev) => {
    if (ev.target === el) el.close();
  });
  return {
    el,
    toggle() {
      if (el.open) el.close();
      else el.showModal();
    },
    isOpen: () => el.open,
  };
}

export function createStreamHint(onExit: () => void): { el: HTMLElement; corner: HTMLElement; flash(show: boolean): void } {
  const el = h("div", { class: "stream-hint glass", attrs: { role: "status" } }, h("span", { text: "Stream mode. Press" }), h("kbd", { text: "H" }), h("span", { text: "to bring the controls back." }));
  const corner = h("button", { class: "stream-corner", attrs: { type: "button", "aria-label": "Show controls" }, on: { click: onExit } });
  let t = 0;
  return {
    el,
    corner,
    flash(show) {
      clearTimeout(t);
      el.classList.toggle("show", show);
      if (show) t = window.setTimeout(() => el.classList.remove("show"), 2600);
    },
  };
}

export function cameraFlash(root: HTMLElement): void {
  const f = h("div", { class: "flash", attrs: { "aria-hidden": "true" } });
  root.append(f);
  f.addEventListener("animationend", () => f.remove(), { once: true });
  setTimeout(() => f.remove(), 1200);
}
