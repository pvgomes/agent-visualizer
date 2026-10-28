// Tests for the control plane's CLI wiring (src/cli.ts, src/control/cli.ts), on a fresh bundle of
// src/cli.ts against a fake HOME and a scratch AGENT_VISUALIZER_HOME: the banner's Controls line
// (never the unlock link), `agent-visualizer open --print` and `--rotate`, a watch-only office with
// --no-control, help and doctor rows, the hints a copy run from an npx cache (or the service's copy
// of one) prints, and what happens with no browser to open. No service is loaded (an install
// writes its files under a fake HOME, its launchctl/systemctl calls only recorded), and no real
// browser opens. Where the control plane can't run (Windows), what doctor and open say instead.
import nodeTest, { after, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cleanup, fakeBin, load } from "./control.session-fakes.mjs";
import { CONTROL, skipAll } from "./platform.mjs";

const test = skipAll(nodeTest, CONTROL);

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TMP = realpathSync(mkdtempSync(join(tmpdir(), "agent-visualizer-ctl-cli-")));
const CLI = join(TMP, "pkg", "dist", "cli.js");
/** The same CLI where `npx @pvgomes/agent-visualizer` puts it: `agent-visualizer` isn't on PATH there. */
const NPX_CLI = join(TMP, ".npm", "_npx", "0123abcd", "node_modules", "agent-visualizer", "dist", "cli.js");
const kids = [];

before(async () => {
  for (const outfile of [CLI, NPX_CLI]) {
    mkdirSync(join(outfile, "..", "web"), { recursive: true });
    await build({
      entryPoints: [join(ROOT, "src/cli.ts")], outfile, bundle: true, platform: "node", format: "esm", target: "node18",
      external: ["@lydell/node-pty"], logLevel: "error",
    });
  }
  // A package root the service can copy (src/control/service.ts copyApp).
  writeFileSync(join(NPX_CLI, "..", "..", "package.json"), JSON.stringify({ name: "agent-visualizer", version: "0.2.0" }));
  try {
    symlinkSync(join(ROOT, "node_modules"), join(TMP, "pkg", "node_modules"));
  } catch {
    // Terminal support is optional here.
  }
});
after(() => {
  for (const k of kids) if (k.exitCode === null) k.kill("SIGKILL");
  rmSync(TMP, { recursive: true, force: true });
  cleanup();
});

let n = 0;
function homes() {
  const home = join(TMP, `home-${n++}`);
  mkdirSync(home, { recursive: true });
  const ao = join(home, ".agent-visualizer");
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, AGENT_VISUALIZER_HOME: ao, NO_COLOR: "1", BROWSER: "none", CI: "1", SHELL: "/bin/sh" };
  return { home, ao, env };
}

const run = (args, env, cli = CLI) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env, timeout: 20_000 });

function get(port, path, headers = {}, method = "GET", data) {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path, headers, agent: false, method }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => done({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", fail);
    req.end(data);
  });
}

/** Start an office, wait for office.json, return its port and a way to read its output. */
async function office(env, args = [], o = {}) {
  const child = spawn(process.execPath, [o.cli ?? CLI, ...(o.open ? [] : ["--no-open"]), "--port", "0", "--local-only", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  kids.push(child);
  let output = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (output += c));
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      const info = JSON.parse(readFileSync(join(env.AGENT_VISUALIZER_HOME, "office.json"), "utf8"));
      if (info.pid === child.pid && /Ctrl\+C/.test(output)) return { child, info, output: () => output };
    } catch {
      // not yet
    }
  }
  child.kill("SIGKILL");
  throw new Error(`office didn't start: ${output}`);
}

async function stop(child) {
  const exited = new Promise((r) => child.on("exit", r));
  child.kill("SIGTERM");
  await exited;
}

test("help lists open, --no-control and install --service", () => {
  const r = run(["--help"], homes().env);
  assert.equal(r.status, 0);
  for (const w of ["open", "--no-control", "install --service"]) assert.ok(r.stdout.includes(w), w);
  assert.ok(!r.stdout.includes("--service      "), "--service itself stays out of the office flags");
  assert.equal(run(["open", "--bogus"], homes().env).status, 2);
  assert.equal(run(["doctor", "--service"], homes().env).status, 2);
});

test("open with no office running says how to start one", () => {
  const r = run(["open", "--print"], homes().env);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /No office running/);
});

test("a running office: the banner never shows the link; open --print does; the link unlocks once; --rotate logs out", { timeout: 40_000 }, async () => {
  const { env, ao } = homes();
  const { child, info, output } = await office(env);
  try {
    assert.equal(info.control, true);
    assert.match(output(), /Controls\s+locked · agent-visualizer open unlocks a browser/);
    assert.doesNotMatch(output(), /unlock\?t=/);
    const r = run(["open", "--print"], env);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const link = r.stdout.trim().split("\n")[0];
    assert.match(link, new RegExp(`^http://127\\.0\\.0\\.1:${info.port}/unlock\\?t=[0-9a-z]+\\.[0-9a-f]{12}\\.[0-9a-f]{32}$`));
    assert.match(r.stdout, /once, within 2 minutes/);
    const u = new URL(link);
    const unlocked = await get(info.port, u.pathname + u.search, { "sec-fetch-site": "none" });
    assert.equal(unlocked.status, 303);
    const cookie = unlocked.headers["set-cookie"][0].split(";")[0];
    assert.equal((await get(info.port, u.pathname + u.search)).status, 403, "used once");
    // The page trades the redirect's #unlock handoff for its token; the cookie alone unlocks nothing.
    const handoff = /^\/#unlock=([0-9a-f]{32})$/.exec(unlocked.headers.location)?.[1];
    assert.ok(handoff, unlocked.headers.location);
    const tok = await get(info.port, "/api/control/token", { "x-agent-visualizer": "1", cookie, "content-type": "application/json" }, "POST", JSON.stringify({ handoff }));
    assert.equal(tok.status, 200, tok.body);
    const token = JSON.parse(tok.body).token;
    assert.equal((await get(info.port, "/api/control", { "x-agent-visualizer": "1", cookie })).status, 401, "a cookie without the token");
    const ctl = await get(info.port, "/api/control", { "x-agent-visualizer": "1", "x-agent-visualizer-token": token, cookie });
    assert.equal(ctl.status, 200);
    assert.equal(JSON.parse(ctl.body).enabled, true);
    assert.equal(JSON.parse((await get(info.port, `/api/snapshot?k=${token}`, { cookie })).body).control, "enabled");
    const rot = run(["open", "--rotate", "--print"], env);
    assert.equal(rot.status, 0);
    assert.match(rot.stdout, /logged out/);
    await new Promise((r) => setTimeout(r, 1_100)); // the office re-reads control.json within a second
    assert.equal((await get(info.port, "/api/control", { "x-agent-visualizer": "1", "x-agent-visualizer-token": token, cookie })).status, 401);
    assert.doesNotMatch(output(), /unlock\?t=/, "the office never logs a link");
    assert.ok(!output().includes(token), "nor the token");
    assert.equal(JSON.parse(readFileSync(join(ao, "control.json"), "utf8")).v, 1);
  } finally {
    await stop(child);
  }
});

test("a second office on the same home that quits hands office.json back to the first", { timeout: 40_000 }, async () => {
  const { env, ao } = homes();
  const a = await office(env);
  try {
    const b = await office(env);
    assert.equal(JSON.parse(readFileSync(join(ao, "office.json"), "utf8")).pid, b.child.pid);
    await stop(b.child);
    let pid;
    for (let i = 0; i < 80 && pid !== a.child.pid; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        pid = JSON.parse(readFileSync(join(ao, "office.json"), "utf8")).pid;
      } catch {
        // gone until A writes it again
      }
    }
    assert.equal(pid, a.child.pid, "the office still running advertises itself again");
    const r = run(["open", "--print"], env);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`:${a.info.port}/unlock`));
  } finally {
    await stop(a.child);
  }
});

test("--no-control: watch-only, the snapshot says off and open refuses", { timeout: 30_000 }, async () => {
  const { env } = homes();
  const { child, info, output } = await office(env, ["--no-control"]);
  try {
    assert.equal(info.control, false);
    assert.match(output(), /Controls\s+off \(--no-control\)/);
    assert.equal(JSON.parse((await get(info.port, "/api/snapshot")).body).control, "off");
    assert.equal((await get(info.port, "/api/control", { "x-agent-visualizer": "1" })).status, 404);
    const r = run(["open", "--print"], env);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /controls off/);
  } finally {
    await stop(child);
  }
});

test("doctor shows the control plane's rows (names only for keys)", () => {
  const { env, ao } = homes();
  mkdirSync(ao, { recursive: true });
  const r = run(["doctor"], env);
  for (const w of ["Controls", "Terminals", "Service", "Keys"]) assert.match(r.stdout, new RegExp(`${w}\\s`), w);
  assert.match(r.stdout, /not installed · agent-visualizer install --service/);
});

nodeTest("where the control plane can't run (Windows), doctor and open say the office is watch-only", async () => {
  const outfile = join(TMP, "control-cli.mjs");
  await build({ entryPoints: [join(ROOT, "src/control/cli.ts")], outfile, bundle: true, platform: "node", format: "esm", target: "node18", external: ["@lydell/node-pty"], logLevel: "error" });
  const C = await import(pathToFileURL(outfile).href);
  const lines = [];
  const out = (l = "") => lines.push(l);
  await C.doctorRows("0.0.0", out, "win32");
  assert.match(lines.join("\n"), /Controls\s+off: hiring and driving agents from the page needs macOS or Linux/);
  assert.ok(!/Terminals|Service|Keys/.test(lines.join("\n")), lines.join("\n"));
  lines.length = 0;
  assert.equal(await C.runOpen(["--print"], "0.0.0", out, "win32"), 1);
  assert.match(lines.join("\n"), /no controls to unlock here/);
  // The browser opener: cmd.exe by full path on Windows, so a cmd.exe in the folder the office starts from never runs.
  assert.deepEqual(C.browserCommand("http://127.0.0.1:4747", "win32", { SystemRoot: "C:\\WINDOWS" }), ["C:\\WINDOWS\\System32\\cmd.exe", ["/c", "start", '""', "http://127.0.0.1:4747"]]);
  assert.deepEqual(C.browserCommand("http://127.0.0.1:4747", "darwin"), ["open", ["http://127.0.0.1:4747"]]);
  assert.deepEqual(C.browserCommand("http://127.0.0.1:4747", "linux"), ["xdg-open", ["http://127.0.0.1:4747"]]);
  if (process.platform !== "win32") return;
  // And on Windows itself, through the CLI.
  const { env } = homes();
  assert.match(run(["doctor"], env).stdout, /Controls\s+off: hiring and driving agents/);
  const o = run(["open"], env);
  assert.equal(o.status, 1);
  assert.match(o.stdout, /no controls to unlock here/);
});

test("run from an npx cache, every hint names npx @pvgomes/agent-visualizer: agent-visualizer isn't on PATH there", { timeout: 30_000 }, async () => {
  const { env, ao } = homes();
  const bad = run(["--bogus"], env, NPX_CLI);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /Run npx @pvgomes\/agent-visualizer --help for usage/);
  assert.match(run(["install", "--bogus"], env, NPX_CLI).stderr, /Run npx @pvgomes\/agent-visualizer install --help for usage/);
  assert.match(run(["--help"], env, NPX_CLI).stdout, /Run npx @pvgomes\/agent-visualizer <command> --help/);
  mkdirSync(ao, { recursive: true });
  const doc = run(["doctor"], env, NPX_CLI);
  assert.match(doc.stdout, /npx @pvgomes\/agent-visualizer open unlocks a browser/);
  assert.match(doc.stdout, /not installed · npx @pvgomes\/agent-visualizer install --service/);
  const { child, info, output } = await office(env, [], { cli: NPX_CLI });
  try {
    assert.match(output(), /Controls\s+locked · npx @pvgomes\/agent-visualizer open unlocks a browser/);
    const spent = await get(info.port, "/unlock?t=0.0.0", { "sec-fetch-site": "none" });
    assert.equal(spent.status, 403);
    assert.match(spent.body, /Run <code>npx @pvgomes\/agent-visualizer open<\/code> for a new one/);
  } finally {
    await stop(child);
  }
  // A global install (or a checkout) keeps the short name.
  assert.match(run(["--bogus"], env).stderr, /Run agent-visualizer --help for usage/);
});

test("Linux with no display: the banner doesn't claim a browser opened, and open points at --print", { skip: process.platform !== "linux" && "only Linux can lack a display (elsewhere this would open a real browser)", timeout: 30_000 }, async () => {
  const { env } = homes();
  for (const k of ["BROWSER", "CI", "DISPLAY", "WAYLAND_DISPLAY", "WSL_DISTRO_NAME"]) delete env[k];
  const { child, output } = await office(env, [], { open: true });
  try {
    assert.match(output(), /Controls\s+locked · no browser to open here: agent-visualizer open --print gives a link for yours/);
    assert.doesNotMatch(output(), /unlocked in the browser it opened/);
    const r = run(["open"], env);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /No browser to open here.*agent-visualizer open --print/);
    assert.doesNotMatch(r.stdout, /unlock\?t=|Opened/);
    assert.equal(run(["open", "--print"], env).status, 0, "--print still works");
  } finally {
    await stop(child);
  }
});

nodeTest("canOpenBrowser: Linux needs a display, $BROWSER or WSL; macOS and Windows always can; BROWSER=none never", async () => {
  const { canOpenBrowser } = await load("src/control/cli.ts");
  assert.equal(canOpenBrowser({}, "win32"), true);
  assert.equal(canOpenBrowser({}, "linux"), false, "an ssh session or a server");
  assert.equal(canOpenBrowser({ DISPLAY: ":0" }, "linux"), true);
  assert.equal(canOpenBrowser({ WAYLAND_DISPLAY: "wayland-0" }, "linux"), true);
  assert.equal(canOpenBrowser({ BROWSER: "wslview" }, "linux"), true);
  assert.equal(canOpenBrowser({ WSL_DISTRO_NAME: "Ubuntu" }, "linux"), true);
  assert.equal(canOpenBrowser({}, "freebsd"), false);
  assert.equal(canOpenBrowser({}, "darwin"), true);
  assert.equal(canOpenBrowser({ BROWSER: "none", DISPLAY: ":0" }, "linux"), false);
  assert.equal(canOpenBrowser({ BROWSER: "none" }, "darwin"), false);
});

test("openBrowser resolves false when no opener ran or it gave up, true when it exited cleanly or keeps running", async () => {
  const { openBrowser } = await load("src/control/cli.ts");
  const bin = join(TMP, "openers");
  const url = "http://127.0.0.1:1/";
  assert.equal(await openBrowser(url, { platform: "linux", opener: join(bin, "missing") }), false);
  // xdg-open with nothing to open with: "no method available", exit 3.
  assert.equal(await openBrowser(url, { platform: "linux", opener: fakeBin(bin, "gives-up", "process.exit(3)") }), false);
  assert.equal(await openBrowser(url, { platform: "linux", opener: fakeBin(bin, "opens", "process.exit(process.argv[2] === 'http://127.0.0.1:1/' ? 0 : 1)") }), true);
  assert.equal(await openBrowser(url, { platform: "linux", opener: fakeBin(bin, "stays", "setTimeout(() => {}, 5000)"), waitMs: 300 }), true);
});

test("a background service installed through npx keeps naming npx @pvgomes/agent-visualizer: its app copy isn't on PATH either", { timeout: 30_000 }, async () => {
  const { installService, readServiceFile } = await load("src/control/service.ts");
  const { env, home, ao } = homes();
  const calls = [];
  const deps = (command) => ({
    home: ao, userHome: home, platform: process.platform === "linux" ? "linux" : "darwin", uid: 501, version: "0.2.0",
    env: { PATH: env.PATH, LANG: "en_US.UTF-8" }, pkgRoot: join(NPX_CLI, "..", ".."), node: process.execPath, command,
    run: async (cmd, args) => (calls.push([cmd, ...args].join(" ")), { code: 0, out: "" }),
  });
  await installService(deps("npx @pvgomes/agent-visualizer"), { start: false, port: 4747 });
  assert.ok(calls.length && calls.every((c) => /^(launchctl|systemctl) /.test(c)), "launchctl/systemctl were only recorded");
  assert.equal(readServiceFile(ao).command, "npx @pvgomes/agent-visualizer");
  const copy = join(ao, "app", "current", "dist", "cli.js");
  const { child, info, output } = await office(env, [], { cli: copy });
  try {
    assert.match(output(), /Controls\s+locked · npx @pvgomes\/agent-visualizer open unlocks a browser/);
    const spent = await get(info.port, "/unlock?t=0.0.0", { "sec-fetch-site": "none" });
    assert.equal(spent.status, 403);
    assert.match(spent.body, /Run <code>npx @pvgomes\/agent-visualizer open<\/code> for a new one/);
  } finally {
    await stop(child);
  }
  // Installed from a global install, the copy keeps the short name.
  await installService(deps("agent-visualizer"), { start: false, port: 4747 });
  assert.equal(readServiceFile(ao).command, "agent-visualizer");
  assert.match(run(["--bogus"], env, copy).stderr, /Run agent-visualizer --help for usage/);
});
