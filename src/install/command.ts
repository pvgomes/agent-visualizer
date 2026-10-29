/*
 * What command each agent should launch for the MCP server. From an npx
 * cache the CLI's own path is temporary, so agents get `npx -y
 * @pvgomes/agent-visualizer@<this exact version> mcp`; from a global install or a checkout
 * they get the absolute node + dist/cli.js paths, which work before the
 * package is even published. Remote installs always use npx: our paths mean
 * nothing there. The npx form is pinned, never @latest, so a later release
 * (or a compromised one) doesn't run in every agent unannounced, and
 * src/install/index.ts refuses it unless that version is really on npm.
 * Every command ends in `mcp --agent <kind>`, so the server knows who
 * launched it even when the client's self-reported name is unfamiliar.
 */
import { accessSync, constants, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentKind } from "../shared/events.ts";
import { readServiceFile } from "../control/service.ts";

export const SERVER_NAME = "agent-visualizer";
export const PACKAGE_NAME = "@pvgomes/agent-visualizer";
/** Where people install it from while it isn't on npm: npx and npm -g take it straight from GitHub. */
export const GITHUB_SPEC = "github:pvgomes/agent-visualizer";

/** The spec agents run with npx: this exact version. */
export function npxPackage(version: string): string {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ? `${PACKAGE_NAME}@${version}` : `${PACKAGE_NAME}@latest`;
}

export interface Launch {
  how: "npx" | "node";
  /** Why this form was picked, for the plan header. */
  why: string;
  /** Executable + args before `mcp --agent <kind>`. */
  base: string[];
}

export interface LaunchCommand {
  command: string;
  args: string[];
}

/** Is this script running out of a package-runner cache (npx, pnpm dlx, bunx, yarn dlx)? */
export function isEphemeral(script: string): boolean {
  const p = script.replace(/\\/g, "/");
  return /\/_npx\/|\/\.pnpm-store\/|\/pnpm\/dlx\/|\/dlx-\d+\/|\/bunx-|\/\.bun\/install\/cache\/|\/yarn\/berry\/cache\//.test(p);
}

/** The background service's copy: <AGENT_VISUALIZER_HOME>/app/<version>/dist/cli.js (src/control/service.ts copyApp). */
const SERVICE_COPY = /\/app\/[^/]+\/dist\/cli\.js$/;

/**
 * What to type to run this CLI again, for the commands its hints name: `agent-visualizer` after a
 * global install, `npx github:pvgomes/agent-visualizer` from a package-runner cache, where `agent-visualizer` was
 * never put on PATH. The background service's copy isn't on PATH either: it names what installed
 * it, as service.json beside app/ records (npx when that predates the record).
 */
export function selfCommand(script = fileURLToPath(import.meta.url)): string {
  if (isEphemeral(script)) return `npx ${GITHUB_SPEC}`;
  if (SERVICE_COPY.test(script.replace(/\\/g, "/"))) {
    const f = readServiceFile(dirname(dirname(dirname(dirname(script)))));
    if (f) return f.command ?? `npx ${GITHUB_SPEC}`;
  }
  return "agent-visualizer";
}

export function chooseLaunch(opts: { remote: boolean; version?: string; script?: string; node?: string; platform?: string }): Launch {
  const platform = opts.platform ?? process.platform;
  const pkg = npxPackage(opts.version ?? "");
  const npx = platform === "win32" && !opts.remote ? ["cmd", "/c", "npx", "-y", pkg] : ["npx", "-y", pkg];
  if (opts.remote) return { how: "npx", why: "remote install: agents there run it straight from npm", base: npx };
  const script = opts.script ?? fileURLToPath(import.meta.url);
  if (isEphemeral(script)) return { how: "npx", why: "running from an npx cache, which can be cleared at any time", base: npx };
  const node = opts.node ?? stableNode();
  return {
    how: "node",
    why: "running from a local install, so agents launch this exact copy (works before it's on npm)",
    base: [isAbsolute(node) ? node : process.execPath, script],
  };
}

/**
 * process.execPath is often a versioned path (Homebrew's Cellar/node/26.5.0) that vanishes on the
 * next upgrade. If `node` on PATH is the same binary, register that stable name instead.
 */
export function stableNode(execPath = process.execPath, path = process.env.PATH ?? ""): string {
  let real: string;
  try {
    real = realpathSync(execPath);
  } catch {
    return execPath;
  }
  for (const dir of path.split(delimiter)) {
    // A relative PATH entry (node_modules/.bin) would make the command depend on the agent's folder.
    if (!dir || !isAbsolute(dir)) continue;
    const cand = join(dir, process.platform === "win32" ? "node.exe" : "node");
    try {
      accessSync(cand, constants.X_OK);
      if (realpathSync(cand) === real) return cand;
    } catch {
      // Not here.
    }
  }
  return execPath;
}

/**
 * Is @pvgomes/agent-visualizer@<version> on the npm registry? null when the registry can't be asked. An npx
 * command for a version that isn't there fails at every agent launch, and for an unclaimed
 * name it would run whatever someone publishes under it next.
 */
export async function npmHasVersion(version: string, o: { fetch?: typeof fetch; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<boolean | null> {
  const f = o.fetch ?? globalThis.fetch;
  if (!f) return null;
  const env = o.env ?? process.env;
  const registry = (env.npm_config_registry || env.NPM_CONFIG_REGISTRY || "https://registry.npmjs.org").replace(/\/+$/, "");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 8_000);
  try {
    const res = await f(`${registry}/${PACKAGE_NAME}/${encodeURIComponent(version)}`, { headers: { accept: "application/json" }, signal: ctl.signal });
    if (res.status === 404) return false;
    if (!res.ok) return null;
    const j = (await res.json()) as { name?: unknown; version?: unknown; dist?: { tarball?: unknown } };
    return j?.name === PACKAGE_NAME && j.version === version && typeof j.dist?.tarball === "string";
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function launchFor(launch: Launch, agent: AgentKind): LaunchCommand {
  const [command, ...rest] = launch.base;
  return { command: command!, args: [...rest, "mcp", "--agent", agent] };
}

/** "node /a b/cli.js mcp" with shell-style quoting, for display. */
export function display(cmd: LaunchCommand): string {
  return [cmd.command, ...cmd.args].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
}
