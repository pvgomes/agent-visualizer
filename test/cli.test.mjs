// Tests for the built CLI (dist/cli.js, built by `npm test` first): help, flag errors, office.json lifecycle.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const built = existsSync(CLI);

function env(home) {
  return { ...process.env, AGENT_VISUALIZER_HOME: home, NO_COLOR: "1", BROWSER: "none", CI: "1" };
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, agent: false }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("--help documents every command and flag", { skip: !built && "dist/cli.js not built" }, () => {
  const r = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8", env: env(tmpdir()) });
  assert.equal(r.status, 0);
  for (const word of [
    "office", "install", "uninstall", "doctor", "mcp",
    "--demo", "--port", "--host", "--no-open", "--agents", "--seed", "--name", "--herd", "--no-herdr",
    "--ssh", "--daytona", "--boat", "--railway", "--vercel", "--no-cloud", "--local-only",
    "claude", "commandcode", "codex", "opencode", "droid", "gemini", "qwen", "cursor", "copilot",
  ]) assert.ok(r.stdout.includes(word), `help mentions ${word}`);
});

test("bad flags exit 2 with a one-line error", { skip: !built && "dist/cli.js not built" }, () => {
  const r = spawnSync(process.execPath, [CLI, "--agents", "aider"], { encoding: "utf8", env: env(tmpdir()) });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown agent "aider"/);
  const ok = spawnSync(process.execPath, [CLI, "office", "--version"], { encoding: "utf8", env: env(tmpdir()) });
  assert.equal(ok.status, 0, "`office` is accepted as the explicit default command");
});

test("the office advertises itself in office.json and removes it on exit", { skip: !built && "dist/cli.js not built", timeout: 20_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "agent-visualizer-cli-"));
  try {
    const child = spawn(process.execPath, [CLI, "--demo", "--no-open", "--port", "0", "--quiet"], { env: env(home), stdio: "ignore" });
    const file = join(home, "office.json");
    let info;
    for (let i = 0; i < 100 && !info; i++) {
      await wait(100);
      try {
        info = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        // not yet
      }
    }
    assert.ok(info, "office.json appeared");
    assert.equal(info.pid, child.pid);
    assert.equal(info.demo, true);
    assert.ok(info.port > 0);
    const health = await get(info.port, "/healthz");
    assert.equal(health.status, 200);
    const exited = new Promise((r) => child.on("exit", r));
    child.kill("SIGTERM");
    await exited;
    // Windows has no SIGTERM to send: kill() ends the process outright, so nothing runs on the way out
    // (Ctrl+C there is SIGINT, which does). A stale office.json is ignored once its pid is gone.
    if (process.platform !== "win32") assert.equal(existsSync(file), false, "office.json removed on shutdown");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
