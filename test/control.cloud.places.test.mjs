// Tests for src/control/cloud/index.ts (createPlaces) with stand-in platform drivers, and for
// Remotes.watch in src/remote/index.ts: status answers within its deadline when a platform hangs
// (the last known row or just the login state, the real answer later through onChange), the cache,
// the ssh row (config hosts and config.json remotes), routing errors, the cost guard counting a
// recorded sandbox on a platform that didn't answer, and watch holds that discovery can't drop.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { load, tmp, until } from "./remote.fakes.mjs";
import { fakeContext } from "./control.cloud.fakes.mjs";

const M = await load("src/control/cloud/index.ts", "src/remote/index.ts");

function stub(kind, over = {}) {
  let calls = 0;
  return {
    kind,
    name: kind,
    get calls() {
      return calls;
    },
    login: () => ({ ready: true, via: "test" }),
    async status() {
      calls++;
      return { kind, name: kind, ready: true, via: "test", canCreate: true, sandboxes: [] };
    },
    async create() {
      throw new Error("not in this test");
    },
    async open() {
      throw new Error("not in this test");
    },
    async remove() {},
    ...over,
  };
}

test("a hanging platform doesn't hold status: login state first, the real row later through onChange", async () => {
  const home = tmp();
  let release;
  const slow = stub("vercel", {
    status: () => new Promise((r) => (release = () => r({ kind: "vercel", name: "Vercel Sandbox", ready: true, via: "test", canCreate: true, sandboxes: [{ id: "s1", name: "s1", provider: "vercel", status: "running", ours: true, workers: 2 }] }))),
  });
  const daytona = stub("daytona");
  const p = M.createPlaces(fakeContext({ home, env: { HOME: home, PATH: "/nonexistent" } }), { deadlineMs: 100, clouds: { daytona, vercel: slow, railway: stub("railway") } });
  const changes = [];
  p.onChange((rows) => changes.push(rows));
  const t0 = Date.now();
  const rows = await p.status();
  assert.ok(Date.now() - t0 < 1000, "answered inside the deadline");
  assert.deepEqual(rows.map((r) => r.kind), ["daytona", "vercel", "railway", "ssh"]);
  const v = rows.find((r) => r.kind === "vercel");
  assert.deepEqual([v.ready, v.canCreate, v.sandboxes.length], [true, false, 0], "just the login state");
  const ssh = rows.find((r) => r.kind === "ssh");
  assert.equal(ssh.ready, false, "no ssh on this PATH");
  release();
  await until(() => changes.length, 2000, "onChange with the late row");
  assert.equal(changes.at(-1).find((r) => r.kind === "vercel").sandboxes[0].id, "s1");
  // Cached now: no new call inside the TTL; fresh asks again.
  const before = daytona.calls;
  await p.status();
  assert.equal(daytona.calls, before);
  await p.status({ fresh: true });
  assert.equal(daytona.calls, before + 1);
});

test("the ssh row lists ~/.ssh/config hosts and ssh remotes from config.json", async () => {
  const home = tmp();
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(home, ".ssh/config"), "Host *\n  ForwardAgent no\nHost gpu-box web-1\n");
  mkdirSync(join(home, ".agent-visualizer"), { recursive: true });
  writeFileSync(join(home, ".agent-visualizer/config.json"), JSON.stringify({ remotes: [{ ssh: "me@build" }, { vercel: "all" }] }));
  const p = M.createPlaces(fakeContext({ home: join(home, ".agent-visualizer"), env: { HOME: home, PATH: process.env.PATH } }), { clouds: { daytona: stub("daytona"), vercel: stub("vercel"), railway: stub("railway") } });
  const ssh = (await p.status()).find((r) => r.kind === "ssh");
  assert.equal(ssh.ready, true);
  assert.equal(ssh.canCreate, false);
  assert.deepEqual(ssh.hosts, ["gpu-box", "web-1", "me@build"]);
});

test("routing: local isn't a remote place, unknown kinds and providers are 400s", async () => {
  const home = tmp();
  const p = M.createPlaces(fakeContext({ home, env: { HOME: home } }), { clouds: { daytona: stub("daytona"), vercel: stub("vercel"), railway: stub("railway") } });
  await assert.rejects(p.open({ kind: "local", target: "/x" }, { agent: "claude", progress() {} }), (e) => e.status === 400);
  await assert.rejects(p.open({ kind: "boat", target: "new" }, { agent: "claude", progress() {} }), (e) => e.status === 400);
  await assert.rejects(p.open({ kind: "daytona", target: "" }, { agent: "claude", progress() {} }), (e) => e.status === 400);
  await assert.rejects(p.deleteSandbox("boat", "x"), (e) => e.status === 400);
  p.shutdown();
  await assert.rejects(p.open({ kind: "daytona", target: "new" }, { agent: "claude", progress() {} }), (e) => e.status === 409);
});

test("the cost guard counts recorded sandboxes on a platform that didn't answer", async () => {
  const home = tmp();
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "sandboxes.json"), JSON.stringify({ v: 1, sandboxes: [1, 2, 3].map((i) => ({ provider: "railway", id: `r${i}`, name: `agent-visualizer-r${i}`, createdAt: "2026-10-18T00:00:00.000Z" })) }));
  let created = 0;
  const down = stub("railway", { login: () => ({ ready: false, why: "offline" }), status: async () => { throw new Error("unreachable"); } });
  const p = M.createPlaces(fakeContext({ home, env: { HOME: home } }), {
    clouds: { daytona: stub("daytona", { create: async () => created++ }), vercel: stub("vercel"), railway: down },
  });
  await assert.rejects(p.open({ kind: "daytona", target: "new" }, { agent: "claude", progress() {} }), (e) => e.status === 409 && /agent-visualizer-r1/.test(e.message));
  assert.equal(created, 0);
});

test("Remotes.watch: a held host is watched, discovery can't drop it, and the last release sends its workers home", async () => {
  const events = [];
  const started = [];
  const stopped = [];
  let listed = [];
  const provider = { kind: "daytona", label: "Daytona", keepsAwake: false, available: () => ({ ok: true }), list: async () => listed };
  const r = M.startRemotes({
    agents: ["claude"],
    selectors: [{ kind: "daytona", id: "all" }],
    providers: [provider],
    onEvent: (e) => events.push(e),
    timers: false,
    readyWaitMs: 10,
    watch: (target, agents, onEvent) => {
      started.push(target.host.id);
      setTimeout(() => onEvent({ ts: new Date().toISOString(), agent: "claude", workerId: `w-${target.host.id}`, project: "p", host: target.host, kind: "session_start" }), 5);
      return { stop: () => stopped.push(target.host.id) };
    },
  });
  await r.ready;
  const target = { host: { kind: "daytona", id: "daytona:abc", name: "agent-visualizer-x" }, exec: async () => "" };
  const a = r.watch(target);
  const b = r.watch(target);
  assert.deepEqual(started, ["daytona:abc"], "one watcher for two holds");
  await until(() => events.length, 1000, "an event from the watched host");
  await r.tick(); // discovery doesn't list it: it stays
  assert.deepEqual(stopped, []);
  assert.ok(r.hosts().some((h) => h.host.id === "daytona:abc"));
  a.dispose();
  a.dispose();
  assert.deepEqual(stopped, [], "still held once");
  b.dispose();
  assert.deepEqual(stopped, ["daytona:abc"]);
  assert.equal(events.at(-1).kind, "session_end");
  // A host discovery found on its own stays after a hold on it ends.
  const t2 = { host: { kind: "daytona", id: "daytona:def", name: "other" }, exec: async () => "" };
  listed = [{ host: t2.host, target: t2 }];
  await r.tick();
  const h = r.watch(t2);
  h.dispose();
  assert.ok(r.hosts().some((x) => x.host.id === "daytona:def"));
  listed = [];
  await r.tick();
  assert.ok(!r.hosts().some((x) => x.host.id === "daytona:def"), "discovery still owns it");
  r.stop();
});

test("deleting a sandbox releases its transcript watch at once; closing a place releases it after the linger", async () => {
  const home = tmp();
  const ctx = fakeContext({ home, env: { HOME: home } });
  const place = (id) => {
    const closers = [];
    return {
      host: { kind: "vercel", id: `vercel:${id}`, name: id },
      target: { host: { kind: "vercel", id: `vercel:${id}`, name: id } },
      onClose: (fn) => closers.push(fn),
      close: () => closers.splice(0).forEach((fn) => fn()),
    };
  };
  const vercel = stub("vercel", { open: async (id) => place(id) });
  const p = M.createPlaces(ctx, { unwatchAfterMs: 60_000, clouds: { daytona: stub("daytona"), vercel, railway: stub("railway") } });
  const a = await p.open({ kind: "vercel", target: "sbx-a" }, { agent: "claude", progress() {} });
  await p.open({ kind: "vercel", target: "sbx-b" }, { agent: "claude", progress() {} });
  assert.deepEqual(ctx.watched.map((w) => [w.target.host.id, w.disposed]), [["vercel:sbx-a", false], ["vercel:sbx-b", false]]);
  a.close();
  assert.equal(ctx.watched[0].disposed, false, "a closed place keeps its watch for the linger");
  await p.deleteSandbox("vercel", "sbx-a", true);
  assert.equal(ctx.watched[0].disposed, true, "deleted: released now");
  assert.equal(ctx.watched[1].disposed, false, "another sandbox keeps its watch");
  p.shutdown();
  assert.equal(ctx.watched[1].disposed, true);
});

test("a deleted sandbox the platform still lists for a while is hidden from status", async () => {
  const home = tmp();
  const row = { id: "sb-1", name: "agent-visualizer-1", provider: "daytona", status: "running", ours: true, workers: 0 };
  const daytona = stub("daytona", { status: async () => ({ kind: "daytona", name: "daytona", ready: true, via: "test", canCreate: true, sandboxes: [row, { ...row, id: "sb-2", name: "agent-visualizer-2" }] }) });
  const p = M.createPlaces(fakeContext({ home, env: { HOME: home } }), { clouds: { daytona, vercel: stub("vercel"), railway: stub("railway") } });
  assert.deepEqual((await p.status({ fresh: true }))[0].sandboxes.map((s) => s.id), ["sb-1", "sb-2"]);
  await p.deleteSandbox("daytona", "sb-1", true);
  assert.deepEqual((await p.status({ fresh: true }))[0].sandboxes.map((s) => s.id), ["sb-2"], "gone from the page at once, though the platform still lists it");
  p.shutdown();
});

test("a sandbox created for a hire that never got going is deleted again: stopped mid-create, or a failed install", async () => {
  const home = tmp();
  const removed = [];
  let fail = "cancel";
  const daytona = stub("daytona", {
    async create(c, o) {
      writeFileSync(join(home, "sandboxes.json"), JSON.stringify({ v: 1, sandboxes: [{ provider: "daytona", id: "sb-new", name: c.name, createdAt: new Date().toISOString() }] }));
      c.onCreated("sb-new");
      if (fail === "cancel") {
        ctl.abort(); // Stop pressed while the platform makes it
        throw new Error("Cancelled");
      }
      if (fail === "slow") throw new Error("Daytona sandbox didn't start within 2 minutes");
      return { host: { kind: "daytona", id: "daytona:sb-new", name: c.name }, cwd: "/home/daytona", ours: true, target: {}, onClose() {}, close() {} };
    },
    async remove(id) {
      removed.push(id);
    },
  });
  const ctx = fakeContext({ home, env: { HOME: home } });
  const p = M.createPlaces(ctx, { clouds: { daytona, vercel: stub("vercel"), railway: stub("railway") } });
  let ctl;
  const open = () => p.open({ kind: "daytona", target: "new" }, { agent: "claude", progress() {}, signal: (ctl = new AbortController()).signal });
  await assert.rejects(open(), /Cancelled; the sandbox was deleted/);
  assert.deepEqual(removed, ["sb-new"]);
  fail = "slow";
  await assert.rejects(open(), /didn't start within 2 minutes; the sandbox was deleted/);
  assert.deepEqual(removed, ["sb-new", "sb-new"]);
  fail = "";
  const place = await open();
  assert.equal(typeof place.discard, "function", "a sandbox made for this hire can be discarded");
  assert.equal(await place.discard(), true);
  assert.deepEqual(removed, ["sb-new", "sb-new", "sb-new"]);
  assert.ok(ctx.logs.some((l) => /sandbox sb-new deleted: its agent never started/.test(l.m)), JSON.stringify(ctx.logs));
  p.shutdown();
});

test("a worker the office already sent home is forgotten, not walked back in, when its sandbox goes offline", async () => {
  const events = [];
  const inOffice = new Set();
  const host = { kind: "daytona", id: "daytona:aaa", name: "agent-visualizer-26e9e0" };
  const t = { host, err: null, async exec() { if (t.err) throw t.err; return "ok\n"; } };
  const provider = { kind: "daytona", label: "Daytona", keepsAwake: false, available: () => ({ ok: true }), list: async () => [{ host, target: t }] };
  let w;
  const r = M.startRemotes({
    agents: ["claude"], providers: [provider], timers: false, readyWaitMs: 10, log: () => {},
    inOffice: (id) => inOffice.has(id),
    onEvent: (e) => events.push(e),
    watch: (target, agents, onEvent) => (w = { target, onEvent, stop() {} }),
  });
  await r.ready;
  const ev = (workerId, kind) => ({ ts: new Date().toISOString(), agent: "claude", workerId, project: "p", host, kind });
  w.onEvent(ev("daytona:aaa/u1", "session_start"));
  w.onEvent(ev("daytona:aaa/u2", "prompt"));
  inOffice.add("daytona:aaa/u2"); // u1's hired agent ended: the office sent it home
  t.err = Object.assign(new Error("404 sandbox not found"), { code: "gone" });
  await w.target.exec("poll").catch(() => {});
  await w.target.exec("poll").catch(() => {});
  const offline = events.filter((e) => e.kind === "error");
  assert.deepEqual(offline.map((e) => e.workerId), ["daytona:aaa/u2"], "only the worker still in the office dims");
  r.stop();
});
