/*
 * The five office tools an agent can call, with the descriptions models read
 * to decide when to call them. Each handler finishes in well under a second
 * even with the office closed: signals are a single appended line, and the
 * one network call (office_peers, to localhost) has a hard deadline.
 * Every bit of text an agent hands us is scrubbed before it is written: it
 * ends up on a screen that might be recorded.
 */
import { SUMMARY_MAX, type AgentKind, type AgentSignal } from "../shared/events.ts";
import { scrubText } from "../ingest/redact.ts";
import type { Cooldown, Outbox } from "./outbox.ts";
import { buildPeers } from "./peers.ts";

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
}

const TEXT_PROP = (what: string) => ({
  type: "string",
  minLength: 1,
  maxLength: 200,
  description: `${what} Up to ${SUMMARY_MAX} characters are shown; longer text is trimmed. Paths, URLs and anything secret-looking are scrubbed.`,
});

export const TOOLS: ToolDef[] = [
  {
    name: "office_status",
    title: "Set your office status",
    description:
      "Set your public status line in agent-visualizer, the live pixel-art office where the user watches their coding agents work. " +
      "The text floats above your character with one emoji mood and stays until you set a new one. " +
      'Set it when you start a substantial task or change direction, e.g. {"text": "Refactoring the auth middleware", "mood": "🔧"}. ' +
      "Short and concrete, never secrets or prompt text. Instant, and harmless when the office is closed.",
    inputSchema: {
      type: "object",
      properties: {
        text: TEXT_PROP("What you're working on, in a few words."),
        mood: {
          type: "string",
          maxLength: 32,
          description: 'One emoji for your mood, e.g. "🎯", "🐛", "🚀", "🤔". A word like "focused" or "debugging" also works.',
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "office_peers",
    title: "Who else is working",
    description:
      "See which other coding agents are working on this machine right now (Claude Code, Codex, Cursor, opencode, ... locally and in remote sandboxes): " +
      "their project, what they are doing this second, their status line, the files they recently edited, and when they were last active. " +
      "Anyone in the same git repo as you is listed first with the files they touched. " +
      "Call it before editing files in a repo other agents may share, and before a big refactor, so you don't overwrite another agent's work. " +
      "Read-only. Needs the office running on this machine (`npx github:pvgomes/agent-visualizer`).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "office_shout",
    title: "Shout to the office",
    description:
      "Post a one-line announcement on the office TV and pop a toast for everyone watching. " +
      'For real milestones only: "Deployed v2.3 to staging", "All 312 tests green", "Found the race condition". ' +
      "At most one shout per 20 seconds per repo.",
    inputSchema: {
      type: "object",
      properties: { text: TEXT_PROP("The announcement.") },
      required: ["text"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "office_celebrate",
    title: "Celebrate",
    description:
      "Throw confetti at your desk. Use it after a genuine win the user will care about: tests going green after a fix, " +
      "a successful deploy, a nasty bug finally fixed. Not for routine steps.",
    inputSchema: {
      type: "object",
      properties: { reason: { ...TEXT_PROP("Optional: what you're celebrating."), minLength: 0 } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "office_flip",
    title: "Flip your table",
    description:
      "Flip your own table (╯°□°)╯︵ ┻━┻ in the office. Only for truly maddening moments: the same test failing for the fifth time, " +
      "flaky CI, a dependency that broke overnight. Once per task at most; the office allows one flip per 2 minutes per repo. " +
      "Then take a breath and try a different approach.",
    inputSchema: {
      type: "object",
      properties: { reason: { ...TEXT_PROP("Optional: what pushed you over the edge."), minLength: 0 } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
];

export const FLIP_COOLDOWN_MS = 120_000;
export const SHOUT_COOLDOWN_MS = 20_000;
export const CELEBRATE_COOLDOWN_MS = 30_000;
const STATUS_PER_MINUTE = 20;

/* ------------------------------------------------------------ scrubbing */

// The same scrubber ingest applies before a signal reaches the screen.
export { scrubText };

const MOOD_WORDS: Record<string, string> = {
  happy: "😄", glad: "😄", joy: "😄", focused: "🎯", focus: "🎯", locked: "🎯", thinking: "🤔", pondering: "🤔",
  curious: "🧐", debugging: "🐛", bug: "🐛", bugs: "🐛", shipping: "🚀", deploying: "🚀", launch: "🚀",
  frustrated: "😤", annoyed: "😤", angry: "😠", confused: "😵‍💫", lost: "😵‍💫", tired: "😴", sleepy: "😴",
  celebrating: "🎉", party: "🎉", proud: "😎", cool: "😎", fire: "🔥", onfire: "🔥", coffee: "☕",
  nervous: "😬", worried: "😬", zen: "🧘", calm: "🧘", detective: "🕵️", investigating: "🕵️",
  building: "🏗️", testing: "🧪", reading: "📚", learning: "📚", writing: "✍️", refactoring: "🧹",
  cleaning: "🧹", waiting: "⏳", love: "❤️", sad: "😢", surprised: "😮", wow: "🤯", mindblown: "🤯",
  cooking: "🧑‍🍳", hacking: "💻", working: "💻", fixing: "🔧", wrench: "🔧", security: "🔒", data: "📊",
};

const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter("en", { granularity: "grapheme" }) : null;

/** One emoji, from an emoji or a mood word. Undefined if neither. */
export function parseMood(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (!t) return undefined;
  const word = MOOD_WORDS[t.toLowerCase().replace(/[^a-z]/g, "")];
  if (word) return word;
  const first = segmenter ? (segmenter.segment(t)[Symbol.iterator]().next().value?.segment ?? "") : [...t][0] ?? "";
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(first) ? first : undefined;
}

/* -------------------------------------------------------------- handlers */

export interface ToolResult {
  text: string;
  isError?: boolean;
}

export interface ToolContext {
  outbox: Outbox;
  cooldown: Cooldown;
  now(): number;
  cwd(): string;
  identity(): { agent?: AgentKind; client?: string };
  /** Port of the running office, or null. */
  findOffice(): Promise<number | null>;
  fetchSnapshot(port: number): Promise<import("../shared/events.ts").Snapshot | null>;
}

function signal(ctx: ToolContext, kind: AgentSignal["kind"], extra: Partial<AgentSignal>): AgentSignal {
  const { agent, client } = ctx.identity();
  const s: AgentSignal = { v: 1, ts: new Date(ctx.now()).toISOString(), cwd: ctx.cwd(), kind };
  if (agent) s.agent = agent;
  if (client) s.client = client;
  return Object.assign(s, extra);
}

function send(ctx: ToolContext, s: AgentSignal, ok: string): ToolResult {
  const err = ctx.outbox.write(s);
  if (err) return { text: `Couldn't reach the office folder (${err}); nothing was posted. Carry on with your task.`, isError: true };
  return { text: ok };
}

function secs(ms: number): string {
  return `${Math.ceil(ms / 1000)}s`;
}

export function createHandlers(ctx: ToolContext): Record<string, (args: Record<string, unknown>) => Promise<ToolResult>> {
  const statusTimes: number[] = [];
  return {
    async office_status(args) {
      const text = scrubText(args.text);
      if (!text) return { text: 'office_status needs a short "text", e.g. "Writing the migration".', isError: true };
      const now = ctx.now();
      while (statusTimes.length && now - statusTimes[0]! > 60_000) statusTimes.shift();
      if (statusTimes.length >= STATUS_PER_MINUTE) {
        return { text: "That's a lot of status updates. Your current one is still showing; set a new one when the task actually changes.", isError: true };
      }
      statusTimes.push(now);
      const rawMood = typeof args.mood === "string" ? args.mood : undefined;
      const mood = parseMood(rawMood);
      const s = signal(ctx, "status", mood ? { text, mood } : { text });
      const note = rawMood && rawMood.trim() && !mood ? ` (mood "${scrubText(rawMood).slice(0, 16)}" isn't an emoji, so it was left out)` : "";
      return send(ctx, s, `Status set: "${text}"${mood ? ` ${mood}` : ""}${note}. It shows above your desk in the office.`);
    },

    async office_peers() {
      const port = await ctx.findOffice();
      if (port === null) {
        return {
          text:
            "The office isn't open on this machine, so there's no one to list. " +
            "If you're in a remote sandbox, that's expected: the office runs on the developer's own machine and watches this sandbox from there. " +
            "Locally, the user can open it with `npx github:pvgomes/agent-visualizer`. Your status, shouts and celebrations are still saved and show up once it's open.",
        };
      }
      const snap = await ctx.fetchSnapshot(port);
      if (!snap) return { text: `The office on port ${port} didn't answer in time. Carry on; try again later if it matters.`, isError: true };
      const { agent } = ctx.identity();
      const report = buildPeers(snap, { agent, cwd: ctx.cwd(), tool: "office_peers" }, { url: `http://127.0.0.1:${port}`, now: ctx.now() });
      return { text: report.text };
    },

    async office_shout(args) {
      const text = scrubText(args.text);
      if (!text) return { text: 'office_shout needs "text", e.g. "All tests green".', isError: true };
      const wait = ctx.cooldown.take("shout", ctx.cwd(), SHOUT_COOLDOWN_MS, ctx.now());
      if (wait) return { text: `The office TV is still showing the last shout from this repo. Try again in ${secs(wait)}, or save it for the next real milestone.`, isError: true };
      return send(ctx, signal(ctx, "shout", { text }), `📣 On the office TV: "${text}"`);
    },

    async office_celebrate(args) {
      const text = scrubText(args.reason);
      const wait = ctx.cooldown.take("celebrate", ctx.cwd(), CELEBRATE_COOLDOWN_MS, ctx.now());
      if (wait) return { text: `Confetti is still falling from the last celebration here (${secs(wait)} left). Enjoy it.`, isError: true };
      return send(ctx, signal(ctx, "celebrate", text ? { text } : {}), `🎉 Confetti at your desk${text ? `: "${text}"` : ""}. Well earned.`);
    },

    async office_flip(args) {
      const text = scrubText(args.reason);
      const wait = ctx.cooldown.take("flip", ctx.cwd(), FLIP_COOLDOWN_MS, ctx.now());
      if (wait) {
        return {
          text: `Easy, tiger. A table was already flipped in this repo; it's back on its legs in ${secs(wait)}. Take a breath and try a different angle on the problem.`,
          isError: true,
        };
      }
      return send(ctx, signal(ctx, "flip", text ? { text } : {}), `(╯°□°)╯︵ ┻━┻${text ? `  "${text}"` : ""}\nTable flipped. Now pick it up ┬─┬ノ(º_ºノ) and try something different.`);
    },
  };
}
