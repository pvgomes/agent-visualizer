/*
 * Words for the control plane's chrome: where a session runs, what state it
 * is in, the permission modes, the providers.
 */
import type { ControlSession, PermissionMode, Place, PlaceKind, SessionStatus } from "../../../src/shared/control.ts";
import { HOST_BRAND } from "../../../src/shared/events.ts";
import { h } from "../dom.ts";
import { tidyPath } from "../format.ts";
import { hostLogo } from "../logos.ts";

export const PLACE_NAME: Record<PlaceKind, string> = {
  local: "This Mac",
  ssh: "ssh",
  daytona: "Daytona",
  vercel: "Vercel Sandbox",
  railway: "Railway",
};

/** "This Mac · ~/Codes/api", "Daytona · auth-refactor", "ssh · gpu-box". */
export function placeLabel(p: Place, hostName?: string): string {
  if (p.kind === "local") return `${PLACE_NAME.local} · ${tidyPath(p.target)}`;
  const where = hostName || (p.target === "new" ? "new sandbox" : p.target);
  return `${p.kind === "ssh" ? "ssh" : PLACE_NAME[p.kind]} · ${where}`;
}

/** A compact badge: the provider mark (or a laptop for this machine) and where. */
export function placeBadge(s: Pick<ControlSession, "place" | "host">): HTMLElement {
  const p = s.place;
  if (p.kind === "local") {
    return h("span", { class: "place-badge place-local", attrs: { title: placeLabel(p) } }, h("span", { class: "place-dot" }), h("span", { class: "host-name", text: "This Mac" }));
  }
  const name = s.host?.name || (p.target === "new" ? "new sandbox" : p.target);
  return h(
    "span",
    { class: `host-badge place-badge host-${p.kind}`, attrs: { title: placeLabel(p, s.host?.name) } },
    hostLogo(p.kind),
    h("span", { class: "host-name", text: name }),
  );
}

export type StatusTone = "busy" | "ok" | "done" | "fail";

export function statusWord(s: SessionStatus): { word: string; tone: StatusTone } {
  switch (s) {
    case "creating": return { word: "Creating", tone: "busy" };
    case "installing": return { word: "Installing", tone: "busy" };
    case "starting": return { word: "Starting", tone: "busy" };
    case "running": return { word: "Running", tone: "ok" };
    case "exited": return { word: "Exited", tone: "done" };
    case "failed": return { word: "Failed", tone: "fail" };
    default: return { word: String(s), tone: "busy" };
  }
}

export const PERMISSIONS: { mode: PermissionMode; label: string; hint: string }[] = [
  { mode: "default", label: "Ask before acting", hint: "The agent asks before edits and commands. Answer in the session panel." },
  { mode: "acceptEdits", label: "Accept edits", hint: "File edits go through; commands still ask." },
  { mode: "plan", label: "Plan only", hint: "The agent reads and plans, and changes nothing." },
  { mode: "bypass", label: "Bypass all checks", hint: "" },
];

export const PROVIDER_COLOR = (kind: string): string => HOST_BRAND[kind as keyof typeof HOST_BRAND]?.color ?? "#9aa4b2";

/** "in 23 min", "in 2 h", "expired". */
export function until(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "expired";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `in ${Math.max(1, m)} min`;
  const hrs = Math.round(m / 6) / 10;
  return `in ${hrs % 1 ? hrs.toFixed(1) : hrs} h`;
}
