/*
 * The floating control pill at the bottom, in labelled groups: agents (Hire,
 * the ones the office started), view (CRT), capture
 * (screenshot, clip that), display (stream mode, fullscreen, sound) and
 * panels (feed, settings, help). One shared tooltip element follows hover and
 * keyboard focus and shows each control's name, group and shortcut.
 */
import { h, setText, svgEl } from "./dom.ts";
import { icon, type ToolbarIcon } from "./icons.ts";

export interface ToolbarActions {
  hire(): void;
  location(): void;
  sessions(anchor: HTMLElement): void;
  settings(): void;
  crt(): void;
  shot(): void;
  rec(): void;
  full(): void;
  stream(): void;
  sound(): void;
  feed(): void;
  help(): void;
}

export interface Toolbar {
  el: HTMLElement;
  tip: HTMLElement;
  setCrt(on: boolean): void;
  /** The office's city, named on the Location button. */
  setCity(name: string): void;
  setSound(on: boolean): void;
  setFeed(open: boolean): void;
  setFull(on: boolean): void;
  setRecording(on: boolean, ms?: number): void;
  setRecLeft(seconds: number): void;
  /** Controls locked (watch-only) or not offered by this server. */
  setControl(state: "enabled" | "locked" | "off" | "unknown", lockedTip: string): void;
  setSessions(count: number, needsYou: number): void;
  setSettings(open: boolean): void;
}

export const RING_C = 2 * Math.PI * 16;

export function createToolbar(act: ToolbarActions): Toolbar {
  const tip = h("div", { class: "tip", attrs: { role: "tooltip", id: "ao-tip", hidden: true } });
  const tipGroup = h("span", { class: "tip-group" });
  const tipText = h("span");
  const tipKey = h("kbd");
  tip.append(tipGroup, tipText, tipKey);

  function showTip(btn: HTMLElement): void {
    setText(tipGroup, btn.closest<HTMLElement>("[data-group]")?.dataset.group ?? "");
    tipGroup.hidden = !tipGroup.textContent;
    setText(tipText, btn.dataset.tip ?? "");
    setText(tipKey, btn.dataset.key ?? "");
    tipKey.hidden = !btn.dataset.key;
    tip.hidden = false;
    const r = btn.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    const x = Math.min(window.innerWidth - tr.width - 8, Math.max(8, r.left + r.width / 2 - tr.width / 2));
    tip.style.left = `${x}px`;
    tip.style.top = `${r.top - tr.height - 10}px`;
  }
  const hideTip = () => {
    tip.hidden = true;
  };

  function button(name: string, ic: ToolbarIcon, label: string, key: string, onClick: () => void, toggle = false): HTMLButtonElement {
    const b = h(
      "button",
      {
        class: `tb tb-${name}`,
        attrs: { type: "button", "aria-label": label, "aria-keyshortcuts": key === "?" ? "Shift+?" : key || undefined, "aria-pressed": toggle ? "false" : undefined },
        on: { click: onClick },
      },
      icon(ic, 2),
    );
    b.dataset.tip = label;
    b.dataset.key = key;
    return b;
  }

  const hire = h(
    "button",
    { class: "tb tb-hire", attrs: { type: "button", "aria-label": "Add an agent", "aria-keyshortcuts": "N" }, on: { click: () => act.hire() } },
    icon("hire", 2),
    h("span", { class: "tb-label", text: "Add agent" }),
  );
  hire.dataset.tip = "Add an agent";
  hire.dataset.key = "N";
  const cityName = h("span", { class: "tb-label", text: "Location" });
  const location = h(
    "button",
    { class: "tb tb-location", attrs: { type: "button", "aria-label": "Change location", "aria-haspopup": "dialog", "aria-keyshortcuts": "L" }, on: { click: () => act.location() } },
    icon("globe", 2),
    cityName,
  );
  location.dataset.tip = "Change location";
  location.dataset.key = "L";
  const lockBadge = () => h("span", { class: "tb-lock", attrs: { "aria-hidden": "true" } }, icon("lock", 1));
  hire.append(lockBadge());
  const sessionsCount = h("span", { class: "tb-count", attrs: { "aria-hidden": "true" } });
  const sessions = h(
    "button",
    { class: "tb tb-sessions", attrs: { type: "button", "aria-label": "Agents the office started", "aria-haspopup": "dialog", "aria-expanded": "false", hidden: true } },
    icon("crew", 2),
    sessionsCount,
  );
  sessions.addEventListener("click", () => act.sessions(sessions));
  sessions.dataset.tip = "Your agents";
  const settings = button("settings", "gear", "Settings: logins, keys, cloud, service", "", act.settings, true);
  settings.append(lockBadge());
  const crt = button("crt", "crt", "CRT scanlines", "C", act.crt, true);
  const shot = button("shot", "camera", "Screenshot (PNG)", "S", act.shot);
  const rec = button("rec", "record", "Clip that: save the last 15s", "R", act.rec, true);
  const ring = svgEl("svg", { class: "ring", viewBox: "0 0 36 36", "aria-hidden": "true" });
  ring.append(svgEl("circle", { cx: 18, cy: 18, r: 16, "stroke-dasharray": RING_C.toFixed(2), "stroke-dashoffset": "0" }));
  const recLeft = h("span", { class: "rec-left", attrs: { "aria-hidden": "true" } });
  rec.append(ring, recLeft);
  const full = button("full", "fullscreen", "Fullscreen", "F", act.full, true);
  const stream = button("stream", "eye", "Stream mode: hide the controls", "H", act.stream, true);
  const sound = button("sound", "soundOff", "Sound", "M", act.sound, true);
  const feed = button("feed", "feed", "Activity feed", "\\", act.feed, true);
  const help = button("help", "help", "Keyboard shortcuts", "?", act.help);
  if (!document.fullscreenEnabled) full.hidden = true;

  const group = (name: string, cls: string, ...kids: HTMLElement[]) => {
    const g = h("div", { class: `tb-group tb-g-${cls}`, attrs: { role: "group", "aria-label": name } }, ...kids);
    g.dataset.group = name;
    return g;
  };
  const el = h(
    "nav",
    { class: "toolbar glass", attrs: { "aria-label": "Controls" } },
    group("Agents", "agents", hire, location, sessions),
    group("View", "view", crt),
    group("Capture", "capture", shot, rec),
    group("Display", "display", stream, full, sound),
    group("Panels", "panels", feed, settings, help),
  );

  el.addEventListener("pointerover", (ev) => {
    const b = ev.target instanceof Element ? ev.target.closest<HTMLElement>("[data-tip]") : null;
    if (b) showTip(b);
  });
  el.addEventListener("pointerleave", hideTip);
  el.addEventListener("focusin", (ev) => {
    const b = ev.target instanceof HTMLElement && ev.target.matches(":focus-visible") ? ev.target.closest<HTMLElement>("[data-tip]") : null;
    if (b) showTip(b);
  });
  el.addEventListener("focusout", hideTip);
  el.addEventListener("click", hideTip);

  const press = (b: HTMLElement, on: boolean) => b.setAttribute("aria-pressed", String(on));

  return {
    el,
    tip,
    setCrt: (on) => press(crt, on),
    setCity(name) {
      setText(cityName, name);
      location.setAttribute("aria-label", `Change location (now ${name})`);
    },
    setSound(on) {
      press(sound, on);
      sound.replaceChildren(icon(on ? "soundOn" : "soundOff", 2));
      sound.dataset.tip = on ? "Sound on" : "Sound off";
    },
    setFeed: (open) => press(feed, open),
    setFull: (on) => press(full, on),
    setRecording(on, ms = 10_000) {
      press(rec, on);
      rec.classList.toggle("is-recording", on);
      rec.style.setProperty("--rec-ms", `${ms}ms`);
      rec.dataset.tip = on ? "Stop recording" : "Clip that: save the last 15s";
      rec.firstElementChild?.replaceWith(icon(on ? "stop" : "record", 2));
      if (!on) setText(recLeft, "");
    },
    setRecLeft: (s) => setText(recLeft, String(s)),
    setControl(state, lockedTip) {
      const locked = state !== "enabled";
      for (const b of [hire, settings]) {
        b.classList.toggle("is-locked", locked);
        b.setAttribute("aria-disabled", String(locked));
      }
      hire.hidden = settings.hidden = state === "unknown" || state === "off";
      hire.dataset.tip = locked ? lockedTip : "Add an agent";
      settings.dataset.tip = locked ? lockedTip : "Settings: logins, keys, cloud, service";
      hire.dataset.key = locked ? "" : "N";
      settings.dataset.key = "";
    },
    setSessions(count, needsYou) {
      sessions.hidden = count === 0;
      setText(sessionsCount, String(count));
      sessions.classList.toggle("needs-you", needsYou > 0);
      sessions.dataset.tip = needsYou ? `Your agents · ${needsYou} need${needsYou === 1 ? "s" : ""} you` : `Your agents (${count})`;
    },
    setSettings: (open) => press(settings, open),
  };
}
