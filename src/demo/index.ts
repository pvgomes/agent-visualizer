/*
 * `agent-visualizer --demo`: a scripted office that never runs out of work, for
 * recordings and for anyone with no agents running. It opens on the
 * arrivals: eight Claude Code and Cursor workers walk in from the elevator
 * over the first eight seconds while five more beam into the cloud wing (two
 * in the devops Vercel Sandbox, one each in the ai-agents and website ones,
 * and one in the incidents-check Railway sandbox), and after that people come and go every few minutes. The opening
 * is scripted on every seed: a status line at ~3s, the first table flip at
 * ~14s, then a shout and confetti when that worker goes green, and a
 * sandboxed agent flipping its own table through the office MCP tools at
 * ~38s; random flips keep their distance from those and from each other. The
 * whole thing is a pure function of the seed, so a recording can be replayed
 * exactly; the real-time driver only decides when to look, and the server
 * starts it over for each new viewer (src/cli.ts).
 */
import type { AgentKind, RawEvent } from "../shared/events.ts";
import { DEMO_HOSTS, FLIP_REASONS, MODELS, MOODS, OPENING_CAST, PROJECTS, REMOTE_CAST, TOOLSETS, type Seat } from "./cast.ts";
import { Rng } from "./rng.ts";
import { flipOwnTable, session, status, type Ctx, type SessionPlan } from "./scripts.ts";
import { Sim, sleep, type Handle, type Script } from "./sim.ts";

export const DEFAULT_SEED = 7;
const ALL_AGENTS: AgentKind[] = ["claude", "commandcode", "codex", "opencode", "droid", "gemini", "qwen", "cursor"];
/** Who works in the demo unless --agents asks for others. */
const DEMO_AGENTS: AgentKind[] = ["claude", "cursor"];
/** Local desks the director tries to keep filled. */
const TARGET_WORKERS = 8;
/** When the scripted MCP flip lands; random flips stay clear of it. */
const OWN_FLIP_AT = 38_000;
/** Real-time lag beyond which the driver skips ahead instead of replaying a burst. */
const MAX_LAG_MS = 3_000;

export interface DemoOptions {
  onEvent: (e: RawEvent) => void;
  seed?: number;
  /** Restrict the cast to these agents (others are recast). */
  agents?: AgentKind[];
  /** Wall clock, epoch ms. */
  now?: () => number;
  /** Playback speed; 2 runs the office twice as fast. */
  speed?: number;
}

export interface Demo {
  sim: Sim;
  /** Advance virtual time by ms, emitting everything due (for tests and tools). */
  advance(ms: number): void;
}

/** Build the office without timers. startDemo drives it in real time. */
export function createDemo(opts: DemoOptions & { stamp?: (virtualMs: number) => string }): Demo {
  const seed = opts.seed ?? DEFAULT_SEED;
  const rng = new Rng(seed);
  const sim = new Sim();
  const agents = opts.agents?.length ? ALL_AGENTS.filter((a) => opts.agents!.includes(a)) : DEMO_AGENTS;
  const t0 = (opts.now ?? Date.now)();
  const stamp = opts.stamp ?? ((v: number) => new Date(t0 + v).toISOString());

  const active: { handle: Handle; project: string; agent: AgentKind; host?: string }[] = [];
  let seatIndex = 0;
  // One table flip at a time: nothing random within 8s of another, nor around the scripted ones.
  const office = { lastFlip: Number.NEGATIVE_INFINITY, quiet: [[0, 24_000], [OWN_FLIP_AT - 8_000, OWN_FLIP_AT + 8_000]] as [number, number][] };

  const hire = (seat: Seat, plan: SessionPlan, delay = 0): Ctx => {
    const agent = agents.includes(seat.agent) ? seat.agent : agents[seatIndex++ % agents.length]!;
    const models = MODELS[agent];
    const project = PROJECTS[seat.project]!;
    const own = rng.fork();
    const box = seat.host ? DEMO_HOSTS[seat.host] : undefined;
    const id = own.uuid();
    const c: Ctx = {
      sim,
      rng: own,
      me: {
        workerId: box ? `${box.host.id}/${id}` : id,
        agent,
        project,
        model: models[seat.model % models.length]!,
        cwd: box ? `${box.home}/${project.name}` : `~/${rng.pick(["code", "code", "work", "src"])}/${project.name}`,
        ...(box ? { host: box.host } : {}),
      },
      tools: TOOLSETS[agent],
      stamp,
      out: opts.onEvent,
      office,
    };
    active.push({ handle: sim.spawn(session(c, plan), delay), project: project.name, agent, host: seat.host });
    return c;
  };

  /** A project nobody is on (any project if every one is taken). */
  const freeProject = (): string => {
    const busy = new Set(active.map((a) => a.project));
    const free = Object.keys(PROJECTS).filter((p) => !busy.has(p));
    return rng.pick(free.length ? free : Object.keys(PROJECTS));
  };

  /** The scripted opening beats that come through the office MCP server. */
  function* beats(hero: Ctx, cloud: Ctx[]): Script {
    yield sleep(2_800);
    status(hero, MOODS[0]!); // "🧠 deep in the auth refactor", then it flips at ~13s
    yield sleep(4_400);
    status(cloud[0]!, MOODS[1]!);
    yield sleep(14_000);
    status(cloud[4]!, MOODS[7]!);
    yield sleep(OWN_FLIP_AT - sim.now);
    // ~38s: the Railway agent loses it, through MCP, no failing test needed.
    flipOwnTable(cloud[3]!, FLIP_REASONS[0]!);
    yield sleep(6_000);
    status(cloud[3]!, MOODS[6]!);
  }

  function* director(): Script {
    let hero: Ctx | undefined;
    // The arrivals are the hook of any recording: the elevator dings once a second or so and
    // everyone walks to a desk, the hero first so it is seated well before its flip.
    OPENING_CAST.forEach((seat, i) => {
      const c = hire(
        seat,
        {
          lifetime: seat.opening === "hero" ? Infinity : rng.int(5, 12),
          startDelay: seat.opening === "hero" ? 400 : seat.opening === "interns" ? 3_200 : rng.int(2_500, 5_000),
          opening: seat.opening,
        },
        i === 0 ? 500 : 600 + i * 1_050,
      );
      if (seat.opening === "hero") hero = c;
    });
    // Sandboxes beam in meanwhile, and live longer than a laptop session.
    const cloud = REMOTE_CAST.map((seat, i) => hire(seat, { lifetime: rng.int(10, 18), startDelay: rng.int(1_500, 3_000) }, 1_100 + i * 1_000));
    sim.spawn(beats(hero!, cloud));
    yield sleep(12_000);

    let nextArrival: number | undefined;
    for (;;) {
      yield sleep(4_000);
      for (let i = active.length - 1; i >= 0; i--) {
        const a = active[i]!;
        if (!a.handle.done) continue;
        active.splice(i, 1);
        // A sandbox that finishes its job picks up another after a breather.
        if (a.host) {
          hire({ project: freeProject(), agent: rng.pick(agents), model: rng.int(0, 2), host: a.host }, { lifetime: rng.int(8, 14), startDelay: rng.int(3_000, 6_000) }, rng.int(8_000, 20_000));
        }
      }
      const local = active.filter((a) => !a.host);
      if (local.length >= TARGET_WORKERS) {
        nextArrival = undefined;
        continue;
      }
      // A thin office refills fast; otherwise leave the empty desk a moment.
      nextArrival ??= sim.now + (local.length < 6 ? rng.int(3_000, 8_000) : rng.int(12_000, 30_000));
      if (sim.now < nextArrival) continue;
      nextArrival = undefined;
      // The agent with the fewest local desks gets the new hire.
      const counts = agents.map((a) => local.filter((w) => w.agent === a).length);
      const agent = agents[counts.indexOf(Math.min(...counts))]!;
      hire(
        { project: freeProject(), agent, model: rng.int(0, 2) },
        { lifetime: rng.int(5, 12), startDelay: rng.int(3_000, 6_000) },
      );
    }
  }

  sim.spawn(director());
  return {
    sim,
    advance(ms: number) {
      sim.runUntil(sim.now + ms);
    },
  };
}

export interface RunningDemo {
  stop(): void;
  /** Start over from virtual 0 (a fresh viewer gets the whole opening). */
  restart(): void;
}

/** Run the demo office in real time until stop(). `paused`: nothing happens until the first restart(). */
export function startDemo(opts: DemoOptions & { paused?: boolean }): RunningDemo {
  const now = opts.now ?? Date.now;
  const speed = opts.speed && opts.speed > 0 ? opts.speed : 1;
  let base = now(); // wall clock at virtual 0
  let demo: Demo | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const pump = () => {
    if (stopped || !demo) return;
    const { sim } = demo;
    let v = (now() - base) * speed;
    const due = sim.nextDue();
    // After a laptop sleep, skip the gap rather than replaying minutes of work at once.
    if (due !== undefined && v - due > MAX_LAG_MS * speed) {
      base += (v - due) / speed;
      v = due;
    }
    sim.runUntil(v);
    const next = sim.nextDue();
    if (next === undefined) return;
    timer = setTimeout(pump, Math.max(0, next / speed - (now() - base)));
  };
  const begin = () => {
    if (timer) clearTimeout(timer);
    base = now();
    demo = createDemo({ ...opts, now, stamp: (v) => new Date(base + v / speed).toISOString() });
    pump();
  };
  if (!opts.paused) begin();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    restart() {
      if (!stopped) begin();
    },
  };
}
