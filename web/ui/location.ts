/*
 * The location picker: where the office is. One card per city with a live
 * postcard of its view (the scene paints it), its local time and what you see
 * from the glass. Picking one moves the office there; the choice is the
 * viewer's own and lives in their prefs.
 */
import { CITIES, cityClock, type CityId } from "../cities.ts";
import { h, setText } from "./dom.ts";
import { glyph } from "./icons.ts";

export interface LocationPicker {
  el: HTMLDialogElement;
  open(current: CityId): void;
  close(): void;
  isOpen(): boolean;
}

/** Postcard size in art px: wide enough for every city's landmarks. */
const CARD_W = 172, CARD_H = 66;

export function createLocationPicker(o: { onPick(city: CityId): void; preview?(city: CityId, w: number, h: number): HTMLCanvasElement }): LocationPicker {
  const closeX = h("button", { class: "icon-btn", attrs: { type: "button", "aria-label": "Close" } }, glyph("close", 1));
  const grid = h("div", { class: "loc-grid", attrs: { role: "radiogroup", "aria-label": "Office location" } });
  const el = h(
    "dialog",
    { class: "dlg loc glass", attrs: { "aria-labelledby": "ao-loc-title" } },
    h(
      "div",
      { class: "loc-inner" },
      h("header", { class: "dlg-head" }, h("h2", { class: "dlg-title", text: "Change location", attrs: { id: "ao-loc-title" } }), closeX),
      h("p", { class: "loc-sub", text: "Move the office. The view, the sky and the wall clock follow the city's own time." }),
      grid,
    ),
  );
  const times = new Map<CityId, HTMLElement>();
  let timer = 0;

  function render(current: CityId) {
    grid.replaceChildren();
    times.clear();
    for (const c of CITIES) {
      const here = c.id === current;
      const shot = h("div", { class: "loc-shot" });
      try {
        const cv = o.preview?.(c.id, CARD_W, CARD_H);
        if (cv) shot.append(cv);
      } catch {
        /* the postcard is decoration */
      }
      const time = h("span", { class: "loc-time", text: cityClock(c.id) });
      times.set(c.id, time);
      const card = h(
        "button",
        {
          class: "loc-card",
          attrs: { type: "button", role: "radio", "aria-checked": String(here) },
          on: {
            click: () => {
              el.close();
              if (!here) o.onPick(c.id);
            },
          },
        },
        shot,
        h(
          "div",
          { class: "loc-meta" },
          h("div", { class: "loc-row" }, h("b", { class: "loc-name", text: c.name }), time),
          h("div", { class: "loc-row" }, h("span", { class: "loc-country", text: c.country }), here ? h("span", { class: "loc-here", text: "You're here" }) : null),
          h("p", { class: "loc-view", text: c.view }),
        ),
      );
      grid.append(card);
    }
  }

  closeX.addEventListener("click", () => el.close());
  el.addEventListener("click", (ev) => {
    if (ev.target === el) el.close();
  });
  el.addEventListener("close", () => clearInterval(timer));

  return {
    el,
    open(current) {
      render(current);
      clearInterval(timer);
      timer = window.setInterval(() => {
        for (const [id, t] of times) setText(t, cityClock(id));
      }, 5_000);
      el.showModal();
      grid.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    },
    close: () => el.close(),
    isOpen: () => el.open,
  };
}
