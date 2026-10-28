/*
 * Where a new Railway sandbox goes: the project and environment picker of
 * the hire form, and the line Settings › Cloud shows. The server sends the
 * account's projects (ids and names) and its default (ProviderStatus.dest);
 * the pick goes back as ids in HireRequest.sandbox, and the server remembers
 * it for next time.
 */
import type { ProviderStatus } from "../../../src/shared/control.ts";
import { h } from "../dom.ts";

export interface RailwayPick {
  project: string;
  environment: string;
}

/** "agent-visualizer-test · production" (just the project when the environment has no name). */
export function railwayLabel(ps: ProviderStatus | undefined, pick: RailwayPick | undefined): string {
  const p = pick && ps?.projects?.find((x) => x.id === pick.project);
  const e = p?.environments.find((x) => x.id === pick!.environment);
  if (!p || !e) return "";
  return e.name ? `${p.name} · ${e.name}` : p.name;
}

/** The pick if it's still one of the account's, else the server's default, else none. */
export function railwayChoice(ps: ProviderStatus | undefined, pick: RailwayPick | undefined): RailwayPick | undefined {
  if (pick && railwayLabel(ps, pick)) return pick;
  const d = ps?.dest;
  return d && railwayLabel(ps, { project: d.project, environment: d.environment }) ? { project: d.project, environment: d.environment } : undefined;
}

/** The hire form's row: a select over every project · environment, or the one there is as text. */
export function railwayPicker(ps: ProviderStatus, current: RailwayPick | undefined, onPick: (p: RailwayPick) => void): HTMLElement | null {
  const projects = ps.projects ?? [];
  const all = projects.flatMap((p) => p.environments.map((e) => ({ p, e })));
  if (!all.length) return null;
  const label = h("span", { class: "hire-row-label", text: "Project" });
  if (all.length === 1) {
    return h("div", { class: "hire-row" }, label, h("span", { text: railwayLabel(ps, { project: all[0]!.p.id, environment: all[0]!.e.id }) }));
  }
  const sel = h("select", { class: "field-select", attrs: { "aria-label": "Railway project for the new sandbox" } });
  if (!current) sel.append(h("option", { text: "Pick a project…", attrs: { value: "", disabled: true, selected: true } }));
  const spaces = new Map<string, HTMLElement>();
  for (const { p, e } of all) {
    const o = h("option", { text: e.name ? `${p.name} · ${e.name}` : p.name, attrs: { value: `${p.id} ${e.id}` } });
    if (!p.workspace) sel.append(o);
    else {
      let g = spaces.get(p.workspace);
      if (!g) spaces.set(p.workspace, (g = sel.appendChild(h("optgroup", { attrs: { label: p.workspace } }))));
      g.append(o);
    }
  }
  if (current) sel.value = `${current.project} ${current.environment}`;
  sel.addEventListener("change", () => {
    const [project, environment] = sel.value.split(" ");
    if (project && environment) onPick({ project, environment });
  });
  const why = ps.dest && current && ps.dest.project === current.project && ps.dest.environment === current.environment ? ps.dest.why : "";
  if (why) sel.title = `Default: ${why}`;
  return h("label", { class: "hire-row" }, label, sel);
}

/** Settings › Cloud: where new sandboxes go, or why none can be made. */
export function railwayWhere(ps: ProviderStatus): string {
  const d = ps.dest ? railwayLabel(ps, { project: ps.dest.project, environment: ps.dest.environment }) : "";
  if (d) return `New sandboxes go in ${d} (${ps.dest!.why}); you can pick another when you add an agent.${ps.note ? ` ${ps.note}.` : ""}`;
  if (ps.canCreate) return `Pick the project for each new sandbox when you add an agent.${ps.note ? ` ${ps.note}.` : ""}`;
  return ps.note ? `${ps.note}.` : "";
}
