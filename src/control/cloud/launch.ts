/*
 * Turning a Launch (A's description of one agent process) into what a remote
 * shell runs, and handing its environment over without putting a value on
 * any command line.
 *
 *   <prefix>[ -f F ] && { . F; rm -f F; }; echo $$ > P; export PATH=…:"$PATH"; cd <cwd> && exec <argv>
 *
 * Literals are single-quoted; {env: N} becomes "$N", so the first prompt
 * (AO_PROMPT) and every key travel as environment, never as words. F is a
 * 0600 file of `NAME='value'; export NAME` lines, written by a separate
 * script just before and deleted by this line before the agent starts; it is
 * used only where the transport has no per-process environment. P records
 * the shell's pid, which `exec` hands to the agent, so a transport that can't
 * signal its command can still stop it (stopScript). There is no umask here:
 * the agent keeps the user's own.
 *
 * Over ssh-like transports the line is wrapped as `sh -c '<line>'`, since the
 * user's login shell may be fish. A leading space keeps a typed line out of
 * history where HISTCONTROL allows, and `exec` means the shell never writes
 * its history at all.
 */
import { shQuote } from "../../remote/source.ts";
import { ControlError, type Arg, type Launch } from "../types.ts";

/** Under the remote $HOME: env files (milliseconds) and pid files. Never anything else. */
export const RUN_DIR = ".agent-visualizer/run";
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SID = /^[A-Za-z0-9_-]{1,64}$/;

function checkSid(sid: string): string {
  if (!SID.test(sid)) throw new ControlError(500, "bad session id for a remote launch");
  return sid;
}

/** A shell expression for a file in RUN_DIR: "$HOME"/'.agent-visualizer/run/<sid>.env'. */
export function runFile(sid: string, ext: "env" | "pid"): string {
  return `"$HOME"/${shQuote(`${RUN_DIR}/${checkSid(sid)}.${ext}`)}`;
}

/** "~" and "~/x" are under that machine's home; anything else must be absolute. */
export function renderPath(p: string): string {
  if (p === "~") return `"$HOME"`;
  if (p.startsWith("~/")) return p.length > 2 ? `"$HOME"/${shQuote(p.slice(2))}` : `"$HOME"`;
  if (!p.startsWith("/") || /[\0\n\r]/.test(p)) throw new ControlError(400, "a remote folder must be absolute or start with ~/");
  return shQuote(p);
}

export function renderArg(a: Arg): string {
  if (typeof a === "string") return shQuote(a);
  if (!a || typeof a.env !== "string" || !ENV_NAME.test(a.env)) throw new ControlError(500, "bad env reference in a launch");
  return `"$${a.env}"`;
}

export function renderArgv(argv: Arg[]): string {
  if (!argv.length) throw new ControlError(500, "empty launch");
  return argv.map(renderArg).join(" ");
}

/** The env-file text: `NAME='value'; export NAME` per line. Values may hold anything but NUL. */
export function envLines(env: Record<string, string>): string {
  let out = "";
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_NAME.test(k)) throw new ControlError(400, `bad environment name ${JSON.stringify(k.slice(0, 40))}`);
    out += `${k}=${shQuote(String(v))}; export ${k}\n`;
  }
  return out;
}

export interface LineOptions {
  /** Session id: names the env file and the pid file. */
  sid: string;
  /** Source and delete the env file first (the transport has no per-process env). */
  envFile?: boolean;
  /** Record the shell's pid (which becomes the agent's) for stopScript. */
  pidFile?: boolean;
  /** Extra PATH entries when the Launch names none (where ensureAgent found the agent). */
  path?: string[];
  /** Typed into an interactive login shell (Daytona's PTY): clear the echoed line off the screen first. */
  typed?: boolean;
}

/** The POSIX sh line that starts the agent. No secret is ever in it. */
export function launchLine(launch: Launch, o: LineOptions): string {
  const parts: string[] = [];
  if (o.typed) parts.push(`printf '\\033[H\\033[2J\\033[3J'`);
  if (o.envFile) {
    const f = runFile(o.sid, "env");
    parts.push(`if [ -f ${f} ]; then . ${f}; rm -f ${f}; else echo 'agent-visualizer: the environment file is missing' >&2; exit 97; fi`);
  }
  if (o.pidFile) parts.push(`mkdir -p "$HOME"/${shQuote(RUN_DIR)} && echo $$ > ${runFile(o.sid, "pid")}`);
  const path = launch.path?.length ? launch.path : o.path ?? [];
  if (path.length) parts.push(`PATH=${path.map(renderPath).join(":")}:"$PATH"; export PATH`);
  parts.push(`cd ${renderPath(launch.cwd)} && exec ${renderArgv(launch.argv)}`);
  return " " + parts.join("; ");
}

/** For ssh-like transports, whose remote end joins words and hands them to the login shell. */
export function shWrap(line: string): string {
  return `sh -c ${shQuote(line)}`;
}

/** Write the env file from the variable AO_ENV of this one command (Daytona execute envs, Vercel cmd env, Railway exec env). */
export function envFromVarScript(sid: string, varName = "AO_ENV"): string {
  if (!ENV_NAME.test(varName)) throw new ControlError(500, "bad variable name");
  return `umask 077; mkdir -p "$HOME"/${shQuote(RUN_DIR)} && printf '%s' "$${varName}" > ${runFile(sid, "env")}`;
}

/** Write the env file from this script's own stdin (a CLI transport that forwards stdin). */
export function envFromStdinScript(sid: string): string {
  return `umask 077; mkdir -p "$HOME"/${shQuote(RUN_DIR)} && cat > ${runFile(sid, "env")}`;
}

/**
 * The env file as a heredoc inside a script that itself travels on stdin (ssh's `sh -s`).
 * The delimiter is random and checked against the content.
 */
export function envHeredocScript(sid: string, env: Record<string, string>, rand: () => string): string {
  const body = envLines(env);
  let tag = "";
  for (let i = 0; i < 5 && (!tag || body.split("\n").includes(tag)); i++) tag = `AO_EOF_${rand()}`;
  if (!tag || body.split("\n").includes(tag)) throw new ControlError(500, "could not pick a heredoc delimiter");
  return `umask 077; mkdir -p "$HOME"/${shQuote(RUN_DIR)} && cat > ${runFile(sid, "env")} <<'${tag}'\n${body}${tag}\n`;
}

/** Delete a leftover env file (an attach that failed between write and start). */
export function cleanupScript(sid: string): string {
  return `rm -f ${runFile(sid, "env")} ${runFile(sid, "pid")}`;
}

/** Signal the agent a pidFile line started, then forget the pid. */
export function stopScript(sid: string, signal: "HUP" | "TERM" | "KILL" = "HUP"): string {
  const p = runFile(sid, "pid");
  return `if [ -f ${p} ]; then pid=$(cat ${p}); case "$pid" in ''|*[!0-9]*) ;; *) kill -${signal} "$pid" 2>/dev/null ;; esac; fi; ${signal === "HUP" ? "" : `rm -f ${p}; `}:`;
}

/** Resolve (and for office sandboxes, create) the working folder; prints it, or @@nodir. */
export function cwdScript(cwd: string | undefined, create: boolean): string {
  const d = cwd ? renderPath(cwd) : `"$HOME"`;
  return `d=${d}; ${create ? `[ -d "$d" ] || mkdir -p "$d" 2>/dev/null; ` : ""}if cd "$d" 2>/dev/null; then pwd -P; else echo @@nodir; fi`;
}

export function parseCwd(out: string, asked: string | undefined, where: string): string {
  const line = out.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  if (!line || line === "@@nodir" || !line.startsWith("/")) throw new ControlError(400, `No folder ${asked ?? "~"} on ${where}`);
  return line;
}
