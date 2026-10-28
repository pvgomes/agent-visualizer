/*
 * The key store: API keys the user adds on the page, handed to agents they
 * hire in a sandbox or on an ssh box, and platform tokens (Daytona, Vercel,
 * Railway, boat) the office uses for its own calls. This is credential
 * brokering by the user's explicit choice, so it is kept small and strict:
 *
 *   - $AGENT_VISUALIZER_HOME/keys.json, 0600 in a 0700 folder, written atomically
 *     (a fresh 0600 temp file, then rename), re-read when it changes on disk.
 *     Plain JSON: the same protection the agents' own auth files get.
 *   - The page only ever sees KeyInfo (name, agents, a short preview).
 *   - Values never go into a log line, an error message, a URL or the
 *     snapshot. reveal() is for one hire's chosen keys, platformEnv() for the
 *     office's provider calls; nothing else returns a value.
 *   - Import reads only allowlisted names from a fresh login shell.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentKind } from "../shared/events.ts";
import type { KeyInfo, KeyInput } from "../shared/control.ts";
import { AGENT_FACTS, ControlError, FILES, KEY_NAME, PLATFORM_KEY_NAMES, type Disposable, type KeyStore } from "./types.ts";
import { privateDir, writePrivate } from "./auth.ts";
import { loginShellVars, type ShellOptions } from "./env.ts";

export const MAX_KEYS = 64;
/** What Connect Claude stores (claude setup-token's token). */
export const OAUTH_TOKEN_KEY = "CLAUDE_CODE_OAUTH_TOKEN";
export const MAX_KEY_BYTES = 16 * 1024;
const AGENT_KINDS = Object.keys(AGENT_FACTS) as AgentKind[];

interface Stored {
  name: string;
  value: string;
  agents: AgentKind[];
  addedAt: string;
  expiresAt?: string;
}

/** Every name import looks for: each agent's keys and the platform tokens. */
export function importableNames(): string[] {
  const names = new Set<string>();
  for (const a of AGENT_KINDS) for (const n of AGENT_FACTS[a].keyNames) names.add(n);
  for (const n of PLATFORM_KEY_NAMES) names.add(n);
  return [...names];
}

/** "sk-ant-…a1b2": at most the first 6 and last 4 characters, less for short values, none under 12. */
export function preview(value: string): string {
  const chars = [...value];
  if (chars.length >= 24) return `${chars.slice(0, 6).join("")}…${chars.slice(-4).join("")}`;
  if (chars.length >= 12) return `${chars.slice(0, 3).join("")}…${chars.slice(-2).join("")}`;
  return "•••";
}

/** Agents a key is for when the page doesn't say: those that read that name. Platform tokens are for none. */
export function defaultAgents(name: string): AgentKind[] {
  if (PLATFORM_KEY_NAMES.includes(name)) return [];
  return AGENT_KINDS.filter((a) => AGENT_FACTS[a].keyNames.includes(name));
}

export interface KeyStoreOptions {
  now?: () => number;
  /** How import reads the login shell (tests pass a fake shell). */
  shell?: ShellOptions;
}

export function createKeyStore(home: string, o: KeyStoreOptions = {}): KeyStore {
  const file = join(home, FILES.keys);
  const now = o.now ?? Date.now;
  const listeners = new Set<() => void>();
  let keys: Stored[] = [];
  let mtimeMs = -2;
  /** keys.json exists but doesn't parse: never overwrite it. */
  let damaged = false;

  function load(): Stored[] {
    let st;
    try {
      st = statSync(file);
    } catch {
      if (mtimeMs !== -1) keys = [];
      mtimeMs = -1;
      damaged = false;
      return keys;
    }
    if (st.mtimeMs === mtimeMs) return keys;
    mtimeMs = st.mtimeMs;
    damaged = false;
    try {
      const j = JSON.parse(readFileSync(file, "utf8"));
      const list = Array.isArray(j?.keys) ? j.keys : [];
      keys = list
        .filter((k: any) => k && typeof k.name === "string" && KEY_NAME.test(k.name) && typeof k.value === "string" && k.value)
        .map((k: any) => ({
          name: k.name,
          value: k.value,
          agents: Array.isArray(k.agents) ? k.agents.filter((a: unknown) => AGENT_KINDS.includes(a as AgentKind)) : defaultAgents(k.name),
          addedAt: typeof k.addedAt === "string" ? k.addedAt : new Date(0).toISOString(),
          ...(typeof k.expiresAt === "string" ? { expiresAt: k.expiresAt } : {}),
        }))
        .slice(0, MAX_KEYS);
    } catch {
      keys = [];
      damaged = true;
    }
    return keys;
  }

  function save(list: Stored[]): void {
    load();
    if (damaged) throw new ControlError(409, "keys.json in the office folder doesn't parse; fix or delete it, then try again.");
    privateDir(home);
    writePrivate(file, JSON.stringify({ v: 1, keys: list }, null, 2) + "\n");
    keys = list;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      mtimeMs = -2;
    }
    for (const fn of listeners) {
      try {
        fn();
      } catch {
        // A listener must not undo a save.
      }
    }
  }

  // A subscription token is never shown, not even its ends: Settings says "never shown".
  const info = (k: Stored): KeyInfo => ({ name: k.name, agents: [...k.agents], preview: k.name === OAUTH_TOKEN_KEY ? "•••" : preview(k.value), addedAt: k.addedAt, ...(k.expiresAt ? { expiresAt: k.expiresAt } : {}) });

  function validName(name: unknown): string {
    if (typeof name !== "string" || !KEY_NAME.test(name)) {
      throw new ControlError(400, "A key name is 2-64 capital letters, digits and underscores, starting with a letter (ANTHROPIC_API_KEY).");
    }
    return name;
  }

  function put(k: KeyInput, meta: { expiresAt?: string } = {}): KeyInfo {
    const name = validName(k?.name);
    if (typeof k.value !== "string") throw new ControlError(400, "A key needs a value.");
    const value = k.value.trim();
    if (!value) throw new ControlError(400, "A key needs a value.");
    if (Buffer.byteLength(value) > MAX_KEY_BYTES) throw new ControlError(400, "That value is too long for a key (16 KB at most).");
    if (/[\r\n\0]/.test(value)) throw new ControlError(400, "A key value must be one line.");
    let agents: AgentKind[];
    if (k.agents === undefined) agents = defaultAgents(name);
    else if (Array.isArray(k.agents) && k.agents.every((a) => AGENT_KINDS.includes(a))) agents = [...new Set(k.agents)];
    else throw new ControlError(400, "Unknown agent in the key's agent list.");
    const list = load().filter((x) => x.name !== name);
    if (list.length >= MAX_KEYS) throw new ControlError(400, `The office keeps at most ${MAX_KEYS} keys.`);
    const prev = load().find((x) => x.name === name);
    const same = prev && prev.value === value;
    const expiresAt = meta.expiresAt ?? (same ? prev.expiresAt : undefined);
    const stored: Stored = { name, value, agents, addedAt: same ? prev.addedAt : new Date(now()).toISOString(), ...(expiresAt ? { expiresAt } : {}) };
    const at = load().findIndex((x) => x.name === name);
    const next = [...load()];
    if (at >= 0) next[at] = stored;
    else next.push(stored);
    save(next);
    return info(stored);
  }

  return {
    list: () => load().map(info),
    put,
    remove(name) {
      if (typeof name !== "string" || !KEY_NAME.test(name)) return false;
      const list = load();
      if (!list.some((k) => k.name === name)) return false;
      save(list.filter((k) => k.name !== name));
      return true;
    },
    async importFromShell() {
      const names = importableNames();
      const found = await loginShellVars(names, o.shell);
      if (!found) throw new ControlError(502, "Couldn't read your login shell's environment (it took too long or failed).");
      const stored: string[] = [];
      for (const n of names) {
        const v = found[n]?.trim();
        if (!v || /[\r\n\0]/.test(v) || Buffer.byteLength(v) > MAX_KEY_BYTES) continue;
        const cur = load().find((k) => k.name === n);
        if (cur?.value === v) continue;
        if (!cur && load().length >= MAX_KEYS) break;
        put({ name: n, value: v, agents: cur?.agents });
        stored.push(n);
      }
      return stored;
    },
    reveal(names) {
      const list = load();
      const out: Record<string, string> = {};
      for (const n of names) {
        const name = validName(n);
        const k = list.find((x) => x.name === name);
        if (!k) throw new ControlError(400, `No stored key named ${name}.`);
        out[name] = k.value;
      }
      return out;
    },
    platformEnv() {
      const out: Record<string, string> = {};
      for (const k of load()) if (PLATFORM_KEY_NAMES.includes(k.name)) out[k.name] = k.value;
      return out;
    },
    onChange(fn): Disposable {
      listeners.add(fn);
      return { dispose: () => void listeners.delete(fn) };
    },
  };
}
