// Tests for src/control/service.ts against a fake HOME with a recording command runner: the
// LaunchAgent plist (checked with plutil -lint when it exists) and the systemd unit, the stable
// app copy and its pruning, install / start-at-login / uninstall command sequences, and status.
// Nothing is ever loaded into launchd or systemd.
import nodeTest, { after, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CONTROL, skipAll } from "./platform.mjs";

const test = skipAll(nodeTest, CONTROL);

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TMP = realpathSync(mkdtempSync(join(tmpdir(), "agent-visualizer-ctl-svc-")));
let M;

before(async () => {
  const outfile = join(TMP, "mod.mjs");
  await build({
    stdin: { contents: `export * from "./src/control/service.ts";`, resolveDir: ROOT, loader: "ts" },
    bundle: true, platform: "node", format: "esm", target: "node18", outfile, logLevel: "error",
  });
  M = await import(pathToFileURL(outfile).href);
});
after(() => rmSync(TMP, { recursive: true, force: true }));

let n = 0;
/** A fake package (package.json, dist/, node-pty), a fake HOME and a runner that records every command. */
function rig(platform = "darwin", over = {}) {
  const base = join(TMP, `rig-${n++}`);
  const pkg = join(base, "pkg");
  mkdirSync(join(pkg, "dist", "web"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "agent-visualizer", version: "1.2.3" }));
  writeFileSync(join(pkg, "dist", "cli.js"), "#!/usr/bin/env node\n");
  writeFileSync(join(pkg, "dist", "web", "index.html"), "<!doctype html>");
  for (const name of ["node-pty", `node-pty-${platform}-arm64`]) {
    mkdirSync(join(pkg, "node_modules", "@lydell", name), { recursive: true });
    writeFileSync(join(pkg, "node_modules", "@lydell", name, "package.json"), JSON.stringify({ name: `@lydell/${name}`, version: "1.0.0" }));
  }
  const userHome = join(base, "home");
  mkdirSync(userHome, { recursive: true });
  const calls = [];
  const d = {
    home: join(userHome, ".agent-visualizer"), userHome, platform, uid: 501, version: "1.2.3", env: { PATH: "/usr/bin:/bin", LANG: "en_GB.UTF-8" },
    pkgRoot: pkg, node: "/opt/homebrew/bin/node", now: () => Date.parse("2026-10-18T10:00:00Z"),
    run: async (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      return over.result?.(cmd, args) ?? { code: 0, out: "" };
    },
    ...over.deps,
  };
  return { d, calls, base, pkg, userHome };
}

const spec = (o = {}) => ({
  node: "/opt/homebrew/bin/node", script: "/Users/me/.agent-visualizer/app/current/dist/cli.js", userHome: "/Users/me",
  path: "/Users/me/.local/bin:/opt/homebrew/bin:/usr/bin:/bin", lang: "en_US.UTF-8", port: 4747, log: "/Users/me/.agent-visualizer/logs/office.log", ...o,
});

test("the LaunchAgent plist: label, program, a PATH-only environment, restart on failure; it lints", () => {
  const xml = M.launchdPlist(spec({ officeHome: "/Users/me/ao & <x>" }));
  assert.match(xml, /<key>Label<\/key><string>com\.agent-visualizer\.office<\/string>/);
  assert.match(xml, /<string>\/opt\/homebrew\/bin\/node<\/string>\n    <string>\/Users\/me\/\.agent-visualizer\/app\/current\/dist\/cli\.js<\/string>\n    <string>office<\/string>\n    <string>--service<\/string>\n    <string>--port<\/string>\n    <string>4747<\/string>/);
  assert.match(xml, /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/);
  assert.match(xml, /<key>ProcessType<\/key><string>Interactive<\/string>/);
  assert.match(xml, /<key>AGENT_VISUALIZER_HOME<\/key><string>\/Users\/me\/ao &amp; &lt;x&gt;<\/string>/);
  const keys = [...xml.matchAll(/<key>([A-Z_]+)<\/key><string>/g)].map((m) => m[1]);
  assert.deepEqual(keys.filter((k) => k === k.toUpperCase()), ["PATH", "HOME", "LANG", "AGENT_VISUALIZER_SERVICE", "AGENT_VISUALIZER_HOME"], "nothing but these in the environment");
  const plutil = spawnSync("plutil", ["-help"], { encoding: "utf8" });
  if (plutil.error) return; // not macOS
  const file = join(TMP, "lint.plist");
  writeFileSync(file, xml);
  const r = spawnSync("plutil", ["-lint", file], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /OK/);
});

test("the systemd unit: quoted ExecStart, escaped specifiers and variables, KillMode control-group", () => {
  const unit = M.systemdUnit(spec({ node: "/opt/node 22/bin/node", path: "/a%b:/c$d" }));
  assert.match(unit, /^ExecStart="\/opt\/node 22\/bin\/node" "\/Users\/me\/\.agent-visualizer\/app\/current\/dist\/cli\.js" "office" "--service" "--port" "4747"$/m);
  assert.match(unit, /^Environment="PATH=\/a%%b:\/c\$\$d"$/m);
  assert.match(unit, /^Environment="AGENT_VISUALIZER_SERVICE=1"$/m);
  assert.match(unit, /^KillMode=control-group$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
  assert.doesNotMatch(unit, /AGENT_VISUALIZER_HOME/);
});

test("dedupePath keeps the first of each absolute entry and the system folders", () => {
  assert.equal(M.dedupePath("/a:/b:/a:rel", "/b:/c"), "/a:/b:/c:/usr/bin:/bin:/usr/sbin:/sbin");
});

test("the app copy: package.json, dist and node-pty into app/<version>, app/current swapped, older versions pruned", () => {
  const r = rig();
  const cur = M.copyApp(r.d, undefined, "arm64");
  const app = join(r.d.home, "app");
  assert.equal(readlinkSync(cur), "1.2.3");
  assert.ok(existsSync(join(app, "1.2.3", "dist", "cli.js")));
  assert.ok(existsSync(join(app, "1.2.3", "node_modules", "@lydell", "node-pty", "package.json")));
  assert.ok(existsSync(join(app, "1.2.3", "node_modules", "@lydell", "node-pty-darwin-arm64", "package.json")));
  assert.equal(M.appCurrent(r.d.home), cur);
  for (const v of ["1.2.4", "1.2.5"]) M.copyApp({ ...r.d, version: v }, v === "1.2.5" ? "1.2.4" : "1.2.3", "arm64");
  assert.deepEqual(readdirSync(app).sort(), ["1.2.4", "1.2.5", "current"], "the current and the previous version stay");
  assert.equal(readlinkSync(join(app, "current")), "1.2.5");
  // Installing from the installed copy itself copies nothing.
  M.copyApp({ ...r.d, version: "1.2.5", pkgRoot: join(app, "1.2.5") }, "1.2.4", "arm64");
  assert.ok(existsSync(join(app, "1.2.5", "dist", "cli.js")));
  assert.throws(() => M.copyApp({ ...r.d, pkgRoot: join(r.base, "nothing") }), /dist\/cli\.js/);
});

test("macOS install: plist written, enabled, bootstrapped into gui/<uid>; status reads it back", async () => {
  const r = rig("darwin");
  const st = await M.installService(r.d, { start: true, port: 4748, path: "/Users/x/.local/bin:/opt/homebrew/bin" });
  const plist = join(r.userHome, "Library", "LaunchAgents", "com.agent-visualizer.office.plist");
  assert.deepEqual(r.calls, [
    "launchctl enable gui/501/com.agent-visualizer.office",
    "launchctl bootout gui/501/com.agent-visualizer.office",
    `launchctl bootstrap gui/501 ${plist}`,
  ]);
  const xml = readFileSync(plist, "utf8");
  assert.match(xml, /<string>\/Users\/x\/\.local\/bin:\/opt\/homebrew\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin<\/string>/);
  assert.match(xml, /<string>4748<\/string>/);
  assert.match(xml, new RegExp(`${join(r.d.home, "app", "current", "dist", "cli.js").replace(/[.]/g, "\\.")}`));
  assert.doesNotMatch(xml, /AGENT_VISUALIZER_HOME/, "the default home isn't spelled out");
  assert.equal(statSync(plist).mode & 0o777, 0o644);
  assert.deepEqual(st, { supported: true, installed: true, running: false, startAtLogin: true, platform: "darwin" });
  const f = JSON.parse(readFileSync(join(r.d.home, "service.json"), "utf8"));
  assert.deepEqual(f, { v: 1, version: "1.2.3", node: "/opt/homebrew/bin/node", installedAt: "2026-10-18T10:00:00.000Z", startAtLogin: true, port: 4748 });
  assert.equal(statSync(join(r.d.home, "service.json")).mode & 0o777, 0o600);
  // Running: office.json says service and its pid is alive.
  writeFileSync(join(r.d.home, "office.json"), JSON.stringify({ pid: process.pid, service: true }));
  assert.equal(M.serviceStatus(r.d).running, true);
  assert.equal(M.serviceStatus(r.d, true).running, true);
  writeFileSync(join(r.d.home, "office.json"), JSON.stringify({ pid: process.pid }));
  assert.equal(M.serviceStatus(r.d).running, false);
});

test("start at login off disables without stopping; on enables; uninstall boots out and removes everything", async () => {
  const r = rig("darwin");
  await assert.rejects(M.setStartAtLogin(r.d, false), (e) => e.status === 409);
  await M.installService(r.d, { start: false, port: 4747 });
  assert.deepEqual(r.calls, ["launchctl enable gui/501/com.agent-visualizer.office"], "install for the next login only");
  r.calls.length = 0;
  assert.equal((await M.setStartAtLogin(r.d, false)).startAtLogin, false);
  assert.equal((await M.setStartAtLogin(r.d, true)).startAtLogin, true);
  assert.deepEqual(r.calls, ["launchctl disable gui/501/com.agent-visualizer.office", "launchctl enable gui/501/com.agent-visualizer.office"]);
  r.calls.length = 0;
  await M.startService(r.d);
  assert.deepEqual(r.calls.slice(-1), [`launchctl kickstart gui/501/com.agent-visualizer.office`], "print succeeded: it is loaded, so kickstart");
  r.calls.length = 0;
  assert.equal(await M.uninstallService(r.d), true);
  assert.deepEqual(r.calls, ["launchctl bootout gui/501/com.agent-visualizer.office", "launchctl enable gui/501/com.agent-visualizer.office"]);
  assert.ok(!existsSync(join(r.userHome, "Library", "LaunchAgents", "com.agent-visualizer.office.plist")));
  assert.ok(!existsSync(join(r.d.home, "app")));
  assert.ok(!existsSync(join(r.d.home, "service.json")));
  assert.deepEqual(M.serviceStatus(r.d), { supported: true, installed: false, running: false, startAtLogin: false, platform: "darwin" });
});

test("a failing launchctl is reported, not swallowed", async () => {
  const r = rig("darwin", { result: (cmd, args) => (args[0] === "bootstrap" ? { code: 5, out: "Bootstrap failed: 5: Input/output error\n" } : undefined) });
  await assert.rejects(M.installService(r.d, { start: true, port: 4747 }), (e) => e.status === 500 && /Input\/output error/.test(e.message));
});

test("Linux install: the unit under XDG_CONFIG_HOME, daemon-reload, enable --now; uninstall disables and reloads", async () => {
  const r = rig("linux", { deps: { env: { PATH: "/usr/bin", XDG_CONFIG_HOME: join(TMP, "xdg") } } });
  r.d.home = join(TMP, "custom-ao");
  await M.installService(r.d, { start: true, port: 4747 });
  const unit = join(TMP, "xdg", "systemd", "user", "agent-visualizer.service");
  assert.ok(existsSync(unit));
  assert.match(readFileSync(unit, "utf8"), /Environment="AGENT_VISUALIZER_HOME=.*custom-ao"/, "a non-default home is spelled out");
  assert.deepEqual(r.calls, ["systemctl --user daemon-reload", "systemctl --user enable --now agent-visualizer.service"]);
  r.calls.length = 0;
  await M.uninstallService(r.d);
  assert.deepEqual(r.calls, ["systemctl --user disable --now agent-visualizer.service", "systemctl --user daemon-reload"]);
  assert.ok(!existsSync(unit));
});

test("unsupported platforms say so", async () => {
  const r = rig("win32");
  assert.equal(M.serviceStatus(r.d).supported, false);
  assert.equal(M.unitPath(r.d), null);
  await assert.rejects(M.installService(r.d, { start: true, port: 4747 }), (e) => e.status === 400);
});

test("the service log rotates past 5 MB and never breaks", () => {
  const home = join(TMP, "logs-home");
  const log = M.serviceLogger(home, () => 0);
  log("hired claude in site (terminal)");
  const file = join(home, "logs", "office.log");
  assert.match(readFileSync(file, "utf8"), /^1970-01-01T00:00:00\.000Z info hired claude in site \(terminal\)\n$/);
  writeFileSync(file, "x".repeat(M.LOG_MAX_BYTES + 1));
  const log2 = M.serviceLogger(home, () => 0);
  log2("line\nwith newline", "warn");
  assert.ok(existsSync(`${file}.1`));
  assert.equal(readFileSync(file, "utf8"), "1970-01-01T00:00:00.000Z warn line with newline\n");
});

test("the unit's PATH: the login shell's, else the installing shell's minus project and npx bins", () => {
  assert.equal(
    M.installTimePath("/w/proj/node_modules/.bin:/w/node_modules/.bin:/Users/x/.npm/_npx/1a2b/node_modules/.bin:/usr/local/bin:/opt/homebrew/bin"),
    "/usr/local/bin:/opt/homebrew/bin",
  );
  assert.equal(M.dedupePath(M.installTimePath(undefined), "/opt/node/bin"), "/opt/node/bin:/usr/bin:/bin:/usr/sbin:/sbin");
});
