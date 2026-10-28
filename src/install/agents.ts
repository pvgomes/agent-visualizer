/*
 * One adapter per agent: how to tell it is installed, where its MCP config
 * and skills live, and what an `agent-visualizer` entry looks like in its own
 * format. Claude Code and Codex are registered through their own
 * `mcp add/remove` subcommands when the binary is present (their configs are
 * large, live files those CLIs know how to update); everything else, and
 * those two when their CLI is missing, gets a span-preserving edit of its
 * JSON/JSONC/TOML file. Droid's `mcp add` is skipped on purpose: it splits
 * arguments on spaces, which breaks any path with a space in it.
 *
 * Formats (checked against each agent's docs and real files, Oct 2026):
 *   claude       ~/.claude.json            mcpServers.agent-visualizer {type,command,args,env}
 *   codex        ~/.codex/config.toml      [mcp_servers.agent-visualizer] command, args
 *   commandcode  ~/.commandcode/mcp.json   mcpServers.agent-visualizer {transport,enabled,command,args}
 *   opencode     ~/.config/opencode/opencode.json(c)  mcp.agent-visualizer {type:"local",command:[...],enabled}
 *   droid        ~/.factory/mcp.json       mcpServers.agent-visualizer {type,command,args,disabled}
 *   gemini       ~/.gemini/settings.json   mcpServers.agent-visualizer {command,args}
 *   qwen         ~/.qwen/settings.json     mcpServers.agent-visualizer {command,args}
 *   cursor       ~/.cursor/mcp.json        mcpServers.agent-visualizer {command,args}
 * Skills: <dir>/agent-visualizer/SKILL.md under ~/.claude/skills, ~/.agents/skills
 * (Codex's current user location), ~/.commandcode/skills,
 * ~/.config/opencode/skills, ~/.factory/skills, ~/.gemini/skills,
 * ~/.qwen/skills, ~/.cursor/skills.
 */
import { posix, win32 } from "node:path";
import type { AgentKind } from "../shared/events.ts";
import { BRAND } from "../shared/events.ts";
import { SERVER_NAME, type LaunchCommand } from "./command.ts";
import { JsoncError, nodeAt, parseJsonc, setPath, deletePath, toValue, isEmptyObject } from "./jsonc.ts";
import { TomlEditError, hasTable, readCommand, removeTable, tableCount, tableKeys, tomlArray, tomlString, updateTable } from "./toml.ts";
import type { Sys } from "./sys.ts";

export const pathFor = (sys: Sys) => (sys.platform === "win32" && !sys.remote ? win32 : posix);
const j = (sys: Sys, ...parts: string[]) => pathFor(sys).join(...parts);

export type McpState =
  | { state: "missing"; file: string }
  | { state: "registered"; file: string; command: LaunchCommand; enabled: boolean }
  | { state: "unreadable"; file: string; message: string };

/** A planned edit to one file: `after: null` deletes it. */
export interface FileEdit {
  file: string;
  before: string | null;
  after: string | null;
}

export interface McpPlan {
  /** Nothing to do. */
  noop: boolean;
  /** The file edit that does it (also what the CLI route amounts to). */
  edit?: FileEdit;
  /** When set, run these instead of applying `edit` (and fall back to `edit` if they don't stick). */
  run?: string[][];
  /** Why it can't be done safely; nothing is touched. */
  blocked?: string;
}

export interface Adapter {
  id: AgentKind;
  name: string;
  bins: string[];
  /** Folders whose existence means the agent is set up here. */
  dirs(sys: Sys): string[];
  /** Config files to read up front. */
  files(sys: Sys): string[];
  skillRoot(sys: Sys): string;
  /** CLI binary for the native mcp add/remove route, if the agent has a dependable one. */
  cli?: string;
  /** JSON configs: the object our entry lives in ("mcpServers"). */
  container?: string[];
  readMcp(sys: Sys): Promise<McpState>;
  planInstall(sys: Sys, cmd: LaunchCommand, useCli: boolean): Promise<McpPlan>;
  /** dropContainer/dropFile: we created them, so take them away again if nothing else is left in them. */
  planUninstall(sys: Sys, useCli: boolean, opts: { dropContainer: boolean; dropFile: boolean }): Promise<McpPlan>;
  /** Format a registration the way this agent's config spells it. */
  entry(cmd: LaunchCommand): Record<string, unknown>;
}

const sameCmd = (a: LaunchCommand | undefined, b: LaunchCommand) =>
  !!a && a.command === b.command && a.args.length === b.args.length && a.args.every((x, k) => x === b.args[k]);

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/* ----------------------------------------------------------------- JSON */

interface JsonSpec {
  id: AgentKind;
  bins: string[];
  dirs(sys: Sys): string[];
  /** Candidate config files, most preferred first; the first existing one is edited. */
  candidates(sys: Sys): string[];
  container: string[];
  skillRoot(sys: Sys): string;
  entry(cmd: LaunchCommand): Record<string, unknown>;
  /** Pull command + args back out of an entry. */
  read(entry: Record<string, unknown>): LaunchCommand | undefined;
  enabled?(entry: Record<string, unknown>): boolean;
  cli?: { bin: string; add(cmd: LaunchCommand): string[]; remove(): string[] };
}

const stdioRead = (e: Record<string, unknown>): LaunchCommand | undefined =>
  typeof e.command === "string" ? { command: e.command, args: isStrings(e.args) ? e.args : [] } : undefined;

function jsonAdapter(spec: JsonSpec): Adapter {
  const keyPath = [...spec.container, SERVER_NAME];

  /** The file holding our entry, else the first that exists, else the preferred one. */
  async function locate(sys: Sys): Promise<{ file: string; text: string | null }> {
    const cands = spec.candidates(sys);
    const texts = await Promise.all(cands.map((f) => sys.read(f)));
    for (let k = 0; k < cands.length; k++) {
      const t = texts[k];
      if (t == null) continue;
      try {
        if (nodeAt(parseJsonc(t), keyPath)) return { file: cands[k]!, text: t };
      } catch {
        // Unparseable: report it below if it's the one we'd edit.
      }
    }
    const k = texts.findIndex((t) => t != null);
    return k === -1 ? { file: cands[0]!, text: null } : { file: cands[k]!, text: texts[k]! };
  }

  function current(text: string | null): Record<string, unknown> | undefined | "bad" {
    if (text == null || !text.trim()) return undefined;
    const n = nodeAt(parseJsonc(text), keyPath);
    if (!n) return undefined;
    const v = toValue(n);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : "bad";
  }

  return {
    id: spec.id,
    name: BRAND[spec.id].name,
    bins: spec.bins,
    dirs: spec.dirs,
    files: spec.candidates,
    skillRoot: spec.skillRoot,
    cli: spec.cli?.bin,
    container: spec.container,
    entry: spec.entry,
    async readMcp(sys) {
      const { file, text } = await locate(sys);
      try {
        const e = current(text);
        if (e === undefined) return { state: "missing", file };
        const command = e === "bad" ? undefined : spec.read(e);
        if (!command) return { state: "unreadable", file, message: "agent-visualizer entry has no command" };
        return { state: "registered", file, command, enabled: e !== "bad" && (spec.enabled?.(e) ?? true) };
      } catch (err) {
        return { state: "unreadable", file, message: err instanceof JsoncError ? err.message : String(err) };
      }
    },
    async planInstall(sys, cmd, useCli) {
      const { file, text } = await locate(sys);
      let after: string;
      try {
        const e = current(text);
        if (e && e !== "bad" && sameCmd(spec.read(e), cmd) && (spec.enabled?.(e) ?? true)) return { noop: true };
        // Keep anything the user added to our entry (env, timeout, trust...), refresh the rest.
        const prev = e && e !== "bad" ? e : {};
        const fresh = spec.entry(cmd);
        const merged: Record<string, unknown> = { ...prev, ...fresh };
        for (const [k, v] of Object.entries(fresh)) {
          // An empty object of ours (Claude's env: {}) never wipes the user's.
          const old = prev[k];
          if (isPlainObject(v) && isPlainObject(old)) merged[k] = { ...old, ...v };
        }
        after = setPath(text ?? "", keyPath, merged);
        // `claude mcp add` writes only command/args: with user-added keys, edit the file instead.
        const extra = Object.keys(prev).some((k) => !(k in fresh) || (isPlainObject(prev[k]) && Object.keys(prev[k] as object).length > 0));
        if (spec.cli && useCli && !extra) {
          const run = e ? [spec.cli.remove(), spec.cli.add(cmd)] : [spec.cli.add(cmd)];
          return { noop: false, edit: { file, before: text, after }, run };
        }
      } catch (err) {
        return { noop: false, blocked: `${tilde(sys, file)} can't be edited safely (${(err as Error).message}); left untouched` };
      }
      return { noop: false, edit: { file, before: text, after } };
    },
    async planUninstall(sys, useCli, opts) {
      const { file, text } = await locate(sys);
      try {
        if (current(text) === undefined) return { noop: true };
        let after = deletePath(text!, keyPath);
        if (opts.dropContainer && isEmptyObject(after, spec.container)) after = deletePath(after, spec.container);
        const doc = after.trim() ? toValue(parseJsonc(after)) : {};
        const empty = !!doc && typeof doc === "object" && !Array.isArray(doc) && Object.keys(doc).length === 0;
        const edit: FileEdit = { file, before: text, after: opts.dropFile && empty ? null : after };
        if (spec.cli && useCli) return { noop: false, edit, run: [spec.cli.remove()] };
        return { noop: false, edit };
      } catch (err) {
        return { noop: false, blocked: `${tilde(sys, file)} can't be edited safely (${(err as Error).message}); left untouched` };
      }
    },
  };
}

/* ---------------------------------------------------------------- Codex */

function codexHome(sys: Sys): string {
  return sys.env("CODEX_HOME") || j(sys, sys.home, ".codex");
}

const CODEX_TABLE = ["mcp_servers", SERVER_NAME];

const codex: Adapter = {
  id: "codex",
  name: BRAND.codex.name,
  bins: ["codex"],
  cli: "codex",
  dirs: (sys) => [codexHome(sys)],
  files: (sys) => [j(sys, codexHome(sys), "config.toml")],
  skillRoot: (sys) => j(sys, sys.home, ".agents", "skills"),
  entry: (cmd) => ({ command: cmd.command, args: cmd.args }),
  async readMcp(sys) {
    const file = j(sys, codexHome(sys), "config.toml");
    const text = await sys.read(file);
    if (text == null || !hasTable(text, CODEX_TABLE)) return { state: "missing", file };
    const c = readCommand(text, CODEX_TABLE);
    if (!c?.command) return { state: "unreadable", file, message: "[mcp_servers.agent-visualizer] has no command" };
    return { state: "registered", file, command: { command: c.command, args: c.args ?? [] }, enabled: c.enabled !== false };
  },
  async planInstall(sys, cmd, useCli) {
    const file = j(sys, codexHome(sys), "config.toml");
    const text = await sys.read(file);
    if (text != null && hasTable(text, CODEX_TABLE)) {
      const c = readCommand(text, CODEX_TABLE);
      if (c && c.enabled !== false && sameCmd({ command: c.command ?? "", args: c.args ?? [] }, cmd)) return { noop: true };
    }
    let after: string;
    try {
      // Only command and args (and a disabling `enabled = false`) are ours; env, timeouts and subtables stay.
      after = updateTable(text ?? "", CODEX_TABLE, { command: tomlString(cmd.command), args: tomlArray(cmd.args), enabled: null });
    } catch (err) {
      if (err instanceof TomlEditError) return { noop: false, blocked: `${tilde(sys, file)}: ${err.message}; left untouched` };
      throw err;
    }
    // Never write a file Codex would refuse to load.
    if (tableCount(after, CODEX_TABLE) !== 1) {
      return { noop: false, blocked: `${tilde(sys, file)}: couldn't tell where [mcp_servers.agent-visualizer] ends; left untouched` };
    }
    const edit = { file, before: text, after };
    // `codex mcp add` rewrites the entry with just command and args; if the user added their own
    // keys to it (env, startup_timeout_sec, ...), edit the file instead so those survive.
    const extra = text != null && tableKeys(text, CODEX_TABLE).some((k) => !["command", "args", "enabled"].includes(k));
    if (useCli && !extra) return { noop: false, edit, run: [["codex", "mcp", "add", SERVER_NAME, "--", cmd.command, ...cmd.args]] };
    return { noop: false, edit };
  },
  async planUninstall(sys, useCli, opts) {
    const file = j(sys, codexHome(sys), "config.toml");
    const text = await sys.read(file);
    if (text == null || !hasTable(text, CODEX_TABLE)) return { noop: true };
    const rest = removeTable(text, CODEX_TABLE);
    const edit = { file, before: text, after: opts.dropFile && !rest.trim() ? null : rest };
    if (useCli) return { noop: false, edit, run: [["codex", "mcp", "remove", SERVER_NAME]] };
    return { noop: false, edit };
  },
};

/* ------------------------------------------------------------- the rest */

function claudeDir(sys: Sys): string {
  return sys.env("CLAUDE_CONFIG_DIR") || j(sys, sys.home, ".claude");
}

const claude = jsonAdapter({
  id: "claude",
  bins: ["claude"],
  dirs: (sys) => [claudeDir(sys)],
  candidates: (sys) => [sys.env("CLAUDE_CONFIG_DIR") ? j(sys, sys.env("CLAUDE_CONFIG_DIR")!, ".claude.json") : j(sys, sys.home, ".claude.json")],
  container: ["mcpServers"],
  skillRoot: (sys) => j(sys, claudeDir(sys), "skills"),
  entry: (cmd) => ({ type: "stdio", command: cmd.command, args: cmd.args, env: {} }),
  read: stdioRead,
  cli: {
    bin: "claude",
    add: (cmd) => ["claude", "mcp", "add", "--scope", "user", SERVER_NAME, "--", cmd.command, ...cmd.args],
    remove: () => ["claude", "mcp", "remove", "--scope", "user", SERVER_NAME],
  },
});

const commandcode = jsonAdapter({
  id: "commandcode",
  bins: ["commandcode", "command-code"],
  dirs: (sys) => [j(sys, sys.home, ".commandcode")],
  candidates: (sys) => [j(sys, sys.home, ".commandcode", "mcp.json")],
  container: ["mcpServers"],
  skillRoot: (sys) => j(sys, sys.home, ".commandcode", "skills"),
  entry: (cmd) => ({ transport: "stdio", enabled: true, command: cmd.command, args: cmd.args }),
  read: stdioRead,
  enabled: (e) => e.enabled !== false,
});

function opencodeDir(sys: Sys): string {
  const xdg = sys.env("XDG_CONFIG_HOME");
  return j(sys, xdg || j(sys, sys.home, ".config"), "opencode");
}

const opencode = jsonAdapter({
  id: "opencode",
  bins: ["opencode"],
  dirs: (sys) => [opencodeDir(sys), j(sys, sys.home, ".local", "share", "opencode")],
  // opencode reads all three; a new entry goes in opencode.json unless only another one exists.
  candidates: (sys) => ["opencode.json", "opencode.jsonc", "config.json"].map((f) => j(sys, opencodeDir(sys), f)),
  container: ["mcp"],
  skillRoot: (sys) => j(sys, opencodeDir(sys), "skills"),
  entry: (cmd) => ({ type: "local", command: [cmd.command, ...cmd.args], enabled: true }),
  read: (e) => (isStrings(e.command) && e.command.length ? { command: e.command[0]!, args: e.command.slice(1) } : undefined),
  enabled: (e) => e.enabled !== false,
});

const droid = jsonAdapter({
  id: "droid",
  bins: ["droid"],
  dirs: (sys) => [j(sys, sys.home, ".factory")],
  candidates: (sys) => [j(sys, sys.home, ".factory", "mcp.json")],
  container: ["mcpServers"],
  skillRoot: (sys) => j(sys, sys.home, ".factory", "skills"),
  entry: (cmd) => ({ type: "stdio", command: cmd.command, args: cmd.args, disabled: false }),
  read: stdioRead,
  enabled: (e) => e.disabled !== true,
});

const gemini = jsonAdapter({
  id: "gemini",
  bins: ["gemini"],
  dirs: (sys) => [j(sys, sys.home, ".gemini")],
  candidates: (sys) => [j(sys, sys.home, ".gemini", "settings.json")],
  container: ["mcpServers"],
  skillRoot: (sys) => j(sys, sys.home, ".gemini", "skills"),
  entry: (cmd) => ({ command: cmd.command, args: cmd.args }),
  read: stdioRead,
});

const qwen = jsonAdapter({
  id: "qwen",
  bins: ["qwen"],
  dirs: (sys) => [j(sys, sys.home, ".qwen")],
  candidates: (sys) => [j(sys, sys.home, ".qwen", "settings.json")],
  container: ["mcpServers"],
  skillRoot: (sys) => j(sys, sys.home, ".qwen", "skills"),
  entry: (cmd) => ({ command: cmd.command, args: cmd.args }),
  read: stdioRead,
});

const cursor = jsonAdapter({
  id: "cursor",
  bins: ["cursor-agent", "cursor"],
  dirs: (sys) => [j(sys, sys.home, ".cursor")],
  candidates: (sys) => [j(sys, sys.home, ".cursor", "mcp.json")],
  container: ["mcpServers"],
  skillRoot: (sys) => j(sys, sys.home, ".cursor", "skills"),
  entry: (cmd) => ({ command: cmd.command, args: cmd.args }),
  read: stdioRead,
});

export const ADAPTERS: Adapter[] = [claude, codex, commandcode, opencode, droid, gemini, qwen, cursor];

export function adapterFor(id: AgentKind): Adapter {
  return ADAPTERS.find((a) => a.id === id)!;
}

export interface Detection {
  installed: boolean;
  /** "claude on PATH", "~/.qwen exists". */
  evidence: string[];
  bin?: string;
}

export async function detect(sys: Sys, a: Adapter): Promise<Detection> {
  const evidence: string[] = [];
  let bin: string | undefined;
  for (const b of a.bins) {
    const p = await sys.which(b);
    if (p) {
      bin = p;
      evidence.push(`${b} on PATH`);
      break;
    }
  }
  for (const d of a.dirs(sys)) if (await sys.exists(d)) evidence.push(`${tilde(sys, d)} exists`);
  return { installed: evidence.length > 0, evidence, bin };
}

export function tilde(sys: Sys, p: string): string {
  if (p === sys.home) return "~";
  const sep = pathFor(sys).sep;
  return p.startsWith(sys.home + sep) ? "~" + p.slice(sys.home.length) : p;
}
