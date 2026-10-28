/*
 * The office the video films: the real OfficeState (src/server/state.ts) fed
 * by a scripted cast on the virtual clock. Workers run small loops built from
 * the demo's own pieces (src/demo: emit, the cast's projects, toolsets and
 * models), so every label is one the real demo would show; the beats the
 * video cuts to (poses, interns, the flip, the beam-ins, the hand up) are
 * placed at exact world times instead of left to the demo's dice. A beat
 * "holds" its worker so the background loop can't step on it.
 *
 * World time is vt time (ms). The stage advances it; the sim and the state's
 * once-a-second tick follow.
 */
import { OfficeState } from "../../src/server/state.ts";
import { emit, type Ctx, type Persona } from "../../src/demo/scripts.ts";
import { DEMO_HOSTS, MODELS, PROJECTS, TOOLSETS } from "../../src/demo/cast.ts";
import { Rng } from "../../src/demo/rng.ts";
import { Sim, sleep, type Script } from "../../src/demo/sim.ts";
import type { AgentKind, OfficeEvent, RawEvent } from "../../src/shared/events.ts";

declare const __vt: { now: number; epoch: number };

export interface Hand {
  id: string;
  c: Ctx;
}

type Cat = "read" | "search" | "edit" | "bash" | "web" | "thinking";

export class World {
  readonly sim = new Sim();
  readonly state: OfficeState;
  private readonly rng = new Rng(20261020);
  private readonly holds = new Map<string, number>();
  private readonly office = { lastFlip: Number.NEGATIVE_INFINITY, quiet: [[0, Number.POSITIVE_INFINITY]] as [number, number][] };
  private lastTick = 0;
  readonly hands = new Map<string, Hand>();
  private listeners = new Set<(e: OfficeEvent) => void>();

  constructor() {
    this.state = new OfficeState({ demo: false, now: () => __vt.epoch + __vt.now, home: null });
    this.state.subscribe((e) => {
      for (const fn of this.listeners) fn(e);
    });
  }

  on(fn: (e: OfficeEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Run the cast and the state's clock up to world ms t. */
  step(t: number) {
    this.sim.runUntil(t);
    while (t - this.lastTick >= 1000) {
      this.lastTick += 1000;
      this.state.tick();
    }
  }

  readonly stamp = (v: number) => new Date(__vt.epoch + v).toISOString();
  readonly ingest = (e: RawEvent) => {
    this.state.ingest(e);
  };

  /* ------------------------------------------------------------- cast */

  persona(agent: AgentKind, project: string, host?: keyof typeof DEMO_HOSTS, model = 0): Persona {
    const box = host ? DEMO_HOSTS[host] : undefined;
    const id = this.rng.uuid();
    return {
      workerId: box ? `${box.host.id}/${id}` : id,
      agent,
      project: PROJECTS[project]!,
      model: MODELS[agent][model % MODELS[agent].length]!,
      cwd: box ? `${box.home}/${project}` : `~/code/${project}`,
      ...(box ? { host: box.host } : {}),
    };
  }

  ctx(p: Persona): Ctx {
    return { sim: this.sim, rng: this.rng.fork(), me: p, tools: TOOLSETS[p.agent], stamp: this.stamp, out: this.ingest, office: this.office };
  }

  /** A worker walks in (or beams in) at world ms `at` and then works in a loop. */
  hire(name: string, p: Persona, at: number, settle = 6_500): Hand {
    const c = this.ctx(p);
    const hand = { id: p.workerId, c };
    this.hands.set(name, hand);
    this.sim.spawn(this.life(c, settle), Math.max(0, at - this.sim.now));
    return hand;
  }

  private *life(c: Ctx, settle: number): Script {
    emit(c, "session_start");
    yield sleep(settle);
    if (!this.held(c.me.workerId)) emit(c, "prompt");
    yield sleep(900);
    yield* this.loop(c);
  }

  held(id: string) {
    return (this.holds.get(id) ?? -1) > this.sim.now;
  }

  hold(id: string, until: number) {
    this.holds.set(id, Math.max(this.holds.get(id) ?? 0, until));
  }

  /** The background day: reads, searches, edits, a lint or a build now and then. Never waits, never flips. */
  private *loop(c: Ctx): Script {
    const r = c.rng;
    const pr = c.me.project;
    const t = c.tools.tools;
    for (;;) {
      if (this.held(c.me.workerId)) {
        yield sleep(200);
        continue;
      }
      const roll = r.next();
      const cat: Cat = roll < 0.14 ? "thinking" : roll < 0.42 ? "read" : roll < 0.6 ? "search" : roll < 0.88 ? "edit" : roll < 0.95 ? "bash" : "web";
      if (cat === "thinking") {
        emit(c, "thinking", { tokens: r.int(900, 6000) });
        yield sleep(r.int(1600, 3200));
        continue;
      }
      const summary =
        cat === "read" ? `Read ${r.pick(pr.files)}` :
        cat === "search" ? `Search ${r.pick(pr.globs)}` :
        cat === "edit" ? `Edit ${r.pick(pr.files)}` :
        cat === "bash" ? r.pick(pr.bash) : r.pick(pr.docs);
      const tool = cat === "read" ? t.read : cat === "search" ? (r.chance(0.5) ? t.search : t.glob) : cat === "edit" ? t.edit : cat === "bash" ? t.bash : r.pick(c.tools.web);
      emit(c, "tool_start", { tool, category: cat, summary, tokens: r.int(200, 2400) });
      yield sleep(r.int(1700, 3800));
      if (this.held(c.me.workerId)) continue;
      emit(c, "tool_end", { tool, category: cat, summary });
      yield sleep(r.int(250, 700));
    }
  }

  /* ------------------------------------------------------------ beats */

  /** Run `gen` at world ms `at`. */
  at(at: number, gen: () => Script) {
    this.sim.spawn(gen(), Math.max(0, at - this.sim.now));
  }

  /** Hold a pose: one tool call that lasts until `until`. */
  pose(name: string, at: number, cat: Exclude<Cat, "thinking">, summary: string, until: number) {
    const h = this.hands.get(name)!;
    const t = h.c.tools.tools;
    const tool = cat === "read" ? t.read : cat === "search" ? t.search : cat === "edit" ? t.edit : cat === "bash" ? t.bash : t.web;
    this.at(at, function* (this: World) {
      this.hold(h.id, until + 400);
      emit(h.c, "tool_start", { tool, category: cat, summary, tokens: 1200 });
    }.bind(this));
  }

  /** The boss hands work to interns who walk in from the lift; its turn ends and it leans back to supervise. */
  interns(name: string, at: number, roles: string[], life: number) {
    const h = this.hands.get(name)!;
    const world = this;
    const c = h.c;
    const t = c.tools.tools;
    this.at(at, function* () {
      world.hold(h.id, at + life + 4_000);
      for (const [i, role] of roles.entries()) {
        emit(c, "tool_start", { tool: t.agent, category: "agent", summary: `Spawn ${role}`, tokens: 700 });
        world.sim.spawn(world.intern(c, role, life - i * 900), 150);
        yield sleep(700);
      }
      yield sleep(900);
      emit(c, "reply", { tokens: 1400 });
      yield sleep(400);
      // the turn ends while the interns work: the state turns this into "supervising 3 interns"
      emit(c, "waiting");
    });
  }

  private *intern(parent: Ctx, role: string, life: number): Script {
    const p = parent.me;
    const r = parent.rng;
    const c = this.ctx({ ...p, workerId: `agent-${r.hex(12)}`, parentId: p.workerId, role, model: p.agent === "claude" ? MODELS.claude[1]! : p.model });
    const t = c.tools.tools;
    emit(c, "subagent_start", { role });
    yield sleep(3_000);
    emit(c, "thinking", { tokens: 1200 });
    yield sleep(1_200);
    for (let left = life; left > 0; left -= 2_400) {
      const read = r.chance(0.6);
      emit(c, "tool_start", read ? { tool: t.read, category: "read", summary: `Read ${r.pick(p.project.files)}` } : { tool: t.search, category: "search", summary: `Search ${r.pick(p.project.globs)}` });
      yield sleep(1_700);
      emit(c, "tool_end", { tool: read ? t.read : t.search, category: read ? "read" : "search" });
      yield sleep(700);
    }
    emit(c, "reply", { tokens: 900 });
    yield sleep(600);
    emit(c, "subagent_end", { role });
  }

  /** `$ pnpm test` fails at world ms `failAt`: test_fail is the table flip. */
  flip(name: string, failAt: number, runFor = 1_900) {
    const h = this.hands.get(name)!;
    const c = h.c;
    const t = c.tools.tools.bash;
    const cmd = c.me.project.test;
    this.at(failAt - runFor - 120, function* (this: World) {
      this.hold(h.id, failAt + 7_000);
      emit(c, "tool_start", { tool: t, category: "bash", summary: cmd, tokens: 400 });
      yield sleep(runFor);
      emit(c, "tool_end", { tool: t, category: "bash", summary: cmd, isError: true });
      yield sleep(120);
      emit(c, "test_fail", { tool: t, category: "bash", summary: cmd });
    }.bind(this));
  }

  /** Green again: tests pass (a cheer). */
  pass(name: string, at: number, runFor = 1_400) {
    const h = this.hands.get(name)!;
    const c = h.c;
    const t = c.tools.tools.bash;
    const cmd = c.me.project.test;
    this.at(at - runFor - 120, function* (this: World) {
      this.hold(h.id, at + 3_000);
      emit(c, "tool_start", { tool: t, category: "bash", summary: cmd, tokens: 400 });
      yield sleep(runFor);
      emit(c, "tool_end", { tool: t, category: "bash", summary: cmd });
      yield sleep(120);
      emit(c, "test_pass", { tool: t, category: "bash", summary: cmd });
    }.bind(this));
  }

  /** The turn is over: a reply, then the hand goes up ("needs you"). */
  waiting(name: string, at: number, holdFor = 20_000) {
    const h = this.hands.get(name)!;
    this.at(at, function* (this: World) {
      this.hold(h.id, at + holdFor);
      emit(h.c, "reply", { tokens: 1800 });
      yield sleep(500);
      emit(h.c, "waiting");
    }.bind(this));
  }

  /** Back to work after a beat: thinking, then the loop takes over when the hold runs out. */
  resume(name: string, at: number) {
    const h = this.hands.get(name)!;
    this.at(at, function* (this: World) {
      this.holds.set(h.id, at);
      emit(h.c, "prompt");
      yield sleep(800);
      emit(h.c, "thinking", { tokens: 2400 });
    }.bind(this));
  }

  /** office_shout, as the agent-visualizer MCP server delivers it. */
  shout(name: string, at: number, text: string) {
    const h = this.hands.get(name)!;
    this.at(at, function* () {
      emit(h.c, "shout", { summary: text });
    });
  }

  /** office_celebrate: confetti at the desk. */
  celebrate(name: string, at: number) {
    const h = this.hands.get(name)!;
    this.at(at, function* () {
      emit(h.c, "celebrate");
    });
  }

  /** office_flip: the agent flips its own table, in its own words. */
  selfFlip(name: string, at: number, why: string) {
    const h = this.hands.get(name)!;
    this.at(at, function* (this: World) {
      this.hold(h.id, at + 7_000);
      this.office.lastFlip = this.sim.now;
      emit(h.c, "flip", { summary: why });
    }.bind(this));
  }

  status(name: string, at: number, mood: readonly [string, string]) {
    const h = this.hands.get(name)!;
    this.at(at, function* () {
      emit(h.c, "status", { tool: mood[0], summary: mood[1] });
    });
  }
}
