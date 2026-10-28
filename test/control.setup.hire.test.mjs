// "Bring my setup" from the session side (src/control/sessions.ts) and Connect Claude
// (src/control/logins.ts). A hire with a setup collects on this machine, opens the place with the
// working folder made, hands the bundle and the key values to RemotePlace.bring, and shows a step
// of its own; the sign-in choice decides which keys go (and which don't); Codex's device sign-in
// runs first in the terminal and its link and code reach ControlSession.needs. Connect Claude runs
// a fake `claude setup-token`, takes the token off its screen into the key store, ends it, and
// never lets the token reach the page, a log or a frame. Every value is a dummy.
import nodeTest, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fakeBin, fakeContext, load, scratch, sleep, until } from "./control.session-fakes.mjs";
import { fakePty } from "./control.cloud.fakes.mjs";
import { CONTROL, skipAll } from "./platform.mjs";

const test = skipAll(nodeTest, CONTROL);

const M = await load("src/control/sessions.ts", "src/control/pty.ts", "src/control/logins.ts", "src/control/keys.ts");
const pty = await M.loadPty();
const managers = [];
const ptys = [];
after(async () => {
  await Promise.all(managers.map((m) => m.shutdown()));
  for (const p of ptys) p.killAll();
  cleanup();
});

const SHELL_KEY = "sk-ant-api03-shell-value-dummy-000000000-QRSTUVWXYZabcdefghij";
const OAUTH = "sk-ant-oat01-stored-oauth-dummy-0000000000000000000000000000000000000000000";
const MCP_SECRET = "mcp-hire-secret-0303";

function home() {
  const root = scratch();
  const userHome = join(root, "home");
  const project = join(userHome, "Codes", "my shop");
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src", "a.js"), "1\n");
  writeFileSync(join(userHome, ".claude.json"), JSON.stringify({ mcpServers: { tool: { command: "npx", args: ["-y", "@acme/tool"], env: { TOKEN: MCP_SECRET } } } }));
  return { root, userHome, project };
}

/** A place that records what the session asks of it; the agent is a shell that prints `screen`. */
function fakePlaces(rec, screen = "agent up") {
  return {
    status: async () => [],
    onChange: () => ({ dispose() {} }),
    deleteSandbox: async () => {},
    shutdown() {},
    async open(place, o) {
      rec.open = { place, createCwd: o.createCwd };
      const cwd = scratch();
      return {
        host: { kind: "vercel", id: "vercel:sbx", name: "agent-visualizer-sbx" },
        cwd,
        ours: true,
        target: { host: { kind: "vercel", id: "vercel:sbx", name: "agent-visualizer-sbx" }, exec: async () => "" },
        ensureAgent: async () => ({ bin: place.kind === "vercel" && rec.agent === "codex" ? "codex" : "claude" }),
        firstRun: async () => {},
        async bring(bundle, secrets, progress) {
          rec.bundle = bundle;
          rec.secrets = secrets;
          progress("Uploading ~/Codes/my shop (1 KB)…");
          await sleep(30);
          return { skipped: rec.skip ?? [] };
        },
        attach: async (launch, size) => {
          rec.launch = launch;
          return pty.spawn({ file: "/bin/sh", args: ["-c", `printf '%s' "$S"; sleep 30`], cwd, env: { PATH: "/usr/bin:/bin", S: screen }, ...size });
        },
        keepAlive: () => ({ dispose() {} }),
        close() {},
      };
    },
  };
}

function manager(h, places, keyValues = {}, keys = []) {
  const f = fakeContext({ userHome: h.userHome, path: "/usr/bin:/bin", keyValues, keys: undefined });
  f.ctx.keys.list = () => keys;
  const shellAsked = [];
  const mgr = createMgr(f.ctx, places, shellAsked);
  const changes = [];
  mgr.onChange((s) => changes.push(s));
  return { ...f, mgr, changes, shellAsked };
}
function createMgr(ctx, places, shellAsked) {
  const mgr = M.createSessionManager(ctx, places, {
    pty,
    version: async () => "1.0.0",
    exitedKeepMs: 200,
    stopGraceMs: 300,
    shellVars: async (names) => {
      shellAsked.push(names);
      return { ANTHROPIC_API_KEY: SHELL_KEY, OPENAI_API_KEY: "sk-openai-shell-dummy" };
    },
  });
  managers.push(mgr);
  return mgr;
}

test("a hire with Your setup: collected here, the folder made there, brought in, then started with the shell key", { skip: !pty && "no PTY here" }, async () => {
  const h = home();
  const rec = {};
  const t = manager(h, fakePlaces(rec));
  const s = await t.mgr.hire({
    agent: "claude",
    mode: "terminal",
    place: { kind: "vercel", target: "new" },
    setup: { login: "key", shellKeys: ["ANTHROPIC_API_KEY", "DAYTONA_API_KEY"], mcp: ["tool"], project: { folder: h.project } },
  });
  assert.equal(s.place.cwd, "~/my-shop", "the project's folder there, by default");
  await until(() => t.mgr.get(s.id).status === "running", 5000, "running");
  assert.deepEqual(rec.open, { place: { kind: "vercel", target: "new", cwd: "~/my-shop" }, createCwd: true });
  assert.deepEqual(t.shellAsked, [["ANTHROPIC_API_KEY"]], "platform tokens are never read for an agent");
  assert.equal(rec.secrets.ANTHROPIC_API_KEY, SHELL_KEY);
  assert.equal(rec.bundle.approveClaudeKey, true);
  assert.equal(rec.bundle.claude.mcpServers.tool.env.TOKEN, MCP_SECRET);
  assert.equal(rec.bundle.project.files, 1);
  assert.match(rec.bundle.summary, /^API key · 1 MCP server · ~\/Codes\/my shop \(/);
  assert.equal(rec.launch.env.ANTHROPIC_API_KEY, SHELL_KEY);
  assert.ok(rec.launch.secret.includes("ANTHROPIC_API_KEY"));
  const steps = t.changes.map((c) => [c.status, c.detail ?? "", c.setup?.state ?? ""]);
  assert.ok(steps.some(([st, d, ss]) => st === "installing" && /Uploading/.test(d) && ss === "running"), JSON.stringify(steps));
  assert.equal(t.mgr.get(s.id).setup.state, "done");
  const said = JSON.stringify(t.changes) + t.logs.join("\n");
  for (const v of [SHELL_KEY, MCP_SECRET]) assert.ok(!said.includes(v), "no value in a frame or a log");
  assert.ok(t.logs.some((l) => /set up Claude Code in my-shop: API key · 1 MCP server/.test(l)), t.logs.join("\n"));
  await t.mgr.stop(s.id);
});

test("the sign-in decides the keys: the subscription drops an API key that would win over it, and needs a token", { skip: !pty && "no PTY here" }, async () => {
  const h = home();
  const rec = {};
  const none = manager(h, fakePlaces(rec), {}, []);
  await assert.rejects(none.mgr.hire({ agent: "claude", mode: "terminal", place: { kind: "vercel", target: "new" }, setup: { login: "subscription" } }), (e) => e.status === 400 && /Connect Claude/i.test(e.message));
  const stored = [{ name: "CLAUDE_CODE_OAUTH_TOKEN", agents: ["claude"], preview: "x", addedAt: new Date().toISOString() }, { name: "ANTHROPIC_API_KEY", agents: ["claude"], preview: "y", addedAt: new Date().toISOString() }];
  const t = manager(h, fakePlaces(rec), { CLAUDE_CODE_OAUTH_TOKEN: OAUTH, ANTHROPIC_API_KEY: "sk-ant-stored-dummy" }, stored);
  const s = await t.mgr.hire({ agent: "claude", mode: "terminal", place: { kind: "vercel", target: "new" }, keys: ["ANTHROPIC_API_KEY"], setup: { login: "subscription", shellKeys: ["ANTHROPIC_API_KEY"] } });
  await until(() => t.mgr.get(s.id).status === "running", 5000, "running");
  assert.deepEqual(Object.keys(rec.launch.env).filter((k) => /ANTHROPIC|CLAUDE_CODE/.test(k)), ["CLAUDE_CODE_OAUTH_TOKEN"]);
  assert.equal(rec.launch.env.CLAUDE_CODE_OAUTH_TOKEN, OAUTH);
  assert.deepEqual(t.shellAsked, [], "nothing from the shell");
  assert.equal(rec.bundle.approveClaudeKey, undefined);
  await t.mgr.stop(s.id);
});

const DEVICE_SCREEN = [
  "Welcome to Codex [v0.130.0]",
  "OpenAI's command-line coding agent",
  "",
  "Follow these steps to sign in with ChatGPT using device code authorization:",
  "",
  "1. Open this link in your browser and sign in to your account",
  "   https://auth.openai.com/codex/device",
  "",
  "2. Enter this one-time code (expires in 15 minutes)",
  "   3L9G-X64BG",
  "",
].join("\r\n");

test("Codex's device sign-in runs first in the terminal; its link and code become the session's needs", { skip: !pty && "no PTY here" }, async () => {
  const h = home();
  const rec = { agent: "codex" };
  const t = manager(h, fakePlaces(rec, DEVICE_SCREEN), {}, [{ name: "OPENAI_API_KEY", agents: ["codex"], preview: "z", addedAt: new Date().toISOString() }]);
  await assert.rejects(t.mgr.hire({ agent: "codex", mode: "chat", place: { kind: "ssh", target: "box" }, setup: { login: "device" } }), (e) => e.status === 400 && /terminal mode/.test(e.message));
  const s = await t.mgr.hire({ agent: "codex", mode: "terminal", place: { kind: "vercel", target: "new" }, keys: ["OPENAI_API_KEY"], setup: { login: "device" } });
  await until(() => t.mgr.get(s.id).needs, 5000, "the device code");
  const argv = rec.launch.argv.map((a) => (typeof a === "string" ? a : `$${a.env}`));
  assert.deepEqual(argv.slice(0, 2), ["sh", "-c"]);
  assert.match(argv[2], /"\$0" login status .*"\$0" login --device-auth .*exec "\$0" "\$@"/);
  assert.equal(argv[3], "codex");
  assert.equal(rec.launch.env.OPENAI_API_KEY, undefined, "an API key would skip the ChatGPT sign-in");
  const now = t.mgr.get(s.id);
  assert.deepEqual(now.needs, { kind: "device-login", url: "https://auth.openai.com/codex/device", code: "3L9G-X64BG" });
  assert.equal(now.detail, "Sign in to Codex: open the link and enter the code");
  assert.ok(t.emitted.some((e) => e.kind === "waiting"), "the worker puts its hand up");
  t.linkTo("codex:linked");
  assert.equal(t.mgr.get(s.id).needs, undefined, "signed in: the transcript took the desk");
  await t.mgr.stop(s.id);
});

test("deviceCode reads Codex's screen and nothing else", () => {
  assert.deepEqual(M.deviceCode(DEVICE_SCREEN.replace(/\r/g, "")), { url: "https://auth.openai.com/codex/device", code: "3L9G-X64BG" });
  assert.equal(M.deviceCode("Enter your API key"), undefined);
});

/* ---------------------------------------------------------- Connect Claude */

const TOKEN = "sk-ant-oat01-FAKEsetupTOKEN0123456789abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ_-xyz";
const FAKE_SETUP_TOKEN = `
const args = process.argv.slice(2);
if (args[0] !== "setup-token") process.exit(2);
const fail = process.env.FAKE_FAIL;
process.stdout.write("Opening browser to sign in\\u2026\\r\\nBrowser didn't open? Use the url below to sign in:\\r\\n\\r\\nhttps://claude.ai/oauth/authorize?code=true&client_id=dummy&state=st4te&pad=" + "x".repeat(560) + "\\r\\n\\r\\nPaste code here if prompted > ");
if (fail) setTimeout(() => process.exit(1), 200);
process.stdin.on("data", (d) => {
  if (!/[\\r\\n]/.test(d.toString())) return;
  process.stdout.write("\\r\\n\\r\\n\\u2713 Long-lived authentication token created successfully!\\r\\n\\r\\nYour OAuth token (valid for 1 year):\\r\\n\\r\\n${TOKEN}\\r\\n\\r\\nStore this token securely. You won't be able to see it again.\\r\\n\\r\\nUse this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>\\r\\n");
});
setInterval(() => {}, 1000);
`;

function logins(o = {}) {
  const root = scratch();
  const bin = fakeBin(join(root, "bin"), "claude", FAKE_SETUP_TOKEN);
  const aoHome = join(root, "ao");
  const keys = M.createKeyStore(aoHome);
  const p = fakePty();
  ptys.push(p);
  const logs = [];
  const ctx = { userHome: root, now: () => Date.now(), log: (m) => logs.push(m), agentEnv: () => ({ PATH: `${join(root, "bin")}:/usr/bin:/bin`, HOME: root, ...(o.env ?? {}) }) };
  const flows = [];
  const l = M.createLogins({ ctx, keys, pty: async () => p, bin: () => bin, waitMs: o.waitMs });
  l.onChange((f) => flows.push(JSON.parse(JSON.stringify(f))));
  return { l, keys, p, logs, flows, aoHome };
}

test("Connect Claude: setup-token's screen without the token, a pasted code, the token stored and the process ended", async () => {
  const t = logins();
  const first = await t.l.start("claude");
  assert.equal(first.state, "running");
  await until(() => t.l.status()[0].wantsCode, 5000, "the paste prompt");
  const running = t.l.status()[0];
  assert.match(running.url, /^https:\/\/claude\.ai\/oauth\/authorize\?.*&pad=x{560}$/, "a URL longer than the terminal comes back whole");
  assert.match(running.screen, /Paste code here if prompted/);
  assert.deepEqual(t.l.pids(), [t.p.children[0].pid], "presence leaves the sign-in alone");
  t.l.input("claude", "dummy-code\r");
  await until(() => t.l.status()[0].state === "connected", 5000, "connected");
  const k = t.keys.list().find((x) => x.name === "CLAUDE_CODE_OAUTH_TOKEN");
  assert.deepEqual(k.agents, ["claude"]);
  assert.equal(k.preview, "•••", "not even its ends");
  const days = (Date.parse(k.expiresAt) - Date.now()) / 86400_000;
  assert.ok(days > 364 && days <= 365, `a year: ${days}`);
  assert.equal(t.keys.reveal(["CLAUDE_CODE_OAUTH_TOKEN"]).CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
  const file = join(t.aoHome, "keys.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(readFileSync(file, "utf8").includes(TOKEN));
  const done = t.l.status()[0];
  assert.equal(done.screen, undefined, "the screen is gone once the token is taken");
  assert.ok(done.expiresAt);
  // The process is ended, not left waiting.
  const child = t.p.children[0];
  await until(() => child.exitCode !== null || child.signalCode !== null, 3000, "setup-token ended");
  assert.throws(() => t.l.input("claude", "x"), (e) => e.status === 409);
  assert.deepEqual(t.l.pids(), []);
  const everything = JSON.stringify(t.flows) + JSON.stringify(t.l.status()) + t.logs.join("\n");
  assert.ok(!everything.includes(TOKEN) && !everything.includes(TOKEN.slice(20, 60)), "no token in a frame, a status or a log");
  assert.equal(t.p.spawns[0].env.ANTHROPIC_API_KEY, undefined);
  assert.deepEqual(t.p.spawns[0].args, ["setup-token"]);
});

test("Connect Claude: an exit without a token fails plainly; cancel ends a running one", async () => {
  const t = logins({ env: { FAKE_FAIL: "1" } });
  await t.l.start("claude");
  await until(() => t.l.status()[0].state === "failed", 5000, "failed");
  assert.match(t.l.status()[0].error, /ended .* without a token/);
  const u = logins();
  await u.l.start("claude");
  await until(() => u.l.status()[0].state === "running" && u.l.status()[0].screen, 5000, "running");
  u.l.cancel("claude");
  assert.equal(u.l.status()[0].state, "idle");
  const child = u.p.children[0];
  await until(() => child.exitCode !== null || child.signalCode !== null, 3000, "ended");
});

test("the screen the page gets never carries a token", () => {
  const screen = `Your OAuth token (valid for 1 year):\n\n${TOKEN}\n\nStore this token securely.\nsk-ant-api03-somekeyvalue\nhttps://claude.ai/oauth/authorize?x=1`;
  const s = M.scrubScreen(screen);
  assert.ok(!s.includes(TOKEN) && !s.includes("somekeyvalue"));
  assert.match(s, /https:\/\/claude\.ai\/oauth\/authorize\?x=1/);
  assert.equal(M.tokenOf(screen), TOKEN);
  assert.equal(M.tokenOf("nothing here"), undefined);
  assert.equal(M.validFor("Your OAuth token (valid for 30 days):"), 30 * 86400_000);
});
