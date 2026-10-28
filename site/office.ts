/*
 * The landing page's office, with no server: the real scene (web/scene),
 * driven by the real demo simulator (src/demo) through the real office state
 * (src/server/state.ts), all in the browser. The pipe is the one the CLI
 * builds for `--demo`, minus the HTTP hop:
 *
 *   createDemo().onEvent -> OfficeState.ingest -> subscribe -> scene.apply
 *
 * Time is virtual. The demo, the state's idle timer and every moment below
 * run on one clock that only moves while the office is running, so pausing
 * (the pause button, reduced motion, the office scrolled out of view, a
 * hidden tab) freezes the whole office and resuming picks up where it was.
 * The scene has no pause of its own, so pausing keeps a still of the last
 * frame and destroys it; resuming creates a new one and loads the state's
 * snapshot, which seats everyone at once, exactly like a reconnect.
 *
 * Moments on demand: trigger("flip") and friends inject the events a real
 * session would produce for a worker that is already seated (or hire a new
 * one), through the same state. A moment holds its worker for a few seconds:
 * the demo's own events for it wait and only the latest pose is replayed
 * after, so a raised hand or a table flip isn't cut short by the script.
 */
import { createOfficeScene, type OfficeSceneExtras } from "../web/scene/index.ts";
import { OfficeState } from "../src/server/state.ts";
import { createDemo } from "../src/demo/index.ts";
import { emit, session, type Ctx, type Persona } from "../src/demo/scripts.ts";
import { DEMO_HOSTS, ERRORS, FLIP_REASONS, MCP_CALLS, MODELS, MOODS, PROJECTS, SHOUTS, TOOLSETS, type Project } from "../src/demo/cast.ts";
import { Rng } from "../src/demo/rng.ts";
import { sleep, type Script } from "../src/demo/sim.ts";
import { BRAND, HOST_BRAND, type AgentKind, type EventKind, type Host, type OfficeEvent, type RawEvent } from "../src/shared/events.ts";

export type Moment =
  | "arrive" | "beam" | "leave"
  | "prompt" | "thinking" | "edit" | "bash" | "read" | "search" | "web" | "mcp" | "todo"
  | "intern" | "supervise" | "waiting" | "idle"
  | "smoke" | "alarm" | "flip" | "pass"
  | "status" | "shout" | "celebrate" | "rage";

export interface OfficeOptions {
  seed?: number;
  /** Virtual ms to run before the first frame, so the office opens busy (the first flip lands ~3s later). */
  fastForward?: number;
  /** Pin the sky to this hour; null follows the visitor's clock. */
  hour?: number | null;
}

export interface Fired {
  workerId: string;
  /** "Claude Code on api-gateway flipped a table", for the caption and the live region. */
  text: string;
}

export interface Office {
  start(): void;
  pause(): void;
  readonly running: boolean;
  trigger(m: Moment, opts?: { focus?: boolean }): Fired | null;
  /** Bring the camera in on a worker for a few seconds. */
  focus(workerId: string): void;
  setCrt(on: boolean): void;
  setDirector(on: boolean): void;
  /** Called with every published event (the page's caption line listens). */
  onEvent(fn: (e: OfficeEvent) => void): void;
  /** Called when the visitor clicks a worker on the canvas (null: empty floor). */
  onSelect(fn: (w: { id: string; text: string } | null) => void): void;
  /** For tooling: the scene, when one is mounted. */
  readonly scene: OfficeSceneExtras | null;
  destroy(): void;
}

/** Ms of virtual time a fresh worker needs to walk from the lift (or beam in) and sit down. */
const SEATED_LOCAL = 9_000;
const SEATED_REMOTE = 3_500;
/** Kinds that set a pose; only the last one held back during a moment is replayed. */
const POSE = new Set<EventKind>(["prompt", "thinking", "tool_start", "tool_end", "reply", "waiting", "idle"]);
const MAX_GUESTS = 3;
/** "Walks back to the lift" never thins the main office below this many desks. */
const MIN_LOCAL = 6;
const MAX_STEP = 250;

interface Seen {
  id: string;
  agent: AgentKind;
  project: string;
  host?: Host;
  parentId?: string;
  cwd?: string;
  model?: string;
  arrived: number;
  flipAt: number;
}

interface Hold {
  until: number;
  last?: RawEvent;
  end?: RawEvent;
}

const who = (s: { agent: AgentKind; project: string; host?: Host }) =>
  `${BRAND[s.agent]?.name ?? s.agent} on ${s.project}${s.host && s.host.kind !== "local" ? ` (${HOST_BRAND[s.host.kind].name})` : ""}`;

export function createOffice(mount: HTMLElement, opts: OfficeOptions = {}): Office {
  const base = Date.now();
  let v = 0;
  const vnow = () => base + v;
  const stamp = (t: number) => new Date(base + t).toISOString();
  const state = new OfficeState({ demo: true, now: vnow, home: null });

  /* ------------------------------------------------------------ routing */
  const holds = new Map<string, Hold>();
  /** Workers sent home by a moment while their demo script keeps going: never let them back in. */
  const dropped = new Set<string>();
  const ingest = (e: RawEvent) => state.ingest(e);
  const fromDemo = (raw: RawEvent) => {
    if (dropped.has(raw.workerId) || (raw.parentId && dropped.has(raw.parentId))) return;
    const h = holds.get(raw.workerId);
    if (!h) return void ingest(raw);
    if (raw.kind === "session_end") h.end = raw;
    else if (POSE.has(raw.kind)) h.last = raw;
  };
  const demo = createDemo({ onEvent: fromDemo, seed: opts.seed ?? 7, now: vnow, stamp });
  const sim = demo.sim;
  const office = { lastFlip: Number.NEGATIVE_INFINITY, quiet: [] as [number, number][] };
  const rng = new Rng((opts.seed ?? 7) * 7919 + 1);

  /* -------------------------------------------------------- who is here */
  const seen = new Map<string, Seen>();
  const listeners = new Set<(e: OfficeEvent) => void>();
  state.subscribe((e) => {
    if (e.kind === "session_start" || e.kind === "subagent_start") {
      seen.set(e.workerId, { id: e.workerId, agent: e.agent, project: e.project, host: e.host, parentId: e.parentId, cwd: e.cwd, model: e.model, arrived: v, flipAt: -1e9 });
    } else if (e.kind === "session_end" || e.kind === "subagent_end") {
      seen.delete(e.workerId);
    } else if (e.kind === "test_fail" || e.kind === "flip") {
      const s = seen.get(e.workerId);
      if (s) s.flipAt = v;
    }
    scene?.apply(e);
    for (const fn of listeners) fn(e);
  });

  const seated = (s: Seen) => v - s.arrived > (s.host ? SEATED_REMOTE : SEATED_LOCAL);
  function pick(where: "local" | "remote" | "any", prefer: AgentKind[] = []): Seen | undefined {
    const ok = [...seen.values()].filter(
      (s) => !s.parentId && seated(s) && !holds.has(s.id) && !dropped.has(s.id) && state.has(s.id) && v - s.flipAt > 9_000 &&
        (where === "any" || (where === "remote") === !!s.host),
    );
    const best = ok.filter((s) => prefer.includes(s.agent));
    const from = best.length ? best : ok;
    return from.length ? from[Math.floor(Math.random() * from.length)] : undefined;
  }

  function hold(id: string, ms: number) {
    const h = holds.get(id);
    if (h) h.until = Math.max(h.until, v + ms);
    else holds.set(id, { until: v + ms });
  }
  function releaseHolds() {
    for (const [id, h] of holds) {
      if (v < h.until) continue;
      holds.delete(id);
      const next = h.end ?? h.last;
      if (!next) continue;
      // A prompt that arrived meanwhile is replayed as the thinking it turned into: no stale paper plane.
      const kind: EventKind = next.kind === "prompt" || next.kind === "tool_end" ? "thinking" : next.kind;
      ingest({ ...next, kind, ts: stamp(v) });
    }
  }

  /* ------------------------------------------------------------ moments */
  const projectOf = (name: string): Project =>
    PROJECTS[name] ?? { name, files: ["index.ts"], testFiles: ["index.test.ts"], newFiles: ["util.ts"], test: "$ npm test", bash: ["$ git diff"], globs: ["*.ts"], docs: ["developer.mozilla.org"] };
  const ctxOf = (p: Persona): Ctx => ({ sim, rng: rng.fork(), me: p, tools: TOOLSETS[p.agent], stamp, out: ingest, office });
  const ctxFor = (s: Seen): Ctx =>
    ctxOf({ workerId: s.id, agent: s.agent, project: projectOf(s.project), model: s.model ?? MODELS[s.agent][0]!, cwd: s.cwd ?? `~/code/${s.project}`, host: s.host });
  const any = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;
  const run = (gen: Script) => sim.spawn(gen);

  let guests = 0;
  /** `now`: walk in this instant (from a trigger, outside the sim); false when called from a running script. */
  function hire(remote: boolean, now = true): Fired | null {
    if (guests >= MAX_GUESTS) return null;
    const busy = new Set([...seen.values()].map((s) => s.project));
    const free = Object.keys(PROJECTS).filter((p) => !busy.has(p));
    const project = projectOf(any(free.length ? free : Object.keys(PROJECTS)));
    const counts = new Map<AgentKind, number>();
    for (const s of seen.values()) if (!s.parentId && !s.host) counts.set(s.agent, (counts.get(s.agent) ?? 0) + 1);
    const agents = Object.keys(BRAND) as AgentKind[];
    const agent = remote ? any(["claude", "codex", "opencode"] as AgentKind[]) : agents.sort((a, b) => (counts.get(a) ?? 0) - (counts.get(b) ?? 0))[0]!;
    const box = remote ? any(Object.values(DEMO_HOSTS)) : undefined;
    const id = rng.uuid();
    const c = ctxOf({
      workerId: box ? `${box.host.id}/${id}` : id,
      agent,
      project,
      model: MODELS[agent][0]!,
      cwd: box ? `${box.home}/${project.name}` : `~/code/${project.name}`,
      ...(box ? { host: box.host } : {}),
    });
    guests++;
    const h = sim.spawn(session(c, { lifetime: 2, startDelay: 2_400 }));
    run((function* () {
      while (!h.done) yield sleep(1_000);
      guests--;
    })());
    // its session_start, so the scene can select and follow it straight away
    if (now) sim.runUntil(v);
    const s = { agent, project: project.name, host: box?.host };
    return { workerId: c.me.workerId, text: remote ? `${who(s)} beamed into the cloud wing` : `${who(s)} walked in from the lift` };
  }

  function* intern(parent: Ctx, role: string, life: number): Script {
    const p = parent.me;
    const c = ctxOf({ ...p, workerId: `${p.host ? `${p.host.id}/` : ""}agent-${parent.rng.hex(12)}`, parentId: p.workerId, role, model: p.agent === "claude" ? MODELS.claude[1]! : p.model });
    const t = parent.tools.tools;
    emit(c, "subagent_start", { role });
    yield sleep(2_800);
    emit(c, "thinking", { tokens: 1200 });
    yield sleep(1_400);
    for (let left = life; left > 0; left -= 2_600) {
      const f = any(p.project.files);
      if (Math.random() < 0.6) emit(c, "tool_start", { tool: t.read, category: "read", summary: `Read ${f}` });
      else emit(c, "tool_start", { tool: t.search, category: "search", summary: `Search ${any(p.project.globs)}` });
      yield sleep(1_700);
      emit(c, "tool_end", { tool: t.read, category: "read" });
      yield sleep(900);
    }
    emit(c, "reply", { tokens: 900 });
    yield sleep(700);
    emit(c, "subagent_end", { role });
    emit(parent, "tool_end", { tool: t.agent, category: "agent", summary: `Spawn ${role}` });
  }

  function tool(c: Ctx, category: "edit" | "bash" | "read" | "search" | "web" | "mcp" | "todo") {
    const t = c.tools.tools;
    const pr = c.me.project;
    if (category === "edit") return emit(c, "tool_start", { tool: t.edit, category, summary: `Edit ${any(pr.files)}`, tokens: 900 });
    if (category === "bash") return emit(c, "tool_start", { tool: t.bash, category, summary: any(pr.bash), tokens: 300 });
    if (category === "read") return emit(c, "tool_start", { tool: t.read, category, summary: `Read ${any(pr.files)}`, tokens: 1400 });
    if (category === "search") return emit(c, "tool_start", { tool: t.search, category, summary: `Search ${any(pr.globs)}`, tokens: 400 });
    if (category === "web") return emit(c, "tool_start", { tool: any(c.tools.web), category, summary: any(pr.docs), tokens: 2000 });
    if (category === "todo") return emit(c, "tool_start", { tool: t.todo, category, summary: c.tools.todoSummary, tokens: 200 });
    const [server, name] = any(MCP_CALLS);
    return emit(c, "tool_start", { tool: `mcp__${server}__${name}`, category, summary: `${server}.${name}`, tokens: 600 });
  }

  const POSES: Record<string, [string, number]> = {
    thinking: ["is thinking", 5_000],
    edit: ["is editing files", 5_500],
    bash: ["is running a command", 5_500],
    read: ["is reading files", 5_500],
    search: ["is searching the code", 5_500],
    web: ["is fetching the web", 5_500],
    mcp: ["called an MCP tool", 5_500],
  };

  function fire(m: Moment): Fired | null {
    if (m === "arrive") return hire(false);
    if (m === "beam") return hire(true);

    const remoteOk = m === "status" || m === "shout" || m === "celebrate";
    const s = m === "intern" || m === "supervise" ? pick("local", ["claude", "codex"]) : pick(remoteOk ? "any" : "local");
    if (!s) return null;
    const c = ctxFor(s);
    const pr = c.me.project;
    const name = who(s);
    const done = (text: string): Fired => ({ workerId: s.id, text: `${name} ${text}` });

    switch (m) {
      case "leave": {
        // keep the floor busy: nobody else goes home while the office is thin
        const here = [...seen.values()].filter((w) => !w.parentId && !w.host && !dropped.has(w.id)).length;
        if (here <= MIN_LOCAL) return null;
        dropped.add(s.id);
        state.end(s.id);
        // Someone new takes the desk a little later, as the demo's director would.
        run((function* () {
          yield sleep(7_000);
          hire(false, false);
        })());
        return done("clocked out and walked back to the lift");
      }
      case "prompt":
        hold(s.id, 4_500);
        emit(c, "prompt");
        run((function* () {
          yield sleep(1_900);
          emit(c, "thinking", { tokens: 3000 });
        })());
        return done("got a new prompt");
      case "thinking":
        hold(s.id, POSES.thinking![1]);
        emit(c, "thinking", { tokens: 4000 });
        return done(POSES.thinking![0]);
      case "edit": case "bash": case "read": case "search": case "web": case "mcp":
        hold(s.id, POSES[m]![1]);
        tool(c, m);
        return done(POSES[m]![0]);
      case "todo":
        hold(s.id, 6_500);
        run((function* () {
          for (let i = 0; i < 3; i++) {
            tool(c, "todo");
            yield sleep(1_100);
          }
        })());
        return done("updated its todo list");
      case "intern": {
        hold(s.id, 3_500);
        emit(c, "tool_start", { tool: c.tools.tools.agent, category: "agent", summary: "Spawn Explore", tokens: 800 });
        run(intern(c, s.agent === "codex" ? "explorer" : "Explore", 8_000));
        return done("spawned a subagent: an intern walks in");
      }
      case "supervise": {
        hold(s.id, 18_000);
        run((function* () {
          const roles = s.agent === "codex" ? ["explorer", "worker", "explorer"] : ["Explore", "general-purpose", "Plan"];
          for (const [i, role] of roles.entries()) {
            emit(c, "tool_start", { tool: c.tools.tools.agent, category: "agent", summary: `Spawn ${role}`, tokens: 700 });
            sim.spawn(intern(c, role, 7_000 + i * 2_600), 200);
            yield sleep(600);
          }
          yield sleep(800);
          emit(c, "reply", { tokens: 1600 });
          yield sleep(500);
          // The turn ends while the interns work: the state turns this into "supervising 3 interns".
          emit(c, "waiting");
        })());
        return done("ended its turn while three interns keep working");
      }
      case "waiting":
        hold(s.id, 7_000);
        emit(c, "reply", { tokens: 1800 });
        run((function* () {
          yield sleep(500);
          emit(c, "waiting");
        })());
        return done("finished and is waiting on you");
      case "idle":
        hold(s.id, 9_000);
        emit(c, "idle");
        return done("has been idle for a while");
      case "smoke":
        hold(s.id, 5_000);
        tool(c, "bash");
        run((function* () {
          yield sleep(900);
          emit(c, "tool_end", { tool: c.tools.tools.bash, category: "bash", isError: true });
        })());
        return done("had a tool call fail");
      case "alarm":
        hold(s.id, 5_200);
        emit(c, "error", { summary: any(ERRORS), isError: true });
        return done("hit an API error");
      case "flip":
      case "pass": {
        const fail = m === "flip";
        hold(s.id, fail ? 8_500 : 5_000);
        const t = c.tools.tools.bash;
        emit(c, "tool_start", { tool: t, category: "bash", summary: pr.test, tokens: 400 });
        run((function* () {
          yield sleep(1_200);
          emit(c, "tool_end", fail ? { tool: t, category: "bash", summary: pr.test, isError: true } : { tool: t, category: "bash", summary: pr.test });
          yield sleep(120);
          emit(c, fail ? "test_fail" : "test_pass", { tool: t, category: "bash", summary: pr.test });
        })());
        return done(fail ? `ran ${pr.test.replace(/^\$ /, "")} and flipped the table` : `ran ${pr.test.replace(/^\$ /, "")}: all green`);
      }
      case "status": {
        const [emoji, text] = any(MOODS);
        emit(c, "status", { tool: emoji, summary: text });
        return done(`set its status: "${text}"`);
      }
      case "shout": {
        const text = any(SHOUTS);
        emit(c, "shout", { summary: text });
        return done(`shouted on the office TV: "${text.replace(/\s*\p{Extended_Pictographic}.*$/u, "")}"`);
      }
      case "celebrate":
        emit(c, "celebrate");
        return done("asked for confetti");
      case "rage": {
        hold(s.id, 8_000);
        const why = any(FLIP_REASONS);
        office.lastFlip = sim.now;
        emit(c, "flip", { summary: why });
        return done(`flipped its own table: "${why}"`);
      }
    }
    return null;
  }

  /* -------------------------------------------------------------- scene */
  let scene: OfficeSceneExtras | null = null;
  let still: HTMLCanvasElement | null = null;
  let crt = false;
  let director = false;
  let selectCb: ((w: { id: string; text: string } | null) => void) | null = null;
  let spot: { id: string; until: number; focus: boolean } | null = null;

  // A landing page scrolls: the wheel and a drag over the office belong to the page, not the camera.
  const toPage = (e: Event) => e.stopPropagation();
  const noDrag = (e: PointerEvent) => {
    if (e.buttons) e.stopPropagation();
  };
  mount.addEventListener("wheel", toPage, { capture: true });
  mount.addEventListener("pointermove", noDrag, { capture: true });

  function mountScene() {
    const sc = createOfficeScene(mount) as OfficeSceneExtras;
    scene = sc;
    sc.canvas.style.touchAction = "pan-y";
    sc.canvas.setAttribute("aria-hidden", "true");
    if (opts.hour !== undefined) sc.setHour(opts.hour);
    sc.setWeather("clear");
    sc.setCrt(crt);
    sc.setDirector?.(director);
    sc.onSelect((id) => {
      if (!id) {
        sc.select(null);
        spot = null;
        return selectCb?.(null);
      }
      sc.focus(id);
      const w = state.snapshot().workers.find((x) => x.workerId === id);
      if (w) selectCb?.({ id, text: `${who(w)}${w.role ? ` · intern (${w.role})` : ""}${w.summary ? ` · ${w.summary}` : ""}` });
    });
    sc.load(state.snapshot());
    if (still) {
      // keep the still up until the new canvas has painted, so a resume never flashes
      const old = still;
      still = null;
      requestAnimationFrame(() => requestAnimationFrame(() => old.remove()));
    }
  }

  function unmountScene() {
    if (!scene) return;
    const src = scene.canvas;
    const c = document.createElement("canvas");
    c.width = src.width;
    c.height = src.height;
    c.getContext("2d")?.drawImage(src, 0, 0);
    c.className = "office-still";
    c.setAttribute("aria-hidden", "true");
    c.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;image-rendering:pixelated;";
    still?.remove();
    still = c;
    mount.appendChild(c);
    scene.destroy();
    scene = null;
  }

  /* --------------------------------------------------------------- clock */
  let running = false;
  let timer = 0;
  let lastReal = 0;
  let lastTick = 0;

  function advance(to: number) {
    while (v < to) {
      v = Math.min(to, v + 500);
      sim.runUntil(v);
      if (v - lastTick >= 1_000) {
        lastTick = v;
        state.tick();
      }
    }
  }

  function pump() {
    timer = 0;
    if (!running) return;
    const t = performance.now();
    // never replay a burst: a stalled tab just runs the office a little slower
    advance(v + Math.min(MAX_STEP, t - lastReal));
    lastReal = t;
    releaseHolds();
    if (spot && v >= spot.until) {
      if (scene) scene.select(null);
      spot = null;
    }
    const due = sim.nextDue();
    timer = window.setTimeout(pump, Math.max(16, Math.min(200, due === undefined ? 200 : due - v)));
  }

  advance(opts.fastForward ?? 0);

  const api: Office = {
    get running() {
      return running;
    },
    get scene() {
      return scene;
    },
    start() {
      if (running) return;
      running = true;
      lastReal = performance.now();
      if (!scene) mountScene();
      pump();
    },
    pause() {
      if (!running) return;
      running = false;
      clearTimeout(timer);
      timer = 0;
      unmountScene();
    },
    trigger(m, o = {}) {
      if (!running) return null;
      const fired = fire(m);
      if (!fired || !scene) return fired;
      const focus = !!o.focus && m !== "shout";
      // a moment the camera shouldn't fly to still gets the whole office back from the last one it did
      if (!focus && spot?.focus) scene.select(null);
      scene.select(fired.workerId);
      if (focus) scene.focus(fired.workerId);
      spot = { id: fired.workerId, until: v + (m === "arrive" || m === "beam" ? 9_000 : m === "supervise" ? 9_000 : 5_500), focus };
      return fired;
    },
    focus(id) {
      if (!scene || !seen.has(id)) return;
      scene.select(id);
      scene.focus(id);
      spot = { id, until: v + 5_500, focus: true };
    },
    setCrt(on) {
      crt = on;
      scene?.setCrt(on);
    },
    setDirector(on) {
      director = on;
      scene?.setDirector?.(on);
    },
    onEvent(fn) {
      listeners.add(fn);
    },
    onSelect(fn) {
      selectCb = fn;
    },
    destroy() {
      running = false;
      clearTimeout(timer);
      scene?.destroy();
      scene = null;
      still?.remove();
      mount.removeEventListener("wheel", toPage, { capture: true });
      mount.removeEventListener("pointermove", noDrag, { capture: true });
    },
  };
  return api;
}
