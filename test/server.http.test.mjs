// Tests for src/server/http.ts: static serving and traversal, Host/Origin checks, headers, SSE, JSON endpoints.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http, { request } from "node:http";
import { connect, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";

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

const { OfficeState, startServer, hostOf, safeResolve, allowedHosts, hostAllowed } = await load(
  "src/server/state.ts",
  "src/server/http.ts",
  "src/server/static.ts",
);

const SECRET = "TOP SECRET DO NOT SERVE";
const HASHED_JS = `export const office = ${JSON.stringify("x".repeat(4000))};\n`;
let tmp, webRoot, state, srv, port;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "agent-visualizer-web-"));
  webRoot = join(tmp, "web");
  mkdirSync(join(webRoot, "assets", "logos"), { recursive: true });
  writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>office</title>");
  writeFileSync(join(webRoot, "assets", "app.js"), "export {};");
  writeFileSync(join(webRoot, "assets", "app.css"), "body{}");
  // a build output: hashed name, with the precompressed copies the build writes next to it
  writeFileSync(join(webRoot, "assets", "app-ABC234XY.js"), HASHED_JS);
  writeFileSync(join(webRoot, "assets", "app-ABC234XY.js.br"), brotliCompressSync(HASHED_JS));
  writeFileSync(join(webRoot, "assets", "app-ABC234XY.js.gz"), gzipSync(HASHED_JS));
  writeFileSync(join(webRoot, "assets", "logos", "claude.svg"), "<svg/>");
  writeFileSync(join(webRoot, "assets", ".env"), SECRET);
  writeFileSync(join(webRoot, "secret.txt"), SECRET); // inside the web root, outside assets
  writeFileSync(join(tmp, "secret.txt"), SECRET);
  symlinkSync(join(tmp, "secret.txt"), join(webRoot, "assets", "link.txt"));
  symlinkSync(join(webRoot, "secret.txt"), join(webRoot, "assets", "up.txt"));
  state = new OfficeState({ home: null });
  srv = await startServer({ state, port: 0, webRoot, pingMs: 60 });
  port = srv.port;
});

after(async () => {
  await srv.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** Raw-path GET via node:http (no URL normalisation). */
function get(path, headers = {}, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { Host: `localhost:${port}`, ...headers } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** Send bytes the http client would refuse to send, read the status line. */
function raw(text) {
  return new Promise((resolve, reject) => {
    const sock = connect(port, "127.0.0.1", () => sock.write(text));
    let buf = "";
    sock.setEncoding("latin1");
    sock.on("data", (d) => (buf += d));
    sock.on("end", () => resolve(buf));
    sock.on("close", () => resolve(buf));
    sock.on("error", reject);
  });
}

/** Open an SSE stream; returns helpers to await frames. */
function stream(headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/events", headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let buf = "";
      const waiters = [];
      res.setEncoding("utf8");
      res.on("data", (d) => {
        buf += d;
        for (const w of [...waiters]) w();
      });
      const until = (pred, ms = 2000) =>
        new Promise((ok, fail) => {
          const t = setTimeout(() => fail(new Error(`timeout waiting on stream; got: ${buf.slice(0, 300)}`)), ms);
          const check = () => {
            const r = pred(buf);
            if (r) {
              clearTimeout(t);
              waiters.splice(waiters.indexOf(check), 1);
              ok(r);
            }
          };
          waiters.push(check);
          check();
        });
      resolve({ res, req, until, text: () => buf, close: () => req.destroy() });
    });
    req.on("error", reject);
    req.end();
  });
}

const frames = (buf) =>
  buf
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const f = {};
      for (const line of block.split("\n")) {
        const i = line.indexOf(":");
        if (i === 0) f.comment = line.slice(1).trim();
        else if (i > 0) f[line.slice(0, i)] = line.slice(i + 1).trimStart();
      }
      return f;
    });

const ev = (over = {}) => ({
  ts: new Date().toISOString(), agent: "claude", workerId: "s1", project: "api-gateway", kind: "prompt", ...over,
});

test("GET / serves index.html with the security headers and no CORS", async () => {
  const r = await get("/", { Origin: "https://evil.example" });
  assert.equal(r.status, 200);
  assert.match(r.headers["content-type"], /^text\/html/);
  assert.match(r.body, /<title>office<\/title>/);
  const csp = r.headers["content-security-policy"];
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.equal(r.headers["referrer-policy"], "no-referrer");
  for (const h of Object.keys(r.headers)) assert.ok(!h.startsWith("access-control-"), `unexpected ${h}`);
});

test("assets get the right content types and revalidate by ETag", async () => {
  const js = await get("/assets/app.js");
  assert.equal(js.status, 200);
  assert.equal(js.headers["content-type"], "text/javascript; charset=utf-8");
  assert.equal(js.headers["cache-control"], "no-cache");
  assert.equal((await get("/assets/app.css")).headers["content-type"], "text/css; charset=utf-8");
  assert.equal((await get("/assets/logos/claude.svg")).headers["content-type"], "image/svg+xml");
  assert.equal((await get("/assets/app.js?v=2")).status, 200);
  const again = await get("/assets/app.js", { "If-None-Match": js.headers.etag });
  assert.equal(again.status, 304);
  assert.equal(again.body, "");
  const head = await get("/assets/app.js", {}, "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
});

/** GET as raw bytes (no decoding), with these request headers. */
function getRaw(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { Host: `localhost:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("hashed build outputs are cached for good and sent precompressed when the browser takes it", async () => {
  const br = await getRaw("/assets/app-ABC234XY.js", { "Accept-Encoding": "gzip, deflate, br" });
  assert.equal(br.status, 200);
  assert.equal(br.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(br.headers["content-encoding"], "br");
  assert.equal(br.headers.vary, "Accept-Encoding");
  assert.equal(br.headers["content-type"], "text/javascript; charset=utf-8");
  assert.equal(brotliDecompressSync(br.body).toString("utf8"), HASHED_JS);
  assert.equal(Number(br.headers["content-length"]), br.body.length);
  const gz = await getRaw("/assets/app-ABC234XY.js", { "Accept-Encoding": "gzip" });
  assert.equal(gz.headers["content-encoding"], "gzip");
  assert.equal(gunzipSync(gz.body).toString("utf8"), HASHED_JS);
  assert.notEqual(gz.headers.etag, br.headers.etag, "each encoding has its own ETag");
  const plain = await getRaw("/assets/app-ABC234XY.js", { "Accept-Encoding": "identity, br;q=0" });
  assert.equal(plain.headers["content-encoding"], undefined);
  assert.equal(plain.body.toString("utf8"), HASHED_JS);
  const again = await getRaw("/assets/app-ABC234XY.js", { "Accept-Encoding": "br", "If-None-Match": br.headers.etag });
  assert.equal(again.status, 304);
  // a name without a hash may change under the same name: revalidated each time
  assert.equal((await get("/assets/app.js")).headers["cache-control"], "no-cache");
  assert.equal((await get("/")).headers["cache-control"], "no-cache");
});

test("an asset that changes on disk is sent anew (the memory copy follows size and mtime)", async () => {
  const file = join(webRoot, "assets", "changing.js");
  writeFileSync(file, "export const v = 1;");
  assert.equal((await get("/assets/changing.js")).body, "export const v = 1;");
  writeFileSync(file, "export const v = 22;");
  assert.equal((await get("/assets/changing.js")).body, "export const v = 22;");
});

test("path traversal is refused in every spelling", async () => {
  const attempts = [
    "/assets/../secret.txt",
    "/assets/../../secret.txt",
    "/assets/%2e%2e/secret.txt",
    "/assets/%2E%2E/%2E%2E/secret.txt",
    "/assets/..%2fsecret.txt",
    "/assets/%2e%2e%2f%2e%2e%2fsecret.txt",
    "/assets/%252e%252e/secret.txt",
    "/assets/..%5csecret.txt",
    "/assets/..\\secret.txt",
    "/assets/logos/../../secret.txt",
    "/assets/./app.js",
    "/assets//secret.txt",
    "/assets/.env",
    "/assets/%2eenv",
    "/assets/app.js%00.txt",
    "/assets/%c0%ae%c0%ae/secret.txt",
    "/assets/link.txt",
    "/assets/up.txt",
    "/secret.txt",
    "/assets/",
    "//evil.example/assets/app.js",
  ];
  for (const path of attempts) {
    const r = await get(path);
    assert.ok([400, 404].includes(r.status), `${path} -> ${r.status}`);
    assert.ok(!r.body.includes(SECRET), `${path} leaked the secret`);
  }
  const nul = await raw(`GET /assets/app.js\0../../secret.txt HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
  assert.match(nul, /^HTTP\/1\.1 400/);
  const absolute = await raw(`GET http://localhost/assets/../secret.txt HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
  assert.match(absolute, /^HTTP\/1\.1 400/);
  assert.ok(!absolute.includes(SECRET));
});

test("safeResolve only returns paths inside the root", () => {
  const root = join(tmp, "web", "assets");
  assert.equal(safeResolve(root, "logos/claude.svg"), join(root, "logos", "claude.svg"));
  for (const bad of ["", "..", "../x", "a/../../x", "%2e%2e/x", "a%2f..%2f..%2fx", "a%00", "%E0%A4%A", "a\\b", "%5c"]) {
    assert.equal(safeResolve(root, bad), null, bad);
  }
});

test("Host header must name this machine (DNS-rebinding guard)", async () => {
  for (const host of ["evil.example", `evil.example:${port}`, `127.0.0.1.nip.io:${port}`, `localhost.:${port}`, `localhost:${port}@evil.example`]) {
    const r = await get("/api/snapshot", { Host: host });
    assert.ok([400, 403].includes(r.status), `${JSON.stringify(host)} -> ${r.status}`);
    assert.ok(!r.body.includes("workers"));
  }
  for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, "LOCALHOST", "localhost"]) {
    assert.equal((await get("/healthz", { Host: host })).status, 200, host);
  }
  const http10 = await raw("GET /api/snapshot HTTP/1.0\r\n\r\n");
  assert.match(http10, /^HTTP\/1\.1 403/);
  const empty = await raw("GET /api/snapshot HTTP/1.1\r\nHost: \r\nConnection: close\r\n\r\n");
  assert.match(empty, /^HTTP\/1\.1 (400|403)/);
  assert.ok(!empty.includes("workers"));
});

test("host parsing and the allow-list", () => {
  assert.equal(hostOf("[::1]:4747"), "[::1]");
  assert.equal(hostOf("LocalHost:4747"), "localhost");
  assert.equal(hostOf("a:b:c"), null);
  assert.equal(hostOf("localhost:abc"), null);
  assert.equal(hostOf("[::1]x"), null);
  const lan = allowedHosts("192.168.1.20");
  assert.ok(hostAllowed("192.168.1.20:4747", lan));
  assert.ok(!hostAllowed("192.168.1.21:4747", lan));
  assert.ok(allowedHosts("0.0.0.0").has("127.0.0.1"));
});

test("data endpoints refuse cross-site browsers", async () => {
  assert.equal((await get("/api/snapshot", { Origin: "https://evil.example" })).status, 403);
  assert.equal((await get("/api/snapshot", { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await get("/api/snapshot", { "Sec-Fetch-Site": "same-site" })).status, 403);
  assert.equal((await get("/events", { Origin: "http://localhost:3000.evil.example" })).status, 403);
  assert.equal((await get("/api/snapshot", { Origin: `http://localhost:${port}`, "Sec-Fetch-Site": "same-origin" })).status, 200);
  assert.equal((await get("/", { "Sec-Fetch-Site": "cross-site" })).status, 200, "navigating to the office from a link is fine");
});

test("only GET and HEAD", async () => {
  const r = await get("/api/snapshot", {}, "POST");
  assert.equal(r.status, 405);
  assert.equal(r.headers.allow, "GET, HEAD");
  assert.equal((await get("/api/snapshot", {}, "OPTIONS")).status, 405);
});

test("/api/snapshot and /healthz", async () => {
  state.ingest(ev({ kind: "session_start", workerId: "snap" }));
  const r = await get("/api/snapshot");
  assert.equal(r.status, 200);
  assert.match(r.headers["content-type"], /^application\/json/);
  assert.equal(r.headers["cache-control"], "no-store");
  const snap = JSON.parse(r.body);
  assert.equal(snap.version, 1);
  assert.ok(snap.workers.some((w) => w.workerId === "snap"));
  assert.ok(Array.isArray(snap.recent));
  const h = JSON.parse((await get("/healthz")).body);
  assert.equal(h.ok, true);
  assert.equal(typeof h.workers, "number");
  assert.equal(h.proof, undefined, "no secret, no proof");
  assert.equal((await get("/nope")).status, 404);
});

test("/healthz answers a challenge with an HMAC under the office secret, and nothing else", async () => {
  const { createHmac } = await import("node:crypto");
  const secret = "5e".repeat(32);
  const s2 = await startServer({ state: new OfficeState(), port: 0, webRoot, secret });
  try {
    const ask = async (q) => JSON.parse(await new Promise((done) => http.get({ host: "127.0.0.1", port: s2.port, path: `/healthz${q}` }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => done(b));
    })));
    const c = "0123456789abcdef0123456789abcdef";
    assert.equal((await ask(`?challenge=${c}`)).proof, createHmac("sha256", secret).update(`agent-visualizer:${c}`).digest("hex"));
    assert.equal((await ask("?challenge=not-hex")).proof, undefined);
    assert.equal((await ask("")).proof, undefined);
    assert.ok(!JSON.stringify(await ask(`?challenge=${c}`)).includes(secret), "the secret itself never leaves");
  } finally {
    await s2.close();
  }
});

test("SSE: snapshot first, then office events with ids, pings, and many clients", async () => {
  state.ingest(ev({ kind: "session_start", workerId: "live" }));
  const a = await stream();
  const b = await stream();
  assert.equal(a.res.statusCode, 200);
  assert.equal(a.res.headers["content-type"], "text/event-stream; charset=utf-8");
  assert.match(a.res.headers["cache-control"], /no-cache/);
  await a.until((t) => t.includes("event: snapshot"));
  const first = frames(a.text()).find((f) => f.event);
  assert.equal(first.event, "snapshot");
  const snap = JSON.parse(first.data);
  assert.ok(snap.workers.some((w) => w.workerId === "live"));
  assert.equal(srv.clients(), 2);

  const sent = state.ingest(ev({ kind: "tool_start", workerId: "live", tool: "Read", category: "read", summary: "Read a.ts" }));
  for (const s of [a, b]) {
    await s.until((t) => t.includes(`id: ${sent.seq}\n`));
    const f = frames(s.text()).find((x) => x.event === "office");
    assert.equal(f.id, String(sent.seq));
    assert.deepEqual(JSON.parse(f.data), sent);
  }
  await a.until((t) => t.includes(": ping"), 1000);

  a.close();
  b.close();
  for (let i = 0; i < 50 && srv.clients() > 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(srv.clients(), 0, "disconnected clients are dropped");
});

test("SSE refuses a cross-site EventSource", async () => {
  const s = await stream({ Origin: "https://evil.example" });
  assert.equal(s.res.statusCode, 403);
  s.close();
});

test("port fallback: a taken port moves to the next free one", async () => {
  const blocker = createNetServer();
  await new Promise((r) => blocker.listen(0, "127.0.0.1", r));
  const taken = blocker.address().port;
  const other = await startServer({ state: new OfficeState(), port: taken, webRoot, portFallback: 5 });
  try {
    assert.ok(other.port > taken && other.port <= taken + 5, `${other.port} after ${taken}`);
    assert.equal(other.url, `http://127.0.0.1:${other.port}`);
  } finally {
    await other.close();
    blocker.close();
  }
});

test("close() ends open streams and resolves", async () => {
  const s2 = await startServer({ state: new OfficeState(), port: 0, webRoot });
  const req = request({ host: "127.0.0.1", port: s2.port, path: "/events", headers: { Host: "localhost" } });
  const ended = new Promise((r) => req.on("response", (res) => { res.resume(); res.on("end", r); res.on("close", r); }));
  req.end();
  await new Promise((r) => setTimeout(r, 50));
  await s2.close();
  await ended;
});

test("missing web build answers 503, not a crash", async () => {
  const empty = mkdtempSync(join(tmpdir(), "agent-visualizer-empty-"));
  const s3 = await startServer({ state: new OfficeState(), port: 0, webRoot: empty });
  try {
    const r = await new Promise((resolve) =>
      request({ host: "127.0.0.1", port: s3.port, path: "/", headers: { Host: "localhost" } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).end(),
    );
    assert.equal(r, 503);
  } finally {
    await s3.close();
    rmSync(empty, { recursive: true, force: true });
  }
});
