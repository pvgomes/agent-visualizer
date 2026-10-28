/*
 * Environments. A hired agent gets the office's own environment minus the
 * markers a parent Claude Code or Codex sets (NESTED_ENV): an inherited
 * CLAUDE_CODE_CHILD_SESSION turns transcript saving off, so the worker would
 * never link. The background service starts with launchd's or systemd's bare
 * environment, so it first adopts what a terminal would have: a login shell's
 * environment, captured once at start and held in memory only.
 *
 * The capture runs `$SHELL -l -i -c 'exec "$AO_NODE" -e "<js>"'`: the user's
 * rc files run as in a terminal, then node prints JSON between two RS
 * characters, so a chatty rc file can't confuse it. The command is valid in
 * sh, bash, zsh and fish (no quotes, `$`, `!` or backslashes inside the JS).
 * stdin is /dev/null, it has its own process group, and the answer is taken
 * at the closing RS. The group is SIGKILLed once there's an answer or after
 * 5 s, so nothing the rc files started outlives the probe. Key import asks
 * for allowlisted names only, never the whole thing.
 */
import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import { NESTED_ENV } from "./types.ts";

export const LOGIN_TIMEOUT_MS = 5_000;
/** Never adopted from the login shell: per-terminal state and the nested-agent markers. */
export const LOGIN_ENV_DROP: readonly string[] = [...NESTED_ENV, "PWD", "OLDPWD", "SHLVL", "_", "TERM_SESSION_ID", "AO_NODE", "AO_NAMES"];

const RS = "String.fromCharCode(30)";
const JS_ALL = `process.stdout.write(${RS}+JSON.stringify(process.env)+${RS})`;
const JS_SOME =
  `const e=process.env,o={};for(const k of String(e.AO_NAMES).split(String.fromCharCode(44)))if(e[k])o[k]=e[k];` +
  `process.stdout.write(${RS}+JSON.stringify(o)+${RS})`;

/** The user's login shell: $SHELL, the account's shell, else the platform's default. */
export function loginShell(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  const s = env.SHELL?.trim();
  if (s && s.startsWith("/")) return s;
  try {
    const u = userInfo().shell;
    if (u && u.startsWith("/")) return u;
  } catch {
    // No passwd entry.
  }
  return platform === "darwin" ? "/bin/zsh" : "/bin/sh";
}

export interface ShellOptions {
  shell?: string;
  /** The environment the shell starts from. Default process.env. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** The node that prints the result. Default process.execPath. */
  node?: string;
}

async function runLogin(js: string, extra: Record<string, string>, o: ShellOptions): Promise<Record<string, string> | null> {
  const shell = o.shell ?? loginShell(o.env);
  const env: NodeJS.ProcessEnv = { ...(o.env ?? process.env), ...extra, AO_NODE: o.node ?? process.execPath };
  return new Promise((done) => {
    let child;
    try {
      child = spawn(shell, ["-l", "-i", "-c", `exec "$AO_NODE" -e "${js}"`], {
        env,
        stdio: ["ignore", "pipe", "ignore"],
        detached: true,
        cwd: env.HOME || undefined,
      });
    } catch {
      return done(null);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (v: Record<string, string> | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        // The whole group, every time: the shell is done with it, and a job its rc files started
        // there (one that hangs, or one that would have ended with the terminal) must not outlive it.
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      // A daemon the rc files started in a session of its own may still hold the other end.
      child.stdout!.destroy();
      done(v);
    };
    const timer = setTimeout(() => finish(null), o.timeoutMs ?? LOGIN_TIMEOUT_MS);
    child.on("error", () => finish(null));
    child.stdout!.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 4 << 20) return finish(null);
      chunks.push(c);
      // Done at the closing marker, not when stdout closes: anything the rc files left running
      // holds stdout open, which would otherwise throw a complete answer away at the timeout.
      if (c.includes(0x1e)) {
        const v = parseMarked(Buffer.concat(chunks).toString("utf8"));
        if (v) finish(v);
      }
    });
    child.on("close", () => finish(parseMarked(Buffer.concat(chunks).toString("utf8"))));
  });
}

/** The JSON object between the first two RS characters, strings only. */
export function parseMarked(out: string): Record<string, string> | null {
  const a = out.indexOf("\x1e");
  const b = a < 0 ? -1 : out.indexOf("\x1e", a + 1);
  if (b < 0) return null;
  try {
    const j = JSON.parse(out.slice(a + 1, b));
    if (!j || typeof j !== "object" || Array.isArray(j)) return null;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(j)) if (typeof v === "string") env[k] = v;
    return env;
  } catch {
    return null;
  }
}

/** The whole environment of a fresh login shell, or null when it can't be read in time. For the service only. */
export function loginShellEnv(o: ShellOptions = {}): Promise<Record<string, string> | null> {
  return runLogin(JS_ALL, {}, o);
}

/** Only these names from a fresh login shell (the values never pass through anything but this process). */
export function loginShellVars(names: readonly string[], o: ShellOptions = {}): Promise<Record<string, string> | null> {
  const list = names.filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n));
  return runLogin(JS_SOME, { AO_NAMES: list.join(",") }, o);
}

/**
 * Service start: merge a login shell's environment into process.env, so
 * transcript roots (CLAUDE_CONFIG_DIR, CODEX_HOME), provider logins and
 * agents see what a terminal would. Returns false (PATH stays as the unit
 * set it) when the shell can't be read.
 */
export async function adoptLoginEnv(o: ShellOptions = {}): Promise<boolean> {
  const env = await loginShellEnv(o);
  if (!env) return false;
  const drop = new Set(LOGIN_ENV_DROP);
  for (const [k, v] of Object.entries(env)) {
    if (drop.has(k) || k === "AGENT_VISUALIZER_SERVICE" || k === "AGENT_VISUALIZER_HOME") continue;
    process.env[k] = v;
  }
  for (const k of NESTED_ENV) delete process.env[k];
  return true;
}

/** Environment for an agent started on this machine: a fresh copy of the office's own, minus NESTED_ENV and the service marker. */
export function agentEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const drop = new Set<string>([...NESTED_ENV, "AGENT_VISUALIZER_SERVICE"]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (typeof v === "string" && !drop.has(k)) out[k] = v;
  return out;
}
