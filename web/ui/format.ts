/*
 * Turning events into the words the chrome shows: feed labels, status words,
 * compact numbers and relative times. Summaries arrive already redacted by
 * ingest; nothing here adds transcript content.
 */
import type { EventKind, OfficeEvent, ToolCategory } from "../../src/shared/events.ts";
import { glyphFor, type Glyph } from "./icons.ts";

export type Tone = "plain" | "fail" | "pass" | "wait" | "intern" | "error" | "muted" | "shout";

export interface Line {
  text: string;
  glyph: Glyph;
  tone: Tone;
  /** Short chip for big moments, e.g. "table flipped". */
  tag?: string;
}

/** The feed / timeline label for an event, or null for events too chatty to list. */
export function describe(e: Pick<OfficeEvent, "kind" | "summary" | "tool" | "category" | "isError" | "role">): Line | null {
  const s = e.summary?.trim();
  const glyph = glyphFor(e.kind, e.category, e.isError);
  switch (e.kind) {
    case "tool_start":
      return { text: s || e.tool || "used a tool", glyph, tone: "plain" };
    case "tool_end":
      return e.isError ? { text: s || e.tool || "a tool failed", glyph, tone: "error", tag: "failed" } : null;
    case "test_fail":
      return { text: s || "tests failed", glyph, tone: "fail", tag: "table flipped" };
    case "test_pass":
      return { text: s || "tests passed", glyph, tone: "pass", tag: "tests passed" };
    case "waiting":
      return { text: "waiting for you", glyph, tone: "wait", tag: "needs you" };
    case "error":
      if (s && /^remote offline/i.test(s)) return { text: "remote went offline", glyph: "unplug", tone: "error", tag: "offline" };
      return { text: s || "hit an error", glyph, tone: "error", tag: "error" };
    case "flip":
      return { text: s || "flipped a table", glyph, tone: "fail", tag: "table flipped" };
    case "status":
      return s ? { text: s, glyph, tone: "plain", tag: "status" } : { text: "cleared its status", glyph, tone: "muted" };
    case "shout":
      return { text: s || "shouted", glyph, tone: "shout", tag: "shout" };
    case "celebrate":
      return { text: s || "is celebrating", glyph, tone: "pass", tag: "party" };
    case "subagent_start":
      return { text: e.role ? `${e.role} walked in` : "an intern walked in", glyph, tone: "intern", tag: "intern" };
    case "subagent_end":
      return { text: "clocked out", glyph, tone: "muted" };
    case "session_start":
      return { text: "walked in", glyph, tone: "plain" };
    case "session_end":
      return { text: "left the office", glyph, tone: "muted" };
    case "prompt":
      return { text: "picked up a task", glyph, tone: "plain" };
    case "idle":
      return { text: s || "went idle", glyph, tone: "muted" };
    default:
      return null;
  }
}

const CATEGORY_WORD: Record<ToolCategory, string> = {
  read: "reading",
  edit: "editing",
  bash: "running",
  search: "searching",
  web: "browsing",
  agent: "delegating",
  todo: "planning",
  mcp: "using a tool",
  other: "working",
};

export type Activity = "active" | "thinking" | "waiting" | "idle" | "fail" | "pass" | "gone";

export function statusOf(kind: EventKind, category?: ToolCategory): { word: string; activity: Activity } {
  switch (kind) {
    case "flip":
      return { word: "flipped a table", activity: "fail" };
    case "celebrate":
      return { word: "celebrating", activity: "pass" };
    case "tool_start":
      return { word: CATEGORY_WORD[category ?? "other"] ?? "working", activity: "active" };
    case "tool_end":
    case "reply":
    case "prompt":
    case "session_start":
    case "subagent_start":
      return { word: kind === "reply" ? "replying" : "working", activity: "active" };
    case "thinking":
      return { word: "thinking", activity: "thinking" };
    case "waiting":
      return { word: "waiting for you", activity: "waiting" };
    case "test_fail":
      return { word: "flipped a table", activity: "fail" };
    case "test_pass":
      return { word: "celebrating", activity: "pass" };
    case "error":
      return { word: "hit an error", activity: "fail" };
    case "idle":
      return { word: "idle", activity: "idle" };
    case "subagent_end":
    case "session_end":
      return { word: "left", activity: "gone" };
    default:
      return { word: "working", activity: "active" };
  }
}

export function fmtCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) n = 0;
  if (n < 10_000) return Math.round(n).toLocaleString("en-US");
  if (n < 1_000_000) return `${trim(n / 1000, n < 100_000 ? 1 : 0)}k`;
  if (n < 1_000_000_000) return `${trim(n / 1e6, n < 10e6 ? 2 : 1)}M`;
  return `${trim(n / 1e9, 2)}B`;
}

const trim = (v: number, digits: number): string => {
  const f = 10 ** digits;
  return (Math.floor(v * f) / f).toFixed(digits);
};

export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 3) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const hr = Math.floor(m / 60);
  return hr < 48 ? `${hr}h` : `${Math.floor(hr / 24)}d`;
}

/** Home directories become ~ (it hides the username on a screen recording). */
export function tidyPath(p: string): string {
  return p.replace(/^\/(?:Users|home)\/[^/]+/, "~").replace(/^[A-Za-z]:\\Users\\[^\\]+/, "~");
}

export function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const keep = max - 1;
  const head = Math.ceil(keep * 0.4);
  return `${s.slice(0, head)}…${s.slice(s.length - (keep - head))}`;
}

export const parseTs = (ts: string | undefined): number => {
  const t = ts ? Date.parse(ts) : NaN;
  return Number.isFinite(t) ? t : Date.now();
};

export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
