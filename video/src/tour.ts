/*
 * The product tour, cut for understanding: the problem (a wall of terminals),
 * the answer (one command, every agent walks in), then the centrepiece, step
 * by step: hire Command Code into a new Daytona sandbox from the page, watch
 * it walk into the cloud-room, send it a prompt, and in chat mode approve a
 * command with one key and read the diff. Then a short "and also" montage,
 * the three steps to use it, and the end card. Every step is on screen (the
 * band's step chips) while it happens; the cursor moves at a person's pace
 * and the part of the page in use is lit, the rest dimmed.
 *
 * Honest about this branch: chat mode in a sandbox is Claude Code and Codex
 * on Railway or ssh, so the Command Code hired into Daytona is driven in its
 * terminal, and the approval and the diff are on another Command Code, on
 * this Mac, in chat mode (over ACP), and the band says so. Your setup for
 * Command Code is its keys and the project.
 */
import type { Cut, Engine, Shot, View } from "./stage.ts";
import type { Feature } from "./band.ts";
import { TV, tourScript2 } from "./script.ts";
import { INK, clamp, dropIn, ease, lerp, px, ramp, textW } from "./type.ts";
import { boot, command, flip, hook, inside, interns, mixView } from "./shots.ts";
import { endCard, night, plate, vignette } from "./titles.ts";
import { all, flow, frame, withText, type Target } from "./flow.ts";
import { $, keycap, type UiView } from "./uishots.ts";
import { toolSummary } from "../../src/ingest/redact.ts";
import type { AgentKind } from "../../src/shared/events.ts";

const LINEUP: AgentKind[] = ["commandcode", "claude", "codex", "opencode", "cursor", "droid", "qwen", "gemini"];
const tall = (e: Engine) => e.H > e.W * 1.2;
const unit = (e: Engine) => Math.min(e.W, e.H) / 1080;
const sticky = (key: string, cam: (e: Engine) => UiView | null) => (e: Engine): UiView | null => {
  const v = cam(e);
  if (v) e.mem[key] = v;
  return v ?? ((e.mem[key] as UiView | undefined) ?? null);
};

/* ------------------------------------------------------------ the features */

const HIRE_STEPS = ["Pick Command Code", "Daytona, new sandbox", "Your setup", "Hire"];
const HIRE_STEPS_SHORT = ["Pick Command Code", "Daytona, new sandbox", "Hire"];
const hireF = (step: number, steps = HIRE_STEPS): Feature => ({ title: "Hire an agent into a sandbox.", line: "", steps, step, accent: INK.cyan });
const DRIVE_STEPS = ["Send a prompt", "Watch it work"];
const driveF = (step: number): Feature => ({ title: "Drive it from the browser.", line: "", steps: DRIVE_STEPS, step, accent: "#f2f2f2" });
const CHAT_STEPS = ["Open its chat", "Read the full command", "Press 1 to allow"];
const chatF = (step: number): Feature => ({ title: "In chat mode, approve with one key.", line: "", steps: CHAT_STEPS, step, accent: INK.green });

export const F: Record<string, Feature> = {
  one: { title: "One command.", line: "Run ‹npx @pvgomes/agent-visualizer› and every agent you already use walks in.", accent: INK.cyan, logos: LINEUP },
  lapse: { title: "The sandbox spins up.", line: "Daytona creates it, the office installs Command Code and copies your setup.", accent: INK.cyan, tag: "" },
  beam: { title: "It walks into the cloud-room.", line: "A desk at the meeting room, next to your other sandboxes.", accent: INK.cyan, logos: ["daytona", "vercel", "railway"] },
  diff: { title: "See every change.", line: "The work log keeps each tool call, with the diff of every edit.", accent: INK.violet },
  interns: { title: "Subagents walk in as interns.", line: "The boss leans back: ‹supervising 3 interns›.", accent: INK.violet },
  needs: { title: "Never miss a waiting agent.", line: "A raised hand, and the ‹needs you› button takes you straight there.", accent: INK.amber },
  flip: { title: "Failing test? Table flipped.", line: "‹(╯°□°)╯︵ ┻━┻› the moment a test command fails.", accent: INK.red },
  mcp: { title: "Agents talk back, over MCP.", line: "‹office_shout› puts a message on the TV; ‹office_celebrate›, confetti.", accent: INK.claude },
  privacy: { title: "Private by default.", line: "Labels, not content. Your transcripts never leave your machine.", accent: INK.green },
};

const withF = (shot: Shot, f: Feature, extra: Partial<Shot> = {}): Shot => ({ ...shot, feature: f, ...extra });
const lapseTag = (x: number) => `×${x} · a new sandbox takes about a minute`;

/* ------------------------------------------------------------ the opening */

/** The command, typed; Enter shows as a key cap */
function commandShot(dur: number, o: { typeAt: number; enterAt: number }): Shot {
  const base = command(dur, o);
  return {
    ...base,
    draw(e, g, lt) {
      base.draw!(e, g, lt);
      const s = Math.round(7 * unit(e));
      keycap(g, "Enter", "", e.W / 2, e.H / 2 + 16 * s, s, lt, o.enterAt, "center", 0.6);
    },
  };
}

/** "And also": a beat between the centrepiece and the montage. */
function andAlso(dur: number): Shot {
  return {
    name: "and-also",
    dur,
    enter(e) {
      e.cue("whoosh", { dur: 0.4, soft: true });
    },
    draw(e, g, lt) {
      night(g, e.W, e.H);
      let s = Math.round((tall(e) ? 13 : 15) * unit(e));
      while (s > 4 && textW("And also…", s) > e.W * 0.86) s--;
      dropIn(g, "And also…", e.W / 2, Math.round(e.H / 2 - 4 * s), s, lt - 0.05, { color: INK.white, align: "center", stagger: 0.03, dur: 0.25, depth: 1 });
      vignette(g, e.W, e.H, 0.45);
    },
  };
}

/* ------------------------------------------------------------ office beats */

/** The cloud-room, wide; the new worker walks in; the camera eases in on its desk and holds. */
function beamIn(dur: number, at: (e: Engine) => number, closeAt = 1.4): Shot {
  return {
    name: "beam-in",
    dur,
    at,
    office: true,
    feature: F.beam,
    enter(e) {
      e.cue("beam", { pitch: 0 });
    },
    update(e, lt) {
      const w = e.findWorker((x) => x.host?.kind === "daytona" && x.agent === "commandcode" && !x.intern);
      const pods = e.cloudPods();
      // the whole cloud-room, followed as its desks settle, then in on the new desk
      const want: View = pods ? e.fit({ x: pods.x - 8, y: pods.y - 4, w: pods.w + 16, h: pods.h + 8 }, 8) : e.fit(e.geo().room);
      const wide = (e.s.wide as View | undefined) ?? (e.s.wide = { ...want });
      const k = 1 - Math.exp(-(1 / e.fps) * 3);
      wide.x += (want.x - wide.x) * k;
      wide.y += (want.y - wide.y) * k;
      wide.z = Math.exp(Math.log(wide.z) + (Math.log(want.z) - Math.log(wide.z)) * k);
      const close: View = w ? { x: w.deskX + 18, y: w.deskY + 8, z: tall(e) ? 6 : 6 } : wide;
      e.view(inside(e, mixView(wide, close, ease.inOutCubic(ramp(lt, closeAt, closeAt + 1.6)))));
    },
    draw(e, g) {
      vignette(g, e.W, e.H, 0.3);
    },
  };
}

/** Over MCP: Command Code shouts on the TV, then asks for confetti at its desk. */
function mcpShot(dur: number): Shot {
  return {
    name: "mcp",
    dur,
    at: TV.mcp - 500,
    office: true,
    feature: F.mcp,
    update(e, lt) {
      const { plan } = e.geo();
      const cc = e.seat("cc");
      const z = tall(e) ? 5 : 5;
      const tv: View = { x: plan.tv.x + plan.tv.w / 2, y: plan.tv.y + plan.tv.h / 2 + 14, z: z + 1 };
      const desk: View = { x: cc.deskX + 18, y: cc.deskY + 4, z: z + 1 };
      e.view(inside(e, mixView(tv, desk, ease.inOutCubic(ramp(lt, 1.6, 2.8)))));
    },
    draw(e, g) {
      vignette(g, e.W, e.H, 0.3);
    },
  };
}

/* ------------------------------------------------------------ kept */

/** "Every coding agent. / One office." over the whole floor, on a solid plate. */
function positioning(dur: number): Shot {
  return {
    name: "positioning",
    dur,
    office: true,
    update(e, lt) {
      const { room } = e.geo();
      const v = e.fit(room, 8);
      e.view({ ...v, z: v.z * lerp(1.0, 1.05, ease.inOutCubic(lt / dur)) });
      if (Math.abs(lt - 0.15) < 0.5 / e.fps) e.cue("thud", { vol: 0.5 });
    },
    draw(e, g, lt) {
      g.fillStyle = `rgba(6,5,11,${0.62 * ease.outCubic(ramp(lt, 0, 0.3))})`;
      g.fillRect(0, 0, e.W, e.H);
      const u = unit(e);
      let s = Math.round((tall(e) ? 15 : 17) * u);
      while (s > 4 && textW("Every coding agent.", s) > e.W * 0.88) s--;
      const y = Math.round(e.H / 2 - 10 * s);
      dropIn(g, "Every coding agent.", e.W / 2, y, s, lt - 0.1, { color: INK.white, align: "center", stagger: 0.02, dur: 0.22, depth: 1 });
      dropIn(g, "One office.", e.W / 2, y + 11 * s, s, lt - 0.55, { color: INK.claude, align: "center", stagger: 0.03, dur: 0.25, depth: 1 });
      vignette(g, e.W, e.H, 0.45);
    },
  };
}

/** What a transcript line holds, and the label the office shows: the real redaction (src/ingest/redact.ts). */
function privacyShot(dur: number): Shot {
  const raw = { file_path: "/Users/you/code/api-gateway/src/auth.ts", new_string: 'const key = "sk-live-4f9c2a71"' };
  // the parser pulls the file out of the call; the label is the office's own redaction of it
  const label = toolSummary("Edit", "edit", { file: raw.file_path });
  return {
    name: "privacy",
    dur,
    at: TV.privacy,
    office: true,
    feature: F.privacy,
    update(e, lt) {
      const s = e.seat("hero");
      const z = tall(e) ? 7 : 8;
      const off = tall(e) ? 0 : (e.W * 0.2) / z;
      const a: View = { x: s.deskX + 18 - off, y: s.deskY + 12, z };
      e.view(inside(e, { ...a, x: a.x + lerp(3, -3, ease.inOutCubic(lt / dur)) }));
    },
    draw(e, g, lt) {
      vignette(g, e.W, e.H, 0.4);
      // the panel: the transcript line, its private parts struck out, then the label
      const u = unit(e);
      const s = Math.max(2, Math.round((tall(e) ? 5 : 6) * u));
      const lines = [
        ['{"name":"Edit","input":{"file_path":"', "q"],
        ["/Users/you/code/api-gateway/src/", "cut"],
        ["auth.ts", "keep"],
        ['","new_string":"', "q"],
        ['const key = \\"sk-live-4f9c2a71\\"', "cut"],
        ['"}}', "q"],
      ] as const;
      const pw = tall(e) ? e.W - 2 * 48 : Math.round(e.W * 0.5);
      const x0 = tall(e) ? 48 : Math.round(e.W * 0.05);
      const y0 = tall(e) ? Math.round(e.regionH * 0.08) : Math.round(e.regionH * 0.12);
      const k = ease.outCubic(ramp(lt, 0.05, 0.35));
      const lh = 11 * s;
      // wrap the line's runs into the panel
      const rows: { t: string; kind: string }[][] = [[]];
      let w = 0;
      const maxW = pw - 12 * s;
      for (const [t, kind] of lines) {
        for (const ch of t) {
          const cw = textW(ch, s) + s;
          if (w + cw > maxW) {
            rows.push([]);
            w = 0;
          }
          const row = rows[rows.length - 1]!;
          const last = row[row.length - 1];
          if (last && last.kind === kind) last.t += ch;
          else row.push({ t: ch, kind });
          w += cw;
        }
      }
      const ph = (rows.length + 5) * lh + 10 * s;
      g.save();
      g.globalAlpha = k;
      plate(g, x0, y0, pw, ph, s, "rgba(9,8,16,0.95)", "rgba(126,246,255,0.35)");
      g.restore();
      px(g, "in the transcript", x0 + 6 * s, y0 + 4 * s, s, { color: INK.dim, shadow: null, alpha: k });
      const strike = ramp(lt, 0.9, 1.5);
      rows.forEach((row, ri) => {
        let x = x0 + 6 * s;
        const y = y0 + 4 * s + (ri + 1.5) * lh;
        for (const run of row) {
          const col = run.kind === "keep" ? INK.white : run.kind === "cut" ? (strike > 0 ? INK.red : "#c9c7d8") : "#6f6a86";
          const rw = px(g, run.t, x, y, s, { color: col, shadow: null, alpha: k * (run.kind === "cut" ? 1 - 0.55 * strike : 1) });
          if (run.kind === "cut" && strike > 0) {
            g.fillStyle = INK.red;
            g.globalAlpha = k;
            g.fillRect(x, y + 3 * s, Math.round(rw * strike), s);
            g.globalAlpha = 1;
          }
          x += rw + s;
        }
      });
      const yl = y0 + 4 * s + (rows.length + 2) * lh;
      const kl = ease.outBack(ramp(lt, 1.5, 1.85));
      px(g, "on the page", x0 + 6 * s, yl, s, { color: INK.dim, shadow: null, alpha: k * clamp(kl, 0, 1) });
      if (kl > 0) {
        const ls = s + 1;
        const lw = textW(label, ls);
        g.save();
        g.globalAlpha = clamp(kl, 0, 1);
        plate(g, x0 + 6 * s, yl + lh, lw + 8 * ls, 12 * ls, ls, "#14202a", INK.green);
        g.restore();
        px(g, label, x0 + 6 * s + 4 * ls, yl + lh + 2.5 * ls + Math.round((1 - kl) * 3) * ls, ls, { color: INK.white, shadow: null, alpha: clamp(kl, 0, 1) });
      }
    },
  };
}

/** Three steps, then the end card. */
function howTo(dur: number): Shot {
  const steps: [string, string, string][] = [
    ["1", "npx @pvgomes/agent-visualizer", INK.cyan],
    ["2", "Your agents walk in.", INK.white],
    ["3", "Hire and drive them from the page.", INK.white],
  ];
  return {
    name: "how-to",
    dur,
    // the pulse carries on under the steps, softer, so the end card's chord doesn't arrive out of silence
    bed: 0.55,
    enter(e) {
      e.cue("whoosh", { dur: 0.4, soft: true });
    },
    draw(e, g, lt) {
      night(g, e.W, e.H);
      const u = unit(e);
      const portrait = tall(e);
      let ts = Math.round((portrait ? 11 : 10) * u);
      px(g, "How to use it", e.W / 2, Math.round(e.H * (portrait ? 0.24 : 0.16)), ts, { align: "center", color: INK.claude, alpha: ease.outCubic(ramp(lt, 0, 0.3)) });
      let s = Math.round((portrait ? 6 : 7) * u);
      const longest = Math.max(...steps.map(([, t]) => textW(t, s)));
      while (s > 3 && longest + 22 * s > e.W * 0.9) s--;
      const blockW = textW(steps[2]![1], s) + 22 * s;
      const x0 = Math.round(e.W / 2 - blockW / 2);
      let y = Math.round(e.H * (portrait ? 0.36 : 0.38));
      steps.forEach(([n, t, col], i) => {
        const k = ease.outBack(ramp(lt, 0.25 + i * 0.35, 0.55 + i * 0.35));
        if (k <= 0) return;
        const a = clamp(k, 0, 1);
        const ns = Math.round(s * 1.6);
        g.save();
        g.globalAlpha = a;
        plate(g, x0, y + Math.round((1 - k) * 3) * s - 3 * s, 12 * s, 12 * s, s, "#151325", col === INK.cyan ? INK.cyan : INK.violet);
        g.restore();
        px(g, n, x0 + 6 * s, y + Math.round((1 - k) * 3) * s - 1 * s, ns, { align: "center", color: INK.white, alpha: a, shadow: null });
        px(g, t, x0 + 18 * s, y + Math.round((1 - k) * 3) * s, s, { color: col, alpha: a });
        y += Math.round(18 * s);
      });
      void ts;
      ts = 0;
      vignette(g, e.W, e.H, 0.45);
    },
  };
}

function endTour(dur: number): Shot {
  return {
    name: "end",
    dur,
    enter(e) {
      e.cue("chord", { dur });
    },
    draw(e, g, lt) {
      night(g, e.W, e.H);
      endCard(g, e.W, e.H, lt, unit(e), { tagline: "the harness you needed all along", agents: LINEUP, tagScale: tall(e) ? 7 : 6.5, tagColor: INK.white });
      vignette(g, e.W, e.H, 0.45);
      const fin = ramp(lt, 0, 0.18);
      if (fin < 1) {
        g.fillStyle = `rgba(6,5,11,${1 - fin})`;
        g.fillRect(0, 0, e.W, e.H);
      }
    },
  };
}

/* ------------------------------------------------------------ the app */

const HOME = "/Users/dev";
/** Agents hired from this page earlier: a Command Code on this Mac in chat mode, a Claude on Railway, a Codex on Vercel. */
function preHire(e: Engine) {
  const b = e.bridge!;
  b.hire({ agent: "commandcode", place: { kind: "local", target: `${HOME}/code/cli-kit` }, mode: "chat", prompt: "add a --json flag to the table output", permission: "default" });
  b.hire({ agent: "claude", place: { kind: "railway", target: "new", cwd: "/root/payments-svc" }, mode: "chat", prompt: "review the refund retry logic", permission: "default", sandbox: { timeoutMin: 30 } });
  b.hire({ agent: "codex", place: { kind: "vercel", target: "new", cwd: "/vercel/sandbox/chat-bot" }, mode: "terminal", prompt: "fix the flaky handler test", permission: "default", sandbox: { timeoutMin: 30 } });
}

const panel = ".session:not([hidden])";
const actionable = (e: Engine) => all(e, `${panel} .apcard.is-actionable`)[0] ?? $(e, ".apbar:not([hidden])");
const firstDiffRow = (e: Engine) => all(e, `${panel} .wrow.c-edit.has-detail .wrow-main`)[0] ?? null;
const lastLog = (e: Engine) => {
  const heads = all(e, `${panel} .wlog-head`);
  return heads.length ? heads[heads.length - 1]! : null;
};
const newSandbox = withText(".hire-opt", "New sandbox");
/** The starting steps: the walker, what it's doing, the steps. */
const WAIT = [`${panel} .sw-stage`, `${panel} .sw-detail`, `${panel} .sw-steps`, `${panel} .sw-setup`];

/** The session panel, from its top (its header, then the terminal's first lines) or its bottom (the prompt box). */
const panelCam = (edge: "top" | "bottom", o: { max?: number; maxTall?: number } = {}) => (e: Engine): UiView | null => {
  const el = $(e, panel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!r.width) return null;
  const s = Math.min(tall(e) ? (o.maxTall ?? 3.0) : (o.max ?? 1.8), (e.W * 0.96) / r.width);
  const half = e.regionH / 2 / s;
  return { cx: r.left + r.width / 2, cy: edge === "top" ? r.top + half - 4 : r.bottom - half + 4, s };
};
const sandboxPane = '.hire-pane[data-pane="sandbox"]';

/** Frame these, as big as fits (capped per frame shape). */
const fr = (t: Target | Target[], o: { max?: number; maxTall?: number; pad?: number; dy?: number } = {}) => (e: Engine) =>
  frame(t, { max: tall(e) ? (o.maxTall ?? 3.4) : (o.max ?? 2.0), pad: o.pad ?? 0.06, dy: o.dy })(e);

/** ① Open Hire, pick Command Code. */
function hire1(dur: number, o: { at: number; steps?: string[]; k?: number }): Shot {
  const k = o.k ?? 1;
  return flow("hire-pick", dur, [
    { t: 1.2 * k, click: ".tb-hire" },
    { t: 3.3 * k, click: '.hire-agent[data-agent="commandcode"]' },
  ], {
    at: o.at,
    open: { then: preHire },
    feature: hireF(0, o.steps),
    spots: [
      { from: 0.2 * k, to: 1.45 * k, on: ".tb-hire" },
      { from: 2.2 * k, to: dur, on: '.hire-agent[data-agent="commandcode"]' },
    ],
    cam: (e, lt) => (lt < 1.45 * k ? null : sticky("c-agents", fr(".hire-agents", { max: 2.2 }))(e)),
    rate: 2.6,
    move: 0.8 * k,
  });
}

/** ② Where it works: Sandbox, Daytona, New sandbox. */
function hire2(dur: number, o: { steps?: string[]; k?: number } = {}): Shot {
  const k = o.k ?? 1;
  return flow("hire-where", dur, [
    // a phone's dialog scrolls: bring "Where it works" up first
    { t: 0.05, scroll: ".hire-seg", dur: 0.45 },
    { t: 1.0 * k, click: '.hire-seg-btn[data-where="sandbox"]' },
    { t: 2.3 * k, click: ".hire-prov.host-daytona" },
    { t: 3.6 * k, click: newSandbox, fx: 0.3 },
  ], {
    feature: hireF(1, o.steps),
    spots: [
      { from: 0.1, to: 1.2 * k, on: '.hire-seg-btn[data-where="sandbox"]' },
      { from: 1.25 * k, to: 2.5 * k, on: ".hire-prov.host-daytona" },
      { from: 2.55 * k, to: dur, on: newSandbox },
    ],
    cam: sticky("c-where", fr([".hire-seg", `${sandboxPane}:not([hidden])`], { max: 2.0 })),
    rate: 2.6,
    move: 0.7 * k,
  });
}

/** ③ Your setup: what Command Code takes along (its keys, the project), by name. */
function hire3(dur: number): Shot {
  const rows = ['.hire-setup .setup-row[data-row="login"]', '.hire-setup .setup-row[data-row="project"]'];
  return flow("hire-setup", dur, [{ t: 0.1, scroll: ".hire-setup", dur: 0.7 }], {
    feature: hireF(2),
    spots: [
      { from: 1.0, to: 3.0, on: rows },
      { from: 3.0, to: dur, on: ".hire-setup .setup-line" },
    ],
    cam: sticky("c-setup", fr(".hire-setup", { max: 2.0 })),
    rate: 2.4,
    cursor: false,
  });
}

/** ④ Hire. */
function hire4(dur: number, o: { steps?: string[]; step?: number; k?: number } = {}): Shot {
  const k = o.k ?? 1;
  return flow("hire-go", dur, [
    { t: 1.2 * k, click: ".hire button[type=submit]", fx: 0.4 },
    { t: 1.22 * k, run: (e) => (e.mem.ccHiredAt = e.wNow) },
  ], {
    feature: hireF(o.step ?? 3, o.steps),
    spots: [{ from: 0.1, to: 1.35 * k, on: ".hire button[type=submit]" }],
    cam: (e, lt) => (lt < 1.35 * k ? sticky("c-go", fr([".hire .hire-summary", ".hire button[type=submit]"], { max: 1.9 }))(e) : sticky("c-wait", fr(WAIT, { max: 2.3, pad: 0.12 }))(e)),
    rate: 2.6,
    move: 0.7 * k,
  });
}

/** The session's starting steps, time-lapsed, and labelled so. */
function lapse(dur: number, x: number, part: 1 | 2): Shot {
  return flow(`lapse-${part}`, dur, [], {
    feature: { ...F.lapse, tag: lapseTag(x) },
    speed: (lt) => (part === 1 && lt < 0.3 ? 1 : x),
    ...(part === 2 ? { at: (e: Engine) => e.wNow } : {}),
    spots: [{ from: 0.1, to: dur + 0.3, on: WAIT }],
    cam: sticky("c-wait", fr(WAIT, { max: 2.3, pad: 0.12 })),
    rate: 2.6,
    cursor: false,
  });
}

/** ① Send a prompt: click the prompt box, type it, Enter. */
function drive1(dur: number, o: { prompt?: string; at?: (e: Engine) => number; k?: number } = {}): Shot {
  const prompt = o.prompt ?? "rank ties by recency";
  const k = o.k ?? 1;
  const look = 1.6 * k;
  const clickAt = look + 1.1 * k, typeAt = clickAt + 0.25 * k, rate = 0.06 * k;
  const enterAt = typeAt + prompt.length * rate + 0.45 * k;
  return flow("drive-send", dur, [
    { t: clickAt, click: `${panel} .ses-input`, fx: 0.3 },
    { t: typeAt, type: prompt, into: `${panel} .ses-input`, rate },
    { t: enterAt, key: "Enter", code: "Enter", on: `${panel} .ses-input`, cap: { label: "", near: `${panel} .ses-prompt`, above: true } },
  ], {
    ...(o.at ? { at: o.at } : {}),
    feature: driveF(0),
    spots: [{ from: look + 0.3 * k, to: enterAt + 0.4, on: `${panel} .ses-prompt` }],
    // first which agent this is (the panel's header: Command Code, its Daytona sandbox), then down to the prompt box
    // then back up to its terminal, where the answer comes in
    cam: (e, lt) => (lt < look || lt > enterAt + 0.4 ? sticky("c-ptop", panelCam("top"))(e) : sticky("c-pbot", panelCam("bottom"))(e)),
    rate: 2.2,
    move: 0.7 * k,
  });
}

/** ② Watch it work: back up to the terminal as its output comes in. */
function drive2(dur: number): Shot {
  return flow("drive-watch", dur, [], {
    feature: driveF(1),
    cam: sticky("c-ptop", panelCam("top")),
    rate: 2.2,
    cursor: false,
  });
}

/** ① Open its chat: Your agents, then the Command Code on this Mac. */
function chat1(dur: number): Shot {
  return flow("chat-open", dur, [
    { t: 0.9, click: ".tb-sessions" },
    { t: 2.6, click: withText(".sl-row", "cli-kit") },
  ], {
    feature: chatF(0),
    spots: [
      { from: 0.1, to: 1.05, on: ".tb-sessions" },
      { from: 1.4, to: 2.75, on: withText(".sl-row", "cli-kit") },
    ],
    cam: (e, lt) => (lt < 1.1 ? null : lt < 2.8 ? sticky("c-sl", fr(".sl", { max: 2.4 }))(e) : (fr([actionable], { max: 2.2, pad: 0.08, dy: -60 })(e) ?? (e.mem["c-sl"] as UiView | undefined) ?? null)),
    rate: 2.6,
    move: 0.7,
  });
}

/** ② Read the full command. */
function chat2(dur: number): Shot {
  return flow("chat-read", dur, [], {
    feature: chatF(1),
    spots: [{ from: 0.05, to: dur + 0.3, on: (e: Engine) => (actionable(e)?.querySelector<HTMLElement>("pre, code, .ap-cmd, .apcard-detail") ?? actionable(e)) }],
    cam: sticky("c-ap", fr([actionable], { max: 2.2, pad: 0.08, dy: -60 })),
    rate: 2.6,
    cursor: false,
  });
}

/** ③ Press 1: allowed; the test run goes ahead. */
function chat3(dur: number, keyAt = 0.9): Shot {
  return flow("chat-allow", dur, [{ t: keyAt, key: "1", code: "Digit1", cap: { label: "allow", near: actionable } }], {
    feature: chatF(2),
    spots: [{ from: 0, to: keyAt + 0.5, on: actionable }],
    cam: sticky("c-ap", fr([actionable], { max: 2.2, pad: 0.08, dy: -60 })),
    rate: 2.6,
    cursor: false,
  });
}

/** See every change: open the turn's work log, then the first edit's diff. */
function diffShot(dur: number): Shot {
  return flow("diff", dur, [
    { t: 0.4, click: lastLog, fx: 0.2 },
    { t: 1.9, click: firstDiffRow, fx: 0.25 },
  ], {
    feature: F.diff,
    spots: [{ from: 1.5, to: dur, on: (e: Engine) => (firstDiffRow(e)?.closest(".wrow") as HTMLElement | null) }],
    cam: (e, lt) =>
      lt < 1.5
        ? sticky("c-log", fr([lastLog], { max: 2.2, pad: 0.1, dy: 140 }))(e)
        : sticky("c-diff", (e2) => {
            const row = firstDiffRow(e2)?.closest(".wrow") as HTMLElement | null;
            return fr(row ? [() => row] : [firstDiffRow], { max: 2.1 })(e2);
          })(e),
    rate: 2.4,
    move: 0.6,
  });
}

/** "needs you": close the panel, then the amber button in the top bar takes the camera to the waiting worker. */
function needsYou(dur: number): Shot {
  const clickAt = 1.9;
  return flow("needs-you", dur, [
    { t: 0.05, click: `${panel} .ses-close`, hide: true },
    { t: clickAt, click: ".stat-needs", fx: 0.45 },
  ], {
    at: TV.waiting - 600,
    feature: F.needs,
    spots: [{ from: 0.5, to: clickAt + 0.15, on: ".stat-needs" }],
    cam: (e, lt) => (lt < clickAt + 0.3 ? sticky("c-needs", fr([".stat-needs"], { max: 2.0, pad: 0.2, dy: 120 }))(e) : null),
    rate: 2.2,
    move: 0.8,
  });
}

/* ------------------------------------------------------------ the cuts */

/** ~98 s: the problem, the answer, the centrepiece step by step, "and also", how to use it, the end card. */
const main = (w: number, h: number, app = { w: 1440, h: 900 }): Cut => ({
  name: "main",
  w,
  h,
  app,
  script: tourScript2,
  shots: [
    hook(4.0, { line1: "Eight agents. Eight terminals.", line2: "Which one needs you?", line1At: 0.3, line2At: 1.9, outAt: 3.5 }),
    commandShot(2.8, { typeAt: 0.3, enterAt: 2.0 }),
    withF(boot(6.2, { holdTight: 1.5 }), F.one),
    positioning(1.8),
    hire1(5.0, { at: TV.app }),
    hire2(5.0),
    hire3(4.8),
    hire4(2.6),
    lapse(2.6, 8, 1),
    beamIn(4.8, (e) => (e.mem.ccHiredAt as number) + 24_050),
    lapse(2.2, 8, 2),
    drive1(6.4),
    drive2(4.2),
    chat1(4.4),
    chat2(2.6),
    chat3(3.0),
    diffShot(5.2),
    andAlso(1.2),
    withF(interns(4.4, { at: TV.interns - 200 }), F.interns),
    needsYou(4.8),
    withF(flip(4.4, { impact: 1.3, flipAt: TV.flip, band: true }), F.flip, { bed: 0 }),
    mcpShot(4.2),
    privacyShot(4.2),
    howTo(4.0),
    endTour(5.6),
  ],
});

/** 30 s: the problem, the answer, then the Command Code cloud hire as the centrepiece, the flip, the card. */
const short = (name: string, w: number, h: number, app = { w: 1440, h: 900 }): Cut => ({
  name,
  w,
  h,
  app,
  script: tourScript2,
  shots: [
    hook(2.2, { line1: "Eight agents. Eight terminals.", line2: "Which one needs you?", line1At: 0.1, line2At: 1.0, outAt: 1.8 }),
    commandShot(1.9, { typeAt: 0.1, enterAt: 1.35 }),
    withF(boot(3.0, { holdTight: 0.8 }), F.one),
    hire1(3.2, { at: TV.app, steps: HIRE_STEPS_SHORT, k: 0.58 }),
    hire2(2.9, { steps: HIRE_STEPS_SHORT, k: 0.68 }),
    hire4(1.9, { steps: HIRE_STEPS_SHORT, step: 2, k: 0.75 }),
    lapse(1.4, 14, 1),
    beamIn(3.0, (e) => (e.mem.ccHiredAt as number) + 24_050, 0.9),
    drive1(4.4, { at: (e) => (e.mem.ccHiredAt as number) + 44_000, k: 0.5, prompt: "rank ties by recency" }),
    withF(flip(3.2, { impact: 1.0, flipAt: TV.flip, band: true, slow: 1.3 }), F.flip, { bed: 0 }),
    endTour(3.4),
  ],
});

export const TOUR: Record<string, Cut> = {
  main: main(1920, 1080),
  social: short("social", 1920, 1080),
  // the app at a phone's width in the vertical cut (its own phone layout), and a narrow window in the square
  vertical: short("vertical", 1080, 1920, { w: 480, h: 610 }),
  square: short("square", 1080, 1080, { w: 720, h: 500 }),
};
