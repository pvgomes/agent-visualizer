/*
 * Is the agent there, and if not, put it there: one probe exec, and at most
 * one install exec, on a sandbox or ssh box.
 *
 * The probe looks for the agent's bins on PATH plus the places installers
 * use ($HOME/.local/bin, the npm prefix Vercel's image sets, ~/.npm-global),
 * and reports node and npm. Installing follows AGENT_FACTS: npm agents need
 * Node >= nodeMin (`npm i -g`, retried under --prefix ~/.local when the
 * global prefix isn't writable); Claude Code takes its own installer when
 * Node is too old; Droid and Cursor always use their scripts. Never
 * `npm i -g cursor-agent`: that package isn't Cursor's.
 */
import { BRAND, type AgentKind } from "../../shared/events.ts";
import { shQuote } from "../../remote/source.ts";
import { AGENT_FACTS, ControlError, type OpenOptions } from "../types.ts";

export const INSTALL_TIMEOUT_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 30_000;
const EXTRA_PATH = `"$HOME/.local/bin:$HOME/.global/npm/bin:$HOME/.npm-global/bin:$HOME/.bun/bin"`;

export interface Probe {
  bin?: string;
  binPath?: string;
  version?: string;
  /** Node major, when node runs. */
  node?: number;
  nodeRaw?: string;
  npm: boolean;
  curl: boolean;
  home?: string;
}

/** Runs a script on the remote with a deadline (RemotePlace's long-running exec). */
export type Run = (script: string, o: { timeoutMs: number }) => Promise<string>;

export function probeScript(agent: AgentKind): string {
  const bins = AGENT_FACTS[agent].bins.map(shQuote).join(" ");
  // Cursor's installer links both `agent` and `cursor-agent`; a bare `agent` counts only if it really is Cursor's.
  const cursorCheck = agent === "cursor" ? `[ "$b" = agent ] && { r=$(readlink -f "$p" 2>/dev/null || echo "$p"); case "$r" in *cursor*) ;; *) continue ;; esac; }; ` : "";
  return [
    `PATH=${EXTRA_PATH}:"$PATH"; export PATH`,
    `if command -v timeout >/dev/null 2>&1; then T="timeout 15"; else T=; fi`,
    `for b in ${bins}; do p=$(command -v "$b" 2>/dev/null) || continue; ${cursorCheck}echo "bin=$b"; echo "binpath=$p"; v=$($T "$p" --version </dev/null 2>/dev/null | head -n 1); echo "version=$v"; break; done`,
    `v=$(node -v 2>/dev/null) && echo "node=$v"`,
    `command -v npm >/dev/null 2>&1 && echo npm=1`,
    `command -v curl >/dev/null 2>&1 && echo curl=1`,
    `echo "home=$HOME"`,
    `:`,
  ].join("\n");
}

export function parseProbe(out: string): Probe {
  const kv = new Map<string, string>();
  for (const line of out.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0 && !kv.has(line.slice(0, i))) kv.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const nodeRaw = kv.get("node");
  const major = nodeRaw?.match(/^v?(\d+)\./)?.[1];
  const ver = kv.get("version")?.match(/\d+\.\d+\.\d+[\w.-]*/)?.[0];
  return {
    bin: kv.get("bin") || undefined,
    binPath: kv.get("binpath") || undefined,
    version: ver,
    node: major ? Number(major) : undefined,
    nodeRaw,
    npm: kv.get("npm") === "1",
    curl: kv.get("curl") === "1",
    home: kv.get("home") || undefined,
  };
}

export interface InstallPlan {
  /** What the status pill says: "npm i -g @google/gemini-cli". */
  how: string;
  script: string;
}

/** How to install `agent` there, or a ControlError(409) saying why it can't be. */
export function installPlan(agent: AgentKind, p: Probe): InstallPlan {
  const f = AGENT_FACTS[agent];
  const name = BRAND[agent].name;
  const nodeOk = p.node !== undefined && p.npm && (!f.nodeMin || p.node >= f.nodeMin);
  const head = [`PATH=${EXTRA_PATH}:"$PATH"; export PATH`, `t=$(mktemp 2>/dev/null) || t=/tmp/.agent-visualizer-install.$$`];
  const viaScript = (url: string, sh: "sh" | "bash"): InstallPlan => ({
    how: `curl ${url.replace(/^https:\/\//, "")} | ${sh}`,
    script: [
      ...head,
      `curl -fsSL ${shQuote(url)} -o "$t" || { rm -f "$t"; echo "could not download ${url.replace(/^https:\/\//, "")}" >&2; exit 1; }`,
      // bash may be missing on a slim image; the scripts run under sh too.
      `if command -v ${sh} >/dev/null 2>&1; then ${sh} "$t"; else sh "$t"; fi >"$t.log" 2>&1 </dev/null; rc=$?`,
      `[ "$rc" -eq 0 ] || tail -n 5 "$t.log" >&2; rm -f "$t" "$t.log"; exit "$rc"`,
    ].join("\n"),
  });
  const viaNpm = (pkg: string): InstallPlan => ({
    how: `npm i -g ${pkg}`,
    script: [
      ...head,
      `if npm i -g ${shQuote(pkg)} >"$t" 2>&1 </dev/null; then rc=0; else mkdir -p "$HOME/.local" && npm i -g --prefix "$HOME/.local" ${shQuote(pkg)} >"$t" 2>&1 </dev/null; rc=$?; fi`,
      `[ "$rc" -eq 0 ] || tail -n 5 "$t" >&2; rm -f "$t"; exit "$rc"`,
    ].join("\n"),
  });

  if (agent === "droid" || agent === "cursor") {
    if (!f.script) throw new ControlError(500, `no installer for ${name}`);
    if (!p.curl) throw new ControlError(409, `${name} needs curl in this sandbox to install`);
    return viaScript(f.script, agent === "droid" ? "sh" : "bash");
  }
  if (f.npm && nodeOk) return viaNpm(f.npm);
  if (agent === "claude" && f.script && p.curl) return viaScript(f.script, "bash");
  if (!f.npm) throw new ControlError(409, `${name} can't be installed here`);
  const has = p.node === undefined ? "none" : String(p.node);
  if (p.node !== undefined && !p.npm) throw new ControlError(409, `${name} needs npm in this sandbox (it has Node ${has} without npm)`);
  throw new ControlError(409, `${name} needs Node ${f.nodeMin ?? 18}+ in this sandbox (it has ${has})`);
}

export interface Ensured {
  bin: string;
  version?: string;
  path?: string[];
}

function ensured(p: Probe): Ensured | undefined {
  if (!p.bin || !p.binPath) return undefined;
  const dir = p.binPath.slice(0, p.binPath.lastIndexOf("/"));
  return { bin: p.bin, ...(p.version ? { version: p.version } : {}), ...(dir.startsWith("/") ? { path: [dir] } : {}) };
}

/** Probe, install when missing, probe again. */
export async function ensureAgent(agent: AgentKind, run: Run, progress: OpenOptions["progress"], where: string): Promise<Ensured> {
  const name = BRAND[agent].name;
  const first = parseProbe(await run(probeScript(agent), { timeoutMs: PROBE_TIMEOUT_MS }));
  const have = ensured(first);
  if (have) return have;
  const plan = installPlan(agent, first);
  progress("installing", `Installing ${name} (${plan.how})…`);
  try {
    await run(plan.script, { timeoutMs: INSTALL_TIMEOUT_MS });
  } catch (err) {
    const why = (err as Error).message;
    // Daytona's Tier 1/2 egress allowlist leaves out factory.ai and commandcode.ai (UNVERIFIED in practice).
    const egress = where.startsWith("Daytona") && (agent === "droid" || agent === "commandcode") ? " (Daytona's lower tiers block its download site)" : "";
    throw new ControlError(502, `Installing ${name} failed on ${where}${egress}: ${why}`.slice(0, 300));
  }
  const after = parseProbe(await run(probeScript(agent), { timeoutMs: PROBE_TIMEOUT_MS }));
  const got = ensured(after);
  if (!got) throw new ControlError(502, `Installed ${name} on ${where}, but it isn't on PATH there`);
  return got;
}
