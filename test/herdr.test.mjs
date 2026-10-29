// Tests for the herdr bridge (src/herdr/bridge.ts), its socket client (client.ts) and the plugin's settings (plugin.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

async function load(...entries) {
  const dir = mkdtempSync(join(tmpdir(), "agent-visualizer-test-"));
  const outfile = join(dir, "mod.mjs");
  await build({
    stdin: { contents: entries.map((e) => `export * from ${JSON.stringify(`./${e}`)};`).join("\n"), resolveDir: ROOT, loader: "ts" },
    bundle: true, platform: "node", format: "esm", target: "node18", outfile, logLevel: "error", external: ["@lydell/node-pty"],
  });
  try {
    return await import(pathToFileURL(outfile).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const M = await load("src/herdr/bridge.ts", "src/herdr/client.ts", "src/herdr/plugin.ts");

const CLAUDE_SID = "11111111-2222-4333-8444-555555555555";
/** One herdr agent as session.snapshot lists it. */
const agent = (pane, name, status, o = {}) => ({
  pane_id: pane, workspace_id: pane.split(":")[0], agent: name, agent_status: status, cwd: o.cwd ?? `/Users/me/Codes/${name}-app`,
  ...(o.session ? { agent_session: { agent: name, kind: o.kind ?? "id", source: `herdr:${name}`, value: o.session } } : {}),
});

/** A fake herdr: a snapshot to answer with, and every request it got. */
function fakeHerdr(agents = []) {
  const calls = [];
  const h = {
    agents,
    calls,
    request: async (method, params) => {
      calls.push([method, params]);
      if (method === "session.snapshot") return { type: "session_snapshot", snapshot: { agents: h.agents, workspaces: h.agents.map((a) => ({ workspace_id: a.workspace_id, label: `ws-${a.workspace_id}` })) } };
      if (method === "workspace.create") return { type: "workspace_created", root_pane: { pane_id: "w9:p1" } };
      if (method === "agent.start" || method === "agent.focus") return { type: "ok" };
      throw new Error(`unexpected ${method}`);
    },
  };
  return h;
}

function bridge(mode, h, o = {}) {
  let t = 1_000_000;
  const events = [];
  const b = M.startHerdr({ mode, request: h.request, onEvent: (e) => events.push(e), has: o.has ?? (() => false), manual: true, now: () => t });
  return { b, events, advance: (ms) => (t += ms) };
}

const kinds = (evs) => evs.map((e) => `${e.workerId}:${e.kind}${e.summary ? `(${e.summary})` : ""}`);

test("herd mode: herdr's agents walk in posed by its state, change with it, and leave with their pane", async () => {
  const h = fakeHerdr([agent("w1:p1", "claude", "working", { session: CLAUDE_SID }), agent("w2:p1", "pi", "idle", { session: "/x/pi.jsonl", kind: "path" })]);
  const { b, events, advance } = bridge("herd", h);
  await b.tick();
  assert.deepEqual(kinds(events), [
    `${CLAUDE_SID}:session_start`, `${CLAUDE_SID}:thinking(Working)`,
    "herdr:w2:p1:session_start", "herdr:w2:p1:idle",
  ]);
  // a known kind keeps its session id (the transcript's worker id); others are "other", named by herdr
  assert.equal(events[0].agent, "claude");
  assert.equal(events[0].project, "claude-app");
  assert.equal(events[2].agent, "other");
  assert.equal(events[2].model, "pi");
  assert.equal(b.paneOf(CLAUDE_SID), "w1:p1");
  events.length = 0;
  h.agents[0].agent_status = "blocked";
  h.agents[1].agent_status = "done";
  await b.tick();
  assert.deepEqual(kinds(events), [`${CLAUDE_SID}:waiting(Needs you)`, "herdr:w2:p1:waiting(Done)"]);
  events.length = 0;
  await b.tick();
  assert.deepEqual(events, [], "nothing changed, nothing sent");
  advance(61_000);
  await b.tick();
  assert.deepEqual(kinds(events), [`${CLAUDE_SID}:session_start`, "herdr:w2:p1:session_start"], "live agents are re-sighted so the quiet timer leaves them be");
  events.length = 0;
  h.agents.pop();
  await b.tick();
  assert.deepEqual(kinds(events), ["herdr:w2:p1:session_end"]);
  assert.equal(b.available(), true);
});

test("herd mode: only herdr's agents' transcripts (and their interns') get in, and they take over the poses", async () => {
  const h = fakeHerdr([agent("w1:p1", "claude", "idle", { session: CLAUDE_SID })]);
  const { b, events } = bridge("herd", h);
  await b.tick();
  const ev = (workerId, parentId) => ({ ts: "", agent: "claude", workerId, project: "p", kind: "tool_start", ...(parentId ? { parentId } : {}) });
  assert.equal(b.admit(ev(CLAUDE_SID)), true);
  assert.equal(b.admit(ev("someone-else")), false, "an agent outside herdr stays out");
  assert.equal(b.admit(ev("agent-a1", CLAUDE_SID)), true, "its intern");
  assert.equal(b.admit(ev("agent-a2", "agent-a1")), true, "and the intern's intern");
  events.length = 0;
  h.agents[0].agent_status = "working";
  await b.tick();
  assert.deepEqual(events, [], "the transcript is telling the story: herdr's 'working' adds nothing");
  h.agents[0].agent_status = "blocked";
  await b.tick();
  assert.deepEqual(kinds(events), [`${CLAUDE_SID}:waiting(Needs you)`], "but a permission prompt the transcript can't see does");
});

test("machine mode: herdr only raises the hand of a blocked worker the office already has; everything gets in", async () => {
  const h = fakeHerdr([agent("w1:p1", "claude", "working", { session: CLAUDE_SID }), agent("w2:p1", "codex", "blocked", { session: "c-1" })]);
  const { b, events } = bridge("machine", h, { has: (id) => id === CLAUDE_SID });
  await b.tick();
  assert.deepEqual(events, [], "no walk-ins, no poses: the office's own sources do that");
  h.agents[0].agent_status = "blocked";
  await b.tick();
  assert.deepEqual(kinds(events), [`${CLAUDE_SID}:waiting(Needs you)`]);
  h.agents.length = 0;
  await b.tick();
  assert.equal(kinds(events).length, 1, "a closed pane sends no one home in machine mode");
  assert.equal(b.admit({ workerId: "anyone", kind: "tool_start" }), true);
});

test("focus and start go to herdr; agents herdr can't start are refused; unreachable herdr is just unavailable", async () => {
  const h = fakeHerdr([agent("w1:p1", "claude", "idle", { session: CLAUDE_SID })]);
  const { b } = bridge("machine", h);
  await b.tick();
  await b.focus(CLAUDE_SID);
  assert.deepEqual(h.calls.at(-1), ["agent.focus", { target: "w1:p1" }]);
  await assert.rejects(b.focus("nobody"), /isn't in a herdr pane/);
  const r = await b.start({ agent: "claude", folder: "/Users/me/Codes/site", args: ["--permission-mode", "default", "hi"] });
  assert.deepEqual(r, { pane: "w9:p1" });
  const create = h.calls.find((c) => c[0] === "workspace.create");
  assert.deepEqual(create[1], { cwd: "/Users/me/Codes/site", label: "site", focus: true });
  const start = h.calls.find((c) => c[0] === "agent.start");
  assert.deepEqual(start[1], { name: "claude-site", kind: "claude", pane_id: "w9:p1", args: ["--permission-mode", "default", "hi"], timeout_ms: 30_000 });
  await assert.rejects(b.start({ agent: "qwen", folder: "/x", args: [] }), /can't start qwen/);
  const down = M.startHerdr({ mode: "herd", request: async () => { throw new Error("ENOENT"); }, onEvent: () => {}, has: () => false, manual: true });
  await down.tick();
  assert.equal(down.available(), false);
  assert.deepEqual(down.agents(), []);
});

test("client: newline-delimited JSON over the socket, herdr's errors as HerdrError; socket path from env or ~/.config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-sock-"));
  const path = join(dir, "h.sock");
  const server = createServer((c) => {
    let buf = "";
    c.on("data", (d) => {
      buf += d;
      if (!buf.includes("\n")) return;
      const req = JSON.parse(buf.split("\n")[0]);
      const reply = req.method === "ping" ? { id: req.id, result: { type: "pong", version: "0.7.5" } } : { id: req.id, error: { code: "not_found", message: "no such pane" } };
      c.end(JSON.stringify(reply) + "\n");
    });
  });
  await new Promise((r) => server.listen(path, r));
  try {
    const req = M.herdrClient(path);
    assert.deepEqual(await req("ping"), { type: "pong", version: "0.7.5" });
    await assert.rejects(req("agent.focus", { target: "w0:p0" }), (e) => e instanceof M.HerdrError && e.code === "not_found" && /no such pane/.test(e.message));
    await assert.rejects(M.herdrClient(join(dir, "missing.sock"))("ping"));
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(M.herdrSocketPath({ HERDR_SOCKET_PATH: "/s" }, "/h"), "/s");
  assert.equal(M.herdrSocketPath({}, "/h"), "/h/.config/herdr/herdr.sock");
  assert.equal(M.herdrSocketPath({ XDG_CONFIG_HOME: "/x" }, "/h"), "/x/herdr/herdr.sock");
});

test("plugin settings: herd mode unless office.json says otherwise; name and port pass through, junk is ignored", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-cfg-"));
  try {
    assert.deepEqual(M.officeArgs(M.readPluginConfig({ HERDR_PLUGIN_CONFIG_DIR: dir })), ["--herd", "--no-open", "--quiet"]);
    writeFileSync(join(dir, "office.json"), JSON.stringify({ herd: false, name: "Paulo", port: 4790 }));
    assert.deepEqual(M.officeArgs(M.readPluginConfig({ HERDR_PLUGIN_CONFIG_DIR: dir })), ["--no-open", "--quiet", "--name", "Paulo", "--port", "4790"]);
    writeFileSync(join(dir, "office.json"), "{ not json");
    assert.deepEqual(M.readPluginConfig({ HERDR_PLUGIN_CONFIG_DIR: dir }), { herd: true });
    writeFileSync(join(dir, "office.json"), JSON.stringify({ port: 99999, name: 7 }));
    assert.deepEqual(M.readPluginConfig({ HERDR_PLUGIN_CONFIG_DIR: dir }), { herd: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
