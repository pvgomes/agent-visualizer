// Fakes for the session-side control tests (test/control.{pty,term,agents,sessions,chat}.test.mjs):
// a bundler that keeps the PTY library external (so the real native module loads), fake agent
// binaries written as node scripts on a private PATH, and a ControlContext whose office records
// what the session manager tells it. Nothing here runs a real agent or touches the real HOME.
import { build } from "esbuild";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
const dirs = [];

/** Bundle TS entry points into a temp ESM module (node_modules linked beside it) and import it. */
export async function load(...entries) {
  const dir = mkdtempSync(join(tmpdir(), "agent-visualizer-test-"));
  dirs.push(dir);
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  const outfile = join(dir, "mod.mjs");
  await build({
    stdin: { contents: entries.map((e) => `export * from ${JSON.stringify(`./${e}`)};`).join("\n"), resolveDir: ROOT, loader: "ts" },
    bundle: true, platform: "node", format: "esm", target: "node18", outfile, logLevel: "error",
    external: ["@lydell/node-pty"],
  });
  return import(pathToFileURL(outfile).href);
}

export function scratch(prefix = "agent-visualizer-ctl-") {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

export function cleanup() {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** Write an executable node script named `name` into dir. */
export function fakeBin(dir, name, source) {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, `#!${process.execPath}\n${source}\n`);
  chmodSync(p, 0o755);
  return p;
}

export const NODE_DIR = dirname(process.execPath);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(fn, ms = 5000, what = "condition") {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}

/*
 * A TUI stand-in. At start it records argv and which env names it got (never values) to
 * $FAKE_LOG, asks for the cursor position (DSR) and turns bracketed paste on, then reports what
 * it receives on screen: PASTE[...] for a bracketed paste, ENTER, ESC, KEY[..] otherwise. SIGHUP
 * prints HUP and exits 0, unless FAKE_IGNORE_HUP is set. FAKE_TRUST draws a folder-trust dialog.
 */
export const FAKE_TUI = String.raw`
const fs = require("node:fs");
const log = process.env.FAKE_LOG;
const names = Object.keys(process.env).filter((k) => /^(AO_|CLAUDE|CODEX|OPENCODE_|ANTHROPIC|OPENAI|TERM$|COLORTERM$|LANG$|PWD$)/.test(k)).sort();
if (log) fs.appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: names, hookToken: process.env.AO_HOOK_TOKEN ? process.env.AO_HOOK_TOKEN.length : 0 }) + "\n");
process.stdin.setRawMode?.(true);
process.stdout.write("fake tui ready\r\n\x1b[6n\x1b[?2004h");
// FAKE_TRUST: a folder-trust dialog drawn in two chunks, then quiet; "t" answers it.
if (process.env.FAKE_TRUST) {
  process.stdout.write("Quick safety check: Is this a project you created or one ");
  setTimeout(() => process.stdout.write("you trust?\r\n> No, exit\r\n  Yes, I trust this folder\r\n"), 20);
}
if (process.env.FAKE_IGNORE_HUP) process.on("SIGHUP", () => process.stdout.write("ignoring HUP\r\n"));
else process.on("SIGHUP", () => { process.stdout.write("HUP\r\n"); process.exit(0); });
let buf = "";
const say = (s) => { process.stdout.write(s + "\r\n"); if (log) fs.appendFileSync(log, JSON.stringify({ got: s }) + "\n"); };
process.stdin.on("data", (d) => {
  buf += d.toString("utf8");
  for (;;) {
    let m;
    if ((m = /^\x1b\[200~([\s\S]*?)\x1b\[201~/.exec(buf))) { say("PASTE[" + m[1].replace(/\n/g, "\\n") + "]"); buf = buf.slice(m[0].length); continue; }
    if (buf.startsWith("\x1b[200~")) break;
    if ((m = /^\x1b\[(\d+);(\d+)R/.exec(buf))) { say("CPR[" + m[1] + "," + m[2] + "]"); buf = buf.slice(m[0].length); continue; }
    if (buf === "\x1b") { say("ESC"); buf = ""; break; }
    if (buf.startsWith("\x1b") && buf.length < 3) break;
    if (buf[0] === "\r") { say("ENTER"); buf = buf.slice(1); continue; }
    // "q" may share a read with the terminal's late answer to the DSR above: quit on a leading q.
    if (buf[0] === "q") { say("BYE"); process.exit(3); }
    if (buf === "t" && process.env.FAKE_TRUST) { process.stdout.write("\x1b[2J\x1b[Htrusted\r\n"); buf = ""; break; }
    if (buf.length) { say("KEY[" + JSON.stringify(buf).slice(1, -1) + "]"); buf = ""; }
    break;
  }
});
`;

/**
 * A ControlContext with a recording OfficePort. `linkTo(workerId)` plays the transcript showing
 * up for the newest expectation.
 */
export function fakeContext(o = {}) {
  const emitted = [];
  const expectations = [];
  const held = new Set();
  const ended = [];
  const logs = [];
  const userHome = o.userHome;
  const ctx = {
    home: o.home ?? join(userHome, ".agent-visualizer"),
    userHome,
    version: "0.0.0-test",
    platform: process.platform,
    now: () => Date.now(),
    log: (m, level = "info") => logs.push(`${level}: ${m}`),
    agentEnv: () => ({ PATH: o.path, HOME: userHome, ...(o.env ?? {}) }),
    officeUrl: () => "http://127.0.0.1:4599",
    viewers: () => (o.viewers ? o.viewers() : 0),
    keys: o.keys ?? {
      list: () => [],
      put: () => { throw new Error("no"); },
      remove: () => false,
      importFromShell: async () => [],
      reveal: (names) => {
        const out = {};
        for (const n of names) {
          if (!(o.keyValues ?? {})[n]) { const e = new Error(`No stored key named ${n}.`); e.status = 400; throw e; }
          out[n] = o.keyValues[n];
        }
        return out;
      },
      platformEnv: () => ({}),
      onChange: () => ({ dispose() {} }),
    },
    office: {
      emit: (e) => emitted.push(e),
      expect: (x) => {
        const rec = { ...x, disposed: false };
        expectations.push(rec);
        return { dispose: () => void (rec.disposed = true) };
      },
      hold: (id) => held.add(id),
      release: (id) => held.delete(id),
      end: (id) => { ended.push(id); held.delete(id); },
      workersOn: () => 0,
      recentFolders: () => o.recent ?? [],
    },
  };
  return {
    ctx, emitted, expectations, held, ended, logs,
    linkTo(workerId) {
      const x = expectations.filter((e) => !e.disposed).at(-1);
      x.onLinked(workerId);
      return x;
    },
  };
}
