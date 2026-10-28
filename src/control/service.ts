/*
 * The background service: an office that starts at login and owns the
 * agents hired from the page, so closing a terminal doesn't end them.
 *
 *   macOS  a LaunchAgent, ~/Library/LaunchAgents/com.agent-visualizer.office.plist
 *   Linux  a systemd user unit, ~/.config/systemd/user/agent-visualizer.service
 *
 * It runs a stable copy of the package, $AGENT_VISUALIZER_HOME/app/<version>
 * with app/current pointing at it (never an npx cache or a checkout that
 * can vanish), with the node that installed it. The unit holds PATH (the
 * login shell's, deduplicated), HOME, LANG and AGENT_VISUALIZER_SERVICE=1 and
 * nothing else: the office adopts the rest of the login environment in
 * memory when it starts (env.ts adoptLoginEnv), so no key is ever written
 * into a unit file. Turning start-at-login off only disables it at login;
 * a running service keeps going. Restarting it ends every hired agent.
 */
import { execFile } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ServiceStatus } from "../shared/control.ts";
import { ControlError, FILES } from "./types.ts";
import { privateDir, writePrivate } from "./auth.ts";

export const LABEL = "com.agent-visualizer.office";
export const UNIT = "agent-visualizer.service";
export const LOG_MAX_BYTES = 5 << 20;

export interface RunResult {
  code: number;
  out: string;
}

export interface ServiceDeps {
  /** $AGENT_VISUALIZER_HOME. */
  home: string;
  userHome: string;
  platform: NodeJS.Platform;
  uid: number;
  version: string;
  env: NodeJS.ProcessEnv;
  /** launchctl / systemctl. Tests inject a recorder; nothing else runs commands here. */
  run(cmd: string, args: string[]): Promise<RunResult>;
  /** The package being installed: holds package.json and dist/. */
  pkgRoot: string;
  /** Absolute node for the unit (src/install/command.ts stableNode). */
  node: string;
  /** What runs this CLI where it was installed from (src/install/command.ts selfCommand): the service's hints name it. */
  command?: string;
  now?: () => number;
}

export interface ServiceFile {
  v: 1;
  version: string;
  node: string;
  installedAt: string;
  startAtLogin: boolean;
  port: number;
  /** "agent-visualizer" or "npx agent-visualizer": what installed it, since app/<version> is on nobody's PATH. */
  command?: string;
}

/** The commands a service.json may name (it ends up in the office's own pages). */
const COMMANDS = new Set(["agent-visualizer", "npx agent-visualizer"]);

export function supported(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "linux";
}

/** Where the unit file lives, or null on an unsupported platform. */
export function unitPath(d: Pick<ServiceDeps, "platform" | "userHome" | "env">): string | null {
  if (d.platform === "darwin") return join(d.userHome, "Library", "LaunchAgents", `${LABEL}.plist`);
  if (d.platform === "linux") return join(d.env.XDG_CONFIG_HOME?.trim() || join(d.userHome, ".config"), "systemd", "user", UNIT);
  return null;
}

export interface UnitSpec {
  node: string;
  /** <home>/app/current/dist/cli.js */
  script: string;
  userHome: string;
  /** Set AGENT_VISUALIZER_HOME in the unit (only when it isn't the default ~/.agent-visualizer). */
  officeHome?: string;
  path: string;
  lang: string;
  port: number;
  log: string;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function launchdPlist(u: UnitSpec): string {
  const str = (s: string) => `<string>${xml(s)}</string>`;
  const env: [string, string][] = [["PATH", u.path], ["HOME", u.userHome], ["LANG", u.lang], ["AGENT_VISUALIZER_SERVICE", "1"]];
  if (u.officeHome) env.push(["AGENT_VISUALIZER_HOME", u.officeHome]);
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>${str(LABEL)}`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...[u.node, u.script, "office", "--service", "--port", String(u.port)].map((a) => `    ${str(a)}`),
    `  </array>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    ...env.map(([k, v]) => `    <key>${xml(k)}</key>${str(v)}`),
    `  </dict>`,
    `  <key>WorkingDirectory</key>${str(u.userHome)}`,
    `  <key>RunAtLoad</key><true/>`,
    `  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>`,
    `  <key>ThrottleInterval</key><integer>10</integer>`,
    `  <key>ProcessType</key>${str("Interactive")}`,
    `  <key>ExitTimeOut</key><integer>10</integer>`,
    `  <key>StandardOutPath</key>${str(u.log)}`,
    `  <key>StandardErrorPath</key>${str(u.log)}`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

/** One systemd word: double-quoted, with specifiers (%) and variables ($) escaped. */
function sdQuote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
}

export function systemdUnit(u: UnitSpec): string {
  const env: [string, string][] = [["PATH", u.path], ["LANG", u.lang], ["AGENT_VISUALIZER_SERVICE", "1"]];
  if (u.officeHome) env.push(["AGENT_VISUALIZER_HOME", u.officeHome]);
  return [
    `[Unit]`,
    `Description=agent-visualizer`,
    ``,
    `[Service]`,
    `ExecStart=${[u.node, u.script, "office", "--service", "--port", String(u.port)].map(sdQuote).join(" ")}`,
    ...env.map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`)}`),
    `WorkingDirectory=%h`,
    `Restart=on-failure`,
    `RestartSec=5`,
    `KillMode=control-group`,
    `StandardOutput=append:${u.log.replace(/%/g, "%%")}`,
    `StandardError=append:${u.log.replace(/%/g, "%%")}`,
    ``,
    `[Install]`,
    `WantedBy=default.target`,
    ``,
  ].join("\n");
}

/** PATH entries in order, each once, absolute only. */
export function dedupePath(...paths: (string | undefined)[]): string {
  const out: string[] = [];
  for (const p of paths) for (const dir of (p ?? "").split(":")) if (dir.startsWith("/") && !out.includes(dir)) out.push(dir);
  for (const dir of ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]) if (!out.includes(dir)) out.push(dir);
  return out.join(":");
}

/* ------------------------------------------------------------- app copy */

const safeVersion = (v: string) => v.replace(/[^\w.+-]/g, "_") || "0.0.0";

/** node-pty and this platform's binary package, when this copy has them. */
function ptyDirs(pkgRoot: string, platform: string, arch: string): string[] {
  const req = createRequire(join(pkgRoot, "package.json"));
  const out: string[] = [];
  for (const name of ["@lydell/node-pty", `@lydell/node-pty-${platform}-${arch}`]) {
    try {
      out.push(dirname(req.resolve(`${name}/package.json`)));
    } catch {
      // Not installed: the service runs without terminal mode.
    }
  }
  return out;
}

/**
 * Copy this package into app/<version>/ and point app/current at it
 * (a fresh symlink renamed over the old one). Keeps the current and the
 * previous version, prunes the rest. Returns app/current.
 */
export function copyApp(d: Pick<ServiceDeps, "home" | "version" | "pkgRoot" | "platform">, previous?: string, arch = process.arch): string {
  const app = join(d.home, FILES.app);
  privateDir(d.home);
  mkdirSync(app, { recursive: true, mode: 0o755 });
  const ver = safeVersion(d.version);
  const dest = join(app, ver);
  const current = join(app, "current");
  const src = d.pkgRoot.replace(/[\\/]+$/, "");
  if (!existsSync(join(src, "dist", "cli.js"))) throw new ControlError(500, "This copy of agent-visualizer has no dist/cli.js to install.");
  if (src !== dest) {
    const tmp = `${dest}.${process.pid}.tmp`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    cpSync(join(src, "package.json"), join(tmp, "package.json"));
    cpSync(join(src, "dist"), join(tmp, "dist"), { recursive: true, dereference: true });
    for (const dir of ptyDirs(src, d.platform, arch)) {
      const rel = dir.slice(dir.lastIndexOf("node_modules") + "node_modules".length + 1);
      cpSync(dir, join(tmp, "node_modules", rel), { recursive: true, dereference: true });
    }
    rmSync(dest, { recursive: true, force: true });
    renameSync(tmp, dest);
  }
  const link = `${current}.${process.pid}.tmp`;
  rmSync(link, { force: true });
  symlinkSync(ver, link);
  renameSync(link, current);
  const keep = new Set(["current", ver, previous ? safeVersion(previous) : ""]);
  for (const name of readdirSync(app)) {
    if (!keep.has(name)) rmSync(join(app, name), { recursive: true, force: true });
  }
  return current;
}

/* ---------------------------------------------------------------- state */

const serviceFile = (home: string) => join(home, FILES.service);

export function readServiceFile(home: string): ServiceFile | null {
  try {
    const j = JSON.parse(readFileSync(serviceFile(home), "utf8"));
    if (j?.v !== 1) return null;
    return {
      v: 1,
      version: String(j.version ?? ""),
      node: String(j.node ?? ""),
      installedAt: String(j.installedAt ?? ""),
      startAtLogin: j.startAtLogin !== false,
      port: Number.isInteger(j.port) ? j.port : 4747,
      ...(COMMANDS.has(j.command) ? { command: j.command as string } : {}),
    };
  } catch {
    return null;
  }
}

function writeServiceFile(home: string, f: ServiceFile): void {
  privateDir(home);
  writePrivate(serviceFile(home), JSON.stringify(f, null, 2) + "\n");
}

function pidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Is the service's office running: office.json says so (service: true, live pid). */
export function serviceRunning(home: string): boolean {
  try {
    const j = JSON.parse(readFileSync(join(home, "office.json"), "utf8"));
    return j?.service === true && pidAlive(j.pid);
  } catch {
    return false;
  }
}

export function serviceStatus(d: Pick<ServiceDeps, "home" | "platform" | "userHome" | "env">, self = false): ServiceStatus {
  const path = unitPath(d);
  const installed = !!path && existsSync(path);
  const f = readServiceFile(d.home);
  return {
    supported: supported(d.platform),
    installed,
    running: self || (installed && serviceRunning(d.home)),
    startAtLogin: installed && (f?.startAtLogin ?? true),
    platform: d.platform,
  };
}

/* ------------------------------------------------------------- commands */

export function defaultRun(cmd: string, args: string[], timeoutMs = 15_000): Promise<RunResult> {
  return new Promise((done) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? ((err as unknown as { code: number }).code) : 1) : 0;
      done({ code, out: `${stdout ?? ""}${stderr ?? ""}` });
    });
  });
}

const domain = (d: ServiceDeps) => `gui/${d.uid}`;
const target = (d: ServiceDeps) => `${domain(d)}/${LABEL}`;

async function must(d: ServiceDeps, cmd: string, args: string[], what: string): Promise<void> {
  const r = await d.run(cmd, args);
  if (r.code !== 0) {
    const why = r.out.trim().split("\n").pop()?.slice(0, 160) ?? "";
    throw new ControlError(500, `${what} failed${why ? `: ${why}` : ""}`);
  }
}

/** Start the installed service now (launchd: bootstrap, or kickstart if it is loaded already). */
export async function startService(d: ServiceDeps): Promise<void> {
  if (d.platform === "darwin") {
    await d.run("launchctl", ["enable", target(d)]);
    const loaded = (await d.run("launchctl", ["print", target(d)])).code === 0;
    if (loaded) await must(d, "launchctl", ["kickstart", target(d)], "Starting the service");
    else await must(d, "launchctl", ["bootstrap", domain(d), unitPath(d)!], "Starting the service");
  } else if (d.platform === "linux") {
    await must(d, "systemctl", ["--user", "start", UNIT], "Starting the service");
  }
}

export interface InstallServiceOptions {
  /** Start it now as well as at login. */
  start: boolean;
  port: number;
  /** PATH for the unit: the login shell's (env.ts loginShellVars), else this process's minus project-local bins. */
  path?: string;
}

/**
 * The PATH of whatever ran the install, minus what only that folder or that
 * npx run had (node_modules/.bin, the npx cache): never baked into a unit,
 * where it would pick a project's own `claude` long after.
 */
export function installTimePath(path: string | undefined): string {
  return (path ?? "")
    .split(":")
    .filter((dir) => !/[\\/]node_modules[\\/]\.bin[\\/]?$|[\\/]_npx[\\/]/.test(dir))
    .join(":");
}

/** Copy the app, write the unit and service.json, enable it at login, and optionally start it. */
export async function installService(d: ServiceDeps, o: InstallServiceOptions): Promise<ServiceStatus> {
  if (!supported(d.platform)) throw new ControlError(400, "The background service needs macOS (launchd) or Linux (systemd).");
  const prev = readServiceFile(d.home);
  const current = copyApp(d, prev?.version && prev.version !== d.version ? prev.version : undefined);
  const logs = join(d.home, FILES.logs);
  privateDir(logs);
  const defaultHome = join(d.userHome, ".agent-visualizer");
  const spec: UnitSpec = {
    node: d.node,
    script: join(current, "dist", "cli.js"),
    userHome: d.userHome,
    officeHome: d.home.replace(/[\\/]+$/, "") === defaultHome ? undefined : d.home,
    // The login shell's PATH when it could be read; the installing shell's only as a fallback, never both.
    path: dedupePath(installTimePath(o.path ?? d.env.PATH), dirname(d.node)),
    lang: d.env.LANG || "en_US.UTF-8",
    port: o.port,
    log: join(logs, "office.log"),
  };
  const file = unitPath(d)!;
  mkdirSync(dirname(file), { recursive: true });
  const text = d.platform === "darwin" ? launchdPlist(spec) : systemdUnit(spec);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o644 });
  renameSync(tmp, file);
  writeServiceFile(d.home, {
    v: 1,
    version: d.version,
    node: d.node,
    installedAt: new Date((d.now ?? Date.now)()).toISOString(),
    startAtLogin: true,
    port: o.port,
    ...(d.command && COMMANDS.has(d.command) ? { command: d.command } : {}),
  });
  if (d.platform === "darwin") {
    await d.run("launchctl", ["enable", target(d)]);
    if (o.start) {
      // A copy loaded from an earlier install would keep running its old plist.
      await d.run("launchctl", ["bootout", target(d)]);
      await must(d, "launchctl", ["bootstrap", domain(d), file], "Starting the service");
    }
  } else {
    await must(d, "systemctl", ["--user", "daemon-reload"], "Reloading systemd");
    await must(d, "systemctl", ["--user", "enable", ...(o.start ? ["--now"] : []), UNIT], "Enabling the service");
  }
  return serviceStatus(d);
}

/** Start at login on or off. Off never stops a running service. */
export async function setStartAtLogin(d: ServiceDeps, on: boolean): Promise<ServiceStatus> {
  const f = readServiceFile(d.home);
  if (!f || !existsSync(unitPath(d) ?? "")) throw new ControlError(409, "The background service isn't installed.");
  if (d.platform === "darwin") await must(d, "launchctl", [on ? "enable" : "disable", target(d)], on ? "Enabling the service" : "Disabling the service");
  else await must(d, "systemctl", ["--user", on ? "enable" : "disable", UNIT], on ? "Enabling the service" : "Disabling the service");
  writeServiceFile(d.home, { ...f, startAtLogin: on });
  return serviceStatus(d);
}

/** Stop it, remove the unit, the app copy and service.json. */
export async function uninstallService(d: ServiceDeps): Promise<boolean> {
  const file = unitPath(d);
  if (!file) return false;
  const had = existsSync(file) || !!readServiceFile(d.home);
  if (d.platform === "darwin") {
    await d.run("launchctl", ["bootout", target(d)]);
    // Leave no persistent "disabled" override behind for a later reinstall.
    await d.run("launchctl", ["enable", target(d)]);
  } else {
    await d.run("systemctl", ["--user", "disable", "--now", UNIT]);
  }
  rmSync(file, { force: true });
  if (d.platform === "linux") await d.run("systemctl", ["--user", "daemon-reload"]);
  rmSync(join(d.home, FILES.app), { recursive: true, force: true });
  rmSync(serviceFile(d.home), { force: true });
  return had;
}

/* ----------------------------------------------------------------- logs */

/** One line into logs/office.log (service mode), rotated to office.log.1 past LOG_MAX_BYTES. Never a key, prompt or argv. */
export function serviceLogger(home: string, now: () => number = Date.now): (msg: string, level?: "info" | "warn") => void {
  const file = join(home, FILES.logs, "office.log");
  let n = 0;
  return (msg, level = "info") => {
    try {
      if (n++ % 200 === 0) {
        privateDir(dirname(file));
        try {
          if (statSync(file).size > LOG_MAX_BYTES) renameSync(file, `${file}.1`);
        } catch {
          // No log yet.
        }
      }
      appendFileSync(file, `${new Date(now()).toISOString()} ${level === "warn" ? "warn" : "info"} ${msg.replace(/[\r\n]+/g, " ")}\n`, { mode: 0o600 });
    } catch {
      // Logging must never take the office down.
    }
  };
}

/** $AGENT_VISUALIZER_HOME/app/current when it resolves to an installed copy, else null. */
export function appCurrent(home: string): string | null {
  const p = join(home, FILES.app, "current");
  return existsSync(join(p, "dist", "cli.js")) ? p : null;
}
