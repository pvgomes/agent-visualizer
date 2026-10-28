/*
 * The installer's view of a machine. Every agent adapter reads and writes
 * through a Sys, so the same plan/apply code installs on this laptop or, via
 * a RemoteTarget, inside a sandbox or ssh box where the only primitive is
 * "run `sh -c script`, get stdout". Remote file contents travel base64 in
 * both directions so no shell, pty or transport can mangle them, and reads
 * are batched into a single round trip by prefetch().
 *
 * Writes are atomic (temp file + rename), keep the existing file's mode, and
 * follow symlinks so a dotfiles-managed ~/.claude.json stays a symlink.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { constants, promises as fsp } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import type { RemoteTarget } from "../shared/events.ts";
import { userHome } from "../mcp/outbox.ts";
import { endTree, spawnLine, type SpawnLine } from "../remote/util.ts";

export interface RunResult {
  code: number;
  out: string;
}

export interface Sys {
  /** "this machine", "ssh:box", "vercel:my-sandbox". */
  readonly where: string;
  readonly remote: boolean;
  readonly home: string;
  readonly platform: string;
  env(name: string): string | undefined;
  read(path: string): Promise<string | null>;
  write(path: string, text: string, mode?: number): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Remove a file; ok if it is already gone. */
  remove(path: string): Promise<void>;
  /** Remove a directory only if it is empty. Resolves whether it is gone. */
  rmdirIfEmpty(path: string): Promise<boolean>;
  /** Remove `file`, then each of `dirs` in order while they are empty (one round trip remotely). */
  prune(file: string, dirs: string[]): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  /** Copy `file` to the first free `<base>`, `<base>-2`, ... and return that path. */
  backup(file: string, base: string): Promise<string>;
  which(bin: string): Promise<string | null>;
  run(argv: string[], timeoutMs?: number): Promise<RunResult>;
  /** Warm the read / which / exists caches in one go (a no-op locally). */
  prefetch(paths: string[], bins: string[], dirs?: string[]): Promise<void>;
  /** Drop a cached read, after something else (an agent's CLI) changed the file. */
  forget(path: string): void;
}

/* ---------------------------------------------------------------- local */

export interface LocalSysOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: string;
}

export function localSys(opts: LocalSysOptions = {}): Sys {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  // Where the agents keep their configs: the profile folder on Windows, whatever HOME says.
  const home = opts.home ?? userHome(env, platform);

  const real = async (p: string) => {
    try {
      return await fsp.realpath(p);
    } catch {
      return p;
    }
  };
  const exists = async (p: string) => {
    try {
      await fsp.access(p);
      return true;
    } catch {
      return false;
    }
  };
  const copy = async (from: string, to: string) => {
    await fsp.copyFile(await real(from), to);
    try {
      await fsp.chmod(to, (await fsp.stat(await real(from))).mode & 0o7777);
    } catch {
      // Best effort.
    }
  };
  const which = async (bin: string): Promise<string | null> => {
    if (isAbsolute(bin)) return (await executable(bin)) ? bin : null;
    const exts = platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean).map((e) => e.toLowerCase()) : [""];
    for (const dir of (env.PATH ?? "").split(delimiter)) {
      // Relative entries (node_modules/.bin, .) would run whatever the current folder holds.
      if (!dir || !isAbsolute(dir)) continue;
      for (const ext of exts) {
        const p = join(dir, bin + ext);
        if (await executable(p)) return p;
      }
    }
    return null;
  };

  return {
    where: "this machine",
    remote: false,
    home,
    platform,
    env: (name) => env[name],
    async read(path) {
      try {
        return await fsp.readFile(path, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ENOTDIR") return null;
        throw err;
      }
    },
    async write(path, text, mode) {
      const target = await real(path);
      // A private file's missing parent folders are created private too (~/.agent-visualizer).
      await fsp.mkdir(dirname(target), { recursive: true, mode: mode === 0o600 ? 0o700 : 0o777 });
      let keepMode = mode;
      try {
        keepMode = (await fsp.stat(target)).mode & 0o7777;
      } catch {
        // New file.
      }
      const tmp = `${target}.agent-visualizer-${process.pid}-${Date.now()}.tmp`;
      try {
        await fsp.writeFile(tmp, text, { mode: keepMode ?? 0o644 });
        if (keepMode !== undefined) await fsp.chmod(tmp, keepMode);
        await fsp.rename(tmp, target);
      } catch (err) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
    },
    exists,
    async remove(path) {
      await fsp.rm(path, { force: true });
    },
    async rmdirIfEmpty(path) {
      try {
        await fsp.rmdir(path);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === "ENOENT";
      }
    },
    async prune(file, dirs) {
      await fsp.rm(file, { force: true });
      for (const d of dirs) {
        try {
          await fsp.rmdir(d);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") break;
        }
      }
    },
    copy,
    async backup(file, base) {
      let name = base;
      for (let k = 2; await exists(name); k++) name = `${base}-${k}`;
      await copy(file, name);
      return name;
    },
    which,
    async run(argv, timeoutMs = 60_000) {
      // Windows agent CLIs are .cmd shims. The CLI is found on PATH here, never in the current folder
      // (where Windows would look first), then started the way src/remote/util.ts starts a .cmd: an
      // npm shim's script with node, anything else through cmd.exe with its arguments quoted.
      let line: SpawnLine = { file: argv[0]!, args: argv.slice(1), cmd: false };
      if (platform === "win32") {
        const exe = await which(argv[0]!);
        if (!exe) return { code: 127, out: `${argv[0]}: not found on PATH` };
        try {
          line = spawnLine(exe, argv.slice(1), platform, env);
        } catch (err) {
          return { code: 127, out: (err as Error).message };
        }
      }
      return new Promise((done) => {
        let out = "";
        let child: ChildProcess;
        try {
          child = spawn(line.file, line.args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: line.cmd });
        } catch (err) {
          return done({ code: 127, out: (err as Error).message });
        }
        const timer = setTimeout(() => {
          out += `\n(timed out after ${Math.round(timeoutMs / 1000)}s)`;
          endTree(child);
        }, timeoutMs);
        child.stdout!.on("data", (c: Buffer) => (out += c.toString("utf8")));
        child.stderr!.on("data", (c: Buffer) => (out += c.toString("utf8")));
        child.on("error", (err) => {
          clearTimeout(timer);
          done({ code: 127, out: out + err.message });
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          done({ code: code ?? 1, out });
        });
      });
    },
    async prefetch() {},
    forget() {},
  };
}

async function executable(p: string): Promise<boolean> {
  try {
    const st = await fsp.stat(p);
    if (!st.isFile()) return false;
    await fsp.access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------- remote */

export const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Agents get installed in odd places; a non-login `sh -c` often misses them. */
const PATH_PRELUDE = [
  'PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:$HOME/.opencode/bin:$HOME/.cargo/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"',
  'for d in "$HOME"/.nvm/versions/node/*/bin /vercel/runtimes/node*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done',
  "export PATH",
].join("; ");

const B64_DECODE = "(base64 -d 2>/dev/null || base64 --decode 2>/dev/null || openssl base64 -d -A)";
const b64Encode = (file: string) => `(base64 < ${file} 2>/dev/null || openssl base64 < ${file}) | tr -d '\\n\\r'`;
/** Keep each exec's script comfortably under ARG_MAX on any transport. */
const CHUNK = 48_000;

const ENV_NAMES = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "AGENT_VISUALIZER_HOME"];

export async function remoteSys(target: RemoteTarget, timeoutMs = 60_000): Promise<Sys> {
  const exec = (script: string) => target.exec(`${PATH_PRELUDE}; ${script}`, { timeoutMs });
  const probe = await exec(`printf '%s\\n' "$HOME" "$(uname -s 2>/dev/null)" ${ENV_NAMES.map((n) => `"\${${n}-}"`).join(" ")}`);
  const lines = probe.replace(/\r/g, "").split("\n");
  const home = lines[0]?.trim();
  if (!home || !home.startsWith("/")) throw new Error(`couldn't read $HOME on ${target.host.id}`);
  const platform = (lines[1] ?? "").trim().toLowerCase() || "linux";
  const envs = new Map<string, string>();
  ENV_NAMES.forEach((n, k) => {
    const v = lines[2 + k]?.trim();
    if (v) envs.set(n, v);
  });

  const files = new Map<string, string | null>();
  const bins = new Map<string, string | null>();
  const there = new Map<string, boolean>();
  const decode = (b64: string) => Buffer.from(b64.trim(), "base64").toString("utf8");

  const readScript = (p: string, k: number) =>
    `if [ -f ${sh(p)} ]; then printf '@@F ${k} OK\\n'; ${b64Encode(sh(p))}; printf '\\n'; else printf '@@F ${k} NO\\n'; fi`;
  const whichScript = (b: string, k: number) => `printf '@@B ${k} %s\\n' "$(command -v ${sh(b)} 2>/dev/null)"`;
  const existsScript = (d: string, k: number) => `if [ -e ${sh(d)} ]; then printf '@@D ${k} 1\\n'; else printf '@@D ${k} 0\\n'; fi`;

  async function prefetch(paths: string[], names: string[], dirs: string[] = []): Promise<void> {
    const ps = paths.filter((p) => !files.has(p));
    const bs = names.filter((b) => !bins.has(b));
    const ds = dirs.filter((d) => !there.has(d));
    if (!ps.length && !bs.length && !ds.length) return;
    const out = (await exec([...ps.map(readScript), ...bs.map(whichScript), ...ds.map(existsScript)].join("; ") || ":")).replace(/\r/g, "");
    const rows = out.split("\n");
    for (let r = 0; r < rows.length; r++) {
      const f = /^@@F (\d+) (OK|NO)$/.exec(rows[r]!);
      if (f) {
        const p = ps[Number(f[1])]!;
        files.set(p, f[2] === "OK" ? decode(rows[++r] ?? "") : null);
        continue;
      }
      const b = /^@@B (\d+) ?(.*)$/.exec(rows[r]!);
      if (b) {
        const found = b[2]!.trim();
        // Only real paths: a shell function, alias or relative PATH hit isn't a program we can trust.
        bins.set(bs[Number(b[1])]!, found.startsWith("/") ? found : null);
        continue;
      }
      const d = /^@@D (\d+) ([01])$/.exec(rows[r]!);
      if (d) there.set(ds[Number(d[1])]!, d[2] === "1");
    }
  }

  return {
    where: target.host.id,
    remote: true,
    home,
    platform,
    env: (name) => envs.get(name),
    async read(path) {
      if (!files.has(path)) await prefetch([path], []);
      return files.get(path) ?? null;
    },
    async write(path, text, mode) {
      const b64 = Buffer.from(text, "utf8").toString("base64");
      const t = `"$t"`;
      const resolve = `t=$(readlink -f ${sh(path)} 2>/dev/null || printf '%s' ${sh(path)}); [ -n "$t" ] || t=${sh(path)}`;
      const tmp = `"$t.agent-visualizer.b64"`;
      const chunks = b64.match(new RegExp(`.{1,${CHUNK}}`, "g")) ?? [""];
      const m = mode !== undefined ? mode.toString(8) : "644";
      const mkdir = `${mode === 0o600 ? "(umask 077; " : "("}mkdir -p "$(dirname "$t")")`;
      const finish =
        `if [ -f ${t} ]; then cp -p ${t} "$t.agent-visualizer.tmp"; else : > "$t.agent-visualizer.tmp" && chmod ${m} "$t.agent-visualizer.tmp"; fi && ` +
        `${B64_DECODE} < ${tmp} > "$t.agent-visualizer.tmp" && mv "$t.agent-visualizer.tmp" ${t} && rm -f ${tmp}`;
      // Small files (all of ours) go in one round trip; big ones in chunks under the script limit.
      for (let k = 0; k < chunks.length; k++) {
        const prep = k === 0 ? `${mkdir} && : > ${tmp} && ` : "";
        const last = k === chunks.length - 1 ? ` && ${finish}` : "";
        await exec(`${resolve}; ${prep}printf '%s' ${sh(chunks[k]!)} >> ${tmp}${last}`);
      }
      files.set(path, text);
      there.set(path, true);
    },
    async exists(path) {
      if (files.get(path) != null) return true;
      if (!there.has(path)) await prefetch([], [], [path]);
      return there.get(path) === true;
    },
    async remove(path) {
      await exec(`rm -f ${sh(path)}`);
      files.set(path, null);
      there.set(path, false);
    },
    async rmdirIfEmpty(path) {
      const out = await exec(`rmdir ${sh(path)} 2>/dev/null; [ -e ${sh(path)} ] && printf kept || printf gone`);
      const gone = out.trim() === "gone";
      there.set(path, !gone);
      return gone;
    },
    async copy(from, to) {
      await exec(`cp -p "$(readlink -f ${sh(from)} 2>/dev/null || printf '%s' ${sh(from)})" ${sh(to)}`);
      there.set(to, true);
    },
    async prune(file, dirs) {
      const list = dirs.map(sh).join(" ");
      await exec(`rm -f ${sh(file)}${dirs.length ? `; for d in ${list}; do [ -e "$d" ] || continue; rmdir "$d" 2>/dev/null || break; done` : ""}; :`);
      files.set(file, null);
      there.set(file, false);
      for (const d of dirs) there.delete(d);
    },
    async backup(file, base) {
      const out = await exec(
        `n=${sh(base)}; k=2; while [ -e "$n" ]; do n=${sh(base)}-$k; k=$((k+1)); done; ` +
          `cp -p "$(readlink -f ${sh(file)} 2>/dev/null || printf '%s' ${sh(file)})" "$n" && printf '%s' "$n"`,
      );
      const name = out.replace(/\r/g, "").trim();
      there.set(name, true);
      return name;
    },
    async which(bin) {
      if (!bins.has(bin)) await prefetch([], [bin]);
      return bins.get(bin) ?? null;
    },
    async run(argv, runTimeout = timeoutMs) {
      const out = await target.exec(`${PATH_PRELUDE}; ${argv.map(sh).join(" ")} </dev/null 2>&1; printf '\\n@@RC %s\\n' "$?"`, { timeoutMs: runTimeout });
      const m = /\n@@RC (\d+)\s*$/.exec(out.replace(/\r/g, ""));
      return { code: m ? Number(m[1]) : 1, out: m ? out.replace(/\r/g, "").slice(0, m.index) : out };
    },
    prefetch,
    forget: (path) => {
      files.delete(path);
      there.delete(path);
    },
  };
}
