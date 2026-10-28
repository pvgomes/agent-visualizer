/*
 * `--ssh box`, `--vercel <id|all>`, ... -> RemoteTargets for the installer.
 * The transports live in src/remote (one factory per platform); they are
 * plugged in through registerRemoteFactory so this module builds on its own.
 * ssh is simple enough to have a built-in fallback: `ssh -o BatchMode=yes`,
 * so it never stops to ask for a password.
 */
import { spawn } from "node:child_process";
import type { RemoteTarget } from "../shared/events.ts";
import { spawnLine, type SpawnLine } from "../remote/util.ts";

export type RemoteKind = "ssh" | "daytona" | "boat" | "railway" | "vercel";
export const REMOTE_KINDS: RemoteKind[] = ["ssh", "daytona", "boat", "railway", "vercel"];

export interface RemoteSelector {
  kind: RemoteKind;
  /** ssh target, sandbox id or name, or "all". */
  id: string;
}

/** Resolve one selector ("all" means every running one) to targets. */
export type RemoteFactory = (id: string) => Promise<RemoteTarget[]>;

const factories: Partial<Record<RemoteKind, RemoteFactory>> = {};

export function registerRemoteFactory(kind: RemoteKind, f: RemoteFactory): void {
  factories[kind] = f;
}

/** Sandbox platforms with a usable login here ("Vercel Sandbox (sandbox CLI login)"), offline and cheap. */
export type RemoteDetector = () => string[];
let detector: RemoteDetector | undefined;

export function registerRemoteDetector(d: RemoteDetector): void {
  detector = d;
}

export function detectRemotes(): string[] | undefined {
  try {
    return detector?.();
  } catch {
    return undefined;
  }
}

const HOW: Record<Exclude<RemoteKind, "ssh">, string> = {
  daytona: "Daytona (DAYTONA_API_KEY or `daytona login`)",
  boat: "boat (the `boat` CLI)",
  railway: "Railway (`railway login`, then `railway link` the project)",
  vercel: "Vercel Sandbox (`npx sandbox@latest login`)",
};

export async function resolveRemotes(sels: RemoteSelector[]): Promise<RemoteTarget[]> {
  const out: RemoteTarget[] = [];
  for (const s of sels) {
    const f = factories[s.kind] ?? (s.kind === "ssh" ? sshFactory : undefined);
    if (!f) throw new Error(`${HOW[s.kind as Exclude<RemoteKind, "ssh">]} support isn't available in this build`);
    if (s.kind === "ssh" && s.id === "all") throw new Error('--ssh needs a host (user@host or an ~/.ssh/config alias), not "all"');
    const got = await f(s.id);
    if (!got.length) throw new Error(s.id === "all" ? `no running ${s.kind} sandboxes found` : `${s.kind} "${s.id}" not found or not running`);
    out.push(...got);
  }
  return out;
}

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** A plain ssh RemoteTarget; the real one in src/remote takes over once registered. */
export function sshTarget(dest: string, opts: { sshBin?: string; extraArgs?: string[] } = {}): RemoteTarget {
  if (!/^[A-Za-z0-9_.@:%+\[\]-]+$/.test(dest) || dest.startsWith("-")) throw new Error(`"${dest}" doesn't look like an ssh host`);
  const name = dest.includes("@") ? dest.slice(dest.indexOf("@") + 1) : dest;
  return {
    host: { kind: "ssh", id: `ssh:${dest}`, name },
    exec(script, o) {
      const timeoutMs = o?.timeoutMs ?? 60_000;
      return new Promise((resolve, reject) => {
        const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", ...(opts.extraArgs ?? []), dest, "--", `sh -c ${sh(script)}`];
        let line: SpawnLine;
        try {
          // On Windows: ssh.exe found on PATH, never the current folder's.
          line = spawnLine(opts.sshBin ?? "ssh", args);
        } catch (err) {
          return reject(err);
        }
        const child = spawn(line.file, line.args, { stdio: ["ignore", "pipe", "pipe"], windowsVerbatimArguments: line.cmd });
        let out = "";
        let err = "";
        const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
        child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
        child.stderr.on("data", (c: Buffer) => (err += c.toString("utf8")));
        child.on("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0) resolve(out);
          else reject(new Error(`ssh ${dest} exited ${code}: ${err.trim().split("\n").pop() ?? ""}`));
        });
      });
    },
  };
}

const sshFactory: RemoteFactory = async (id) => [sshTarget(id)];
