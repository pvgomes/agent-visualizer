// Tests for src/control/install-api.ts: the page's view of `agent-visualizer install` against a fake
// HOME (the dry-run plan as rows, applying it, the plan after), the npm check for an npx
// registration, and that the CLI installer still prints its plan when it reports rows.
import nodeTest, { after, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CONTROL, skipAll } from "./platform.mjs";

const test = skipAll(nodeTest, CONTROL);

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TMP = realpathSync(mkdtempSync(join(tmpdir(), "agent-visualizer-ctl-install-")));
let M;

before(async () => {
  const outfile = join(TMP, "mod.mjs");
  const entries = ["src/control/install-api.ts", "src/install/sys.ts", "src/install/installer.ts", "src/install/command.ts"];
  await build({
    stdin: { contents: entries.map((e) => `export * from ${JSON.stringify(`./${e}`)};`).join("\n"), resolveDir: ROOT, loader: "ts" },
    bundle: true, platform: "node", format: "esm", target: "node18", outfile, logLevel: "error",
  });
  M = await import(pathToFileURL(outfile).href);
});
after(() => rmSync(TMP, { recursive: true, force: true }));

function home(name) {
  const h = join(TMP, name);
  mkdirSync(join(h, ".gemini"), { recursive: true });
  const env = { HOME: h, PATH: join(TMP, "empty-bin"), AGENT_VISUALIZER_HOME: join(h, ".agent-visualizer") };
  return { h, sys: () => M.localSys({ env, home: h }) };
}

test("plan, apply, plan again: rows per agent, files as ~ paths, a masked diff, then all ok", async () => {
  const { h, sys } = home("a");
  const api = M.createInstallApi({ version: "1.2.3", script: "/opt/ao/app/current/dist/cli.js", sys });
  const plan = await api.plan();
  assert.equal(plan.applied, false);
  assert.equal(plan.agents.length, 8);
  const g = plan.agents.find((r) => r.agent === "gemini");
  assert.equal(g.found, true);
  assert.equal(g.mcp, "add");
  assert.equal(g.skill, "add");
  assert.ok(g.files.includes("~/.gemini/settings.json"), g.files.join());
  assert.match(g.diff, /\+\+\+ ~\/\.gemini\/settings\.json/);
  assert.match(g.diff, /\/opt\/ao\/app\/current\/dist\/cli\.js/, "the service's stable path is what gets registered");
  assert.deepEqual(plan.agents.find((r) => r.agent === "codex"), { agent: "codex", found: false, mcp: "skip", skill: "skip", files: [] });
  assert.ok(!existsSync(join(h, ".gemini", "settings.json")), "a plan writes nothing");
  const done = await api.apply();
  assert.equal(done.applied, true);
  const g2 = done.agents.find((r) => r.agent === "gemini");
  assert.equal(g2.mcp, "ok");
  assert.equal(g2.skill, "ok");
  assert.equal(g2.error, undefined);
  assert.match(readFileSync(join(h, ".gemini", "settings.json"), "utf8"), /agent-visualizer/);
  assert.equal((await api.plan()).agents.find((r) => r.agent === "gemini").mcp, "ok");
});

test("an npx registration is refused (with a reason on the row) unless that version is on npm", async () => {
  const { h, sys } = home("b");
  const api = M.createInstallApi({ version: "9.9.9", script: "/Users/x/.npm/_npx/abc/node_modules/agent-visualizer/dist/cli.js", sys, npmHasVersion: async () => false });
  const done = await api.apply(["gemini"]);
  const g = done.agents.find((r) => r.agent === "gemini");
  assert.match(g.error, /isn't on npm/);
  assert.ok(!existsSync(join(h, ".gemini", "settings.json")));
});

test("the CLI installer still prints its plan when a report hook is set", async () => {
  const { sys } = home("c");
  const lines = [];
  let rows;
  const code = await M.install(sys(), {
    dryRun: true, launch: M.chooseLaunch({ remote: false, version: "1.2.3", script: "/opt/ao/dist/cli.js" }), out: (l = "") => lines.push(l), report: (r) => (rows = r),
  });
  assert.equal(code, 0);
  assert.ok(lines.some((l) => /What would change/.test(l)));
  assert.equal(rows.find((r) => r.agent === "gemini").mcp, "add");
});
