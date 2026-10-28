/*
 * "Bring my setup", on this machine: what an agent hired into a sandbox or
 * onto an ssh box can take along (inventory, names only, for the hire form),
 * and the bundle a hire actually takes (collect, at hire time).
 *
 *   login         the stored CLAUDE_CODE_OAUTH_TOKEN (Settings, Logins), an
 *                 API key (stored, or from the login shell, never stored),
 *                 Codex's device code, or this machine's ~/.codex/auth.json
 *   MCP servers   Claude: user scope (~/.claude.json mcpServers) and the
 *                 chosen project's local scope (projects[<folder>]); the
 *                 project's .mcp.json travels with the code. Codex:
 *                 [mcp_servers.*] in ~/.codex/config.toml. Pre-ticked: http
 *                 and sse servers, and stdio servers run through npx, uvx,
 *                 bunx or docker (an absolute path to one of those becomes
 *                 the bare name). A server that runs a file on this machine,
 *                 or listens on its localhost, is listed but left unticked.
 *   instructions  Claude: CLAUDE.md, rules/, skills/, agents/, commands/ and
 *                 settings.json minus hooks, statusLine, apiKeyHelper and the
 *                 like that run files here (and plugins, which stay here).
 *                 Codex: AGENTS.md, prompts/, skills/.
 *   project       `git ls-files -co --exclude-standard` (tracked, plus
 *                 untracked files .gitignore doesn't exclude), .git under a
 *                 cap (hooks left out, credentials taken out of remote URLs),
 *                 .env* files only when asked.
 *
 * Limits: 20 MB of instructions, 100 MB and 20,000 files of project, 50 MB
 * of .git. Links that leave their folder, big binaries and anything over a
 * cap are skipped and named. No value is ever logged or returned to the page.
 *
 * The hire form asks for the inventory each time it opens and whenever the
 * agent or folder changes: createSetupCache answers from a cache (per folder,
 * per agent), stale-while-revalidate (swr.ts), stamped with the mtimes that
 * show a change (the git index, the folder, the config files), so a repeat
 * look is instant and an edit shows up on the next one.
 */
import { execFile } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync, type Stats } from "node:fs";
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { BRAND, type AgentKind } from "../shared/events.ts";
import type { KeyInfo, SetupChoice, SetupInventory, SetupItem, SetupLogin, SetupMcp, SetupProject } from "../shared/control.ts";
import { ControlError, PLATFORM_KEY_NAMES, type SetupBundle } from "./types.ts";
import { mcpServerToml, parseToml, type TomlTable } from "./toml.ts";
import { safeName, type TarEntry } from "./tar.ts";
import { Swr, SwrMap } from "./swr.ts";

export const INSTRUCTIONS_MAX_BYTES = 20 << 20;
export const PROJECT_MAX_BYTES = 100 << 20;
export const PROJECT_MAX_FILES = 20_000;
export const GIT_MAX_BYTES = 50 << 20;
const FILE_MAX_BYTES = 5 << 20;
const BINARY_MAX_BYTES = 512 << 10;
const INSTRUCTION_FILES_MAX = 5_000;
const SECRET_FILE_MAX = 64 << 10;
/** setup-token's tokens last a year. */
export const OAUTH_TOKEN_DAYS = 365;
const RUNNERS = new Set(["npx", "uvx", "bunx", "docker"]);
const SKIP_DIRS = new Set([".git", "node_modules", ".DS_Store", "__pycache__", ".venv"]);
/** Never copied as an instruction file, whatever links lead there: sign-ins, config with secrets, transcripts. */
const NEVER = new Set([".credentials.json", "auth.json", ".claude.json", "history.jsonl", "projects", "keys.json"]);
/** Secret .env files (off unless ticked); .env.example and the like are code and go with the project. */
const ENV_FILE = /^\.env(?!\.(example|sample|template|dist|defaults)$)(\..+)?$/;

export interface SetupSource {
  /** The user's home on this machine. */
  home: string;
  /** The agents' environment here (CLAUDE_CONFIG_DIR, CODEX_HOME). */
  env: Record<string, string | undefined>;
  keys: KeyInfo[];
  /** Key names set in the login shell. */
  shellKeys: string[];
}

/* -------------------------------------------------------------- paths */

export function claudeDir(s: Pick<SetupSource, "home" | "env">): string {
  return s.env.CLAUDE_CONFIG_DIR?.trim() || join(s.home, ".claude");
}
export function claudeJsonPath(s: Pick<SetupSource, "home" | "env">): string {
  return s.env.CLAUDE_CONFIG_DIR?.trim() ? join(s.env.CLAUDE_CONFIG_DIR.trim(), ".claude.json") : join(s.home, ".claude.json");
}
export function codexDir(s: Pick<SetupSource, "home" | "env">): string {
  return s.env.CODEX_HOME?.trim() || join(s.home, ".codex");
}

const realHome = new Map<string, string>();
/** "~/x" for a path under home (given or resolved through links, as /var and /private/var on macOS). */
function tidy(p: string, home: string): string {
  let real = realHome.get(home);
  if (real === undefined) {
    try {
      real = realpathSync(home);
    } catch {
      real = home;
    }
    realHome.set(home, real);
  }
  for (const h of [home, real]) {
    if (p === h) return "~";
    if (p.startsWith(h + sep)) return `~/${p.slice(h.length + 1)}`;
  }
  return p;
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/* ---------------------------------------------------- local references */

const SYSTEM = /^\/(bin|sbin|usr\/bin|usr\/sbin|dev|tmp|etc|proc)(\/|$)/;

/** Does this command (or path) point at something on this machine only? */
export function localRef(cmd: string, home: string): boolean {
  if (!cmd) return false;
  // A URL (https://…, git+https://…) points elsewhere, not at this machine.
  cmd = cmd.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, "");
  if (home && cmd.includes(home)) return true;
  if (/(^|[\s'"=:(])(~\/|\$HOME\b|\$\{HOME\})/.test(cmd)) return true;
  for (const m of cmd.matchAll(/(?:^|[\s'"=:(])(\/[^\s'";|&)]+)/g)) if (!SYSTEM.test(m[1]!)) return true;
  return false;
}

/* --------------------------------------------------------------- MCP */

export interface McpFound extends SetupMcp {
  /** The config to write there (secrets included); absent for project scope. */
  config?: Record<string, unknown>;
  /** Codex: the TOML table. */
  table?: TomlTable;
}

/**
 * "npx @acme/mcp", "docker mcp/fetch": a runner and the package or image it
 * runs; any other command by its name alone. Never a flag or a flag's value
 * (`--api-key sk_live_…` is two words, and the second is a secret).
 */
function whatOf(cmd: string, args: unknown[]): string {
  const base = basename(cmd);
  if (!RUNNERS.has(base)) return base;
  const words = args.filter((a): a is string => typeof a === "string");
  const PKG = /^@?[\w.-]+(\/[\w.-]+)*(@[\w.^~-]+)?(:[\w.-]+)?$/;
  let pick: string | undefined;
  for (let i = base === "docker" ? Math.max(0, words.indexOf("run") + 1) : 0; i < words.length; i++) {
    const w = words[i]!;
    if (w.startsWith("-")) {
      // A flag without "=" takes the next word (except the bare switches npx and docker use).
      if (!w.includes("=") && !/^-(y|-yes|-rm|i|t|it|d|-init|-quiet|q)$/.test(w)) i++;
      continue;
    }
    if (PKG.test(w) && w.length < 64) pick = w;
    break;
  }
  return [base, pick].filter(Boolean).join(" ");
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** Is it worth pre-ticking, and what it would take there. `cfg` may be rewritten (an absolute npx becomes npx). */
export function classifyMcp(cfgIn: Record<string, unknown>, home: string, codex = false): { mcp: Omit<SetupMcp, "name" | "scope">; config: Record<string, unknown> } {
  const cfg = { ...cfgIn };
  const env = obj(cfg.env);
  const headers = obj(codex ? cfg.http_headers : cfg.headers);
  const secrets = (env ? Object.keys(env).length : 0) + (headers ? Object.keys(headers).length : 0);
  const url = typeof cfg.url === "string" ? cfg.url : undefined;
  const type = typeof cfg.type === "string" ? cfg.type : url ? (codex ? "http" : "http") : "stdio";
  if (url) {
    const transport = (["http", "sse", "ws"].includes(type) ? type : "http") as SetupMcp["transport"];
    const host = hostOf(url);
    if (/^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(host)) return { mcp: { transport, ok: false, why: `listens on this Mac (${host})`, what: host, secrets }, config: cfg };
    if (transport === "ws") return { mcp: { transport, ok: false, why: "a WebSocket server (IDE connection)", what: host, secrets }, config: cfg };
    return { mcp: { transport, ok: true, what: host, secrets }, config: cfg };
  }
  const command = typeof cfg.command === "string" ? cfg.command : "";
  const args = Array.isArray(cfg.args) ? cfg.args : [];
  const base = basename(command);
  const what = whatOf(command, args);
  if (!command) return { mcp: { transport: "stdio", ok: false, why: "no command", secrets }, config: cfg };
  const localArg = args.find((a) => typeof a === "string" && localRef(a, home));
  if (RUNNERS.has(base)) {
    if (command !== base) cfg.command = base;
    if (localArg !== undefined) return { mcp: { transport: "stdio", ok: false, why: base === "docker" ? "mounts or runs a file on this Mac" : "points at a file on this Mac", what, secrets }, config: cfg };
    if (typeof cfg.cwd === "string" && localRef(cfg.cwd, home)) delete cfg.cwd;
    return { mcp: { transport: "stdio", ok: true, what, secrets }, config: cfg };
  }
  if (command.includes("/") || localRef(command, home)) return { mcp: { transport: "stdio", ok: false, why: `runs ${tidy(command, home)}, which the sandbox won't have`, what: base, secrets }, config: cfg };
  if (localArg !== undefined) return { mcp: { transport: "stdio", ok: false, why: "points at a file on this Mac", what, secrets }, config: cfg };
  return { mcp: { transport: "stdio", ok: false, why: `needs ${base} installed there`, what, secrets }, config: cfg };
}

function projectEntry(j: any, folder?: string): Record<string, unknown> | undefined {
  if (!folder || !obj(j?.projects)) return undefined;
  const tries = [folder];
  try {
    tries.push(realpathSync(folder));
  } catch {
    // Gone.
  }
  for (const f of tries) if (obj(j.projects[f])) return j.projects[f];
  return undefined;
}

export function claudeMcp(s: Pick<SetupSource, "home" | "env">, folder?: string): McpFound[] {
  const j = readJson(claudeJsonPath(s));
  const out: McpFound[] = [];
  const add = (servers: unknown, scope: SetupMcp["scope"]) => {
    for (const [name, cfg] of Object.entries(obj(servers) ?? {})) {
      const c = obj(cfg);
      if (!c || out.some((x) => x.name === name && x.scope === scope)) continue;
      const { mcp, config } = classifyMcp(c, s.home);
      out.push({ name, scope, ...mcp, ...(scope === "project" ? {} : { config }) });
    }
  };
  add(j?.mcpServers, "user");
  add(projectEntry(j, folder)?.mcpServers, "local");
  if (folder) add(readJson(join(folder, ".mcp.json"))?.mcpServers, "project");
  return out;
}

export function codexMcp(s: Pick<SetupSource, "home" | "env">): McpFound[] {
  const text = readText(join(codexDir(s), "config.toml"));
  if (!text) return [];
  const servers = obj(parseToml(text).mcp_servers) ?? {};
  const out: McpFound[] = [];
  for (const [name, t] of Object.entries(servers)) {
    const table = obj(t) as TomlTable | undefined;
    if (!table) continue;
    const { mcp, config } = classifyMcp(table as Record<string, unknown>, s.home, true);
    out.push({ name, scope: "user", ...mcp, table: config as TomlTable });
  }
  return out;
}

export function mcpOf(agent: AgentKind, s: Pick<SetupSource, "home" | "env">, folder?: string): McpFound[] {
  if (agent === "claude") return claudeMcp(s, folder);
  if (agent === "codex") return codexMcp(s);
  return [];
}

/* ------------------------------------------------------ instructions */

interface Walked {
  entries: TarEntry[];
  files: number;
  bytes: number;
  skipped: string[];
}

/** Text or a small binary: worth copying. */
function looksCopyable(path: string, size: number): string | undefined {
  if (size > FILE_MAX_BYTES) return `${(size / 1048576).toFixed(0)} MB`;
  if (size <= BINARY_MAX_BYTES) return undefined;
  try {
    const fd = readFileSync(path).subarray(0, 8192);
    if (fd.includes(0)) return `a ${(size / 1048576).toFixed(1)} MB binary`;
  } catch {
    return "unreadable";
  }
  return undefined;
}

/**
 * Every file under `dir`, archived as `prefix/<rel>`. Links are followed only
 * when they stay inside `root`; folders are 0700, files 0600 (0700 when executable).
 */
export function walkDir(dir: string, prefix: string, o: { root: string; home: string; read: boolean; budget: { bytes: number; files: number }; label: string; raw?: boolean }): Walked {
  const w: Walked = { entries: [], files: 0, bytes: 0, skipped: [] };
  let rootReal = o.root;
  try {
    rootReal = realpathSync(o.root);
  } catch {
    // Keep it.
  }
  const seen = new Set<string>();
  const visit = (abs: string, rel: string) => {
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) {
      let real: string;
      try {
        real = realpathSync(abs);
      } catch {
        w.skipped.push(`${o.label}/${rel}: a broken link`);
        return;
      }
      if (real !== rootReal && !real.startsWith(rootReal + sep)) {
        w.skipped.push(`${o.label}/${rel}: a link to outside ${tidy(o.root, o.home)}`);
        return;
      }
      try {
        st = statSync(abs);
      } catch {
        return;
      }
      abs = real;
    }
    if (st.isDirectory()) {
      let real = abs;
      try {
        real = realpathSync(abs);
      } catch {
        // Keep it.
      }
      if (seen.has(real)) return;
      seen.add(real);
      if (rel) w.entries.push({ name: `${prefix}/${rel}`, type: "dir", mode: 0o700, mtime: st.mtimeMs / 1000 });
      let names: string[] = [];
      try {
        names = readdirSync(abs).sort();
      } catch {
        return;
      }
      for (const n of names) {
        if (!o.raw && (SKIP_DIRS.has(n) || NEVER.has(n))) continue;
        const r = rel ? `${rel}/${n}` : n;
        // A name tar can't carry safely (a backslash, a control character) stays here, alone.
        if (!safeName(r) || /[\x00-\x1f]/.test(n)) {
          w.skipped.push(`${o.label}/${JSON.stringify(r).slice(1, -1)}: a name that can't be copied`);
          continue;
        }
        visit(join(abs, n), r);
      }
      return;
    }
    if (!st.isFile()) return;
    if (!o.raw && NEVER.has(basename(abs))) {
      w.skipped.push(`${o.label}/${rel}: a sign-in or config file, never copied`);
      return;
    }
    const big = o.raw ? undefined : looksCopyable(abs, st.size);
    if (big) {
      w.skipped.push(`${o.label}/${rel}: ${big}`);
      return;
    }
    if (!o.raw && (o.budget.bytes + st.size > INSTRUCTIONS_MAX_BYTES || o.budget.files >= INSTRUCTION_FILES_MAX)) {
      w.skipped.push(`${o.label}/${rel}: over the ${INSTRUCTIONS_MAX_BYTES >> 20} MB cap`);
      return;
    }
    let data: Buffer | undefined;
    if (o.read) {
      try {
        data = readFileSync(abs);
      } catch {
        w.skipped.push(`${o.label}/${rel}: unreadable`);
        return;
      }
    }
    o.budget.bytes += st.size;
    o.budget.files++;
    w.files++;
    w.bytes += st.size;
    w.entries.push({ name: rel ? `${prefix}/${rel}` : prefix, type: "file", mode: st.mode & 0o111 ? 0o700 : 0o600, ...(data ? { data } : {}), mtime: st.mtimeMs / 1000 });
  };
  visit(dir, "");
  return w;
}

/** settings.json without what would run files on this machine there. */
export function sanitizeSettings(j: Record<string, unknown>, home: string): { settings: Record<string, unknown>; dropped: string[] } {
  const s: Record<string, unknown> = JSON.parse(JSON.stringify(j));
  const dropped: string[] = [];
  const hooks = obj(s.hooks);
  if (hooks) {
    let n = 0;
    for (const [event, list] of Object.entries(hooks)) {
      if (!Array.isArray(list)) continue;
      const kept = list
        .map((m) => {
          const mm = obj(m);
          if (!mm || !Array.isArray(mm.hooks)) return m;
          const hs = mm.hooks.filter((h) => {
            const hh = obj(h);
            const bad = hh && typeof hh.command === "string" && localRef(hh.command, home);
            if (bad) n++;
            return !bad;
          });
          return hs.length ? { ...mm, hooks: hs } : null;
        })
        .filter(Boolean);
      if (kept.length) hooks[event] = kept;
      else delete hooks[event];
    }
    if (!Object.keys(hooks).length) delete s.hooks;
    if (n) dropped.push(`hooks: ${n} that run${n === 1 ? "s" : ""} a file on this Mac`);
  }
  const cmdOf = (v: unknown) => (typeof v === "string" ? v : typeof obj(v)?.command === "string" ? (obj(v)!.command as string) : "");
  for (const k of ["statusLine", "apiKeyHelper", "awsCredentialExport", "awsAuthRefresh", "otelHeadersHelper", "fileSuggestion"]) {
    if (s[k] !== undefined && localRef(cmdOf(s[k]), home)) {
      delete s[k];
      dropped.push(`${k}: runs a file on this Mac`);
    }
  }
  const env = obj(s.env);
  if (env) {
    const local = Object.keys(env).filter((k) => typeof env[k] === "string" && localRef(env[k] as string, home));
    for (const k of local) delete env[k];
    if (local.length) dropped.push(`env: ${local.join(", ")} point${local.length === 1 ? "s" : ""} at this Mac`);
  }
  const perms = obj(s.permissions);
  if (perms && Array.isArray(perms.additionalDirectories)) {
    const before = perms.additionalDirectories.length;
    perms.additionalDirectories = perms.additionalDirectories.filter((d) => !(typeof d === "string" && localRef(d, home)));
    if ((perms.additionalDirectories as unknown[]).length !== before) dropped.push("permissions: extra folders on this Mac");
  }
  for (const k of ["enabledPlugins", "extraKnownMarketplaces"]) {
    if (s[k] !== undefined) {
      delete s[k];
      if (!dropped.some((d) => d.startsWith("plugins"))) dropped.push("plugins: they stay on this Mac");
    }
  }
  return { settings: s, dropped };
}

interface InstructionSpec {
  id: string;
  label: string;
  /** Path under the agent's config dir there and here. */
  rel: string;
  kind: "file" | "dir";
}

const INSTRUCTIONS: Partial<Record<AgentKind, InstructionSpec[]>> = {
  claude: [
    { id: "CLAUDE.md", label: "CLAUDE.md", rel: "CLAUDE.md", kind: "file" },
    { id: "rules", label: "Rules", rel: "rules", kind: "dir" },
    { id: "skills", label: "Skills", rel: "skills", kind: "dir" },
    { id: "agents", label: "Subagents", rel: "agents", kind: "dir" },
    { id: "commands", label: "Commands", rel: "commands", kind: "dir" },
  ],
  codex: [
    { id: "AGENTS.md", label: "AGENTS.md", rel: "AGENTS.md", kind: "file" },
    { id: "prompts", label: "Prompts", rel: "prompts", kind: "dir" },
    { id: "skills", label: "Skills", rel: "skills", kind: "dir" },
  ],
};

/** How many skills: folders with a SKILL.md (or any folder at the top). */
function skillCount(dir: string): number {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith(".")).length;
  } catch {
    return 0;
  }
}

export interface InstructionsCollected {
  items: SetupItem[];
  entries: TarEntry[];
  settings?: Record<string, unknown>;
}

export function instructionsOf(agent: AgentKind, s: Pick<SetupSource, "home" | "env">, o: { read: boolean; only?: string[] }): InstructionsCollected {
  const specs = INSTRUCTIONS[agent];
  if (!specs) return { items: [], entries: [] };
  const root = agent === "claude" ? claudeDir(s) : codexDir(s);
  const there = agent === "claude" ? ".claude" : ".codex";
  const budget = { bytes: 0, files: 0 };
  const items: SetupItem[] = [];
  const entries: TarEntry[] = [];
  const want = (id: string) => !o.only || o.only.includes(id);
  for (const spec of specs) {
    const abs = join(root, spec.rel);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (spec.kind === "file" ? !st.isFile() : !st.isDirectory()) continue;
    // Links are followed only inside the item's own folder: a skill can't reach ~/.claude/.credentials.json or the transcripts.
    const w = walkDir(abs, `${there}/${spec.rel}`, { root: spec.kind === "dir" ? abs : root, home: s.home, read: o.read && want(spec.id), budget: want(spec.id) ? budget : { bytes: 0, files: 0 }, label: spec.rel });
    if (!w.files) continue;
    items.push({ id: spec.id, label: spec.label, files: w.files, bytes: w.bytes, ...(spec.id === "skills" ? { count: skillCount(abs) } : {}), ...(w.skipped.length ? { skipped: w.skipped.slice(0, 20) } : {}) });
    if (o.read && want(spec.id)) entries.push(...w.entries);
  }
  let settings: Record<string, unknown> | undefined;
  if (agent === "claude") {
    const path = join(root, "settings.json");
    const raw = readText(path);
    const j = raw ? obj((() => { try { return JSON.parse(raw); } catch { return undefined; } })()) : undefined;
    if (j) {
      const { settings: clean, dropped } = sanitizeSettings(j, s.home);
      items.push({ id: "settings.json", label: "settings.json", files: 1, bytes: Buffer.byteLength(JSON.stringify(clean)), ...(dropped.length ? { skipped: dropped } : {}) });
      if (want("settings.json")) settings = clean;
    }
  }
  return { items, entries, ...(settings ? { settings } : {}) };
}

/* ------------------------------------------------------------ project */

/**
 * git in a folder the user picked, which may be someone else's checkout: a repo's own config can
 * name commands git runs (core.fsmonitor, hooks), so those are switched off, the system config is
 * skipped, and git gets only PATH and HOME (HOME for the user's global excludes file).
 */
function git(args: string[], cwd: string, maxBuffer = 64 << 20): Promise<string | null> {
  const env: Record<string, string> = { GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
  for (const k of ["PATH", "HOME"]) if (process.env[k]) env[k] = process.env[k]!;
  const hardened = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.untrackedCache=false", ...args];
  return new Promise((done) => {
    execFile("git", hardened, { cwd, timeout: 15_000, maxBuffer, env, encoding: "buffer" }, (err, out) => done(err ? null : (out as Buffer).toString("utf8")));
  });
}

/** lstat each path, a batch at a time, off the event loop (null for one that's gone). */
async function lstatAll(paths: string[], batch = 256): Promise<(Stats | null)[]> {
  const out: (Stats | null)[] = new Array(paths.length);
  for (let i = 0; i < paths.length; i += batch) {
    const part = await Promise.all(paths.slice(i, i + batch).map((p) => lstat(p).catch(() => null)));
    for (let j = 0; j < part.length; j++) out[i + j] = part[j]!;
  }
  return out;
}

/** Folder size, stopping once it passes `cap` (returns cap + 1 then). */
async function duCapped(dir: string, cap: number, skip?: (rel: string) => boolean): Promise<number> {
  let total = 0;
  const stack: [string, string][] = [[dir, ""]];
  while (stack.length) {
    const [abs, rel] = stack.pop()!;
    let names: string[];
    try {
      names = await readdir(abs);
    } catch {
      continue;
    }
    const kept = names.map((n) => [n, rel ? `${rel}/${n}` : n] as const).filter(([, r]) => !skip?.(r));
    const sts = await lstatAll(kept.map(([n]) => join(abs, n)));
    for (let i = 0; i < kept.length; i++) {
      const st = sts[i];
      if (!st) continue;
      if (st.isDirectory()) stack.push([join(abs, kept[i]![0]), kept[i]![1]]);
      else if (st.isFile()) total += st.size;
      if (total > cap) return cap + 1;
    }
  }
  return total;
}

/**
 * What of .git stays here: hooks (they run), the reflogs and FETCH_HEAD (a clone's reflog reads
 * "clone: from <url>", token included), config.worktree (a second config that can hold the same
 * headers; worktreeConfig isn't kept, so git won't look for it), other worktrees' admin folders
 * (paths on this Mac), and anything that looks like stored credentials.
 */
const GIT_LEFT_HERE = /^\.git\/(?:modules\/.+\/)?(?:hooks|logs)(?:\/|$)|^\.git\/worktrees(?:\/|$)|^\.git\/(?:modules\/.+\/)?(?:FETCH_HEAD|config\.worktree)$|^\.git\/[^/]*credential[^/]*$/i;

/**
 * Which keys of a repo's .git/config go to the sandbox, by section. Everything
 * else stays here: http.extraheader and credential helpers (tokens), url.<base>.insteadOf (often
 * a token in the base), include/includeIf (files on this Mac), core.sshCommand, fsmonitor, hooks.
 */
const GIT_CONFIG_KEEP: Record<string, readonly string[]> = {
  core: ["repositoryformatversion", "filemode", "bare", "logallrefupdates", "ignorecase", "precomposeunicode", "symlinks"],
  extensions: ["objectformat", "refstorage", "partialclone"],
  remote: ["url", "pushurl", "fetch", "push", "tagopt", "prune", "promisor", "partialclonefilter"],
  branch: ["remote", "merge", "rebase", "pushremote"],
  user: ["name", "email"],
};

/**
 * A remote URL without its credentials: all of http(s)'s userinfo (a token often rides as the
 * user name), and only the password part elsewhere, since ssh://git@host needs its user.
 */
function scrubRemoteUrl(value: string): string {
  return value.replace(/^("?)([a-z][a-z0-9+.-]*):\/\/([^@\s/]+)@/i, (m, q: string, scheme: string, info: string) => {
    if (/^(https?|ftps?)$/i.test(scheme)) return `${q}${scheme}://`;
    const user = info.split(":")[0]!;
    return info.includes(":") ? `${q}${scheme}://${user}@` : m;
  });
}

/**
 * A fresh .git/config with only the keys above, the remotes' URLs without user:password@ (a
 * token in a clone URL stays here). Values are copied as written, so quoting survives; a
 * continued value (trailing backslash) is dropped whole.
 */
export function safeGitConfig(text: string): string {
  const out: string[] = [];
  let section: string | null = null;
  let header = "";
  let headerOut = false;
  let continued = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (continued) {
      continued = line.endsWith("\\");
      continue;
    }
    if (!line || line[0] === "#" || line[0] === ";") continue;
    const h = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line);
    if (h) {
      // [name "sub"], or the old [name.sub] form
      const [name, sub] = h[2] !== undefined ? [h[1]!, h[2]] : [h[1]!.split(".")[0]!, h[1]!.includes(".") ? h[1]!.slice(h[1]!.indexOf(".") + 1) : undefined];
      section = Object.hasOwn(GIT_CONFIG_KEEP, name.toLowerCase()) ? name.toLowerCase() : null;
      // remote and branch need their subsection; user, core and extensions must not have one
      if (section && (section === "remote" || section === "branch") !== (sub !== undefined)) section = null;
      header = sub === undefined ? `[${section}]` : `[${section} "${sub.replace(/["\\]/g, "\\$&")}"]`;
      headerOut = false;
      continue;
    }
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line);
    if (!kv) continue;
    if (line.endsWith("\\")) {
      continued = true;
      continue;
    }
    if (!section) continue;
    const key = kv[1]!.toLowerCase();
    const keep = GIT_CONFIG_KEEP[section]!;
    if (!keep.includes("*") && !keep.includes(key)) continue;
    let value = kv[2] ?? "true";
    if (section === "remote" && (key === "url" || key === "pushurl")) value = scrubRemoteUrl(value);
    if (!headerOut) {
      out.push(header);
      headerOut = true;
    }
    out.push(`\t${key} = ${value}`);
  }
  return out.length ? `${out.join("\n")}\n` : "";
}

interface ProjectList {
  root: string;
  files: { rel: string; size: number; mode: number; link?: string }[];
  bytes: number;
  envFiles: string[];
  skipped: string[];
  git: SetupProject["git"];
  gitDir?: string;
  over?: string;
}

async function listProject(folder: string, o: { env: boolean; home: string }): Promise<ProjectList> {
  let root: string;
  try {
    root = realpathSync(folder);
    if (!statSync(root).isDirectory()) throw new Error("not a folder");
  } catch {
    throw new ControlError(400, "That project folder doesn't exist.");
  }
  const out: ProjectList = { root, files: [], bytes: 0, envFiles: [], skipped: [], git: { present: false, bytes: 0, ok: false } };
  const top = (await git(["rev-parse", "--show-toplevel"], root))?.trim();
  let rels: string[];
  const skippedDirs = new Set<string>();
  const listed = top ? await git(["ls-files", "-co", "--exclude-standard", "-z"], root) : null;
  if (top && listed === null) out.skipped.push("git ls-files didn't answer: the folder was read directly (only node_modules and caches left out)");
  if (top && listed !== null) {
    rels = listed.split("\0").filter(Boolean);
    // Ignored folders collapse to one line each (--directory), so node_modules isn't listed file by file.
    const ignoredEnv = (await git(["ls-files", "-o", "-i", "--exclude-standard", "--directory", "-z"], root)) ?? "";
    const have = new Set(rels);
    for (const r of ignoredEnv.split("\0")) if (r && ENV_FILE.test(basename(r)) && !have.has(r)) rels.push(r);
    let topReal = top;
    try {
      topReal = realpathSync(top);
    } catch {
      // Keep it.
    }
    const gitPath = join(root, ".git");
    if (topReal !== root) out.git = { present: true, bytes: 0, ok: false, why: `the repository starts at ${tidy(topReal, o.home)}: its history stays here` };
    else {
      let st;
      try {
        st = lstatSync(gitPath);
      } catch {
        st = undefined;
      }
      if (st?.isFile()) out.git = { present: true, bytes: 0, ok: false, why: "a git worktree: its history lives in another folder" };
      else if (st?.isDirectory()) {
        const bytes = await duCapped(gitPath, GIT_MAX_BYTES, (r) => r === "hooks" || r.startsWith("hooks/"));
        out.git = bytes > GIT_MAX_BYTES ? { present: true, bytes, ok: false, why: `.git is over ${GIT_MAX_BYTES >> 20} MB: the files go without their history` } : { present: true, bytes, ok: true };
        if (out.git.ok) out.gitDir = gitPath;
      }
    }
  } else {
    rels = [];
    const stack: string[] = [""];
    while (stack.length && rels.length <= PROJECT_MAX_FILES) {
      const rel = stack.pop()!;
      let ents;
      try {
        ents = await readdir(join(root, rel), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of ents) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name) || e.name === ".cache") {
            skippedDirs.add(e.name);
            continue;
          }
          stack.push(r);
        } else rels.push(r);
      }
    }
    if (skippedDirs.size) out.skipped.push(`${[...skippedDirs].sort().join(", ")}: not copied`);
  }
  rels.sort();
  const names: string[] = [];
  for (const rel of rels) {
    if (!safeName(rel) || /[\x00-\x1f]/.test(rel)) out.skipped.push(`${JSON.stringify(rel).slice(1, -1)}: a name that can't be copied`);
    else names.push(rel);
  }
  // Thousands of files: stat them off the event loop, a batch at a time, and stop once over the cap.
  const BATCH = 512;
  let stats: (Stats | null)[] = [];
  for (let i = 0; i < names.length; i++) {
    if (i % BATCH === 0) {
      if (out.files.length > PROJECT_MAX_FILES) break;
      stats = await lstatAll(names.slice(i, i + BATCH).map((rel) => join(root, rel)));
    }
    const rel = names[i]!;
    const abs = join(root, rel);
    const st = stats[i % BATCH];
    if (!st) continue;
    if (ENV_FILE.test(basename(rel))) {
      if (st.isFile()) out.envFiles.push(rel);
      continue;
    }
    if (st.isSymbolicLink()) {
      let real: string | undefined;
      try {
        real = await realpath(abs);
      } catch {
        real = undefined;
      }
      if (!real || (real !== root && !real.startsWith(root + sep))) {
        out.skipped.push(`${rel}: a link to outside the folder`);
        continue;
      }
      const target = relative(dirname(abs), real) || ".";
      const raw = await readlink(abs).catch(() => target);
      out.files.push({ rel, size: 0, mode: 0o777, link: raw.startsWith("/") ? target : raw });
      continue;
    }
    if (st.isDirectory()) {
      out.skipped.push(`${rel}: a submodule (not copied)`);
      continue;
    }
    if (!st.isFile()) continue;
    if (st.size > FILE_MAX_BYTES * 4) {
      out.skipped.push(`${rel}: ${(st.size / 1048576).toFixed(0)} MB`);
      continue;
    }
    out.files.push({ rel, size: st.size, mode: st.mode });
    out.bytes += st.size;
    if (out.bytes > PROJECT_MAX_BYTES && !out.over) out.over = `over ${PROJECT_MAX_BYTES >> 20} MB`;
  }
  if (out.files.length > PROJECT_MAX_FILES) out.over = `over ${PROJECT_MAX_FILES.toLocaleString("en-US")} files`;
  return out;
}

export async function projectInventory(folder: string, home: string): Promise<SetupProject> {
  const p = await listProject(folder, { env: false, home });
  return {
    folder: p.root,
    display: tidy(p.root, home),
    files: p.files.length,
    bytes: p.bytes,
    git: p.git,
    envFiles: p.envFiles.slice(0, 20),
    ok: !p.over,
    ...(p.over ? { why: `${tidy(p.root, home)} is ${p.over}: pick a smaller folder` } : {}),
    ...(p.skipped.length ? { skipped: p.skipped.slice(0, 20) } : {}),
  };
}

async function projectArchive(folder: string, o: { git: boolean; env: boolean; home: string }): Promise<{ entries: TarEntry[]; files: number; bytes: number; display: string; envFiles: { path: string; content: string }[]; skipped: string[] }> {
  const p = await listProject(folder, { env: o.env, home: o.home });
  if (p.over) throw new ControlError(400, `${tidy(p.root, o.home)} is ${p.over}; pick a smaller folder.`);
  const entries: TarEntry[] = [];
  const dirs = new Set<string>();
  const addDirs = (rel: string) => {
    const parts = rel.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const d = parts.slice(0, i).join("/");
      if (!dirs.has(d)) {
        dirs.add(d);
        entries.push({ name: d, type: "dir", mode: 0o700 });
      }
    }
  };
  const skipped = [...p.skipped];
  for (const f of p.files) {
    addDirs(f.rel);
    if (f.link !== undefined) {
      entries.push({ name: f.rel, type: "symlink", mode: 0o777, link: f.link });
      continue;
    }
    let data: Buffer;
    try {
      data = readFileSync(join(p.root, f.rel));
    } catch {
      skipped.push(`${f.rel}: unreadable`);
      continue;
    }
    entries.push({ name: f.rel, type: "file", mode: f.mode & 0o111 ? 0o700 : 0o600, data });
  }
  let bytes = p.bytes;
  if (o.git && p.gitDir) {
    const w = walkDir(p.gitDir, ".git", { root: p.gitDir, home: o.home, read: true, budget: { bytes: 0, files: 0 }, label: ".git", raw: true });
    entries.push({ name: ".git", type: "dir", mode: 0o700 });
    for (const e of w.entries) {
      if (GIT_LEFT_HERE.test(e.name)) continue;
      if (/^\.git\/(modules\/.+\/)?config$/.test(e.name) && e.data) e.data = Buffer.from(safeGitConfig(e.data.toString("utf8")), "utf8");
      entries.push(e.type === "file" ? { ...e, mode: 0o600 } : e);
      if (e.type === "file") bytes += e.data?.length ?? 0;
    }
  } else if (o.git && p.git.present && p.git.why) skipped.push(p.git.why);
  const envFiles: { path: string; content: string }[] = [];
  if (o.env) {
    for (const rel of p.envFiles) {
      let text: string;
      try {
        text = readFileSync(join(p.root, rel), "utf8");
      } catch {
        continue;
      }
      if (Buffer.byteLength(text) > SECRET_FILE_MAX || text.includes("\0")) {
        skipped.push(`${rel}: over ${SECRET_FILE_MAX >> 10} KB`);
        continue;
      }
      envFiles.push({ path: rel, content: text });
    }
  }
  return { entries, files: p.files.length, bytes, display: tidy(p.root, o.home), envFiles, skipped };
}

/** Folder entries for every parent an entry needs, ahead of it (0700). */
export function withDirs(entries: TarEntry[]): TarEntry[] {
  const have = new Set(entries.filter((e) => e.type === "dir").map((e) => e.name));
  const out: TarEntry[] = [];
  for (const e of entries) {
    const parts = e.name.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const d = parts.slice(0, i).join("/");
      if (have.has(d)) continue;
      have.add(d);
      out.push({ name: d, type: "dir", mode: 0o700 });
    }
    out.push(e);
  }
  return out;
}

/* -------------------------------------------------------------- login */

export function oauthExpiry(k: KeyInfo | undefined): string | undefined {
  if (!k) return undefined;
  if (k.expiresAt) return k.expiresAt;
  const t = Date.parse(k.addedAt);
  return Number.isFinite(t) && t > 0 ? new Date(t + OAUTH_TOKEN_DAYS * 86400_000).toISOString() : undefined;
}

const month = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export function loginsOf(agent: AgentKind, s: SetupSource): SetupLogin[] {
  const stored = (n: string) => s.keys.find((k) => k.name === n);
  const inShell = (n: string) => s.shellKeys.includes(n);
  const keyLogin = (name: string, label: string): SetupLogin => {
    if (stored(name)) return { kind: "key", label, detail: `${name}, stored`, available: true, keys: [name] };
    if (inShell(name)) return { kind: "key", label, detail: `${name} from your shell`, available: true, keys: [name] };
    return { kind: "key", label, available: false, why: `Add ${name} under Keys, or export it in your shell` };
  };
  if (agent === "claude") {
    const tok = stored("CLAUDE_CODE_OAUTH_TOKEN");
    const exp = oauthExpiry(tok);
    return [
      tok
        ? { kind: "subscription", label: "Claude subscription", detail: exp ? `expires ~${month(exp)}` : "connected", available: true, keys: ["CLAUDE_CODE_OAUTH_TOKEN"] }
        : inShell("CLAUDE_CODE_OAUTH_TOKEN")
          ? { kind: "subscription", label: "Claude subscription", detail: "CLAUDE_CODE_OAUTH_TOKEN from your shell", available: true, keys: ["CLAUDE_CODE_OAUTH_TOKEN"] }
          : { kind: "subscription", label: "Claude subscription", available: false, why: "Connect Claude in Settings, Logins" },
      keyLogin("ANTHROPIC_API_KEY", "API key"),
      { kind: "none", label: "Sign in there myself", available: true },
    ];
  }
  if (agent === "codex") {
    let auth = false;
    try {
      auth = statSync(join(codexDir(s), "auth.json")).isFile();
    } catch {
      auth = false;
    }
    return [
      keyLogin("OPENAI_API_KEY", "API key"),
      { kind: "device", label: "ChatGPT, with a device code", detail: "the code shows in the panel (terminal mode)", available: true },
      auth
        ? { kind: "copy", label: "This Mac's ChatGPT sign-in", detail: "copies ~/.codex/auth.json (it holds your tokens)", available: true }
        : { kind: "copy", label: "This Mac's ChatGPT sign-in", available: false, why: "Codex isn't signed in with ChatGPT on this Mac" },
      { kind: "none", label: "Sign in there myself", available: true },
    ];
  }
  return [];
}

/** Key names "Bring my setup" may read from the login shell for an agent: its own, never a platform token. */
export function shellKeyNames(names: string[]): string[] {
  return names.filter((n) => !PLATFORM_KEY_NAMES.includes(n));
}

/* ---------------------------------------------------------- inventory */

/** The pieces of an inventory, each looked up on its own (and cached on its own by createSetupCache). */
export interface InventoryParts {
  mcp(agent: AgentKind, s: SetupSource, folder?: string): Promise<SetupMcp[]>;
  instructions(agent: AgentKind, s: SetupSource): Promise<SetupItem[]>;
  project(folder: string, home: string): Promise<SetupProject>;
}

const DIRECT: InventoryParts = {
  mcp: async (agent, s, folder) => mcpOf(agent, s, folder).map(({ config: _c, table: _t, ...m }) => m),
  instructions: async (agent, s) => instructionsOf(agent, s, { read: false }).items,
  project: (folder, home) => projectInventory(folder, home),
};

export async function inventory(agent: AgentKind, s: SetupSource, folder?: string, parts: InventoryParts = DIRECT): Promise<SetupInventory> {
  const notes: string[] = [];
  if (agent === "claude") notes.push("claude.ai connectors don't come along with a setup-token login; MCP servers configured on this Mac do.");
  const [mcp, instructions, project] = await Promise.all([parts.mcp(agent, s, folder), parts.instructions(agent, s), folder ? parts.project(folder, s.home) : undefined]);
  if (agent !== "claude" && agent !== "codex") notes.push(`MCP servers and instructions come along for Claude Code and Codex; ${BRAND[agent].name} gets its keys and the project.`);
  return { agent, login: loginsOf(agent, s), shellKeys: shellKeyNames(s.shellKeys), mcp, instructions, ...(project ? { project } : {}), notes };
}

/* --------------------------------------------------- the cached inventory */

/** How long each piece stays fresh when nothing it is stamped with changed. */
export const SETUP_TTL_MS = { project: 30_000, instructions: 120_000, mcp: 30_000 } as const;

/** mtime and size of each path ("-" for one that isn't there): what a stamp is made of. */
function statStamp(paths: string[]): string {
  return paths
    .map((p) => {
      try {
        const st = statSync(p);
        return `${Math.floor(st.mtimeMs)}:${st.size}`;
      } catch {
        return "-";
      }
    })
    .join("|");
}

/**
 * What changes when a project's file list does: the git index (an add, a commit, a checkout), HEAD,
 * .gitignore and the folder itself (a file added or removed at the top). Deeper untracked changes
 * wait for the TTL.
 */
export function projectStamp(folder: string): string {
  return statStamp([folder, join(folder, ".git"), join(folder, ".git", "index"), join(folder, ".git", "HEAD"), join(folder, ".gitignore")]);
}

/** The agent's config folder and each instruction file or folder in it (an added skill, an edited CLAUDE.md). */
export function instructionsStamp(agent: AgentKind, s: Pick<SetupSource, "home" | "env">): string {
  const specs = INSTRUCTIONS[agent];
  if (!specs) return "";
  const root = agent === "claude" ? claudeDir(s) : codexDir(s);
  return statStamp([root, ...specs.map((x) => join(root, x.rel)), join(root, "settings.json")]);
}

/** The files MCP servers are read from. */
export function mcpStamp(agent: AgentKind, s: Pick<SetupSource, "home" | "env">, folder?: string): string {
  if (agent === "claude") return statStamp([claudeJsonPath(s), ...(folder ? [join(folder, ".mcp.json")] : [])]);
  if (agent === "codex") return statStamp([join(codexDir(s), "config.toml")]);
  return "";
}

export interface SetupCache {
  /**
   * The inventory for the hire form, from the cache where it can: `refreshing` when a piece was
   * stale (a fresh look is under way). `wait`: answer with fresh pieces, waiting for them.
   */
  inventory(agent: AgentKind, s: SetupSource, folder?: string, o?: { wait?: boolean }): Promise<SetupInventory>;
  clear(): void;
}

export function createSetupCache(o: { now?: () => number; ttl?: Partial<typeof SETUP_TTL_MS>; parts?: InventoryParts } = {}): SetupCache {
  const ttl = { ...SETUP_TTL_MS, ...o.ttl };
  const direct = o.parts ?? DIRECT;
  // The source a piece is computed from is the one of the request that made it (home and env don't change).
  let src: SetupSource | undefined;
  const projects = new SwrMap<string, SetupProject>((folder) => new Swr(() => direct.project(folder, src!.home), { ttlMs: ttl.project, stamp: () => projectStamp(folder), now: o.now }), 16);
  const instructions = new SwrMap<AgentKind, SetupItem[]>((agent) => new Swr(() => direct.instructions(agent, src!), { ttlMs: ttl.instructions, stamp: () => instructionsStamp(agent, src!), now: o.now }), 8);
  const mcps = new SwrMap<string, SetupMcp[]>((key) => {
    const [agent, folder] = key.split("\0") as [AgentKind, string];
    return new Swr(() => direct.mcp(agent, src!, folder || undefined), { ttlMs: ttl.mcp, stamp: () => mcpStamp(agent, src!, folder || undefined), now: o.now });
  }, 32);
  return {
    async inventory(agent, s, folder, io = {}) {
      src = s;
      let stale = false;
      const piece = async <V>(c: Swr<V>): Promise<V> => {
        if (io.wait) return c.fresh();
        const hit = await c.get();
        if (!hit.fresh) stale = true;
        return hit.value;
      };
      const inv = await inventory(agent, s, folder, {
        mcp: (a, _s, f) => piece(mcps.of(`${a}\0${f ?? ""}`)),
        instructions: (a) => piece(instructions.of(a)),
        project: (f) => piece(projects.of(f)),
      });
      return stale ? { ...inv, refreshing: true } : inv;
    },
    clear() {
      projects.clear();
      instructions.clear();
      mcps.clear();
    },
  };
}

/* ------------------------------------------------------------ collect */

function size(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1 << 20) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

/** What a hire takes along. Throws ControlError(400) for a project that can't go (missing, over the cap). */
export async function collect(agent: AgentKind, choice: SetupChoice, s: SetupSource): Promise<SetupBundle> {
  const skipped: string[] = [];
  const bits: string[] = [];
  const folder = choice.project?.folder;
  const b: SetupBundle = { agent, summary: "", skipped };
  const login = choice.login ?? "none";
  if (agent === "claude" && login === "subscription") bits.push("Claude subscription");
  else if (login === "key") bits.push("API key");
  else if (login === "device") bits.push("device sign-in");
  else if (login === "copy") bits.push("ChatGPT sign-in");
  if (agent === "claude" && login === "key") b.approveClaudeKey = true;

  // MCP servers
  const wanted = new Set(choice.mcp ?? []);
  const servers = mcpOf(agent, s, folder).filter((m) => m.scope !== "project" && wanted.has(m.name));
  if (agent === "claude") {
    const mcpServers: Record<string, unknown> = {};
    const projectMcpServers: Record<string, unknown> = {};
    for (const m of servers) if (m.config) (m.scope === "local" ? projectMcpServers : mcpServers)[m.name] = m.config;
    const projectFlags: Record<string, unknown> = {};
    const entry = projectEntry(readJson(claudeJsonPath(s)), folder);
    for (const k of ["enabledMcpjsonServers", "disabledMcpjsonServers", "enableAllProjectMcpServers"]) if (entry && entry[k] !== undefined) projectFlags[k] = entry[k];
    b.claude = { mcpServers, projectMcpServers, projectFlags, onboarding: true };
  } else if (agent === "codex") {
    b.codex = { mcp: servers.filter((m) => m.table).map((m) => ({ name: m.name, toml: mcpServerToml(m.name, m.table!) })) };
  }
  if (servers.length) bits.push(`${servers.length} MCP server${servers.length === 1 ? "" : "s"}`);

  // instructions and skills
  const only = choice.instructions ?? [];
  if (only.length) {
    const ins = instructionsOf(agent, s, { read: true, only });
    for (const it of ins.items) if (only.includes(it.id)) for (const x of it.skipped ?? []) skipped.push(x);
    if (ins.entries.length) {
      const files = ins.entries.filter((e) => e.type === "file");
      b.home = { entries: withDirs(ins.entries), files: files.length, bytes: files.reduce((n, e) => n + (e.data?.length ?? 0), 0) };
    }
    if (ins.settings && b.claude) b.claude.settings = ins.settings;
    const skills = ins.items.find((i) => i.id === "skills" && only.includes("skills"))?.count ?? 0;
    const named = ins.items.filter((i) => only.includes(i.id) && i.id !== "skills").map((i) => i.label);
    const parts = [named.includes("CLAUDE.md") || named.includes("AGENTS.md") ? "instructions" : named.length ? named.join(", ").toLowerCase() : "", skills ? `${skills} skill${skills === 1 ? "" : "s"}` : ""].filter(Boolean);
    if (parts.length) bits.push(parts.join(" + "));
  }

  // Codex: this machine's sign-in, when asked.
  if (agent === "codex" && login === "copy") {
    const text = readText(join(codexDir(s), "auth.json"));
    if (text && Buffer.byteLength(text) <= SECRET_FILE_MAX && !text.includes("\0")) b.codex = { ...(b.codex ?? { mcp: [] }), authJson: text };
    else skipped.push("Codex sign-in: ~/.codex/auth.json isn't there");
  }

  // project
  if (folder) {
    const p = await projectArchive(folder, { git: choice.project?.git !== false, env: !!choice.project?.env, home: s.home });
    b.project = { entries: p.entries, files: p.files, bytes: p.bytes, display: p.display };
    if (p.envFiles.length) b.envFiles = p.envFiles;
    skipped.push(...p.skipped);
    bits.push(`${p.display} (${size(p.bytes)})`);
  }
  b.summary = bits.join(" · ") || "nothing";
  return b;
}

/** A remote folder for the project when the form left "Folder there" empty: ~/<name>. */
export function defaultRemoteCwd(folder: string): string {
  const name = basename(resolve(folder)).replace(/[^\w.-]+/g, "-").replace(/^[.-]+/, "") || "project";
  return `~/${name}`;
}
