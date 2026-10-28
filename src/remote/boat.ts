/*
 * boat (boat.dev) sandboxes, persistent Ubuntu VMs, as RemoteTargets. The
 * HTTP API with fetch when a key is at hand: BOAT_API_KEY (BOAT_API_BASE or
 * BOAT_API_URL to point elsewhere, BOAT_ORG for an organization wallet), or
 * the key the boat CLI saved in ~/.config/ascii/boat/config.json. Without a
 * key, the `boat` CLI itself when it is on PATH.
 *
 *   list   GET  /sandboxes?state=ready,idle,running   -> {sandboxes:[{id,name,state}], pageInfo}
 *   exec   POST /sandboxes/{id}/commands {command, timeoutSeconds}
 *                                                   -> {exitCode, stdout, stdoutTruncated, timedOut}
 *   CLI    boat list --json, boat exec <id> --timeout N --json -- sh -c <script>
 *
 * boat also streams its integrated agents' turns (`boat events`, GET
 * /sandboxes/{id}/events), but those only cover `boat prompt` runs, so the
 * office reads the agents' own transcripts here like everywhere else.
 * Commands don't push a sandbox's auto-stop deadline (only agent prompts
 * do), so polling never keeps one running. But boat keeps every command run
 * through its API or `boat exec`, with its output, in the sandbox's command
 * history for 90 days (docs.boat.dev/data-retention), and a poll's output is
 * transcript bytes: prompts, tool output, anything secret in them. So boat is
 * never auto-detected; it is watched only when asked for with `--boat`, and
 * the office says what that means when it starts.
 */
import { join } from "node:path";
import type { RemoteTarget } from "../shared/events.ts";
import { shQuote } from "./source.ts";
import {
  RemoteError, displayName, http, jsonOf, lastLine, pick, readJson, run, str, userConfigDir, which,
  type Availability, type Discovered, type Provider, type ProviderOptions,
} from "./util.ts";

export const BOAT_API = "https://boat.dev/api/v1";
const LIVE = new Set(["ready", "idle", "running"]);
const MAX_PAGES = 10;

interface Key {
  key: string;
  api: string;
  org?: string;
  via: string;
}

export function boatConfigPath(env: NodeJS.ProcessEnv, platform = process.platform): string {
  // The CLI documents ~/.config/ascii/boat/config.json; XDG_CONFIG_HOME moves it on Linux.
  const home = env.HOME || env.USERPROFILE || "";
  const base = platform === "win32" ? userConfigDir(env, platform) : env.XDG_CONFIG_HOME || join(home, ".config");
  return join(base, "ascii", "boat", "config.json");
}

/** The first boat_/box_ key-looking string under a key-ish field, wherever the CLI nests it. */
function findKey(v: unknown, depth = 0): string | undefined {
  if (!v || typeof v !== "object" || depth > 4) return undefined;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (typeof x === "string" && /key|token/i.test(k) && /^(boat|box)_[A-Za-z0-9_-]{8,}$/.test(x)) return x;
  }
  for (const x of Object.values(v as Record<string, unknown>)) {
    const found = findKey(x, depth + 1);
    if (found) return found;
  }
  return undefined;
}

export function boatKey(o: ProviderOptions = {}): Key | { why: string; code: "missing" } {
  const env = o.env ?? process.env;
  const api = (str(env.BOAT_API_BASE) ?? str(env.BOAT_API_URL) ?? BOAT_API).replace(/\/+$/, "");
  const org = str(env.BOAT_ORG);
  const key = str(env.BOAT_API_KEY);
  if (key) return { key, api, org, via: "BOAT_API_KEY" };
  const cfg = readJson(boatConfigPath(env, o.platform));
  const saved = findKey(cfg);
  if (saved) {
    const url = str(cfg?.apiUrl) ?? str(cfg?.api_url) ?? str(cfg?.apiBase);
    return { key: saved, api: str(env.BOAT_API_BASE) || !url ? api : url.replace(/\/+$/, ""), org, via: "boat CLI login" };
  }
  return { code: "missing", why: "not logged in (run `boat login`, or set BOAT_API_KEY)" };
}

interface Box {
  id: string;
  name: string;
}

export function createBoatProvider(o: ProviderOptions = {}): Provider {
  const env = o.env ?? process.env;
  const timeoutMs = o.timeoutMs ?? 20_000;
  const cache = new Map<string, Discovered>();
  const cli = () => (o.bin ? o.bin : which("boat", env));
  const cliEnv = { ...env, BOAT_NO_UPDATE: "1" };

  const headers = (k: Key): Record<string, string> => ({ authorization: `Bearer ${k.key}`, ...(k.org ? { "x-boat-org": k.org } : {}) });

  function transport(): Key | "cli" {
    const k = boatKey(o);
    if (!("why" in k)) return k;
    if (cli()) return "cli";
    throw new RemoteError("missing", `boat: ${k.why}`);
  }

  async function boatCli(args: string[], ms: number): Promise<string> {
    const path = cli();
    if (!path) throw new RemoteError("missing", "boat: CLI not installed");
    const r = await run(path, args, { timeoutMs: ms + 5_000, env: cliEnv });
    if (r.timedOut) throw new RemoteError("timeout", `boat ${args[0]}: timed out`);
    if (r.code !== 0) {
      // In --json mode a failure's last stdout line is a JSON object with code/message.
      const why = jsonMessage(lastLine(r.stdout)) || lastLine(r.stderr) || `exit ${r.code}`;
      throw new RemoteError(/unauthor|log ?in|api key/i.test(why) ? "auth" : r.code === 124 ? "timeout" : "failed", `boat: ${why}`);
    }
    return r.stdout;
  }

  async function execApi(k: Key, box: Box, script: string, ms: number): Promise<string> {
    const r = await http(`${k.api}/sandboxes/${encodeURIComponent(box.id)}/commands`, {
      method: "POST",
      headers: headers(k),
      body: { command: `sh -c ${shQuote(script)}`, timeoutSeconds: Math.min(600, Math.max(1, Math.ceil(ms / 1000))) },
      timeoutMs: ms + 5_000,
      fetch: o.fetch,
    });
    if (r.status === 409) throw new RemoteError("gone", `boat ${box.name}: not running`);
    const j = jsonOf(r, `boat ${box.name}`);
    if (j?.ok === false) throw new RemoteError("failed", `boat ${box.name}: ${j.message ?? j.code ?? "error"}`);
    if (j?.timedOut) throw new RemoteError("timeout", `boat ${box.name}: timed out`);
    if (j?.stdoutTruncated) throw new RemoteError("failed", `boat ${box.name}: output truncated`);
    if (j?.exitCode !== 0) throw new RemoteError("failed", `boat ${box.name}: exit ${j?.exitCode}`);
    return typeof j.stdout === "string" ? j.stdout : "";
  }

  async function execCli(box: Box, script: string, ms: number): Promise<string> {
    const out = await boatCli(["exec", box.id, "--timeout", String(Math.max(1, Math.ceil(ms / 1000))), "--json", "--", "sh", "-c", script], ms);
    // --json prints the command result as one object; fall back to raw stdout for older CLIs.
    const t = out.trim();
    if (t.startsWith("{") && t.endsWith("}")) {
      try {
        const j = JSON.parse(t);
        if (typeof j?.stdout === "string") {
          if (j.stdoutTruncated) throw new RemoteError("failed", `boat ${box.name}: output truncated`);
          return j.stdout;
        }
      } catch (err) {
        if (err instanceof RemoteError) throw err;
      }
    }
    return out;
  }

  function targetFor(box: Box): RemoteTarget {
    return {
      host: { kind: "boat", id: `boat:${box.id}`, name: box.name },
      async exec(script, eo) {
        const ms = eo?.timeoutMs ?? timeoutMs;
        const t = transport();
        return t === "cli" ? execCli(box, script, ms) : execApi(t, box, script, ms);
      },
    };
  }

  async function listApi(k: Key): Promise<any[]> {
    const rows: any[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const q = new URLSearchParams({ state: [...LIVE].join(","), limit: "200" });
      if (cursor) q.set("cursor", cursor);
      const j = jsonOf(await http(`${k.api}/sandboxes?${q}`, { headers: headers(k), timeoutMs, fetch: o.fetch }), "boat sandboxes");
      rows.push(...(Array.isArray(j?.sandboxes) ? j.sandboxes : []));
      cursor = j?.pageInfo?.hasMore ? str(j.pageInfo.nextCursor) : undefined;
      if (!cursor) break;
    }
    return rows;
  }

  async function listCli(): Promise<any[]> {
    return parseList(await boatCli(["list", "--json"], timeoutMs));
  }

  return {
    kind: "boat",
    label: "boat",
    keepsAwake: false,
    // Every poll's output would sit in boat's command history for 90 days: only on request.
    autoDetect: false,
    available(): Availability {
      const k = boatKey(o);
      if (!("why" in k)) return { ok: true, via: k.via };
      return cli() ? { ok: true, via: "boat CLI" } : { ok: false, why: k.why };
    },
    async list() {
      const t = transport();
      const rows = t === "cli" ? await listCli() : await listApi(t);
      const out: Discovered[] = [];
      const seen = new Set<string>();
      for (const s of rows) {
        const id = str(s?.id);
        // `boat list` without --all already shows only running ones, whatever it calls the field.
        if (!id || (t !== "cli" || s.state !== undefined ? !LIVE.has(s.state) : false)) continue;
        seen.add(id);
        let d = cache.get(id);
        if (!d) {
          // Default names are a timestamp ("Sandbox 2026-05-31 12:00"); the id reads better then.
          const name = str(s.name) && !/^(Sandbox|Boat) \d{4}-\d\d-\d\d/.test(s.name) ? displayName(s.name) : id;
          const target = targetFor({ id, name });
          d = { host: target.host, target };
          cache.set(id, d);
        }
        out.push(d);
      }
      for (const id of [...cache.keys()]) if (!seen.has(id)) cache.delete(id);
      return out;
    },
  };
}

/** `boat list --json`: an array, an object with `sandboxes`, or JSON Lines of sandboxes. */
export function parseList(out: string): any[] {
  const t = out.trim();
  if (!t) return [];
  try {
    const j = JSON.parse(t);
    if (Array.isArray(j)) return j;
    if (Array.isArray(j?.sandboxes)) return j.sandboxes;
    if (j?.id) return [j];
  } catch {
    // JSON Lines.
  }
  const rows: any[] = [];
  for (const line of t.split("\n")) {
    try {
      const j = JSON.parse(line);
      if (j?.id) rows.push(j);
      else if (Array.isArray(j?.sandboxes)) rows.push(...j.sandboxes);
    } catch {
      // A text line (warning, update notice).
    }
  }
  return rows;
}

function jsonMessage(line: string): string {
  try {
    const j = JSON.parse(line);
    return typeof j?.message === "string" ? j.message : typeof j?.error === "string" ? j.error : "";
  } catch {
    return "";
  }
}

/** For `--boat <all|id>` and the installer. */
export async function createBoatTargets(sel = "all", o: ProviderOptions = {}): Promise<RemoteTarget[]> {
  const found = await createBoatProvider(o).list();
  return pick(found, sel, (d) => [d.host.id.slice("boat:".length), d.host.name]).map((d) => d.target);
}
