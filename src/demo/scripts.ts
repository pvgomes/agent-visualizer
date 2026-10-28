/*
 * How a demo worker spends its day. A session loops through turns with the
 * rhythm of a real one: prompt, thinking, a burst of reads and searches,
 * edits, a test run that sometimes fails (table flip), a fix, a reply, then
 * a wait for the human. Claude sessions sometimes hand work to interns that
 * walk in, poke around and leave. Now and then an agent uses the office MCP
 * tools the way a real one would: a status line at the start of a turn, a
 * shout and confetti after a hard-won green run, rarely a flip of its own.
 */
import type { AgentKind, EventKind, Host, RawEvent, ToolCategory } from "../shared/events.ts";
import { ERRORS, FLIP_REASONS, INTERN_ROLES, MCP_CALLS, MODELS, MOODS, SHOUTS, type Project, type Toolset } from "./cast.ts";
import type { Rng } from "./rng.ts";
import { sleep, type Handle, type Script, type Sim } from "./sim.ts";

export interface Persona {
  workerId: string;
  agent: AgentKind;
  project: Project;
  model: string;
  cwd: string;
  parentId?: string;
  role?: string;
  /** Set for workers in a sandbox: events carry it, ids are prefixed with it, like real remote ones. */
  host?: Host;
}

export interface Ctx {
  sim: Sim;
  rng: Rng;
  me: Persona;
  tools: Toolset;
  /** Virtual ms -> ISO timestamp. */
  stamp: (virtualMs: number) => string;
  out: (e: RawEvent) => void;
  /** Shared by the whole office: when a table last flipped, and windows kept clear for scripted flips. */
  office: { lastFlip: number; quiet: [number, number][] };
}

/** Can a random flip happen now without stepping on another one? */
function flipAllowed(c: Ctx): boolean {
  const t = c.sim.now;
  return t - c.office.lastFlip >= 8_000 && !c.office.quiet.some(([a, b]) => t >= a && t <= b);
}

type Extra = Partial<Pick<RawEvent, "tool" | "category" | "summary" | "isError" | "tokens" | "role">>;

export function emit(c: Ctx, kind: EventKind, extra: Extra = {}): void {
  const m = c.me;
  const e: RawEvent = {
    ts: c.stamp(c.sim.now),
    agent: m.agent,
    workerId: m.workerId,
    project: m.project.name,
    cwd: m.cwd,
    model: m.model,
    kind,
    ...extra,
  };
  if (m.parentId) e.parentId = m.parentId;
  if (m.role) e.role = m.role;
  if (m.host) e.host = m.host;
  c.out(e);
}

/* MCP signals, as the agent-visualizer MCP server would deliver them. */

export const status = (c: Ctx, [emoji, text]: readonly [string, string]) => emit(c, "status", { tool: emoji, summary: text });
export const shout = (c: Ctx, text: string) => emit(c, "shout", { summary: text });
export const celebrate = (c: Ctx) => emit(c, "celebrate");
export const flipOwnTable = (c: Ctx, why: string) => {
  c.office.lastFlip = c.sim.now;
  emit(c, "flip", { summary: why });
};

const ms = (c: Ctx, min: number, max: number) => Math.round(c.rng.range(min, max));

function* think(c: Ctx, min = 2000, max = 5000): Script {
  emit(c, "thinking", { tokens: c.rng.int(900, 7200) });
  yield sleep(ms(c, min, max));
}

function* tool(
  c: Ctx,
  category: ToolCategory,
  name: string,
  summary: string,
  dur: [number, number],
  isError = false,
): Script {
  emit(c, "tool_start", { tool: name, category, summary, tokens: c.rng.int(180, 2400) });
  yield sleep(ms(c, dur[0], dur[1]));
  emit(c, "tool_end", isError ? { tool: name, category, summary, isError } : { tool: name, category, summary });
  yield sleep(ms(c, 800, 2300));
}

const read = (c: Ctx, file = c.rng.pick(c.me.project.files)) =>
  tool(c, "read", c.tools.tools.read, `Read ${file}`, [700, 2000]);

function* search(c: Ctx): Script {
  const glob = c.rng.chance(0.5);
  yield* tool(
    c,
    "search",
    glob ? c.tools.tools.glob : c.tools.tools.search,
    `Search ${c.rng.pick(c.me.project.globs)}`,
    [800, 2200],
  );
}

const edit = (c: Ctx, file = c.rng.pick(c.me.project.files)) =>
  tool(c, "edit", c.tools.tools.edit, `Edit ${file}`, [1000, 2600]);

const create = (c: Ctx) =>
  tool(c, "edit", c.tools.tools.write, `Write ${c.rng.pick(c.me.project.newFiles)}`, [1100, 2400]);

const bash = (c: Ctx, cmd = c.rng.pick(c.me.project.bash)) =>
  tool(c, "bash", c.tools.tools.bash, cmd, [1400, 3800]);

const web = (c: Ctx) =>
  tool(c, "web", c.rng.pick(c.tools.web), c.rng.pick(c.me.project.docs), [1600, 3800]);

const todo = (c: Ctx) => tool(c, "todo", c.tools.tools.todo, c.tools.todoSummary, [300, 700]);

function* mcp(c: Ctx): Script {
  const [server, name] = c.rng.pick(MCP_CALLS);
  yield* tool(c, "mcp", `mcp__${server}__${name}`, `${server}.${name}`, [900, 2600]);
}

/** Run the project's tests; failing ends in test_fail, the table flip (unless another table is mid-air). */
function* test(c: Ctx, fail: boolean, dur = ms(c, 2600, 5200), scripted = false): Script {
  const { test: cmd } = c.me.project;
  const name = c.tools.tools.bash;
  emit(c, "tool_start", { tool: name, category: "bash", summary: cmd, tokens: c.rng.int(200, 900) });
  yield sleep(dur);
  if (fail && !scripted && !flipAllowed(c)) fail = false;
  if (fail) c.office.lastFlip = c.sim.now;
  emit(c, "tool_end", fail ? { tool: name, category: "bash", summary: cmd, isError: true } : { tool: name, category: "bash", summary: cmd });
  yield sleep(ms(c, 80, 200));
  emit(c, fail ? "test_fail" : "test_pass", { tool: name, category: "bash", summary: cmd });
  // Give the flip (or the celebration) room to play before the next move.
  yield sleep(fail ? ms(c, 3200, 4600) : ms(c, 1400, 2400));
}

/** Tests until green: ~1 in 4 runs fail first, and a stubborn bug sometimes fails twice. */
function* testUntilGreen(c: Ctx, firstFails = c.rng.chance(0.25), firstDur?: number): Script {
  let fail = firstFails;
  for (let round = 0; ; round++) {
    const before = c.office.lastFlip;
    yield* test(c, fail, round === 0 ? firstDur : undefined);
    // test() may have let it pass to keep the floor to one flip at a time.
    if (!fail || c.office.lastFlip === before) return;
    yield* think(c, 1800, 4200);
    yield* read(c, c.rng.pick(c.me.project.testFiles));
    if (c.rng.chance(0.4)) yield* search(c);
    yield* edit(c);
    fail = round === 0 && c.rng.chance(0.15);
  }
}

function* explore(c: Ctx, n: number): Script {
  for (let i = 0; i < n; i++) {
    if (c.rng.chance(0.6)) yield* read(c);
    else yield* search(c);
    if (i < n - 1 && c.rng.chance(0.25)) yield* think(c, 900, 2200);
  }
}

/** Codex names its subagents' roles itself. */
const CODEX_ROLES: readonly (readonly [string, number])[] = [["explorer", 3], ["worker", 2]];

/** A Claude or Codex session hands work to 1-3 subagents and waits for them all. */
function* interns(c: Ctx, count = c.rng.weighted([[1, 5], [2, 4], [3, 2]] as const)): Script {
  const handles: Handle[] = [];
  const codex = c.me.agent === "codex";
  for (let i = 0; i < count; i++) {
    const role = c.rng.weighted(codex ? CODEX_ROLES : INTERN_ROLES);
    const summary = codex ? "Spawn agent" : `Spawn ${role}`;
    emit(c, "tool_start", { tool: c.tools.tools.agent, category: "agent", summary, tokens: c.rng.int(300, 1400) });
    const me: Persona = {
      workerId: `${c.me.host ? `${c.me.host.id}/` : ""}agent-${c.rng.hex(12)}`,
      agent: c.me.agent,
      project: c.me.project,
      model: role === "general-purpose" || codex ? c.me.model : MODELS.claude[1] ?? c.me.model,
      cwd: c.me.cwd,
      parentId: c.me.workerId,
      role,
      host: c.me.host,
    };
    const ic: Ctx = { ...c, rng: c.rng.fork(), me };
    handles.push(c.sim.spawn(intern(ic, () => emit(c, "tool_end", { tool: c.tools.tools.agent, category: "agent", summary })), ms(c, 300, 900)));
    yield sleep(ms(c, 250, 700));
  }
  yield { join: handles };
  yield sleep(ms(c, 600, 1400));
}

function* intern(c: Ctx, done: () => void): Script {
  emit(c, "subagent_start", { role: c.me.role });
  // The walk from the elevator to a spare desk.
  yield sleep(ms(c, 2200, 3400));
  yield* think(c, 900, 2000);
  const role = c.me.role;
  const n = role === "Explore" || role === "explorer" ? c.rng.int(3, 6) : c.rng.int(2, 4);
  yield* explore(c, n);
  if (role === "general-purpose" || role === "worker") {
    yield* think(c, 900, 2000);
    for (let i = c.rng.int(1, 2); i > 0; i--) yield* edit(c);
    if (c.rng.chance(0.5)) yield* bash(c);
  } else if (role === "Plan") {
    yield* think(c, 1600, 3200);
  }
  emit(c, "reply", { tokens: c.rng.int(600, 2600) });
  yield sleep(ms(c, 500, 1000));
  emit(c, "subagent_end", { role });
  done();
}

/** One prompt -> reply cycle. */
function* turn(c: Ctx, opening?: "interns"): Script {
  const { rng } = c;
  const claude = c.me.agent === "claude" && !c.me.parentId;
  const delegates = (c.me.agent === "claude" || c.me.agent === "codex") && !c.me.parentId;
  emit(c, "prompt");
  yield sleep(ms(c, 500, 1200));
  if (!c.me.parentId && rng.chance(0.22)) {
    status(c, rng.pick(MOODS));
    yield sleep(ms(c, 300, 800));
  }
  yield* think(c);
  if (rng.chance(0.28)) yield* todo(c);
  if (opening === "interns" && delegates) yield* interns(c, 2);
  yield* explore(c, rng.int(2, 4));
  if (!opening && claude && rng.chance(0.35)) yield* interns(c);
  if (rng.chance(0.2)) yield* web(c);
  if (rng.chance(0.12)) yield* mcp(c);
  yield* think(c);
  if (rng.chance(0.18)) yield* create(c);
  for (let i = rng.int(1, 4); i > 0; i--) yield* edit(c);
  if (rng.chance(0.4)) yield* bash(c);
  if (rng.chance(0.04)) {
    emit(c, "error", { summary: rng.pick(ERRORS), isError: true });
    yield sleep(ms(c, 2500, 4500));
    yield* think(c);
  }
  const stubborn = rng.chance(0.03) && flipAllowed(c);
  if (stubborn) {
    // Fed up before even running the suite: the agent flips its own table.
    flipOwnTable(c, rng.pick(FLIP_REASONS));
    yield sleep(ms(c, 4200, 5200));
  }
  yield* testUntilGreen(c);
  if (!c.me.parentId && rng.chance(stubborn ? 0.8 : 0.07)) {
    shout(c, rng.pick(SHOUTS));
    yield sleep(ms(c, 400, 900));
    celebrate(c);
    yield sleep(ms(c, 1800, 2600));
  }
  if (rng.chance(0.3)) yield* bash(c, "$ git diff");
  emit(c, "reply", { tokens: rng.int(500, 3200) });
  yield sleep(ms(c, 500, 1000));
  emit(c, "waiting");
}

/** The scripted first turn of the first worker: a failing test (table flip) at ~13s, whatever the seed. */
function* heroTurn(c: Ctx): Script {
  const { files, testFiles, globs } = c.me.project;
  const t = c.tools.tools;
  function* step(category: ToolCategory, name: string, summary: string, dur: number, gap: number): Script {
    emit(c, "tool_start", { tool: name, category, summary, tokens: 900 });
    yield sleep(dur);
    emit(c, "tool_end", { tool: name, category, summary });
    yield sleep(gap);
  }
  emit(c, "prompt");
  yield sleep(800);
  emit(c, "thinking", { tokens: 4200 });
  yield sleep(1600);
  yield* step("read", t.read, `Read ${files[0]}`, 900, 600);
  yield* step("search", t.glob, `Search ${globs[0]}`, 800, 600);
  emit(c, "thinking", { tokens: 2600 });
  yield sleep(1400);
  yield* step("edit", t.edit, `Edit ${files[0]}`, 1100, 500);
  yield* step("edit", t.edit, `Edit ${files[1]}`, 900, 600);
  yield* test(c, true, 3000, true);
  emit(c, "thinking", { tokens: 3100 });
  yield sleep(2400);
  yield* step("read", t.read, `Read ${testFiles[0]}`, 1000, 700);
  yield* step("edit", t.edit, `Edit ${files[0]}`, 1300, 800);
  yield* test(c, false);
  // Green after the flip: tell the whole office.
  shout(c, SHOUTS[0]!);
  yield sleep(600);
  celebrate(c);
  yield sleep(2200);
  emit(c, "reply", { tokens: 1800 });
  yield sleep(700);
  emit(c, "waiting");
}

export interface SessionPlan {
  /** Turns before leaving the office; Infinity stays forever. */
  lifetime: number;
  /** Quiet time before the first prompt. */
  startDelay: number;
  opening?: "hero" | "interns";
}

export function* session(c: Ctx, plan: SessionPlan): Script {
  // A real transcript starts with the first prompt, so a new worker settles
  // in quietly rather than opening on "needs you".
  emit(c, "session_start");
  yield sleep(plan.startDelay);
  for (let turns = 0; turns < plan.lifetime; ) {
    if (turns === 0 && plan.opening === "hero") yield* heroTurn(c);
    else yield* turn(c, turns === 0 && plan.opening === "interns" ? "interns" : undefined);
    turns++;
    if (turns >= plan.lifetime) break;
    // The human reads the reply and types the next prompt (quickly: a demo office is a busy one);
    // now and then they go for coffee (idle).
    yield sleep(c.rng.chance(0.05) ? ms(c, 60_000, 90_000) : ms(c, 4_000, 12_000));
  }
  yield sleep(ms(c, 3000, 6000));
  emit(c, "session_end");
}
