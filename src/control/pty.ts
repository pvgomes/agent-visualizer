/*
 * Pseudo-terminals for hired agents. @lydell/node-pty (an optionalDependency,
 * prebuilt per platform, no install script) when it loads; otherwise a small
 * python3 bridge (pty.fork + a select loop, resize lines on fd 3); otherwise
 * none, and the office offers chat mode only. BSD `script` is never used: it
 * can't run on Node's pipes, which are sockets on macOS.
 *
 * Every PTY child is a session leader, so its process group is the job:
 * SIGKILL goes to -pid, which reaches what the agent started too.
 */
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { basename } from "node:path";
import { which } from "../remote/util.ts";
import { Emitter, Latch } from "./emitter.ts";
import { ControlError, type PtyBackend, type PtySpawn, type Term, type TermExit } from "./types.ts";

export type PtyKind = PtyBackend["kind"];

const SIGNAL_NAMES = new Map<number, string>(Object.entries(constants.signals).map(([name, n]) => [n as number, name]));

/** 128 + n for a death by signal n, like a shell reports it. */
export function exitOf(code: number | null | undefined, signal: number | string | null | undefined): TermExit {
  const n = typeof signal === "string" ? (constants.signals as Record<string, number>)[signal] : signal;
  if (n) return { code: 128 + n, signal: SIGNAL_NAMES.get(n) ?? String(n) };
  return { code: typeof code === "number" ? code : null };
}

export function clampSize(cols: number, rows: number): { cols: number; rows: number } {
  const c = Number.isFinite(cols) ? Math.round(cols) : 120;
  const r = Number.isFinite(rows) ? Math.round(rows) : 32;
  return { cols: Math.min(500, Math.max(10, c)), rows: Math.min(200, Math.max(4, r)) };
}

/* ------------------------------------------------------------- node-pty */

interface NodePtyModule {
  spawn(file: string, args: string[], o: Record<string, unknown>): NodePty;
}
interface NodePty {
  readonly pid: number;
  onData(fn: (d: string | Uint8Array) => void): { dispose(): void };
  onExit(fn: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(d: string | Buffer): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

/** Wrap a loaded node-pty module (tests pass their own). */
export function nodePtyBackend(mod: NodePtyModule): PtyBackend {
  return {
    kind: "node-pty",
    spawn(spec: PtySpawn): Term {
      const { cols, rows } = clampSize(spec.cols, spec.rows);
      let p: NodePty;
      try {
        // encoding: null hands out Buffers (verified on 1.2.0-beta.15), so a UTF-8 sequence split across reads stays intact.
        p = mod.spawn(spec.file, spec.args, { name: "xterm-256color", cols, rows, cwd: spec.cwd, env: spec.env, encoding: null });
      } catch {
        throw new ControlError(500, `Could not start ${basename(spec.file)} in a terminal.`);
      }
      const data = new Emitter<Uint8Array>();
      const exit = new Latch<TermExit>();
      p.onData((d) => data.emit(typeof d === "string" ? Buffer.from(d, "utf8") : d));
      p.onExit((e) => exit.fire(exitOf(e.exitCode, e.signal)));
      return {
        pid: p.pid,
        write: (d) => {
          if (!exit.fired) p.write(typeof d === "string" ? d : Buffer.from(d));
        },
        resize: (c, r) => {
          if (exit.fired) return;
          const s = clampSize(c, r);
          try {
            p.resize(s.cols, s.rows);
          } catch {
            // The child is going away.
          }
        },
        onData: (fn) => data.on(fn),
        onExit: (fn) => exit.on(fn),
        kill: (sig = "SIGHUP") => {
          if (exit.fired) return;
          if (sig === "SIGKILL") killGroup(p.pid);
          try {
            p.kill(sig);
          } catch {
            // Already gone.
          }
        },
      };
    },
  };
}

function killGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // No such group (already gone, or not a session leader).
  }
}

/* -------------------------------------------------------- python bridge */

/*
 * argv: rows cols file args...  stdin -> pty, pty -> stdout, fd 3 "rows cols\n".
 * SIGHUP/SIGTERM go to the child's group, SIGUSR2 means SIGKILL it, SIGINT is
 * ignored (the office's own Ctrl+C is the office's business). Exits 128+n
 * when the child died of signal n, and hangs the child up when the office
 * goes away (stdin closes or stdout breaks).
 */
export const BRIDGE = `
import os, sys, pty, select, signal, struct, fcntl, termios, errno
def setsize(fd, rows, cols):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    except OSError:
        pass
rows, cols, argv = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3:]
pid, master = pty.fork()
if pid == 0:
    try:
        os.execvp(argv[0], argv)
    except OSError as e:
        os.write(2, ('agent-visualizer: cannot run %s: %s\\r\\n' % (argv[0], e.strerror)).encode())
    os._exit(127)
setsize(master, rows, cols)
def group(sig):
    try:
        os.killpg(pid, sig)
    except OSError:
        pass
def fwd(sig, _f):
    group(signal.SIGKILL if sig == signal.SIGUSR2 else sig)
for s in (signal.SIGHUP, signal.SIGTERM, signal.SIGUSR2):
    signal.signal(s, fwd)
signal.signal(signal.SIGINT, signal.SIG_IGN)
signal.signal(signal.SIGQUIT, signal.SIG_IGN)
def out(data):
    while data:
        n = os.write(1, data)
        data = data[n:]
ctl = 3
try:
    os.fstat(ctl)
except OSError:
    ctl = None
fds = [master, 0] + ([ctl] if ctl is not None else [])
buf = b''
status = None
gone = False
while True:
    try:
        r, _, _ = select.select(fds, [], [], 0.25)
    except InterruptedError:
        continue
    if master in r:
        try:
            data = os.read(master, 65536)
        except OSError:
            data = b''
        if not data:
            break
        try:
            out(data)
        except OSError:
            gone = True
            break
    if 0 in r:
        data = os.read(0, 65536)
        if data:
            try:
                os.write(master, data)
            except OSError:
                pass
        else:
            gone = True
            break
    if ctl is not None and ctl in r:
        data = os.read(ctl, 4096)
        if not data:
            fds.remove(ctl)
            ctl = None
        else:
            buf += data
            while b'\\n' in buf:
                line, buf = buf.split(b'\\n', 1)
                try:
                    rr, cc = map(int, line.split())
                    setsize(master, rr, cc)
                except ValueError:
                    pass
    p, st = os.waitpid(pid, os.WNOHANG)
    if p:
        status = st
        fl = fcntl.fcntl(master, fcntl.F_GETFL)
        fcntl.fcntl(master, fcntl.F_SETFL, fl | os.O_NONBLOCK)
        try:
            while True:
                data = os.read(master, 65536)
                if not data:
                    break
                out(data)
        except OSError:
            pass
        break
if gone:
    group(signal.SIGHUP)
if status is None:
    _, status = os.waitpid(pid, 0)
if os.WIFSIGNALED(status):
    sys.exit(128 + os.WTERMSIG(status))
sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1)
`;

export function pythonBackend(python: string): PtyBackend {
  return {
    kind: "python",
    spawn(spec: PtySpawn): Term {
      const { cols, rows } = clampSize(spec.cols, spec.rows);
      const child = spawn(python, ["-I", "-c", BRIDGE, String(rows), String(cols), spec.file, ...spec.args], {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ["pipe", "pipe", "pipe", "pipe"],
      });
      const data = new Emitter<Uint8Array>();
      const exit = new Latch<TermExit>();
      child.stdout!.on("data", (d: Buffer) => data.emit(d));
      child.stderr!.on("data", () => {});
      const ctl = child.stdio[3] as import("node:stream").Writable | null;
      child.stdin!.on("error", () => {});
      ctl?.on("error", () => {});
      child.on("error", () => exit.fire({ code: 127 }));
      // "exit" can come before the last of stdout is read: hold it until stdout ends, so the
      // agent's final words (or the bridge's "cannot run") reach the screen. A grandchild that
      // keeps the pipe open can't hold the exit for more than half a second.
      let ended = false;
      let status: TermExit | undefined;
      child.stdout!.on("close", () => {
        ended = true;
        if (status) exit.fire(status);
      });
      child.on("exit", (code, signal) => {
        status = exitOf(code, signal);
        if (ended) exit.fire(status);
        else setTimeout(() => exit.fire(status!), 500).unref();
      });
      return {
        pid: child.pid,
        write: (d) => {
          if (!exit.fired) child.stdin!.write(typeof d === "string" ? d : Buffer.from(d));
        },
        resize: (c, r) => {
          if (exit.fired || !ctl) return;
          const s = clampSize(c, r);
          ctl.write(`${s.rows} ${s.cols}\n`);
        },
        onData: (fn) => data.on(fn),
        onExit: (fn) => exit.on(fn),
        kill: (sig = "SIGHUP") => {
          if (exit.fired || !child.pid) return;
          try {
            if (sig === "SIGKILL") {
              // The bridge SIGKILLs the agent's group, then goes itself.
              child.kill("SIGUSR2");
              setTimeout(() => !exit.fired && child.kill("SIGKILL"), 300).unref();
            } else child.kill(sig);
          } catch {
            // Already gone.
          }
        },
      };
    },
  };
}

/* --------------------------------------------------------------- loader */

export interface LoadPtyOptions {
  env?: NodeJS.ProcessEnv;
  /** "node-pty" | "python" | "none": force one (AGENT_VISUALIZER_PTY does the same). */
  force?: string;
  /** Import the node-pty module; default `import("@lydell/node-pty")`. */
  importPty?: () => Promise<unknown>;
  /** Check that this python3 can run the bridge; default runs it. */
  checkPython?: (python: string, env: NodeJS.ProcessEnv) => Promise<boolean>;
  platform?: NodeJS.Platform;
}

let cached: Promise<PtyBackend | null> | undefined;

/** The PTY backend for this office, probed once. */
export function loadPty(o: LoadPtyOptions = {}): Promise<PtyBackend | null> {
  const custom = o.force !== undefined || o.importPty !== undefined || o.checkPython !== undefined || o.env !== undefined || o.platform !== undefined;
  if (custom) return probe(o);
  return (cached ??= probe(o));
}

async function probe(o: LoadPtyOptions): Promise<PtyBackend | null> {
  const env = o.env ?? process.env;
  const force = (o.force ?? env.AGENT_VISUALIZER_PTY ?? "").trim().toLowerCase();
  if (force === "none") return null;
  if (force !== "python") {
    try {
      const m: any = await (o.importPty ?? (() => import("@lydell/node-pty")))();
      const mod = m?.default?.spawn ? m.default : m;
      if (typeof mod?.spawn === "function") return nodePtyBackend(mod);
    } catch {
      // Not installed (--omit=optional), or no prebuilt binary for this platform.
    }
    if (force === "node-pty") return null;
  }
  const python = await findPython(env, o.platform ?? process.platform);
  if (!python) return null;
  const ok = await (o.checkPython ?? checkPython)(python, env);
  return ok ? pythonBackend(python) : null;
}

/**
 * A python3 that is really there. On macOS /usr/bin/python3 is the developer
 * tools shim: without the Command Line Tools, calling it pops an install
 * dialog, so it counts only when `xcode-select -p` says the tools exist.
 */
async function findPython(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<string | undefined> {
  if (platform === "win32") return undefined;
  const found = which("python3", env);
  if (!found) return undefined;
  if (platform !== "darwin" || !found.startsWith("/usr/bin/")) return found;
  const code = await exitCodeOf("xcode-select", ["-p"], env, 4000);
  return code === 0 ? found : undefined;
}

async function checkPython(python: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return (await exitCodeOf(python, ["-I", "-c", "import pty, termios, fcntl, select"], env, 6000)) === 0;
}

function exitCodeOf(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: "ignore", env });
    } catch {
      return resolve(null);
    }
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(t);
      resolve(null);
    });
    child.on("exit", (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });
}

/** For doctor and the hire form: which backend this office has. */
export async function ptyKind(): Promise<PtyKind | null> {
  return (await loadPty())?.kind ?? null;
}

