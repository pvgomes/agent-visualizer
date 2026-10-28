/*
 * This browser's page token (src/control/auth.ts): sent with the unlock
 * cookie on every control request, because a cookie for 127.0.0.1 also goes
 * to every other port there and the token doesn't (it lives in this origin's
 * localStorage). /unlock lands on /#unlock=<handoff>; that is traded once for
 * the token and wiped from the address bar before anything else runs.
 */
import { CONTROL_HEADER } from "../../../src/shared/control.ts";

const KEY = "agent-visualizer.control-token";
/** When storage is blocked (a private window): this tab only. */
let mem: string | null = null;

export function controlToken(): string | null {
  try {
    return localStorage.getItem(KEY) ?? mem;
  } catch {
    return mem;
  }
}

function keep(token: string): void {
  mem = token;
  try {
    localStorage.setItem(KEY, token);
  } catch {
    /* this tab only */
  }
}

/** /events with the token, so the stream carries control frames to this browser. */
export function eventsUrl(base = "/events"): string {
  const t = controlToken();
  return t ? `${base}?k=${encodeURIComponent(t)}` : base;
}

/** Right after /unlock: trade the #unlock handoff for the token. True when this browser is now unlocked. */
export async function redeemUnlock(): Promise<boolean> {
  const m = /^#unlock=([0-9a-f]{32})$/.exec(location.hash);
  if (!m) return false;
  history.replaceState(null, "", location.pathname + location.search);
  try {
    const res = await fetch("/api/control/token", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { [CONTROL_HEADER]: "1", "content-type": "application/json" },
      body: JSON.stringify({ handoff: m[1] }),
    });
    if (!res.ok) return false;
    const j = (await res.json()) as { token?: unknown };
    if (typeof j.token !== "string" || !/^[0-9a-f]{64}$/.test(j.token)) return false;
    keep(j.token);
    return true;
  } catch {
    return false;
  }
}
