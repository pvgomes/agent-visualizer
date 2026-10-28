/*
 * RemoteTarget over the system ssh client, for any box you can already ssh
 * into (an ~/.ssh/config alias, user@host, or ssh://user@host:port). Every
 * exec is `ssh -o BatchMode=yes ... <dest> sh -s` with the script on stdin,
 * so nothing from a script is ever put on a command line and ssh never stops
 * to ask for a password or a host key. Execs share one connection through a
 * ControlMaster socket in $AGENT_VISUALIZER_HOME/ssh (ControlPersist 120s), which
 * turns a poll into a few milliseconds of round trip. A connection error or
 * a timeout tears that master down so the next exec reconnects from scratch;
 * close() asks it to exit. Scripts run under `sh -s`, so they must not read
 * stdin themselves (none of ours do).
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RemoteTarget } from "../shared/events.ts";
import { shQuote } from "./source.ts";
import { RemoteError, homeOf, lastLine, run } from "./util.ts";

export interface SshOptions {
  /** ssh binary (default "ssh" on PATH). */
  bin?: string;
  /** Extra ssh arguments placed before the destination, e.g. ["-i", key]. */
  args?: string[];
  /** Exported at the top of every script (point agents at other folders). */
  env?: Record<string, string>;
  /** ControlMaster socket folder; null turns multiplexing off. */
  controlDir?: string | null;
  /** Default per-exec deadline. */
  timeoutMs?: number;
  /** For AGENT_VISUALIZER_HOME. */
  processEnv?: NodeJS.ProcessEnv;
}

const DEST = /^[A-Za-z0-9_.@%+\[\]:-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Unix socket paths are capped near 104 bytes; %C expands to 40 hex chars. */
const SOCKET_ROOM = 100 - 41;

export interface ParsedDest {
  dest: string;
  port?: number;
  /** The host part, for display. */
  name: string;
}

/** "box", "me@box", "me@10.0.0.2", "ssh://me@box:2222". Throws on anything that could be read as a flag. */
export function parseSshDest(raw: string): ParsedDest {
  let s = raw.trim();
  let port: number | undefined;
  const url = s.match(/^ssh:\/\/([^/?#]+)\/?$/);
  if (url) {
    // [user@]host[:port], host possibly a bracketed IPv6 address.
    const m = url[1]!.match(/^((?:[^@]+@)?)(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/);
    if (!m) throw new RemoteError("failed", `"${raw}" doesn't look like an ssh host`);
    s = m[1]! + m[2]!.replace(/^\[|\]$/g, "");
    if (m[3]) port = Number(m[3]);
  }
  if (!s || s.startsWith("-") || !DEST.test(s) || s.length > 255) throw new RemoteError("failed", `"${raw}" doesn't look like an ssh host`);
  if (port !== undefined && (port < 1 || port > 65535)) throw new RemoteError("failed", `bad port in "${raw}"`);
  const at = s.lastIndexOf("@");
  return { dest: s, port, name: displayHost(at >= 0 ? s.slice(at + 1) : s) };
}

/**
 * What the office shows for a box: an alias as is, a hostname's first label,
 * an IP address with its tail masked, so a screen recording never shows
 * where your servers are.
 */
export function displayHost(h: string): string {
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (v4) return `${v4[1]}.${v4[2]}.•.•`;
  if (h.includes(":")) return h === "::1" ? "localhost" : `${h.split(":").filter(Boolean)[0] ?? "ipv6"}:•••`;
  return h.split(".")[0] || h;
}

export function createSshTarget(raw: string, opts: SshOptions = {}): RemoteTarget & { readonly controlPath?: string } {
  const { dest, port, name } = parseSshDest(raw);
  const bin = opts.bin ?? "ssh";
  const env = opts.processEnv ?? process.env;
  const controlPath = opts.controlDir === null ? undefined : socketPath(opts.controlDir, env);
  const base = [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=5",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=2",
    ...(controlPath ? ["-o", "ControlMaster=auto", "-o", `ControlPath=${controlPath}`, "-o", "ControlPersist=120"] : []),
    ...(port ? ["-p", String(port)] : []),
    ...(opts.args ?? []),
  ];
  const exports = Object.entries(opts.env ?? {})
    .filter(([k]) => ENV_NAME.test(k))
    .map(([k, v]) => `${k}=${shQuote(v)}; export ${k}\n`)
    .join("");

  const resetMaster = () => {
    if (!controlPath) return;
    try {
      const c = spawn(bin, [...base, "-O", "exit", "--", dest], { stdio: "ignore", detached: true, windowsHide: true, env });
      c.on("error", () => {});
      c.unref();
    } catch {
      // ssh missing: nothing to tear down.
    }
  };

  return {
    host: { kind: "ssh", id: `ssh:${port ? `${dest}:${port}` : dest}`, name },
    controlPath,
    async exec(script, o) {
      const timeoutMs = o?.timeoutMs ?? opts.timeoutMs ?? 20_000;
      if (controlPath) ensureDir(controlPath);
      const r = await run(bin, ["-T", ...base, "--", dest, "sh -s"], { input: exports + script, timeoutMs, env });
      if (r.timedOut) {
        resetMaster();
        throw new RemoteError("timeout", `ssh ${name}: no answer in ${Math.round(timeoutMs / 1000)}s`);
      }
      if (r.code === 0) return r.stdout;
      const why = lastLine(r.stderr);
      if (r.code === 255) {
        resetMaster();
        const auth = /permission denied|host key|authentication|identification has changed/i.test(why);
        throw new RemoteError(auth ? "auth" : "unreachable", `ssh ${name}: ${hint(why) || "could not connect"}`);
      }
      throw new RemoteError("failed", `ssh ${name}: exit ${r.code}${why ? `: ${maskAddresses(why).slice(0, 120)}` : ""}`);
    },
    close: resetMaster,
  };
}

/**
 * ssh's own wording is long, and names the address it dialled: a fixed phrase for each
 * failure we know, and anything else with its addresses masked as displayHost does,
 * since this line reaches the banner and the snapshot of an office meant to be recorded.
 */
export function hint(line: string): string {
  if (/identification has changed|host key verification failed/i.test(line)) return "host key changed or unknown (check it, then fix ~/.ssh/known_hosts)";
  if (/permission denied/i.test(line)) return "permission denied (no key that works with BatchMode)";
  if (/connection refused/i.test(line)) return "connection refused";
  if (/timed out/i.test(line)) return "connection timed out";
  if (/could not resolve|name or service not known|nodename nor servname/i.test(line)) return "host name not found";
  if (/no route to host|network is unreachable/i.test(line)) return "no route to host";
  if (/connection (closed|reset)/i.test(line)) return "connection closed by the remote";
  return maskAddresses(line.replace(/^ssh:\s*/, "")).slice(0, 120);
}

/** IPv4, IPv6 and dotted host names in free text -> what displayHost shows for them. */
export function maskAddresses(s: string): string {
  return s
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, (m) => displayHost(m))
    .replace(/\b(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}\b/gi, (m) => (m.includes("::") || m.split(":").length > 2 ? displayHost(m) : m))
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\.[a-z]{2,}\b/gi, (m) => displayHost(m))
    .replace(/\bport \d+\b/gi, "port •");
}

function socketPath(dir: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (process.platform === "win32") return undefined; // Windows' OpenSSH has no ControlMaster
  let d = dir ?? join(env.AGENT_VISUALIZER_HOME || join(homeOf(env), ".agent-visualizer"), "ssh");
  // macOS's per-user temp dir is itself too long for a socket, so fall back to /tmp.
  if (d.length > SOCKET_ROOM) d = `/tmp/agent-visualizer-ssh-${process.getuid?.() ?? "u"}`;
  return join(d, "%C");
}

const made = new Set<string>();
function ensureDir(controlPath: string): void {
  const dir = controlPath.slice(0, -"/%C".length);
  if (made.has(dir)) return;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    made.add(dir);
  } catch {
    // ssh reports the socket problem itself.
  }
}
