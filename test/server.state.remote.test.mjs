// Tests for src/server/state.ts additions: hosts on workers and synthetic events, every agent kind,
// and the four kinds agents send through MCP (status sets mood; shout/celebrate/flip pass through).
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

async function load(...entries) {
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

const { OfficeState, IDLE_MS, GONE_MS } = await load("src/server/state.ts", "src/shared/events.ts");

const HOST = { kind: "vercel", id: "vercel:sbx_abc123", name: "sbx-abc" };
const W = `${HOST.id}/11111111-2222-4333-8444-555555555555`;

function office() {
  const clock = { t: Date.parse("2026-10-18T10:00:00Z") };
  const state = new OfficeState({ now: () => clock.t, home: "/Users/test" });
  const seen = [];
  state.subscribe((e) => seen.push(e));
  const iso = (dt = 0) => new Date(clock.t + dt).toISOString();
  const ev = (over = {}) => ({ ts: iso(), agent: "claude", workerId: W, project: "app", host: HOST, cwd: "/Users/test/app", kind: "prompt", ...over });
  const advance = (ms) => {
    clock.t += ms;
    state.tick();
  };
  return { state, seen, ev, iso, advance };
}

test("every agent kind is accepted", () => {
  const { state, ev } = office();
  for (const agent of ["claude", "commandcode", "codex", "opencode", "droid", "gemini", "qwen", "cursor"]) {
    assert.ok(state.ingest(ev({ agent, workerId: `w-${agent}`, host: undefined })), agent);
  }
  assert.equal(state.ingest(ev({ agent: "aider", workerId: "w-x" })), null);
});

test("a remote worker carries its host on the worker and on synthetic arrival, idle and session_end", () => {
  const { state, seen, ev, advance } = office();
  state.ingest(ev({ kind: "tool_start", tool: "Read", category: "read", summary: "Read a.ts" }));
  assert.equal(seen[0].kind, "session_start");
  assert.deepEqual(seen[0].host, HOST);
  assert.deepEqual(state.snapshot().workers[0].host, HOST);
  // Remote cwds are not this machine's: no "~" even when the path happens to match our home.
  assert.equal(state.snapshot().workers[0].cwd, "/Users/test/app");
  advance(IDLE_MS + 1);
  assert.equal(seen.at(-1).kind, "idle");
  assert.deepEqual(seen.at(-1).host, HOST);
  advance(GONE_MS);
  assert.equal(seen.at(-1).kind, "session_end");
  assert.deepEqual(seen.at(-1).host, HOST);
});

test("bad hosts are dropped, the event is kept", () => {
  const { state, ev } = office();
  assert.equal(state.ingest(ev({ workerId: "a", host: { kind: "mainframe", id: "x", name: "x" } })).host, undefined);
  assert.equal(state.ingest(ev({ workerId: "b", host: { kind: "local", id: "local", name: "local" } })).host, undefined);
  const long = state.ingest(ev({ workerId: "c", host: { kind: "ssh", id: "ssh:me@box", name: "box‮\u0000" + "x".repeat(80) } }));
  assert.equal(long.host.id, "ssh:me@box");
  assert.ok(long.host.name.length <= 48 && !/[‮\u0000]/.test(long.host.name));
});

test("interns of a remote parent stay attached and leave with it", () => {
  const { state, seen, ev } = office();
  state.ingest(ev({ kind: "session_start" }));
  state.ingest(ev({ kind: "subagent_start", workerId: `${HOST.id}/agent-a1`, parentId: W, role: "Explore" }));
  assert.equal(state.snapshot().workers.find((w) => w.parentId).parentId, W);
  state.ingest(ev({ kind: "session_end" }));
  assert.equal(state.size, 0);
  assert.ok(seen.some((e) => e.kind === "subagent_end" && e.workerId === `${HOST.id}/agent-a1` && e.host?.id === HOST.id));
});

test("status sets the mood line without touching the pose or the counters", () => {
  const { state, seen, ev } = office();
  state.ingest(ev({ kind: "tool_start", tool: "Bash", category: "bash", summary: "$ npm test" }));
  const before = { ...state.snapshot().workers[0] };
  const e = state.ingest(ev({ kind: "status", tool: "🔥", summary: "refactoring auth" }));
  assert.equal(e.kind, "status");
  assert.equal(e.category, undefined, "a mood emoji is not a tool");
  const w = state.snapshot().workers[0];
  assert.equal(w.mood, "🔥 refactoring auth");
  assert.equal(w.status, "tool_start");
  assert.equal(w.summary, "$ npm test");
  assert.equal(w.toolCalls, before.toolCalls);
  state.ingest(ev({ kind: "status", summary: "just text" }));
  assert.equal(state.snapshot().workers[0].mood, "just text");
  assert.equal(seen.filter((x) => x.kind === "status").length, 2);
});

test("shout, celebrate and flip pass through, keep the worker awake, and never create one", () => {
  const { state, seen, ev, advance } = office();
  for (const kind of ["status", "shout", "celebrate", "flip"]) assert.equal(state.ingest(ev({ kind, workerId: "nobody" })), null);
  state.ingest(ev({ kind: "reply", summary: "Replied" }));
  for (const kind of ["shout", "celebrate", "flip"]) {
    const e = state.ingest(ev({ kind, summary: kind === "shout" ? "deploy is green sk-ant-api03-abcdefghijklmnop" : undefined }));
    assert.equal(e.kind, kind);
  }
  assert.ok(seen.find((x) => x.kind === "shout").summary.includes("•••"), "re-redacted");
  assert.equal(state.snapshot().workers[0].status, "reply");
  advance(IDLE_MS - 1_000);
  state.ingest(ev({ kind: "shout", summary: "still here" }));
  advance(2_000);
  assert.notEqual(state.snapshot().workers[0].status, "idle");
});

test("prefixed remote ids longer than local ones survive sanitising", () => {
  const { state, ev } = office();
  const id = `daytona:${"a".repeat(36)}/agent-${"b".repeat(40)}`;
  assert.equal(state.ingest(ev({ workerId: id, host: { kind: "daytona", id: `daytona:${"a".repeat(36)}`, name: "dev" } })).workerId, id);
});
