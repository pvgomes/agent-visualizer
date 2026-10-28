/*
 * Vercel Sandboxes as RemoteTargets, over Vercel's REST API with fetch (the
 * endpoints @vercel/sandbox 3.x uses; no SDK). Token, first that exists:
 * VERCEL_TOKEN, VERCEL_AUTH_TOKEN, VERCEL_OIDC_TOKEN, then the login the
 * standalone `sandbox` CLI stores after `npx sandbox login` (auth.json in
 * the com.vercel.cli data folder). It is read fresh each listing and never
 * printed or refreshed here: refreshing would rotate the CLI's refresh
 * token, so an expired login is reported instead.
 *
 *   list   GET  /v2/sandboxes?teamId&project        -> {sandboxes:[{name,status,currentSessionId}], pagination}
 *   exec   POST /v2/sandboxes/sessions/{sid}/cmd     {command:"sh", args:["-c", script], wait:true}
 *                                                  -> ndjson: {command}, {stream,data}..., {command:{exitCode}}
 *
 * Scope: VERCEL_TEAM_ID / VERCEL_ORG_ID and VERCEL_PROJECT_ID (comma lists
 * allowed), an OIDC token's own team and project, a linked
 * .vercel/project.json, else the CLI's default project
 * "vercel-sandbox-default-project" (where `sandbox create` and `sandbox sh`
 * put sandboxes) in the user's default team. Only `--vercel all` (or a
 * sandbox name) looks in every team the login belongs to: auto-detection
 * never execs into a teammate's sandbox in some other team. Nothing here creates a project, resumes a
 * stopped sandbox or extends one: a stopped sandbox is simply not listed, and
 * because its filesystem is snapshotted and restored on the next connect,
 * its transcripts are there again when it comes back.
 */
import { join } from "node:path";
import type { RemoteTarget } from "../shared/events.ts";
import {
  RemoteError, displayName, homeOf, http, jsonOf, jwtClaims, pick, readJson, str,
  type Availability, type Discovered, type Provider, type ProviderOptions, type Scope,
} from "./util.ts";

export const VERCEL_API = "https://vercel.com/api";
export const VERCEL_DEFAULT_PROJECT = "vercel-sandbox-default-project";
const TEAMS_TTL_MS = 10 * 60_000;
const MAX_PAGES = 10;

interface Login {
  token: string;
  via: string;
  teams?: string[];
  projects?: string[];
}

/** com.vercel.cli data folders, as xdg-app-paths resolves them, plus the legacy ~/.now. */
export function vercelAuthPaths(env: NodeJS.ProcessEnv, platform = process.platform): string[] {
  if (env.VERCEL_AUTH_CONFIG_DIR) return [join(env.VERCEL_AUTH_CONFIG_DIR, "auth.json")];
  const home = homeOf(env);
  const data =
    env.XDG_DATA_HOME ||
    (platform === "darwin"
      ? join(home, "Library", "Application Support")
      : platform === "win32"
        ? join(env.APPDATA || join(home, "AppData", "Roaming"), "xdg.data")
        : join(home, ".local", "share"));
  return [join(data, "com.vercel.cli", "auth.json"), join(home, ".now", "auth.json"), join(data, "now", "auth.json")];
}

const list = (v: string | undefined) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);

export function vercelLogin(o: ProviderOptions = {}): Login | { why: string; code: "missing" | "auth" } {
  const env = o.env ?? process.env;
  const now = (o.now ?? Date.now)();
  const teams = list(env.VERCEL_TEAM_ID ?? env.VERCEL_ORG_ID);
  const projects = list(env.VERCEL_PROJECT_ID);
  for (const name of ["VERCEL_TOKEN", "VERCEL_AUTH_TOKEN", "VERCEL_OIDC_TOKEN"] as const) {
    const token = str(env[name]);
    if (!token) continue;
    const c = jwtClaims(token);
    const owner = str(c?.owner_id);
    const project = str(c?.project_id);
    return { token, via: name, teams: teams ?? (owner ? [owner] : undefined), projects: projects ?? (project ? [project] : undefined) };
  }
  for (const path of vercelAuthPaths(env, o.platform)) {
    const a = readJson(path);
    if (!a || typeof a !== "object") continue;
    const token = str(a.token);
    if (!token) {
      if (str(a.refreshToken)) return { code: "auth", why: "sandbox CLI login expired (run `npx sandbox@latest list` once to refresh it)" };
      continue;
    }
    if (typeof a.expiresAt === "number" && a.expiresAt * 1000 < now + 60_000) {
      return { code: "auth", why: "sandbox CLI login expired (run `npx sandbox@latest list` once to refresh it)" };
    }
    return { token, via: "sandbox CLI login", teams, projects };
  }
  return { code: "missing", why: "not logged in (run `npx sandbox@latest login`, or set VERCEL_TOKEN)" };
}

interface Box {
  name: string;
  team: string;
  project: string;
  session: string;
}

export function createVercelProvider(o: ProviderOptions = {}): Provider {
  const timeoutMs = o.timeoutMs ?? 20_000;
  const env = o.env ?? process.env;
  const api = (str(env.AGENT_VISUALIZER_VERCEL_API) ?? VERCEL_API).replace(/\/+$/, "");
  const cache = new Map<string, { d: Discovered; box: Box }>();
  let teamsCache: { at: number; ids: string[]; all: boolean } | undefined;
  let token = "";

  const getLogin = () => {
    const l = vercelLogin(o);
    if ("why" in l) throw new RemoteError(l.code, `Vercel Sandbox: ${l.why}`);
    token = l.token;
    return l;
  };
  const headers = () => ({ authorization: `Bearer ${token}` });
  const get = async (path: string, what: string) => jsonOf(await http(api + path, { headers: headers(), timeoutMs, fetch: o.fetch }), what);

  /** Teams to look in when nothing pins them: the default team ("auto"), or it first and then every other ("all"). */
  async function teams(l: Login, scope: Scope): Promise<string[]> {
    if (l.teams?.length) return l.teams;
    const now = (o.now ?? Date.now)();
    if (!teamsCache || now - teamsCache.at >= TEAMS_TTL_MS) {
      const user = await get("/v2/user", "Vercel user");
      // A personal account without a default team: its own id is the scope.
      const def = str(user?.user?.defaultTeamId) ?? str(user?.user?.id);
      const ids: string[] = def ? [def] : [];
      if (scope === "all") {
        const t = await get("/v2/teams?limit=100", "Vercel teams");
        for (const x of Array.isArray(t?.teams) ? t.teams : []) if (str(x?.id) && !ids.includes(x.id)) ids.push(x.id);
      }
      teamsCache = { at: now, ids, all: scope === "all" };
    } else if (scope === "all" && !teamsCache.all) {
      teamsCache = undefined;
      return teams(l, scope);
    }
    return scope === "all" ? teamsCache.ids : teamsCache.ids.slice(0, 1);
  }

  function projectsFor(l: Login, team: string): string[] {
    if (l.projects?.length) return l.projects;
    const out = [VERCEL_DEFAULT_PROJECT];
    const linked = readJson(join(o.cwd ?? process.cwd(), ".vercel", "project.json"));
    if (str(linked?.projectId) && (!str(linked?.orgId) || linked.orgId === team)) out.push(linked.projectId);
    return out;
  }

  function targetFor(box: Box, id: string): RemoteTarget {
    return {
      host: { kind: "vercel", id, name: box.name },
      async exec(script, eo) {
        const ms = eo?.timeoutMs ?? timeoutMs;
        if (!token) getLogin();
        const q = new URLSearchParams({ teamId: box.team });
        const r = await http(`${api}/v2/sandboxes/sessions/${encodeURIComponent(box.session)}/cmd?${q}`, {
          method: "POST",
          headers: headers(),
          body: { command: "sh", args: ["-c", script], wait: true, logs: true, timeout: ms },
          timeoutMs: ms + 5_000,
          fetch: o.fetch,
        });
        if (r.status >= 400) jsonOf(r, `Vercel ${box.name}`);
        return parseCommandStream(r.text, box.name);
      },
    };
  }

  return {
    kind: "vercel",
    label: "Vercel Sandbox",
    keepsAwake: false, // a sandbox stops at its own timeout, whatever runs in it
    autoScope: "your default team",
    available(): Availability {
      const l = vercelLogin(o);
      return "why" in l ? { ok: l.code === "auth", why: l.why } : { ok: true, via: l.via };
    },
    async list(scope: Scope = "all") {
      const l = getLogin();
      const rows: { s: any; team: string; project: string }[] = [];
      for (const team of await teams(l, scope)) {
        for (const project of projectsFor(l, team)) {
          let cursor: string | undefined;
          for (let page = 0; page < MAX_PAGES; page++) {
            const q = new URLSearchParams({ teamId: team, project, limit: "50" });
            if (cursor) q.set("cursor", cursor);
            let j: any;
            try {
              j = await get(`/v2/sandboxes?${q}`, "Vercel sandboxes");
            } catch (err) {
              // This team has no such project, or the token can't see the team: not an error for discovery.
              if (["gone", "auth", "failed"].includes((err as RemoteError).code) && !l.teams?.length) break;
              throw err;
            }
            for (const s of Array.isArray(j?.sandboxes) ? j.sandboxes : []) rows.push({ s, team, project });
            cursor = str(j?.pagination?.next);
            if (!cursor) break;
          }
        }
      }
      const live = rows.filter(({ s }) => s?.status === "running" && str(s.currentSessionId) && str(s.name));
      const names = new Map<string, number>();
      for (const { s } of live) names.set(s.name, (names.get(s.name) ?? 0) + 1);
      const out: Discovered[] = [];
      const seen = new Set<string>();
      for (const { s, team, project } of live) {
        // Names are unique per project; only spell out the project when two collide.
        const id = names.get(s.name)! > 1 ? `vercel:${project}/${s.name}` : `vercel:${s.name}`;
        seen.add(id);
        let hit = cache.get(id);
        if (!hit) {
          const box: Box = { name: displayName(s.name), team, project, session: s.currentSessionId };
          const target = targetFor(box, id);
          hit = { box, d: { host: target.host, target } };
          cache.set(id, hit);
        }
        // A resumed sandbox gets a new session; the target follows it.
        hit.box.session = s.currentSessionId;
        hit.box.team = team;
        out.push(hit.d);
      }
      for (const id of [...cache.keys()]) if (!seen.has(id)) cache.delete(id);
      return out;
    },
  };
}

/** stdout of a `wait: true` command stream; rejects on a non-zero exit or a stream error. */
export function parseCommandStream(text: string, name: string): string {
  let stdout = "";
  let exit: number | null | undefined;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j?.command) {
      if (typeof j.command.exitCode === "number") exit = j.command.exitCode;
    } else if (j?.stream === "stdout" && typeof j.data === "string") {
      stdout += j.data;
    } else if (j?.stream === "error") {
      throw new RemoteError("failed", `Vercel ${name}: ${j.data?.code ?? "error"} ${j.data?.message ?? ""}`);
    }
  }
  if (exit === undefined || exit === null) throw new RemoteError("unreachable", `Vercel ${name}: command stream ended early`);
  if (exit !== 0) throw new RemoteError("failed", `Vercel ${name}: exit ${exit}`);
  return stdout;
}

/** For `--vercel <all|name>` and the installer. */
export async function createVercelTargets(sel = "all", o: ProviderOptions = {}): Promise<RemoteTarget[]> {
  const found = await createVercelProvider(o).list();
  return pick(found, sel, (d) => [d.host.name, d.host.id.slice("vercel:".length)]).map((d) => d.target);
}
