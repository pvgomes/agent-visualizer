// Tests for src/remote/boat.ts against a fake boat API and a fake `boat` CLI (boat isn't installed
// here). The key from BOAT_API_KEY or the CLI's config file, BOAT_ORG, listing live states
// across pages, exec through POST /sandboxes/{id}/commands run with sh here (exit codes,
// truncation, a stopped VM), the CLI path with --json output, and an ingest loop.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeHome, load, runIn, serve, tmp, writeBin } from "./remote.fakes.mjs";
import { POSIX } from "./platform.mjs";

const M = await load("src/remote/boat.ts", "src/ingest/index.ts");

async function fakeBoat(boxes, { pageSize = 200 } = {}) {
  return serve(async (req, body, url) => {
    if (req.headers.authorization !== "Bearer boat_goodkey123") return { status: 401, json: { ok: false, type: "sandbox.error", code: "unauthorized", message: "Missing or invalid API key" } };
    if (req.method === "GET" && url.pathname === "/api/v1/sandboxes") {
      const want = new Set((url.searchParams.get("state") ?? "").split(","));
      const all = boxes.filter((b) => want.has(b.state));
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const page = all.slice(start, start + pageSize);
      const more = start + pageSize < all.length;
      return { json: { ok: true, type: "sandbox.list", sandboxes: page.map(({ id, name, state }) => ({ id, name, state })), pageInfo: { nextCursor: more ? String(start + pageSize) : null, hasMore: more, limit: pageSize } } };
    }
    const cmd = url.pathname.match(/^\/api\/v1\/sandboxes\/([^/]+)\/commands$/);
    if (cmd && req.method === "POST") {
      const b = boxes.find((x) => x.id === cmd[1]);
      if (!b) return { status: 404, json: { ok: false, code: "not_found", message: "no such sandbox" } };
      if (!["ready", "idle", "running"].includes(b.state)) return { status: 409, json: { ok: false, code: "sandbox_not_ready", message: "stopped" } };
      const r = await runIn(b.home, "sh", ["-c", body.command]);
      const cap = b.cap ?? 1 << 20;
      return { json: { ok: true, type: "command.finished", success: r.code === 0, exitCode: r.code, stdout: r.stdout.slice(0, cap), stderr: r.stderr, stdoutTruncated: r.stdout.length > cap, stderrTruncated: false, timedOut: false } };
    }
    return { status: 404, json: { ok: false, code: "not_found", message: "no route" } };
  });
}

test("BOAT_API_KEY: live sandboxes across pages, BOAT_ORG header, default names replaced by ids", async () => {
  const boxes = [
    { id: "bx_23456789", name: "Sandbox 2026-05-31 12:00", state: "idle", home: tmp() },
    { id: "bx_3456789a", name: "train-box", state: "running", home: tmp() },
    { id: "bx_456789ab", name: "parked", state: "archived", home: tmp() },
    { id: "bx_56789abc", name: "fresh", state: "ready", home: tmp() },
  ];
  const srv = await fakeBoat(boxes, { pageSize: 2 });
  const p = M.createBoatProvider({ env: { HOME: tmp(), BOAT_API_KEY: "boat_goodkey123", BOAT_API_BASE: `${srv.url}/api/v1`, BOAT_ORG: "org_9", PATH: "" } });
  assert.deepEqual(p.available(), { ok: true, via: "BOAT_API_KEY" });
  const found = await p.list();
  assert.deepEqual(found.map((d) => d.host), [
    { kind: "boat", id: "boat:bx_23456789", name: "bx_23456789" },
    { kind: "boat", id: "boat:bx_3456789a", name: "train-box" },
    { kind: "boat", id: "boat:bx_56789abc", name: "fresh" },
  ]);
  const lists = srv.requests.filter((r) => r.path === "/api/v1/sandboxes");
  assert.equal(lists.length, 2);
  assert.equal(lists[0].query.state, "ready,idle,running");
  assert.equal(lists[0].headers["x-boat-org"], "org_9");
  assert.equal(p.keepsAwake, false, "commands don't push boat's auto-stop");
  await srv.close();
});

test("exec through the commands API: sh -c, exit codes, truncation and a stopped VM are errors", { skip: POSIX }, async () => {
  const boxes = [{ id: "bx_23456789", name: "vm", state: "running", home: tmp() }];
  const srv = await fakeBoat(boxes);
  const [d] = await M.createBoatProvider({ env: { HOME: tmp(), BOAT_API_KEY: "boat_goodkey123", BOAT_API_BASE: `${srv.url}/api/v1`, PATH: "" } }).list();
  assert.equal(await d.target.exec(`printf '%s|%s' "$HOME" '$(nope)'\nexit 0\n`), `${boxes[0].home}|$(nope)`);
  const call = srv.requests.find((r) => r.path.endsWith("/commands"));
  assert.match(call.body.command, /^sh -c '/);
  assert.ok(call.body.timeoutSeconds >= 1 && call.body.timeoutSeconds <= 600);
  await assert.rejects(d.target.exec("exit 2\n"), (e) => e.code === "failed" && /exit 2/.test(e.message));
  boxes[0].cap = 10;
  await assert.rejects(d.target.exec("echo 0123456789abcdef\nexit 0\n"), (e) => /truncated/.test(e.message));
  boxes[0].state = "archived";
  await assert.rejects(d.target.exec("exit 0\n"), (e) => e.code === "gone");
  await assert.rejects(M.createBoatProvider({ env: { HOME: tmp(), BOAT_API_KEY: "boat_bad000000", BOAT_API_BASE: `${srv.url}/api/v1`, PATH: "" } }).list(), (e) => e.code === "auth");
  await srv.close();
});

test("the key the boat CLI saved in ~/.config/ascii/boat/config.json", async () => {
  const srv = await fakeBoat([{ id: "bx_23456789", name: "vm", state: "running", home: tmp() }]);
  const home = tmp();
  mkdirSync(join(home, ".config", "ascii", "boat"), { recursive: true });
  writeFileSync(join(home, ".config", "ascii", "boat", "config.json"), JSON.stringify({ account: { email: "x" }, auth: { apiKey: "boat_goodkey123" }, apiUrl: `${srv.url}/api/v1` }));
  const p = M.createBoatProvider({ env: { HOME: home, PATH: "" }, platform: "linux" });
  assert.equal(p.available().via, "boat CLI login");
  assert.equal((await p.list()).length, 1);
  assert.equal(M.createBoatProvider({ env: { HOME: tmp(), PATH: "" }, platform: "linux" }).available().ok, false);
  await srv.close();
});

const FAKE_BOAT = `
const fs = require("fs");
const { spawnSync } = require("child_process");
const a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(a) + "\\n");
const w = JSON.parse(fs.readFileSync(process.env.FAKE_WORLD, "utf8"));
if (a[0] === "list") {
  // JSON Lines, with an update notice mixed in.
  process.stdout.write("boat 1.2.3 is available\\n" + w.map((b) => JSON.stringify({ id: b.id, name: b.name, state: b.state })).join("\\n") + "\\n");
} else if (a[0] === "exec") {
  const b = w.find((x) => x.id === a[1]);
  const cmd = a.slice(a.indexOf("--") + 1);
  const r = spawnSync(cmd[0], cmd.slice(1), { env: { PATH: process.env.PATH, HOME: b.home }, encoding: "utf8" });
  process.stdout.write(JSON.stringify({ ok: true, type: "command.finished", exitCode: r.status, stdout: r.stdout, stderr: r.stderr, stdoutTruncated: false }) + "\\n");
  process.exit(r.status === null ? 1 : r.status);
} else process.exit(2);
`;

test("no key but the boat CLI on PATH: boat list --json and boat exec --json", { skip: POSIX }, async () => {
  const dir = tmp();
  const home = fakeHome();
  const world = join(dir, "world.json");
  const log = join(dir, "argv.log");
  writeFileSync(world, JSON.stringify([{ id: "bx_23456789", name: "train-box", state: "running", home }]));
  const bin = writeBin(join(dir, "bin"), "boat", FAKE_BOAT);
  const env = { HOME: tmp(), PATH: join(dir, "bin") + ":" + process.env.PATH, FAKE_WORLD: world, FAKE_LOG: log };
  const p = M.createBoatProvider({ env, platform: "linux" });
  assert.deepEqual(p.available(), { ok: true, via: "boat CLI" });
  const [d] = await p.list();
  assert.equal(d.host.name, "train-box");
  assert.equal(await d.target.exec(`printf '%s' "$HOME"\nexit 0\n`), home);
  const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(calls[0], ["list", "--json"]);
  assert.deepEqual([calls[1][0], calls[1][1], calls[1][2], calls[1][4], calls[1][5]], ["exec", "bx_23456789", "--timeout", "--json", "--"]);
  // The whole loop over the CLI transport.
  const events = [];
  const ing = M.createIngest({ agents: ["claude", "codex"], local: false, remotes: [d.target], onEvent: (e) => events.push(e), watch: false });
  await ing.tick();
  ing.stop();
  assert.ok(events.length >= 3 && events.every((e) => e.host.kind === "boat" && e.workerId.startsWith("boat:bx_23456789/")));
  void bin;
});

test("parseList takes an array, an object, or JSON Lines", () => {
  assert.deepEqual(M.parseList('[{"id":"a"}]').map((x) => x.id), ["a"]);
  assert.deepEqual(M.parseList('{"sandboxes":[{"id":"b"}]}').map((x) => x.id), ["b"]);
  assert.deepEqual(M.parseList('notice\n{"id":"c"}\n{"id":"d"}\n').map((x) => x.id), ["c", "d"]);
  assert.deepEqual(M.parseList(""), []);
});
