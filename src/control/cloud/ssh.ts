/*
 * An ssh box as a place: the user's own `ssh`, and the same ControlMaster
 * socket the transcript watcher uses (src/remote/ssh.ts), so a hire costs no
 * extra login once the box is watched.
 *
 *   check   `cd <cwd> && pwd` through the watcher's BatchMode exec, before
 *           anything else: the folder check, the install and the env file all
 *           go that way, so a box that needs a key passphrase or an unknown
 *           host key answered fails here, with a message saying how to fix
 *           it (ssh-add, or one `ssh <host>` in a terminal), not in the panel
 *   keys    a 0600 env file written by a heredoc inside a script on ssh's stdin
 *   TTY     ssh -tt … -- <dest> "sh -c '<line>'" under a local PTY, so window
 *           changes reach the remote
 *   chat    ssh -T … the same line, on plain pipes
 *
 * Nothing is installed or seeded on an ssh box except the agent itself when
 * it's missing (with the user's own npm or the agent's installer), and
 * first-run screens are left to the user.
 */
import { randomBytes } from "node:crypto";
import type { RemoteTarget } from "../../shared/events.ts";
import { createSshTarget, maskAddresses, parseSshDest } from "../../remote/ssh.ts";
import { which } from "../../remote/util.ts";
import type { Place } from "../../shared/control.ts";
import { ControlError, type Launch, type OpenOptions, type PipeProc, type PlacesContext, type Term } from "../types.ts";
import { tgzOf, type TarEntry } from "../tar.ts";
import { cleanupScript, cwdScript, envHeredocScript, envLines, launchLine, parseCwd, shWrap } from "./launch.ts";
import { BasePlace, afterExit, asControlError, failed, helperEnv, sid as newSid, spawnPipe, untarScript } from "./place.ts";

export interface SshDeps {
  /** ssh binary (tests). */
  bin?: string;
}

/** ProviderStatus.hosts for ssh: Host entries of ~/.ssh/config without patterns. */
export function sshConfigHosts(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^host\s+(.+)$/i) ?? line.match(/^host\s*=\s*(.+)$/i);
    if (!m) continue;
    for (const h of m[1]!.split(/\s+/)) {
      if (!h || /[*?!]/.test(h) || out.includes(h)) continue;
      try {
        parseSshDest(h);
        out.push(h);
      } catch {
        // Not something we could dial.
      }
    }
  }
  return out;
}

export async function openSsh(ctx: PlacesContext, place: Place, o: OpenOptions, deps: SshDeps = {}): Promise<SshPlace> {
  let parsed;
  try {
    parsed = parseSshDest(place.target);
  } catch (err) {
    throw new ControlError(400, (err as Error).message);
  }
  const env = ctx.providerEnv();
  const bin = deps.bin ?? which("ssh", env) ?? "ssh";
  const target = createSshTarget(place.target, { bin, processEnv: env, timeoutMs: 20_000 });
  o.progress("starting", `Connecting to ${target.host.name}…`);
  let cwd: string;
  try {
    cwd = parseCwd(await target.exec(cwdScript(place.cwd, !!o.createCwd), { timeoutMs: 20_000 }), place.cwd, `ssh ${target.host.name}`);
  } catch (err) {
    const e = asControlError(err);
    // The office never types a passphrase or accepts a host key for you.
    if (/permission denied|host key/i.test(e.message)) {
      throw new ControlError(e.status, `${e.message.replace(/[.\s]+$/, "")}. The office connects without prompts: add the key to your ssh-agent (ssh-add), or run ssh ${target.host.name} once in a terminal to answer its questions, then hire again`);
    }
    throw e;
  }
  return new SshPlace(ctx, target, { dest: parsed.dest, port: parsed.port, bin }, cwd, o.agent);
}

export class SshPlace extends BasePlace {
  constructor(
    private readonly ctx: PlacesContext,
    target: RemoteTarget & { readonly controlPath?: string },
    private readonly conn: { dest: string; port?: number; bin: string },
    cwd: string,
    agent: OpenOptions["agent"],
  ) {
    super({ host: target.host, cwd, ours: false, target, agent, where: `ssh ${target.host.name}`, log: ctx.log });
  }

  run(script: string, o: { timeoutMs: number }): Promise<string> {
    return this.target.exec(script, o);
  }

  /** The script travels on ssh's stdin (`sh -s`), the values as assignments ahead of it. */
  protected runSecret(script: string, env: Record<string, string>, o: { timeoutMs: number }): Promise<string> {
    return this.target.exec(`${envLines(env)}${script}`, o);
  }

  /** `ssh -T … tar xzf -` with the archive on stdin, on the shared connection. */
  protected async upload(entries: TarEntry[], dir: string, o: { home: string; timeoutMs: number }): Promise<void> {
    const tgz = await tgzOf(entries);
    const p = spawnPipe(this.conn.bin, ["-T", ...this.opts(), "--", this.conn.dest, shWrap(untarScript(dir))], helperEnv(this.ctx.providerEnv(), false), this.ctx.userHome);
    const err: Uint8Array[] = [];
    p.onStderr((c) => {
      if (err.length < 64) err.push(c);
    });
    const done = new Promise<number | null>((resolve) => p.onExit((e) => resolve(e.code)));
    const t = setTimeout(() => p.kill("SIGKILL"), o.timeoutMs);
    t.unref?.();
    for (let i = 0; i < tgz.length; i += 64 << 10) p.write(tgz.subarray(i, i + (64 << 10)));
    p.end();
    const code = await done;
    clearTimeout(t);
    if (code !== 0) throw failed(`ssh ${this.host.name}`, code ?? "?", maskAddresses(Buffer.concat(err).toString("utf8")));
  }

  /** ssh options shared with the watcher's master. */
  private opts(): string[] {
    const cp = (this.target as { controlPath?: string }).controlPath;
    return [
      "-o", "ConnectTimeout=10",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=4",
      ...(cp ? ["-o", "ControlMaster=auto", "-o", `ControlPath=${cp}`, "-o", "ControlPersist=120"] : []),
      ...(this.conn.port ? ["-p", String(this.conn.port)] : []),
    ];
  }

  /** The env file, when the launch has any environment; resolves whether one was written. */
  private async envFile(launch: Launch, id: string): Promise<boolean> {
    if (!Object.keys(launch.env).length) return false;
    // The script (with the values in its heredoc) is ssh's stdin, never an argument.
    await this.target.exec(envHeredocScript(id, launch.env, () => randomBytes(8).toString("hex")), { timeoutMs: 20_000 });
    return true;
  }

  private cleanup(id: string): void {
    this.target.exec(cleanupScript(id), { timeoutMs: 15_000 }).catch(() => {});
  }

  protected async openTerm(launch: Launch, size: { cols: number; rows: number }, id: string, path: string[] | undefined): Promise<Term> {
    const pty = await this.ctx.pty();
    if (!pty) throw new ControlError(503, "Terminal mode needs the PTY library on this machine");
    const withFile = await this.envFile(launch, id);
    const line = launchLine(launch, { sid: id, envFile: withFile, path });
    let term: Term;
    try {
      term = pty.spawn({
        file: this.conn.bin,
        args: ["-tt", ...this.opts(), "--", this.conn.dest, shWrap(line)],
        cwd: this.ctx.userHome,
        env: helperEnv(this.ctx.providerEnv(), false),
        cols: size.cols,
        rows: size.rows,
      });
    } catch (err) {
      if (withFile) this.cleanup(id);
      throw err;
    }
    // If ssh dies before the line ran, the env file would stay: remove it either way.
    return withFile ? afterExit(term, () => this.cleanup(id)) : term;
  }

  async pipe(launch: Launch): Promise<PipeProc> {
    const l = this.prepare(launch);
    const id = newSid();
    const withFile = await this.envFile(l, id);
    const line = launchLine(l, { sid: id, envFile: withFile, path: l.path?.length ? l.path : this.path });
    const p = spawnPipe(this.conn.bin, ["-T", ...this.opts(), "--", this.conn.dest, shWrap(line)], helperEnv(this.ctx.providerEnv(), false), this.ctx.userHome);
    if (withFile) p.onExit(() => this.cleanup(id));
    return p;
  }
}
