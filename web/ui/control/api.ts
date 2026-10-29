/*
 * The control plane's wire. Every request is same-origin, sends the browser's
 * cookie (credentials "same-origin"), the X-Agent-Visualizer header the server
 * checks, so a cross-site page can neither read nor forge a call, and the page
 * token (token.ts), so a cookie that leaked to another port can't either. A session's
 * two streams (terminal bytes, chat items) are read with fetch rather than
 * EventSource, because EventSource can't send that header.
 */
import {
  CONTROL_HEADER,
  CONTROL_TOKEN_HEADER,
  type ApprovalAnswer,
  type ControlInfo,
  type ControlSession,
  type FsListing,
  type HireRequest,
  type InstallPlan,
  type KeyInfo,
  type KeyInput,
  type LoginFlow,
  type ServiceStatus,
  type SetupInventory,
} from "../../../src/shared/control.ts";
import type { AgentKind } from "../../../src/shared/events.ts";
import { controlToken } from "./token.ts";

const BASE = "/api/control";

export class ControlError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const enc = encodeURIComponent;

function controlHeaders(): Record<string, string> {
  const t = controlToken();
  return t ? { [CONTROL_HEADER]: "1", [CONTROL_TOKEN_HEADER]: t } : { [CONTROL_HEADER]: "1" };
}

async function call<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = controlHeaders();
  if (body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ControlError("The office server isn't answering.", 0);
  }
  if (!res.ok) {
    let msg = res.status === 401 ? "Controls are locked in this browser." : `Request failed (${res.status}).`;
    try {
      const j = (await res.json()) as { error?: unknown };
      if (j && typeof j.error === "string" && j.error) msg = j.error;
    } catch {
      /* not JSON */
    }
    throw new ControlError(msg, res.status);
  }
  const text = res.status === 204 ? "" : await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const session = (id: string, what: string) => `/sessions/${enc(id)}/${what}`;

/** What the office knows about herdr (src/herdr/bridge.ts); `pane` when that worker runs in a herdr pane. */
export interface HerdrInfo {
  available: boolean;
  mode?: "herd" | "machine";
  startable?: AgentKind[];
  pane?: string;
}

export const api = {
  info: () => call<ControlInfo>("GET", ""),
  hire: (r: HireRequest) => call<ControlSession>("POST", "/hire", r),
  herdr: (worker?: string) => call<HerdrInfo>("GET", `/herdr${worker ? `?worker=${enc(worker)}` : ""}`),
  herdrFocus: (worker: string) => call<void>("POST", "/herdr/focus", { worker }),
  herdrStart: (r: { agent: AgentKind; folder: string; permission: string; prompt?: string }) => call<{ pane: string }>("POST", "/herdr/start", r),
  fs: (path?: string) => call<FsListing>("GET", `/fs${path ? `?path=${enc(path)}` : ""}`),
  input: (id: string, data: string) => call<void>("POST", session(id, "input"), { data }),
  resize: (id: string, cols: number, rows: number) => call<void>("POST", session(id, "resize"), { cols, rows }),
  prompt: (id: string, text: string) => call<void>("POST", session(id, "prompt"), { text }),
  interrupt: (id: string) => call<void>("POST", session(id, "interrupt")),
  stop: (id: string) => call<void>("POST", session(id, "stop")),
  approval: (id: string, a: ApprovalAnswer) => call<void>("POST", session(id, "approval"), a),
  addKey: (k: KeyInput) => call<KeyInfo>("POST", "/keys", k),
  deleteKey: (name: string) => call<void>("DELETE", `/keys/${enc(name)}`),
  importKeys: () => call<{ imported: string[] }>("POST", "/keys/import"),
  deleteSandbox: (provider: string, id: string, force = false) => call<void>("POST", "/sandboxes/delete", force ? { provider, id, force } : { provider, id }),
  service: (startAtLogin: boolean) => call<ServiceStatus>("POST", "/service", { startAtLogin }),
  installPlan: () => call<InstallPlan>("GET", "/install"),
  install: (agents?: AgentKind[]) => call<InstallPlan>("POST", "/install", agents ? { agents } : {}),
  /** `wait`: answer once a refresh under way is done, rather than at once from the office's cache. */
  setup: (agent: AgentKind, folder?: string, wait = false) => call<SetupInventory>("GET", `/setup?agent=${enc(agent)}${folder ? `&folder=${enc(folder)}` : ""}${wait ? "&wait=1" : ""}`),
  loginStart: () => call<LoginFlow>("POST", "/logins/claude"),
  loginInput: (data: string) => call<void>("POST", "/logins/claude/input", { data }),
  loginCancel: () => call<void>("DELETE", "/logins/claude"),
};

export type StreamState = "open" | "retrying" | "ended";

export interface Stream {
  close(): void;
}

/**
 * Follow a session's text/event-stream: `on(event, data)` per message. A
 * dropped connection reconnects with backoff (the server replays history
 * first, so `onState("open", true)` tells the caller to start clean); 401, 403,
 * 404 and 410 end it for good.
 */
export function stream(path: string, on: (event: string, data: string) => void, onState?: (s: StreamState, reconnect: boolean, err?: string) => void): Stream {
  let ctl: AbortController | null = null;
  let closed = false;
  let attempt = 0;
  let opened = 0;
  let timer = 0;

  const dispatch = (block: string) => {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const i = line.indexOf(":");
      const field = i < 0 ? line : line.slice(0, i);
      const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length) on(event, data.join("\n"));
  };

  async function run(): Promise<void> {
    ctl = new AbortController();
    let fatal = "";
    try {
      const res = await fetch(BASE + path, {
        credentials: "same-origin",
        cache: "no-store",
        headers: { ...controlHeaders(), accept: "text/event-stream" },
        signal: ctl.signal,
      });
      if (!res.ok || !res.body) {
        if ([401, 403, 404, 410].includes(res.status)) fatal = res.status === 401 ? "locked" : "gone";
        throw new ControlError(`stream ${res.status}`, res.status);
      }
      attempt = 0;
      onState?.("open", opened++ > 0);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done || closed) break;
        buf += value.replace(/\r\n?/g, "\n");
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          dispatch(buf.slice(0, i));
          buf = buf.slice(i + 2);
        }
      }
    } catch {
      /* dropped: retried below unless fatal */
    }
    if (closed) return;
    if (fatal) {
      onState?.("ended", false, fatal);
      return;
    }
    const delay = Math.min(10_000, 800 * 2 ** attempt++);
    onState?.("retrying", false);
    timer = window.setTimeout(() => void run(), delay);
  }
  void run();
  return {
    close() {
      closed = true;
      clearTimeout(timer);
      ctl?.abort();
    },
  };
}

export const termPath = (id: string) => session(id, "term");
export const chatPath = (id: string) => session(id, "chat");
