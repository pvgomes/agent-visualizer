// Tests for src/demo: determinism, pacing, the early table flip, interns, redaction style, --agents,
// the sandboxed workers, and the MCP beats (status, shout, celebrate, a flip of its own).
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Bundle TS entry points into one temp ESM module and import it. */
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

const { createDemo, startDemo, OfficeState, SUMMARY_MAX } = await load(
  "src/demo/index.ts",
  "src/server/state.ts",
  "src/shared/events.ts",
);

const T0 = Date.parse("2026-10-18T09:00:00Z");

function run(seed, minutes, agents) {
  const events = [];
  const demo = createDemo({ seed, agents, now: () => T0, onEvent: (e) => events.push(e) });
  demo.advance(minutes * 60_000);
  return events;
}
const at = (e) => (Date.parse(e.ts) - T0) / 1000;

test("the opening is the arrivals: eight Claude Code and Cursor desks walk in over ~8s, the sandboxes beam in within 6s", () => {
  const events = run(7, 0.25);
  const local = events.filter((e) => e.kind === "session_start" && !e.host);
  const cloud = events.filter((e) => e.kind === "session_start" && e.host);
  assert.equal(local.length, 8, "eight local desks");
  assert.deepEqual([...new Set(local.map((e) => e.agent))].sort(), ["claude", "cursor"]);
  assert.ok(local.every((e) => at(e) >= 0.4 && at(e) <= 9), local.map(at).join(","));
  assert.ok(new Set(local.map((e) => Math.round(at(e)))).size >= 6, "spread out: the elevator dings again and again");
  assert.equal(cloud.length, 5);
  assert.ok(cloud.every((e) => at(e) <= 6), cloud.map(at).join(","));
});

test("never two table flips within 8s of each other", () => {
  for (const seed of [1, 7, 42, 2026]) {
    const flips = run(seed, 15).filter((e) => e.kind === "test_fail" || e.kind === "flip").map(at);
    for (let i = 1; i < flips.length; i++) assert.ok(flips[i] - flips[i - 1] >= 7.9, `seed ${seed}: ${flips[i - 1]} then ${flips[i]}`);
  }
});

test("the same seed replays the same office; another seed doesn't", () => {
  const a = JSON.stringify(run(11, 5));
  assert.equal(a, JSON.stringify(run(11, 5)));
  assert.notEqual(a, JSON.stringify(run(12, 5)));
});

test("a table flip in the first 20 seconds, whatever the seed", () => {
  for (const seed of [1, 7, 42, 2026, -5]) {
    const flip = run(seed, 0.5).find((e) => e.kind === "test_fail");
    assert.ok(flip && at(flip) < 20, `seed ${seed}: ${flip && at(flip)}`);
  }
});

test("pacing is ~3-8 events/sec with 8-14 workers, ~1 in 4 test runs failing", () => {
  const events = run(7, 20);
  const rate = events.length / (20 * 60);
  // A busy office: short human think time between turns, so most workers are animating at any moment.
  assert.ok(rate >= 3 && rate <= 8, `rate ${rate.toFixed(2)}/s`);
  const live = new Set();
  let i = 0;
  for (let s = 0; s <= 20 * 60; s += 15) {
    while (i < events.length && at(events[i]) <= s) {
      const e = events[i++];
      if (e.kind === "session_start") live.add(e.workerId);
      if (e.kind === "session_end") live.delete(e.workerId);
    }
    if (s >= 60) assert.ok(live.size >= 8 && live.size <= 14, `${live.size} workers at ${s}s`);
  }
  const fails = events.filter((e) => e.kind === "test_fail").length;
  const passes = events.filter((e) => e.kind === "test_pass").length;
  const ratio = fails / (fails + passes);
  assert.ok(ratio > 0.12 && ratio < 0.4, `fail ratio ${ratio.toFixed(2)}`);
  for (const kind of ["web", "mcp", "todo", "agent", "read", "edit", "bash", "search"]) {
    assert.ok(events.some((e) => e.category === kind), `no ${kind} calls`);
  }
});

test("interns belong to Claude and Codex sessions, arrive after their Spawn and leave", () => {
  const events = run(3, 15);
  const sessions = new Map();
  const open = new Map();
  for (const e of events) {
    if (e.kind === "session_start") sessions.set(e.workerId, e);
    if (e.kind === "subagent_start") {
      const parent = sessions.get(e.parentId);
      assert.ok(parent, "parent session exists");
      assert.ok(["claude", "codex"].includes(parent.agent), parent.agent);
      assert.ok((parent.agent === "codex" ? ["explorer", "worker"] : ["Explore", "general-purpose", "Plan"]).includes(e.role), e.role);
      open.set(e.workerId, e);
    }
    if (e.kind === "subagent_end") {
      assert.ok(open.delete(e.workerId), "ends an intern that started");
    }
  }
  assert.ok(events.filter((e) => e.kind === "subagent_start").length >= 3);
  const spawns = events.filter((e) => e.category === "agent" && e.kind === "tool_start");
  assert.ok(spawns.every((e) => /^Spawn (Explore|general-purpose|Plan|agent)$/.test(e.summary)));
  assert.ok(open.size <= 3, "only the interns still at work when the clock stopped");
});

test("summaries are short and in the redacted style", () => {
  const events = run(5, 10);
  for (const e of events) {
    if (!e.summary) continue;
    assert.ok([...e.summary].length <= SUMMARY_MAX, e.summary);
    if (e.category === "bash") assert.match(e.summary, /^\$ [\w.-]+( [\w.-]+)?$/, e.summary);
    if (e.category === "edit") assert.match(e.summary, /^(Edit|Write) [\w.-]+$/, e.summary);
    if (e.category === "read") assert.match(e.summary, /^Read [\w.-]+$/, e.summary);
    if (e.category === "search") assert.match(e.summary, /^Search \S+$/, e.summary);
  }
  // Local paths are shown from ~; a sandbox's are its own absolute paths.
  assert.ok(events.every((e) => !e.cwd || (e.host ? e.cwd.startsWith("/") : e.cwd.startsWith("~/"))));
});

test("five workers run in sandboxes on Vercel and Railway, shaped like real remote events", () => {
  const events = run(7, 3);
  const starts = events.filter((e) => e.kind === "session_start" && e.host);
  assert.equal(starts.length, 5);
  assert.deepEqual([...new Set(starts.map((e) => e.host.kind))].sort(), ["railway", "vercel"]);
  for (const e of events.filter((e) => e.host)) {
    assert.ok(e.workerId.startsWith(e.host.id + "/"), e.workerId);
    if (e.parentId) assert.ok(e.parentId.startsWith(e.host.id + "/"), e.parentId);
  }
  const kinds = new Set(events.filter((e) => e.kind === "session_start").map((e) => e.agent));
  assert.deepEqual([...kinds].sort(), ["claude", "cursor"]);
  // Sandboxes keep their workers: still five there after 20 minutes.
  const late = run(7, 20);
  const live = new Map();
  for (const e of late) {
    if (!e.host || e.parentId) continue;
    if (e.kind === "session_start") live.set(e.workerId, e);
    if (e.kind === "session_end") live.delete(e.workerId);
  }
  assert.ok(live.size >= 4 && live.size <= 5, `${live.size} in the cloud`);
});

test("the MCP beats: a status at ~3s, a shout and confetti after the flip, a flip of its own at ~38s", () => {
  for (const seed of [1, 7, 42]) {
    const events = run(seed, 1);
    const hero = events.find((e) => e.kind === "test_fail");
    const mood = events.find((e) => e.kind === "status" && e.workerId === hero.workerId);
    assert.ok(mood && at(mood) < 5, `seed ${seed}: status at ${mood && at(mood)}`);
    assert.equal(mood.tool, "🧠");
    assert.equal(mood.summary, "deep in the auth refactor");
    const shout = events.find((e) => e.kind === "shout" && e.workerId === hero.workerId);
    assert.ok(shout && at(shout) > at(hero) && at(shout) < 40, `seed ${seed}: shout at ${shout && at(shout)}`);
    assert.equal(shout.summary, "shipped v2 🚀");
    assert.ok(events.some((e) => e.kind === "celebrate" && e.workerId === hero.workerId && at(e) >= at(shout)));
    const own = events.find((e) => e.kind === "flip");
    assert.ok(own && own.host?.kind === "railway" && at(own) < 45, `seed ${seed}: own flip at ${own && at(own)}`);
  }
  // Later on, signals keep coming now and then.
  const long = run(7, 20);
  assert.ok(long.filter((e) => e.kind === "status").length >= 10);
  assert.ok(long.filter((e) => e.kind === "shout").length >= 2);
});

test("--agents recasts the office", () => {
  const only = run(7, 5, ["codex"]);
  assert.ok(only.length > 100);
  assert.ok(only.every((e) => e.agent === "codex"));
  assert.ok(only.every((e) => /^gpt-/.test(e.model)));
  assert.ok(only.some((e) => e.host), "the sandboxes are recast too");
  const two = new Set(run(7, 5, ["claude", "commandcode"]).map((e) => e.agent));
  assert.deepEqual([...two].sort(), ["claude", "commandcode"]);
});

test("every demo event is accepted by the state store", () => {
  const state = new OfficeState({ demo: true, now: () => T0 });
  const events = run(9, 10);
  let dropped = 0;
  for (const e of events) if (!state.ingest(e)) dropped++;
  assert.equal(dropped, 0);
  assert.ok(state.sessions().length >= 4);
});

test("startDemo drives the clock in real time and stops cleanly", async () => {
  const events = [];
  const demo = startDemo({ seed: 1, speed: 20, onEvent: (e) => events.push(e) });
  await new Promise((r) => setTimeout(r, 400));
  demo.stop();
  const n = events.length;
  assert.ok(n > 20, `${n} events at 20x for 0.4s`);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(events.length, n, "nothing after stop()");
});
