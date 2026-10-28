// Tests for the Source abstraction (src/ingest/source.ts) and the exec-based RemoteSource (src/remote/source.ts).
// The "remote" is a fake RemoteTarget whose exec runs `sh -c` on this machine against a temp HOME, which
// drives the real scripts end to end: listing, stat, binary-safe reads, SQLite queries, and the whole
// ingest loop over the remote path. Hostile filenames prove nothing in a name is ever executed.
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { execFile, execFileSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { POSIX } from "./platform.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FX = join(ROOT, "test", "fixtures");

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

const S = await load("src/ingest/source.ts", "src/remote/source.ts", "src/ingest/index.ts");

const HOST = { kind: "ssh", id: "ssh:test@box", name: "box" };

/** A RemoteTarget that is really `sh -c` here, with HOME pointed at a temp dir. */
function fakeTarget(home, counter = { execs: 0 }) {
  return {
    host: HOST,
    counter,
    exec: (script, o) =>
      new Promise((resolve, reject) => {
        counter.execs++;
        execFile("sh", ["-c", script], { env: { PATH: process.env.PATH, HOME: home, LC_ALL: "C" }, cwd: home, maxBuffer: 64 << 20, timeout: o?.timeoutMs ?? 20_000, encoding: "utf8" }, (err, out) =>
          err ? reject(err) : resolve(out),
        );
      }),
  };
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const HOSTILE = [
  "plain.jsonl",
  "it's.jsonl",
  "$(touch PWNED).jsonl",
  "`touch PWNED2`.jsonl",
  "sp ace;rm -rf x.jsonl",
  "-dash.jsonl",
  "back\\slash.jsonl",
  "uni-é-日本.jsonl",
  "'; touch PWNED3; '.jsonl",
  "%s%n.jsonl",
  "@0 b.jsonl",
];

function hostileTree() {
  const home = mkdtempSync(join(tmpdir(), "agent-visualizer-remote-"));
  const dir = join(home, "data", "deep");
  mkdirSync(dir, { recursive: true });
  HOSTILE.forEach((n, i) => writeFileSync(join(dir, n), Buffer.concat([Buffer.from(`{"i":${i}}\n`), Buffer.from([0, 255, 254, 10]), Buffer.from("é\n")])));
  writeFileSync(join(dir, "nl\nname.jsonl"), "x\n");
  writeFileSync(join(dir, "skip.txt"), "x\n");
  mkdirSync(join(home, "data", "node_modules"));
  writeFileSync(join(home, "data", "node_modules", "pkg.jsonl"), "x\n");
  return { home, dir };
}

const pwned = (home) => walk(home).some((p) => /PWNED/.test(p) && !p.endsWith(".jsonl"));

test("shQuote round-trips nasty strings through a real shell", () => {
  for (const s of ["", "a b", "it's", "$(id)", "`id`", "\\", "'\"'", "-n", "\n\t", "日本"]) {
    const out = execFileSync("sh", ["-c", `printf '%s' ${S.shQuote(s)}`], { encoding: "utf8" });
    assert.equal(out, s);
  }
});

test("inlineParams escapes SQL literals; decodeReads drops an entry cut off before @end", () => {
  assert.equal(S.inlineParams("a = ? and b = ? and c = ?", ["it's", 3, null]), "a = 'it''s' and b = 3 and c = NULL");
  const full = S.decodeReads("@0 b\naGVsbG8=\n@1 -\n@2 x\n6869\n@end\n");
  assert.equal(full.get(0).toString(), "hello");
  assert.equal(full.has(1), false);
  assert.equal(full.get(2).toString(), "hi");
  const cut = S.decodeReads("@0 b\naGVsbG8=\n@1 b\naGVs");
  assert.equal(cut.get(0).toString(), "hello");
  assert.equal(cut.has(1), false);
});

test("local and remote sources list, stat and read hostile filenames identically, executing nothing", { skip: POSIX }, async () => {
  const { home, dir } = hostileTree();
  const counter = { execs: 0 };
  const remote = S.createRemoteSource(fakeTarget(home, counter));
  const local = S.createLocalSource();
  const req = [{ root: join(home, "data"), depth: 3, suffixes: [".jsonl"], skip: ["node_modules"] }, { root: join(home, "missing"), depth: 2, suffixes: [".jsonl"] }];
  const [lr, rr] = [await local.list(req), await remote.list(req)];
  const names = (fs) => fs.map((f) => f.path.slice(dir.length + 1)).sort();
  // Remote skips the one name with a newline (it could forge an output line); everything else matches.
  assert.deepEqual(names(rr[0]), [...HOSTILE].sort());
  assert.deepEqual(names(lr[0]).filter((n) => !n.includes("\n")), [...HOSTILE].sort());
  assert.deepEqual(rr[1], []);
  const byPath = new Map(lr[0].map((f) => [f.path, f]));
  for (const f of rr[0]) {
    assert.equal(f.size, byPath.get(f.path).size);
    assert.equal(f.ino, byPath.get(f.path).ino);
    assert.equal(Math.floor(f.mtimeMs / 1000), Math.floor(byPath.get(f.path).mtimeMs / 1000));
  }
  const paths = HOSTILE.map((n) => join(dir, n));
  const rs = await remote.stat([...paths, join(dir, "nope.jsonl"), dir, "relative/path"]);
  assert.ok(rs.slice(0, HOSTILE.length).every((s, i) => s && s.size === byPath.get(paths[i]).size));
  assert.deepEqual(rs.slice(HOSTILE.length), [null, null, null]);
  // Byte ranges are binary-safe (NUL, invalid UTF-8) and stop at EOF.
  const reqs = paths.flatMap((p) => [{ path: p, start: 0, end: 1 << 20 }, { path: p, start: 3, end: 9 }]);
  const [lb, rb] = [await local.read(reqs), await remote.read(reqs)];
  rb.forEach((b, i) => assert.ok(b && lb[i] && b.equals(lb[i]), `read ${i}`));
  assert.deepEqual(await remote.read([{ path: join(dir, "nope.jsonl"), start: 0, end: 10 }]), [null]);
  assert.equal(pwned(home), false, "no name was ever executed");
  rmSync(home, { recursive: true, force: true });
});

test("remote: big batches split into several execs with the same answers; listAndRead is one exec", { skip: POSIX }, async () => {
  const { home, dir } = hostileTree();
  const t = fakeTarget(home);
  const small = S.createRemoteSource(t, { maxScriptBytes: 400, maxBatchBytes: 40, maxReadBytes: 1 << 20 });
  const big = S.createRemoteSource(fakeTarget(home));
  const paths = HOSTILE.map((n) => join(dir, n));
  const reqs = paths.map((p) => ({ path: p, start: 0, end: 100 }));
  const before = t.counter.execs;
  const [a, b] = [await small.read(reqs), await big.read(reqs)];
  assert.ok(t.counter.execs - before > 3, "split into several execs");
  a.forEach((x, i) => assert.ok(x.equals(b[i])));
  // listAndRead: reads may run past EOF, an empty buffer means nothing new.
  const c = fakeTarget(home);
  const one = S.createRemoteSource(c);
  const lists = [{ root: dir, depth: 0, suffixes: [".jsonl"] }];
  const n0 = c.counter.execs;
  const r = await one.listAndRead(lists, [{ path: paths[0], start: 0, end: 1 << 20 }, { path: paths[1], start: 1000, end: 2000 }, { path: join(dir, "gone"), start: 0, end: 5 }]);
  assert.equal(c.counter.execs - n0, 1);
  assert.equal(r.lists[0].length, HOSTILE.length);
  assert.ok(r.reads[0].equals(b[0]), "a read past EOF returns the bytes that exist");
  assert.equal(r.reads[1].length, 0);
  assert.equal(r.reads[2], null);
  assert.equal(pwned(home), false);
  rmSync(home, { recursive: true, force: true });
});

/** A small opencode-shaped database, or null when this Node has no node:sqlite. */
async function makeDb(path) {
  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch {
    return null;
  }
  const db = new sqlite.DatabaseSync(path);
  db.exec(`create table session (id text primary key, project_id text, parent_id text, slug text, directory text, title text, version text, agent text, time_created integer, time_updated integer, time_archived integer);
    create table message (id text primary key, session_id text, time_created integer, time_updated integer, data text);
    create table part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text);
    create index message_session_time_created_id_idx on message (session_id, time_created, id);
    create index part_message_id_id_idx on part (message_id, id);`);
  return db;
}

test("remote SQLite queries (sqlite3 CLI or node) match local ones; a missing database is empty", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "agent-visualizer-sql-"));
  const path = join(home, "it's a.db");
  const db = await makeDb(path);
  if (!db) return t.skip("node:sqlite not available");
  db.prepare("insert into session (id, directory, time_created, time_updated) values (?, ?, ?, ?)").run("ses_1", "/tmp/o'neil", 1, 2);
  db.close();
  const sql = "select id, directory, time_updated from session where id = ? and directory = ?";
  const params = ["ses_1", "/tmp/o'neil"];
  const local = await S.createLocalSource().query(path, sql, params);
  const remote = await S.createRemoteSource(fakeTarget(home)).query(path, sql, params);
  assert.deepEqual(local, [{ id: "ses_1", directory: "/tmp/o'neil", time_updated: 2 }]);
  if (remote === null) return t.skip("no sqlite3 or node:sqlite on the fake remote");
  assert.deepEqual(remote, local);
  assert.deepEqual(await S.createRemoteSource(fakeTarget(home)).query(join(home, "none.db"), "select 1"), []);
  rmSync(home, { recursive: true, force: true });
});

/* ------------------------------------------------- ingest over the remote */

const AGENTS = ["claude", "commandcode", "codex", "droid", "qwen", "cursor", "gemini"];

/** Every fixture laid out the way each agent keeps it under a fake HOME, freshly modified. */
function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), "agent-visualizer-home-"));
  cpSync(join(FX, "claude"), join(home, ".claude"), { recursive: true });
  cpSync(join(FX, "commandcode"), join(home, ".commandcode"), { recursive: true });
  cpSync(join(FX, "codex"), join(home, ".codex"), { recursive: true });
  cpSync(join(FX, "droid"), join(home, ".factory"), { recursive: true });
  cpSync(join(FX, "qwen"), join(home, ".qwen"), { recursive: true });
  cpSync(join(FX, "cursor"), join(home, ".cursor"), { recursive: true });
  cpSync(join(FX, "gemini"), join(home, ".gemini"), { recursive: true });
  const now = Date.now() / 1000;
  for (const f of walk(home)) utimesSync(f, now, now);
  return home;
}

const localEnv = (home) => ({
  AGENT_VISUALIZER_CLAUDE_DIR: join(home, ".claude"),
  AGENT_VISUALIZER_COMMANDCODE_DIR: join(home, ".commandcode"),
  AGENT_VISUALIZER_CODEX_DIR: join(home, ".codex"),
  AGENT_VISUALIZER_DROID_DIR: join(home, ".factory"),
  AGENT_VISUALIZER_QWEN_DIR: join(home, ".qwen"),
  AGENT_VISUALIZER_CURSOR_DIR: join(home, ".cursor"),
  AGENT_VISUALIZER_GEMINI_DIR: join(home, ".gemini"),
  AGENT_VISUALIZER_HOME: join(home, ".agent-visualizer"),
});

// Remote mtimes are whole seconds; Cursor's timestamps come from the mtime.
const secs = (e) => (e.agent === "cursor" ? { ...e, ts: e.ts.slice(0, 19) } : e);
const unhost = (e) => {
  const { host, ...x } = e;
  const strip = (id) => id.replace(/^ssh:test@box\//, "");
  return JSON.stringify(secs({ ...x, workerId: strip(x.workerId), ...(x.parentId ? { parentId: strip(x.parentId) } : {}) }));
};

test("the whole loop over a remote sees exactly what it sees locally, host-tagged and prefixed", { skip: POSIX }, async () => {
  const home = fakeHome();
  const remoteEvs = [];
  const localEvs = [];
  const target = fakeTarget(home);
  const r = S.createIngest({ agents: AGENTS, local: false, remotes: [target], onEvent: (e) => remoteEvs.push(e), watch: false });
  const l = S.createIngest({ agents: AGENTS, env: localEnv(home), onEvent: (e) => localEvs.push(e), watch: false });
  await r.tick();
  await l.tick();
  assert.ok(localEvs.length >= 12, `backfill found every agent (${localEvs.length})`);
  assert.deepEqual(new Set(localEvs.map((e) => e.agent)), new Set(AGENTS));
  assert.deepEqual(remoteEvs.map(unhost).sort(), localEvs.map((e) => JSON.stringify(secs(e))).sort());
  assert.ok(remoteEvs.every((e) => e.host?.id === HOST.id && e.workerId.startsWith("ssh:test@box/")));
  assert.ok(remoteEvs.filter((e) => e.parentId).every((e) => e.parentId.startsWith("ssh:test@box/")));

  // Live: a line appended on the remote arrives with the next poll, in one exec (listing + prefetch).
  const qwen = walk(join(home, ".qwen")).find((p) => p.endsWith(".jsonl"));
  appendFileSync(qwen, JSON.stringify({ type: "user", sessionId: "q", cwd: "/tmp/demo-app", timestamp: new Date().toISOString(), message: { role: "user", parts: [{ text: "again" }] } }) + "\n");
  const n = remoteEvs.length;
  const execs = target.counter.execs;
  await r.tick();
  assert.equal(target.counter.execs - execs, 1, "a quiet remote poll is one exec");
  const live = remoteEvs.slice(n);
  assert.deepEqual(live.map((e) => e.kind), ["prompt"]);
  assert.equal(live[0].agent, "qwen");
  assert.equal(live[0].host.kind, "ssh");
  r.stop();
  l.stop();
  rmSync(home, { recursive: true, force: true });
});

test("a remote that fails is retried and logged once, without touching the local office", async () => {
  const logs = [];
  let calls = 0;
  const broken = { host: { kind: "vercel", id: "vercel:sbx_1", name: "sbx" }, exec: async () => { calls++; throw new Error("sandbox stopped\nmore detail"); } };
  const h = S.startIngest({ agents: ["claude"], remotes: [broken], onEvent: () => {}, log: (m) => logs.push(m), local: false, remotePollMs: 20 });
  for (let i = 0; i < 40 && calls < 2; i++) await new Promise((res) => setTimeout(res, 25));
  h.stop();
  assert.ok(calls >= 2, "retried");
  assert.equal(logs.filter((m) => /sandbox stopped/.test(m)).length, 1, "the same error is logged once");
  assert.ok(logs.every((m) => !m.includes("more detail")));
});

test("missing remote folders list as empty and nothing is created on the remote", async () => {
  const home = mkdtempSync(join(tmpdir(), "agent-visualizer-empty-remote-"));
  const evs = [];
  const r = S.createIngest({ agents: AGENTS, local: false, remotes: [fakeTarget(home)], onEvent: (e) => evs.push(e), watch: false });
  await r.tick();
  await r.tick();
  assert.deepEqual(evs, []);
  assert.deepEqual(readdirSync(home), []);
  assert.equal(existsSync(join(home, ".agent-visualizer")), false);
  r.stop();
  rmSync(home, { recursive: true, force: true });
});

test("remote quick polls skip files untouched since the last full listing; reads come back gzipped and capped", { skip: POSIX }, async () => {
  const home = mkdtempSync(join(tmpdir(), "agent-visualizer-quick-"));
  const dir = join(home, "t");
  mkdirSync(dir);
  const old = Date.now() - 3 * 60 * 60_000;
  for (let i = 0; i < 20; i++) {
    writeFileSync(join(dir, `old-${i}.jsonl`), `{"i":${i}}\n`);
    utimesSync(join(dir, `old-${i}.jsonl`), old / 1000, old / 1000);
  }
  const scripts = [];
  const base = fakeTarget(home);
  const t = { ...base, exec: (s, o) => (scripts.push(s), base.exec(s, o)) };
  const src = S.createRemoteSource(t);
  const full = await src.list([{ root: dir, depth: 0, suffixes: [".jsonl"] }]);
  assert.equal(full[0].length, 20);
  writeFileSync(join(dir, "new.jsonl"), "{}\n");
  const quick = await src.list([{ root: dir, depth: 0, suffixes: [".jsonl"], onlyNew: true }]);
  assert.deepEqual(quick[0].map((f) => f.path.split("/").pop()), ["new.jsonl"], "the 20 old ones aren't re-stat'ed");
  assert.match(scripts.at(-1), /-mmin -[12] /);

  // A JSON-ish read is gzipped on the wire and inflates back byte-exact.
  const body = Buffer.from(Array.from({ length: 2000 }, (_, i) => `{"type":"assistant","n":${i},"text":"é日本"}\n`).join(""));
  writeFileSync(join(dir, "big.jsonl"), body);
  const [buf] = await src.read([{ path: join(dir, "big.jsonl"), start: 0, end: body.length }]);
  assert.ok(buf.equals(body));
  // A forged answer that inflates past the cap is dropped, not allocated.
  const { gzipSync } = await import("node:zlib");
  const bomb = gzipSync(Buffer.alloc(40 << 20)).toString("base64");
  assert.equal(S.decodeReads(`@0 z\n${bomb}\n@1 b\n${Buffer.from("ok").toString("base64")}\n@end\n`).has(0), false);
  assert.equal(S.decodeReads(`@1 b\n${Buffer.from("ok").toString("base64")}\n@end\n`).get(1).toString(), "ok");
  rmSync(home, { recursive: true, force: true });
});

test("a remote that caps reads (Railway) never replays the end of a tail window as new lines", async () => {
  const home = mkdtempSync(join(tmpdir(), "agent-visualizer-cap-"));
  const proj = join(home, ".claude", "projects", "-work-app");
  mkdirSync(proj, { recursive: true });
  const SIDX = "eeeeeeee-2222-4333-8444-555555555555";
  const t0 = Date.now() - 60_000;
  const lines = [];
  for (let i = 0; i < 120; i++) {
    const ts = new Date(t0 + i * 400).toISOString();
    lines.push(JSON.stringify({ type: "assistant", sessionId: SIDX, cwd: "/work/app", timestamp: ts, message: { id: `m${i}`, role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { command: "npm test" } }] } }));
    lines.push(JSON.stringify({ type: "user", sessionId: SIDX, cwd: "/work/app", timestamp: ts, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, is_error: true, content: "Exit code 1\n" + "x".repeat(200) }] } }));
  }
  writeFileSync(join(proj, `${SIDX}.jsonl`), lines.join("\n") + "\n");
  const target = { ...fakeTarget(home), readLimits: { maxReadBytes: 8 << 10, prefetchBytes: 4 << 10, maxBatchBytes: 32 << 10 } };
  const events = [];
  const ing = S.createIngest({ agents: ["claude"], local: false, remotes: [target], onEvent: (e) => events.push(e), watch: false });
  await ing.tick();
  const first = events.splice(0);
  assert.deepEqual(first.map((e) => e.kind), ["session_start", "test_fail"], "one arrival and the latest pose");
  await ing.tick();
  await ing.tick();
  assert.deepEqual(events.map((e) => e.kind), [], "nothing new on the remote, nothing replayed");
  ing.stop();
  rmSync(home, { recursive: true, force: true });
});
