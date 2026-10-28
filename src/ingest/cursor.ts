/*
 * Cursor agent transcripts (IDE agent and cursor-agent CLI):
 * ~/.cursor/projects/<cwd-slug>/agent-transcripts/<id>/<id>.jsonl, with
 * subagents in .../<id>/subagents/<sub>.jsonl. Lines are {role, message:
 * {content[]}} with text and tool_use blocks, plus {type:"turn_ended",
 * status}. There are no timestamps, no tool results, no model and no cwd, so:
 * the loop supplies the clock (file mtime on backfill, now when live), a call
 * ends when the next line arrives, the turn's end closes whatever is open, and
 * cwd is recovered from absolute paths in tool inputs that match the slug.
 * Human prompts are wrapped in <user_query>.
 */
import type { RawEvent } from "../shared/events.ts";
import { categorize } from "./categories.ts";
import {
  closePending, emit, isObj, newCtx, parseJson, setCwd, toolFields,
  type InternHost, type PendingTool, type WorkerCtx,
} from "./common.ts";
import { cwdFromSlug } from "./discover.ts";
import { isTestCommand, shellCategory, toolSummary } from "./redact.ts";

export interface CursorFile {
  /** Transcript id (the folder name), or the subagent's file name for subagents. */
  sessionId: string;
  /** For subagents: the session they work for. */
  parentId?: string;
  role?: string;
  /** The project folder name under ~/.cursor/projects, e.g. "Users-me-my-app". */
  slug: string;
}

export interface CursorState extends InternHost {
  slug: string;
  /** Timestamp the loop assigns to the lines it is about to parse. */
  clock: string;
  callSeq: number;
  /** subagent_type of the last Task call, for the next subagent transcript. */
  lastSpawnRole?: string;
}

const SHELL_TOOLS = new Set(["Shell", "Bash", "run_terminal_cmd", "RunTerminalCommand"]);
const ASKS_HUMAN = new Set(["AskQuestion", "AskUserQuestion", "CreatePlan"]);

export function createCursorState(f: CursorFile): CursorState {
  const main = newCtx("cursor", f.sessionId, f.parentId ? { parentId: f.parentId, role: f.role || "subagent" } : {});
  // Until a tool call reveals the real path, the slug's last word is the best label.
  main.project = f.slug.split("-").filter(Boolean).pop() ?? "";
  return { main, workers: new Map([[main.workerId, main]]), internSeq: 0, slug: f.slug, clock: new Date().toISOString(), callSeq: 0 };
}

export function parseCursorLine(state: CursorState, line: string): RawEvent[] {
  const o = parseJson(line);
  if (!o) return [];
  const ctx = state.main;
  const ts = state.clock;
  if (o.type === "turn_ended") {
    const out = closePending(state, ctx, ts);
    if (o.status === "aborted" || o.status === "cancelled") out.push(...emit(ctx, "error", ts, { summary: "Interrupted", isError: true }));
    else if ((o.status && o.status !== "success") || o.error) out.push(...emit(ctx, "error", ts, { summary: "Error", isError: true }));
    else out.push(...emit(ctx, "reply", ts, { summary: "Replied" }));
    out.push(...(ctx.parentId ? emit(ctx, "subagent_end", ts) : emit(ctx, "waiting", ts, { summary: "Waiting" })));
    return out;
  }
  const blocks: any[] = isObj(o.message) && Array.isArray(o.message.content) ? o.message.content : [];
  if (o.role === "user") {
    const text = blocks.map((b) => (isObj(b) && typeof b.text === "string" ? b.text : "")).join("\n").trim();
    if (!text || (text.startsWith("<") && !text.includes("<user_query>"))) return [];
    const out = closePending(state, ctx, ts);
    out.push(...emit(ctx, "prompt", ts, { summary: "New prompt" }));
    return out;
  }
  if (o.role !== "assistant") return [];
  // No tool results are recorded: the model speaking again means the last calls came back.
  const out = closePending(state, ctx, ts);
  let tool = false;
  for (const b of blocks) {
    if (!isObj(b)) continue;
    if (b.type === "tool_use") {
      tool = true;
      out.push(...toolStart(state, ctx, b, ts));
    }
  }
  if (!tool) out.push(...emit(ctx, "thinking", ts, { summary: "Thinking" }));
  return out;
}

function toolStart(state: CursorState, ctx: WorkerCtx, b: Record<string, any>, ts: string): RawEvent[] {
  const name = typeof b.name === "string" && b.name ? b.name : "tool";
  const input: Record<string, any> = isObj(b.input) ? b.input : {};
  learnCwd(state, ctx, input.path ?? input.file_path ?? input.target_file ?? input.working_directory ?? input.cwd);
  const shell = SHELL_TOOLS.has(name);
  const category = shell ? shellCategory(input.command) : categorize(name);
  const summary = toolSummary(name, category, {
    file: input.path ?? input.file_path ?? input.target_file,
    command: shell ? input.command ?? "" : undefined,
    url: input.url,
    glob: name === "Glob" ? input.glob_pattern ?? input.pattern : input.glob,
    path: input.target_directory ?? input.path,
    subagentType: input.subagent_type,
    skill: input.skill ?? input.name,
  });
  const p: PendingTool = { tool: name, category, summary, test: false };
  // Results are never written, so a test run can't be judged; it still animates as one.
  if (shell && isTestCommand(input.command)) p.test = true;
  if (name === "Task") state.lastSpawnRole = typeof input.subagent_type === "string" ? input.subagent_type : undefined;
  ctx.pending.set(`c${++state.callSeq}`, p);
  const out = emit(ctx, "tool_start", ts, toolFields(p));
  if (ASKS_HUMAN.has(name)) out.push(...emit(ctx, "waiting", ts, { summary: "Needs you" }));
  return out;
}

function learnCwd(state: CursorState, ctx: WorkerCtx, p: unknown): void {
  if (ctx.cwd) return;
  const cwd = cwdFromSlug(state.slug, p);
  if (cwd) setCwd(ctx, cwd);
}
