/*
 * The subcommands that aren't the office itself:
 *   agent-visualizer mcp [--agent <kind>]          the stdio MCP server agents launch
 *   agent-visualizer install   [flags]             register the server + skill in every agent
 *   agent-visualizer uninstall [flags]             take exactly that back out
 *   agent-visualizer doctor    [flags]             what's installed where, and is the office up
 *   agent-visualizer open      [--print] [--rotate] unlock the office's controls in a browser
 *   agent-visualizer install --service / uninstall --service   the background service
 * Shared flags: --agents a,b  --dry-run  --yes  --no-skill  --no-mcp, and a
 * target: --ssh <host> | --daytona|--boat|--railway|--vercel <id|all>
 * (repeatable). Without a target everything happens on this machine.
 */
import { createInterface } from "node:readline";
import type { AgentKind } from "../shared/events.ts";
import { AGENT_KINDS, parseAgentKind } from "../mcp/clients.ts";
import { runMcpStdio } from "../mcp/server.ts";
import { fetchSnapshot, findOffice } from "../mcp/office.ts";
import { outboxDir } from "../mcp/outbox.ts";
import { chooseLaunch, npmHasVersion, npxPackage, selfCommand, type Launch } from "./command.ts";
import { diagnose, install, printDoctor, uninstall, type Out } from "./installer.ts";
import { REMOTE_KINDS, detectRemotes, resolveRemotes, type RemoteKind, type RemoteSelector } from "./remotes.ts";
import { localSys, remoteSys, type Sys } from "./sys.ts";
import { PAD, bold, cyan, dim, green, red, yellow } from "./ui.ts";
import { doctorRows, runOpen, serviceCommand } from "../control/cli.ts";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const SUBCOMMANDS = new Set(["mcp", "install", "uninstall", "doctor", "open"]);

class UsageError extends Error {}

interface Flags {
  agents?: AgentKind[];
  dryRun: boolean;
  yes: boolean;
  mcp: boolean;
  skill: boolean;
  remotes: RemoteSelector[];
  help: boolean;
  verbose: boolean;
  agentHint?: AgentKind;
  /** install / uninstall: the background service instead of the MCP server and skill. */
  service: boolean;
}

function parse(cmd: string, argv: string[]): Flags {
  const f: Flags = { dryRun: false, yes: false, mcp: true, skill: true, remotes: [], help: false, verbose: false, service: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const value = (): string => {
      if (eq !== -1) return arg.slice(eq + 1);
      const v = argv[++i];
      if (v === undefined || v.startsWith("-")) throw new UsageError(`${flag} needs a value`);
      return v;
    };
    const remote = flag.startsWith("--") ? (flag.slice(2) as RemoteKind) : undefined;
    if (remote && REMOTE_KINDS.includes(remote) && cmd !== "mcp") {
      const v = value().trim();
      if (!v) throw new UsageError(`${flag} needs a value`);
      f.remotes.push({ kind: remote, id: v });
      continue;
    }
    switch (flag) {
      case "--agent":
        if (cmd === "mcp") {
          const k = parseAgentKind(value());
          if (k) f.agentHint = k; // an unknown name just means no hint; never fail an agent's launch over it
          break;
        }
      // fallthrough
      case "--agents": {
        const names = value().split(",").map((s) => s.trim()).filter(Boolean);
        if (names.includes("all")) {
          f.agents = [...AGENT_KINDS];
          break;
        }
        const picked = new Set<AgentKind>();
        for (const n of names) {
          const k = parseAgentKind(n);
          if (!k) throw new UsageError(`unknown agent "${n}" (expected ${AGENT_KINDS.join(", ")})`);
          picked.add(k);
        }
        if (!picked.size) throw new UsageError("--agents needs at least one agent");
        f.agents = AGENT_KINDS.filter((a) => picked.has(a));
        break;
      }
      case "--dry-run":
      case "-n":
        f.dryRun = true;
        break;
      case "--yes":
      case "-y":
        f.yes = true;
        break;
      case "--no-skill":
        f.skill = false;
        break;
      case "--no-mcp":
        f.mcp = false;
        break;
      case "--verbose":
        f.verbose = true;
        break;
      case "--service":
        if (cmd !== "install" && cmd !== "uninstall") throw new UsageError(`unknown option ${flag}`);
        f.service = true;
        break;
      case "--help":
      case "-h":
        f.help = true;
        break;
      default:
        // The MCP server is launched by agents from saved configs: never refuse to start over a flag.
        if (cmd === "mcp") break;
        throw new UsageError(arg.startsWith("-") ? `unknown option ${flag}` : `unexpected argument "${arg}"`);
    }
  }
  return f;
}

const TARGET_HELP = `  --ssh <host>          Do it on an ssh box (user@host or an ~/.ssh/config alias)
  --daytona <id|all>    ... in Daytona sandboxes
  --boat <id|all>       ... in boat VMs
  --railway <id|all>    ... in Railway sandboxes
  --vercel <id|all>     ... in Vercel Sandboxes
                        (remote installs need Node 18+ there and register \`npx -y @pvgomes/agent-visualizer@<this version> mcp\`,
                        so they need this version published on npm)`;

function help(cmd: string): string {
  if (cmd === "mcp") {
    return `
${bold("agent-visualizer mcp")}  the agent-visualizer MCP server, on stdio

Agents launch this themselves; ${bold("agent-visualizer install")} sets that up.
Tools: office_status, office_peers, office_shout, office_celebrate, office_flip.

  --agent <kind>   Who is launching it (${AGENT_KINDS.join(", ")})
  --verbose        Log protocol traffic to stderr
`;
  }
  if (cmd === "doctor") {
    return `
${bold("agent-visualizer doctor")}  which agents have the office tools and skill, and whether the office is running

${TARGET_HELP}
`;
  }
  return `
${bold(`agent-visualizer ${cmd}`)}  ${cmd === "install" ? "register the office MCP server and skill in every coding agent" : "remove the office MCP server and skill from every agent"}

  --agents <list>       Only these: ${AGENT_KINDS.join(",")} (default: every agent found)
  --dry-run, -n         Show the plan and the exact file diffs; change nothing
  --yes, -y             Don't ask before applying
  --no-skill            ${cmd === "install" ? "Register the MCP server only" : "Leave the skill"}
  --no-mcp              ${cmd === "install" ? "Install the skill only" : "Leave the MCP server"}
  --service             ${cmd === "install" ? "Instead: run the office in the background from login (launchd / systemd), started now" : "Instead: remove the background service"}
${TARGET_HELP}

Every changed file gets a timestamped backup next to it. Re-running is safe.
`;
}

async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer: string = await new Promise((done) => rl.question(`${PAD}${question} ${dim("[Y/n]")} `, done));
    return !/^\s*n/i.test(answer);
  } finally {
    rl.close();
  }
}

/** Machines to work on: this one, or the remotes named by flags. */
async function machines(f: Flags, out: Out, version: string): Promise<{ sys: Sys; launch: Launch }[] | null> {
  if (!f.remotes.length) return [{ sys: localSys(), launch: chooseLaunch({ remote: false, version }) }];
  let targets;
  try {
    targets = await resolveRemotes(f.remotes);
  } catch (err) {
    out(`${PAD}${red("✗")} ${(err as Error).message}`);
    return null;
  }
  const list: { sys: Sys; launch: Launch }[] = [];
  for (const t of targets) {
    try {
      list.push({ sys: await remoteSys(t), launch: chooseLaunch({ remote: true, version }) });
    } catch (err) {
      out(`${PAD}${red("✗")} ${t.host.id}: ${(err as Error).message}`);
    }
  }
  return list;
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86_400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86_400)}d ago`;
}

async function officeLine(out: Out): Promise<void> {
  const port = await findOffice();
  if (port === null) out(`${PAD}${dim("Office")}     ${yellow("not running")} ${dim("· start it with")} ${bold("npx @pvgomes/agent-visualizer")}`);
  else {
    const snap = await fetchSnapshot(port);
    const n = snap?.workers.length ?? 0;
    out(`${PAD}${dim("Office")}     ${green("running")} ${dim("at")} ${bold(`http://127.0.0.1:${port}`)}${snap ? dim(` · ${n} worker${n === 1 ? "" : "s"}${snap.demo ? " (demo)" : ""}`) : ""}`);
  }
  try {
    const dir = outboxDir();
    const files = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
    const last = Math.max(0, ...files.map((n) => statSync(join(dir, n)).mtimeMs));
    out(`${PAD}${dim("Signals")}    ${files.length ? `${files.length} agent${files.length === 1 ? "" : "s"} have used the tools, last ${ago(Date.now() - last)}` : dim("no agent has called the office tools yet")}`);
  } catch {
    out(`${PAD}${dim("Signals")}    ${dim("no agent has called the office tools yet")}`);
  }
}

/** Remote platforms whose CLI or credentials are present here, for doctor. */
async function remoteHints(sys: Sys): Promise<string[]> {
  // The office's own auto-detection, when src/remote is registered: the same answer `npx @pvgomes/agent-visualizer` acts on.
  const hints = detectRemotes() ?? [];
  if (!hints.length) {
    if (await sys.which("railway")) hints.push("railway CLI");
    if (sys.env("DAYTONA_API_KEY") || process.env.DAYTONA_API_KEY || (await sys.which("daytona"))) hints.push("Daytona");
    if (await sys.which("boat")) hints.push("boat CLI");
    if (process.env.VERCEL_TOKEN || process.env.VERCEL_OIDC_TOKEN) hints.push("Vercel token");
  }
  if (await sys.exists(join(sys.home, ".ssh", "config"))) hints.push("ssh config");
  return hints;
}

async function doctor(f: Flags, out: Out, version: string): Promise<number> {
  const list = await machines(f, out, version);
  if (!list) return 1;
  let code = 0;
  for (const { sys, launch } of list) {
    out();
    out(`${PAD}${bold("agent-visualizer")} ${dim("·")} doctor${sys.remote ? ` ${dim("on")} ${cyan(sys.where)}` : ""}`);
    out();
    if (!sys.remote) {
      await officeLine(out);
      await doctorRows(version, out);
    }
    out(`${PAD}${dim("Launch")}     ${launch.how === "npx" ? `npx -y ${npxPackage(version)} mcp` : "node + this copy of dist/cli.js"} ${dim(`· ${launch.why}`)}`);
    if (!sys.remote) {
      const hints = await remoteHints(sys);
      out(`${PAD}${dim("Remotes")}    ${hints.length ? hints.join(dim(", ")) + dim(" · install there with --ssh/--daytona/--boat/--railway/--vercel") : dim("none detected")}`);
    } else {
      const node = await sys.which("node");
      out(`${PAD}${dim("Node")}       ${node ? green(node) : red("missing: remote agents can't launch the office tools")}`);
    }
    out();
    const rows = await diagnose(sys);
    const { fixable } = printDoctor(rows, out);
    out();
    if (fixable) {
      const where = sys.remote ? ` --${sys.where.split(":")[0]} ${sys.where.slice(sys.where.indexOf(":") + 1)}` : "";
      out(`${PAD}${yellow(`${fixable} agent${fixable === 1 ? "" : "s"} could use the office tools.`)} Run ${bold(`npx @pvgomes/agent-visualizer install${where}`)}`);
      out();
    } else if (rows.some((r) => r.installed)) {
      out(`${PAD}${green("All set.")}`);
      out();
    }
    if (rows.some((r) => r.mcp === "broken" || r.mcp === "unreadable")) code = 1;
  }
  return code;
}

async function installOrUninstall(cmd: "install" | "uninstall", f: Flags, out: Out, version: string): Promise<number> {
  // Before touching any machine: an npx registration (remote installs, or running from an npx cache) needs this version on npm.
  const npx = f.remotes.length > 0 || chooseLaunch({ remote: false, version }).how === "npx";
  if (cmd === "install" && f.mcp && npx && !(await publishedOrSay(version, f.dryRun, out))) return 1;
  const list = await machines(f, out, version);
  if (!list) return 1;
  if (!list.length) return 1;
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  let code = 0;
  for (const { sys, launch } of list) {
    const opts = {
      agents: f.agents,
      dryRun: f.dryRun,
      yes: f.yes,
      mcp: f.mcp,
      skill: f.skill,
      launch,
      out,
      confirm: interactive ? askYesNo : undefined,
    };
    try {
      const c = cmd === "install" ? await install(sys, opts) : await uninstall(sys, opts);
      code = Math.max(code, c);
    } catch (err) {
      out(`${PAD}${red("✗")} ${sys.where}: ${(err as Error).message}`);
      code = 1;
    }
  }
  return code;
}

/** An npx registration needs this exact version on npm; say so plainly when it isn't (a dry run just warns). */
async function publishedOrSay(version: string, dryRun: boolean, out: Out): Promise<boolean> {
  const spec = npxPackage(version);
  const ok = await npmHasVersion(version);
  if (ok) return true;
  const mark = dryRun ? yellow("!") : red("✗");
  out();
  out(`${PAD}${mark} ${bold(ok === false ? `${spec} isn't on npm` : `Couldn't check npm for ${spec}`)}${ok === false ? "" : dim(" (no network?)")}.`);
  out(`${PAD}  Agents here would launch the office tools with ${bold(`npx -y ${spec}`)}, which only works once that exact`);
  out(`${PAD}  version is published, and for an unpublished name it would run whatever someone else publishes under it.`);
  out(`${PAD}  ${dryRun ? "Showing the plan anyway; nothing is written." : "Nothing was written. Publish it first, or install agent-visualizer on that machine and run its own installer."}`);
  out();
  return dryRun;
}

/** Entry point from src/cli.ts. Resolves the exit code (mcp resolves when stdin closes). */
export async function runSubcommand(cmd: string, argv: string[], version: string): Promise<number> {
  if (cmd === "open") return runOpen(argv, version, (line = "") => void process.stdout.write(`${line}\n`));
  let f: Flags;
  try {
    f = parse(cmd, argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    process.stderr.write(`agent-visualizer ${cmd}: ${err.message}\nRun ${selfCommand()} ${cmd} --help for usage.\n`);
    return 2;
  }
  const out: Out = (line = "") => void process.stdout.write(`${line}\n`);
  if (f.help) {
    (cmd === "mcp" ? (s: string) => process.stderr.write(s) : (s: string) => out(s))(help(cmd));
    return 0;
  }
  switch (cmd) {
    case "mcp":
      await runMcpStdio({ version, agentHint: f.agentHint, verbose: f.verbose });
      return 0;
    case "install":
    case "uninstall":
      if (f.service) {
        if (f.remotes.length) {
          process.stderr.write(`agent-visualizer ${cmd}: --service is for this machine only\n`);
          return 2;
        }
        return serviceCommand(cmd, version, out);
      }
      return installOrUninstall(cmd, f, out, version);
    case "doctor":
      return doctor(f, out, version);
    default:
      return 2;
  }
}
