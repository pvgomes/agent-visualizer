/*
 * The SSE link to the CLI: GET /events, "snapshot" once per connect, then
 * "office" per live event, plus the control plane's "control",
 * "control_gone" and "control_info" (src/shared/control.ts). EventSource's own
 * retry gives up on HTTP errors, so we close and reconnect ourselves with
 * capped, jittered backoff.
 */
import type { OfficeEvent, Snapshot } from "../../src/shared/events.ts";

export type ConnState = "connecting" | "live" | "retrying" | "offline";

export interface ConnHandlers {
  snapshot(s: Snapshot): void;
  event(e: OfficeEvent): void;
  state(s: ConnState, retryInMs?: number): void;
  /** `control` (a ControlSession), `control_gone` ({id}), `control_info` (Partial<ControlInfo>). */
  control?(name: "control" | "control_gone" | "control_info", data: unknown): void;
}

const BASE_MS = 1000;
const MAX_MS = 15_000;

/** `url` may be a function: read on every (re)connect (the page token can arrive after the first). */
export function connect(url: string | (() => string), on: ConnHandlers): { close(): void } {
  let es: EventSource | null = null;
  let attempt = 0;
  let everLive = false;
  let timer = 0;
  let closed = false;

  const parse = <T>(data: string): T | null => {
    try {
      return JSON.parse(data) as T;
    } catch {
      return null;
    }
  };

  function open(): void {
    if (closed) return;
    clearTimeout(timer);
    es?.close();
    // Opened as a file or in a browser without SSE: nothing to retry against.
    if (typeof EventSource === "undefined" || location.protocol === "file:") {
      on.state("offline");
      return;
    }
    on.state(everLive ? "retrying" : "connecting");
    es = new EventSource(typeof url === "function" ? url() : url);
    es.addEventListener("snapshot", (ev) => {
      const s = parse<Snapshot>((ev as MessageEvent<string>).data);
      if (!s || !Array.isArray(s.workers)) return;
      attempt = 0;
      everLive = true;
      on.state("live");
      on.snapshot({ ...s, recent: Array.isArray(s.recent) ? s.recent : [] });
    });
    es.addEventListener("office", (ev) => {
      const e = parse<OfficeEvent>((ev as MessageEvent<string>).data);
      if (e && typeof e.workerId === "string" && typeof e.kind === "string") on.event(e);
    });
    for (const name of ["control", "control_gone", "control_info"] as const) {
      es.addEventListener(name, (ev) => {
        const data = parse<unknown>((ev as MessageEvent<string>).data);
        if (data && typeof data === "object") on.control?.(name, data);
      });
    }
    es.onerror = () => {
      es?.close();
      es = null;
      const delay = Math.min(MAX_MS, BASE_MS * 2 ** attempt) * (0.8 + Math.random() * 0.4);
      attempt++;
      on.state(!everLive && attempt >= 3 ? "offline" : "retrying", delay);
      timer = window.setTimeout(open, delay);
    };
  }

  const retryNow = () => {
    if (!es && !closed) {
      attempt = 0;
      open();
    }
  };
  window.addEventListener("online", retryNow);
  open();

  return {
    close() {
      closed = true;
      clearTimeout(timer);
      es?.close();
      window.removeEventListener("online", retryNow);
    },
  };
}
