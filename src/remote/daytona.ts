/*
 * Daytona sandboxes as RemoteTargets, over Daytona's HTTP API with fetch (no
 * SDK). Credentials, first that exists: DAYTONA_API_KEY (or DAYTONA_JWT_TOKEN
 * with DAYTONA_ORGANIZATION_ID), then the daytona CLI's own login, read from
 * the active profile in its config.json (an API key, or the OAuth access
 * token plus the active organization). The login is re-read every listing,
 * so a token the CLI refreshes is picked up; it is never printed.
 *
 *   list   GET  {api}/sandbox?states=started            -> {items, nextCursor}
 *   exec   POST {toolboxProxyUrl}/{id}/process/execute  {command, timeout}
 *                                                       -> {exitCode, result}
 *
 * The toolbox URL comes with each sandbox (or GET /sandbox/{id}/toolbox-proxy-url),
 * as the SDK resolves it. The daemon runs `command` through the sandbox's
 * shell and returns stdout and stderr merged, so the script runs under sh
 * with stderr dropped.
 *
 * Scope: a Daytona login is one organization. Auto-detection only watches it
 * when it is the user's personal organization (GET /organizations says
 * `personal`); a shared team organization's sandboxes belong to colleagues
 * too, so they are watched only with `--daytona all` or by id.
 */
import type { RemoteTarget } from "../shared/events.ts";
import { shQuote } from "./source.ts";
import {
  RemoteError, displayName, http, jsonOf, pick, readJson, str, userConfigDir,
  type Availability, type Discovered, type Provider, type ProviderOptions, type Scope,
} from "./util.ts";
import { join } from "node:path";

export const DAYTONA_API = "https://app.daytona.io/api";
const PAGE = 100;
const MAX_PAGES = 20;
const ORGS_TTL_MS = 10 * 60_000;

export interface DaytonaLogin {
  api: string;
  headers: Record<string, string>;
  via: string;
  /** Only sandboxes in this target (region), from DAYTONA_TARGET. */
  target?: string;
}

/** Where the daytona CLI keeps its profiles. */
export function daytonaConfigPaths(env: NodeJS.ProcessEnv, platform = process.platform): string[] {
  const home = env.HOME || env.USERPROFILE || "";
  return [...new Set([
    join(userConfigDir(env, platform), "daytona", "config.json"),
    join(env.XDG_CONFIG_HOME || join(home, ".config"), "daytona", "config.json"),
  ])];
}

/** The login to use, or a reason there is none. Reads files, no network. */
export function daytonaLogin(o: ProviderOptions = {}): DaytonaLogin | { why: string; code: "missing" | "auth" } {
  const env = o.env ?? process.env;
  const now = (o.now ?? Date.now)();
  const apiFromEnv = str(env.DAYTONA_API_URL) ?? str(env.DAYTONA_SERVER_URL);
  const target = str(env.DAYTONA_TARGET);
  const org = str(env.DAYTONA_ORGANIZATION_ID);
  const key = str(env.DAYTONA_API_KEY);
  if (key) return { api: trim(apiFromEnv ?? DAYTONA_API), headers: auth(key, org), via: "DAYTONA_API_KEY", target };
  const jwt = str(env.DAYTONA_JWT_TOKEN);
  if (jwt && org) return { api: trim(apiFromEnv ?? DAYTONA_API), headers: auth(jwt, org), via: "DAYTONA_JWT_TOKEN", target };

  for (const path of daytonaConfigPaths(env, o.platform)) {
    const cfg = readJson(path);
    const profiles: any[] = Array.isArray(cfg?.profiles) ? cfg.profiles : [];
    const p = profiles.find((x) => x?.id === cfg?.activeProfile) ?? (profiles.length === 1 ? profiles[0] : undefined);
    if (!p) continue;
    const api = trim(apiFromEnv ?? str(p.api?.url) ?? DAYTONA_API);
    const pOrg = org ?? str(p.activeOrganizationId);
    const pKey = str(p.api?.key);
    if (pKey) return { api, headers: auth(pKey, pOrg), via: "daytona CLI (api key)", target };
    const tok = str(p.api?.token?.accessToken);
    if (tok) {
      const exp = Date.parse(p.api?.token?.expiresAt ?? "");
      if (Number.isFinite(exp) && exp < now + 30_000) {
        return { code: "auth", why: "daytona CLI login expired (run `daytona sandbox list` to refresh it, or set DAYTONA_API_KEY)" };
      }
      if (!pOrg) return { code: "auth", why: "daytona CLI has no active organization (run `daytona organization use`)" };
      return { api, headers: auth(tok, pOrg), via: "daytona CLI login", target };
    }
  }
  return { code: "missing", why: "not logged in (set DAYTONA_API_KEY or run `daytona login`)" };
}

function auth(token: string, org?: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, "x-daytona-source": "agent-visualizer", ...(org ? { "x-daytona-organization-id": org } : {}) };
}

const trim = (u: string) => u.replace(/\/+$/, "");

interface Box {
  id: string;
  name: string;
  proxy?: string;
}

export function createDaytonaProvider(o: ProviderOptions = {}): Provider {
  const timeoutMs = o.timeoutMs ?? 20_000;
  const cache = new Map<string, { d: Discovered; box: Box }>();
  let login: DaytonaLogin | undefined;
  let orgCheck: { at: number; key: string; personal: boolean | null } | undefined;

  /** Is the login's organization the user's personal one? null when Daytona won't say. */
  async function personalOrg(l: DaytonaLogin): Promise<boolean | null> {
    const id = l.headers["x-daytona-organization-id"] ?? "";
    const now = (o.now ?? Date.now)();
    if (orgCheck && orgCheck.key === id && now - orgCheck.at < ORGS_TTL_MS) return orgCheck.personal;
    let personal: boolean | null = null;
    try {
      const j = jsonOf(await http(`${l.api}/organizations`, { headers: l.headers, timeoutMs, fetch: o.fetch }), "Daytona organizations");
      const orgs: any[] = Array.isArray(j) ? j : Array.isArray(j?.items) ? j.items : [];
      const org = id ? orgs.find((x) => x?.id === id) : orgs.length === 1 ? orgs[0] : undefined;
      if (org && typeof org.personal === "boolean") personal = org.personal;
    } catch {
      // An API key may not be allowed to list organizations: it was set on purpose, so it counts.
    }
    orgCheck = { at: now, key: id, personal };
    return personal;
  }

  const getLogin = (): DaytonaLogin => {
    const l = daytonaLogin(o);
    if ("why" in l) throw new RemoteError(l.code, `Daytona: ${l.why}`);
    login = l;
    return l;
  };

  async function proxyOf(box: Box): Promise<string> {
    if (box.proxy) return box.proxy;
    return (box.proxy = await daytonaToolboxUrl(login ?? getLogin(), box.id, { timeoutMs, fetch: o.fetch }));
  }

  function targetFor(box: Box): RemoteTarget {
    return {
      host: { kind: "daytona", id: `daytona:${box.id}`, name: box.name },
      async exec(script, eo) {
        const ms = eo?.timeoutMs ?? timeoutMs;
        const l = login ?? getLogin();
        const url = `${await proxyOf(box)}/${encodeURIComponent(box.id)}/process/execute`;
        const r = await http(url, {
          method: "POST",
          headers: l.headers,
          body: { command: `sh -c ${shQuote(script)} 2>/dev/null`, timeout: Math.max(1, Math.ceil(ms / 1000)) },
          timeoutMs: ms + 5_000,
          fetch: o.fetch,
        });
        const j = jsonOf(r, `Daytona ${box.name}`);
        const code = j?.exitCode ?? j?.code ?? 0;
        if (code !== 0) throw new RemoteError("failed", `Daytona ${box.name}: exit ${code}`);
        return typeof j?.result === "string" ? j.result : "";
      },
    };
  }

  return {
    kind: "daytona",
    label: "Daytona",
    keepsAwake: true,
    autoScope: "your personal organization",
    available(): Availability {
      const l = daytonaLogin(o);
      return "why" in l ? { ok: l.code === "auth", why: l.why } : { ok: true, via: l.via };
    },
    async list(scope: Scope = "all") {
      const l = getLogin();
      if (scope === "auto" && (await personalOrg(l)) === false) {
        throw new RemoteError("missing", "Daytona: the active organization is shared; watch its sandboxes with --daytona all");
      }
      const items: any[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const q = new URLSearchParams({ states: "started", limit: String(PAGE) });
        if (cursor) q.set("cursor", cursor);
        const j = jsonOf(await http(`${l.api}/sandbox?${q}`, { headers: l.headers, timeoutMs, fetch: o.fetch }), "Daytona sandboxes");
        // Current API: {items, nextCursor}; older ones answer a bare array.
        const batch = Array.isArray(j) ? j : Array.isArray(j?.items) ? j.items : [];
        items.push(...batch);
        cursor = Array.isArray(j) ? undefined : str(j?.nextCursor);
        if (!cursor) break;
      }
      const out: Discovered[] = [];
      const seen = new Set<string>();
      for (const s of items) {
        const id = str(s?.id);
        if (!id || (s.state ?? "started") !== "started") continue;
        if (l.target && s.target && s.target !== l.target) continue;
        seen.add(id);
        let hit = cache.get(id);
        if (!hit) {
          const box: Box = { id, name: displayName(str(s.name) ?? id.slice(0, 8)) };
          const target = targetFor(box);
          hit = { box, d: { host: target.host, target } };
          cache.set(id, hit);
        }
        if (str(s.toolboxProxyUrl)) hit.box.proxy = trim(s.toolboxProxyUrl);
        hit.d.idleStopMin = typeof s.autoStopInterval === "number" ? s.autoStopInterval : 15;
        const act = Date.parse(s.lastActivityAt ?? "");
        hit.d.activityAt = Number.isFinite(act) ? act : undefined;
        out.push(hit.d);
      }
      for (const id of [...cache.keys()]) if (!seen.has(id)) cache.delete(id);
      return out;
    },
  };
}

/**
 * The toolbox base for a sandbox, as the SDK resolves it: GET /sandbox/{id}/toolbox-proxy-url,
 * else (older APIs) the toolbox under the API itself. Exec and the PTY live under `<url>/<id>`.
 */
export async function daytonaToolboxUrl(l: DaytonaLogin, id: string, o: { timeoutMs: number; fetch?: ProviderOptions["fetch"] }): Promise<string> {
  try {
    const j = jsonOf(await http(`${l.api}/sandbox/${encodeURIComponent(id)}/toolbox-proxy-url`, { headers: l.headers, timeoutMs: o.timeoutMs, fetch: o.fetch }), "Daytona toolbox url");
    if (str(j?.url)) return trim(j.url);
  } catch (err) {
    if ((err as RemoteError).code !== "gone") throw err;
  }
  return `${l.api}/toolbox`;
}

/** For `--daytona <all|id|name>` and the installer. */
export async function createDaytonaTargets(sel = "all", o: ProviderOptions = {}): Promise<RemoteTarget[]> {
  const found = await createDaytonaProvider(o).list();
  return pick(found, sel, (d) => [d.host.id.slice("daytona:".length), d.host.name]).map((d) => d.target);
}
