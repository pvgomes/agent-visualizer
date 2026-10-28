// Tests for src/control/sessions.ts with fake agents in a real PTY: hire walks a worker in and
// follows the transcript link, the terminal replays and takes input (browser query answers
// dropped), prompts are a bracketed paste + Enter, Interrupt is one Esc, Stop is SIGHUP then
// SIGKILL, Claude's permission hook opens an approval only with a viewer, remote places get bare
// argv with secrets by env, and bad hires are refused with the right status.
import nodeTest, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, FAKE_TUI, fakeBin, fakeContext, load, NODE_DIR, scratch, sleep, until } from "./control.session-fakes.mjs";
import { CONTROL, skipAll } from "./platform.mjs";

const test = skipAll(nodeTest, CONTROL);

const { createSessionManager, loadPty, ControlError } = await load("src/control/sessions.ts", "src/control/pty.ts", "src/control/types.ts");
const managers = [];
after(async () => {
  // A failed test must not leave its fake agents running.
  await Promise.all(managers.map((m) => m.shutdown()));
  cleanup();
});
const pty = await loadPty();

function setup(o = {}) {
  const root = scratch();
  const userHome = join(root, "home");
  const project = join(userHome, "code", "api-gateway");
  mkdirSync(project, { recursive: true });
  const bin = join(root, "bin");
  const log = join(root, "agent.log");
  for (const b of ["claude", "codex", "droid", "cursor-agent", "command-code", "opencode"]) fakeBin(bin, b, FAKE_TUI);
  const f = fakeContext({ userHome, path: `${bin}:${NODE_DIR}:/usr/bin:/bin`, ...o, env: { FAKE_LOG: log, ...(o.env ?? {}) } });
  const mgr = createSessionManager(f.ctx, o.places, { pty, version: async () => "1.0.0", enterDelayMs: 60, stopGraceMs: 400, exitedKeepMs: 200, ...(o.mgr ?? {}) });
  managers.push(mgr);
  const changes = [];
  mgr.onChange((s) => changes.push(s));
  const records = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const got = () => records().filter((r) => r.got).map((r) => r.got);
  return { ...f, mgr, project, userHome, root, changes, records, got, log };
}

function termViewer(mgr, id) {
  const chunks = [];
  let exit;
  const d = mgr.attachTerm(id, { data: (c) => chunks.push(Buffer.from(c)), exit: (code) => (exit = { code }) });
  return { text: () => Buffer.concat(chunks).toString("utf8"), exit: () => exit, dispose: () => d.dispose() };
}

test("a trust dialog drawn in several chunks shows in the status until it is answered", { skip: !pty && "no PTY here" }, async () => {
  const t = setup({ env: { FAKE_TRUST: "1" } });
  const s = await t.mgr.hire({ agent: "claude", place: { kind: "local", target: t.project }, mode: "terminal" });
  await until(() => t.mgr.get(s.id).detail === "Answer the trust question in the terminal", 15000, "the trust detail");
  t.mgr.input(s.id, "t");
  await until(() => t.mgr.get(s.id).detail === undefined, 15000, "the detail cleared once answered");
  await t.mgr.stop(s.id);
});

test("hire Claude in a terminal: walks in held, pins its session, hooks by env, runs, links, prompts, stops", { skip: !pty && "no PTY here" }, async () => {
  const t = setup({ env: { CLAUDECODE: "1" } });
  const s = await t.mgr.hire({ agent: "claude", place: { kind: "local", target: t.project }, mode: "terminal", prompt: "reply with OK" });
  assert.equal(s.status, "starting");
  assert.equal(s.workerId, `ctl:${s.id}`);
  assert.equal(s.title, "api-gateway");
  assert.equal(s.permission, "default");
  const start = t.emitted[0];
  assert.deepEqual({ kind: start.kind, workerId: start.workerId, agent: start.agent, project: start.project, cwd: start.cwd }, { kind: "session_start", workerId: s.workerId, agent: "claude", project: "api-gateway", cwd: t.project });
  assert.ok(t.held.has(s.workerId));

  await until(() => t.mgr.get(s.id).status === "running", 15000, "running");
  assert.ok(t.emitted.some((e) => e.kind === "prompt" && e.workerId === s.workerId), "a paper plane for the first prompt");
  const rec = await until(() => t.records()[0], 3000, "the agent's argv");
  const sid = rec.argv[rec.argv.indexOf("--session-id") + 1];
  assert.match(sid, /^[0-9a-f-]{36}$/);
  assert.deepEqual(rec.argv.slice(2, 4), ["--permission-mode", "default"]);
  assert.equal(rec.argv.at(-1), "reply with OK");
  const settings = JSON.parse(rec.argv[rec.argv.indexOf("--settings") + 1]);
  assert.equal(settings.hooks.PermissionRequest[0].hooks[0].url, `http://127.0.0.1:4599/api/hook/${s.id}/permission`);
  assert.equal(rec.hookToken, 48, "the hook token reaches the agent by env");
  assert.ok(!rec.argv.join(" ").match(/[0-9a-f]{48}/), "and never by argv");
  assert.equal(rec.cwd, t.project);
  assert.ok(rec.env.includes("COLORTERM") && rec.env.includes("TERM"));
  assert.equal(t.expectations.length, 1);
  assert.deepEqual({ placeholder: t.expectations[0].placeholder, agent: t.expectations[0].agent, cwd: t.expectations[0].cwd, sessionId: t.expectations[0].sessionId }, { placeholder: s.workerId, agent: "claude", cwd: t.project, sessionId: sid });

  // The TUI's own DSR was answered by the server; a browser's late copy is dropped.
  await until(() => t.got().some((g) => g.startsWith("CPR[")), 3000, "server-side CPR");
  t.mgr.input(s.id, "\x1b[9;9R");
  t.mgr.input(s.id, "x");
  await until(() => t.got().includes("KEY[x]"), 3000, "a key");
  assert.equal(t.got().filter((g) => g.startsWith("CPR[")).length, 1, "the agent read one CPR");

  // The transcript shows up: the session follows the renamed worker.
  t.linkTo(sid);
  assert.equal(t.mgr.get(s.id).workerId, sid);
  assert.equal(t.changes.at(-1).workerId, sid);

  // Replay for a browser that attaches late.
  const v = termViewer(t.mgr, s.id);
  await until(() => v.text().includes("fake tui ready"), 3000, "replay");

  await t.mgr.prompt(s.id, "line one\r\nline two\x1b[201~ \x03end");
  await until(() => t.got().includes("ENTER"), 3000, "enter after the paste");
  assert.ok(t.got().includes("PASTE[line one\\nline two end]"), JSON.stringify(t.got()));
  assert.ok(t.got().indexOf("PASTE[line one\\nline two end]") < t.got().indexOf("ENTER"));

  await t.mgr.interrupt(s.id);
  await t.mgr.interrupt(s.id);
  await until(() => t.got().includes("ESC"), 3000, "esc");
  await sleep(150);
  assert.equal(t.got().filter((g) => g === "ESC").length, 1, "never two Escs within 1.5 s");

  t.mgr.resize(s.id, 100, 30);
  await t.mgr.stop(s.id);
  await until(() => t.mgr.get(s.id)?.status === "exited", 15000, "exit");
  assert.equal(t.mgr.get(s.id).exitCode, 0);
  assert.deepEqual(t.ended, [sid]);
  await until(() => v.exit(), 2000, "viewer exit");
  assert.match(v.text(), /HUP/);
  assert.ok(t.expectations.every((x) => x.disposed));
  assert.deepEqual(t.mgr.ownedPids(), []);
  const goneIds = [];
  t.mgr.onGone((id) => goneIds.push(id));
  await until(() => goneIds.includes(s.id), 2000, "gone after the keep period");
  assert.equal(t.mgr.get(s.id), undefined);
});

test("Stop escalates to SIGKILL when the agent ignores SIGHUP; ownedPids lists the PTY child meanwhile", { skip: !pty && "no PTY here" }, async () => {
  const t = setup({ env: { FAKE_IGNORE_HUP: "1" } });
  const s = await t.mgr.hire({ agent: "droid", place: { kind: "local", target: t.project }, mode: "terminal" });
  await until(() => t.mgr.get(s.id).status === "running", 15000, "running");
  assert.ok(t.emitted.some((e) => e.kind === "waiting"), "no first prompt: the worker waits for you");
  const [pid] = t.mgr.ownedPids();
  assert.ok(pid > 0);
  assert.deepEqual((await until(() => t.records()[0], 3000, "argv")).argv, ["--cwd", t.project]);
  await t.mgr.stop(s.id);
  await until(() => t.mgr.get(s.id)?.status === "exited", 15000, "killed");
  assert.equal(t.mgr.get(s.id).exitCode, 137);
});

test("an agent that exits by itself ends its session and sends the worker home", { skip: !pty && "no PTY here" }, async () => {
  const t = setup();
  const s = await t.mgr.hire({ agent: "codex", place: { kind: "local", target: t.project }, mode: "terminal", permission: "plan" });
  await until(() => t.mgr.get(s.id).status === "running", 15000, "running");
  assert.deepEqual((await until(() => t.records()[0], 3000, "argv")).argv, ["-c", "check_for_update_on_startup=false", "-a", "on-request", "-s", "read-only", "-C", t.project]);
  assert.equal(t.expectations[0].sessionId, undefined, "Codex has no --session-id: agent + folder");
  t.mgr.input(s.id, "q");
  await until(() => t.mgr.get(s.id)?.status === "exited", 15000, "exit");
  assert.equal(t.mgr.get(s.id).exitCode, 3);
  assert.deepEqual(t.ended, [s.workerId]);
  await assert.rejects(t.mgr.prompt(s.id, "more"), (e) => e.status === 409);
});

test("hook calls with a wrong token or for an unknown session are refused", { skip: !pty && "no PTY here" }, async () => {
  const t = setup();
  const s = await t.mgr.hire({ agent: "claude", place: { kind: "local", target: t.project }, mode: "terminal" });
  await until(() => t.mgr.get(s.id).status === "running", 15000, "running");
  const body = { tool_name: "Bash", tool_input: { command: "ls" } };
  assert.deepEqual(await t.mgr.hook({ sessionId: s.id, event: "permission", token: "wrong", body }), { status: 401, body: { error: "Bad token." } });
  assert.deepEqual(await t.mgr.hook({ sessionId: s.id, event: "permission", token: "", body }), { status: 401, body: { error: "Bad token." } });
  assert.equal((await t.mgr.hook({ sessionId: "nope", event: "permission", token: "x", body })).status, 404);
  await t.mgr.stop(s.id);
  await until(() => t.mgr.get(s.id)?.status === "exited", 15000, "exit");
});

test("Claude's permission hook, end to end with the real token", { skip: !pty && "no PTY here" }, async () => {
  let viewers = 0;
  // A fake Claude that, on "go", calls its permission hook the way Claude Code does (bearer from its env).
  const t = setup({ viewers: () => viewers });
  const hookBin = join(t.root, "hookbin");
  fakeBin(hookBin, "claude", String.raw`
    const fs = require("node:fs");
    process.stdout.write("ready\r\n");
    process.stdin.setRawMode?.(true);
    process.stdin.on("data", (d) => {
      const s = d.toString();
      if (s.includes("go")) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ token: process.env.AO_HOOK_TOKEN }) + "\n");
    });
    process.on("SIGHUP", () => process.exit(0));
  `);
  const t2 = setup({ viewers: () => viewers, path: `${hookBin}:${NODE_DIR}:/usr/bin:/bin` });
  const s = await t2.mgr.hire({ agent: "claude", place: { kind: "local", target: t2.project }, mode: "terminal" });
  await until(() => t2.mgr.get(s.id).status === "running", 15000, "running");
  t2.mgr.input(s.id, "go");
  const token = (await until(() => t2.records().find((r) => r.token), 3000, "token")).token;
  const body = { tool_name: "Bash", tool_input: { command: "rm -rf dist" }, permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "rm:*" }], behavior: "allow", destination: "localSettings" }] };

  assert.deepEqual(await t2.mgr.hook({ sessionId: s.id, event: "permission", token, body }), { status: 200, body: {} }, "nobody watching: Claude asks in its TUI");

  viewers = 1;
  const pending = t2.mgr.hook({ sessionId: s.id, event: "permission", token, body });
  const open = await until(() => t2.mgr.get(s.id).pendingApproval, 3000, "approval");
  assert.equal(open.tool, "Bash");
  assert.equal(open.summary, "$ rm");
  assert.ok(t2.emitted.some((e) => e.kind === "waiting" && e.summary === "approve $ rm"));
  await assert.rejects(t2.mgr.answer(s.id, { id: "other", decision: "allow" }), (e) => e.status === 409);
  await t2.mgr.answer(s.id, { id: open.id, decision: "allow", always: true });
  const r = await pending;
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.hookSpecificOutput.decision.behavior, "allow");
  assert.deepEqual(r.body.hookSpecificOutput.decision.updatedPermissions, [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "rm:*" }], behavior: "allow", destination: "session" }]);
  assert.equal(t2.mgr.get(s.id).pendingApproval, undefined);
  assert.ok(t2.emitted.at(-1).kind === "thinking");

  // Deny, interrupt, the agent dropping the request, and the last viewer leaving.
  const p2 = t2.mgr.hook({ sessionId: s.id, event: "permission", token, body });
  const a2 = await until(() => t2.mgr.get(s.id).pendingApproval, 3000, "approval 2");
  await t2.mgr.answer(s.id, { id: a2.id, decision: "deny" });
  assert.deepEqual((await p2).body.hookSpecificOutput.decision, { behavior: "deny", message: "Denied from agent-visualizer" });

  const p3 = t2.mgr.hook({ sessionId: s.id, event: "permission", token, body });
  await until(() => t2.mgr.get(s.id).pendingApproval, 3000, "approval 3");
  await t2.mgr.interrupt(s.id);
  assert.equal((await p3).body.hookSpecificOutput.decision.interrupt, true);

  const ac = new AbortController();
  const p4 = t2.mgr.hook({ sessionId: s.id, event: "permission", token, body, signal: ac.signal });
  await until(() => t2.mgr.get(s.id).pendingApproval, 3000, "approval 4");
  ac.abort();
  assert.deepEqual((await p4).body, {});
  assert.equal(t2.mgr.get(s.id).pendingApproval, undefined);

  const p5 = t2.mgr.hook({ sessionId: s.id, event: "permission", token, body });
  await until(() => t2.mgr.get(s.id).pendingApproval, 3000, "approval 5");
  viewers = 0;
  assert.deepEqual((await p5).body, {}, "withdrawn when the last viewer leaves");

  // /clear: a new Claude session id re-links the desk exactly.
  const n = t2.expectations.length;
  assert.deepEqual(await t2.mgr.hook({ sessionId: s.id, event: "session-start", token, body: { session_id: "new-session-id", source: "clear" } }), { status: 200, body: {} });
  assert.equal(t2.expectations.length, n + 1);
  assert.equal(t2.expectations.at(-1).sessionId, "new-session-id");
  assert.equal(t2.expectations.at(-1).exactOnly, true);

  await t2.mgr.stop(s.id);
  await until(() => t2.mgr.get(s.id)?.status === "exited", 15000, "exit");
  assert.equal((await t2.mgr.hook({ sessionId: s.id, event: "permission", token, body })).status, 410);
});

test("bad hires are refused before anything starts", async () => {
  const t = setup();
  const hire = (o) => t.mgr.hire({ agent: "claude", place: { kind: "local", target: t.project }, mode: "terminal", ...o });
  const status = async (o) => {
    try {
      await hire(o);
      return "hired";
    } catch (e) {
      assert.ok(e instanceof ControlError, String(e));
      return e.status;
    }
  };
  assert.equal(await status({ agent: "nope" }), 400);
  assert.equal(await status({ mode: "split" }), 400);
  assert.equal(await status({ place: { kind: "local", target: "relative/dir" } }), 400);
  assert.equal(await status({ place: { kind: "local", target: join(t.project, "missing") } }), 400);
  assert.equal(await status({ place: { kind: "local", target: t.root } }), 403, "outside home");
  assert.equal(await status({ agent: "gemini" }), 400, "not installed");
  assert.equal(await status({ agent: "droid", permission: "bypass" }), 400, "Droid has no bypass flag");
  assert.equal(await status({ agent: "droid", mode: "chat" }), 400, "no chat mode");
  assert.equal(await status({ permission: "yolo" }), 400);
  assert.equal(await status({ place: { kind: "ssh", target: "box" } }), 503, "no places in this office");
  assert.equal(t.emitted.length, 0);
  assert.equal(t.mgr.list().length, 0);
});

test("a folder the office has seen agents in counts even outside home; no PTY means 503 for terminal mode", async () => {
  const outside = scratch();
  const t = setup({ recent: [outside], mgr: { pty: null } });
  await assert.rejects(t.mgr.hire({ agent: "claude", place: { kind: "local", target: outside }, mode: "terminal" }), (e) => e.status === 503);
  const av = await t.mgr.availability();
  assert.deepEqual(av.find((a) => a.agent === "claude").modes, ["chat"]);
});

test("remote: the place is opened, the agent ensured, the TTY attached with bare argv and secrets by env", { skip: !pty && "no PTY here" }, async () => {
  const opened = [];
  let attached;
  let closed = 0;
  let kept = 0;
  const cwd = scratch();
  const places = {
    status: async () => [],
    onChange: () => ({ dispose() {} }),
    deleteSandbox: async () => {},
    shutdown() {},
    async open(place, o) {
      opened.push(place);
      o.progress("creating", "Creating Daytona sandbox…");
      await sleep(20);
      return {
        host: { kind: "daytona", id: "daytona:sbx1", name: "agent-visualizer-1a2b3c" },
        cwd,
        ours: true,
        target: { host: { kind: "daytona", id: "daytona:sbx1", name: "agent-visualizer-1a2b3c" }, exec: async () => "" },
        ensureAgent: async (agent, progress) => {
          progress("installing", "Installing Claude Code…");
          return { bin: "claude", version: "2.1.302", path: ["$HOME/.local/bin"] };
        },
        firstRun: async () => {},
        attach: async (launch, size) => {
          attached = { launch, size };
          return pty.spawn({ file: "/bin/sh", args: ["-c", "echo remote up; sleep 30"], cwd, env: { PATH: "/usr/bin:/bin" }, ...size });
        },
        keepAlive: () => {
          kept++;
          return { dispose: () => kept-- };
        },
        close: () => closed++,
      };
    },
  };
  const t = setup({ places, keyValues: { ANTHROPIC_API_KEY: "sk-ant-dummy-value-123" } });
  await assert.rejects(t.mgr.hire({ agent: "claude", place: { kind: "daytona", target: "new" }, mode: "terminal", keys: ["MISSING_KEY"] }), (e) => e.status === 400);
  const s = await t.mgr.hire({ agent: "claude", place: { kind: "daytona", target: "new" }, mode: "terminal", prompt: "reply with OK", permission: "acceptEdits", keys: ["ANTHROPIC_API_KEY"], sandbox: { timeoutMin: 30 } });
  assert.equal(s.status, "creating");
  assert.equal(t.emitted.length, 0, "no worker until the host is known");
  await until(() => t.mgr.get(s.id).status === "running", 15000, "running");
  assert.ok(t.changes.some((c) => c.status === "creating" && c.detail === "Creating Daytona sandbox…"));
  assert.ok(t.changes.some((c) => c.status === "installing" && c.detail === "Installing Claude Code…"));
  const now = t.mgr.get(s.id);
  assert.deepEqual(now.host, { kind: "daytona", id: "daytona:sbx1", name: "agent-visualizer-1a2b3c" });
  assert.equal(now.title, "agent-visualizer-1a2b3c");
  assert.equal(t.emitted[0].kind, "session_start");
  assert.equal(t.emitted[0].host.id, "daytona:sbx1");
  const l = attached.launch;
  const argv = l.argv.map((a) => (typeof a === "string" ? a : `$${a.env}`));
  assert.equal(argv[0], "claude");
  assert.deepEqual(argv.slice(3), ["--permission-mode", "acceptEdits", "$AO_PROMPT"]);
  assert.ok(!argv.includes("--settings"), "a sandbox can't reach the office's hooks");
  assert.equal(l.env.AO_PROMPT, "reply with OK");
  assert.equal(l.env.ANTHROPIC_API_KEY, "sk-ant-dummy-value-123");
  assert.deepEqual(l.secret, ["ANTHROPIC_API_KEY"]);
  assert.deepEqual(l.path, ["$HOME/.local/bin"]);
  assert.deepEqual(attached.size, { cols: 120, rows: 32 });
  assert.equal(t.expectations[0].hostId, "daytona:sbx1");
  assert.equal(kept, 1);
  assert.ok(!t.logs.join("\n").includes("sk-ant-dummy"), "no key in the log");
  assert.ok(!JSON.stringify(t.changes).includes("sk-ant-dummy"), "or in any session frame");
  await t.mgr.stop(s.id);
  await until(() => t.mgr.get(s.id)?.status === "exited", 15000, "exit");
  assert.equal(closed, 1);
  assert.equal(kept, 0);
});

test("remote chat is hired into any place, and fails with a reason where the place can't pipe; opencode stays local", async () => {
  const host = { kind: "vercel", id: "vercel:sbx", name: "sbx" };
  const noPipe = { host, cwd: "/vercel", ours: true, target: { host, exec: async () => "" }, ensureAgent: async () => ({ bin: "claude" }), firstRun: async () => {}, attach: async () => { throw new Error("not reached"); }, keepAlive: () => ({ dispose() {} }), close() {} };
  const t = setup({ places: { open: async (place) => { if (place.kind === "vercel") return noPipe; throw new Error("not reached"); } } });
  const chat = await t.mgr.hire({ agent: "claude", place: { kind: "vercel", target: "sbx" }, mode: "chat" });
  await until(() => t.mgr.get(chat.id).status === "failed", 3000, "failed");
  assert.match(t.mgr.get(chat.id).error, /Chat mode isn't available there/);
  await assert.rejects(t.mgr.hire({ agent: "opencode", place: { kind: "ssh", target: "box" }, mode: "terminal" }), (e) => e.status === 400);
  // A place that fails to open ends as failed with a short, scrubbed reason.
  const s = await t.mgr.hire({ agent: "codex", place: { kind: "ssh", target: "box" }, mode: "terminal" });
  await until(() => t.mgr.get(s.id).status === "failed", 3000, "failed");
  assert.equal(t.mgr.get(s.id).error, "not reached");
});

test("shutdown ends every agent", { skip: !pty && "no PTY here" }, async () => {
  const t = setup({ env: { FAKE_IGNORE_HUP: "1" } });
  const a = await t.mgr.hire({ agent: "codex", place: { kind: "local", target: t.project }, mode: "terminal" });
  const b = await t.mgr.hire({ agent: "droid", place: { kind: "local", target: t.project }, mode: "terminal" });
  await until(() => t.mgr.list().every((s) => s.status === "running"), 15000, "running");
  const pids = t.mgr.ownedPids();
  assert.equal(pids.length, 2);
  await t.mgr.shutdown();
  assert.ok(t.mgr.list().every((s) => s.status === "exited"));
  for (const pid of pids) assert.throws(() => process.kill(pid, 0));
  assert.deepEqual(t.ended.sort(), [a.workerId, b.workerId].sort());
});
