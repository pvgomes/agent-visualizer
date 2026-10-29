// Tests for the web app's DOM-free parts: busy-pod seating (web/scene/layout.ts),
// the intern summary chip text, OfficeEvent.replaces in the chrome's model
// (web/ui/state.ts) and the control store's session lookup (web/ui/control/store.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

async function load(...entries) {
  const dir = mkdtempSync(join(tmpdir(), "agent-visualizer-web-test-"));
  const outfile = join(dir, "mod.mjs");
  await build({
    stdin: { contents: entries.map((e) => `export * from ${JSON.stringify(`./${e}`)};`).join("\n"), resolveDir: ROOT, loader: "ts" },
    bundle: true, platform: "node", format: "esm", target: "node18", outfile, logLevel: "error",
    loader: { ".svg": "text", ".css": "text" },
  });
  try {
    return await import(pathToFileURL(outfile).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const {
  Layout, Camera, SEAT_W, MAX_BENCH, MAX_HOT, POD_H, DESK_W, DESK_DY, SEAT_DY, DESK_ROW, ROOM_MIN_W, ROOM_MIN_W_TALL,
  internSummary, OfficeModel, ControlStore,
} = await load(
  "web/scene/layout.ts",
  "web/scene/camera.ts",
  "web/scene/util.ts",
  "web/ui/state.ts",
  "web/ui/control/store.ts",
);

/** A pod with one main worker and `n` interns, packed and settled. */
function crew(n, mains = 1) {
  const layout = new Layout();
  const seats = [];
  for (let m = 0; m < mains; m++) {
    layout.allocMain(`main${m}`, "claude", "Codes", undefined, 0);
    for (let i = 0; i < n; i++) seats.push(layout.allocIntern(`m${m}-sub${i}`, `main${m}`, "claude", "Codes", undefined, 0));
  }
  for (let t = 0; t < 200; t++) layout.update(16, t * 16);
  return { layout, seats, block: [...layout.blocks.values()][0] };
}

test("a busy pod seats every intern: nobody stands", () => {
  for (const n of [5, 9, 15]) {
    const { seats } = crew(n);
    assert.equal(seats.length, n);
    for (const s of seats) assert.equal(s.kind, "intern", `${n} interns: ${s.kind}`);
  }
});

test("1 + 9: the main desk's bench fills, the overflow goes to a hot desk, all on the rug", () => {
  const { seats, block } = crew(9);
  const own = seats.filter((s) => !s.st.hot), hot = seats.filter((s) => s.st.hot);
  assert.equal(own.length, MAX_BENCH);
  assert.equal(hot.length, 9 - MAX_BENCH);
  assert.equal(block.stations.at(-1).hot, true, "hot desks sit at the end of the pod");
  const xs = seats.map((s) => s.x).sort((a, b) => a - b);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] >= SEAT_W, `seats ${xs[i - 1]} and ${xs[i]} overlap`);
  for (const s of seats) {
    assert.ok(s.x - 7 >= block.x && s.x + 7 <= block.x + block.w, `intern at ${s.x} is off the rug [${block.x}, ${block.x + block.w}]`);
    assert.ok(s.y < block.y + POD_H, "inside the pod");
  }
});

test("two crowded desks share hot desks, and a hot desk never becomes a main desk", () => {
  const { layout, seats, block } = crew(MAX_BENCH + 5, 2);
  assert.equal(seats.filter((s) => s.st.hot).length, 10);
  assert.ok(block.stations.filter((s) => s.hot).every((s) => s.seats <= MAX_HOT));
  layout.allocMain("main2", "claude", "Codes", undefined, 0);
  const st = layout.seatOf("main2").st;
  assert.ok(!st.hot, "a new session gets a real desk");
  assert.ok(block.stations.indexOf(st) < block.stations.findIndex((s) => s.hot), "desks before hot desks");
});

test("an empty hot desk is cleared away after a short linger", () => {
  const { layout, block } = crew(MAX_BENCH + 2);
  let now = 10_000;
  for (let i = MAX_BENCH; i < MAX_BENCH + 2; i++) layout.free(`m0-sub${i}`, now);
  for (let t = 0; t < 200; t++) layout.update(16, (now += 16));
  assert.ok(block.stations.some((s) => s.hot), "still lingering");
  for (let t = 0; t < 200; t++) layout.update(16, (now += 16));
  assert.ok(!block.stations.some((s) => s.hot), "gone once it lingered");
});

test("rename keeps the seat: a replacing worker takes over the desk in place", () => {
  const layout = new Layout();
  const seat = layout.allocMain("ctl:ab12", "claude", "api", undefined, 0);
  layout.rename("ctl:ab12", "sess-1");
  assert.equal(layout.seatOf("sess-1"), seat);
  assert.equal(layout.seatOf("ctl:ab12"), undefined);
  assert.equal(seat.st.main, "sess-1");
});

/* ---- the floor plan by screen shape: a phone held upright vs a landscape screen ---- */

/** The owner's phone repro: six sessions in one project, three more one each. */
const HIRES = [["alpha", 6], ["beta", 1], ["gamma", 1], ["ledger", 1]];
/** The free area of a 390x844 phone between the top bar and the toolbar. */
const PHONE = 390 / 528;

function office(pods, aspect, tall, layout = new Layout()) {
  let n = 0;
  for (const [project, desks] of pods) for (let i = 0; i < desks; i++) layout.allocMain(`${project}-${n++}`, "claude", project, undefined, 0);
  return settle(layout, aspect, tall);
}

function settle(layout, aspect, tall) {
  layout.setAspect(aspect, tall);
  for (let t = 0; t < 300; t++) layout.update(16, t * 16);
  return layout;
}

const pod = (layout, project) => [...layout.blocks.values()].find((b) => b.project === project);
const rowsOf = (b) => new Set(b.stations.map((s) => s.oy)).size;
/** How big auto-fit can draw the room in a free area of this shape (relative units). */
const scale = (layout, aspect) => { const r = layout.room(); return Math.min(aspect / (r.w + 20), 1 / (r.h + 20)); };

test("remote workers from any host share one cloud-room pod on the office floor", () => {
  const layout = new Layout();
  layout.allocMain("local", "claude", "Codes", undefined, 0);
  const r1 = layout.allocMain("r1", "codex", "api", { kind: "railway", id: "railway:1", name: "edge" }, 0);
  const r2 = layout.allocMain("r2", "claude", "site", { kind: "vercel", id: "vercel:2", name: "web" }, 0);
  const sub = layout.allocIntern("r2-sub", "r2", "claude", "site", { kind: "vercel", id: "vercel:2", name: "web" }, 0);
  for (let t = 0; t < 200; t++) layout.update(16, t * 16);
  assert.equal(r1.block, r2.block, "one room for every sandbox");
  assert.equal(sub.block, r2.block, "interns sit on their parent's bench");
  assert.equal(r1.block.key, "cloud-room");
  assert.equal(r1.block.label, "cloud-room");
  assert.equal(r1.remote, true);
  assert.deepEqual(r1.block.mix, ["codex", "claude"], "each desk keeps its own agent");
  assert.equal(layout.blocks.size, 2);
  const room = layout.room();
  for (const b of layout.blocks.values()) assert.ok(b.x >= room.x && b.x + b.w <= room.x + room.w, `${b.key} is inside the office`);
  // everyone leaves: the room goes with them
  for (const id of ["r2-sub", "r1", "r2"]) layout.free(id, 4000);
  for (let t = 0; t < 1200; t++) layout.update(16, 4000 + t * 16);
  assert.equal(layout.blocks.has("cloud-room"), false);
});

test("portrait: a pod too wide for the screen wraps its desks into balanced rows", () => {
  const layout = office(HIRES, PHONE, true);
  const alpha = pod(layout, "alpha");
  const rows = rowsOf(alpha);
  assert.ok(rows >= 2, `alpha has ${rows} desk row(s)`);
  assert.equal(alpha.h, POD_H + (rows - 1) * DESK_ROW);
  const perRow = [...new Set(alpha.stations.map((s) => s.oy))].map((oy) => alpha.stations.filter((s) => s.oy === oy).length);
  assert.ok(Math.max(...perRow) - Math.min(...perRow) <= 1, `unbalanced rows ${perRow}`);
  for (const b of ["beta", "gamma", "ledger"].map((p) => pod(layout, p))) assert.equal(b.h, POD_H, `${b.project} stays one row`);
});

test("portrait: every wrapped desk sits on its own rug, in its row, with no desk on another", () => {
  const layout = office(HIRES, PHONE, true);
  const alpha = pod(layout, "alpha");
  const seats = alpha.stations.map((st) => layout.seatOf(st.main));
  for (const s of seats) {
    assert.ok(s.deskX >= alpha.x && s.deskX + DESK_W <= alpha.x + alpha.w, `desk at x ${s.deskX} is off the rug`);
    assert.equal(s.deskY, Math.round(alpha.y + s.st.oy) + DESK_DY, "the desk is in its row");
    assert.equal(s.y, s.deskY + SEAT_DY, "the chair hangs off the desk");
    assert.ok(s.laneY < alpha.y + alpha.h, "the lane to the chair is on the rug");
  }
  for (const a of seats) for (const b of seats) {
    if (a === b || a.deskY !== b.deskY) continue;
    assert.ok(Math.abs(a.deskX - b.deskX) >= DESK_W, `desks at ${a.deskX} and ${b.deskX} overlap`);
  }
});

test("landscape keeps the plan it always had: one row per pod, the wide room", () => {
  const layout = office(HIRES, 1.6, false);
  for (const b of layout.blocks.values()) {
    assert.equal(b.h, POD_H, `${b.project} is one row`);
    assert.ok(b.stations.every((s) => s.oy === 0));
  }
  assert.ok(layout.room().w >= ROOM_MIN_W);
});

test("portrait packing frames the office bigger than the landscape rules would on the same screen", () => {
  const tall = office(HIRES, PHONE, true);
  const wide = office(HIRES, PHONE, false);
  assert.ok(tall.room().w < wide.room().w, `portrait room ${tall.room().w} wide, landscape rules ${wide.room().w}`);
  assert.ok(tall.room().w >= ROOM_MIN_W_TALL);
  assert.ok(scale(tall, PHONE) > scale(wide, PHONE) * 1.15, `portrait ${scale(tall, PHONE)} vs ${scale(wide, PHONE)}`);
});

test("small pods on a phone don't wrap: there is nothing to gain", () => {
  const layout = office([["api", 1], ["web", 2], ["docs", 1]], PHONE, true);
  for (const b of layout.blocks.values()) assert.equal(b.h, POD_H, `${b.project} wrapped`);
});

test("turning the screen re-packs: wrapped desks go back to one row and the seats follow", () => {
  const layout = office(HIRES, PHONE, true);
  assert.ok(pod(layout, "alpha").h > POD_H);
  settle(layout, 1.6, false);
  const alpha = pod(layout, "alpha");
  assert.equal(alpha.h, POD_H);
  for (const st of alpha.stations) {
    const s = layout.seatOf(st.main);
    assert.equal(s.deskY, Math.round(alpha.y) + DESK_DY);
  }
});

/** A camera on a 390x844 phone at 3x, the chrome's top bar and toolbar as insets. */
function phoneCamera() {
  const cam = new Camera();
  Object.assign(cam, { vw: 1170, vh: 2532, dpr: 3 });
  cam.insets = { top: 116, right: 0, bottom: 200, left: 0 };
  return cam;
}
const podSpan = (layout) => {
  const bs = [...layout.blocks.values()];
  return { x0: Math.min(...bs.map((b) => b.tx)) - 26, x1: Math.max(...bs.map((b) => b.tx + b.w)) + 26 };
};

test("auto-fit on a phone rests on a whole zoom and keeps every pod in the free area", () => {
  const cam = phoneCamera();
  const layout = office(HIRES, cam.layoutAspect(), true);
  cam.fit(layout.room(), podSpan(layout));
  assert.ok(Number.isInteger(cam.tz), `zoom ${cam.tz}`);
  for (const b of layout.blocks.values()) {
    const [x0, y0] = cam.toScreen(b.x, b.y);
    const [x1, y1] = cam.toScreen(b.x + b.w, b.y + b.h);
    assert.ok(x0 >= 0 && x1 <= cam.vw, `${b.project} cut at the side: ${x0}..${x1}`);
    assert.ok(y0 >= 116 * 3 && y1 <= cam.vh - 200 * 3, `${b.project} under the chrome: ${y0}..${y1}`);
  }
});

test("drags and pinches stay over the office, and end on a whole zoom", () => {
  const layout = office([["api", 1]], 1, false);
  const room = layout.room();
  const cam = new Camera();
  Object.assign(cam, { vw: 1000, vh: 1000, dpr: 1 });
  cam.bounds = room;
  cam.fit(room);
  assert.equal(cam.tz, 3, "a whole zoom");
  // the whole office in frame: nothing to drag to, the camera stays on auto
  cam.panBy(0, 300);
  assert.equal(cam.mode, "auto");
  // pinch in: manual, and the gesture ends on the next whole zoom it was heading for
  cam.zoomAt(500, 500, 2.5);
  assert.equal(cam.mode, "manual");
  cam.settle(500, 500, 3);
  assert.equal(cam.tz, 8);
  // one small wheel notch still takes a whole step, either way
  cam.zoomAt(500, 500, 1.1);
  cam.settle(500, 500, 8);
  assert.equal(cam.tz, 9);
  cam.zoomAt(500, 500, 0.95);
  cam.settle(500, 500, 9);
  assert.equal(cam.tz, 8);
  // a drag far past the corner stops a few px past the room's edge
  cam.z = cam.tz;
  cam.panBy(-1e5, -1e5);
  const [sx, sy] = cam.toScreen(room.x + room.w, room.y + room.h);
  assert.ok(sx >= cam.vw - 12 - 1e-6 && sy >= cam.vh - 12 - 1e-6, `the room's corner is at ${sx}, ${sy}`);
  // zoomed out past the room it sits centred, wherever the drag goes
  cam.zoomAt(500, 500, 0.01);
  cam.z = cam.tz;
  cam.panBy(400, -250);
  const [cx, cy] = cam.toScreen(room.x + room.w / 2, room.y + room.h / 2);
  assert.ok(Math.abs(cx - 500) < 1e-6 && Math.abs(cy - 500) < 1e-6, `centre at ${cx}, ${cy}`);
});

test("intern summary: counts roles, folds the rest into +N when it doesn't fit", () => {
  const roles = ["fork", "fork", "general-purpose", "fork", "fork"];
  assert.equal(internSummary(roles, 60), "5 interns · fork ×4 · general-purpose");
  assert.equal(internSummary(roles, 24), "5 interns · fork ×4 · +1");
  assert.equal(internSummary(roles, 10), "5 interns · +2");
  assert.equal(internSummary(["Explore", "Plan", "Explore"], 60), "3 interns · Explore ×2 · Plan");
});

test("OfficeEvent.replaces moves a worker, its history and its interns to the new id", () => {
  const m = new OfficeModel();
  m.load({ version: 1, startedAt: "", demo: false, workers: [], recent: [] });
  const base = { ts: new Date().toISOString(), agent: "claude", project: "api" };
  m.apply({ ...base, seq: 1, workerId: "ctl:ab12", kind: "session_start" });
  m.apply({ ...base, seq: 2, workerId: "ctl:ab12", kind: "tool_start", tool: "Read", category: "read", summary: "Read a.ts" });
  m.apply({ ...base, seq: 3, workerId: "sub1", parentId: "ctl:ab12", kind: "subagent_start", role: "Explore" });
  const ch = m.apply({ ...base, seq: 4, workerId: "sess-1", kind: "session_start", replaces: "ctl:ab12" });
  assert.deepEqual(ch.renamed, { from: "ctl:ab12", to: "sess-1" });
  assert.equal(ch.joined, undefined, "no new worker joins");
  assert.equal(m.get("ctl:ab12"), undefined);
  const w = m.get("sess-1");
  assert.equal(w.toolCalls, 1);
  assert.ok(w.history.some((a) => a.summary === "Read a.ts"));
  assert.equal(m.get("sub1").parentId, "sess-1");
  assert.equal(m.workers.size, 2);
});

test("control store: sessions arrive by event and are found by their (renamed) worker", () => {
  const store = new ControlStore();
  store.state = "enabled";
  store.info = { enabled: true, agents: [], providers: [], keys: [], service: { supported: false, installed: false, running: false, startAtLogin: false, platform: "x" }, sessions: [], recentFolders: [] };
  const seen = [];
  store.subscribe((what) => seen.push(what));
  const s = { id: "ab12", agent: "claude", place: { kind: "local", target: "/w/api" }, mode: "terminal", workerId: "ctl:ab12", status: "starting", startedAt: new Date().toISOString(), title: "api", permission: "default" };
  store.onEvent("control", s);
  assert.equal(store.forWorker("ctl:ab12")?.id, "ab12");
  store.onEvent("control", { ...s, workerId: "sess-1", status: "running" });
  assert.equal(store.forWorker("ctl:ab12"), undefined);
  assert.equal(store.forWorker("sess-1")?.status, "running");
  store.onEvent("control_info", { keys: [{ name: "K", agents: [], preview: "k…1", addedAt: "" }] });
  assert.equal(store.info.keys.length, 1);
  store.onEvent("control_gone", { id: "ab12" });
  assert.equal(store.sessions.size, 0);
  assert.ok(seen.includes("sessions") && seen.includes("info"));
});

test("control store: a locked or control-less snapshot needs no request", async () => {
  const store = new ControlStore();
  let fetched = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetched++; return new Response("{}", { status: 401 }); };
  try {
    await store.fromSnapshot("locked");
    assert.equal(store.state, "locked");
    await store.fromSnapshot("off");
    assert.equal(store.state, "off");
    assert.equal(fetched, 0);
    await store.fromSnapshot(undefined);
    assert.equal(fetched, 1, "absent: probe once");
    assert.equal(store.state, "locked", "a 401 probe locks");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("control store: a primed answer stands for the first snapshot, and a dialog's refresh keeps the sessions events brought", async () => {
  const store = new ControlStore();
  const realFetch = globalThis.fetch;
  let fetched = 0;
  const session = (status) => ({ id: "s1", workerId: "w1", agent: "claude", mode: "terminal", status, title: "app", startedAt: new Date().toISOString(), place: { kind: "local", target: "/w" }, permission: "default" });
  let reply = { enabled: true, agents: [], providers: [], keys: [], sessions: [session("starting")], recentFolders: [], service: {} };
  globalThis.fetch = async () => { fetched++; return new Response(JSON.stringify(reply), { status: 200 }); };
  try {
    await store.refresh();
    assert.equal(store.state, "enabled");
    await store.fromSnapshot("enabled");
    assert.equal(fetched, 1, "the snapshot right after the primed answer doesn't ask again");
    store.onEvent("control", session("running"));
    // an answer computed before that event, as a dialog's refresh might get
    reply = { ...reply, keys: [{ name: "K", agents: [], preview: "k…1", addedAt: "" }], sessions: [session("starting")] };
    await store.refresh({ keepSessions: true });
    assert.equal(store.get("s1").status, "running", "the event's state stays");
    assert.equal(store.info.keys[0].name, "K", "the rest is new");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("control store: a control_info that lands while GET /api/control is out isn't lost to that older answer", async () => {
  const store = new ControlStore();
  const realFetch = globalThis.fetch;
  // The office's state: the agents on PATH first, their versions once the startup probe is done.
  let agents = [{ agent: "claude", installed: true, modes: ["terminal"], keyNames: [] }];
  const answer = () => JSON.stringify({ enabled: true, agents, providers: [], keys: [], sessions: [], recentFolders: [], service: {} });
  let release;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) {
      // assembled now, answered later (it waited on the platforms)
      const body = answer();
      await new Promise((r) => (release = r));
      return new Response(body, { status: 200 });
    }
    return new Response(answer(), { status: 200 });
  };
  try {
    const loading = store.refresh();
    await new Promise((r) => setTimeout(r, 5));
    // meanwhile the probe finishes and /events carries it
    agents = [{ agent: "claude", installed: true, version: "2.1.302", modes: ["terminal"], keyNames: [] }];
    store.onEvent("control_info", { agents });
    release();
    await loading;
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(store.state, "enabled");
    assert.equal(store.info.agents[0].version, "2.1.302", "the probe's versions stay");
  } finally {
    globalThis.fetch = realFetch;
  }
});
