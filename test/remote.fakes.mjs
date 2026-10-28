// Shared fakes for the remote transport tests (test/remote.*.test.mjs): a bundler for the TS
// sources, a fake HOME holding synthetic transcripts, local "sandboxes" that run commands with
// sh on this machine, tiny HTTP servers standing in for the platforms' APIs, and fake CLIs
// (ssh, railway, boat) written as node scripts. Nothing here talks to a real service.
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FX = join(ROOT, "test", "fixtures");

/** Bundle TS entry points into one temp ESM module and import it. */
export async function load(...entries) {
  const dir = mkdtempSync(join(tmpdir(), "agent-visualizer-test-"));
  const outfile = join(dir, "mod.mjs");
  await build({
    stdin: { contents: entries.map((e) => `export * from ${JSON.stringify(`./${e}`)};`).join("\n"), resolveDir: ROOT, loader: "ts" },
    bundle: true, platform: "node", format: "esm", target: "node18", outfile, logLevel: "error",
  });
  try {
    return await import(pathToFileURL(outfile).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function tmp(prefix = "agent-visualizer-remote-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** A HOME with the synthetic Claude and Codex fixtures, freshly modified so they count as live. */
export function fakeHome() {
  const home = tmp("agent-visualizer-home-");
  cpSync(join(FX, "claude"), join(home, ".claude"), { recursive: true });
  cpSync(join(FX, "codex"), join(home, ".codex"), { recursive: true });
  const now = Date.now() / 1000;
  for (const f of walk(home)) utimesSync(f, now, now);
  return home;
}

/** Run a program here as if inside the sandbox whose home is `home`. */
export function runIn(home, cmd, args, input) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { env: { PATH: process.env.PATH, HOME: home, LC_ALL: "C" }, cwd: home });
    const out = [];
    const err = [];
    c.stdout.on("data", (d) => out.push(d));
    c.stderr.on("data", (d) => err.push(d));
    c.on("close", (code) => resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
    c.stdin.on("error", () => {});
    c.stdin.end(input ?? "");
  });
}

/** An HTTP server; `handler(req, body, url)` returns {status, json} | {status, text, type}. Records requests. */
export async function serve(handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    const url = new URL(req.url, "http://x");
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
    try {
      const r = (await handler(req, body, url)) ?? { status: 404, json: { message: "no route" } };
      res.writeHead(r.status ?? 200, { "content-type": r.type ?? "application/json" });
      res.end(r.text ?? JSON.stringify(r.json ?? {}));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: String(err) }));
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  server.unref(); // a failed assertion before close() must not hang the test file
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((r) => server.close(r)),
  };
}

/** Write an executable node script named `name` into `dir`. */
export function writeBin(dir, name, source) {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, `#!${process.execPath}\n${source}\n`);
  chmodSync(p, 0o755);
  return p;
}

/** Wait until `fn()` is truthy (polling), or fail after `ms`. */
export async function until(fn, ms = 5_000, what = "condition") {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
