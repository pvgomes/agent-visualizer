// Tests for src/install: the JSONC and TOML span editors, and install / uninstall / doctor for
// every agent against fake HOMEs (fresh, existing configs, idempotent re-runs, byte-exact restore,
// malformed configs, dry runs, the claude/codex CLI route via shims, and a remote install through a
// fake RemoteTarget). All config contents here are synthetic; the real HOME is never touched.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { spawnSync, spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { POSIX } from "./platform.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), "agent-visualizer-install-test-"));
const CLI = join(TMP, "cli.mjs");
let M;

before(async () => {
  const outfile = join(TMP, "mod.mjs");
  const entries = ["src/install/jsonc.ts", "src/install/toml.ts", "src/install/installer.ts", "src/install/sys.ts", "src/install/command.ts", "src/install/agents.ts", "src/install/skill.ts", "src/install/diff.ts", "src/install/remotes.ts"];
  await build({
    stdin: { contents: entries.map((e) => `export * from ${JSON.stringify(`./${e}`)};`).join("\n"), resolveDir: ROOT, loader: "ts" },
    bundle: true, platform: "node", format: "esm", target: "node18", outfile, logLevel: "error",
  });
  await build({ entryPoints: [join(ROOT, "src/cli.ts")], outfile: CLI, bundle: true, platform: "node", format: "esm", target: "node18", logLevel: "error" });
  M = await import(pathToFileURL(outfile).href);
});
after(() => rmSync(TMP, { recursive: true, force: true }));

/* ------------------------------------------------------------------ JSONC */

const ENTRY = { command: "node", args: ["/x y/cli.js", "mcp"] };

const JSON_CASES = {
  "pretty, other servers": '{\n  "mcpServers": {\n    "a": { "command": "a" }\n  },\n  "theme": "dark"\n}\n',
  "tabs": '{\n\t"mcpServers": {\n\t\t"a": {\n\t\t\t"command": "a"\n\t\t}\n\t}\n}\n',
  "jsonc comments + trailing commas": '{\n  // servers\n  "mcpServers": {\n    "a": { "command": "a" }, // keep me\n  },\n  /* block */ "x": [1, 2,],\n}\n',
  "minified": '{"mcpServers":{"a":{"command":"a"}},"y":1}',
  "empty container": '{\n  "mcpServers": {}\n}\n',
  "no container, no trailing newline": '{\n  "security": { "auth": { "selectedType": "oauth" } },\n  "model": { "name": "m" }\n}',
  "no container, comment after last": '{\n  "a": 1 // last\n}\n',
  "empty object": "{}",
  "bom": '\ufeff{\n  "mcpServers": {\n    "a": {}\n  }\n}\n',
};

test("JSONC: set then delete restores every format byte-for-byte; untouched parts stay identical", () => {
  for (const [name, text] of Object.entries(JSON_CASES)) {
    const had = M.nodeAt(M.parseJsonc(text), ["mcpServers"]);
    const added = M.setPath(text, ["mcpServers", "agent-visualizer"], ENTRY);
    const v = M.readJsonc(added);
    assert.deepEqual(v.mcpServers["agent-visualizer"], ENTRY, name);
    const before = M.readJsonc(text);
    delete v.mcpServers["agent-visualizer"];
    if (!had) delete v.mcpServers;
    assert.deepEqual(v, before, `${name}: nothing else changed`);
    let removed = M.deletePath(added, ["mcpServers", "agent-visualizer"]);
    if (!had) removed = M.deletePath(removed, ["mcpServers"]);
    assert.equal(removed, text, `${name}: byte-exact restore`);
    // Replacing our entry is in place.
    const replaced = M.setPath(added, ["mcpServers", "agent-visualizer"], { command: "npx", args: [] });
    assert.deepEqual(M.readJsonc(replaced).mcpServers["agent-visualizer"], { command: "npx", args: [] }, name);
  }
  assert.ok(M.setPath(JSON_CASES["jsonc comments + trailing commas"], ["mcpServers", "agent-visualizer"], ENTRY).includes("// keep me"));
});

test("JSONC: empty documents, broken documents, non-object parents", () => {
  assert.equal(M.setPath("", ["mcp", "agent-visualizer"], { a: 1 }), '{\n  "mcp": {\n    "agent-visualizer": {\n      "a": 1\n    }\n  }\n}\n');
  for (const bad of ['{ "a": ', '{"a": 1} trailing', "[1, 2", '{"a": "unterminated}', "{'a': 1}"]) {
    assert.throws(() => M.setPath(bad, ["mcpServers", "x"], 1), M.JsoncError, bad);
  }
  assert.throws(() => M.setPath('{"mcpServers": []}', ["mcpServers", "x"], 1), /not an object/);
  assert.throws(() => M.setPath("[]", ["mcpServers", "x"], 1), /not an object/);
  assert.equal(M.deletePath('{"a": 1}', ["mcpServers", "x"]), '{"a": 1}');
  assert.equal(M.readJsonc('{"s": "a\\nb\\u0041", "n": -1.5e3, "t": true, "z": null}').s, "a\nbA");
});

/* ------------------------------------------------------------------- TOML */

const TOML = `# Codex config
model = "gpt-5.5"
notes = """
[mcp_servers.agent-visualizer]
this is inside a string, not a header
"""

[mcp_servers.sandbox]
command = "sandbox-mcp" # inline comment
args = []

[mcp_servers.sandbox.env]
X = "1"

[projects."/Users/x/#odd [dir]"]
trust_level = "trusted"
`;

test("TOML: add, replace and remove our table only; headers inside strings and odd keys are safe", () => {
  const body = ['command = "node"', 'args = ["/a b/cli.js", "mcp", "--agent", "codex"]'];
  const added = M.setTable(TOML, ["mcp_servers", "agent-visualizer"], body);
  assert.ok(added.startsWith(TOML), "the user's text is untouched");
  assert.ok(M.hasTable(added, ["mcp_servers", "agent-visualizer"]));
  assert.deepEqual(M.readCommand(added, ["mcp_servers", "agent-visualizer"]), { command: "node", args: ["/a b/cli.js", "mcp", "--agent", "codex"] });
  assert.equal(M.hasTable(TOML, ["mcp_servers", "agent-visualizer"]), false, "the string's fake header doesn't count");
  const replaced = M.setTable(added, ["mcp_servers", "agent-visualizer"], ['command = "npx"', "args = []", "enabled = false"]);
  assert.equal(replaced.match(/\[mcp_servers\.agent-visualizer\]/g).length, 2, "one real header plus the one in the string");
  assert.equal(M.readCommand(replaced, ["mcp_servers", "agent-visualizer"]).enabled, false);
  assert.equal(M.removeTable(added, ["mcp_servers", "agent-visualizer"]), TOML, "byte-exact restore");
  assert.equal(M.removeTable(TOML, ["mcp_servers", "sandbox"]).includes("X = "), false, "subtables go with their table");
  assert.ok(M.removeTable(TOML, ["mcp_servers", "sandbox"]).includes('[projects."/Users/x/#odd [dir]"]'));
  assert.equal(M.setTable("", ["mcp_servers", "agent-visualizer"], body), `[mcp_servers.agent-visualizer]\n${body.join("\n")}\n`);
  // Definitions we can't edit by lines are refused, never guessed at.
  assert.throws(() => M.setTable('mcp_servers = { agent-visualizer = { command = "x" } }\n', ["mcp_servers", "agent-visualizer"], body), M.TomlEditError);
  assert.throws(() => M.setTable('[mcp_servers]\nagent-visualizer.command = "x"\n', ["mcp_servers", "agent-visualizer"], body), M.TomlEditError);
  assert.deepEqual(M.splitKey('a."b.c".\'d\''), ["a", "b.c", "d"]);
});

test("TOML: a \"\"\" in a comment or a one-line string never hides the tables after it", () => {
  const text = '# tip: multi-line prompts go in """ strings\nmodel = "x"\nnote = "a \'\'\' b"\n\n[mcp_servers.agent-visualizer]\ncommand = "old"\nargs = []\n';
  assert.equal(M.hasTable(text, ["mcp_servers", "agent-visualizer"]), true);
  const next = M.updateTable(text, ["mcp_servers", "agent-visualizer"], { command: '"node"', args: '["cli.js"]', enabled: null });
  assert.equal(M.tableCount(next, ["mcp_servers", "agent-visualizer"]), 1);
  assert.deepEqual(M.readCommand(next, ["mcp_servers", "agent-visualizer"]), { command: "node", args: ["cli.js"] });
  // A real multi-line string still hides a header-looking line inside it.
  const ml = 'prompt = """\n[mcp_servers.agent-visualizer]\n"""\n';
  assert.equal(M.hasTable(ml, ["mcp_servers", "agent-visualizer"]), false);
});

test("TOML: re-registering keeps the user's own keys, comments and subtables in our table", () => {
  const text = '[mcp_servers.agent-visualizer]\n# mine\ncommand = "old"\nargs = [\n  "a",\n  "b",\n]\nstartup_timeout_sec = 30\nenabled = false\n\n[mcp_servers.agent-visualizer.env]\nAGENT_VISUALIZER_HOME = "/Volumes/work/.agent-visualizer"\n\n[other]\nx = 1\n';
  const next = M.updateTable(text, ["mcp_servers", "agent-visualizer"], { command: '"node"', args: '["cli.js", "mcp"]', enabled: null });
  assert.deepEqual(M.readCommand(next, ["mcp_servers", "agent-visualizer"]), { command: "node", args: ["cli.js", "mcp"] });
  for (const keep of ["# mine", "startup_timeout_sec = 30", "[mcp_servers.agent-visualizer.env]", 'AGENT_VISUALIZER_HOME = "/Volumes/work/.agent-visualizer"', "[other]"]) assert.ok(next.includes(keep), keep);
  assert.ok(!next.includes("enabled = false") && !next.includes('"a",'), next);
  assert.deepEqual(M.tableKeys(text, ["mcp_servers", "agent-visualizer"]).sort(), ["args", "command", "enabled", "env", "startup_timeout_sec"]);
});

test("diff masks secrets anywhere on a line, minified files included", () => {
  const before = '{"mcpServers":{"github":{"command":"npx","args":["-y","x","ghp_ArgTokenValue0123456789abcdefABCD"],"env":{"GITHUB_PERSONAL_ACCESS_TOKEN":"ghp_R3alLookingTokenValue0123456789abcd","LINEAR_API_KEY":"lin_api_SECRETCANARYVALUE42"}}}}';
  const after = M.setPath(before, ["mcpServers", "agent-visualizer"], { command: "/Users/me/.nvm/versions/node/v22.11.0/bin/node", args: ["/Users/me/agent-visualizer/dist/cli.js"] });
  const shown = M.diffHunk(before, after).lines.map((l) => l.text).join("\n");
  for (const secret of ["ArgTokenValue", "R3alLooking", "SECRETCANARY"]) assert.ok(!shown.includes(secret), shown);
  assert.ok(shown.includes("/Users/me/.nvm/versions/node/v22.11.0/bin/node"), "our own paths stay readable");
  assert.ok(!M.maskLine('password = "hunter2"  # x').includes("hunter2"));
  assert.ok(!M.maskLine('[x]\nheaders = { Authorization = "Bearer abc.def" }').includes("abc.def"));
});

test("diff masks secrets in context lines", () => {
  const before = '{\n  "headers": {\n    "API_KEY": "abc123"\n  },\n  "x": 1\n}\n';
  const after = M.setPath(before, ["mcpServers", "agent-visualizer"], ENTRY);
  const h = M.diffHunk(before, after);
  const shown = h.lines.map((l) => l.text).join("\n");
  assert.ok(!shown.includes("abc123"), shown);
  assert.ok(shown.includes("agent-visualizer"));
});

/* --------------------------------------------------------- fake machines */

/** Synthetic configs shaped like the real ones. */
const EXISTING = {
  ".claude.json": '{\n  "numStartups": 3,\n  "mcpServers": {\n    "context7": {\n      "type": "http",\n      "url": "https://mcp.context7.com/mcp",\n      "headers": { "CONTEXT7_API_KEY": "ctx7-not-a-real-key" }\n    }\n  },\n  "projects": {}\n}\n',
  ".codex/config.toml": TOML,
  ".commandcode/mcp.json": '{\n\t"mcpServers": {\n\t\t"aside": {\n\t\t\t"transport": "stdio",\n\t\t\t"command": "aside",\n\t\t\t"args": ["mcp"]\n\t\t}\n\t}\n}\n',
  ".config/opencode/opencode.json": '{\n  // mine\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": {\n    "aside": { "type": "local", "command": ["aside", "mcp"], "enabled": true }, // keep\n  },\n  "plugin": ["a"],\n}\n',
  ".factory/mcp.json": '{"mcpServers":{"railway":{"disabled":false,"type":"http","url":"https://x"}}}',
  ".qwen/settings.json": '{\n  "security": { "auth": { "selectedType": "oauth" } },\n  "model": { "name": "qwen3-coder" }\n}',
  ".cursor/mcp.json": '{\n  "mcpServers": {\n    "sandbox": { "command": "sandbox", "args": [] }\n  }\n}\n',
};
const DIRS = [".claude", ".codex", ".commandcode", ".config/opencode", ".factory", ".gemini", ".qwen", ".cursor"];

function makeHome(withConfigs = true) {
  const home = mkdtempSync(join(TMP, "home-"));
  for (const d of DIRS) mkdirSync(join(home, d), { recursive: true });
  if (withConfigs) for (const [f, t] of Object.entries(EXISTING)) writeFileSync(join(home, f), t);
  const bin = join(home, "bin");
  mkdirSync(bin);
  return { home, bin };
}

/** Every file under `dir` -> content, skipping backups. */
function snapshot(dir, { backups = false } = {}) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (backups || !name.includes(".agent-visualizer-backup-")) out[p.slice(dir.length + 1).replaceAll("\\", "/")] = readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

const LAUNCH = () => M.chooseLaunch({ remote: false, script: "/opt/agent-visualizer/dist/cli.js", node: "/usr/local/bin/node" });

function run(fn, sys, extra = {}) {
  const lines = [];
  return fn(sys, { launch: LAUNCH(), yes: true, out: (l = "") => lines.push(l), now: () => new Date(2026, 9, 18, 5, 0, 0), ...extra }).then((code) => ({ code, text: lines.join("\n") }));
}

const AGENT_FILES = {
  claude: [".claude.json", ["mcpServers", "agent-visualizer"]],
  commandcode: [".commandcode/mcp.json", ["mcpServers", "agent-visualizer"]],
  opencode: [".config/opencode/opencode.json", ["mcp", "agent-visualizer"]],
  droid: [".factory/mcp.json", ["mcpServers", "agent-visualizer"]],
  gemini: [".gemini/settings.json", ["mcpServers", "agent-visualizer"]],
  qwen: [".qwen/settings.json", ["mcpServers", "agent-visualizer"]],
  cursor: [".cursor/mcp.json", ["mcpServers", "agent-visualizer"]],
};
const SKILLS = {
  claude: ".claude/skills", codex: ".agents/skills", commandcode: ".commandcode/skills", opencode: ".config/opencode/skills",
  droid: ".factory/skills", gemini: ".gemini/skills", qwen: ".qwen/skills", cursor: ".cursor/skills",
};

function assertInstalled(home, launchFor) {
  for (const [agent, [file, path]] of Object.entries(AGENT_FILES)) {
    const v = M.readJsonc(readFileSync(join(home, file), "utf8"));
    const e = path.reduce((o, k) => o?.[k], v);
    const cmd = launchFor(agent);
    if (agent === "opencode") assert.deepEqual(e, { type: "local", command: [cmd.command, ...cmd.args], enabled: true });
    else {
      assert.equal(e.command, cmd.command, agent);
      assert.deepEqual(e.args, cmd.args, agent);
    }
    if (agent === "claude") assert.equal(e.type, "stdio");
    if (agent === "commandcode") assert.equal(e.transport, "stdio");
    if (agent === "droid") assert.equal(e.disabled, false);
  }
  const toml = readFileSync(join(home, ".codex/config.toml"), "utf8");
  const c = launchFor("codex");
  assert.deepEqual(M.readCommand(toml, ["mcp_servers", "agent-visualizer"]), { command: c.command, args: c.args });
  for (const [agent, dir] of Object.entries(SKILLS)) {
    const skill = readFileSync(join(home, dir, "agent-visualizer", "SKILL.md"), "utf8");
    assert.equal(skill, M.SKILL_TEXT, agent);
  }
}

test("skill file: valid frontmatter every agent accepts", () => {
  const t = M.SKILL_TEXT;
  assert.ok(t.startsWith("---\nname: agent-visualizer\ndescription: "), "frontmatter on line 1 (Qwen requires it)");
  const desc = /^description: (.*)$/m.exec(t)[1];
  assert.ok(desc.length > 100 && desc.length <= 1024, `description length ${desc.length}`);
  assert.ok(M.isOurSkill(t));
  for (const tool of ["office_status", "office_peers", "office_shout", "office_celebrate", "office_flip"]) assert.ok(t.includes(tool), tool);
  assert.equal(readFileSync(join(ROOT, "skills/agent-visualizer/SKILL.md"), "utf8"), t, "bundled copy matches the repo file");
});

test("install on a machine with existing configs, re-run is a no-op, uninstall restores byte-for-byte", async () => {
  const { home, bin } = makeHome(true);
  const sys = M.localSys({ env: { HOME: home, PATH: bin }, home });
  const original = snapshot(home);

  const first = await run(M.install, sys);
  assert.equal(first.code, 0, first.text);
  const launch = LAUNCH();
  assertInstalled(home, (a) => M.launchFor(launch, a));
  // The user's other entries survive (and their secrets aren't printed).
  assert.ok(readFileSync(join(home, ".claude.json"), "utf8").includes("ctx7-not-a-real-key"));
  assert.ok(!first.text.includes("ctx7-not-a-real-key"));
  assert.ok(readFileSync(join(home, ".config/opencode/opencode.json"), "utf8").includes("// keep"));
  // Backups of every pre-existing file, identical to the original.
  const withBackups = snapshot(home, { backups: true });
  for (const f of Object.keys(EXISTING)) {
    const b = Object.keys(withBackups).find((p) => p.startsWith(f + ".agent-visualizer-backup-"));
    assert.ok(b, `backup of ${f}`);
    assert.equal(withBackups[b], EXISTING[f]);
  }
  if (process.platform !== "win32") assert.equal(statSync(join(home, ".agent-visualizer")).mode & 0o777, 0o700);

  const afterFirst = snapshot(home, { backups: true });
  const second = await run(M.install, sys);
  assert.equal(second.code, 0);
  assert.match(second.text, /Everything is already in place/);
  assert.deepEqual(snapshot(home, { backups: true }), afterFirst, "second run changes nothing, no new backups");

  const un = await run(M.uninstall, sys);
  assert.equal(un.code, 0, un.text);
  assert.deepEqual(snapshot(home), original, "every config is back to the byte, created files are gone");
  assert.equal(existsSync(join(home, ".agents")), false, "skill folders we created are removed");
  assert.equal(existsSync(join(home, ".claude/skills")), false);
});

test("fresh machine: install creates configs, uninstall removes them again", async () => {
  const { home, bin } = makeHome(false);
  const sys = M.localSys({ env: { HOME: home, PATH: bin }, home });
  const original = snapshot(home);
  const r = await run(M.install, sys);
  assert.equal(r.code, 0, r.text);
  assertInstalled(home, (a) => M.launchFor(LAUNCH(), a));
  const un = await run(M.uninstall, sys);
  assert.equal(un.code, 0, un.text);
  assert.deepEqual(snapshot(home), original);
});

test("a user's own changes to our entry are kept; a stale command is refreshed", async () => {
  const { home, bin } = makeHome(false);
  writeFileSync(join(home, ".gemini/settings.json"), '{\n  "mcpServers": {\n    "agent-visualizer": { "command": "old-node", "args": ["old.js"], "trust": true, "timeout": 5000 }\n  }\n}\n');
  writeFileSync(join(home, ".factory/mcp.json"), JSON.stringify({ mcpServers: { "agent-visualizer": { ...M.adapterFor("droid").entry(M.launchFor(LAUNCH(), "droid")), disabled: true } } }));
  const sys = M.localSys({ env: { HOME: home, PATH: bin }, home });
  const r = await run(M.install, sys, { agents: ["gemini", "droid"] });
  assert.equal(r.code, 0, r.text);
  const g = M.readJsonc(readFileSync(join(home, ".gemini/settings.json"), "utf8")).mcpServers["agent-visualizer"];
  assert.equal(g.command, "/usr/local/bin/node");
  assert.equal(g.trust, true);
  assert.equal(g.timeout, 5000);
  assert.equal(M.readJsonc(readFileSync(join(home, ".factory/mcp.json"), "utf8")).mcpServers["agent-visualizer"].disabled, false, "re-enabled");
});

test("a malformed config is reported and left untouched; everything else still installs", async () => {
  const { home, bin } = makeHome(true);
  const broken = '{ "mcpServers": { "x": ';
  writeFileSync(join(home, ".cursor/mcp.json"), broken);
  writeFileSync(join(home, ".codex/config.toml"), 'mcp_servers = { agent-visualizer = { command = "x" } }\n');
  const sys = M.localSys({ env: { HOME: home, PATH: bin }, home });
  const r = await run(M.install, sys);
  assert.equal(r.code, 1);
  assert.match(r.text, /~[\\/]\.cursor[\\/]mcp\.json can't be edited safely/);
  assert.match(r.text, /config\.toml: "mcp_servers" is set inline/);
  assert.equal(readFileSync(join(home, ".cursor/mcp.json"), "utf8"), broken);
  assert.equal(readFileSync(join(home, ".codex/config.toml"), "utf8"), 'mcp_servers = { agent-visualizer = { command = "x" } }\n');
  assert.ok(M.readJsonc(readFileSync(join(home, ".qwen/settings.json"), "utf8")).mcpServers["agent-visualizer"]);
  assert.ok(existsSync(join(home, ".cursor/skills/agent-visualizer/SKILL.md")), "the skill still goes in");
  const rows = await M.diagnose(sys);
  assert.equal(rows.find((x) => x.agent === "cursor").mcp, "unreadable");
});

test("dry run prints the plan and diffs and writes nothing", async () => {
  const { home, bin } = makeHome(true);
  const sys = M.localSys({ env: { HOME: home, PATH: bin }, home });
  const before = snapshot(home, { backups: true });
  const r = await run(M.install, sys, { dryRun: true, yes: false });
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /dry run/);
  assert.match(r.text, /What would change/);
  assert.match(r.text, /\+ \[mcp_servers\.agent-visualizer\]/);
  assert.match(r.text, /~[\\/]\.agents[\\/]skills[\\/]agent-visualizer[\\/]SKILL\.md \(new file/);
  assert.deepEqual(snapshot(home, { backups: true }), before);
  await run(M.install, sys);
  const installed = snapshot(home, { backups: true });
  const u = await run(M.uninstall, sys, { dryRun: true, yes: false });
  assert.equal(u.code, 0);
  assert.deepEqual(snapshot(home, { backups: true }), installed);
  // Without --yes and without a terminal to ask on, nothing is applied.
  const { home: h2, bin: b2 } = makeHome(true);
  const s2 = M.localSys({ env: { HOME: h2, PATH: b2 }, home: h2 });
  const snap2 = snapshot(h2, { backups: true });
  const n = await run(M.install, s2, { yes: false });
  assert.equal(n.code, 1);
  assert.match(n.text, /Nothing written/);
  assert.deepEqual(snapshot(h2, { backups: true }), snap2);
});

test("--agents limits the run; agents that aren't installed are skipped", async () => {
  const { home, bin } = makeHome(false);
  rmSync(join(home, ".gemini"), { recursive: true });
  const sys = M.localSys({ env: { HOME: home, PATH: bin }, home });
  const r = await run(M.install, sys, { agents: ["qwen", "gemini"] });
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /Gemini CLI.*isn't installed here/);
  assert.ok(existsSync(join(home, ".qwen/settings.json")));
  assert.equal(existsSync(join(home, ".claude.json")), false);
  assert.equal(existsSync(join(home, ".gemini")), false, "never creates a config folder for an agent that isn't there");
});

/** A shim CLI that logs its argv and optionally does the job by editing the config the way the real CLI would. */
function shim(bin, name, logFile, script) {
  const js = join(bin, `${name}.mjs`);
  writeFileSync(js, `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(logFile)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n${script ?? ""}\n`);
  // On Windows a .cmd like npm's shims, which the installer can only start through cmd.exe.
  if (process.platform === "win32") return writeFileSync(join(bin, `${name}.cmd`), `@"${process.execPath}" "${js}" %*\r\n`);
  writeFileSync(join(bin, name), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(js)} "$@"\n`);
  chmodSync(join(bin, name), 0o755);
}

test("claude and codex go through their own CLIs when present, verified, with a file fallback", async (t) => {
  const { home, bin } = makeHome(true);
  const log = join(home, "cli.log");
  // Starting the CLIs never trips a Node warning (on Windows: DEP0190, an args array handed to a shell).
  const warnings = [];
  const onWarning = (w) => warnings.push(`${w.code ?? w.name}: ${w.message}`);
  process.on("warning", onWarning);
  t.after(() => process.off("warning", onWarning));
  // claude: a working `mcp add`/`remove` that edits ~/.claude.json like the real one.
  shim(bin, "claude", log, `
import { readFileSync, writeFileSync } from "node:fs";
const a = process.argv.slice(2), f = process.env.HOME + "/.claude.json";
const j = JSON.parse(readFileSync(f, "utf8"));
if (a[1] === "add") { const i = a.indexOf("--"); j.mcpServers ??= {}; if (j.mcpServers[a[4]]) { console.log("already exists"); process.exit(1); } j.mcpServers[a[4]] = { type: "stdio", command: a[i + 1], args: a.slice(i + 2), env: {} }; }
if (a[1] === "remove") delete j.mcpServers[a[4]];
writeFileSync(f, JSON.stringify(j, null, 2) + "\\n");`);
  // codex: a CLI that exits 0 but doesn't actually register anything.
  shim(bin, "codex", log);
  const sys = M.localSys({ env: { HOME: home, PATH: bin }, home });
  const r = await run(M.install, sys, { agents: ["claude", "codex"] });
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /Claude Code.*registered with claude mcp add/);
  assert.match(r.text, /Codex.*registered in ~[\\/]\.codex[\\/]config\.toml \(codex mcp add didn't take/);
  const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const cmd = M.launchFor(LAUNCH(), "claude");
  assert.deepEqual(calls[0], ["mcp", "add", "--scope", "user", "agent-visualizer", "--", cmd.command, ...cmd.args]);
  assert.deepEqual(calls[1].slice(0, 4), ["mcp", "add", "agent-visualizer", "--"]);
  assertInstalledSubset(home);
  // Changing the command: claude needs remove + add.
  const moved = M.chooseLaunch({ remote: false, script: "/new/place/dist/cli.js", node: "/usr/local/bin/node" });
  const lines = [];
  assert.equal(await M.install(sys, { launch: moved, yes: true, agents: ["claude"], out: (l = "") => lines.push(l) }), 0, lines.join("\n"));
  const after = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).slice(2);
  assert.deepEqual(after.map((c) => c[1]), ["remove", "add"]);
  assert.equal(M.readJsonc(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers["agent-visualizer"].args[0], "/new/place/dist/cli.js");
  // Uninstall uses `claude mcp remove`.
  const u = await run(M.uninstall, sys, { agents: ["claude"] });
  assert.equal(u.code, 0, u.text);
  assert.equal(M.readJsonc(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers["agent-visualizer"], undefined);
  assert.ok(M.readJsonc(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers.context7, "other servers kept");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(warnings.filter((w) => /DEP0190|child process/i.test(w)), []);
});

test("on Windows the installer runs an agent's CLI from PATH, never one sitting in the current folder", { skip: process.platform !== "win32" && "Windows only" }, async () => {
  const { home, bin } = makeHome(false);
  const dir = mkdtempSync(join(TMP, "cwd-"));
  // An .exe named like the CLI where `agent-visualizer install` happens to run (a cloned repo, say).
  copyFileSync(join(process.env.SystemRoot || "C:\\Windows", "System32", "whoami.exe"), join(dir, "claude.exe"));
  const sys = M.localSys({ env: { PATH: bin, PATHEXT: ".EXE;.CMD", SystemRoot: process.env.SystemRoot }, home });
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const r = await sys.run(["claude", "--version"], 10_000);
    assert.equal(r.code, 127, r.out);
    assert.match(r.out, /claude: not found on PATH/);
  } finally {
    process.chdir(cwd);
  }
});

function assertInstalledSubset(home) {
  assert.ok(M.readJsonc(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers["agent-visualizer"]);
  assert.ok(M.hasTable(readFileSync(join(home, ".codex/config.toml"), "utf8"), ["mcp_servers", "agent-visualizer"]));
}

test("launch choice: npx cache -> npx; checkout -> absolute node + script; remote -> npx", () => {
  assert.equal(M.chooseLaunch({ remote: false, script: "/Users/me/.npm/_npx/abc123/node_modules/agent-visualizer/dist/cli.js" }).how, "npx");
  assert.equal(M.chooseLaunch({ remote: false, script: "/tmp/dlx-12345/node_modules/agent-visualizer/dist/cli.js" }).how, "npx");
  const local = M.chooseLaunch({ remote: false, script: "/Users/me/agent-visualizer/dist/cli.js", node: "/opt/homebrew/bin/node" });
  assert.deepEqual(M.launchFor(local, "qwen"), { command: "/opt/homebrew/bin/node", args: ["/Users/me/agent-visualizer/dist/cli.js", "mcp", "--agent", "qwen"] });
  // Pinned to the running version, never @latest.
  assert.deepEqual(M.launchFor(M.chooseLaunch({ remote: true, version: "0.1.0" }), "codex"), { command: "npx", args: ["-y", "agent-visualizer@0.1.0", "mcp", "--agent", "codex"] });
  assert.equal(M.npxPackage("1.2.3-beta.1"), "agent-visualizer@1.2.3-beta.1");
});

test("selfCommand: hints name npx agent-visualizer from an npx cache, where agent-visualizer isn't on PATH", () => {
  assert.equal(M.selfCommand("/Users/me/.npm/_npx/abc123/node_modules/agent-visualizer/dist/cli.js"), "npx agent-visualizer");
  assert.equal(M.selfCommand("/tmp/dlx-12345/node_modules/agent-visualizer/dist/cli.js"), "npx agent-visualizer");
  assert.equal(M.selfCommand("/opt/homebrew/lib/node_modules/agent-visualizer/dist/cli.js"), "agent-visualizer");
  assert.equal(M.selfCommand("/Users/me/agent-visualizer/dist/cli.js"), "agent-visualizer");
});

test("stableNode never registers a node found through a relative PATH entry", () => {
  const dir = mkdtempSync(join(TMP, "relpath-"));
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  symlinkSync(realpathSync(process.execPath), join(dir, "node_modules", ".bin", "node"));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const got = M.stableNode(process.execPath, "node_modules/.bin:/nonexistent");
    assert.ok(isAbsolute(got), got);
    const l = M.chooseLaunch({ remote: false, script: "/opt/agent-visualizer/dist/cli.js", node: "node_modules/.bin/node" });
    assert.ok(isAbsolute(l.base[0]), l.base[0]);
  } finally {
    process.chdir(cwd);
  }
});

test("npmHasVersion: published, missing, unreachable", async () => {
  const fake = (status, body) => async () => ({ status, ok: status < 300, json: async () => body });
  assert.equal(await M.npmHasVersion("0.1.0", { fetch: fake(200, { name: "agent-visualizer", version: "0.1.0", dist: { tarball: "https://x/t.tgz" } }) }), true);
  assert.equal(await M.npmHasVersion("0.1.0", { fetch: fake(404, {}) }), false);
  assert.equal(await M.npmHasVersion("0.1.0", { fetch: fake(200, { name: "someone-else", version: "0.1.0", dist: { tarball: "x" } }) }), false);
  assert.equal(await M.npmHasVersion("0.1.0", { fetch: async () => { throw new Error("offline"); } }), null);
});

/* ------------------------------------------------------------- remote */

/**
 * node and npx alone in a folder, for the fake remote's PATH. Not node's own bin folder: with nvm
 * or a global npm install, the real claude and codex sit there too, and the installer would run them.
 */
function nodeOnlyBin() {
  const dir = join(TMP, "node-bin");
  if (!existsSync(dir)) {
    mkdirSync(dir);
    symlinkSync(process.execPath, join(dir, "node"));
    symlinkSync(join(dirname(process.execPath), "npx"), join(dir, "npx"));
  }
  return dir;
}

/** A RemoteTarget that runs `sh -c` here, with HOME pointed at a fake remote home. */
function fakeRemote(home) {
  return {
    host: { kind: "vercel", id: "vercel:sbx_test", name: "sbx-test" },
    exec(script) {
      return new Promise((resolve, reject) => {
        const child = spawn("/bin/sh", ["-c", script], { env: { HOME: home, PATH: "/usr/bin:/bin:" + nodeOnlyBin() } });
        let out = "";
        let err = "";
        child.stdout.on("data", (c) => (out += c));
        child.stderr.on("data", (c) => (err += c));
        child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${err}`))));
      });
    },
  };
}

test("remote install through a RemoteTarget: npx command, same files, uninstall restores", { skip: POSIX }, async () => {
  const { home } = makeHome(true);
  const original = snapshot(home);
  const sys = await M.remoteSys(fakeRemote(home));
  assert.equal(sys.remote, true);
  assert.equal(sys.home, home);
  const lines = [];
  const launch = M.chooseLaunch({ remote: true });
  const code = await M.install(sys, { launch, yes: true, out: (l = "") => lines.push(l) });
  assert.equal(code, 0, lines.join("\n"));
  assert.match(lines.join("\n"), /install on vercel:sbx_test/);
  assertInstalled(home, (a) => M.launchFor(launch, a));
  assert.ok(readFileSync(join(home, ".claude.json"), "utf8").includes("ctx7-not-a-real-key"));
  assert.equal(statSync(join(home, ".agent-visualizer/installed.json")).mode & 0o777, 0o600);
  const rows = await M.diagnose(await M.remoteSys(fakeRemote(home)));
  assert.ok(rows.every((r) => r.mcp === "registered" && r.skill === "installed"), JSON.stringify(rows));
  const again = [];
  assert.equal(await M.install(await M.remoteSys(fakeRemote(home)), { launch, yes: true, out: (l = "") => again.push(l) }), 0);
  assert.match(again.join("\n"), /Everything is already in place/);
  const un = [];
  assert.equal(await M.uninstall(await M.remoteSys(fakeRemote(home)), { launch, yes: true, out: (l = "") => un.push(l) }), 0, un.join("\n"));
  assert.deepEqual(snapshot(home), original);
});

test("remote install explains a missing Node instead of registering a dead command", { skip: POSIX }, async () => {
  const { home } = makeHome(true);
  const real = await M.remoteSys(fakeRemote(home));
  const sys = { ...real, which: async (b) => (b === "node" || b === "npx" ? null : real.which(b)) };
  const lines = [];
  const code = await M.install(sys, { launch: M.chooseLaunch({ remote: true }), yes: true, out: (l = "") => lines.push(l) });
  assert.equal(code, 1);
  assert.match(lines.join("\n"), /Node\.js isn't installed on vercel:sbx_test/);
  assert.ok(!existsSync(join(home, ".gemini/settings.json")));
});

test("--ssh: the built-in ssh target survives a real shell's quoting (fake ssh, local sh)", { skip: POSIX }, async () => {
  const { home, bin } = makeHome(true);
  // Stands in for ssh: drops the options and host, then hands the command string to a shell in a
  // fresh environment, as sshd does (the runner's own XDG_CONFIG_HOME must not leak into the "remote").
  const fakeSsh = join(bin, "fake-ssh");
  writeFileSync(fakeSsh, `#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done; shift\nexec env -i HOME=${JSON.stringify(home)} PATH=/usr/bin:/bin:${JSON.stringify(nodeOnlyBin())} /bin/sh -c "$*"\n`);
  chmodSync(fakeSsh, 0o755);
  const original = snapshot(home);
  const target = M.sshTarget("dev@box", { sshBin: fakeSsh });
  assert.equal(target.host.id, "ssh:dev@box");
  assert.throws(() => M.sshTarget("-oProxyCommand=evil"), /doesn't look like an ssh host/);
  const launch = M.chooseLaunch({ remote: true });
  const lines = [];
  assert.equal(await M.install(await M.remoteSys(target), { launch, yes: true, out: (l = "") => lines.push(l) }), 0, lines.join("\n"));
  assertInstalled(home, (a) => M.launchFor(launch, a));
  assert.equal(await M.uninstall(await M.remoteSys(target), { launch, yes: true, out: () => {} }), 0);
  assert.deepEqual(snapshot(home), original);
  await assert.rejects(M.resolveRemotes([{ kind: "vercel", id: "all" }]), /Vercel Sandbox .* isn't available in this build/);
  M.registerRemoteFactory("vercel", async (id) => (id === "all" ? [target] : []));
  assert.equal((await M.resolveRemotes([{ kind: "vercel", id: "all" }])).length, 1);
  await assert.rejects(M.resolveRemotes([{ kind: "vercel", id: "sbx_nope" }]), /not found or not running/);
});

test("CLI: install --dry-run and doctor run end to end against a fake HOME", () => {
  const { home, bin } = makeHome(true);
  const before = snapshot(home, { backups: true });
  const env = { HOME: home, USERPROFILE: home, PATH: bin, AGENT_VISUALIZER_PORT: "1", NO_COLOR: "1" };
  const dry = spawnSync(process.execPath, [CLI, "install", "--dry-run"], { env, encoding: "utf8" });
  assert.equal(dry.status, 0, dry.stderr + dry.stdout);
  assert.match(dry.stdout, /What would change/);
  assert.deepEqual(snapshot(home, { backups: true }), before);
  const doc = spawnSync(process.execPath, [CLI, "doctor"], { env, encoding: "utf8" });
  assert.equal(doc.status, 0, doc.stderr + doc.stdout);
  assert.match(doc.stdout, /Office\s+not running/);
  assert.match(doc.stdout, /8 agents could use the office tools/);
  const bad = spawnSync(process.execPath, [CLI, "install", "--agents", "notepad"], { env, encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown agent "notepad"/);
  const yes = spawnSync(process.execPath, [CLI, "install", "--yes"], { env, encoding: "utf8" });
  assert.equal(yes.status, 0, yes.stdout);
  const doc2 = spawnSync(process.execPath, [CLI, "doctor"], { env, encoding: "utf8" });
  assert.match(doc2.stdout, /All set/);
});
