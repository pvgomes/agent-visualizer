/*
 * Which remotes to watch, from flags and from $AGENT_VISUALIZER_HOME/config.json
 * (default ~/.agent-visualizer/config.json):
 *
 *   { "remotes": [ {"ssh": "me@box"}, {"ssh": "gpu", "env": {"CLAUDE_CONFIG_DIR": "/data/claude"}},
 *                  {"daytona": "all"}, {"boat": "bx_23456789"}, {"railway": "all"}, {"vercel": "my-sbx"} ],
 *     "cloud": false }
 *
 * "all" (or true) means every running sandbox of that platform; anything
 * else is a sandbox id or name. "cloud": false turns off auto-detection,
 * like --no-cloud. Other keys in the file belong to other parts of the app
 * and are left alone.
 */
import { join } from "node:path";
import type { RemoteKind } from "./util.ts";
import { homeOf, readJson } from "./util.ts";

export const REMOTE_KINDS: RemoteKind[] = ["ssh", "daytona", "boat", "railway", "vercel"];

export interface RemoteSelector {
  kind: RemoteKind;
  /** ssh destination, sandbox id or name, or "all". */
  id: string;
  /** ssh only: exported before every script. */
  env?: Record<string, string>;
}

export interface RemoteConfig {
  selectors: RemoteSelector[];
  /** false when the file turns auto-detection off. */
  cloud?: boolean;
  problems: string[];
}

export function agentVisualizerHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENT_VISUALIZER_HOME || join(homeOf(env), ".agent-visualizer");
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(agentVisualizerHome(env), "config.json");
}

export function readRemoteConfig(env: NodeJS.ProcessEnv = process.env): RemoteConfig {
  const path = configPath(env);
  const j = readJson(path);
  const out: RemoteConfig = { selectors: [], problems: [] };
  if (j === undefined) return out;
  if (!j || typeof j !== "object" || Array.isArray(j)) {
    out.problems.push(`${path}: not a JSON object`);
    return out;
  }
  if (j.cloud === false) out.cloud = false;
  if (j.remotes === undefined) return out;
  if (!Array.isArray(j.remotes)) {
    out.problems.push(`${path}: "remotes" should be a list`);
    return out;
  }
  for (const entry of j.remotes) {
    const r = parseRemoteEntry(entry);
    if (typeof r === "string") out.problems.push(`${path}: ${r}`);
    else out.selectors.push(r);
  }
  return out;
}

export function parseRemoteEntry(entry: unknown): RemoteSelector | string {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return `remote ${JSON.stringify(entry)} should be an object like {"ssh": "me@box"}`;
  const e = entry as Record<string, unknown>;
  const kinds = REMOTE_KINDS.filter((k) => k in e);
  if (kinds.length !== 1) return `remote ${JSON.stringify(entry)} should name exactly one of ${REMOTE_KINDS.join(", ")}`;
  const kind = kinds[0]!;
  const v = e[kind];
  const id = v === true ? "all" : typeof v === "string" ? v.trim() : "";
  if (!id) return `remote ${JSON.stringify(entry)}: "${kind}" needs "all" or an id`;
  if (kind === "ssh" && id === "all") return `remote {"ssh": "all"}: ssh needs a host`;
  const sel: RemoteSelector = { kind, id };
  if (kind === "ssh" && e.env && typeof e.env === "object" && !Array.isArray(e.env)) {
    sel.env = Object.fromEntries(Object.entries(e.env as Record<string, unknown>).filter(([, x]) => typeof x === "string")) as Record<string, string>;
  }
  return sel;
}

/** Flags then config, duplicates dropped, order kept. */
export function mergeSelectors(...lists: RemoteSelector[][]): RemoteSelector[] {
  const out: RemoteSelector[] = [];
  const seen = new Set<string>();
  for (const s of lists.flat()) {
    const key = `${s.kind}\0${s.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}
