/*
 * `agent-visualizer herdr start | open`: what the herdr plugin (herdr-plugin.toml at the repo
 * root) runs. herdr's startup hooks are one-shot, not supervised, so `start` makes sure an office
 * is running (leaving one that already is alone) and returns; `open` does that and then opens
 * the office in the browser, unlocked, like `agent-visualizer open`.
 *
 * Settings live in herdr's per-plugin config folder, $HERDR_PLUGIN_CONFIG_DIR/office.json:
 *   { "herd": true, "name": "Paulo", "port": 4747 }
 * herd (default true) starts the office in herd mode; false, the agents on this machine as always.
 */
import { spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findOffice } from "../mcp/office.ts";
import { runOpen } from "../control/cli.ts";
import { officeHome } from "../mcp/outbox.ts";
import { PAD, bold, dim, green, yellow } from "../install/ui.ts";

type Out = (line?: string) => void;

interface PluginConfig {
  herd: boolean;
  name?: string;
  port?: number;
}

export function readPluginConfig(env: NodeJS.ProcessEnv = process.env): PluginConfig {
  const dir = env.HERDR_PLUGIN_CONFIG_DIR;
  let raw: Record<string, unknown> = {};
  if (dir) {
    try {
      const j = JSON.parse(readFileSync(join(dir, "office.json"), "utf8"));
      if (j && typeof j === "object" && !Array.isArray(j)) raw = j;
    } catch {
      // no config yet: the defaults
    }
  }
  const cfg: PluginConfig = { herd: raw.herd !== false };
  if (typeof raw.name === "string" && raw.name.trim()) cfg.name = raw.name.trim().slice(0, 24);
  if (typeof raw.port === "number" && Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536) cfg.port = raw.port;
  return cfg;
}

/** The office's argv for this config (after node and the CLI script). */
export function officeArgs(cfg: PluginConfig): string[] {
  return [...(cfg.herd ? ["--herd"] : []), "--no-open", "--quiet", ...(cfg.name ? ["--name", cfg.name] : []), ...(cfg.port ? ["--port", String(cfg.port)] : [])];
}

/** An office already running, or a new one started in the background; resolves with its port, or null. */
async function ensureOffice(out: Out, env: NodeJS.ProcessEnv): Promise<number | null> {
  const running = await findOffice(env, 800);
  if (running) {
    out(`${PAD}${green("✓")} The office is running on ${bold(`http://127.0.0.1:${running}`)}`);
    return running;
  }
  const cfg = readPluginConfig(env);
  const logDir = env.HERDR_PLUGIN_STATE_DIR || officeHome();
  mkdirSync(logDir, { recursive: true });
  const log = openSync(join(logDir, "office.log"), "a");
  const cli = fileURLToPath(import.meta.url); // dist/cli.js: this module is bundled into it
  const child = spawn(process.execPath, [cli, ...officeArgs(cfg)], { detached: true, stdio: ["ignore", log, log], env });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const port = await findOffice(env, 400);
    if (port) {
      out(`${PAD}${green("✓")} Started the office${cfg.herd ? " in herd mode" : ""} on ${bold(`http://127.0.0.1:${port}`)} ${dim(`(log: ${join(logDir, "office.log")})`)}`);
      return port;
    }
  }
  out(`${PAD}${yellow("The office didn't come up in 10 s.")} ${dim(`See ${join(logDir, "office.log")}`)}`);
  return null;
}

export async function runHerdr(argv: string[], version: string, out: Out): Promise<number> {
  const [cmd] = argv;
  if (cmd === "start") return (await ensureOffice(out, process.env)) ? 0 : 1;
  if (cmd === "open") {
    if (!(await ensureOffice(out, process.env))) return 1;
    return runOpen([], version, out);
  }
  out(`
${bold("agent-visualizer herdr")}  run by the herdr plugin

  start   Make sure an office is running (herd mode unless office.json says "herd": false)
  open    The same, then open it in the browser, unlocked

Settings: $HERDR_PLUGIN_CONFIG_DIR/office.json, e.g. { "herd": true, "name": "Paulo", "port": 4747 }
`);
  return cmd === "--help" || cmd === "-h" || cmd === undefined ? 0 : 2;
}
