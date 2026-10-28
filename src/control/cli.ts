/*
 * The control plane's commands:
 *   agent-visualizer open [--print] [--rotate]   unlock controls in a browser
 *   agent-visualizer install --service           the background service, started now
 *   agent-visualizer uninstall --service         and gone again
 * plus its rows in `agent-visualizer doctor`. The unlock link is opened, never
 * printed, unless --print asks for it: it must not end up in a screen
 * recording or a terminal scrollback someone else reads.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findOffice, officeFilePath, type OfficeFile } from "../mcp/office.ts";
import { officeHome } from "../mcp/outbox.ts";
import { selfCommand, stableNode } from "../install/command.ts";
import { PAD, bold, dim, green, red, yellow } from "../install/ui.ts";
import { windowsSystemBinary } from "../remote/util.ts";
import { ControlAuth } from "./auth.ts";
import { loginShellVars } from "./env.ts";
import { createKeyStore } from "./keys.ts";
import { ptyKind } from "./pty.ts";
import {
  defaultRun, installService, readServiceFile, serviceStatus, startService, supported, uninstallService, unitPath, type ServiceDeps,
} from "./service.ts";
import { ControlError, FILES, controlSupported } from "./types.ts";

type Out = (line?: string) => void;

/** Why the office is watch-only on Windows (and anything else that isn't macOS or Linux). */
export const WATCH_ONLY = "hiring and driving agents from the page needs macOS or Linux; on this machine the office is watch-only.";

/** The program and arguments that open `url` in the default browser. Windows' cmd.exe by full path: by name, the current folder's would win. */
export function browserCommand(url: string, platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): [string, string[]] {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return [windowsSystemBinary("cmd.exe", env), ["/c", "start", '""', url]];
  return ["xdg-open", [url]];
}

/**
 * Whether a browser can be opened from here at all. Linux and the BSDs need a display: over ssh or
 * on a server there is none, and xdg-open gives up ("no method available"). $BROWSER, which
 * xdg-open honours (wslview under WSL, say), and WSL itself get the benefit of the doubt.
 */
export function canOpenBrowser(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): boolean {
  if (env.BROWSER === "none") return false;
  if (platform === "darwin" || platform === "win32") return true;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY || env.BROWSER || env.WSL_DISTRO_NAME);
}

/**
 * Open a URL in the default browser. Resolves false when nothing opened it (no opener, or it
 * exited with an error), true once it exited cleanly or is still going after `waitMs`.
 */
export function openBrowser(url: string, o: { platform?: string; opener?: string; waitMs?: number } = {}): Promise<boolean> {
  const platform = o.platform ?? process.platform;
  const [cmd, args] = browserCommand(url, platform);
  return new Promise((done) => {
    let child;
    try {
      child = spawn(o.opener ?? cmd, args, {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
        // cmd.exe reads `start "" url` itself; libuv quoting would mangle the empty title.
        windowsVerbatimArguments: platform === "win32",
      });
    } catch {
      return done(false); // No opener on this system.
    }
    // A browser xdg-open starts in the foreground keeps it running: that counts as opened.
    const timer = setTimeout(() => done(true), o.waitMs ?? 3_000);
    child.on("error", () => {
      clearTimeout(timer);
      done(false);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      done(code === 0);
    });
    child.unref();
  });
}

/** The installed package root: dist/cli.js lives one folder down. */
export function packageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

export function serviceDeps(version: string, env: NodeJS.ProcessEnv = process.env): ServiceDeps {
  return {
    home: officeHome(env),
    userHome: env.HOME?.trim() || homedir(),
    platform: process.platform,
    uid: process.getuid?.() ?? 0,
    version,
    env,
    run: (cmd, args) => defaultRun(cmd, args),
    pkgRoot: packageRoot(),
    node: stableNode(),
    command: selfCommand(),
  };
}

/** The login shell's PATH (only PATH is read), for the unit file. */
export async function loginPath(): Promise<string | undefined> {
  return (await loginShellVars(["PATH"]))?.PATH;
}

function readOffice(): Partial<OfficeFile> | null {
  try {
    return JSON.parse(readFileSync(officeFilePath(), "utf8")) as Partial<OfficeFile>;
  } catch {
    return null;
  }
}

/** Wait for an office that proves itself (and, with `service`, is the service's) for up to `ms`. */
export async function waitForOffice(ms: number, o: { service?: boolean; notPid?: number } = {}): Promise<number | null> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const f = readOffice();
    if (f && (!o.service || f.service === true) && f.pid !== o.notPid) {
      const port = await findOffice(process.env, 500);
      if (port !== null) return port;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

/** `agent-visualizer open [--print] [--rotate]`. */
export async function runOpen(argv: string[], version: string, out: Out, platform: string = process.platform): Promise<number> {
  const flags = new Set(argv);
  if (!controlSupported(platform) && !flags.has("--help") && !flags.has("-h")) {
    out(`${PAD}${yellow("There are no controls to unlock here:")} ${dim(WATCH_ONLY)}`);
    return 1;
  }
  if (flags.has("--help") || flags.has("-h")) {
    out(`
${bold("agent-visualizer open")}  unlock hiring and driving agents in a browser

Opens the running office with a one-time link that unlocks its controls in that browser
(for 30 days). Starts the background service first when it is installed and not running.

  --print     Print the link instead of opening it (it unlocks one browser, once, for 2 minutes)
  --rotate    Log every browser out first (a new unlock secret)
`);
    return 0;
  }
  for (const f of flags) {
    if (f !== "--print" && f !== "--rotate") {
      process.stderr.write(`agent-visualizer open: unknown option ${f}\n`);
      return 2;
    }
  }
  const home = officeHome();
  const auth = new ControlAuth(home);
  if (flags.has("--rotate")) {
    auth.rotate();
    out(`${PAD}${green("✓")} Every browser is logged out of the office's controls.`);
  }
  let port = await findOffice(process.env, 800);
  if (port === null) {
    const d = serviceDeps(version);
    if (supported(d.platform) && existsSync(unitPath(d) ?? "")) {
      out(`${PAD}${dim("Starting the background service…")}`);
      try {
        await startService(d);
      } catch (err) {
        out(`${PAD}${red("✗")} ${(err as Error).message}`);
        return 1;
      }
      port = await waitForOffice(10_000, { service: true });
    }
  }
  if (port === null) {
    out(`${PAD}${yellow("No office running.")} Start it with ${bold("npx agent-visualizer")}`);
    return 1;
  }
  const f = readOffice();
  if (f?.control === false) {
    out(`${PAD}${yellow("This office runs with controls off")} ${dim("(--demo, --no-control or a non-loopback --host). It is watch-only.")}`);
    return 1;
  }
  const url = typeof f?.url === "string" && f.port === port ? f.url : `http://127.0.0.1:${port}`;
  const print = `${selfCommand()} open --print`;
  if (!flags.has("--print") && !canOpenBrowser()) {
    out(`${PAD}${yellow("No browser to open here")} ${dim("(no display).")} ${bold(print)} prints a link to open in yours.`);
    return 1;
  }
  const link = `${url}/unlock?t=${auth.mintCode()}`;
  if (flags.has("--print")) {
    out(link);
    out(`${PAD}${dim("Unlocks controls in one browser, once, within 2 minutes. Anyone with this link can drive your agents until then.")}`);
    return 0;
  }
  if (!(await openBrowser(link))) {
    out(`${PAD}${red("✗")} Couldn't open a browser. ${bold(print)} prints the link instead.`);
    return 1;
  }
  out(`${PAD}${green("✓")} Opened ${bold(url)} with controls unlocked.`);
  return 0;
}

/** `agent-visualizer install --service` / `uninstall --service`. */
export async function serviceCommand(cmd: "install" | "uninstall", version: string, out: Out): Promise<number> {
  const d = serviceDeps(version);
  out();
  if (!supported(d.platform)) {
    out(`${PAD}${red("✗")} The background service needs macOS (launchd) or Linux (systemd).`);
    return 1;
  }
  try {
    if (cmd === "uninstall") {
      const had = await uninstallService(d);
      out(had ? `${PAD}${green("✓")} Removed the background service ${dim(`(${unitPath(d)})`)}. Agents it was running have stopped.` : `${PAD}${dim("No background service was installed.")}`);
      out();
      return 0;
    }
    const f = readOffice();
    const foreground = (await findOffice(process.env, 800)) !== null && f?.service !== true;
    const st = await installService(d, { start: !foreground, port: 4747, path: await loginPath() });
    out(`${PAD}${green("✓")} Installed the background service ${dim(`(${unitPath(d)})`)}`);
    out(`${PAD}  ${dim("It runs")} ${bold(join(d.home, FILES.app, "current"))} ${dim("with")} ${d.node}${d.node.includes("/.nvm/versions/") || d.node.includes("/fnm/") || d.node.includes("/Cellar/") ? yellow(" (a version manager's node: an upgrade can remove it; re-run this after one)") : ""}`);
    if (foreground) {
      out(`${PAD}  An office is already running in a terminal, so the service starts at your next login.`);
      out(`${PAD}  Close that office (Ctrl+C) and run ${bold(`${selfCommand()} open`)} to start it now.`);
    } else {
      const port = await waitForOffice(10_000, { service: true });
      if (port === null) out(`${PAD}${yellow("!")} It didn't answer within 10 seconds; see ${join(d.home, FILES.logs, "office.log")}`);
      else out(`${PAD}  The office is running in the background at ${bold(`http://127.0.0.1:${port}`)}. ${bold(`${selfCommand()} open`)} unlocks it in a browser.`);
    }
    if (d.platform === "linux") out(`${PAD}  ${dim("systemd stops user services at logout unless you run")} loginctl enable-linger`);
    if (!st.installed) return 1;
    out();
    return 0;
  } catch (err) {
    out(`${PAD}${red("✗")} ${err instanceof ControlError ? err.message : (err as Error).message}`);
    return 1;
  }
}

/** doctor's rows for the control plane (this machine only). */
export async function doctorRows(version: string, out: Out, platform: string = process.platform): Promise<void> {
  const d = serviceDeps(version);
  const label = (s: string) => dim(s.padEnd(11));
  if (!controlSupported(platform)) {
    out(`${PAD}${label("Controls")}${dim(`off: ${WATCH_ONLY}`)}`);
    return;
  }
  const secret = existsSync(join(d.home, FILES.control));
  out(`${PAD}${label("Controls")}${secret ? green("unlock secret set up") : dim("set up on the first start")} ${dim(`· ${selfCommand()} open unlocks a browser`)}`);
  const pty = await ptyKind().catch(() => null);
  out(`${PAD}${label("Terminals")}${pty === "node-pty" ? green("node-pty") : pty === "python" ? yellow("python3 bridge (node-pty didn't load)") : red("none: hired agents get chat mode only (reinstall with optional dependencies)")}`);
  if (supported(d.platform)) {
    const st = serviceStatus(d);
    const f = readServiceFile(d.home);
    const node = f?.node && (f.node.includes("/.nvm/versions/") || f.node.includes("/fnm/") || f.node.includes("/Cellar/")) ? yellow(` · node ${f.node} may vanish on an upgrade`) : "";
    out(`${PAD}${label("Service")}${st.installed ? `${st.running ? green("running") : yellow("installed, not running")}${dim(` · start at login ${st.startAtLogin ? "on" : "off"}`)}${node}` : dim(`not installed · ${selfCommand()} install --service`)}`);
  }
  try {
    const keys = createKeyStore(d.home).list();
    out(`${PAD}${label("Keys")}${keys.length ? `${keys.length} stored ${dim(`(${keys.map((k) => k.name).join(", ")})`)}` : dim("none stored")}`);
  } catch {
    out(`${PAD}${label("Keys")}${red("keys.json can't be read")}`);
  }
}
