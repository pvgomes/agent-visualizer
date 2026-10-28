// Tests for src/remote/railway.ts against a fake Railway GraphQL API and a fake `railway` CLI.
// Discovery across every workspace/project/environment in one aliased sandboxes query, project
// tokens, the CLI's stored login (and the CLI itself once that login has expired), and exec
// through sandboxExec with its 16,000-byte cap: big outputs come back paged (gzipped, or raw
// when gzip fails), byte-exact, multi-byte characters included. Ends with an ingest loop.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeHome, load, runIn, serve, tmp, writeBin } from "./remote.fakes.mjs";
import { POSIX } from "./platform.mjs";

const M = await load("src/remote/railway.ts", "src/ingest/index.ts");

const WORLD = {
  workspaces: [
    { id: "w1", name: "Kira", projects: [{ id: "p1", name: "agent-visualizer-test", envs: ["e1"] }] },
    { id: "w2", name: "Team", projects: [{ id: "p2", name: "api", envs: ["e2", "e3"] }] },
  ],
};
const ENV_NAMES = { e1: "production", e2: "production", e3: "staging" };

/** sandboxes: [{id, env, status, idle, home}] */
async function fakeRailway(sandboxes, { cap = 16_000, pathPrefix } = {}) {
  return serve(async (req, body) => {
    const q = body?.query ?? "";
    const v = body?.variables ?? {};
    const bearer = req.headers.authorization === "Bearer rtok";
    const project = req.headers["project-access-token"] === "ptok";
    if (!bearer && !project) return { json: { errors: [{ message: "Not Authorized" }] } };
    if (q.includes("projectToken")) return { json: { data: { projectToken: { projectId: "p2", environmentId: "e3", project: { name: "api" } } } } };
    if (q.includes("me { workspaces")) return { json: { data: { me: { workspaces: WORLD.workspaces.map((w) => ({ id: w.id, name: w.name })) } } } };
    if (q.includes("projects(workspaceId")) {
      const w = WORLD.workspaces.find((x) => x.id === v.w);
      return { json: { data: { projects: { edges: (w?.projects ?? []).map((p) => ({ node: { id: p.id, name: p.name, environments: { edges: p.envs.map((id) => ({ node: { id, name: ENV_NAMES[id] } })) } } })), pageInfo: { hasNextPage: false } } } } };
    }
    if (q.includes("sandboxes(environmentId")) {
      const data = {};
      for (const [k, env] of Object.entries(v)) {
        data[k] = { edges: sandboxes.filter((s) => s.env === env && s.status !== "DESTROYED").map((s) => ({ node: { id: s.id, status: s.status, idleTimeoutMinutes: s.idle } })) };
      }
      return { json: { data } };
    }
    if (q.includes("sandboxExec")) {
      const s = sandboxes.find((x) => x.id === v.id && x.env === v.e);
      if (!s) return { json: { errors: [{ message: "Sandbox not found" }] } };
      const env = pathPrefix ? ["env", `PATH=${pathPrefix}:${process.env.PATH}`] : [];
      const r = await runIn(s.home, env.length ? "env" : "sh", env.length ? [...env.slice(1), "sh", "-c", v.c] : ["-c", v.c]);
      const buf = Buffer.from(r.stdout, "utf8");
      const truncated = buf.length > cap;
      return { json: { data: { sandboxExec: { exitCode: r.code, stdout: buf.subarray(0, cap).toString("utf8"), stderr: "", truncated, timedOut: false } } } };
    }
    return { json: { errors: [{ message: `unknown query ${q.slice(0, 40)}` }] } };
  });
}

const SBX = () => [
  { id: "5c1e0a47-3d2b-4f6e-9a81-7b04c2d9e316", env: "e1", status: "RUNNING", idle: 120, home: tmp() },
  { id: "aaaaaaaa-0000-4000-8000-000000000000", env: "e2", status: "CREATING", idle: 30, home: tmp() },
  { id: "bbbbbbbb-0000-4000-8000-000000000000", env: "e3", status: "RUNNING", idle: 30, home: tmp() },
];

test("RAILWAY_API_TOKEN: every workspace, project and environment; one aliased query for the sandboxes", async () => {
  const srv = await fakeRailway(SBX());
  const p = M.createRailwayProvider({ env: { HOME: tmp(), RAILWAY_API_TOKEN: "rtok", RAILWAY_GRAPHQL_ENDPOINT: srv.url, PATH: "" } });
  assert.deepEqual(p.available(), { ok: true, via: "RAILWAY_API_TOKEN" });
  const found = await p.list();
  assert.deepEqual(found.map((d) => [d.host.id, d.host.name, d.idleStopMin]), [
    ["railway:5c1e0a47-3d2b-4f6e-9a81-7b04c2d9e316", "agent-visualizer-test:5c1e0a", 120],
    ["railway:bbbbbbbb-0000-4000-8000-000000000000", "api:bbbbbb", 30],
  ]);
  const sbxQueries = srv.requests.filter((r) => r.body.query.includes("sandboxes("));
  assert.equal(sbxQueries.length, 1);
  assert.deepEqual(Object.values(sbxQueries[0].body.variables).sort(), ["e1", "e2", "e3"]);
  assert.match(sbxQueries[0].body.query, /active: true/);
  // Environments are cached; the next round is one request.
  const n = srv.requests.length;
  await p.list();
  assert.equal(srv.requests.length - n, 1);
  await srv.close();
});

test("exec: small output in one call, big output paged back byte-exact (gzip, then raw)", { skip: POSIX }, async () => {
  const sbx = SBX();
  const srv = await fakeRailway(sbx);
  const [d] = await M.createRailwayProvider({ env: { HOME: tmp(), RAILWAY_API_TOKEN: "rtok", RAILWAY_GRAPHQL_ENDPOINT: srv.url, PATH: "" } }).list();
  assert.equal(await d.target.exec(`printf '%s\\n' "$HOME"\nexit 0\n`), `${sbx[0].home}\n`);
  assert.equal(srv.requests.filter((r) => r.body.query.includes("sandboxExec")).length, 1);

  // ~100 KB of lines with multi-byte characters: seven raw pages.
  const lines = Array.from({ length: 3000 }, (_, i) => `${i} é日本-${"z".repeat(i % 40)}`);
  writeFileSync(join(sbx[0].home, "big.txt"), lines.join("\n") + "\n");
  const n = srv.requests.length;
  const out = await d.target.exec("cat \"$HOME/big.txt\"\nexit 0\n");
  assert.equal(out, lines.join("\n") + "\n");
  const calls = srv.requests.length - n;
  assert.ok(calls >= 2 && calls <= 4, `${calls} calls with gzip`);
  assert.deepEqual(readdirSync("/tmp").filter((f) => f.startsWith(".agent-visualizer-") && existsSync(join("/tmp", f)) && readFileSync(join("/tmp", f), "utf8").includes("é日本-zz")), [], "temp file removed");
  await srv.close();

  // No working gzip: raw pages, still exact.
  const bin = tmp();
  writeBin(bin, "gzip", "process.exit(1)");
  const srv2 = await fakeRailway(sbx, { pathPrefix: bin });
  const [d2] = await M.createRailwayProvider({ env: { HOME: tmp(), RAILWAY_API_TOKEN: "rtok", RAILWAY_GRAPHQL_ENDPOINT: srv2.url, PATH: "" } }).list();
  const m = srv2.requests.length;
  assert.equal(await d2.target.exec("cat \"$HOME/big.txt\"\nexit 0\n"), lines.join("\n") + "\n");
  assert.ok(srv2.requests.length - m >= calls + 3, `raw pages (${srv2.requests.length - m} calls)`);
  await assert.rejects(d2.target.exec("exit 5\n"), (e) => e.code === "failed" && /exit 5/.test(e.message));
  await srv2.close();
});

test("pagedScript keeps scripts quoted and only pages when needed", async () => {
  const home = tmp();
  const small = await runIn(home, "sh", ["-c", M.pagedScript("printf '%s' \"it's\"\nexit 0\n")]);
  assert.equal(small.stdout, "it's");
  const big = await runIn(home, "sh", ["-c", M.pagedScript("head -c 20000 /dev/zero | tr '\\0' a\nexit 0\n", 1000)]);
  const m = big.stdout.match(/^@@agent-visualizer-paged (\/tmp\/\.agent-visualizer-\S+) (\d+) (gz|raw)\n$/);
  assert.ok(m, big.stdout.slice(0, 80));
  assert.equal(m[3], "gz");
  await runIn(home, "rm", ["-f", m[1]]);
});

test("a project token sees its own environment; a refused token is an auth error", async () => {
  const srv = await fakeRailway(SBX());
  const found = await M.createRailwayProvider({ env: { HOME: tmp(), RAILWAY_TOKEN: "ptok", RAILWAY_GRAPHQL_ENDPOINT: srv.url, PATH: "" } }).list();
  assert.deepEqual(found.map((d) => d.host.name), ["api:bbbbbb"]);
  assert.equal(srv.requests[0].headers["project-access-token"], "ptok");
  await assert.rejects(M.createRailwayProvider({ env: { HOME: tmp(), RAILWAY_API_TOKEN: "nope", RAILWAY_GRAPHQL_ENDPOINT: srv.url, PATH: "" } }).list(), (e) => e.code === "auth");
  await srv.close();
});

const FAKE_CLI = `
const fs = require("fs");
const { spawnSync } = require("child_process");
const a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(a) + "\\n");
const w = JSON.parse(fs.readFileSync(process.env.FAKE_WORLD, "utf8"));
if (a[0] === "list" && a[1] === "--json") {
  process.stdout.write(JSON.stringify(w.projects));
} else if (a[0] === "sandbox" && a[1] === "list") {
  const e = a[a.indexOf("-e") + 1];
  process.stderr.write("Warning: Railway sandboxes are experimental\\n");
  process.stdout.write(JSON.stringify(w.sandboxes.filter((s) => s.environmentId === e), null, 2) + "\\n");
} else if (a[0] === "sandbox" && a[1] === "exec") {
  const id = a[a.indexOf("--id") + 1];
  const s = w.sandboxes.find((x) => x.id === id);
  const cmd = a.slice(a.indexOf("--") + 1);
  const r = spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit", env: { PATH: process.env.PATH, HOME: s.home } });
  process.exit(r.status === null ? 1 : r.status);
} else { process.stderr.write("unknown\\n"); process.exit(2); }
`;

test("the CLI's stored login drives the API; once expired, the railway CLI takes over", { skip: POSIX }, async () => {
  const sbx = SBX();
  const srv = await fakeRailway(sbx);
  const home = tmp();
  mkdirSync(join(home, ".railway"));
  const writeLogin = (expiresInSec) => writeFileSync(join(home, ".railway", "config.json"), JSON.stringify({ projects: {}, user: { id: "u", token: null, accessToken: "rtok", refreshToken: "r", tokenExpiresAt: Math.floor(Date.now() / 1000) + expiresInSec } }));
  writeLogin(3600);
  const dir = tmp();
  const log = join(dir, "argv.log");
  const world = join(dir, "world.json");
  writeFileSync(world, JSON.stringify({
    projects: [{ id: "p1", name: "agent-visualizer-test", environments: { edges: [{ node: { id: "e1", name: "production", canAccess: true } }] } }],
    sandboxes: [{ id: sbx[0].id, status: "RUNNING", environmentId: "e1", idleTimeoutMinutes: 120, home: sbx[0].home }],
  }));
  const bin = writeBin(join(dir, "bin"), "railway", FAKE_CLI);
  const env = { HOME: home, RAILWAY_GRAPHQL_ENDPOINT: srv.url, PATH: process.env.PATH, FAKE_LOG: log, FAKE_WORLD: world };
  const p = M.createRailwayProvider({ env, bin });
  assert.equal(p.available().via, "railway CLI login");
  assert.equal((await p.list()).length, 2, "API, all environments");
  assert.ok(!existsSync(log), "the CLI was not needed");

  writeLogin(-10);
  const p2 = M.createRailwayProvider({ env, bin });
  assert.equal(p2.available().ok, true);
  const found = await p2.list();
  assert.deepEqual(found.map((d) => d.host.name), ["agent-visualizer-test:5c1e0a"]);
  assert.equal(await found[0].target.exec(`printf '%s' "$HOME"\nexit 0\n`), sbx[0].home);
  const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(calls[0], ["list", "--json"]);
  assert.deepEqual(calls[1], ["sandbox", "list", "--json", "-p", "p1", "-e", "e1"]);
  assert.deepEqual(calls[2].slice(0, 9), ["sandbox", "exec", "--id", sbx[0].id, "-p", "p1", "-e", "e1", "--timeout"]);
  assert.deepEqual(calls[2].slice(10, 13), ["--", "sh", "-c"]);

  // Neither a token nor a CLI: an auth error with the fix in it.
  const p3 = M.createRailwayProvider({ env: { HOME: home, PATH: "" } });
  await assert.rejects(p3.list(), (e) => e.code === "auth" && /expired/.test(e.message));
  await srv.close();
});

test("auto scope: the linked project and the sandboxes this user's CLI made; refusals are 'throttled', not offline", async () => {
  const sbx = SBX();
  sbx[2].status = "RUNNING";
  sbx.push({ id: "cccccccc-0000-4000-8000-000000000000", env: "e3", status: "RUNNING", idle: 30, home: tmp() });
  const srv = await fakeRailway(sbx);
  const home = tmp();
  const cwd = join(home, "code", "app");
  mkdirSync(join(home, ".railway"), { recursive: true });
  writeFileSync(join(home, ".railway", "config.json"), JSON.stringify({
    projects: { [join(home, "code")]: { project: "p1", environment: "e1" } },
    sandboxes: { x: { id: "bbbbbbbb-0000-4000-8000-000000000000", environmentId: "e3", projectId: "p2" } },
    user: {},
  }));
  const p = M.createRailwayProvider({ env: { HOME: home, RAILWAY_API_TOKEN: "rtok", RAILWAY_GRAPHQL_ENDPOINT: srv.url, PATH: "" }, cwd });
  // e1 is linked (everything in it); in e3 only the sandbox the CLI made, not a teammate's cccccccc.
  assert.deepEqual((await p.list("auto")).map((d) => d.host.id).sort(), ["railway:5c1e0a47-3d2b-4f6e-9a81-7b04c2d9e316", "railway:bbbbbbbb-0000-4000-8000-000000000000"]);
  assert.equal((await p.list("all")).length, 3);
  const b = new M.RailwayBudget();
  for (let i = 0; i < 450; i++) b.take();
  assert.throws(() => b.take(), (e) => e.code === "throttled");
  await srv.close();
});

test("railway link's folders as the Windows CLI records them: a subfolder is still linked", () => {
  const home = tmp();
  mkdirSync(join(home, ".railway"), { recursive: true });
  writeFileSync(join(home, ".railway", "config.json"), JSON.stringify({
    projects: { "C:\\Users\\me\\code": { project: "p1", environment: "e1" }, "C:\\Users\\me\\code\\api\\": { project: "p2", environment: "e2" }, "/srv/app": { project: "p3", environment: "e3" } },
  }));
  const env = { HOME: home };
  assert.equal(M.linkedTo(env, "C:\\Users\\me\\code\\app")?.environmentId, "e1");
  assert.equal(M.linkedTo(env, "C:\\Users\\me\\code")?.environmentId, "e1");
  assert.equal(M.linkedTo(env, "C:\\Users\\me\\code\\api\\src")?.environmentId, "e2", "the nearest link wins");
  assert.equal(M.linkedTo(env, "C:\\Users\\me\\codex"), undefined);
  assert.equal(M.linkedTo(env, "/srv/app/web")?.environmentId, "e3");
  assert.equal(M.linkedTo(env, "/srv/application"), undefined);
});

test("a whole ingest loop over a Railway sandbox", async () => {
  const sbx = SBX();
  sbx[0].home = fakeHome();
  const srv = await fakeRailway(sbx);
  const targets = await M.createRailwayTargets("5c1e0a47", { env: { HOME: tmp(), RAILWAY_API_TOKEN: "rtok", RAILWAY_GRAPHQL_ENDPOINT: srv.url, PATH: "" } });
  assert.equal(targets.length, 1);
  const events = [];
  const ing = M.createIngest({ agents: ["claude", "codex"], local: false, remotes: targets, onEvent: (e) => events.push(e), watch: false });
  await ing.tick();
  ing.stop();
  assert.ok(events.length >= 3);
  assert.ok(events.every((e) => e.host.kind === "railway" && e.workerId.startsWith(`railway:${sbx[0].id}/`)));
  await srv.close();
});

test("the API budget: under half the hourly quota, sized from RateLimit-Policy, paused by a 429", async () => {
  let clock = 0;
  const b = new M.RailwayBudget(() => clock);
  const res = (status, headers = {}) => ({ status, text: "{}", contentType: "application/json", header: (n) => headers[n] });
  b.observe(res(200, { "ratelimit-policy": '"default";q=1000;w=3600' }));
  const one = b.pollMs(1);
  assert.ok(one >= 8_000 && one <= 12_000, `Hobby: one sandbox every ~10s (${one})`);
  assert.ok(Math.abs(b.pollMs(3) - 3 * one) <= 3);
  for (let i = 0; i < 450; i++) b.take();
  assert.throws(() => b.take(), /stay well inside Railway's API rate limit/);
  clock += 3_600_001;
  b.take();
  b.observe(res(429, { "retry-after": "30" }));
  assert.throws(() => b.take(), /waiting 30s/);
  clock += 31_000;
  b.take();
  b.observe(res(200, { "ratelimit-policy": '"default";q=10000;w=3600' }));
  assert.equal(b.pollMs(1), 2_500, "Pro: the normal remote pace");

  // The provider applies it: slow discovery, a poll interval per sandbox, refusals before the wire.
  const srv = await fakeRailway(SBX());
  const budget = new M.RailwayBudget();
  const p = M.createRailwayProvider({ env: { HOME: tmp(), RAILWAY_API_TOKEN: "rtok", RAILWAY_GRAPHQL_ENDPOINT: srv.url, PATH: "" }, budget });
  assert.equal(p.discoverMs, 120_000);
  const found = await p.list();
  assert.deepEqual(found.map((d) => d.pollMs), [budget.pollMs(2), budget.pollMs(2)], "two running sandboxes share the Hobby budget");
  assert.ok(found[0].pollMs > 15_000);
  assert.ok(budget.used >= 4);
  await srv.close();
});

test("auto scope also covers the office: its project (the last pick) and the sandboxes it recorded; a stale link matches nothing", async () => {
  const sbx = SBX();
  sbx[1].status = "RUNNING";
  sbx.push({ id: "cccccccc-0000-4000-8000-000000000000", env: "e3", status: "RUNNING", idle: 30, home: tmp() });
  const srv = await fakeRailway(sbx);
  const home = tmp();
  const office = join(home, "office");
  mkdirSync(join(home, ".railway"), { recursive: true });
  mkdirSync(office);
  // The office runs from a folder whose link points at a project that was deleted since.
  writeFileSync(join(home, ".railway", "config.json"), JSON.stringify({ projects: { [home]: { project: "p-deleted", environment: "e-deleted" } }, user: {} }));
  writeFileSync(join(office, "control-state.json"), JSON.stringify({ v: 1, recentFolders: [], railway: { projectId: "p1", environmentId: "e1" } }));
  writeFileSync(join(office, "sandboxes.json"), JSON.stringify({ v: 1, sandboxes: [{ provider: "railway", id: "cccccccc-0000-4000-8000-000000000000", name: "agent-visualizer-x", environmentId: "e3", projectId: "p2", createdAt: "2026-10-18T00:00:00Z" }] }));
  const env = { HOME: home, AGENT_VISUALIZER_HOME: office, RAILWAY_API_TOKEN: "rtok", RAILWAY_GRAPHQL_ENDPOINT: srv.url, PATH: "" };
  const p = M.createRailwayProvider({ env, cwd: join(home, "code") });
  // e1 whole (the office's project), in e3 only the office's own cccccccc: not bbbbbbbb, not e2's aaaaaaaa.
  assert.deepEqual((await p.list("auto")).map((d) => d.host.id).sort(), ["railway:5c1e0a47-3d2b-4f6e-9a81-7b04c2d9e316", "railway:cccccccc-0000-4000-8000-000000000000"]);
  // config.json names (no pick yet) are looked up too.
  writeFileSync(join(office, "control-state.json"), JSON.stringify({ v: 1, recentFolders: [] }));
  writeFileSync(join(office, "config.json"), JSON.stringify({ control: { railway: { project: "api", environment: "e2" } } }));
  const p2 = M.createRailwayProvider({ env, cwd: join(home, "code") });
  assert.deepEqual((await p2.list("auto")).map((d) => d.host.id).sort(), ["railway:aaaaaaaa-0000-4000-8000-000000000000", "railway:cccccccc-0000-4000-8000-000000000000"]);
  await srv.close();
});

test("projects(): ids and names from the API, workspaces named when there are several", async () => {
  const srv = await fakeRailway(SBX());
  const p = M.createRailwayProvider({ env: { HOME: tmp(), RAILWAY_API_TOKEN: "rtok", RAILWAY_GRAPHQL_ENDPOINT: srv.url, PATH: "" } });
  assert.deepEqual(await p.projects(), [
    { id: "p1", name: "agent-visualizer-test", workspace: "Kira", environments: [{ id: "e1", name: "production" }] },
    { id: "p2", name: "api", workspace: "Team", environments: [{ id: "e2", name: "production" }, { id: "e3", name: "staging" }] },
  ]);
  const n = srv.requests.length;
  await p.projects();
  assert.equal(srv.requests.length, n, "cached");
  await p.projects({ refresh: true });
  assert.ok(srv.requests.length > n);
  await srv.close();
});

const P = [
  { id: "p1", name: "app", environments: [{ id: "e1", name: "production" }, { id: "e2", name: "staging" }] },
  { id: "p2", name: "web", environments: [{ id: "e3", name: "production" }] },
  { id: "p3", name: "Web", environments: [{ id: "e4", name: "production" }] },
  { id: "p4", name: "empty", environments: [] },
];
const W = (h, ps = P) => M.railwayDest(ps, h);
const ids = (r) => (r.dest ? [r.dest.projectId, r.dest.environmentId, r.dest.why] : r.problem);

test("railwayDest: names or ids in, ids out; the default's order; nothing stale or ambiguous gets through", () => {
  // What the hire asked for, by id or by name (exact name first, then any case).
  assert.deepEqual(ids(W({ asked: { project: "p1", environment: "e2" } })), ["p1", "e2", "picked"]);
  assert.deepEqual(ids(W({ asked: { project: "app", environment: "STAGING" } })), ["p1", "e2", "picked"]);
  assert.deepEqual(ids(W({ asked: { project: "web" } })), ["p2", "e3", "picked"]);
  assert.match(ids(W({ asked: { project: "WEB" } })), /^2 Railway projects are called "WEB": pick one by its id$/);
  assert.match(ids(W({ asked: { project: "agent-visualizer-test" } })), /^No project "agent-visualizer-test" in your Railway account \(it has app, web, Web\)$/);
  assert.match(ids(W({ asked: { project: "empty" } })), /^No project "empty"/, "a project without environments can't take one");
  assert.match(ids(W({ asked: { project: "p1", environment: "qa" } })), /has no environment "qa" \(it has production, staging\)/);
  // The default, in order.
  const all = { remembered: { projectId: "p2", environmentId: "e3" }, config: { project: "app" }, office: [{ projectId: "p3", environmentId: "e4" }], linked: { projectId: "p1", environmentId: "e2" } };
  assert.deepEqual(ids(W(all)), ["p2", "e3", "last used"]);
  assert.deepEqual(ids(W({ ...all, remembered: { projectId: "p-gone", environmentId: "x" } })), ["p1", "e2", "config.json"], "the env the link names in that project");
  assert.deepEqual(ids(W({ ...all, remembered: undefined, config: undefined })), ["p3", "e4", "has the office's sandboxes"]);
  assert.deepEqual(ids(W({ linked: { projectId: "p1", environmentId: "e2" } })), ["p1", "e2", "linked to the office's folder"]);
  assert.deepEqual(ids(W({ linked: { projectId: "p1", environmentId: "e2" } }, [...P, { id: "p9", name: "agent-visualizer", environments: [{ id: "e9", name: "production" }] }])), ["p9", "e9", "named for the office"]);
  assert.deepEqual(ids(W({ linked: { projectId: "p-deleted", environmentId: "e-deleted" } }, [P[1]])), ["p2", "e3", "your only project"]);
  assert.deepEqual(ids(W({}, [P[0]])), ["p1", "e1", "your only project"], "production when nothing names an environment");
  assert.match(ids(W({ linked: { projectId: "p-deleted", environmentId: "e-deleted" } })), /^Pick the Railway project for the new sandbox: your account has 3 \(app, web, Web\)$/);
  assert.match(ids(W({}, [])), /^Your Railway account has no project to put a sandbox in\./);
  assert.match(ids(W({}, [P[3]])), /no project to put a sandbox in/);
  // A config.json entry that matches nothing: noted, and the next default still applies.
  const r = W({ config: { project: "agent-visualizer-test", environment: "production" } }, [P[1]]);
  assert.deepEqual(ids(r), ["p2", "e3", "your only project"]);
  assert.match(r.note, /config\.json's control\.railway doesn't match: No project "agent-visualizer-test"/);
});
