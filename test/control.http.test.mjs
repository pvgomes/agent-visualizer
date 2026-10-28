// Tests for the control plane on the office server (src/control/{index,api,auth,fs}.ts mounted by
// src/server/http.ts) with fake sessions and places: the unlock link, every rejection path
// (Host, Origin, Sec-Fetch-Site, the X-Agent-Visualizer header, the cookie, a rotated secret),
// Snapshot.control and control frames per browser, body caps, the hook route, keys never echoed,
// and the folder listing confined to HOME. Everything runs in temp folders with dummy keys.
import nodeTest, { after, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CONTROL, skipAll } from "./platform.mjs";

const test = skipAll(nodeTest, CONTROL);

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TMP = realpathSync(mkdtempSync(join(tmpdir(), "agent-visualizer-ctl-http-")));
const HOME = join(TMP, "home");
const AO = join(TMP, "ao");
const DUMMY = "sk-ant-DUMMY-test-value-0000000000000000-zz";
let M, state, plane, srv, port, sessions;
const logs = [];
const everything = [];
/** cookie -> the page token its /unlock handed over (sent along by call() and stream() unless token: false). */
const tokens = new Map();

async function load(...entries) {
  const outfile = join(TMP, `mod-${entries.length}.mjs`);
  await build({
    stdin: { contents: entries.map((e) => `export * from ${JSON.stringify(`./${e}`)};`).join("\n"), resolveDir: ROOT, loader: "ts" },
    bundle: true, platform: "node", format: "esm", target: "node18", outfile, logLevel: "error",
  });
  return import(pathToFileURL(outfile).href);
}

/** A SessionManager that records what the router hands it. */
function fakeSessions() {
  const calls = [];
  const list = new Map();
  const changed = new Set();
  const gone = new Set();
  const termSinks = new Map();
  const mk = (req, id) => ({
    id, agent: req.agent, place: req.place, mode: req.mode, workerId: `ctl:${id}`, status: "starting", startedAt: new Date().toISOString(),
    title: req.place.target.split("/").pop(), permission: req.permission ?? "default",
  });
  return {
    calls,
    emitChange(s) {
      for (const fn of changed) fn(s);
    },
    emitGone(id) {
      for (const fn of gone) fn(id);
    },
    termSinks,
    async availability() {
      return [{ agent: "claude", installed: true, modes: ["terminal", "chat"], keyNames: ["ANTHROPIC_API_KEY"] }];
    },
    async hire(req) {
      calls.push(["hire", req]);
      const s = mk(req, `s${list.size + 1}`);
      list.set(s.id, s);
      return s;
    },
    list: () => [...list.values()],
    get: (id) => list.get(id),
    input: (id, data) => calls.push(["input", id, data]),
    resize: (id, c, r) => calls.push(["resize", id, c, r]),
    async prompt(id, text) {
      calls.push(["prompt", id, text]);
    },
    async interrupt(id) {
      calls.push(["interrupt", id]);
    },
    async stop(id) {
      calls.push(["stop", id]);
    },
    async answer(id, a) {
      calls.push(["answer", id, a]);
    },
    attachTerm(id, sink) {
      const s = list.get(id);
      if (!s || s.mode !== "terminal") throw new M.ControlError(404, "Not a terminal session.");
      sink.data(new TextEncoder().encode("hello\r\n"));
      termSinks.set(id, sink);
      return { dispose: () => termSinks.delete(id) };
    },
    attachChat(id, sink) {
      sink.item({ id: "u1", kind: "user", text: "hi", at: new Date().toISOString() });
      return { dispose() {} };
    },
    async hook(call) {
      calls.push(["hook", call.sessionId, call.event, call.token, call.body, !!call.signal]);
      return call.token === "tok" ? { status: 200, body: { ok: 1 } } : { status: 401, body: {} };
    },
    ownedPids: () => [4242],
    onChange(fn) {
      changed.add(fn);
      return { dispose: () => changed.delete(fn) };
    },
    onGone(fn) {
      gone.add(fn);
      return { dispose: () => gone.delete(fn) };
    },
    async shutdown() {
      calls.push(["shutdown"]);
    },
  };
}

const fakePlaces = {
  deleted: [],
  async status() {
    return [{ kind: "daytona", name: "Daytona", ready: true, canCreate: true, sandboxes: [] }];
  },
  async open() {
    throw new Error("not in this test");
  },
  async deleteSandbox(provider, id, force) {
    this.deleted.push([provider, id, force]);
  },
  onChange: () => ({ dispose() {} }),
  shutdown() {},
};

before(async () => {
  mkdirSync(join(HOME, "Codes", "site", ".git"), { recursive: true });
  mkdirSync(join(HOME, "Codes", "beta"), { recursive: true });
  mkdirSync(join(HOME, ".hidden"), { recursive: true });
  mkdirSync(join(TMP, "outside", "secret"), { recursive: true });
  writeFileSync(join(HOME, "Codes", "notes.txt"), "not a folder");
  symlinkSync(join(TMP, "outside"), join(HOME, "Codes", "escape"));
  symlinkSync(join(HOME, "Codes", "beta"), join(HOME, "Codes", "alias"));
  M = await load("src/server/state.ts", "src/server/http.ts", "src/control/index.ts", "src/control/types.ts", "src/control/keys.ts");
  state = new M.OfficeState({ home: HOME });
  sessions = fakeSessions();
  const webRoot = join(TMP, "web");
  mkdirSync(join(webRoot, "assets"), { recursive: true });
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
  let url = "";
  plane = M.createControlPlane({
    state, enabled: true, version: "0.0.0-test", host: "127.0.0.1", officeUrl: () => url, home: AO, userHome: HOME,
    log: (m) => logs.push(m),
    sessions: () => sessions,
    places: () => fakePlaces,
    pingMs: 50,
    shellNames: async () => ["ANTHROPIC_API_KEY"],
  });
  srv = await M.startServer({ state, port: 0, webRoot, control: plane, pingMs: 50 });
  port = srv.port;
  url = srv.url;
});

after(async () => {
  await plane.shutdown();
  await srv.close();
  rmSync(TMP, { recursive: true, force: true });
});

function call(method, path, o = {}) {
  return new Promise((done, fail) => {
    const headers = { host: `127.0.0.1:${port}`, ...(o.headers ?? {}) };
    if (o.cookie) headers.cookie = o.cookie;
    if (o.ctl !== false && path.startsWith("/api/control")) headers["x-agent-visualizer"] ??= "1";
    if (o.token !== false && tokens.has(o.cookie)) headers["x-agent-visualizer-token"] ??= tokens.get(o.cookie);
    let body = o.body;
    if (body !== undefined && typeof body !== "string" && !Buffer.isBuffer(body)) {
      body = JSON.stringify(body);
      headers["content-type"] ??= "application/json";
    }
    for (const [k, v] of Object.entries(headers)) if (v === null) delete headers[k];
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        everything.push(text, JSON.stringify(res.headers));
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          // not JSON
        }
        done({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", fail);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Open an SSE stream, collect frames for `ms`, then close. */
function stream(path, o = {}, ms = 150) {
  return new Promise((done, fail) => {
    const headers = { host: `127.0.0.1:${port}`, ...(o.headers ?? {}) };
    if (o.cookie) headers.cookie = o.cookie;
    if (path.startsWith("/api/control")) headers["x-agent-visualizer"] = "1";
    if (o.token !== false && tokens.has(o.cookie)) {
      if (path === "/events") path += `?k=${tokens.get(o.cookie)}`;
      else headers["x-agent-visualizer-token"] = tokens.get(o.cookie);
    }
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      o.onOpen?.();
      setTimeout(() => {
        req.destroy();
        everything.push(text);
        done({ status: res.statusCode, text });
      }, ms);
    });
    req.on("error", (e) => (e.code === "ECONNRESET" ? null : fail(e)));
    req.end();
  });
}

async function unlock() {
  const code = plane.auth.mintCode();
  const r = await call("GET", `/unlock?t=${code}`, { headers: { "sec-fetch-site": "none" } });
  assert.equal(r.status, 303);
  const handoff = /^\/#unlock=([0-9a-f]{32})$/.exec(r.headers.location)?.[1];
  assert.ok(handoff, r.headers.location);
  const c = r.headers["set-cookie"][0];
  assert.match(c, /^ao_key=v1\.\d+\.[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000$/);
  const cookie = c.split(";")[0];
  // The page trades the #fragment for its token, once.
  const t = await call("POST", "/api/control/token", { cookie, body: { handoff }, headers: { "sec-fetch-site": "same-origin" } });
  assert.equal(t.status, 200);
  assert.match(t.json.token, /^[0-9a-f]{64}$/);
  tokens.set(cookie, t.json.token);
  return { cookie, code, token: t.json.token, handoff };
}

test("control.json is created 0600 in a 0700 folder", () => {
  assert.equal(statSync(join(AO, "control.json")).mode & 0o777, 0o600);
  assert.equal(statSync(AO).mode & 0o777, 0o700);
});

test("unlock: a code works once, sets the cookie and leaves the address bar; reused, forged or cross-site never", async () => {
  const { cookie, code } = await unlock();
  assert.ok(cookie);
  const again = await call("GET", `/unlock?t=${code}`);
  assert.equal(again.status, 403);
  assert.equal(again.headers["set-cookie"], undefined);
  assert.match(again.text, /expired or was already used/);
  for (const t of ["", "abc", `${code.slice(0, -1)}0`, "zzzzzz.00000000000000000000000000000000", "x".repeat(200)]) {
    const r = await call("GET", `/unlock?t=${encodeURIComponent(t)}`);
    assert.equal(r.status, 403, t);
  }
  const fresh = plane.auth.mintCode();
  for (const headers of [{ "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }, { origin: "http://evil.test" }, { host: "evil.test" }]) {
    const r = await call("GET", `/unlock?t=${fresh}`, { headers });
    assert.equal(r.status, 403, JSON.stringify(headers));
    assert.equal(r.headers["set-cookie"], undefined);
  }
  assert.equal((await call("POST", `/unlock?t=${fresh}`)).status, 405);
  // A rejected attempt didn't burn it.
  assert.equal((await call("GET", `/unlock?t=${fresh}`)).status, 303);
});

test("the cookie alone never unlocks: the page token is required, and a handoff works once", async () => {
  const { cookie, token, handoff } = await unlock();
  assert.equal((await call("GET", "/api/control", { cookie, token: false })).status, 401, "a cookie replayed from another port");
  assert.equal((await call("GET", "/api/control", { headers: { "x-agent-visualizer-token": token } })).status, 401, "a token without the cookie");
  assert.equal((await call("GET", "/api/control", { cookie, headers: { "x-agent-visualizer-token": "0".repeat(64) } })).status, 401);
  assert.equal((await call("GET", "/api/control", { cookie })).status, 200);
  const again = await call("POST", "/api/control/token", { cookie, token: false, body: { handoff } });
  assert.equal(again.status, 403, "the handoff is single use");
  assert.equal((await call("POST", "/api/control/token", { body: { handoff: plane.auth.mintHandoff() } })).status, 401, "the exchange needs the cookie");
  assert.equal((await call("GET", "/api/snapshot", { cookie, token: false })).json.control, "locked");
  assert.equal((await call("GET", `/api/snapshot?k=${token}`, { cookie, token: false })).json.control, "enabled");
  const bare = await stream("/events", { cookie, token: false, onOpen: () => setTimeout(() => sessions.emitChange({ id: "s8", agent: "claude", workerId: "ctl:s8", status: "running" }), 40) });
  assert.doesNotMatch(bare.text, /event: control/, "no control frames for a bare cookie");
  assert.ok(!everything.some((t) => t.includes(token) && !t.includes('"token"')), "the token only ever appears in the exchange's answer");
});

test("every /api/control request needs the Host, the origin, the header and the cookie", async () => {
  const { cookie } = await unlock();
  assert.equal((await call("GET", "/api/control", { cookie })).status, 200);
  const cases = [
    [{ ctl: false, cookie }, 403, /X-Agent-Visualizer/],
    [{ cookie, headers: { "x-agent-visualizer": "yes" } }, 403, /X-Agent-Visualizer/],
    [{}, 401, /locked/],
    [{ cookie: "ao_key=v1.1.deadbeef" }, 401, /locked/],
    [{ cookie, headers: { origin: "http://evil.test" } }, 403, /Cross-site/],
    [{ cookie, headers: { origin: `http://localhost:${port}` } }, 403, /Cross-site/],
    [{ cookie, headers: { "sec-fetch-site": "cross-site" } }, 403, /Cross-site/],
    [{ cookie, headers: { "sec-fetch-site": "same-site" } }, 403, /Cross-site/],
    [{ cookie, headers: { host: "attacker.test" } }, 403, /localhost/],
  ];
  for (const [o, status, re] of cases) {
    const r = await call("GET", "/api/control", o);
    assert.equal(r.status, status, JSON.stringify(o));
    if (r.json) assert.match(r.json.error, re);
  }
  const ok = await call("GET", "/api/control", { cookie, headers: { origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers["cache-control"], "no-store");
  assert.match(ok.headers["content-security-policy"], /default-src 'self'/);
  // A POST from a cross-site form (no custom header) can't hire.
  const form = await call("POST", "/api/control/hire", { ctl: false, cookie, headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://evil.test" }, body: "agent=claude" });
  assert.equal(form.status, 403);
  assert.equal(sessions.calls.filter((c) => c[0] === "hire").length, 0);
});

test("GET /api/control: the whole ControlInfo for an unlocked browser", async () => {
  const { cookie } = await unlock();
  const r = await call("GET", "/api/control", { cookie });
  assert.equal(r.json.enabled, true);
  assert.equal(r.json.agents[0].agent, "claude");
  assert.equal(r.json.providers[0].kind, "daytona");
  assert.deepEqual(r.json.keys, []);
  assert.equal(r.json.service.supported, false);
  assert.ok(Array.isArray(r.json.sessions));
  assert.ok(Array.isArray(r.json.recentFolders));
  assert.equal(r.headers["set-cookie"], undefined, "a fresh cookie isn't re-issued");
});

test("rotating the secret logs every browser out and kills outstanding codes", async () => {
  const { cookie } = await unlock();
  const code = plane.auth.mintCode();
  plane.auth.rotate();
  assert.equal((await call("GET", "/api/control", { cookie })).status, 401);
  assert.equal((await call("GET", `/unlock?t=${code}`)).status, 403);
  await unlock();
});

test("Snapshot.control and control frames are per browser", async () => {
  const { cookie } = await unlock();
  assert.equal((await call("GET", "/api/snapshot")).json.control, "locked");
  assert.equal((await call("GET", "/api/snapshot", { cookie })).json.control, "enabled");
  const s = { id: "s9", agent: "claude", workerId: "ctl:s9", status: "running" };
  const fire = () => setTimeout(() => {
    sessions.emitChange(s);
    sessions.emitGone("s9");
    plane.keys.put({ name: "OPENAI_API_KEY", value: "sk-proj-DUMMY-000000000000000000000000" });
  }, 40);
  const [locked, open] = await Promise.all([stream("/events", { onOpen: fire }), stream("/events", { cookie })]);
  assert.match(locked.text, /event: snapshot/);
  assert.doesNotMatch(locked.text, /event: control/);
  assert.match(locked.text, /"control":"locked"/);
  assert.match(open.text, /"control":"enabled"/);
  assert.match(open.text, /event: control\ndata: \{"id":"s9"/);
  assert.match(open.text, /event: control_gone\ndata: \{"id":"s9"\}/);
  assert.match(open.text, /event: control_info\ndata: \{"keys":\[\{"name":"OPENAI_API_KEY"/);
  assert.doesNotMatch(open.text, /DUMMY-0000/);
  // A cookie on a cross-site EventSource gets no frames.
  const xs = await stream("/events", { cookie, headers: { origin: "http://evil.test" } });
  assert.doesNotMatch(xs.text, /control/);
  plane.keys.remove("OPENAI_API_KEY");
});

test("viewers counts unlocked /events clients only", async () => {
  const { cookie } = await unlock();
  let mid = -1;
  await Promise.all([
    stream("/events", { cookie, onOpen: () => setTimeout(() => (mid = plane.context.viewers()), 40) }),
    stream("/events"),
  ]);
  assert.equal(mid, 1);
});

test("bodies: JSON only, capped, and validated before anything is hired", async () => {
  const { cookie } = await unlock();
  const t = await call("POST", "/api/control/keys", { cookie, headers: { "content-type": "text/plain" }, body: '{"name":"A_B","value":"x"}' });
  assert.equal(t.status, 415);
  const big = await call("POST", "/api/control/keys", { cookie, body: { name: "BIG_KEY", value: "x".repeat(70 << 10) } });
  assert.equal(big.status, 413);
  const huge = await call("POST", "/api/control/hire", { cookie, body: { agent: "claude", place: { kind: "local", target: "~" }, mode: "terminal", prompt: "p".repeat(1.1 * (1 << 20)) } });
  assert.equal(huge.status, 413);
  assert.equal((await call("POST", "/api/control/hire", { cookie, body: "{nope" , headers: { "content-type": "application/json" } })).status, 400);
  for (const body of [
    { agent: "nobody", place: { kind: "local", target: "~" } },
    { agent: "claude", place: { kind: "mars", target: "x" } },
    { agent: "claude", place: { kind: "local", target: "~" }, mode: "gui" },
    { agent: "claude", place: { kind: "local", target: "~" }, permission: "root" },
    { agent: "claude", place: { kind: "local", target: "~" }, keys: ["ANTHROPIC_API_KEY"] },
    { agent: "claude", place: { kind: "daytona", target: "new" }, keys: ["lower"] },
    { agent: "claude", place: { kind: "daytona", target: "new" }, sandbox: { name: "a b" } },
    { agent: "claude", place: { kind: "railway", target: "new" }, sandbox: { environment: "production" } },
    { agent: "claude", place: { kind: "railway", target: "new" }, sandbox: { project: "a\nb" } },
    { agent: "claude", place: { kind: "railway", target: "new" }, sandbox: { project: "p".repeat(129) } },
  ]) {
    const r = await call("POST", "/api/control/hire", { cookie, body });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  const outside = await call("POST", "/api/control/hire", { cookie, body: { agent: "claude", place: { kind: "local", target: "/etc" } } });
  assert.equal(outside.status, 403);
  const escape = await call("POST", "/api/control/hire", { cookie, body: { agent: "claude", place: { kind: "local", target: "~/Codes/escape/secret" } } });
  assert.equal(escape.status, 403);
  assert.equal(sessions.calls.filter((c) => c[0] === "hire").length, 0);
  assert.equal((await call("GET", "/api/control/hire", { cookie })).status, 405);
  assert.equal((await call("GET", "/api/control/nope", { cookie })).status, 404);
});

test("hire and drive: the router hands requests to the sessions part, local folders resolved under HOME", async () => {
  const { cookie } = await unlock();
  const r = await call("POST", "/api/control/hire", { cookie, body: { agent: "claude", place: { kind: "local", target: "~/Codes/site" }, mode: "terminal", prompt: "fix it", permission: "plan" } });
  assert.equal(r.status, 200);
  const hire = sessions.calls.find((c) => c[0] === "hire")[1];
  assert.equal(hire.place.target, join(HOME, "Codes", "site"));
  assert.equal(hire.prompt, "fix it");
  assert.equal(hire.permission, "plan");
  const id = r.json.id;
  assert.ok(!logs.some((l) => l.includes("fix it")), "prompts never reach the log");
  // Railway: where the new sandbox goes travels as given (ids, or names the places part looks up).
  const rw = await call("POST", "/api/control/hire", { cookie, body: { agent: "claude", place: { kind: "railway", target: "new" }, mode: "chat", sandbox: { timeoutMin: 15, project: " agent-visualizer-test ", environment: "production" } } });
  assert.equal(rw.status, 200);
  assert.deepEqual(sessions.calls.filter((c) => c[0] === "hire").at(-1)[1].sandbox, { timeoutMin: 15, project: "agent-visualizer-test", environment: "production" });
  for (const [what, body, want] of [
    ["input", { data: "\x1b[A" }, ["input", id, "\x1b[A"]],
    ["resize", { cols: 9999, rows: 1 }, ["resize", id, 500, 4]],
    ["prompt", { text: "and test" }, ["prompt", id, "and test"]],
    ["interrupt", undefined, ["interrupt", id]],
    ["approval", { id: "ap1", decision: "allow", always: true }, ["answer", id, { id: "ap1", decision: "allow", always: true }]],
    ["stop", undefined, ["stop", id]],
  ]) {
    const res = await call("POST", `/api/control/sessions/${id}/${what}`, { cookie, body });
    assert.equal(res.status, 204, what);
    assert.deepEqual(sessions.calls.at(-1), want);
  }
  assert.equal((await call("POST", `/api/control/sessions/${id}/approval`, { cookie, body: { id: "x", decision: "maybe" } })).status, 400);
  assert.equal((await call("POST", `/api/control/sessions/${id}/prompt`, { cookie, body: { text: "  " } })).status, 400);
  assert.equal((await call("POST", "/api/control/sessions/nope/stop", { cookie })).status, 404);
  const term = await stream(`/api/control/sessions/${id}/term`, { cookie });
  assert.equal(term.status, 200);
  assert.match(term.text, new RegExp(`event: data\\ndata: \\{"d":"${Buffer.from("hello\r\n").toString("base64")}"\\}`));
  assert.equal((await call("GET", `/api/control/sessions/${id}/chat`, { cookie })).status, 404);
  const noHeader = await call("GET", `/api/control/sessions/${id}/term`, { cookie, ctl: false });
  assert.equal(noHeader.status, 403);
  const recent = (await call("GET", "/api/control", { cookie })).json.recentFolders;
  assert.ok(recent.includes(join(HOME, "Codes", "site")));
  assert.equal(statSync(join(AO, "control-state.json")).mode & 0o777, 0o600);
});

test("the hook route: agents only (no browser headers), POST only, token passed through", async () => {
  const ok = await call("POST", "/api/hook/s1/permission", { headers: { authorization: "Bearer tok" }, body: { tool_name: "Bash" } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { ok: 1 });
  assert.deepEqual(sessions.calls.at(-1), ["hook", "s1", "permission", "tok", { tool_name: "Bash" }, true]);
  const n = sessions.calls.length;
  for (const headers of [{ origin: "http://evil.test" }, { origin: `http://127.0.0.1:${port}` }, { "sec-fetch-mode": "cors" }, { "sec-fetch-site": "same-origin" }]) {
    const r = await call("POST", "/api/hook/s1/permission", { headers: { authorization: "Bearer tok", ...headers }, body: {} });
    assert.equal(r.status, 403, JSON.stringify(headers));
  }
  assert.equal((await call("GET", "/api/hook/s1/permission")).status, 405);
  assert.equal((await call("POST", "/api/hook/s1/permission", { headers: { host: "evil.test" }, body: {} })).status, 403);
  assert.equal((await call("POST", "/api/hook/s1/permission", { body: { big: "x".repeat(1.1 * (1 << 20)) } })).status, 413);
  assert.equal(sessions.calls.length, n);
  assert.equal((await call("POST", "/api/hook/s1/permission", { body: {} })).status, 401, "no token: the sessions part says no");
});

test("keys: stored 0600, only previews come back, values never in a response or the log", async () => {
  const { cookie } = await unlock();
  const r = await call("POST", "/api/control/keys", { cookie, body: { name: "ANTHROPIC_API_KEY", value: `  ${DUMMY}\n` } });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json).sort(), ["addedAt", "agents", "name", "preview"]);
  assert.equal(r.json.preview, `${DUMMY.slice(0, 6)}…${DUMMY.slice(-4)}`);
  assert.deepEqual(r.json.agents, ["claude", "opencode"]);
  assert.equal(statSync(join(AO, "keys.json")).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(join(AO, "keys.json"), "utf8")).keys[0].value, DUMMY, "trimmed");
  const info = await call("GET", "/api/control", { cookie });
  assert.equal(info.json.keys[0].name, "ANTHROPIC_API_KEY");
  assert.equal((await call("POST", "/api/control/keys", { cookie, body: { name: "bad name", value: "x" } })).status, 400);
  assert.equal((await call("POST", "/api/control/keys", { cookie, body: { name: "MULTI_LINE", value: "a\nb" } })).status, 400);
  assert.equal((await call("POST", "/api/control/keys", { cookie, body: { name: "WITH_AGENT", value: "v".repeat(30), agents: ["skynet"] } })).status, 400);
  assert.equal((await call("DELETE", "/api/control/keys/NOPE_KEY", { cookie })).status, 404);
  assert.equal((await call("DELETE", "/api/control/keys/ANTHROPIC_API_KEY", { cookie })).status, 204);
  assert.deepEqual((await call("GET", "/api/control", { cookie })).json.keys, []);
  const all = everything.join("\n") + logs.join("\n");
  assert.ok(!all.includes(DUMMY), "the value never left the key store");
  assert.ok(!all.includes(DUMMY.slice(8, 30)));
});

test("folders: under HOME only, folders only, no dot-folders, symlinks out are neither listed nor reachable", async () => {
  const { cookie } = await unlock();
  const home = await call("GET", "/api/control/fs", { cookie });
  assert.equal(home.json.path, "~");
  assert.equal(home.json.parent, undefined);
  assert.deepEqual(home.json.dirs.map((d) => d.name), ["Codes"]);
  const codes = await call("GET", `/api/control/fs?path=${encodeURIComponent("~/Codes")}`, { cookie });
  assert.equal(codes.json.path, "~/Codes");
  assert.equal(codes.json.parent, HOME);
  assert.deepEqual(codes.json.dirs.map((d) => [d.name, d.git, d.path]), [
    ["alias", false, join(HOME, "Codes", "alias")],
    ["beta", false, join(HOME, "Codes", "beta")],
    ["site", true, join(HOME, "Codes", "site")],
  ]);
  for (const p of ["/etc", join(TMP, "outside"), "~/Codes/escape", "~/Codes/escape/secret", "~/../", `${HOME}/../outside`, "relative/path", "~/Codes/notes.txt", "~/missing"]) {
    const r = await call("GET", `/api/control/fs?path=${encodeURIComponent(p)}`, { cookie });
    assert.ok([400, 403, 404].includes(r.status), `${p}: ${r.status}`);
    assert.ok(!r.text.includes("secret"), p);
  }
  assert.equal((await call("GET", `/api/control/fs?path=${encodeURIComponent(join(TMP, "outside"))}`, { cookie })).status, 403);
});

test("sandboxes and the rest of the routes reach their parts", async () => {
  const { cookie } = await unlock();
  assert.equal((await call("POST", "/api/control/sandboxes/delete", { cookie, body: { provider: "daytona", id: "sb-1" } })).status, 204);
  assert.deepEqual(fakePlaces.deleted.at(-1), ["daytona", "sb-1", false]);
  assert.equal((await call("POST", "/api/control/sandboxes/delete", { cookie, body: { provider: "aws", id: "x" } })).status, 400);
  const svc = await call("POST", "/api/control/service", { cookie, body: { startAtLogin: true } });
  assert.equal(svc.status, 400, "no service in this office");
  assert.equal((await call("GET", "/api/control/install", { cookie })).json.applied, false);
});

test("a plane that is off answers 404 everywhere and the snapshot says off", async () => {
  const st = new M.OfficeState({ home: HOME });
  const off = M.createControlPlane({ state: st, enabled: false, version: "x", host: "127.0.0.1", officeUrl: () => "" });
  const s2 = await M.startServer({ state: st, port: 0, webRoot: join(TMP, "web"), control: off });
  try {
    const get = (path, method = "GET") => new Promise((done) => {
      const req = request({ host: "127.0.0.1", port: s2.port, path, method, headers: { "x-agent-visualizer": "1" } }, (res) => {
        let t = "";
        res.on("data", (c) => (t += c));
        res.on("end", () => done({ status: res.statusCode, text: t }));
      });
      req.end();
    });
    assert.equal((await get("/api/control")).status, 404);
    assert.equal((await get("/unlock?t=x")).status, 404);
    assert.equal((await get("/api/hook/a/permission", "POST")).status, 404);
    assert.equal(JSON.parse((await get("/api/snapshot")).text).control, "off");
  } finally {
    await s2.close();
  }
});

test("ownedPids comes from the sessions part; shutdown ends the sessions", async () => {
  assert.deepEqual(plane.ownedPids(), [4242]);
});

test("Your setup: the inventory has names only; a hire carries the setup to a remote place and never to this Mac", async () => {
  const { cookie } = await unlock();
  const SECRET = "mcp-http-secret-0404";
  writeFileSync(join(HOME, ".claude.json"), JSON.stringify({ mcpServers: { tool: { command: "npx", args: ["-y", "@acme/tool"], env: { TOKEN: SECRET } } } }));
  const r = await call("GET", "/api/control/setup?agent=claude&folder=" + encodeURIComponent("~/Codes/beta"), { cookie });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.mcp.map((m) => [m.name, m.ok, m.secrets]), [["tool", true, 1]]);
  assert.deepEqual(r.json.shellKeys, ["ANTHROPIC_API_KEY"]);
  assert.equal(r.json.project.display, "~/Codes/beta");
  assert.ok(!r.text.includes(SECRET), "names only");
  assert.equal((await call("GET", "/api/control/setup?agent=nope", { cookie })).status, 400);
  assert.equal((await call("GET", "/api/control/setup?agent=claude&folder=" + encodeURIComponent(join(TMP, "outside")), { cookie })).status, 403);
  assert.equal((await call("GET", "/api/control/setup?agent=claude")).status, 401, "locked browsers get nothing");

  const local = await call("POST", "/api/control/hire", { cookie, body: { agent: "claude", mode: "terminal", place: { kind: "local", target: "~/Codes/beta" }, setup: { login: "none" } } });
  assert.equal(local.status, 400);
  assert.match(local.json.error, /already here/);
  const bad = await call("POST", "/api/control/hire", { cookie, body: { agent: "claude", mode: "terminal", place: { kind: "daytona", target: "new" }, setup: { login: "steal", shellKeys: ["not a key"] } } });
  assert.equal(bad.status, 400);
  const ok = await call("POST", "/api/control/hire", { cookie, body: { agent: "claude", mode: "terminal", place: { kind: "daytona", target: "new" }, setup: { login: "key", shellKeys: ["ANTHROPIC_API_KEY"], mcp: ["tool"], instructions: ["CLAUDE.md"], project: { folder: "~/Codes/beta", env: true } } } });
  assert.equal(ok.status, 200, ok.text);
  const hired = sessions.calls.filter((c) => c[0] === "hire").at(-1)[1];
  assert.deepEqual(hired.setup, { login: "key", shellKeys: ["ANTHROPIC_API_KEY"], mcp: ["tool"], instructions: ["CLAUDE.md"], project: { folder: join(HOME, "Codes", "beta"), git: true, env: true } });
});

test("Logins: the status rides ControlInfo; Connect Claude answers plainly when it can't run here", async () => {
  const { cookie } = await unlock();
  const info = await call("GET", "/api/control", { cookie });
  assert.deepEqual(info.json.logins, [{ agent: "claude", state: "idle" }]);
  const start = await call("POST", "/api/control/logins/claude", { cookie });
  assert.ok([400, 503].includes(start.status), start.text);
  assert.equal((await call("POST", "/api/control/logins/claude/input", { cookie, body: { data: "x" } })).status, 409);
  assert.equal((await call("DELETE", "/api/control/logins/claude", { cookie })).status, 204);
  assert.equal((await call("POST", "/api/control/logins/claude")).status, 401);
});
