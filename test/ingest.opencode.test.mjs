// opencode through the whole loop (src/ingest/index.ts + opencode.ts): a synthetic opencode.db in WAL mode,
// backfilled, then live rows (a tool going running -> completed, a child session as an intern), both from
// this machine and through a fake remote whose queries run on the sqlite3 CLI (or node) via `sh -c`.
// Skipped on Nodes without node:sqlite.
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

const I = await load("src/ingest/index.ts", "src/shared/events.ts");
let sqlite;
try {
  sqlite = await import("node:sqlite");
} catch {
  sqlite = null;
}

function makeDb(dir) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "opencode.db");
  const db = new sqlite.DatabaseSync(path);
  db.exec(`pragma journal_mode = wal;
    create table session (id text primary key, project_id text not null default 'p', parent_id text, slug text not null default 's', directory text not null, title text not null default 't',
      version text not null default '1.18.0', agent text, model text, time_created integer not null, time_updated integer not null, time_archived integer);
    create table message (id text primary key, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);
    create table part (id text primary key, message_id text not null, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);
    create index message_session_time_created_id_idx on message (session_id, time_created, id);
    create index part_message_id_id_idx on part (message_id, id);
    create index part_session_idx on part (session_id);`);
  const now = () => Date.now();
  const api = {
    path,
    session(id, o = {}) {
      const t = now();
      db.prepare("insert or replace into session (id, parent_id, directory, agent, time_created, time_updated) values (?, ?, ?, ?, ?, ?)").run(id, o.parent ?? null, o.dir ?? "/tmp/demo-app", o.agent ?? "build", t, t);
    },
    touch(id) {
      db.prepare("update session set time_updated = ? where id = ?").run(now(), id);
    },
    message(id, sid, data) {
      const t = now();
      db.prepare("insert or replace into message (id, session_id, time_created, time_updated, data) values (?, ?, coalesce((select time_created from message where id = ?), ?), ?, ?)").run(id, sid, id, t, t, JSON.stringify(data));
      api.touch(sid);
    },
    part(id, mid, sid, data) {
      const t = now();
      db.prepare("insert or replace into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, coalesce((select time_created from part where id = ?), ?), ?, ?)").run(id, mid, sid, id, t, t, JSON.stringify(data));
      api.touch(sid);
    },
    close: () => db.close(),
  };
  return api;
}

const kinds = (evs) => evs.map((e) => e.kind);
const asst = (o = {}) => ({ role: "assistant", modelID: "claude-opus-5-5", providerID: "anthropic", mode: "build", path: { cwd: "/tmp/demo-app", root: "/tmp/demo-app" }, time: { created: Date.now() }, ...o });

/** A session that already ran a passing test, plus a live poll later. */
function seed(db) {
  db.session("ses_main");
  db.message("msg_001", "ses_main", { role: "user", time: { created: Date.now() } });
  db.part("prt_001", "msg_001", "ses_main", { type: "text", text: "run the tests please" });
  db.message("msg_002", "ses_main", asst({ finish: "tool-calls", time: { created: Date.now(), completed: Date.now() } }));
  db.part("prt_002", "msg_002", "ses_main", { type: "reasoning", text: "secret plan" });
  db.part("prt_003", "msg_002", "ses_main", { type: "tool", tool: "bash", callID: "c1", state: { status: "completed", input: { command: "npm test" }, metadata: { exit: 0 }, output: "ok" } });
  db.part("prt_004", "msg_002", "ses_main", { type: "step-finish", reason: "tool-calls", tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 30, write: 0 } } });
}

async function scenario(t, makeIngest) {
  if (!sqlite) return t.skip("node:sqlite not available");
  const dir = mkdtempSync(join(tmpdir(), "agent-visualizer-oc-"));
  // Laid out like $XDG_DATA_HOME/opencode/opencode.db.
  const db = makeDb(join(dir, "opencode"));
  seed(db);
  const events = [];
  const ingest = makeIngest(dir, (e) => events.push(e));
  const tick = async () => {
    await ingest.tick();
    return events.splice(0);
  };
  try {
    const back = await tick();
    return { db, tick, back, dir, ingest };
  } catch (err) {
    db.close();
    throw err;
  }
}

async function liveSteps(s, prefix = "") {
  const { db, tick } = s;
  // A new step starts reading a file...
  db.message("msg_003", "ses_main", asst({}));
  db.part("prt_005", "msg_003", "ses_main", { type: "tool", tool: "read", callID: "c2", state: { status: "running", input: { filePath: "/tmp/demo-app/src/app.ts" } } });
  let evs = await tick();
  assert.deepEqual(kinds(evs), ["tool_start"]);
  assert.equal(evs[0].summary, "Read app.ts");
  assert.equal(evs[0].workerId, `${prefix}ses_main`);
  // ...which completes; the same rows polled again say nothing.
  db.part("prt_005", "msg_003", "ses_main", { type: "tool", tool: "read", callID: "c2", state: { status: "completed", input: { filePath: "/tmp/demo-app/src/app.ts" }, output: "file body" } });
  evs = await tick();
  assert.deepEqual(kinds(evs), ["tool_end"]);
  assert.deepEqual(await tick(), []);
  // A task call's child session walks in as an intern of ses_main.
  db.session("ses_kid", { parent: "ses_main", agent: "explore" });
  db.message("msg_k01", "ses_kid", asst({ mode: "explore" }));
  db.part("prt_k01", "msg_k01", "ses_kid", { type: "tool", tool: "grep", callID: "k1", state: { status: "running", input: { pattern: "TODO", include: "*.ts" } } });
  evs = await tick();
  const kid = evs.filter((e) => e.workerId === `${prefix}ses_kid`);
  assert.deepEqual(kinds(kid), ["subagent_start", "tool_start"]);
  assert.equal(kid[0].parentId, `${prefix}ses_main`);
  assert.equal(kid[0].role, "explore");
  assert.equal(kid[1].summary, "Search *.ts");
  // The main session finishes its turn.
  db.message("msg_003", "ses_main", asst({ finish: "stop", time: { created: Date.now(), completed: Date.now() } }));
  db.part("prt_006", "msg_003", "ses_main", { type: "text", text: "All done." });
  evs = (await tick()).filter((e) => e.workerId === `${prefix}ses_main`);
  assert.deepEqual(kinds(evs), ["thinking", "reply", "waiting"]);
}

test("opencode on this machine: backfill poses the session, live rows animate it", async (t) => {
  const s = await scenario(t, (dir, onEvent) => I.createIngest({ agents: ["opencode"], onEvent, watch: false, env: { AGENT_VISUALIZER_OPENCODE_DIR: join(dir, "opencode"), AGENT_VISUALIZER_HOME: join(dir, "ao") } }));
  if (!s) return;
  try {
    assert.deepEqual(kinds(s.back), ["session_start", "test_pass"]);
    assert.equal(s.back[0].project, "demo-app");
    assert.equal(s.back[0].model, "claude-opus-5-5");
    assert.equal(s.back[0].tokens, 150);
    // Prompt text, reasoning and output never reach a label.
    assert.ok(s.back.every((e) => !/please|secret|ok$/.test(e.summary ?? "")));
    await liveSteps(s);
  } finally {
    s.ingest.stop();
    s.db.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("opencode on a remote: the same rows through sqlite3 (or node) over sh, host-prefixed", async (t) => {
  const s = await scenario(t, (dir, onEvent) => {
    const home = join(dir, "home");
    mkdirSync(join(home, ".local", "share"), { recursive: true });
    const target = {
      host: { kind: "railway", id: "railway:sbx-1", name: "sbx-1" },
      // XDG_DATA_HOME points the remote's opencode lookup at the test database.
      exec: (script) => new Promise((res, rej) => execFile("sh", ["-c", script], { env: { PATH: process.env.PATH, HOME: home, XDG_DATA_HOME: dir }, maxBuffer: 16 << 20 }, (e, out) => (e ? rej(e) : res(out)))),
    };
    return I.createIngest({ agents: ["opencode"], local: false, remotes: [target], onEvent, watch: false });
  });
  if (!s) return;
  try {
    if (!s.back.length) {
      s.ingest.stop();
      return t.skip("remote has neither sqlite3 nor node:sqlite");
    }
    assert.deepEqual(kinds(s.back), ["session_start", "test_pass"]);
    assert.ok(s.back.every((e) => e.host?.kind === "railway"));
    await liveSteps(s, "railway:sbx-1/");
  } finally {
    s.ingest.stop();
    s.db.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("opencode: a second write in the same millisecond still reaches the office", async (t) => {
  const s = await scenario(t, (dir, onEvent) => I.createIngest({ agents: ["opencode"], onEvent, watch: false, env: { AGENT_VISUALIZER_OPENCODE_DIR: join(dir, "opencode"), AGENT_VISUALIZER_HOME: join(dir, "ao") } }));
  if (!s) return;
  const raw = new sqlite.DatabaseSync(s.db.path);
  try {
    s.db.message("msg_003", "ses_main", asst({}));
    s.db.part("prt_005", "msg_003", "ses_main", { type: "tool", tool: "read", callID: "c2", state: { status: "running", input: { filePath: "/tmp/demo-app/src/app.ts" } } });
    assert.deepEqual(kinds(await s.tick()), ["tool_start"]);
    // The tool completes with the very stamps the office already saw: opencode writes ms, and two
    // writes can share one.
    const { t: stamp } = raw.prepare("select time_updated as t from session where id = 'ses_main'").get();
    const done = { type: "tool", tool: "read", callID: "c2", state: { status: "completed", input: { filePath: "/tmp/demo-app/src/app.ts" }, output: "file body" } };
    raw.prepare("update part set data = ?, time_updated = ? where id = 'prt_005'").run(JSON.stringify(done), stamp);
    raw.prepare("update session set time_updated = ? where id = 'ses_main'").run(stamp);
    assert.deepEqual(kinds(await s.tick()), ["tool_end"]);
    assert.deepEqual(await s.tick(), [], "read again, the same rows say nothing");
  } finally {
    raw.close();
    s.ingest.stop();
    s.db.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});
