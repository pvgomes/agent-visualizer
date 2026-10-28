// Tests for src/remote/daytona.ts against a fake Daytona API: credentials from the env and from
// the daytona CLI's profile file (API key, OAuth token + organization, expired token), the
// listing (states filter, pagination, started-only, DAYTONA_TARGET), the toolbox proxy URL, and
// exec through /process/execute, which the fake runs with sh here, stdout and stderr merged
// like the real daemon. Ends with a whole ingest loop over a "sandbox".
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeHome, load, runIn, serve, tmp } from "./remote.fakes.mjs";
import { POSIX } from "./platform.mjs";

const M = await load("src/remote/daytona.ts", "src/ingest/index.ts");

/** A fake API with `boxes`, each {id, name, state, home}. */
async function fakeDaytona(boxes, { pageSize = 100, proxyInList = true, personal } = {}) {
  let srv;
  srv = await serve(async (req, body, url) => {
    if (req.headers.authorization !== "Bearer good-key" && req.headers.authorization !== "Bearer oauth-token") return { status: 401, json: { message: "Unauthorized" } };
    if (req.headers.authorization === "Bearer oauth-token" && req.headers["x-daytona-organization-id"] !== "org-1") return { status: 403, json: { message: "no org" } };
    if (req.method === "GET" && url.pathname === "/api/organizations") {
      if (personal === undefined) return { status: 403, json: { message: "api keys can't list organizations" } };
      return { json: [{ id: "org-1", name: personal ? "Personal" : "Acme", personal }] };
    }
    if (req.method === "GET" && url.pathname === "/api/sandbox") {
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const items = boxes.slice(start, start + pageSize).map((b) => ({
        id: b.id, name: b.name, state: b.state, target: b.target ?? "us", autoStopInterval: b.autoStop ?? 15,
        lastActivityAt: "2026-10-18T00:00:00.000Z", ...(proxyInList ? { toolboxProxyUrl: `${srv.url}/toolbox` } : {}),
      }));
      const next = start + pageSize < boxes.length ? String(start + pageSize) : null;
      return { json: { items, nextCursor: next } };
    }
    const proxyUrl = url.pathname.match(/^\/api\/sandbox\/([^/]+)\/toolbox-proxy-url$/);
    if (proxyUrl) return { json: { url: `${srv.url}/toolbox/` } };
    const exec = url.pathname.match(/^\/toolbox\/([^/]+)\/process\/execute$/);
    if (exec && req.method === "POST") {
      const box = boxes.find((b) => b.id === decodeURIComponent(exec[1]));
      if (!box) return { status: 404, json: { message: "sandbox not found" } };
      // The daemon runs the command line through the sandbox shell and merges stderr into the result.
      const r = await runIn(box.home, "sh", ["-c", body.command]);
      return { json: { exitCode: r.code, result: r.stdout + r.stderr } };
    }
    return { status: 404, json: { message: "no route" } };
  });
  return srv;
}

const env = (srv, extra = {}) => ({ HOME: tmp(), DAYTONA_API_URL: `${srv.url}/api`, ...extra });

test("auto-detection watches a personal organization only; a shared one needs --daytona all", async () => {
  const boxes = [{ id: "aaaa1111-0000-4000-8000-000000000001", name: "colleague-box", state: "started", home: tmp() }];
  const shared = await fakeDaytona(boxes, { personal: false });
  const p = M.createDaytonaProvider({ env: env(shared, { DAYTONA_API_KEY: "good-key", DAYTONA_ORGANIZATION_ID: "org-1" }) });
  await assert.rejects(p.list("auto"), (e) => e.code === "missing" && /shared/.test(e.message));
  assert.equal(shared.requests.filter((r) => r.path === "/api/sandbox").length, 0, "nothing listed, nothing exec'd");
  assert.equal((await p.list("all")).length, 1);
  await shared.close();
  const mine = await fakeDaytona(boxes, { personal: true });
  assert.equal((await M.createDaytonaProvider({ env: env(mine, { DAYTONA_API_KEY: "good-key", DAYTONA_ORGANIZATION_ID: "org-1" }) }).list("auto")).length, 1);
  await mine.close();
});

test("an API key in the env: lists started sandboxes across pages, with the toolbox URL", async () => {
  const boxes = [
    { id: "aaaa1111-0000-4000-8000-000000000001", name: "swarm-01", state: "started", home: tmp() },
    { id: "bbbb2222-0000-4000-8000-000000000002", name: "stopped-one", state: "stopped", home: tmp() },
    { id: "cccc3333-0000-4000-8000-000000000003", name: "eu-box", state: "started", target: "eu", home: tmp(), autoStop: 0 },
  ];
  const srv = await fakeDaytona(boxes, { pageSize: 2 });
  const p = M.createDaytonaProvider({ env: env(srv, { DAYTONA_API_KEY: "good-key" }) });
  assert.deepEqual(p.available(), { ok: true, via: "DAYTONA_API_KEY" });
  const found = await p.list();
  assert.deepEqual(found.map((d) => d.host), [
    { kind: "daytona", id: "daytona:aaaa1111-0000-4000-8000-000000000001", name: "swarm-01" },
    { kind: "daytona", id: "daytona:cccc3333-0000-4000-8000-000000000003", name: "eu-box" },
  ]);
  assert.deepEqual(found.map((d) => d.idleStopMin), [15, 0]);
  assert.equal(found[0].activityAt, Date.parse("2026-10-18T00:00:00.000Z"));
  const lists = srv.requests.filter((r) => r.path === "/api/sandbox");
  assert.equal(lists.length, 2, "followed nextCursor");
  assert.equal(lists[0].query.states, "started");
  // Same target object on the next listing, so a watcher survives rediscovery.
  const again = await p.list();
  assert.equal(again[0].target, found[0].target);
  // DAYTONA_TARGET narrows to one region.
  const eu = await M.createDaytonaProvider({ env: env(srv, { DAYTONA_API_KEY: "good-key", DAYTONA_TARGET: "eu" }) }).list();
  assert.deepEqual(eu.map((d) => d.host.name), ["eu-box"]);
  await srv.close();
});

test("exec runs the script under sh, drops stderr, rejects non-zero exits", { skip: POSIX }, async () => {
  const home = tmp();
  const srv = await fakeDaytona([{ id: "s1", name: "box", state: "started", home }], { proxyInList: false });
  const [d] = await M.createDaytonaProvider({ env: env(srv, { DAYTONA_API_KEY: "good-key" }) }).list();
  const out = await d.target.exec(`echo "it's $HOME"; echo noise >&2; printf '%s\\n' '$(not run)'\nexit 0\n`);
  assert.equal(out, `it's ${home}\n$(not run)\n`);
  assert.ok(srv.requests.some((r) => r.path === "/api/sandbox/s1/toolbox-proxy-url"), "resolved the toolbox URL like the SDK");
  const ex = srv.requests.find((r) => r.path.endsWith("/process/execute"));
  assert.equal(ex.headers.authorization, "Bearer good-key");
  assert.ok(ex.body.timeout >= 1 && ex.body.timeout <= 30);
  await assert.rejects(d.target.exec("exit 7\n"), (e) => e.code === "failed" && /exit 7/.test(e.message));
  await srv.close();
});

test("the daytona CLI's own login: API key profile, or OAuth token plus organization; expired is reported", async () => {
  const srv = await fakeDaytona([{ id: "s1", name: "box", state: "started", home: tmp() }]);
  const home = tmp();
  const cfgDir = join(home, ".config", "daytona");
  mkdirSync(cfgDir, { recursive: true });
  const write = (profile) =>
    writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ activeProfile: "p1", profiles: [{ id: "p0", name: "other", api: { url: "http://nowhere", key: "bad" } }, { id: "p1", name: "me", api: { url: `${srv.url}/api`, ...profile.api }, activeOrganizationId: profile.org }] }));
  const opts = { env: { HOME: home }, platform: "linux" };

  write({ api: { key: "good-key" } });
  assert.equal(M.createDaytonaProvider(opts).available().via, "daytona CLI (api key)");
  assert.equal((await M.createDaytonaProvider(opts).list()).length, 1);

  write({ api: { key: null, token: { accessToken: "oauth-token", refreshToken: "r", expiresAt: new Date(Date.now() + 3_600_000).toISOString() } }, org: "org-1" });
  const p = M.createDaytonaProvider(opts);
  assert.equal(p.available().via, "daytona CLI login");
  assert.equal((await p.list()).length, 1);
  assert.equal(srv.requests.at(-1).headers["x-daytona-organization-id"], "org-1");

  write({ api: { key: null, token: { accessToken: "oauth-token", expiresAt: new Date(Date.now() - 1000).toISOString() } }, org: "org-1" });
  const a = M.createDaytonaProvider(opts).available();
  assert.equal(a.ok, true, "still tried, so the user hears why it failed");
  assert.match(a.why, /login expired/);
  await assert.rejects(M.createDaytonaProvider(opts).list(), (e) => e.code === "auth" && /login expired/.test(e.message));

  assert.equal(M.createDaytonaProvider({ env: { HOME: tmp() }, platform: "linux" }).available().ok, false);
  await srv.close();
});

test("a refused key is an auth error; picking a sandbox by name or id prefix", async () => {
  const srv = await fakeDaytona([
    { id: "abcd1234-0000", name: "swarm-01", state: "started", home: tmp() },
    { id: "abce9999-0000", name: "swarm-02", state: "started", home: tmp() },
  ]);
  await assert.rejects(M.createDaytonaProvider({ env: env(srv, { DAYTONA_API_KEY: "nope" }) }).list(), (e) => e.code === "auth");
  const o = { env: env(srv, { DAYTONA_API_KEY: "good-key" }) };
  assert.equal((await M.createDaytonaTargets("all", o)).length, 2);
  assert.deepEqual((await M.createDaytonaTargets("swarm-02", o)).map((t) => t.host.name), ["swarm-02"]);
  assert.deepEqual((await M.createDaytonaTargets("abcd1", o)).map((t) => t.host.name), ["swarm-01"]);
  assert.equal((await M.createDaytonaTargets("abc", o)).length, 0, "short or ambiguous prefixes match nothing");
  await srv.close();
});

test("a whole ingest loop over a Daytona sandbox", async () => {
  const srv = await fakeDaytona([{ id: "s1", name: "swarm-01", state: "started", home: fakeHome() }]);
  const [d] = await M.createDaytonaProvider({ env: env(srv, { DAYTONA_API_KEY: "good-key" }) }).list();
  const events = [];
  const ing = M.createIngest({ agents: ["claude", "codex"], local: false, remotes: [d.target], onEvent: (e) => events.push(e), watch: false });
  await ing.tick();
  ing.stop();
  assert.ok(events.length >= 3);
  assert.ok(events.every((e) => e.host.kind === "daytona" && e.workerId.startsWith("daytona:s1/")));
  assert.deepEqual([...new Set(events.filter((e) => e.kind === "session_start").map((e) => e.agent))].sort(), ["claude", "codex"]);
  await srv.close();
});
