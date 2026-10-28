/*
 * First-run screens, pre-answered, in sandboxes the office created itself and
 * nowhere else (never an ssh box, never a sandbox the user made). Every write
 * happens only where the file, or the entry in it, is absent, so nothing the
 * agent or the user set is ever changed.
 *
 *   Claude Code  ~/.claude.json  hasCompletedOnboarding, projects[cwd].hasTrustDialogAccepted
 *                (undocumented keys, found in the 2.1.302 binary: UNVERIFIED; the user
 *                clicks through when they don't take)
 *   Codex        ~/.codex/config.toml  [projects."<cwd>"] trust_level = "trusted"
 *   Gemini CLI   ~/.gemini/settings.json  security.auth.selectedType = gemini-api-key,
 *                only when GEMINI_API_KEY is handed over (else its own auth dialog is right)
 *
 * Codex with an OPENAI_API_KEY skips its login screen through a custom
 * provider on the command line (codexKeyArgs), which writes nothing, so that
 * applies to every remote Codex, office sandbox or not.
 */
import type { AgentKind } from "../../shared/events.ts";
import { shQuote } from "../../remote/source.ts";
import type { Arg, Launch } from "../types.ts";

/** A node one-liner that adds missing keys to a JSON file; fed on stdin, reads AO_* from its env. */
const CLAUDE_MERGE = `const fs = require("fs");
const p = process.env.AO_FILE, cwd = process.env.AO_CWD;
let j;
try { j = JSON.parse(fs.readFileSync(p, "utf8")); } catch { process.exit(0); }
if (!j || typeof j !== "object" || Array.isArray(j)) process.exit(0);
let changed = false;
if (j.hasCompletedOnboarding === undefined) { j.hasCompletedOnboarding = true; changed = true; }
if (!j.projects || typeof j.projects !== "object") { j.projects = {}; }
if (!j.projects[cwd] || typeof j.projects[cwd] !== "object") { j.projects[cwd] = {}; }
if (j.projects[cwd].hasTrustDialogAccepted === undefined) { j.projects[cwd].hasTrustDialogAccepted = true; changed = true; }
if (changed) { fs.writeFileSync(p + ".ao-tmp", JSON.stringify(j, null, 2), { mode: 0o600 }); fs.renameSync(p + ".ao-tmp", p); }`;

export function claudeScript(cwd: string): string {
  const fresh = JSON.stringify({ hasCompletedOnboarding: true, projects: { [cwd]: { hasTrustDialogAccepted: true } } });
  return [
    `umask 077; f="$HOME/.claude.json"`,
    `if [ ! -e "$f" ]; then printf '%s\\n' ${shQuote(fresh)} > "$f"`,
    `elif command -v node >/dev/null 2>&1; then AO_FILE="$f" AO_CWD=${shQuote(cwd)} node - <<'AO_JS'\n${CLAUDE_MERGE}\nAO_JS`,
    `fi; :`,
  ].join("\n");
}

function tomlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\u0000-\u001f]/g, "")}"`;
}

export function codexScript(cwd: string): string {
  const header = `[projects.${tomlString(cwd)}]`;
  return [
    `umask 077; d="\${CODEX_HOME:-$HOME/.codex}"; f="$d/config.toml"; mkdir -p "$d"`,
    `if ! grep -qF ${shQuote(header)} "$f" 2>/dev/null; then printf '\\n%s\\ntrust_level = "trusted"\\n' ${shQuote(header)} >> "$f"; fi; :`,
  ].join("\n");
}

export function geminiScript(): string {
  const body = JSON.stringify({ security: { auth: { selectedType: "gemini-api-key" } } });
  return `umask 077; d="$HOME/.gemini"; mkdir -p "$d"; [ -e "$d/settings.json" ] || printf '%s\\n' ${shQuote(body)} > "$d/settings.json"; :`;
}

/** The seeding script for an agent at firstRun time, if any (Gemini waits for attach: it depends on the keys). */
export function firstRunScript(agent: AgentKind, cwd: string): string | undefined {
  if (agent === "claude") return claudeScript(cwd);
  if (agent === "codex") return codexScript(cwd);
  return undefined;
}

/** Codex reads OPENAI_API_KEY without its login screen through a provider of our own (UNVERIFIED on 0.163). */
export const CODEX_PROVIDER_ARGS = [
  "-c",
  "model_provider=agent-visualizer",
  "-c",
  'model_providers.agent-visualizer={name="OpenAI",base_url="https://api.openai.com/v1",env_key="OPENAI_API_KEY",wire_api="responses"}',
];

/** The Launch as run remotely: Codex with an OpenAI key gets the provider flags after its bin. */
export function adjustLaunch(agent: AgentKind, launch: Launch): Launch {
  if (agent !== "codex" || !("OPENAI_API_KEY" in launch.env)) return launch;
  if (launch.argv.some((a) => typeof a === "string" && a.startsWith("model_provider="))) return launch;
  const [bin, ...rest] = launch.argv;
  return { ...launch, argv: [bin as Arg, ...CODEX_PROVIDER_ARGS, ...rest] };
}
