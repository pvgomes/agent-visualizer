/*
 * The control plane, assembled: builds the ControlContext (office port,
 * key store, environments), hands it to the sessions part (A) and the
 * places part (C), and mounts their routes on the office server behind the
 * unlock (auth.ts). src/server/http.ts sends /unlock, /api/control/** and
 * /api/hook/** here, asks unlocked(req) for Snapshot.control and forwards
 * the frames to unlocked /events clients.
 *
 * Off (every route 404, Snapshot.control "off") for --demo, --no-control,
 * a non-loopback --host and Windows: the office is then watch-only.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import type { RemoteTarget } from "../shared/events.ts";
import type { ControlInfo, ServiceStatus } from "../shared/control.ts";
import { allowedHosts, hostAllowed, SECURITY_HEADERS } from "../server/http.ts";
import type { OfficeState } from "../server/state.ts";
import { officeHome } from "../mcp/outbox.ts";
import { selfCommand } from "../install/command.ts";
import { scrubMessage } from "../remote/util.ts";
import {
  ControlError, HOOK_PREFIX,
  type ControlContext, type ControlFrame, type ControlPlane, type Disposable, type KeyStore, type OfficePort,
  type Places, type PlacesContext, type PtyBackend, type SessionManager,
} from "./types.ts";
import { ControlAuth, checkControl, foreignOrigin, fromBrowser } from "./auth.ts";
import { createApi, decode, readJson, sendJson, BIG_BODY, SMALL_BODY, type InstallControl, type ServiceControl } from "./api.ts";
import { agentEnv } from "./env.ts";
import { HiredFolders, isDir } from "./fs.ts";
import { createKeyStore } from "./keys.ts";
import { createLinker, createOfficePort, type Linker } from "./link.ts";
import { createLogins, type Logins } from "./logins.ts";
import type { HerdrBridge } from "../herdr/bridge.ts";

export interface ControlPlaneOptions {
  state: OfficeState;
  /** Decided by the CLI: loopback host, not the demo, not --no-control, darwin or linux. */
  enabled: boolean;
  version: string;
  /** The interface the server binds (for the Host allowlist). */
  host: string;
  /** http://127.0.0.1:<port> once the server listens. */
  officeUrl(): string;
  /** $AGENT_VISUALIZER_HOME; default from the environment. */
  home?: string;
  userHome?: string;
  platform?: NodeJS.Platform;
  now?: () => number;
  log?: (msg: string, level?: "info" | "warn") => void;
  /** Shared with presence (one claimer per OfficeState); created here when absent. */
  linker?: Linker;
  keys?: KeyStore;
  /** The sessions part (src/control/sessions.ts createSessionManager). */
  sessions?: (ctx: ControlContext, places: Places | null) => SessionManager;
  /** The places part (src/control/cloud/index.ts createPlaces). */
  places?: (ctx: PlacesContext) => Places;
  pty?: () => Promise<PtyBackend | null>;
  /** Make the remote transcript watcher follow a host a session runs on. */
  watch?: (target: RemoteTarget) => Disposable;
  service?: ServiceControl;
  installer?: InstallControl;
  /** herdr, when the office talks to it (src/herdr/bridge.ts): pane links, focus, starting agents there. */
  herdr?: HerdrBridge;
  pingMs?: number;
  /** "Bring my setup": known key names in the login shell (tests); default a fresh login shell. */
  shellNames?: () => Promise<string[]>;
}

export interface Plane extends ControlPlane {
  /** Present when enabled. */
  readonly context?: ControlContext;
  readonly auth?: ControlAuth;
  readonly office?: OfficePort;
  readonly keys?: KeyStore;
  /** Processes the plane owns (presence leaves them alone). */
  ownedPids(): number[];
  /** Hired sessions that haven't exited (a hand-over to the service would end them). */
  liveSessions(): number;
  /** Push control_info to unlocked browsers (service changes from outside a request). */
  info(patch: Partial<ControlInfo>): void;
}

const OFF_SERVICE: ServiceControl = {
  status: (): ServiceStatus => ({ supported: false, installed: false, running: false, startAtLogin: false, platform: process.platform }),
  set: async () => {
    throw new ControlError(400, "The background service isn't available here.");
  },
};
const NO_INSTALLER: InstallControl = {
  plan: async () => ({ applied: false, agents: [] }),
  apply: async () => {
    throw new ControlError(503, "Installing isn't available in this office.");
  },
};

function denied(res: ServerResponse, status: number, message: string): void {
  const html = `<!doctype html><meta charset="utf-8"><title>agent-visualizer</title><body style="font:15px system-ui;padding:3em;background:#141414;color:#eee"><p>${message}</p>`;
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": String(Buffer.byteLength(html)),
  });
  res.end(html);
}

export function createControlPlane(o: ControlPlaneOptions): Plane {
  const frames = new Set<(f: ControlFrame) => void>();
  const emit = (f: ControlFrame) => {
    for (const fn of frames) {
      try {
        fn(f);
      } catch {
        // One broken stream must not stop the rest.
      }
    }
  };
  const info = (patch: Partial<ControlInfo>) => emit({ event: "control_info", data: patch });
  const onFrame = (fn: (f: ControlFrame) => void): Disposable => {
    frames.add(fn);
    return { dispose: () => void frames.delete(fn) };
  };

  if (!o.enabled) {
    return {
      enabled: false,
      handle(_req, res, path) {
        if (path !== "/unlock" && path !== "/api/control" && !path.startsWith("/api/control/") && !path.startsWith(HOOK_PREFIX)) return false;
        sendJson(res, 404, { error: "Controls are off in this office." });
        return true;
      },
      unlocked: () => false,
      onFrame,
      ownedPids: () => [],
      liveSessions: () => 0,
      info,
      shutdown: async () => {},
    };
  }

  const now = o.now ?? Date.now;
  const userHome = o.userHome ?? homedir();
  const home = o.home ?? officeHome();
  const log = o.log ?? (() => {});
  const auth = new ControlAuth(home, { now });
  auth.ensure();
  const allowed = allowedHosts(o.host);
  const keys = o.keys ?? createKeyStore(home, { now });
  const hired = new HiredFolders(home);
  const linker = o.linker ?? createLinker(o.state, userHome);
  const office = createOfficePort(o.state, linker, { home: userHome, hired: () => hired.list(), exists: isDir });
  let viewers: () => number = () => 0;

  const ctx: ControlContext = {
    home,
    userHome,
    version: o.version,
    platform: o.platform ?? process.platform,
    now,
    log,
    agentEnv: () => agentEnv(),
    officeUrl: o.officeUrl,
    office,
    keys,
    viewers: () => viewers(),
  };
  const pctx: PlacesContext = {
    ...ctx,
    providerEnv: () => ({ ...process.env, ...keys.platformEnv() }),
    pty: o.pty ?? (async () => null),
    watch: o.watch ?? (() => ({ dispose() {} })),
  };

  let places: Places | null = null;
  let sessions: SessionManager | null = null;
  try {
    places = o.places ? o.places(pctx) : null;
  } catch (err) {
    log(`control: sandboxes unavailable (${scrubMessage((err as Error).message).slice(0, 120)})`, "warn");
  }
  try {
    sessions = o.sessions ? o.sessions(ctx, places) : null;
  } catch (err) {
    log(`control: hiring unavailable (${scrubMessage((err as Error).message).slice(0, 120)})`, "warn");
  }

  let logins: Logins | null = null;
  if (sessions) logins = createLogins({ ctx, keys, pty: o.pty ?? (async () => null) });

  // Probe the agents now, so the first page's GET /api/control (and its Hire button) doesn't wait on
  // it. A page that got there first (the agents on PATH, without versions) hears the answer as control_info.
  sessions?.availability().then((agents) => info({ agents }), () => {});

  const subs: Disposable[] = [];
  subs.push(keys.onChange(() => info({ keys: keys.list(), ...(logins ? { logins: logins.status() } : {}) })));
  if (logins) subs.push(logins.onChange((flows) => info({ logins: flows })));
  if (places) subs.push(places.onChange((providers) => info({ providers })));
  if (sessions) {
    subs.push(sessions.onChange((s) => emit({ event: "control", data: s })));
    subs.push(sessions.onGone((id) => emit({ event: "control_gone", data: { id } })));
  }
  // Agents installed or upgraded while the office runs show up in the hire form without a reload.
  let lastAgents = "";
  const poll = setInterval(() => {
    // Only while an unlocked browser watches (the server's own frame listener is always there).
    if (!sessions || viewers() === 0) return;
    sessions.availability().then((a) => {
      const j = JSON.stringify(a);
      if (lastAgents && j !== lastAgents) info({ agents: a });
      lastAgents = j;
    }, () => {});
  }, 5 * 60_000);
  poll.unref?.();

  const api = createApi({
    ctx,
    auth,
    keys,
    sessions,
    places,
    hired,
    service: o.service ?? OFF_SERVICE,
    installer: o.installer ?? NO_INSTALLER,
    ...(o.herdr ? { herdr: o.herdr } : {}),
    info,
    pingMs: o.pingMs,
    logins,
    ...(o.shellNames ? { shellNames: o.shellNames } : {}),
  });

  async function hook(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return sendJson(res, 405, { error: "POST only." });
    }
    if (fromBrowser(req)) return sendJson(res, 403, { error: "Not for browsers." });
    const m = /^([^/]{1,64})\/([a-z-]{1,32})$/.exec(path.slice(HOOK_PREFIX.length));
    if (!m || !sessions) return sendJson(res, 404, { error: "No such session." });
    let body: unknown;
    try {
      body = await readJson(req, BIG_BODY);
    } catch (err) {
      // Claude sends JSON; be lenient about the content type, strict about the size.
      if (err instanceof ControlError && err.status === 415) body = undefined;
      else throw err;
    }
    const auth = String(req.headers.authorization ?? "");
    const token = /^Bearer\s+(\S+)$/i.exec(auth)?.[1] ?? "";
    const ctl = new AbortController();
    const abort = () => ctl.abort();
    res.on("close", abort);
    try {
      const r = await sessions.hook({ sessionId: decode(m[1]!), event: m[2]!, token, body: body ?? {}, signal: ctl.signal });
      if (!res.destroyed) sendJson(res, r.status, r.body ?? {});
    } finally {
      res.off("close", abort);
    }
  }

  function unlock(req: IncomingMessage, res: ServerResponse): void {
    // GET only: a HEAD (a link checker, a prefetch) must not burn the code.
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return sendJson(res, 405, { error: "GET only." });
    }
    // A link another site (or another localhost port) puts in front of you is never an unlock.
    if (!hostAllowed(req.headers.host, allowed) || foreignOrigin(req)) return denied(res, 403, "This unlock link can only be opened directly.");
    const t = new URL(req.url ?? "/", "http://office").searchParams.get("t");
    if (!auth.redeem(t)) return denied(res, 403, `This unlock link expired or was already used. Run <code>${selfCommand()} open</code> for a new one.`);
    // The page trades the #fragment (never sent anywhere) for its token once; see auth.ts.
    res.writeHead(303, { ...SECURITY_HEADERS, Location: `/#unlock=${auth.mintHandoff()}`, "Set-Cookie": auth.cookie(), "Cache-Control": "no-store", "Content-Length": "0" });
    res.end();
  }

  /** POST /api/control/token {handoff}: the page token, once per /unlock (the cookie, not the token, is checked). */
  async function token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return sendJson(res, 405, { error: "POST only." });
    }
    const body = (await readJson(req, SMALL_BODY)) as { handoff?: unknown } | undefined;
    if (!auth.takeHandoff(body?.handoff)) return sendJson(res, 403, { error: `This unlock link expired or was already used. Run ${selfCommand()} open for a new one.` });
    sendJson(res, 200, { token: auth.pageToken() });
  }

  function fail(res: ServerResponse, err: unknown): void {
    if (err instanceof ControlError) return sendJson(res, err.status, { error: err.message });
    log(`control: ${scrubMessage(String((err as Error)?.message ?? err)).slice(0, 200)}`, "warn");
    sendJson(res, 500, { error: "Internal error" });
  }

  return {
    enabled: true,
    context: ctx,
    auth,
    office,
    keys,
    handle(req, res, path) {
      if (path === "/unlock") {
        unlock(req, res);
        return true;
      }
      if (path.startsWith(HOOK_PREFIX)) {
        hook(req, res, path).catch((err) => fail(res, err));
        return true;
      }
      if (path !== "/api/control" && !path.startsWith("/api/control/")) return false;
      const exchange = path === "/api/control/token";
      const no = checkControl(req, allowed, auth, { cookieOnly: exchange });
      if (no) {
        req.resume();
        sendJson(res, no.status, { error: no.error });
        return true;
      }
      (exchange ? token(req, res) : api(req, res, path)).catch((err) => fail(res, err));
      return true;
    },
    unlocked: (req) => hostAllowed(req.headers.host, allowed) && !foreignOrigin(req) && auth.unlocked(req),
    onFrame,
    setViewers(count) {
      viewers = count;
    },
    ownedPids: () => {
      try {
        return [...(sessions?.ownedPids() ?? []), ...(logins?.pids() ?? [])];
      } catch {
        return [];
      }
    },
    liveSessions: () => sessions?.list().filter((s) => s.status !== "exited" && s.status !== "failed").length ?? 0,
    info,
    async shutdown() {
      clearInterval(poll);
      // Agents first, with the listeners still on, so open panels hear their sessions exit.
      try {
        await sessions?.shutdown();
      } catch {
        // Closing anyway.
      }
      for (const s of subs) s.dispose();
      logins?.shutdown();
      try {
        places?.shutdown();
      } catch {
        // Closing anyway.
      }
      frames.clear();
    },
  };
}
