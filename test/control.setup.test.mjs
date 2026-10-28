// Tests for "Bring my setup" (src/control/setup.ts, src/control/cloud/setup.ts, tar.ts, toml.ts):
// a fake HOME with a fake ~/.claude.json, ~/.claude (CLAUDE.md, rules, skills, settings.json with
// hooks), ~/.codex (config.toml, AGENTS.md, prompts, auth.json) and a small git project. The
// "sandbox" is a second folder where `sh` runs as if it were the remote, with that folder as HOME.
// The page sees names only; values land 0600 there and never in a script, an argv or a log.
import nodeTest, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { load, tmp } from "./remote.fakes.mjs";
import { CONTROL, skipAll } from "./platform.mjs";

const test = skipAll(nodeTest, CONTROL);

const M = await load("src/control/setup.ts", "src/control/cloud/setup.ts", "src/control/tar.ts", "src/control/toml.ts");

const made = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const MCP_SECRET = "mcp-secret-value-0001";
const HEADER_SECRET = "Bearer header-secret-0002";
const API_KEY = "sk-ant-api03-dummy-setup-key-0000000000-abcdefghijklmnopqrst";
const ENV_SECRET = "DATABASE_URL=postgres://user:env-secret-0003@db/app";
const AUTH_SECRET = "codex-refresh-token-secret-0004";
const GIT_SECRET = "git-header-secret-0006";

function w(path, text, mode) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  if (mode) chmodSync(path, mode);
}

function git(cwd, ...args) {
  const r = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

/** A fake HOME: Claude and Codex configs, instructions, skills and a git project at ~/Codes/app. */
function fakeHome() {
  const home = tmp("ao-setup-home-");
  made.push(home);
  const project = join(home, "Codes", "app");
  w(join(home, ".claude.json"), JSON.stringify({
    numStartups: 3,
    oauthAccount: { emailAddress: "local@example.com" },
    mcpServers: {
      docs: { type: "http", url: "https://example.com/mcp", headers: { Authorization: HEADER_SECRET } },
      github: { command: "/opt/homebrew/bin/npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: MCP_SECRET } },
      mine: { command: join(home, "bin", "my-server"), args: [] },
      tunnel: { type: "sse", url: "http://localhost:8123/sse" },
      py: { command: "uvx", args: ["mcp-server-fetch"] },
      script: { command: "node", args: [join(home, "tools", "server.js")] },
    },
    projects: {
      [project]: { mcpServers: { localdb: { command: "npx", args: ["-y", "@acme/db-mcp"], env: { DB_PASSWORD: MCP_SECRET } } }, enabledMcpjsonServers: ["team"], hasTrustDialogAccepted: true },
    },
  }));
  w(join(home, ".claude", "CLAUDE.md"), "# my rules\nBe brief.\n");
  w(join(home, ".claude", "rules", "style.md"), "No emoji.\n");
  w(join(home, ".claude", "skills", "deploy", "SKILL.md"), "---\nname: deploy\n---\nShip it.\n");
  w(join(home, ".claude", "skills", "deploy", "run.sh"), "#!/bin/sh\necho hi\n", 0o755);
  w(join(home, ".claude", "skills", "review", "SKILL.md"), "---\nname: review\n---\nLook hard.\n");
  w(join(home, ".claude", "skills", "review", "big.bin"), Buffer.concat([Buffer.from([0]), Buffer.alloc(600 * 1024, 1)]));
  w(join(home, "elsewhere", "SKILL.md"), "outside\n");
  symlinkSync(join(home, "elsewhere"), join(home, ".claude", "skills", "linked"));
  w(join(home, ".claude", "agents", "tester.md"), "---\nname: tester\n---\n");
  w(join(home, ".claude", "settings.json"), JSON.stringify({
    model: "opus",
    permissions: { allow: ["Bash(npm test)"], additionalDirectories: [join(home, "other")] },
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `${home}/.claude/hooks/guard.sh` }, { type: "command", command: "npx prettier --check ." }] }],
      Stop: [{ hooks: [{ type: "command", command: "~/bin/notify" }] }],
    },
    statusLine: { type: "command", command: `${home}/.claude/statusline.sh` },
    apiKeyHelper: "/usr/local/bin/my-key-helper",
    enabledPlugins: { "x@y": true },
    env: { FOO: "bar", CLAUDE_CONFIG_DIR: join(home, ".claude") },
  }));
  w(join(home, ".codex", "config.toml"), [
    'model = "gpt-5"',
    "",
    "[mcp_servers.search]",
    'command = "npx"',
    'args = [',
    '  "-y",',
    '  "@acme/search-mcp",',
    "]",
    `env = { SEARCH_KEY = "${MCP_SECRET}" }`,
    "",
    '[mcp_servers."remote docs"]',
    'url = "https://docs.example.com/mcp"',
    `http_headers = { "X-Key" = "${MCP_SECRET}" }`,
    "",
    "[mcp_servers.local]",
    `command = "${home}/bin/thing"`,
    "",
    '[projects."/somewhere"]',
    'trust_level = "trusted"',
    "",
  ].join("\n"));
  w(join(home, ".codex", "AGENTS.md"), "# codex rules\n");
  w(join(home, ".codex", "prompts", "fix.md"), "Fix it.\n");
  w(join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { refresh_token: AUTH_SECRET } }));

  mkdirSync(project, { recursive: true });
  git(project, "init", "-q");
  git(project, "remote", "add", "origin", "https://someone:ghp_secretinurl0005@github.com/me/app.git");
  w(join(project, "README.md"), "# app\n");
  w(join(project, "src", "index.js"), "console.log(1)\n");
  w(join(project, "bin", "run"), "#!/bin/sh\n", 0o755);
  w(join(project, ".gitignore"), "node_modules\n.env\ndist\n");
  w(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { team: { command: "npx", args: ["-y", "@team/mcp"] } } }));
  git(project, "add", ".");
  git(project, "commit", "-q", "-m", "first");
  w(join(project, "notes.txt"), "untracked but not ignored\n");
  w(join(project, "node_modules", "x", "index.js"), "ignored\n");
  w(join(project, "dist", "out.js"), "ignored\n");
  w(join(project, ".env"), `${ENV_SECRET}\n`);
  // What a real checkout carries besides the URL: a clone's reflog line and FETCH_HEAD hold the
  // URL as typed, CI checkouts leave an auth header, and a hostile repo can name an fsmonitor command.
  const dotGit = join(project, ".git");
  const config = readFileSync(join(dotGit, "config"), "utf8");
  w(join(dotGit, "config"), `${config}[http "https://github.com/"]\n\textraheader = AUTHORIZATION: basic ${GIT_SECRET}\n[url "https://x:${GIT_SECRET}@github.com/"]\n\tinsteadOf = https://github.com/\n[credential]\n\thelper = store\n[core]\n\tfsmonitor = touch ${join(home, "fsmonitor-ran")}\n`);
  w(join(dotGit, "logs", "HEAD"), `0000000000000000000000000000000000000000 1111111111111111111111111111111111111111 t <t@example.com> 1 +0000\tclone: from https://someone:ghp_secretinurl0005@github.com/me/app.git\n`);
  w(join(dotGit, "config.worktree"), `[http]\n\textraheader = AUTHORIZATION: bearer ${GIT_SECRET}\n`);
  w(join(dotGit, "FETCH_HEAD"), `1111111111111111111111111111111111111111\t\tbranch 'main' of https://someone:ghp_secretinurl0005@github.com/me/app\n`);
  return { home, project };
}

/** Every file under a folder, read as text. */
function readTree(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...readTree(p));
    else if (e.isFile()) out.push(readFileSync(p, "latin1"));
  }
  return out;
}

/** A "sandbox": sh with HOME=remote, recording every script, env name and argv it was handed. */
function shBox(remoteHome, cwd, ours) {
  const calls = [];
  const env = (extra = {}) => ({ PATH: process.env.PATH, HOME: remoteHome, LC_ALL: "C", ...extra });
  const sh = (script, extra, input) => {
    const r = spawnSync("sh", ["-c", script], { env: env(extra), input, cwd: remoteHome });
    if (r.status !== 0) throw new Error(`exit ${r.status}: ${r.stderr}`);
    return r.stdout.toString("utf8");
  };
  return {
    calls,
    where: "test box",
    ours,
    cwd,
    run: async (script) => {
      calls.push({ kind: "run", script });
      return sh(script);
    },
    runSecret: async (script, values) => {
      calls.push({ kind: "secret", script, names: Object.keys(values) });
      return sh(script, values);
    },
    upload: async (entries, dir) => {
      const tgz = await M.tgzOf(entries);
      calls.push({ kind: "upload", dir, bytes: tgz.length });
      sh(`umask 077; mkdir -p '${dir}' && tar xzf - -C '${dir}'`, {}, tgz);
    },
  };
}

const src = (home, extra = {}) => ({ home, env: { HOME: home }, keys: [], shellKeys: [], ...extra });
const mode = (p) => statSync(p).mode & 0o777;

test("inventory lists names and transports only: pre-ticks http/sse and npx/uvx/bunx/docker, says why for the rest", async () => {
  const { home, project } = fakeHome();
  const inv = await M.inventory("claude", src(home, { shellKeys: ["ANTHROPIC_API_KEY"] }), project);
  const by = Object.fromEntries(inv.mcp.map((m) => [`${m.scope}:${m.name}`, m]));
  assert.equal(by["user:docs"].ok, true);
  assert.equal(by["user:docs"].transport, "http");
  assert.equal(by["user:docs"].what, "example.com");
  assert.equal(by["user:docs"].secrets, 1);
  assert.equal(by["user:github"].ok, true, "an absolute npx is still npx");
  assert.equal(by["user:github"].what, "npx @modelcontextprotocol/server-github");
  assert.equal(by["user:py"].ok, true);
  assert.equal(by["user:mine"].ok, false);
  assert.match(by["user:mine"].why, /~\/bin\/my-server.*won't have/);
  assert.equal(by["user:tunnel"].ok, false);
  assert.match(by["user:tunnel"].why, /localhost/);
  assert.equal(by["user:script"].ok, false);
  assert.match(by["user:script"].why, /file on this Mac/);
  assert.equal(by["local:localdb"].ok, true);
  assert.equal(by["project:team"].scope, "project");
  const ids = inv.instructions.map((i) => i.id);
  assert.deepEqual(ids, ["CLAUDE.md", "rules", "skills", "agents", "settings.json"]);
  const skills = inv.instructions.find((i) => i.id === "skills");
  assert.equal(skills.count, 3);
  assert.ok(skills.skipped.some((s) => /linked: a link to outside ~\/\.claude/.test(s)), skills.skipped.join("; "));
  assert.ok(skills.skipped.some((s) => /big\.bin: a 0\.6 MB binary/.test(s)), skills.skipped.join("; "));
  const settings = inv.instructions.find((i) => i.id === "settings.json");
  assert.ok(settings.skipped.some((s) => /hooks: 2 that run a file/.test(s)), settings.skipped.join("; "));
  assert.ok(settings.skipped.some((s) => /statusLine/.test(s)));
  assert.ok(settings.skipped.some((s) => /apiKeyHelper/.test(s)));
  assert.ok(settings.skipped.some((s) => /plugins/.test(s)));
  assert.equal(inv.project.display, "~/Codes/app");
  assert.equal(inv.project.ok, true);
  assert.equal(inv.project.git.present, true);
  assert.equal(inv.project.git.ok, true);
  assert.deepEqual(inv.project.envFiles, [".env"]);
  assert.equal(inv.project.files, 6, "tracked + untracked-not-ignored, no .env, no node_modules or dist");
  const login = Object.fromEntries(inv.login.map((l) => [l.kind, l]));
  assert.equal(login.subscription.available, false);
  assert.match(login.subscription.why, /Connect Claude/);
  assert.equal(login.key.available, true);
  assert.match(login.key.detail, /from your shell/);
  assert.ok(inv.notes.some((n) => /claude\.ai connectors/.test(n)));
  const json = JSON.stringify(inv);
  for (const secret of [MCP_SECRET, HEADER_SECRET, ENV_SECRET, "ghp_secretinurl0005"]) assert.ok(!json.includes(secret), `inventory leaks ${secret}`);
});

test("codex inventory: config.toml servers, AGENTS.md and prompts, and the copy sign-in when auth.json is there", async () => {
  const { home } = fakeHome();
  const inv = await M.inventory("codex", src(home));
  const by = Object.fromEntries(inv.mcp.map((m) => [m.name, m]));
  assert.equal(by.search.ok, true);
  assert.equal(by.search.what, "npx @acme/search-mcp");
  assert.equal(by.search.secrets, 1);
  assert.equal(by["remote docs"].ok, true);
  assert.equal(by["remote docs"].transport, "http");
  assert.equal(by.local.ok, false);
  assert.deepEqual(inv.instructions.map((i) => i.id), ["AGENTS.md", "prompts"]);
  const login = Object.fromEntries(inv.login.map((l) => [l.kind, l]));
  assert.equal(login.copy.available, true);
  assert.equal(login.device.available, true);
  assert.equal(login.key.available, false);
  assert.ok(!JSON.stringify(inv).includes(MCP_SECRET));
});

test("a subscription token shows as connected with its expiry", async () => {
  const { home } = fakeHome();
  const keys = [{ name: "CLAUDE_CODE_OAUTH_TOKEN", agents: ["claude"], preview: "sk-ant…abcd", addedAt: "2026-10-18T00:00:00.000Z", expiresAt: "2027-10-18T00:00:00.000Z" }];
  const inv = await M.inventory("claude", src(home, { keys }));
  const sub = inv.login.find((l) => l.kind === "subscription");
  assert.equal(sub.available, true);
  assert.equal(sub.detail, "expires ~Oct 18, 2027");
  assert.deepEqual(sub.keys, ["CLAUDE_CODE_OAUTH_TOKEN"]);
});

test("bring my setup into an office sandbox: files 0600, MCP servers and the key's approval in ~/.claude.json, nothing secret in a script", async () => {
  const { home, project } = fakeHome();
  const remote = tmp("ao-setup-remote-");
  made.push(remote);
  const cwd = join(remote, "app");
  mkdirSync(cwd);
  const b = await M.collect("claude", {
    login: "key",
    mcp: ["docs", "github", "localdb", "mine"],
    instructions: ["CLAUDE.md", "rules", "skills", "agents", "settings.json"],
    project: { folder: project, git: true, env: false },
  }, src(home));
  assert.match(b.summary, /API key · 4 MCP servers · instructions \+ 3 skills · ~\/Codes\/app \(/);
  const box = shBox(remote, cwd, true);
  const progress = [];
  const r = await M.bringSetup(box, b, { ANTHROPIC_API_KEY: API_KEY }, (d) => progress.push(d));
  assert.deepEqual(r.skipped, []);
  assert.ok(progress.some((p) => /Uploading ~\/Codes\/app/.test(p)), progress.join(" | "));

  // instructions and skills, owner-only
  assert.equal(readFileSync(join(remote, ".claude", "CLAUDE.md"), "utf8"), "# my rules\nBe brief.\n");
  assert.equal(mode(join(remote, ".claude", "CLAUDE.md")), 0o600);
  assert.equal(mode(join(remote, ".claude", "skills")), 0o700);
  assert.equal(mode(join(remote, ".claude", "skills", "deploy", "run.sh")), 0o700);
  assert.ok(existsSync(join(remote, ".claude", "skills", "review", "SKILL.md")));
  assert.ok(!existsSync(join(remote, ".claude", "skills", "review", "big.bin")), "big binaries stay home");
  assert.ok(!existsSync(join(remote, ".claude", "skills", "linked")), "links out of ~/.claude stay home");
  assert.ok(!existsSync(join(remote, ".agent-visualizer", "run")) || spawnSync("ls", ["-A", join(remote, ".agent-visualizer", "run")]).stdout.toString().trim() === "", "staging is cleaned up");

  // ~/.claude.json: the ticked servers, the project's local ones, onboarding, the approval
  const cj = JSON.parse(readFileSync(join(remote, ".claude.json"), "utf8"));
  assert.equal(mode(join(remote, ".claude.json")), 0o600);
  assert.deepEqual(Object.keys(cj.mcpServers).sort(), ["docs", "github", "mine"]);
  assert.equal(cj.mcpServers.github.command, "npx");
  assert.equal(cj.mcpServers.github.env.GITHUB_TOKEN, MCP_SECRET);
  assert.equal(cj.mcpServers.docs.headers.Authorization, HEADER_SECRET);
  assert.equal(cj.projects[cwd].mcpServers.localdb.env.DB_PASSWORD, MCP_SECRET);
  assert.deepEqual(cj.projects[cwd].enabledMcpjsonServers, ["team"]);
  assert.equal(cj.hasCompletedOnboarding, true);
  assert.deepEqual(cj.customApiKeyResponses.approved, [API_KEY.slice(-20)]);
  assert.equal(cj.oauthAccount, undefined, "nothing of this Mac's own account comes along");

  // settings.json without what runs local files
  const st = JSON.parse(readFileSync(join(remote, ".claude", "settings.json"), "utf8"));
  assert.equal(mode(join(remote, ".claude", "settings.json")), 0o600);
  assert.equal(st.model, "opus");
  assert.deepEqual(st.hooks, { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "npx prettier --check ." }] }] });
  assert.equal(st.statusLine, undefined);
  assert.equal(st.apiKeyHelper, undefined);
  assert.equal(st.enabledPlugins, undefined);
  assert.deepEqual(st.env, { FOO: "bar" });
  assert.deepEqual(st.permissions.additionalDirectories, []);

  // the project: tracked + untracked-not-ignored, history included, no .env, credentials out of the remote URL
  assert.equal(readFileSync(join(cwd, "src", "index.js"), "utf8"), "console.log(1)\n");
  assert.ok(existsSync(join(cwd, "notes.txt")));
  assert.ok(!existsSync(join(cwd, "node_modules")));
  assert.ok(!existsSync(join(cwd, "dist")));
  assert.ok(!existsSync(join(cwd, ".env")));
  assert.equal(mode(join(cwd, "bin", "run")), 0o700);
  assert.equal(mode(join(cwd, "README.md")), 0o600);
  assert.equal(git(cwd, "log", "--format=%s").trim(), "first");
  assert.equal(git(cwd, "status", "--porcelain").trim(), "?? notes.txt");
  assert.equal(git(cwd, "remote", "get-url", "origin").trim(), "https://github.com/me/app.git");
  assert.ok(!existsSync(join(cwd, ".git", "hooks")));
  assert.ok(!existsSync(join(cwd, ".git", "logs")) && !existsSync(join(cwd, ".git", "FETCH_HEAD")));
  const shipped = readTree(join(cwd, ".git")).join("\n");
  for (const secret of ["ghp_secretinurl0005", GIT_SECRET, "extraheader", "insteadOf", "fsmonitor", "helper"]) assert.ok(!shipped.includes(secret), `.git carries ${secret}`);
  assert.ok(!existsSync(join(home, "fsmonitor-ran")), "the repo's fsmonitor command ran on this Mac");

  // values only ever in the secret command's environment
  const scripts = box.calls.map((c) => c.script ?? "").join("\n");
  for (const secret of [MCP_SECRET, HEADER_SECRET, API_KEY, API_KEY.slice(-20)]) assert.ok(!scripts.includes(secret), `a script carries ${secret.slice(0, 12)}`);
  assert.ok(box.calls.some((c) => c.kind === "secret" && c.names.length >= 1));
});

test("outside an office sandbox only missing things are added: an existing file, server and a non-empty folder are kept", async () => {
  const { home, project } = fakeHome();
  const remote = tmp("ao-setup-remote-");
  made.push(remote);
  const cwd = join(remote, "app");
  w(join(cwd, "existing.txt"), "mine\n");
  w(join(remote, ".claude", "CLAUDE.md"), "their own\n");
  w(join(remote, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: false, mcpServers: { docs: { type: "http", url: "https://theirs.example.com" } } }));
  const b = await M.collect("claude", { login: "none", mcp: ["docs", "github"], instructions: ["CLAUDE.md", "rules"], project: { folder: project, env: true } }, src(home));
  const r = await M.bringSetup(shBox(remote, cwd, false), b, {}, () => {});
  assert.equal(readFileSync(join(remote, ".claude", "CLAUDE.md"), "utf8"), "their own\n");
  assert.ok(existsSync(join(remote, ".claude", "rules", "style.md")));
  const cj = JSON.parse(readFileSync(join(remote, ".claude.json"), "utf8"));
  assert.equal(cj.mcpServers.docs.url, "https://theirs.example.com");
  assert.equal(cj.mcpServers.github.command, "npx");
  assert.equal(cj.hasCompletedOnboarding, false, "their answer stays");
  assert.ok(!existsSync(join(cwd, "README.md")));
  assert.ok(r.skipped.some((s) => /isn't empty/.test(s)), r.skipped.join("; "));
  assert.ok(r.skipped.some((s) => /\.env files: the project wasn't uploaded/.test(s)));
  assert.ok(r.skipped.some((s) => /1 instruction file was already there/.test(s)));
});

test(".env files only when ticked, written 0600 through the secret path", async () => {
  const { home, project } = fakeHome();
  const remote = tmp("ao-setup-remote-");
  made.push(remote);
  const cwd = join(remote, "app");
  mkdirSync(cwd);
  const b = await M.collect("opencode", { project: { folder: project, git: false, env: true } }, src(home));
  const box = shBox(remote, cwd, true);
  await M.bringSetup(box, b, {}, () => {});
  assert.equal(readFileSync(join(cwd, ".env"), "utf8"), `${ENV_SECRET}\n`);
  assert.equal(mode(join(cwd, ".env")), 0o600);
  assert.ok(!existsSync(join(cwd, ".git")), "no history when git is off");
  assert.ok(!box.calls.map((c) => c.script ?? "").join("\n").includes("env-secret-0003"));
  const up = box.calls.filter((c) => c.kind === "upload");
  assert.equal(up.length, 1, "the project only; nothing for opencode's home");
});

test("codex: [mcp_servers.*] appended to config.toml, auth.json copied 0600 when asked, AGENTS.md and prompts in ~/.codex", async () => {
  const { home } = fakeHome();
  const remote = tmp("ao-setup-remote-");
  made.push(remote);
  w(join(remote, ".codex", "config.toml"), '[projects."/x"]\ntrust_level = "trusted"\n');
  const b = await M.collect("codex", { login: "copy", mcp: ["search", "remote docs"], instructions: ["AGENTS.md", "prompts"] }, src(home));
  await M.bringSetup(shBox(remote, join(remote, "work"), true), b, {}, () => {});
  const text = readFileSync(join(remote, ".codex", "config.toml"), "utf8");
  const t = M.parseToml(text);
  assert.equal(t.projects["/x"].trust_level, "trusted");
  assert.deepEqual(t.mcp_servers.search.args, ["-y", "@acme/search-mcp"]);
  assert.equal(t.mcp_servers.search.env.SEARCH_KEY, MCP_SECRET);
  assert.equal(t.mcp_servers["remote docs"].url, "https://docs.example.com/mcp");
  assert.equal(mode(join(remote, ".codex", "config.toml")), 0o600);
  assert.equal(JSON.parse(readFileSync(join(remote, ".codex", "auth.json"), "utf8")).tokens.refresh_token, AUTH_SECRET);
  assert.equal(mode(join(remote, ".codex", "auth.json")), 0o600);
  assert.equal(readFileSync(join(remote, ".codex", "prompts", "fix.md"), "utf8"), "Fix it.\n");
});

test("merges: Claude's approval list, settings top-level keys, and a server Codex already has", () => {
  const out = JSON.parse(M.mergeClaudeJson(JSON.stringify({ customApiKeyResponses: { approved: ["a"], rejected: ["tail-tail-tail-tail1"] } }), undefined, { cwd: "/w", over: false, keyTail: "tail-tail-tail-tail1" }));
  assert.deepEqual(out.customApiKeyResponses, { approved: ["a", "tail-tail-tail-tail1"], rejected: [] });
  assert.throws(() => M.mergeClaudeJson("{nope", undefined, { cwd: "/w", over: false }), /doesn't parse/);
  assert.deepEqual(JSON.parse(M.mergeSettings('{"model":"x"}', { model: "y", theme: "dark" }, false)), { model: "x", theme: "dark" });
  const m = M.mergeCodexToml('[mcp_servers.search]\ncommand = "x"\n', [{ name: "search", toml: "[mcp_servers.search]\n" }, { name: "b", toml: '[mcp_servers.b]\nurl = "https://b"\n' }]);
  assert.deepEqual(m.added, ["b"]);
  assert.deepEqual(m.kept, ["search"]);
});

test("toml: inline tables, arrays over lines, quoted keys and comments", () => {
  const t = M.parseToml('# c\na = 1 # x\n[mcp_servers."x y"]\nargs = [\n "a", # one\n \'b\',\n]\nenv = { K = "v\\"q", "L-M" = \'w\' }\n[[arr]]\nn = true\nbroken = = =\nok = "yes"\n');
  assert.equal(t.a, 1);
  assert.deepEqual(t.mcp_servers["x y"].args, ["a", "b"]);
  assert.deepEqual(t.mcp_servers["x y"].env, { K: 'v"q', "L-M": "w" });
  assert.equal(t.arr[0].n, true);
  assert.equal(t.arr[0].ok, "yes");
  const back = M.parseToml(M.mcpServerToml("x y", t.mcp_servers["x y"]));
  assert.deepEqual(back.mcp_servers["x y"], t.mcp_servers["x y"]);
});

test("tar: long names, links and modes come back through the system tar", async () => {
  const dir = tmp("ao-tar-");
  made.push(dir);
  const long = `${"deep/".repeat(30)}file.txt`;
  const tgz = await M.tgzOf([
    { name: "a", type: "dir", mode: 0o700 },
    { name: "a/x.sh", type: "file", mode: 0o700, data: Buffer.from("#!/bin/sh\n") },
    { name: long, type: "file", mode: 0o600, data: Buffer.from("deep\n") },
    { name: "a/link", type: "symlink", mode: 0o777, link: "x.sh" },
  ]);
  const r = spawnSync("tar", ["xzf", "-", "-C", dir], { input: tgz });
  assert.equal(r.status, 0, String(r.stderr));
  assert.equal(readFileSync(join(dir, long), "utf8"), "deep\n");
  assert.equal(mode(join(dir, "a", "x.sh")), 0o700);
  assert.equal(readFileSync(join(dir, "a", "link"), "utf8"), "#!/bin/sh\n");
  assert.throws(() => M.tarOf([{ name: "../evil", type: "file", mode: 0o600, data: Buffer.from("x") }]), /unsafe/);
});

test("a folder that isn't a git repo is read directly, node_modules left out", async () => {
  const { home, project } = fakeHome();
  const real = M.PROJECT_MAX_BYTES;
  assert.ok(real >= 50 << 20);
  // A non-git folder with node_modules and .venv: those are skipped by name.
  const plain = join(home, "plain");
  w(join(plain, "a.txt"), "a\n");
  w(join(plain, "node_modules", "m", "i.js"), "x\n");
  const inv = await M.projectInventory(plain, home);
  assert.equal(inv.files, 1);
  assert.equal(inv.git.present, false);
  assert.ok(inv.skipped.some((s) => /node_modules: not copied/.test(s)));
  assert.ok(project);
});

test("a remote working folder for the project: ~/<name>", () => {
  assert.equal(M.defaultRemoteCwd("/Users/me/Codes/my app"), "~/my-app");
  assert.equal(M.defaultRemoteCwd("/Users/me/.hidden"), "~/hidden");
});

test("localRef: home, ~, $HOME and non-system absolute paths are this machine's", () => {
  assert.equal(M.localRef("/Users/me/x.sh", "/Users/me"), true);
  assert.equal(M.localRef("~/bin/notify", "/Users/me"), true);
  assert.equal(M.localRef("bash $HOME/x", "/Users/me"), true);
  assert.equal(M.localRef("/usr/local/bin/helper", "/Users/me"), true);
  assert.equal(M.localRef("npx prettier --check .", "/Users/me"), false);
  assert.equal(M.localRef("/bin/sh -c 'echo hi > /dev/null'", "/Users/me"), false);
});

test("review fixes: URLs aren't local paths, a flag's value never reaches the page, .env.example is code", async () => {
  assert.equal(M.localRef("npx -y mcp-remote https://mcp.example.com/sse", "/Users/me"), false);
  assert.equal(M.localRef("uvx --from git+https://github.com/x/y tool", "/Users/me"), false);
  assert.equal(M.localRef("curl -s https://hooks.example.com/ping", "/Users/me"), false);
  const remote = M.classifyMcp({ command: "npx", args: ["-y", "mcp-remote", "https://mcp.example.com/sse"] }, "/Users/me");
  assert.equal(remote.mcp.ok, true);
  assert.equal(remote.mcp.what, "npx mcp-remote");
  const secretArg = M.classifyMcp({ command: "my-mcp", args: ["--api-key", "sk_live_abc123secret"] }, "/Users/me");
  assert.equal(secretArg.mcp.what, "my-mcp");
  const flagged = M.classifyMcp({ command: "npx", args: ["--registry", "sk_live_abc123secret", "@acme/x"] }, "/Users/me");
  assert.equal(flagged.mcp.what, "npx @acme/x");
  const docker = M.classifyMcp({ command: "docker", args: ["run", "-i", "--rm", "-e", "TOKEN", "mcp/fetch"] }, "/Users/me");
  assert.equal(docker.mcp.what, "docker mcp/fetch");
  const { settings } = M.sanitizeSettings({ env: { ANTHROPIC_BASE_URL: "https://gw.example.com" }, hooks: { Stop: [{ hooks: [{ type: "command", command: "curl -s https://hooks.example.com" }] }] } }, "/Users/me");
  assert.deepEqual(settings.env, { ANTHROPIC_BASE_URL: "https://gw.example.com" });
  assert.equal(settings.hooks.Stop[0].hooks.length, 1);

  const { home, project } = fakeHome();
  w(join(project, ".env.example"), "SECRET=\n");
  const inv = await M.projectInventory(project, home);
  assert.deepEqual(inv.envFiles, [".env"], ".env.example rides with the code");
  assert.equal(inv.files, 7);
});

test("review fixes: links can't reach sign-ins or transcripts, and TOML keys can't reach Object.prototype", () => {
  const { home } = fakeHome();
  w(join(home, ".claude", ".credentials.json"), '{"claudeAiOauth":{"accessToken":"x"}}');
  w(join(home, ".claude", "projects", "p", "t.jsonl"), "{}\n");
  symlinkSync(join(home, ".claude", ".credentials.json"), join(home, ".claude", "skills", "deploy", "creds.json"));
  symlinkSync(join(home, ".claude", "projects"), join(home, ".claude", "skills", "deploy", "history"));
  const ins = M.instructionsOf("claude", src(home), { read: true, only: ["skills"] });
  const names = ins.entries.map((e) => e.name);
  assert.ok(!names.some((n) => /creds|history|credentials|projects/.test(n)), names.join(", "));
  const skills = ins.items.find((i) => i.id === "skills");
  assert.ok(skills.skipped.some((x) => /creds\.json: a link to outside/.test(x)), skills.skipped.join("; "));
  const t = M.parseToml('[__proto__]\npolluted = true\n[mcp_servers.ok]\nconstructor.x = 1\ncommand = "npx"\n');
  assert.equal({}.polluted, undefined);
  assert.equal(t.mcp_servers.ok.command, "npx");
});

test("review fixes: an upload that fails is said and the configs still land; an unreadable config is never overwritten", async () => {
  const { home, project } = fakeHome();
  const remote = tmp("ao-setup-remote-");
  made.push(remote);
  const cwd = join(remote, "app");
  mkdirSync(cwd);
  w(join(remote, ".claude", "settings.json"), '{"theirs":true}');
  chmodSync(join(remote, ".claude", "settings.json"), 0o000);
  const b = await M.collect("claude", { login: "none", mcp: ["github"], instructions: ["CLAUDE.md", "settings.json"], project: { folder: project, git: false } }, src(home));
  const box = shBox(remote, cwd, true);
  box.upload = async () => {
    throw new Error("upload refused (413)");
  };
  const r = await M.bringSetup(box, b, {}, () => {});
  assert.ok(r.skipped.some((x) => /instructions and skills: upload refused/.test(x)), r.skipped.join("; "));
  assert.ok(r.skipped.some((x) => /the project: upload refused/.test(x)));
  assert.ok(r.skipped.some((x) => /settings\.json there couldn't be read/.test(x)));
  chmodSync(join(remote, ".claude", "settings.json"), 0o600);
  assert.equal(readFileSync(join(remote, ".claude", "settings.json"), "utf8"), '{"theirs":true}', "left as it was");
  const cj = JSON.parse(readFileSync(join(remote, ".claude.json"), "utf8"));
  assert.equal(cj.mcpServers.github.env.GITHUB_TOKEN, MCP_SECRET, "the MCP servers still went in");
  // Run again: nothing changed, nothing rewritten.
  const before = statSync(join(remote, ".claude.json")).mtimeMs;
  const again = shBox(remote, cwd, true);
  again.upload = box.upload;
  await M.bringSetup(again, { ...b, home: undefined, project: undefined, claude: { ...b.claude, settings: undefined } }, {}, () => {});
  assert.equal(again.calls.filter((c) => c.kind === "secret").length, 0, "the same config isn't written twice");
  assert.equal(statSync(join(remote, ".claude.json")).mtimeMs, before);
});

test("a project's .git/config goes over rebuilt: remotes, branches and format only, no tokens", () => {
  const out = M.safeGitConfig([
    "[core]",
    "\trepositoryformatversion = 1",
    "\tbare = false",
    "\tsshCommand = ssh -i ~/.ssh/work",
    "\tfsmonitor = /tmp/run-me",
    "[extensions]",
    "\tobjectformat = sha256",
    "\tworktreeConfig = true",
    '[remote "origin"]',
    '\turl = "https://me:tok-0007@github.com/me/app.git"',
    "\tpushurl = ssh://git@github.com/me/app.git",
    "\tfetch = +refs/heads/*:refs/remotes/origin/*",
    '[branch "main"]',
    "\tremote = origin",
    "\tmerge = refs/heads/main",
    "[http]",
    "\textraheader = AUTHORIZATION: basic tok-0008",
    '[url "https://x:tok-0009@github.com/"]',
    "\tinsteadOf = https://github.com/",
    "[include]",
    "\tpath = ~/.gitconfig-work",
    "[user]",
    "\tname = Me",
    "\tsigningkey = ~/.ssh/id",
    "[alias]",
    "\tlong = !echo \\",
    "\t  continued",
  ].join("\n"));
  assert.equal(out, [
    "[core]",
    "\trepositoryformatversion = 1",
    "\tbare = false",
    "[extensions]",
    "\tobjectformat = sha256",
    '[remote "origin"]',
    '\turl = "https://github.com/me/app.git"',
    "\tpushurl = ssh://git@github.com/me/app.git",
    "\tfetch = +refs/heads/*:refs/remotes/origin/*",
    '[branch "main"]',
    "\tremote = origin",
    "\tmerge = refs/heads/main",
    "[user]",
    "\tname = Me",
    "",
  ].join("\n"));
});
