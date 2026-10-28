// Tests for the control plane's side of src/server/state.ts (renames through `replaces` and the
// claimer, holds, end() tombstones, the stricter reconcileLocal), the linker (src/control/link.ts)
// and process presence (src/control/presence.ts with an injected scanner).
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

const { OfficeState, TOMBSTONE_MS, PRESENCE_QUIET_MS, GONE_MS, IDLE_MS, createLinker, createOfficePort, startPresence, parsePs, parseEtime } = await load(
  "src/server/state.ts",
  "src/shared/events.ts",
  "src/control/link.ts",
  "src/control/presence.ts",
  "src/ingest/presence.ts",
);

const HOME = "/Users/test";

function office() {
  const clock = { t: Date.parse("2026-10-18T10:00:00Z") };
  const state = new OfficeState({ now: () => clock.t, home: HOME });
  const seen = [];
  state.subscribe((e) => seen.push(e));
  const iso = (dt = 0) => new Date(clock.t + dt).toISOString();
  const ev = (over = {}) => ({ ts: iso(), agent: "claude", workerId: "s1", project: "site", cwd: `${HOME}/Codes/site`, kind: "prompt", ...over });
  const advance = (ms) => {
    clock.t += ms;
    state.tick();
  };
  return { state, seen, ev, iso, clock, advance };
}

test("a session_start with replaces renames the placeholder in place: no session_end, counters and interns move", () => {
  const { state, seen, ev } = office();
  state.ingest(ev({ workerId: "ctl:ab12", kind: "session_start" }));
  state.ingest(ev({ workerId: "ctl:ab12", kind: "tool_start", tool: "Read", category: "read", summary: "Read a.ts" }));
  state.ingest(ev({ workerId: "i1", parentId: "ctl:ab12", kind: "subagent_start", role: "Explore" }));
  state.hold("ctl:ab12");
  seen.length = 0;
  const out = state.ingest(ev({ workerId: "uuid-1", kind: "session_start", replaces: "ctl:ab12", model: "opus" }));
  assert.equal(out.replaces, "ctl:ab12");
  assert.deepEqual(seen.map((e) => [e.kind, e.workerId, e.replaces]), [["session_start", "uuid-1", "ctl:ab12"]]);
  const ws = state.snapshot().workers;
  assert.ok(!ws.some((w) => w.workerId === "ctl:ab12"));
  const w = ws.find((x) => x.workerId === "uuid-1");
  assert.equal(w.toolCalls, 1);
  assert.equal(w.model, "opus");
  assert.equal(ws.find((x) => x.workerId === "i1").parentId, "uuid-1", "interns follow their boss");
  assert.equal(state.isHeld("uuid-1"), true, "the hold moves with the rename");
  assert.equal(state.isHeld("ctl:ab12"), false);
  assert.deepEqual(ws.map((x) => x.workerId), ["uuid-1", "i1"], "same place in the worker order");
});

test("replaces is dropped when the placeholder is gone, the new id exists, or the event isn't a session_start", () => {
  const { state, seen, ev } = office();
  state.ingest(ev({ workerId: "a", kind: "session_start", replaces: "ctl:none" }));
  assert.equal(seen.at(-1).replaces, undefined);
  state.ingest(ev({ workerId: "ctl:x", kind: "session_start" }));
  state.ingest(ev({ workerId: "a", kind: "session_start", replaces: "ctl:x" }));
  assert.ok(state.has("ctl:x"), "a re-sighting never renames");
  state.ingest(ev({ workerId: "b", kind: "prompt", replaces: "ctl:x" }));
  assert.ok(state.has("ctl:x") && state.has("b"));
  assert.ok(seen.every((e) => e.kind === "session_start" || e.replaces === undefined));
});

test("the claimer renames instead of spawning, and a non-start event is folded right after the rename", () => {
  const { state, seen, ev } = office();
  state.ingest(ev({ workerId: "proc:42", kind: "session_start" }));
  const asked = [];
  state.setClaimer((e) => (asked.push(e.workerId), e.workerId === "t1" ? "proc:42" : undefined));
  seen.length = 0;
  state.ingest(ev({ workerId: "t1", kind: "tool_start", tool: "Edit", category: "edit", summary: "Edit a.ts" }));
  assert.deepEqual(seen.map((e) => [e.kind, e.workerId, e.replaces ?? ""]), [["session_start", "t1", "proc:42"], ["tool_start", "t1", ""]]);
  assert.equal(state.snapshot().workers.length, 1);
  // Interns and placeholders never ask; existing workers never ask.
  state.ingest(ev({ workerId: "i9", parentId: "t1", kind: "subagent_start" }));
  state.ingest(ev({ workerId: "ctl:zz", kind: "session_start" }));
  state.ingest(ev({ workerId: "t1", kind: "thinking" }));
  assert.deepEqual(asked, ["t1"]);
  // A claimer that throws just means a new desk.
  state.setClaimer(() => {
    throw new Error("boom");
  });
  assert.ok(state.ingest(ev({ workerId: "t2", kind: "session_start" })));
});

test("held workers never time out (idle still applies); released ones do", () => {
  const { state, seen, ev, advance } = office();
  state.ingest(ev({ workerId: "h", kind: "session_start" }));
  state.ingest(ev({ workerId: "u", kind: "session_start" }));
  state.hold("h");
  advance(IDLE_MS + 1);
  assert.ok(seen.some((e) => e.kind === "idle" && e.workerId === "h"), "idle still applies");
  advance(GONE_MS);
  assert.ok(state.has("h"));
  assert.ok(!state.has("u"));
  state.release("h");
  advance(1_000);
  assert.ok(!state.has("h"));
});

test("end() sends a worker and its interns home now and drops its transcript for a minute", () => {
  const { state, seen, ev, advance } = office();
  state.ingest(ev({ workerId: "w", kind: "session_start" }));
  state.ingest(ev({ workerId: "i", parentId: "w", kind: "subagent_start" }));
  state.hold("w");
  seen.length = 0;
  state.end("w");
  assert.deepEqual(seen.map((e) => [e.kind, e.workerId]), [["subagent_end", "i"], ["session_end", "w"]]);
  assert.equal(state.isHeld("w"), false);
  assert.equal(state.ingest(ev({ workerId: "w", kind: "reply" })), null, "a last line after the exit is dropped");
  assert.equal(state.ingest(ev({ workerId: "i", parentId: "w", kind: "tool_start", tool: "Read" })), null);
  assert.equal(state.ingest(ev({ workerId: "w", kind: "session_start" })), null);
  // ... unless it replaces a placeholder (the same session hired again).
  state.ingest(ev({ workerId: "ctl:n", kind: "session_start" }));
  assert.ok(state.ingest(ev({ workerId: "w", kind: "session_start", replaces: "ctl:n" })));
  state.end("w");
  advance(TOMBSTONE_MS + 1);
  assert.ok(state.ingest(ev({ workerId: "w", kind: "prompt" })), "after the tombstone it may walk in again");
  state.end("nobody"); // no worker: just a tombstone
});

test("reconcileLocal leaves held and placeholder workers alone and skips an agent whose cwd it couldn't read", () => {
  const { state, seen, ev, advance } = office();
  for (const id of ["a", "b", "proc:7", "ctl:1"]) state.ingest(ev({ workerId: id, kind: "session_start" }));
  state.ingest(ev({ workerId: "c", agent: "codex", kind: "session_start" }));
  state.hold("b");
  advance(PRESENCE_QUIET_MS + 1);
  state.reconcileLocal([{ agent: "claude", cwd: null }]);
  assert.ok(!seen.some((e) => e.kind === "session_end" && e.agent === "claude"), "a blind round ends no claude session");
  assert.ok(seen.some((e) => e.kind === "session_end" && e.workerId === "c"), "other agents still reconcile");
  state.reconcileLocal([]);
  assert.deepEqual(state.sessions().map((w) => w.workerId).sort(), ["b", "ctl:1", "proc:7"]);
});

test("linker: an exact pinned session id wins; a guess needs agent, host, folder and a fresh start", () => {
  const { state, ev, iso, clock } = office();
  const linker = createLinker(state, HOME);
  const linked = [];
  state.ingest(ev({ workerId: "ctl:a", kind: "session_start" }));
  state.ingest(ev({ workerId: "ctl:b", kind: "session_start" }));
  linker.expect({ placeholder: "ctl:a", agent: "claude", cwd: `${HOME}/Codes/site`, since: clock.t, onLinked: (w) => linked.push(["a", w]) });
  linker.expect({ placeholder: "ctl:b", agent: "claude", cwd: `${HOME}/Codes/site`, sessionId: "pinned", since: clock.t, onLinked: (w) => linked.push(["b", w]) });
  // Exact beats the older guess.
  state.ingest(ev({ workerId: "pinned", kind: "session_start" }));
  assert.deepEqual(linked, [["b", "pinned"]]);
  // Wrong agent, wrong folder, an old transcript: none claim.
  state.ingest(ev({ workerId: "x1", agent: "codex", kind: "session_start" }));
  state.ingest(ev({ workerId: "x2", cwd: `${HOME}/Codes/other`, kind: "session_start" }));
  state.ingest(ev({ workerId: "x3", ts: iso(-60_000), kind: "session_start" }));
  state.ingest(ev({ workerId: "x4", host: { kind: "ssh", id: "ssh:box", name: "box" }, cwd: `${HOME}/Codes/site`, kind: "session_start" }));
  assert.equal(linked.length, 1);
  assert.ok(state.has("ctl:a"));
  // /private folding and "~" on the transcript side.
  state.ingest(ev({ workerId: "g1", cwd: "~/Codes/site", kind: "session_start" }));
  assert.deepEqual(linked.at(-1), ["a", "g1"]);
  assert.ok(!state.has("ctl:a") && state.has("g1"));
  // Linked once: a second transcript in the same folder gets its own desk.
  state.ingest(ev({ workerId: "g2", kind: "session_start" }));
  assert.ok(state.has("g2"));
  assert.equal(linked.length, 2);
});

test("linker: exactOnly re-links a linked worker (Claude's /clear) and every expectation follows the rename", () => {
  const { state, ev, clock } = office();
  const linker = createLinker(state, HOME);
  const seenBy = [];
  state.ingest(ev({ workerId: "ctl:c", kind: "session_start" }));
  state.hold("ctl:c");
  const first = linker.expect({ placeholder: "ctl:c", agent: "claude", sessionId: "s-1", since: clock.t, onLinked: (w) => seenBy.push(["first", w]) });
  state.ingest(ev({ workerId: "s-1", kind: "session_start" }));
  linker.expect({ placeholder: "s-1", agent: "claude", sessionId: "s-2", exactOnly: true, since: clock.t, onLinked: (w) => seenBy.push(["clear", w]) });
  state.ingest(ev({ workerId: "other", kind: "session_start" }));
  assert.ok(state.has("other"), "exactOnly never guesses");
  state.ingest(ev({ workerId: "s-2", kind: "prompt" }));
  assert.deepEqual(seenBy, [["first", "s-1"], ["first", "s-2"], ["clear", "s-2"]]);
  assert.equal(state.isHeld("s-2"), true);
  first.dispose();
  assert.equal(linker.size(), 1);
  linker.dispose();
  state.ingest(ev({ workerId: "late", kind: "session_start" }));
  assert.ok(state.has("late"));
});

test("linker: remote expectations match <hostId>/<sessionId> and remote folders as they are", () => {
  const { state, ev, clock } = office();
  const linker = createLinker(state, HOME);
  const got = [];
  const host = { kind: "daytona", id: "daytona:sb1", name: "sb1" };
  state.ingest(ev({ workerId: "ctl:r", host, cwd: "/home/daytona/app", kind: "session_start" }));
  state.ingest(ev({ workerId: "ctl:q", host, cwd: "/home/daytona/app", kind: "session_start" }));
  linker.expect({ placeholder: "ctl:r", agent: "claude", hostId: "daytona:sb1", sessionId: "S", since: clock.t, onLinked: (w) => got.push(["r", w]) });
  linker.expect({ placeholder: "ctl:q", agent: "claude", hostId: "daytona:sb1", cwd: "/home/daytona/app/", since: clock.t, onLinked: (w) => got.push(["q", w]) });
  state.ingest(ev({ workerId: "daytona:sb1/S", host, cwd: "/home/daytona/app", kind: "session_start" }));
  state.ingest(ev({ workerId: "daytona:sb1/T", host, cwd: "/home/daytona/app", kind: "session_start" }));
  assert.deepEqual(got, [["r", "daytona:sb1/S"], ["q", "daytona:sb1/T"]]);
  // A bare id is never the remote one, and a local transcript never matches a remote expectation.
  state.ingest(ev({ workerId: "ctl:s", host, cwd: "/elsewhere", kind: "session_start" }));
  linker.expect({ placeholder: "ctl:s", agent: "claude", hostId: "daytona:sb1", sessionId: "U", since: clock.t, onLinked: (w) => got.push(["s", w]) });
  state.ingest(ev({ workerId: "U", host, cwd: "/home/daytona/app", kind: "session_start" }));
  state.ingest(ev({ workerId: "local", cwd: "/elsewhere", kind: "session_start" }));
  assert.equal(got.length, 2);
});

test("office port: workersOn, recentFolders newest first with hired folders merged", () => {
  const { state, ev, iso } = office();
  const linker = createLinker(state, HOME);
  const port = createOfficePort(state, linker, { home: HOME, hired: () => [`${HOME}/hired`, `${HOME}/Codes/site`, "relative"] });
  state.ingest(ev({ workerId: "a", cwd: `${HOME}/Codes/old`, ts: iso(-5_000), kind: "session_start" }));
  state.ingest(ev({ workerId: "b", kind: "session_start" }));
  state.ingest(ev({ workerId: "r", host: { kind: "vercel", id: "vercel:x", name: "x" }, cwd: "/vercel/sandbox", kind: "session_start" }));
  assert.deepEqual(port.recentFolders(), [`${HOME}/Codes/site`, `${HOME}/Codes/old`, `${HOME}/hired`]);
  assert.equal(port.workersOn("vercel:x"), 1);
  assert.equal(port.workersOn("vercel:y"), 0);
});

test("ps parsing: pid, ppid, tty, elapsed time; the office itself is skipped", () => {
  assert.equal(parseEtime("05"), null);
  assert.equal(parseEtime("01:05"), 65_000);
  assert.equal(parseEtime("2:01:05"), 7_265_000);
  assert.equal(parseEtime("3-02:01:05"), (3 * 86_400 + 7_265) * 1000);
  const now = 1_000_000_000;
  const out = [
    "  101     1 ttys003    10:00 /Users/t/.local/bin/claude --resume",
    "  102   101 ttys003    09:59 node /opt/x/@openai/codex/bin/codex.js",
    "  103     1 ??          1:00 claude -p hi",
    "  104     1 pts/2   1-00:00:00 gemini",
    "  999     1 ttys001    00:01 claude",
    "  105     1 ttys004    00:03 Claude Helper",
  ].join("\n");
  const { agents, parents } = parsePs(out, now, 999);
  assert.deepEqual(agents.map((a) => [a.pid, a.agent, a.ppid, a.tty, now - a.startedAt]), [
    [101, "claude", 1, "ttys003", 600_000],
    [102, "codex", 101, "ttys003", 599_000],
    [103, "claude", 1, null, 60_000],
    [104, "gemini", 1, "pts/2", 86_400_000],
  ]);
  assert.equal(parents.get(102), 101);
  assert.equal(parents.size, 6);
});

/* ------------------------------------------------------------- presence */

function presenceRig(opts = {}) {
  const o = office();
  const linker = createLinker(o.state, HOME);
  const port = createOfficePort(o.state, linker, { home: HOME });
  let scan = { agents: [], parents: new Map() };
  const owned = [];
  const p = startPresence({
    state: o.state, office: port, scan: async () => scan, ownedPids: () => owned, startedAt: o.clock.t, home: HOME, now: () => o.clock.t, manual: true, ...opts,
  });
  const proc = (pid, over = {}) => ({ pid, ppid: 1, agent: "claude", tty: "ttys001", cwd: `${HOME}/Codes/site`, startedAt: o.clock.t, ...over });
  const set = (agents, parents = new Map()) => {
    for (const a of agents) if (!parents.has(a.pid)) parents.set(a.pid, a.ppid);
    scan = { agents, parents };
  };
  return { ...o, p, set, proc, owned, setNull: () => (scan = null) };
}

test("presence: a terminal agent walks in at launch, links to its transcript, and leaves after two missed scans", async () => {
  const r = presenceRig();
  r.set([r.proc(500)]);
  await r.p.tick();
  assert.deepEqual(r.seen.map((e) => [e.kind, e.workerId]), [["session_start", "proc:500"]]);
  assert.equal(r.state.isHeld("proc:500"), true);
  // Its first prompt: the transcript worker takes the desk.
  r.state.ingest(r.ev({ workerId: "sess-9", kind: "prompt" }));
  assert.equal(r.p.tracked().get(500), "sess-9");
  assert.equal(r.state.isHeld("sess-9"), true);
  r.set([]);
  await r.p.tick();
  assert.ok(r.state.has("sess-9"), "one missed scan isn't a goodbye");
  r.setNull();
  await r.p.tick();
  assert.ok(r.state.has("sess-9"), "a failed scan changes nothing");
  r.set([]);
  await r.p.tick();
  assert.ok(!r.state.has("sess-9"));
  assert.deepEqual(r.seen.slice(-1).map((e) => [e.kind, e.workerId]), [["session_end", "sess-9"]]);
  assert.equal(r.state.ingest(r.ev({ workerId: "sess-9", kind: "reply" })), null, "tombstoned");
  r.p.stop();
});

test("presence: no tty, owned, nested, stale, or already accounted for: no walk-in", async () => {
  const r = presenceRig();
  r.state.ingest(r.ev({ workerId: "existing", cwd: `${HOME}/Codes/old`, kind: "session_start" }));
  r.owned.push(600);
  r.set([
    r.proc(601, { tty: null }),
    r.proc(600),
    r.proc(603, { ppid: 600, agent: "codex" }), // a child of an office-owned agent
    r.proc(604, { ppid: 605, agent: "codex" }), // nested under another agent
    r.proc(605, { cwd: `${HOME}/Codes/old` }), // accounted for by "existing"
    r.proc(606, { startedAt: r.clock.t - 31 * 60_000 }), // long before the office
    r.proc(607, { cwd: null }),
  ]);
  await r.p.tick();
  assert.deepEqual(r.seen.filter((e) => e.workerId.startsWith("proc:")), []);
  // A second process in the accounted-for folder does walk in, and the newest one is picked.
  r.set([r.proc(605, { cwd: `${HOME}/Codes/old`, startedAt: r.clock.t - 1000 }), r.proc(608, { cwd: `${HOME}/Codes/old` })]);
  await r.p.tick();
  assert.deepEqual([...r.p.tracked().keys()], [608]);
  r.p.stop();
});

test("presence: tracked and owned processes don't keep stale unlinked sessions alive", async () => {
  const r = presenceRig();
  r.set([r.proc(700), r.proc(701, { cwd: `${HOME}/Codes/hired` })]);
  r.owned.push(701);
  await r.p.tick();
  assert.deepEqual([...r.p.tracked().keys()], [700]);
  // An old session in the same folder whose agent quit long ago (too old for the linker to claim).
  r.state.ingest(r.ev({ workerId: "stale", ts: r.iso(-120_000), kind: "session_start" }));
  r.state.ingest(r.ev({ workerId: "stale2", cwd: `${HOME}/Codes/hired`, ts: r.iso(-120_000), kind: "session_start" }));
  r.advance(PRESENCE_QUIET_MS + 1);
  await r.p.tick();
  assert.ok(!r.state.has("stale"), "pid 700 counts for proc:700, not for the stale session");
  assert.ok(!r.state.has("stale2"), "an office-owned process never counts for a stray session");
  assert.ok(r.state.has("proc:700"));
  r.p.stop();
});

test("presence: /clear in a terminal agent moves its desk to the new transcript; the old conversation goes home", async () => {
  const r = presenceRig();
  r.set([r.proc(710)]);
  await r.p.tick();
  r.state.ingest(r.ev({ workerId: "sessA", kind: "prompt" }));
  r.advance(3000);
  r.state.ingest(r.ev({ workerId: "sessA", kind: "reply" }));
  r.advance(10_000);
  await r.p.tick();
  r.state.ingest(r.ev({ workerId: "sessB", kind: "prompt" })); // same process, new transcript
  r.advance(2500);
  await r.p.tick();
  assert.equal(r.p.tracked().get(710), "sessB");
  assert.equal(r.state.isHeld("sessB"), true);
  assert.ok(!r.state.has("sessA"), "the cleared conversation left");
  r.advance(30_000);
  await r.p.tick();
  assert.ok(r.state.has("sessB"), "quiet but held: no flapping");
  // An older transcript the tail only now reaches is not mistaken for a /clear.
  r.state.ingest(r.ev({ workerId: "older", ts: r.iso(-90_000), kind: "reply" }));
  r.advance(PRESENCE_QUIET_MS + 1);
  await r.p.tick();
  assert.equal(r.p.tracked().get(710), "sessB");
  assert.ok(!r.state.has("older"));
  r.p.stop();
});

test("presence: the agent's own pid record links exactly and follows /clear; two launches in one repo never swap desks", async () => {
  const sids = new Map([[720, "rec-720"], [721, "rec-721"]]);
  const r = presenceRig({ sessionOf: (agent, pid) => sids.get(pid) });
  r.set([r.proc(720)]);
  await r.p.tick();
  r.advance(60_000);
  r.set([r.proc(720), r.proc(721)]);
  await r.p.tick();
  r.state.ingest(r.ev({ workerId: "rec-721", kind: "prompt" })); // typed into the second terminal first
  r.state.ingest(r.ev({ workerId: "rec-720", kind: "prompt" }));
  assert.deepEqual([...r.p.tracked()], [[720, "rec-720"], [721, "rec-721"]]);
  // /clear in the first: its record names the new session, which takes the desk in place.
  sids.set(720, "rec-720b");
  await r.p.tick();
  r.state.ingest(r.ev({ workerId: "rec-720b", kind: "prompt" }));
  assert.equal(r.p.tracked().get(720), "rec-720b");
  assert.ok(r.seen.some((e) => e.workerId === "rec-720b" && e.replaces === "rec-720"));
  r.p.stop();

  // Without records: a transcript that could be either launch's links to neither.
  const q = presenceRig();
  q.set([q.proc(730)]);
  await q.p.tick();
  q.advance(60_000);
  q.set([q.proc(730), q.proc(731)]);
  await q.p.tick();
  q.state.ingest(q.ev({ workerId: "either", kind: "prompt" }));
  await q.p.tick();
  assert.deepEqual([...q.p.tracked()], []);
  assert.ok(!q.state.has("proc:730") && !q.state.has("proc:731"), "both placeholders gave up");
  assert.ok(q.state.has("either") && !q.state.isHeld("either"));
  await q.p.tick();
  assert.deepEqual([...q.p.tracked()], [], "and they don't walk in again");
  q.p.stop();
});

test("presence: an npm launcher and the native binary it runs count as one process", async () => {
  const r = presenceRig();
  r.set([r.proc(740, { agent: "codex" }), r.proc(741, { agent: "codex", ppid: 740 })]);
  await r.p.tick();
  r.state.ingest(r.ev({ agent: "codex", workerId: "live", kind: "prompt" }));
  r.state.ingest(r.ev({ agent: "codex", workerId: "quit-earlier", ts: r.iso(-60_000), kind: "reply" }));
  r.advance(PRESENCE_QUIET_MS + 1);
  await r.p.tick();
  assert.ok(!r.state.has("quit-earlier"), "the native child doesn't keep a quit session in");
  assert.ok(r.state.has("live"));
  r.p.stop();
});

test("claudeSessionOf reads only Claude's pid record, and not a reused pid's", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { claudeSessionOf } = await load("src/control/presence.ts");
  const dir = mkdtempSync(join(tmpdir(), "ao-claude-"));
  mkdirSync(join(dir, "sessions"));
  writeFileSync(join(dir, "sessions", "42.json"), JSON.stringify({ pid: 42, sessionId: "0a5ad4f6-1111-2222-3333-444455556666", startedAt: 1_000_000 }));
  assert.equal(claudeSessionOf(dir, 42, 1_010_000), "0a5ad4f6-1111-2222-3333-444455556666");
  assert.equal(claudeSessionOf(dir, 42, 9_000_000), undefined, "another process had that pid");
  assert.equal(claudeSessionOf(dir, 43, 1_000_000), undefined);
});
