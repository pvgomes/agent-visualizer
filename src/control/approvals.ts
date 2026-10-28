/*
 * Approvals: an agent asking "may I run this?", answered from the page.
 *
 * Each session keeps its open questions in an ApprovalQueue; the oldest one
 * is ControlSession.pendingApproval, the rest wait their turn. Labels are the
 * office's own redacted tool summaries ("Edit auth.ts", "$ rm"), as
 * everywhere else. What is being approved goes in Approval.detail: the whole
 * command, the file and its change, the URL, secrets masked. It reaches
 * unlocked browsers only (control frames and the chat stream), never a
 * label, a log line or the office floor: "$ curl" can't be judged.
 *
 * Where they come from:
 *   - Claude in a terminal: its PermissionRequest http hook (passed per run
 *     with --settings) calls POST /api/hook/<id>/permission and waits. With no
 *     unlocked browser watching, the office answers {} at once and Claude
 *     asks in its own TUI as usual.
 *   - Claude, Codex and opencode in chat mode, and opencode's TUI: their own
 *     protocol (src/control/chat/*).
 *   - Everyone else: the TUI only.
 */
import { timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import type { Approval, ApprovalAnswer } from "../shared/control.ts";
import type { ToolCategory } from "../shared/events.ts";
import { categorize } from "../ingest/categories.ts";
import { redactSecrets, shellCategory, toolSummary } from "../ingest/redact.ts";
import { Emitter } from "./emitter.ts";
import { ControlError } from "./types.ts";

export interface Pending<M> {
  approval: Approval;
  meta: M;
}

/** Open approvals, oldest first. `changed` fires with the oldest (or null) whenever that changes. */
export class ApprovalQueue<M = unknown> {
  private readonly open = new Map<string, Pending<M>>();
  readonly changed = new Emitter<Approval | null>();
  private shown: string | null = null;

  add(approval: Approval, meta: M): void {
    this.open.set(approval.id, { approval, meta });
    this.notify();
  }

  get(id: string): Pending<M> | undefined {
    return this.open.get(id);
  }

  /** Remove and return it; throws 409 when it isn't open. */
  take(id: string): Pending<M> {
    const p = this.open.get(id);
    if (!p) throw new ControlError(409, "That approval is no longer open.");
    this.open.delete(id);
    this.notify();
    return p;
  }

  /** Withdrawn by the agent (answered in its TUI, cancelled, timed out). */
  drop(id: string): Pending<M> | undefined {
    const p = this.open.get(id);
    if (!p) return undefined;
    this.open.delete(id);
    this.notify();
    return p;
  }

  current(): Approval | null {
    for (const p of this.open.values()) return p.approval;
    return null;
  }

  /** Every open one, removed. */
  drain(): Pending<M>[] {
    const all = [...this.open.values()];
    this.open.clear();
    this.notify();
    return all;
  }

  get size(): number {
    return this.open.size;
  }

  private notify(): void {
    const cur = this.current();
    const id = cur?.id ?? null;
    if (id === this.shown) return;
    this.shown = id;
    this.changed.emit(cur);
  }
}

/* ------------------------------------------------------------- labels */

const CLAUDE_SHELL = new Set(["Bash", "BashOutput", "KillShell", "PowerShell"]);

/** A Claude tool call's name + input -> category and redacted label, exactly as the office shows the call. */
export function claudeToolLabel(name: string, input: unknown): { category: ToolCategory; summary: string } {
  const i: Record<string, any> = input && typeof input === "object" ? (input as Record<string, any>) : {};
  const shell = CLAUDE_SHELL.has(name);
  const category = shell ? shellCategory(i.command) : categorize(name);
  const summary = toolSummary(name, category, {
    file: i.file_path ?? i.notebook_path,
    command: shell ? i.command ?? "" : undefined,
    url: i.url,
    glob: name === "Glob" ? i.pattern : i.glob ?? (typeof i.type === "string" ? `*.${i.type}` : undefined),
    path: i.path,
    subagentType: i.subagent_type,
    skill: i.skill,
  });
  return { category, summary };
}

/** Approval.detail is at most this many characters. */
export const DETAIL_MAX = 4000;
const DIFF_LINES = 60;

/**
 * Approval.detail from its parts: control characters out (newlines and tabs
 * stay), the home folder as "~", anything that looks like a key masked,
 * capped at DETAIL_MAX. Empty parts are skipped; nothing left is undefined.
 */
export function approvalDetail(parts: (string | undefined | null | false)[], home: string = homedir()): string | undefined {
  const text = parts
    .filter((p): p is string => typeof p === "string" && p.trim() !== "")
    .join("\n")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .trim();
  if (!text) return undefined;
  // Masked before the final cut, so a key straddling it is never half shown.
  const masked = redactSecrets(tildeHome(text.slice(0, DETAIL_MAX * 4), home));
  return masked.length > DETAIL_MAX ? masked.slice(0, DETAIL_MAX - 1).trimEnd() + "…" : masked;
}

/** "/Users/me/x" -> "~/x", and "/Users/me" alone -> "~" (not "/Users/me2"). */
function tildeHome(text: string, home: string): string {
  const h = home.replace(/\/+$/, "");
  if (!h) return text;
  let out = "";
  let i = 0;
  for (let j = text.indexOf(h); j >= 0; j = text.indexOf(h, i)) {
    const next = text[j + h.length];
    const whole = next === undefined || next === "/" || !/[\w.-]/.test(next);
    out += text.slice(i, j) + (whole ? "~" : h);
    i = j + h.length;
  }
  return out + text.slice(i);
}

/** "-old" / "+new" lines for a replacement, capped. */
export function changeLines(oldText: unknown, newText: unknown): string {
  const lines = (v: unknown) => (typeof v === "string" && v !== "" ? v.split(/\r?\n/) : []);
  const out = [...lines(oldText).map((l) => `-${l}`), ...lines(newText).map((l) => `+${l}`)];
  return out.length > DIFF_LINES ? [...out.slice(0, DIFF_LINES), `… ${out.length - DIFF_LINES} more lines`].join("\n") : out.join("\n");
}

/** A tool input nobody wrote a format for: compact JSON, so nothing is hidden. */
function inputJson(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  try {
    const j = JSON.stringify(input, null, 1);
    return j === "{}" ? undefined : j;
  } catch {
    return undefined;
  }
}

/** What a Claude tool call would actually do, for Approval.detail. */
export function claudeToolDetail(name: string, input: unknown, why?: { reason?: unknown; description?: unknown; blockedPath?: unknown }, home?: string): string | undefined {
  const i: Record<string, any> = input && typeof input === "object" ? (input as Record<string, any>) : {};
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  let body: (string | undefined)[];
  if (CLAUDE_SHELL.has(name) && typeof i.command === "string") body = [i.command];
  else if (name === "Edit") body = [str(i.file_path), changeLines(i.old_string, i.new_string)];
  else if (name === "MultiEdit") body = [str(i.file_path), ...(Array.isArray(i.edits) ? i.edits.map((e: any) => changeLines(e?.old_string, e?.new_string)) : [])];
  else if (name === "Write") body = [str(i.file_path), changeLines("", i.content)];
  else if (name === "NotebookEdit") body = [str(i.notebook_path), changeLines("", i.new_source)];
  else if (name === "WebFetch") body = [str(i.url)];
  else if (name === "WebSearch") body = [str(i.query)];
  else body = [inputJson(input)];
  const notes = [str(why?.description), str(why?.blockedPath) && `Outside the allowed folders: ${why!.blockedPath}`, str(why?.reason) && `Why it asks: ${why!.reason}`];
  return approvalDetail([...body, ...notes], home);
}

/** The office pose for an open approval: "approve Edit auth.ts" on the worker's waiting bubble. */
export function approvalPose(a: Approval): string {
  return `approve ${a.summary}`;
}

/* ------------------------------------------- Claude's PermissionRequest hook */

export const DENY_MESSAGE = "Denied from agent-visualizer";

/**
 * "Always": Claude's own suggestions, kept to this session (nothing written
 * to a settings file). Never a rule of the office's making: with no
 * suggestion, or when Claude says a persistent rule would be broader than
 * the ask (suppress_always_allow_rule), there is no "Always" (null).
 */
export function sessionPermissions(suggestions: unknown, suppress?: unknown): unknown[] | null {
  if (suppress === true) return null;
  const list = Array.isArray(suggestions) ? suggestions.filter((s) => s && typeof s === "object") : [];
  if (!list.length) return null;
  return list.map((s) => ({ ...(s as object), destination: "session" }));
}

export type HookOutcome = { answer: ApprovalAnswer } | { interrupt: true } | { withdrawn: true };

/** The hook's JSON answer. A withdrawn question is {}: no decision, Claude asks in its TUI. */
export function hookReply(outcome: HookOutcome, meta: { suggestions: unknown; suppress?: unknown }): unknown {
  if ("withdrawn" in outcome) return {};
  const always = "answer" in outcome && outcome.answer.always ? sessionPermissions(meta.suggestions, meta.suppress) : null;
  const decision =
    "interrupt" in outcome
      ? { behavior: "deny", message: "Interrupted from agent-visualizer", interrupt: true }
      : outcome.answer.decision === "allow"
        ? { behavior: "allow", ...(always ? { updatedPermissions: always } : {}) }
        : { behavior: "deny", message: DENY_MESSAGE };
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision } };
}

export function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}
