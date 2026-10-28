/*
 * Railway Sandboxes as RemoteTargets. Two transports, picked per call:
 *
 *  - GraphQL (https://backboard.railway.com/graphql/v2) with fetch, whenever a
 *    token is at hand: RAILWAY_API_TOKEN (account or workspace token),
 *    RAILWAY_TOKEN (a project token: its one environment), or the access token
 *    the logged-in railway CLI keeps in ~/.railway/config.json while it is
 *    unexpired. Discovery walks me.workspaces -> projects -> environments
 *    (cached 5 min) and asks every environment for its active sandboxes in
 *    one aliased query. Exec is the sandboxExec mutation, which caps each
 *    stream at 16,000 bytes: the script's output goes to a temp file in the
 *    sandbox, and anything bigger is gzipped there and paged back in
 *    newline-aligned slices.
 *  - The railway CLI, when the stored token has expired (running the CLI
 *    refreshes it, and the next call is back on GraphQL): `railway list
 *    --json`, `railway sandbox list --json -p -e`, `railway sandbox exec
 *    --id -p -e --timeout -- sh -c <script>`.
 *
 * Railway's API allows 1,000 requests an hour on Hobby (10,000 on Pro, read
 * from the RateLimit-Policy header), and the CLI spends from the same pot.
 * The office keeps to under half of it: discovery runs every 2 minutes, each
 * sandbox gets an even share of the rest as a token bucket (a poll that had
 * to page simply waits longer before the next one, so the pace follows what
 * polls really cost), reads are kept small so a poll fits one answer, and a
 * sliding-window budget refuses calls past the share as "throttled", which
 * the watcher backs off from without calling the sandbox offline. Polling
 * also counts as activity, so discovery reports each sandbox's
 * idleTimeoutMinutes and the remote manager stops polling a quiet one well
 * before that (see src/remote/index.ts).
 *
 * Scope: `--railway all` (or an id) looks in every workspace the token sees.
 * Auto-detection only looks where this user works: the project and
 * environment `railway link` tied to the current folder, the one the office
 * puts its sandboxes in (picked when hiring, or set in config.json), the
 * sandboxes the office created (sandboxes.json) and the ones the user's own
 * CLI created (its config records them). Nothing here creates, forks or
 * destroys a sandbox. Tokens are read, never printed or written.
 *
 * Where a new sandbox goes (railwayDest, for the control plane): the CLI
 * wants ids (`-p <project id>`; a name is "Project not found"), and a
 * `railway link` can point at a project that was deleted since, so every
 * project and environment is looked up in the account's own list (ids or
 * names in, ids out) before anything uses it.
 */
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { RemoteTarget } from "../shared/events.ts";
import { agentVisualizerHome, configPath } from "./config.ts";
import { shQuote, type TunedTarget } from "./source.ts";
import {
  RemoteError, displayName, homeOf, http, jsonOf, lastLine, pick, readJson, run, str, which,
  type Availability, type Discovered, type HttpResult, type Provider, type ProviderOptions, type Scope,
} from "./util.ts";

export const RAILWAY_GQL = "https://backboard.railway.com/graphql/v2";
const ENVS_TTL_MS = 5 * 60_000;
const DISCOVER_MS = 2 * 60_000;
/** The share of the hourly API quota the office lets itself use. */
const SHARE = 0.45;
/** Requests an hour kept for discovery out of that share (a listing every 2 min, projects every 5). */
const DISCOVERY_RESERVE = 80;
/** sandboxExec returns at most 16,000 bytes per stream; stay under it. */
export const RAILWAY_EXEC_CAP = 15_000;
/** A paged answer bigger than this is refused rather than fetched (100 calls of the hourly quota). */
const MAX_PAGED = 100 * RAILWAY_EXEC_CAP;
/** Reads per poll, small enough that a typical poll (gzipped) fits one answer. */
const READ_LIMITS = { prefetchBytes: 48 << 10, maxReadBytes: 96 << 10, maxBatchBytes: 384 << 10 };
/** Requests a sandbox may spend in a burst before its share's pace applies. */
const BURST = 12;
/** A sandbox whose share needs a longer wait than this is skipped for the round ("throttled"). */
const MAX_WAIT_MS = 45_000;

interface Token {
  token: string;
  project: boolean;
  via: string;
}

interface Env {
  projectId: string;
  projectName: string;
  environmentId: string;
  /** "" when the token can't say (a project token). */
  environmentName: string;
  workspace?: string;
}

interface Box extends Env {
  id: string;
  name: string;
}

/** A project a new sandbox can go in, with its environments. */
export interface RailwayProject {
  id: string;
  name: string;
  /** Its workspace's name, when the login sees more than one workspace. */
  workspace?: string;
  environments: { id: string; name: string }[];
}

/** Where a new sandbox goes: ids the CLI and the API accept, names for people, and why there. */
export interface RailwayDest {
  projectId: string;
  projectName: string;
  environmentId: string;
  environmentName: string;
  why: string;
}

/** An id pair, as the office stores it. */
export interface RailwayIds {
  projectId: string;
  environmentId: string;
}

/** What railwayDest goes by, most deliberate first. */
export interface DestHints {
  /** What this hire picked: ids, or names. */
  asked?: { project?: string; environment?: string };
  /** The office's last pick (control-state.json). */
  remembered?: RailwayIds;
  /** config.json's {"control": {"railway": {"project", "environment"}}}: ids, or names. */
  config?: { project?: string; environment?: string };
  /** Where the office's recorded sandboxes are, newest first. */
  office?: RailwayIds[];
  /** The `railway link` of the office's folder. */
  linked?: RailwayIds;
}

/** A usable API token, or why not (no network). */
export function railwayToken(o: ProviderOptions = {}): Token | { why: string; code: "missing" | "auth"; expired?: boolean } {
  const env = o.env ?? process.env;
  const now = (o.now ?? Date.now)();
  const api = str(env.RAILWAY_API_TOKEN);
  if (api) return { token: api, project: false, via: "RAILWAY_API_TOKEN" };
  const proj = str(env.RAILWAY_TOKEN);
  if (proj) return { token: proj, project: true, via: "RAILWAY_TOKEN" };
  const user = readJson(join(homeOf(env), ".railway", "config.json"))?.user;
  const access = str(user?.accessToken);
  if (access) {
    const exp = typeof user.tokenExpiresAt === "number" ? user.tokenExpiresAt * 1000 : Infinity;
    if (exp > now + 60_000) return { token: access, project: false, via: "railway CLI login" };
    return { code: "auth", why: "railway CLI login expired", expired: true };
  }
  const legacy = str(user?.token);
  if (legacy) return { token: legacy, project: false, via: "railway CLI login" };
  return { code: "missing", why: "not logged in (run `railway login`, or set RAILWAY_API_TOKEN)" };
}

/** A sliding-window request budget, sized from Railway's RateLimit-Policy header. */
export class RailwayBudget {
  quota = 1_000;
  windowMs = 3_600_000;
  private stamps: number[] = [];
  private retryAt = 0;

  constructor(private readonly now: () => number = Date.now) {}

  take(n = 1): void {
    const t = this.now();
    if (t < this.retryAt) throw new RemoteError("throttled", `Railway API rate limit reached: waiting ${Math.ceil((this.retryAt - t) / 1000)}s`);
    while (this.stamps.length && this.stamps[0]! <= t - this.windowMs) this.stamps.shift();
    if (this.stamps.length + n > this.quota * SHARE) throw new RemoteError("throttled", "pausing to stay well inside Railway's API rate limit");
    for (let i = 0; i < n; i++) this.stamps.push(t);
  }

  observe(r: HttpResult): void {
    const pol = r.header("ratelimit-policy") ?? ""; // "default";q=1000;w=3600
    const q = Number(pol.match(/q=(\d+)/)?.[1]);
    const w = Number(pol.match(/w=(\d+)/)?.[1]);
    if (q > 0) this.quota = q;
    if (w > 0) this.windowMs = w * 1000;
    if (r.status === 429) {
      const after = Number(r.header("retry-after"));
      this.retryAt = this.now() + (after > 0 ? after * 1000 : 60_000);
    }
  }

  /** Poll interval that lets `n` sandboxes share the budget, at one request a poll. */
  pollMs(n: number): number {
    return Math.min(120_000, Math.max(2_500, Math.ceil(this.msPerRequest(n))));
  }

  /** Each of `n` sandboxes may spend one request this often. */
  msPerRequest(n: number): number {
    const perWindow = Math.max(1, this.quota * SHARE - DISCOVERY_RESERVE * (this.windowMs / 3_600_000));
    return (this.windowMs * Math.max(1, n)) / perWindow;
  }

  get used(): number {
    return this.stamps.length;
  }
}

/** A sandbox the control plane already knows (its own record, or a listing): enough to exec in it. */
export interface RailwaySandboxRef {
  id: string;
  environmentId: string;
  projectId: string;
  name: string;
}

export interface RailwayProvider extends Provider {
  targetFor(box: RailwaySandboxRef): RemoteTarget;
  /**
   * The projects and environments the login sees (cached 5 min; `refresh` asks again). From the
   * API while a token works, else `railway list --json`, which also refreshes the CLI's login.
   */
  projects(o?: { refresh?: boolean }): Promise<RailwayProject[]>;
}

export function createRailwayProvider(o: ProviderOptions & { budget?: RailwayBudget } = {}): RailwayProvider {
  const env = o.env ?? process.env;
  const budget = o.budget ?? new RailwayBudget(o.now);
  const timeoutMs = o.timeoutMs ?? 20_000;
  const endpoint = str(env.RAILWAY_GRAPHQL_ENDPOINT) ?? RAILWAY_GQL;
  const bin = o.bin ?? "railway";
  const cache = new Map<string, { d: Discovered; box: Box }>();
  let envsCache: { at: number; key: string; envs: Env[] } | undefined;
  /** Running sandboxes at the last listing: how many share the budget. */
  let running = 1;
  const clock = o.now ?? Date.now;

  const cli = () => (o.bin ? o.bin : which(bin, env));

  async function gql(t: Token, query: string, variables: Record<string, unknown>, ms = timeoutMs, spend?: () => void): Promise<any> {
    const headers: Record<string, string> = t.project ? { "project-access-token": t.token } : { authorization: `Bearer ${t.token}` };
    budget.take();
    spend?.();
    const r = await http(endpoint, { method: "POST", headers, body: { query, variables }, timeoutMs: ms, fetch: o.fetch });
    budget.observe(r);
    const j = jsonOf(r, "Railway API");
    if (Array.isArray(j?.errors) && j.errors.length) {
      const msg = String(j.errors[0]?.message ?? "error");
      const code = /not authorized|unauthorized|authentication|invalid token|forbidden/i.test(msg) ? "auth" : /not found/i.test(msg) ? "gone" : "failed";
      throw new RemoteError(code, `Railway: ${msg}`);
    }
    return j?.data ?? {};
  }

  async function railwayCli(args: string[], ms = timeoutMs): Promise<string> {
    const path = cli();
    if (!path) throw new RemoteError("missing", "Railway: railway CLI not installed");
    budget.take(2); // the CLI makes its own API calls; count them conservatively
    const r = await run(path, args, { timeoutMs: ms + 5_000, env });
    if (r.timedOut || r.code === 124) throw new RemoteError("timeout", `Railway: \`railway ${args[0]} ${args[1] ?? ""}\` timed out`);
    if (r.code !== 0) {
      const why = lastLine(r.stderr) || lastLine(r.stdout);
      throw new RemoteError(/unauthor|log ?in|token/i.test(why) ? "auth" : "failed", `Railway CLI: ${why || `exit ${r.code}`}`);
    }
    return r.stdout;
  }

  /* ---------- discovery ---------- */

  async function envsViaApi(t: Token): Promise<Env[]> {
    if (t.project) {
      const d = await gql(t, "query { projectToken { projectId environmentId project { name } } }", {});
      const p = d.projectToken;
      return p?.environmentId ? [{ projectId: p.projectId, projectName: p.project?.name ?? "project", environmentId: p.environmentId, environmentName: "" }] : [];
    }
    const me = await gql(t, "query { me { workspaces { id name } } }", {});
    // Workspaces in parallel: discovery is on the startup path.
    const per = await Promise.all((me.me?.workspaces ?? []).map(async (w: { id: string; name?: string }) => {
      const out: Env[] = [];
      let after: string | undefined;
      for (let page = 0; page < 10; page++) {
        const d = await gql(
          t,
          "query($w: String!, $after: String) { projects(workspaceId: $w, first: 100, after: $after) { edges { node { id name environments { edges { node { id name } } } } } pageInfo { hasNextPage endCursor } } }",
          { w: w.id, after },
        );
        for (const { node } of d.projects?.edges ?? []) {
          for (const { node: e } of node.environments?.edges ?? []) {
            out.push({ projectId: node.id, projectName: node.name, environmentId: e.id, environmentName: str(e.name) ?? "", workspace: str(w.name) });
          }
        }
        if (!d.projects?.pageInfo?.hasNextPage) break;
        after = d.projects.pageInfo.endCursor;
      }
      return out;
    }));
    return per.flat();
  }

  async function envsViaCli(): Promise<Env[]> {
    const j = JSON.parse(await railwayCli(["list", "--json"]));
    const out: Env[] = [];
    for (const p of Array.isArray(j) ? j : []) {
      if (p?.deletedAt) continue;
      for (const e of p?.environments?.edges ?? []) {
        if (str(p.id) && str(e?.node?.id) && e.node.canAccess !== false) {
          out.push({ projectId: p.id, projectName: p.name ?? "project", environmentId: e.node.id, environmentName: str(e.node.name) ?? "", workspace: str(p.workspace?.name) });
        }
      }
    }
    return out;
  }

  async function environments(t: Token | undefined, refresh = false): Promise<Env[]> {
    const key = t ? (t.project ? "p:" : "a:") + t.via : "cli";
    const now = (o.now ?? Date.now)();
    if (!refresh && envsCache && envsCache.key === key && now - envsCache.at < ENVS_TTL_MS) return envsCache.envs;
    const envs = t ? await envsViaApi(t) : await envsViaCli();
    envsCache = { at: now, key, envs };
    return envs;
  }

  /** Raw sandbox rows {id, status, idleTimeoutMinutes} per environment. */
  async function sandboxes(t: Token | undefined, envs: Env[]): Promise<{ s: any; e: Env }[]> {
    const rows: { s: any; e: Env }[] = [];
    if (t) {
      for (let i = 0; i < envs.length; i += 25) {
        const slice = envs.slice(i, i + 25);
        const vars: Record<string, string> = {};
        const defs = slice.map((_, k) => `$e${k}: String!`).join(", ");
        const body = slice
          .map((e, k) => {
            vars[`e${k}`] = e.environmentId;
            return `e${k}: sandboxes(environmentId: $e${k}, active: true, first: 50) { edges { node { id status idleTimeoutMinutes } } }`;
          })
          .join("\n");
        const d = await gql(t, `query(${defs}) {\n${body}\n}`, vars);
        slice.forEach((e, k) => {
          for (const { node } of d[`e${k}`]?.edges ?? []) rows.push({ s: node, e });
        });
      }
      return rows;
    }
    for (const e of envs) {
      const out = await railwayCli(["sandbox", "list", "--json", "-p", e.projectId, "-e", e.environmentId]);
      const j = JSON.parse(out.slice(Math.max(0, out.indexOf("["))) || "[]");
      for (const s of Array.isArray(j) ? j : []) rows.push({ s, e });
    }
    return rows;
  }

  /* ---------- exec ---------- */

  async function sandboxExec(t: Token, box: Box, command: string, ms: number, spend?: () => void): Promise<string> {
    const d = await gql(
      t,
      "mutation($e: String!, $id: String!, $c: String!, $t: Int) { sandboxExec(environmentId: $e, id: $id, command: $c, timeoutSec: $t) { exitCode stdout truncated timedOut } }",
      { e: box.environmentId, id: box.id, c: command, t: Math.max(1, Math.ceil(ms / 1000)) },
      ms + 5_000,
      spend,
    );
    const x = d.sandboxExec;
    if (!x) throw new RemoteError("failed", `Railway ${box.name}: no exec result`);
    if (x.timedOut) throw new RemoteError("timeout", `Railway ${box.name}: timed out`);
    if (x.exitCode !== 0) throw new RemoteError("failed", `Railway ${box.name}: exit ${x.exitCode}`);
    if (x.truncated) throw new RemoteError("failed", `Railway ${box.name}: output truncated`);
    return typeof x.stdout === "string" ? x.stdout : "";
  }

  async function execApi(t: Token, box: Box, script: string, ms: number, spend?: () => void): Promise<string> {
    const first = await sandboxExec(t, box, pagedScript(script), ms, spend);
    const m = first.match(PAGED);
    if (!m) return first;
    const file = m[1]!;
    const size = Number(m[2]);
    const gz = m[3] === "gz";
    if (!(size <= MAX_PAGED)) {
      await sandboxExec(t, box, `rm -f ${shQuote(file)}`, ms, spend).catch(() => {});
      throw new RemoteError("failed", `Railway ${box.name}: answer too big to page (${Math.round(size / 1024)} KB)`);
    }
    let off = 0;
    let out = "";
    while (off < size) {
      const last = off + RAILWAY_EXEC_CAP >= size;
      const cmd = `tail -c +${off + 1} ${shQuote(file)} | head -c ${RAILWAY_EXEC_CAP}${last ? `; rm -f ${shQuote(file)}` : ""}`;
      const chunk = await sandboxExec(t, box, cmd, ms, spend);
      if (last) {
        out += chunk;
        break;
      }
      // Keep whole lines, so a multi-byte character split at the slice edge is re-read whole next time.
      const nl = chunk.lastIndexOf("\n");
      const keep = nl >= 0 ? chunk.slice(0, nl + 1) : chunk;
      const used = nl >= 0 ? Buffer.byteLength(keep, "utf8") : RAILWAY_EXEC_CAP;
      if (used <= 0) break;
      out += keep;
      off += used;
    }
    if (!gz) return out;
    try {
      return gunzipSync(Buffer.from(out.replace(/[^A-Za-z0-9+/=]/g, ""), "base64"), { maxOutputLength: 32 << 20 }).toString("utf8");
    } catch {
      throw new RemoteError("failed", `Railway ${box.name}: paged output was cut short`);
    }
  }

  async function execCli(box: Box, script: string, ms: number): Promise<string> {
    return railwayCli(
      ["sandbox", "exec", "--id", box.id, "-p", box.projectId, "-e", box.environmentId, "--timeout", String(Math.max(1, Math.ceil(ms / 1000))), "--", "sh", "-c", script],
      ms,
    );
  }

  /** The API when a token works, else the CLI (which also refreshes its stored login). */
  function transport(): Token | "cli" {
    const t = railwayToken(o);
    if (!("why" in t)) return t;
    if (cli()) return "cli";
    throw new RemoteError(t.code, `Railway: ${t.why}`);
  }

  function targetFor(box: Box): RemoteTarget {
    // This sandbox's share of the budget as a token bucket: bursts are fine, the average is held.
    let tokens = BURST;
    let at = clock();
    const refill = () => {
      const now = clock();
      tokens = Math.min(BURST, tokens + (now - at) / budget.msPerRequest(running));
      at = now;
    };
    const spend = () => {
      refill();
      tokens -= 1;
    };
    const target: TunedTarget = {
      host: { kind: "railway", id: `railway:${box.id}`, name: box.name },
      readLimits: READ_LIMITS,
      async exec(script, eo) {
        const ms = eo?.timeoutMs ?? timeoutMs;
        const t = transport();
        refill();
        if (tokens < 1) {
          const wait = (1 - tokens) * budget.msPerRequest(running);
          if (wait > MAX_WAIT_MS) throw new RemoteError("throttled", `Railway ${box.name}: waiting for its share of the API budget`);
          await new Promise((r) => setTimeout(r, wait).unref?.());
        }
        if (t === "cli") {
          spend();
          spend(); // the CLI makes its own API calls
          return execCli(box, script, ms);
        }
        return execApi(t, box, script, ms, spend);
      },
    };
    return target;
  }

  return {
    targetFor: (box: RailwaySandboxRef) => targetFor({ ...box, projectName: box.name, environmentName: "" }),
    async projects(po = {}) {
      const t = transport();
      return groupProjects(await environments(t === "cli" ? undefined : t, po.refresh));
    },
    kind: "railway",
    label: "Railway",
    keepsAwake: true,
    discoverMs: DISCOVER_MS,
    autoScope: "the linked project, the office's project, and the sandboxes the office and your railway CLI created",
    available(): Availability {
      const t = railwayToken(o);
      if (!("why" in t)) return { ok: true, via: t.via };
      if (cli() && (t.expired || readJson(join(homeOf(env), ".railway", "config.json"))?.user)) return { ok: true, via: "railway CLI" };
      return { ok: t.code === "auth", why: t.why };
    },
    async list(scope: Scope = "all") {
      const t = transport();
      const tok = t === "cli" ? undefined : t;
      const all = await environments(tok);
      const mine = scope === "auto" ? ownScope(env, o.cwd ?? process.cwd(), groupProjects(all)) : undefined;
      const envs = mine ? all.filter((e) => mine.envs.has(e.environmentId) || mine.boxes.has(e.environmentId)) : all;
      const rows = (await sandboxes(tok, envs)).filter(({ s, e }) => {
        if (!mine || mine.envs.has(e.environmentId)) return true;
        return !!mine.boxes.get(e.environmentId)?.has(str(s?.id) ?? "");
      });
      const out: Discovered[] = [];
      const seen = new Set<string>();
      running = Math.max(1, rows.filter(({ s }) => str(s?.id) && s.status === "RUNNING").length);
      for (const { s, e } of rows) {
        const id = str(s?.id);
        if (!id || s.status !== "RUNNING") continue;
        seen.add(id);
        let hit = cache.get(id);
        if (!hit) {
          const box: Box = { ...e, id, name: displayName(`${e.projectName}:${id.slice(0, 6)}`) };
          const target = targetFor(box);
          hit = { box, d: { host: target.host, target } };
          cache.set(id, hit);
        }
        hit.d.idleStopMin = typeof s.idleTimeoutMinutes === "number" ? s.idleTimeoutMinutes : 30;
        hit.d.pollMs = budget.pollMs(running);
        hit.d.meta = { projectId: e.projectId, environmentId: e.environmentId };
        out.push(hit.d);
      }
      for (const id of [...cache.keys()]) if (!seen.has(id)) cache.delete(id);
      return out;
    },
  };
}

/**
 * Where this user works: the environment `railway link` tied to `cwd` (or a folder above it), the
 * one the office puts its sandboxes in once it has been picked or set (see officeHints), and the
 * sandboxes the office and the railway CLI created (by environment). Ids that aren't in the
 * account's environments any more simply match nothing.
 */
export function ownScope(env: NodeJS.ProcessEnv, cwd: string, projects: RailwayProject[] = []): { envs: Set<string>; boxes: Map<string, Set<string>> } {
  const cfg = readJson(join(homeOf(env), ".railway", "config.json"));
  const envs = new Set<string>();
  const boxes = new Map<string, Set<string>>();
  const add = (e: string | undefined, id: string | undefined) => {
    if (e && id) (boxes.get(e) ?? boxes.set(e, new Set()).get(e)!).add(id);
  };
  const linked = linkedTo(env, cwd);
  if (linked) envs.add(linked.environmentId);
  const office = officeHints(env);
  if (office.remembered) envs.add(office.remembered.environmentId);
  else if (office.config?.project && projects.length) {
    const w = railwayDest(projects, { asked: office.config }).dest;
    if (w) envs.add(w.environmentId);
  }
  for (const r of office.boxes) add(r.environmentId, r.id);
  const made = cfg?.sandboxes && typeof cfg.sandboxes === "object" ? cfg.sandboxes : {};
  for (const sb of Object.values<any>(made)) add(str(sb?.environmentId), str(sb?.id));
  return { envs, boxes };
}

/** The project and environment `railway link` tied to `cwd` or the nearest folder above it (ids, unchecked). */
export function linkedTo(env: NodeJS.ProcessEnv, cwd: string): (RailwayIds & { dir: string }) | undefined {
  const linked = readJson(join(homeOf(env), ".railway", "config.json"))?.projects;
  let best = "";
  let ids: RailwayIds | undefined;
  for (const [dir, p] of Object.entries<any>(linked && typeof linked === "object" ? linked : {})) {
    const d = dir.replace(/[\\/]+$/, "");
    // On Windows the CLI records the folder as C:\Users\me\code.
    const sep = /^[A-Za-z]:(?:\\|$)/.test(d) ? "\\" : "/";
    if ((cwd === d || cwd.startsWith(d + sep)) && d.length > best.length && str(p?.project) && str(p?.environment)) {
      best = d;
      ids = { projectId: str(p.project)!, environmentId: str(p.environment)! };
    }
  }
  return ids ? { ...ids, dir: best } : undefined;
}

/** Files of $AGENT_VISUALIZER_HOME (src/control/types.ts FILES) that say where the office keeps its Railway sandboxes. */
const STATE_FILE = "control-state.json";
const REGISTRY_FILE = "sandboxes.json";

/**
 * What the office knows without asking Railway: its last pick (control-state.json "railway"),
 * config.json's "control": {"railway": {...}}, and the sandboxes it recorded (sandboxes.json).
 */
export function officeHints(env: NodeJS.ProcessEnv): { remembered?: RailwayIds; config?: { project?: string; environment?: string }; boxes: (RailwayIds & { id: string })[] } {
  const home = agentVisualizerHome(env);
  const st = readJson(join(home, STATE_FILE))?.railway;
  const remembered = str(st?.projectId) && str(st?.environmentId) ? { projectId: str(st.projectId)!, environmentId: str(st.environmentId)! } : undefined;
  const c = readJson(configPath(env))?.control?.railway;
  const config = str(c?.project) ? { project: str(c.project), environment: str(c?.environment) } : undefined;
  const rows: any[] = readJson(join(home, REGISTRY_FILE))?.sandboxes;
  const boxes = (Array.isArray(rows) ? rows : [])
    .filter((r) => r?.provider === "railway" && str(r.id) && str(r.environmentId) && str(r.projectId))
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))
    .map((r) => ({ id: str(r.id)!, projectId: str(r.projectId)!, environmentId: str(r.environmentId)! }));
  return { ...(remembered ? { remembered } : {}), ...(config ? { config } : {}), boxes };
}

/** Environments grouped by project, in listing order; workspaces named only when there are several. */
function groupProjects(envs: Env[]): RailwayProject[] {
  const byId = new Map<string, RailwayProject>();
  const spaces = new Set(envs.map((e) => e.workspace ?? ""));
  for (const e of envs) {
    let p = byId.get(e.projectId);
    if (!p) byId.set(e.projectId, (p = { id: e.projectId, name: e.projectName, ...(spaces.size > 1 && e.workspace ? { workspace: e.workspace } : {}), environments: [] }));
    if (!p.environments.some((x) => x.id === e.environmentId)) p.environments.push({ id: e.environmentId, name: e.environmentName });
  }
  return [...byId.values()];
}

const OFFICE_NAME = /^agent-?visualizer/i;
const names = (xs: { name: string }[]) => xs.slice(0, 6).map((x) => x.name || "(unnamed)").join(", ") + (xs.length > 6 ? ", …" : "");

/** A project by id, else by name (exact, then any case). A string is the problem. */
function findProject(projects: RailwayProject[], s: string): RailwayProject | string {
  const byId = projects.find((p) => p.id === s);
  if (byId) return byId;
  let hits = projects.filter((p) => p.name === s);
  if (!hits.length) hits = projects.filter((p) => p.name.toLowerCase() === s.toLowerCase());
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) return `${hits.length} Railway projects are called "${s}": pick one by its id`;
  return `No project "${s}" in your Railway account (it has ${names(projects)})`;
}

function findEnv(p: RailwayProject, s: string): RailwayProject["environments"][number] | string {
  const hit = p.environments.find((e) => e.id === s) ?? p.environments.find((e) => e.name === s) ?? p.environments.find((e) => e.name.toLowerCase() === s.toLowerCase());
  return hit ?? `Railway project "${p.name}" has no environment "${s}" (it has ${names(p.environments)})`;
}

export const NO_RAILWAY_PROJECT =
  "Your Railway account has no project to put a sandbox in. Create an empty one (railway.com/new, or `railway init` in any folder), then hire again";

/**
 * Where a new sandbox goes: what the hire asked for (ids or names), else a default, in this
 * order: the office's last pick, config.json, a project the office's sandboxes are in, the one
 * project named for the office (agent-visualizer…), the `railway link` of the office's folder, the
 * account's only project. Every candidate is looked up in `projects`, so a stale link or a
 * deleted project is skipped, never passed on. No dest: `problem` says why, plainly; `note` is a
 * config.json entry that didn't match, worth showing even when another default was found.
 */
export function railwayDest(projects: RailwayProject[], h: DestHints): { dest?: RailwayDest; problem?: string; note?: string } {
  const usable = projects.filter((p) => p.environments.length);
  if (!usable.length) return { problem: NO_RAILWAY_PROJECT };
  const make = (p: RailwayProject, e: RailwayProject["environments"][number], why: string): RailwayDest => ({ projectId: p.id, projectName: p.name, environmentId: e.id, environmentName: e.name, why });
  /** An environment of `p` when nothing names one: one the office or the link already used there, else production, else the first. */
  const envOf = (p: RailwayProject) => {
    for (const ids of [h.remembered, h.linked, ...(h.office ?? [])]) {
      const e = ids?.projectId === p.id ? p.environments.find((x) => x.id === ids.environmentId) : undefined;
      if (e) return e;
    }
    return p.environments.find((e) => e.name === "production") ?? p.environments[0]!;
  };
  const byIds = (ids: RailwayIds | undefined, why: string) => {
    const p = ids && usable.find((x) => x.id === ids.projectId);
    return p ? make(p, p.environments.find((e) => e.id === ids!.environmentId) ?? envOf(p), why) : undefined;
  };

  if (h.asked?.project) {
    const p = findProject(usable, h.asked.project);
    if (typeof p === "string") return { problem: p };
    const e = h.asked.environment ? findEnv(p, h.asked.environment) : envOf(p);
    if (typeof e === "string") return { problem: e };
    return { dest: make(p, e, "picked") };
  }

  let note: string | undefined;
  const last = byIds(h.remembered, "last used");
  if (last) return { dest: last };
  if (h.config?.project) {
    const p = findProject(usable, h.config.project);
    const e = typeof p === "string" ? p : h.config.environment ? findEnv(p, h.config.environment) : envOf(p);
    if (typeof p !== "string" && typeof e !== "string") return { dest: make(p, e, "config.json") };
    note = `config.json's control.railway doesn't match: ${typeof p === "string" ? p : e}`;
  }
  const out = (dest: RailwayDest) => ({ dest, ...(note ? { note } : {}) });
  for (const r of h.office ?? []) {
    const w = byIds(r, "has the office's sandboxes");
    if (w) return out(w);
  }
  const named = usable.filter((p) => OFFICE_NAME.test(p.name));
  if (named.length === 1) return out(make(named[0]!, envOf(named[0]!), "named for the office"));
  const link = byIds(h.linked, "linked to the office's folder");
  if (link) return out(link);
  if (usable.length === 1) return out(make(usable[0]!, envOf(usable[0]!), "your only project"));
  return { problem: `Pick the Railway project for the new sandbox: your account has ${usable.length} (${names(usable)})`, ...(note ? { note } : {}) };
}

const PAGED = /^@@agent-visualizer-paged (\/tmp\/\.agent-visualizer-[A-Za-z0-9._-]+) (\d+) (gz|raw)\n?$/;

/**
 * Run the script into a temp file; print it if it fits one answer, else say
 * where it is, how big, and whether it was gzipped (base64 of gzip: polls are
 * mostly base64 of JSON, which shrinks ~7x, so a 256 KB read is ~3 pages).
 */
export function pagedScript(script: string, cap = RAILWAY_EXEC_CAP): string {
  return [
    `t=$(mktemp /tmp/.agent-visualizer-XXXXXXXX 2>/dev/null) || t=/tmp/.agent-visualizer-$$`,
    `find /tmp -maxdepth 1 -name '.agent-visualizer-*' -mmin +10 -exec rm -f {} + 2>/dev/null`,
    `sh -c ${shQuote(script)} >"$t" 2>/dev/null; rc=$?`,
    `if [ "$rc" -ne 0 ]; then rm -f "$t"; exit "$rc"; fi`,
    `n=$(wc -c <"$t" | tr -d ' ')`,
    `if [ "$n" -le ${cap} ]; then cat "$t"; rm -f "$t"; exit 0; fi`,
    `e=raw`,
    `if command -v gzip >/dev/null 2>&1 && command -v base64 >/dev/null 2>&1 && gzip -c <"$t" >"$t.gz" 2>/dev/null && base64 <"$t.gz" >"$t.z" 2>/dev/null; then mv -f "$t.z" "$t"; e=gz; n=$(wc -c <"$t" | tr -d ' '); fi`,
    `rm -f "$t.gz" "$t.z"`,
    `printf '@@agent-visualizer-paged %s %s %s\\n' "$t" "$n" "$e"`,
    "",
  ].join("\n");
}

/** For `--railway <all|id>` and the installer. */
export async function createRailwayTargets(sel = "all", o: ProviderOptions = {}): Promise<RemoteTarget[]> {
  const found = await createRailwayProvider(o).list();
  return pick(found, sel, (d) => [d.host.id.slice("railway:".length), d.host.name]).map((d) => d.target);
}
