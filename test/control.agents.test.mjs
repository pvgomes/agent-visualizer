// Tests for src/control/agents.ts: launch argv per agent and permission mode, the Claude hook
// settings (token by env name only), remote launches (prompt and keys by env, never argv),
// chat commands, binary discovery and the availability probe.
import nodeTest, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fakeBin, load, scratch } from "./control.session-fakes.mjs";
import { CONTROL, skipAll } from "./platform.mjs";

const test = skipAll(nodeTest, CONTROL);

const A = await load("src/control/agents.ts");
after(cleanup);
const { terminalLaunch, chatLaunch, permissionsOf, driveOf, findBin, probeAgents, parseVersion, claudeHookSettings, pinsSessionId, AGENTS } = A;

const flat = (l) => l.argv.map((a) => (typeof a === "string" ? a : `$${a.env}`));

test("Claude: pinned id, an explicit permission mode, per-run hooks with the token only by name", () => {
  const l = terminalLaunch({
    agent: "claude", bin: "/x/claude", cwd: "/w", permission: "default", prompt: "fix the tests", sessionId: "11111111-2222-3333-4444-555555555555",
    hook: { url: "http://127.0.0.1:4747/", token: "tok-secret-value", sessionId: "ab12cd34" },
  });
  const argv = flat(l);
  assert.deepEqual(argv.slice(0, 5), ["/x/claude", "--session-id", "11111111-2222-3333-4444-555555555555", "--permission-mode", "default"]);
  assert.equal(argv.at(-1), "fix the tests");
  const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]);
  const hook = settings.hooks.PermissionRequest[0].hooks[0];
  assert.equal(hook.type, "http");
  assert.equal(hook.url, "http://127.0.0.1:4747/api/hook/ab12cd34/permission");
  assert.deepEqual(hook.headers, { Authorization: "Bearer $AO_HOOK_TOKEN" });
  assert.deepEqual(hook.allowedEnvVars, ["AO_HOOK_TOKEN"]);
  const start = settings.hooks.SessionStart[0].hooks[0];
  assert.equal(start.type, "command", "Claude fires no http hooks for SessionStart");
  assert.match(start.command, /--variable %AO_HOOK_TOKEN --expand-header 'Authorization: Bearer \{\{AO_HOOK_TOKEN\}\}'/);
  assert.match(start.command, /'http:\/\/127\.0\.0\.1:4747\/api\/hook\/ab12cd34\/session-start' >\/dev\/null 2>&1 \|\| true$/);
  assert.ok(!argv.join(" ").includes("tok-secret-value"), "the token is never on argv");
  assert.equal(l.env.AO_HOOK_TOKEN, "tok-secret-value");
  assert.deepEqual(l.secret, ["AO_HOOK_TOKEN"]);
  assert.deepEqual(flat(terminalLaunch({ agent: "claude", bin: "claude", cwd: "/w", permission: "bypass" })), ["claude", "--dangerously-skip-permissions"]);
  assert.deepEqual(JSON.parse(claudeHookSettings({ url: "http://h:1", sessionId: "s" })).hooks.PermissionRequest[0].hooks[0].timeout, 1800);
});

test("every agent's TUI argv, first-run flags and prompt placement", () => {
  const L = (agent, permission = "default", prompt = "hi") => flat(terminalLaunch({ agent, bin: agent, cwd: "/w", permission, prompt, sessionId: pinsSessionId(agent) ? "S" : undefined }));
  assert.deepEqual(L("codex"), ["codex", "-c", "check_for_update_on_startup=false", "-a", "on-request", "-s", "workspace-write", "-C", "/w", "hi"]);
  assert.deepEqual(L("codex", "plan"), ["codex", "-c", "check_for_update_on_startup=false", "-a", "on-request", "-s", "read-only", "-C", "/w", "hi"]);
  assert.deepEqual(L("codex", "bypass"), ["codex", "-c", "check_for_update_on_startup=false", "--dangerously-bypass-approvals-and-sandbox", "-C", "/w", "hi"]);
  assert.deepEqual(L("commandcode", "acceptEdits"), ["commandcode", "-t", "--skip-onboarding", "--no-auto-update", "--permission-mode", "accept-edits", "hi"]);
  assert.deepEqual(L("droid"), ["droid", "--cwd", "/w", "hi"]);
  assert.deepEqual(L("gemini", "acceptEdits"), ["gemini", "--session-id", "S", "--approval-mode", "auto_edit", "--skip-trust", "-i", "hi"]);
  assert.deepEqual(L("qwen", "acceptEdits"), ["qwen", "--session-id", "S", "--approval-mode", "auto-edit", "-i", "hi"]);
  assert.deepEqual(L("cursor", "bypass"), ["cursor", "--force", "hi"]);
  assert.deepEqual(L("opencode", "plan"), ["opencode", "--agent", "plan", "--prompt", "hi", "/w"]);
  const oc = terminalLaunch({ agent: "opencode", bin: "opencode", cwd: "/w", permission: "bypass", opencode: { port: 4512, password: "pw-secret" } });
  assert.deepEqual(flat(oc), ["opencode", "--port", "4512", "--hostname", "127.0.0.1", "--auto", "/w"]);
  assert.equal(oc.env.OPENCODE_SERVER_PASSWORD, "pw-secret");
  assert.deepEqual(oc.secret, ["OPENCODE_SERVER_PASSWORD"]);
  assert.equal(oc.env.OPENCODE_PERMISSION, undefined, "bypass is --auto, nothing to ask");
  // opencode allows everything by default: asking is passed explicitly, over the user's own config.
  const ask = terminalLaunch({ agent: "opencode", bin: "opencode", cwd: "/w", permission: "default" });
  assert.deepEqual(JSON.parse(ask.env.OPENCODE_PERMISSION), { edit: "ask", bash: "ask", webfetch: "ask", external_directory: "ask" });
  assert.equal(JSON.parse(terminalLaunch({ agent: "opencode", bin: "opencode", cwd: "/w", permission: "acceptEdits" }).env.OPENCODE_PERMISSION).edit, "allow");
  assert.equal(L("claude", "default", "-rf everything").at(-1), " -rf everything", "a prompt can't be read as a flag");
});

test("remote launches: bare bins, the prompt and keys by env, Codex reads its key from env, no hooks", () => {
  const l = terminalLaunch({ agent: "claude", bin: "claude", cwd: "~/app", permission: "plan", prompt: "it's \"quoted\" $HOME", remote: true, keys: { ANTHROPIC_API_KEY: "sk-ant-dummy" }, hook: { url: "http://x", token: "t", sessionId: "s" }, path: ["$HOME/.local/bin"] });
  assert.deepEqual(flat(l), ["claude", "--permission-mode", "plan", "$AO_PROMPT"]);
  assert.equal(l.env.AO_PROMPT, "it's \"quoted\" $HOME");
  assert.equal(l.env.ANTHROPIC_API_KEY, "sk-ant-dummy");
  assert.deepEqual(l.secret, ["ANTHROPIC_API_KEY"]);
  assert.deepEqual(l.path, ["$HOME/.local/bin"]);
  assert.ok(!flat(l).some((a) => a.includes("sk-ant")));
  const cx = flat(terminalLaunch({ agent: "codex", bin: "codex", cwd: "/w", permission: "default", remote: true, keys: { OPENAI_API_KEY: "sk-dummy" } }));
  assert.ok(cx.includes("model_provider=agent-visualizer"));
  assert.ok(cx.some((a) => a.includes('env_key="OPENAI_API_KEY"')));
  assert.ok(!cx.some((a) => a.includes("sk-dummy")));
});

test("chat commands", () => {
  assert.deepEqual(flat(chatLaunch({ agent: "claude", bin: "claude", cwd: "/w", permission: "acceptEdits", sessionId: "S" })), [
    "claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--permission-prompt-tool", "stdio", "--permission-mode", "acceptEdits", "--session-id", "S",
  ]);
  assert.deepEqual(flat(chatLaunch({ agent: "codex", bin: "codex", cwd: "/w", permission: "default" })), ["codex", "app-server"]);
  const oc = chatLaunch({ agent: "opencode", bin: "opencode", cwd: "/w", permission: "default", opencode: { port: 4513, password: "pw" } });
  assert.deepEqual(flat(oc), ["opencode", "serve", "--port", "4513", "--hostname", "127.0.0.1"]);
  assert.deepEqual(oc.secret, ["OPENCODE_SERVER_PASSWORD"]);
  assert.equal(JSON.parse(oc.env.OPENCODE_PERMISSION).bash, "ask");
  assert.throws(() => chatLaunch({ agent: "droid", bin: "droid", cwd: "/w", permission: "default" }));
});

test("permission modes offered, drives and pins", () => {
  assert.deepEqual(permissionsOf("droid"), ["default"]);
  assert.deepEqual(permissionsOf("cursor"), ["default", "bypass"]);
  for (const a of ["claude", "codex", "opencode", "commandcode", "gemini", "qwen"]) assert.equal(permissionsOf(a).length, 4, a);
  assert.deepEqual(driveOf("opencode"), { submit: "opencode", enterDelayMs: 0, interrupt: "opencode" });
  assert.deepEqual(driveOf("commandcode"), { submit: "paste", enterDelayMs: 600, interrupt: "esc" });
  assert.equal(pinsSessionId("claude"), "exact");
  assert.equal(pinsSessionId("gemini"), "hint");
  assert.equal(pinsSessionId("codex"), null);
  assert.equal(AGENTS.length, 8);
});

test("versions and binaries: first on PATH wins, Cursor's `agent` only when it is Cursor's", () => {
  assert.equal(parseVersion("2.1.302 (Claude Code)"), "2.1.302");
  assert.equal(parseVersion("codex-cli 0.146.0\n"), "0.146.0");
  assert.equal(parseVersion("v1.2.3-beta.4"), "1.2.3-beta.4");
  assert.equal(parseVersion("no version"), undefined);
  const d = scratch();
  const bin = join(d, "bin");
  fakeBin(bin, "commandcode", "");
  fakeBin(bin, "agent", "");
  const env = { PATH: bin };
  assert.equal(findBin("commandcode", env), join(bin, "commandcode"));
  assert.equal(findBin("cursor", env), undefined, "some other `agent`");
  const cur = join(d, "cursor-install");
  fakeBin(cur, "cursor-agent-real", "");
  const bin2 = join(d, "bin2");
  mkdirSync(bin2);
  symlinkSync(join(cur, "cursor-agent-real"), join(bin2, "agent"));
  assert.equal(findBin("cursor", { PATH: bin2 }), join(bin2, "agent"));
});

test("availability: installed agents get versions and modes, missing ones an install hint, no PTY means a note", async () => {
  const d = scratch();
  const bin = join(d, "bin");
  fakeBin(bin, "claude", "");
  fakeBin(bin, "droid", "");
  const fakePty = { kind: "node-pty", spawn() {} };
  const r = await probeAgents({ env: { PATH: bin }, home: d, pty: fakePty, version: async (b) => (b.endsWith("claude") ? "2.1.302" : undefined) });
  const claude = r.agents.find((a) => a.agent === "claude");
  assert.deepEqual({ ...claude }, { agent: "claude", installed: true, modes: ["terminal", "chat"], keyNames: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"], version: "2.1.302" });
  const droid = r.agents.find((a) => a.agent === "droid");
  assert.deepEqual(droid.permissions, ["default"]);
  assert.match(droid.note, /default mode/);
  const codex = r.agents.find((a) => a.agent === "codex");
  assert.equal(codex.installed, false);
  assert.equal(codex.installCmd, "npm i -g @openai/codex");
  assert.deepEqual(codex.modes, ["terminal", "chat"], "modes a remote hire can use");
  assert.equal(r.bins.claude, join(bin, "claude"));
  const noPty = await probeAgents({ env: { PATH: bin }, home: d, pty: null, version: async () => undefined });
  const c2 = noPty.agents.find((a) => a.agent === "claude");
  assert.deepEqual(c2.modes, ["chat"]);
  assert.match(c2.note, /PTY library/);
  assert.deepEqual(noPty.agents.find((a) => a.agent === "droid").modes, []);
});
