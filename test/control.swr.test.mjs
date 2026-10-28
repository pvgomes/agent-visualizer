// Tests for src/control/swr.ts (stale-while-revalidate) and the caches built on it: the hire
// form's "Your setup" inventory (src/control/setup.ts createSetupCache: TTL, invalidation by the
// git index and config mtimes, serve-stale-then-refresh, wait=1), and the platforms' rows
// (src/control/cloud/index.ts: a row past its TTL is answered at once and refreshed behind it).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, load, scratch, sleep, until } from "./control.session-fakes.mjs";

const M = await load("src/control/swr.ts", "src/control/setup.ts", "src/control/cloud/index.ts");
after(cleanup);

/** A compute that counts its calls and answers what `next` says, after `ms`. */
function source(ms = 0) {
  const s = { calls: 0, next: "v1", fail: false };
  s.fn = async () => {
    s.calls++;
    if (ms) await sleep(ms);
    if (s.fail) throw new Error("down");
    return s.next;
  };
  return s;
}

test("swr: the first look waits, then the value is served from the cache until its TTL", async () => {
  let now = 1_000;
  const src = source(20);
  const c = new M.Swr(src.fn, { ttlMs: 100, now: () => now });
  assert.deepEqual(await c.get(), { value: "v1", fresh: true });
  src.next = "v2";
  now += 50;
  assert.deepEqual(await c.get(), { value: "v1", fresh: true }, "within the TTL: no new compute");
  assert.equal(src.calls, 1);
});

test("swr: past the TTL the stale value is answered at once and one refresh runs behind it", async () => {
  let now = 1_000;
  const src = source(40);
  const c = new M.Swr(src.fn, { ttlMs: 100, now: () => now });
  await c.get();
  src.next = "v2";
  now += 150;
  const t0 = performance.now();
  const [a, b] = await Promise.all([c.get(), c.get()]);
  assert.ok(performance.now() - t0 < 30, "answered without waiting for the refresh");
  assert.deepEqual(a, { value: "v1", fresh: false });
  assert.deepEqual(b, { value: "v1", fresh: false });
  await until(() => c.peek() === "v2", 2000, "the refresh");
  assert.equal(src.calls, 2, "two stale looks share one refresh");
  assert.deepEqual(await c.get(), { value: "v2", fresh: true });
});

test("swr: a changed stamp makes the value stale at once; fresh() waits for the new one", async () => {
  let stamp = "a";
  const src = source(10);
  const c = new M.Swr(src.fn, { ttlMs: 60_000, stamp: () => stamp });
  await c.get();
  assert.equal(c.isFresh(), true);
  stamp = "b";
  src.next = "v2";
  assert.equal(c.isFresh(), false);
  assert.equal(await c.fresh(), "v2");
  assert.equal(c.isFresh(), true);
  assert.equal(await c.fresh(), "v2");
  assert.equal(src.calls, 2, "fresh() on a fresh value computes nothing");
});

test("swr: a failed refresh keeps the last good value, and the next look tries again", async () => {
  let now = 0;
  const src = source();
  const c = new M.Swr(src.fn, { ttlMs: 10, now: () => now });
  await c.get();
  now = 100;
  src.fail = true;
  assert.deepEqual(await c.get(), { value: "v1", fresh: false });
  await sleep(10);
  assert.equal(c.peek(), "v1");
  src.fail = false;
  src.next = "v3";
  await c.get();
  await until(() => c.peek() === "v3", 2000, "the retry");
  const cold = new M.Swr(async () => { throw new Error("nothing yet"); }, { ttlMs: 10 });
  await assert.rejects(cold.get(), /nothing yet/, "with no value at all, the error is the answer");
});

test("swr map: one cache per key, the least recently used dropped past max", async () => {
  const made = [];
  const m = new M.SwrMap((k) => (made.push(k), new M.Swr(async () => k, { ttlMs: 1000 })), 2);
  await m.of("a").get();
  await m.of("b").get();
  await m.of("a").get();
  await m.of("c").get();
  assert.equal(m.size, 2);
  m.of("a");
  m.of("b");
  assert.deepEqual(made, ["a", "b", "c", "b"], "b was the oldest and went; a stayed");
});

/* ---- "Your setup" ---- */

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "ignore", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } });

function setupHome() {
  const home = scratch("agent-visualizer-swr-");
  mkdirSync(join(home, ".claude", "skills", "one"), { recursive: true });
  writeFileSync(join(home, ".claude", "CLAUDE.md"), "be brief\n");
  writeFileSync(join(home, ".claude", "skills", "one", "SKILL.md"), "---\nname: one\n---\n");
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { fetch: { command: "npx", args: ["-y", "@modelcontextprotocol/server-fetch"] } } }));
  const project = join(home, "Codes", "app");
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src", "a.ts"), "export {};\n");
  git(project, "init", "-q");
  git(project, "add", "-A");
  git(project, "commit", "-qm", "init");
  return { home, project, src: { home, env: {}, keys: [], shellKeys: [] } };
}

/** The real pieces, counted. */
function countedParts() {
  const n = { project: 0, instructions: 0, mcp: 0 };
  // counted once each piece is done
  const direct = {
    mcp: async (agent, s, folder) => {
      const v = M.mcpOf(agent, s, folder).map(({ config: _c, table: _t, ...m }) => m);
      n.mcp++;
      return v;
    },
    instructions: async (agent, s) => {
      const v = M.instructionsOf(agent, s, { read: false }).items;
      n.instructions++;
      return v;
    },
    project: async (folder, home) => {
      const v = await M.projectInventory(folder, home);
      n.project++;
      return v;
    },
  };
  return { n, direct };
}

test("setup cache: a repeat look is served from the cache, the same as a fresh one", async () => {
  const { project, src } = setupHome();
  const { n, direct } = countedParts();
  const cache = M.createSetupCache({ parts: direct });
  const a = await cache.inventory("claude", src, project);
  const b = await cache.inventory("claude", src, project);
  assert.deepEqual(b, a);
  assert.equal(a.refreshing, undefined);
  assert.deepEqual(n, { project: 1, instructions: 1, mcp: 1 });
  assert.equal(a.project.files, 1);
  assert.deepEqual(a, await M.inventory("claude", src, project), "the cached inventory is the inventory");
});

test("setup cache: a commit (the git index) makes the project stale; it is served once, refreshed behind, and wait=1 waits for it", async () => {
  const { project, src } = setupHome();
  const { n, direct } = countedParts();
  const cache = M.createSetupCache({ parts: direct });
  assert.equal((await cache.inventory("claude", src, project)).project.files, 1);
  writeFileSync(join(project, "src", "b.ts"), "export {};\n");
  git(project, "add", "-A");
  git(project, "commit", "-qm", "two");
  const stale = await cache.inventory("claude", src, project);
  assert.equal(stale.refreshing, true, "says a fresh look is under way");
  assert.equal(stale.project.files, 1, "the last known listing, at once");
  const fresh = await cache.inventory("claude", src, project, { wait: true });
  assert.equal(fresh.refreshing, undefined);
  assert.equal(fresh.project.files, 2);
  assert.equal(n.instructions, 1, "the instructions didn't change: not read again");
  assert.equal((await cache.inventory("claude", src, project)).refreshing, undefined);
});

test("setup cache: a new skill and an edited ~/.claude.json show up on the next fresh look", async () => {
  const { home, project, src } = setupHome();
  const cache = M.createSetupCache();
  const first = await cache.inventory("claude", src, project);
  assert.equal(first.instructions.find((i) => i.id === "skills").count, 1);
  mkdirSync(join(home, ".claude", "skills", "two"));
  writeFileSync(join(home, ".claude", "skills", "two", "SKILL.md"), "---\nname: two\n---\n");
  // a folder's mtime has 1 s resolution on some file systems: make the change visible
  const later = new Date(Date.now() + 5_000);
  utimesSync(join(home, ".claude", "skills"), later, later);
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { fetch: { command: "npx", args: ["-y", "x"] }, web: { type: "http", url: "https://mcp.example.com/" } } }));
  utimesSync(join(home, ".claude.json"), later, later);
  assert.equal((await cache.inventory("claude", src, project)).refreshing, true);
  const fresh = await cache.inventory("claude", src, project, { wait: true });
  assert.equal(fresh.instructions.find((i) => i.id === "skills").count, 2);
  assert.deepEqual(fresh.mcp.map((m) => m.name).sort(), ["fetch", "web"]);
});

test("setup cache: past its TTL with nothing changed, a piece is served stale and refreshed once", async () => {
  const { project, src } = setupHome();
  let now = 1_000_000;
  const { n, direct } = countedParts();
  const cache = M.createSetupCache({ parts: direct, now: () => now, ttl: { project: 1_000, instructions: 1_000, mcp: 1_000 } });
  await cache.inventory("claude", src, project);
  now += 2_000;
  const again = await cache.inventory("claude", src, project);
  assert.equal(again.refreshing, true);
  await until(() => n.project === 2 && n.instructions === 2 && n.mcp === 2, 3000, "the refreshes");
  assert.equal((await cache.inventory("claude", src, project)).refreshing, undefined);
});

test("setup cache: the project's listing no longer holds up the event loop", async () => {
  const { project, src } = setupHome();
  for (let d = 0; d < 20; d++) {
    mkdirSync(join(project, "big", `d${d}`), { recursive: true });
    for (let i = 0; i < 150; i++) writeFileSync(join(project, "big", `d${d}`, `f${i}.txt`), "x\n");
  }
  git(project, "add", "-A");
  git(project, "commit", "-qm", "big");
  let worst = 0;
  let last = performance.now();
  const iv = setInterval(() => {
    const t = performance.now();
    worst = Math.max(worst, t - last);
    last = t;
  }, 2);
  const inv = await M.createSetupCache().inventory("claude", src, project);
  clearInterval(iv);
  assert.equal(inv.project.files, 3001);
  assert.ok(worst < 60, `blocked for ${worst.toFixed(0)} ms`);
});

/* ---- the platforms' rows ---- */

function fakeCloud(kind, o) {
  return {
    kind,
    name: kind,
    login: () => ({ ready: true, via: "test" }),
    async status() {
      o.calls++;
      if (o.ms) await sleep(o.ms);
      return { kind, name: kind, ready: true, via: "test", canCreate: true, sandboxes: o.rows() };
    },
  };
}

function placesWith(o, extra = {}) {
  const home = scratch("agent-visualizer-places-");
  let now = 1_000_000;
  const ctx = {
    home, userHome: home, version: "0", platform: process.platform, now: () => now, log() {},
    agentEnv: () => ({ HOME: home, PATH: "/usr/bin:/bin" }), officeUrl: () => "http://127.0.0.1:1",
    office: { emit() {}, expect: () => ({ dispose() {} }), hold() {}, release() {}, end() {}, workersOn: () => 0, recentFolders: () => [] },
    keys: { list: () => [], platformEnv: () => ({}), onChange: () => ({ dispose() {} }) },
    viewers: () => 0,
    providerEnv: () => ({ HOME: home, PATH: "/usr/bin:/bin" }),
    pty: async () => null,
    watch: () => ({ dispose() {} }),
  };
  const places = M.createPlaces(ctx, { clouds: { daytona: fakeCloud("daytona", o), vercel: fakeCloud("vercel", o), railway: fakeCloud("railway", o) }, bins: { ssh: "/usr/bin/ssh" }, ...extra });
  return { places, tick: (ms) => (now += ms) };
}

test("places: a row past its TTL is answered at once, and the refreshed one arrives through onChange", async () => {
  let n = 1;
  const o = { calls: 0, ms: 300, rows: () => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, name: `s${i}`, provider: "daytona", status: "running", ours: false, workers: 0 })) };
  const { places, tick } = placesWith(o);
  const first = await places.status();
  assert.equal(first.find((p) => p.kind === "daytona").sandboxes.length, 1);
  const changes = [];
  places.onChange((rows) => changes.push(rows));
  n = 2;
  tick(5 * 60_000);
  const t0 = performance.now();
  const stale = await places.status();
  assert.ok(performance.now() - t0 < 100, "no wait for the platforms");
  assert.equal(stale.find((p) => p.kind === "daytona").sandboxes.length, 1, "the last known row");
  await until(() => changes.length, 3000, "onChange");
  assert.equal(changes.at(-1).find((p) => p.kind === "daytona").sandboxes.length, 2);
  places.shutdown();
});

test("places: a platform with no row yet gets the caller's deadline, then its login state", async () => {
  const o = { calls: 0, ms: 600, rows: () => [] };
  const { places } = placesWith(o);
  const t0 = performance.now();
  const rows = await places.status({ deadlineMs: 50 });
  assert.ok(performance.now() - t0 < 400, `answered in ${(performance.now() - t0).toFixed(0)} ms`);
  const d = rows.find((p) => p.kind === "daytona");
  assert.equal(d.ready, true, "the login state");
  assert.equal(d.canCreate, false, "until its real row is in");
  places.shutdown();
});

test("places: while a platform's first look is still out, a second ask doesn't wait the deadline again", async () => {
  const o = { calls: 0, ms: 800, rows: () => [] };
  const { places, tick } = placesWith(o);
  await places.status({ deadlineMs: 150 });
  tick(150); // the office's clock, as the first ask waited
  const t0 = performance.now();
  await places.status({ deadlineMs: 150 });
  assert.ok(performance.now() - t0 < 100, `waited ${(performance.now() - t0).toFixed(0)} ms`);
  assert.equal(o.calls, 3, "one look per platform, not one per ask");
  places.shutdown();
});
