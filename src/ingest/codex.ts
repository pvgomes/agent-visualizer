/*
 * Codex rollouts: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl,
 * lines {timestamp, type, payload}. The first session_meta is this file's
 * session; later ones are history copied in by a fork and are ignored.
 * Subagents are their own rollouts whose session_meta.source names the parent
 * thread. Tool calls arrive as response_item function_call / custom_tool_call
 * (apply_patch, and "exec": code mode, a JS cell that calls tools.exec_command
 * and friends) answered by *_output items. A command that outlives its call
 * ("Process running with session ID 7", "Script running with cell ID 3") is
 * resolved later by the write_stdin / wait call that sees it exit.
 */
import type { RawEvent, ToolCategory } from "../shared/events.ts";
import { categorize } from "./categories.ts";
import {
  emit, isObj, isoTs, newCtx, num, parseJson, resultText, setCwd, toolFields,
  type ParserState, type PendingTool, type WorkerCtx,
} from "./common.ts";
import { hostLabel, isTestCommand, mcpSummary, outputLooksFailed, shellCategory, shellSummary, testExitHidden, testGuarded, testVerdict, toolSummary } from "./redact.ts";

export interface CodexFile {
  /** The uuid from the rollout file name. */
  sessionId: string;
}

interface CodexPending extends PendingTool {
  /** write_stdin: the exec session it talks to. */
  session?: string;
  /** wait: the code-mode cell it waits on. */
  cell?: string;
  /** Code mode: exit status has to be read out of the script's output. */
  script?: boolean;
}

export interface CodexState extends ParserState {
  metaSeen: boolean;
  lastTotalTokens: number;
  replied: boolean;
  sawMessage: boolean;
  /** Test commands still running: exec session id / code-mode cell id -> the call. */
  sessions: Map<string, CodexPending>;
  cells: Map<string, CodexPending>;
  /** Call ids already answered (exec_command_end and the output item both report a call). */
  resolved: Set<string>;
}

const SHELL_FNS = new Set(["exec_command", "shell", "container.exec", "local_shell", "shell_command", "unified_exec"]);
const ITEM_TYPES = new Set(["message", "reasoning", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output", "local_shell_call", "web_search_call"]);

export function createCodexState(f: CodexFile): CodexState {
  const main = newCtx("codex", f.sessionId, {});
  return {
    main,
    workers: new Map([[main.workerId, main]]),
    metaSeen: false,
    lastTotalTokens: 0,
    replied: false,
    sawMessage: false,
    sessions: new Map(),
    cells: new Map(),
    resolved: new Set(),
  };
}

export function parseCodexLine(state: CodexState, line: string): RawEvent[] {
  const o = parseJson(line);
  if (!o) return [];
  const ctx = state.main;
  const ts = isoTs(o.timestamp, ctx.lastTs);
  const p: Record<string, any> = isObj(o.payload) ? o.payload : {};
  switch (o.type) {
    case "session_meta":
      sessionMeta(state, p);
      return [];
    case "turn_context":
      if (typeof p.model === "string" && p.model) ctx.model = p.model;
      setCwd(ctx, p.cwd);
      return [];
    case "event_msg":
      return event(state, p, ts);
    case "response_item":
      return item(state, p, ts);
    default:
      // Early rollouts wrote bare response items with no envelope.
      if (typeof o.type === "string" && ITEM_TYPES.has(o.type) && !isObj(o.payload)) return item(state, o, ts);
      return [];
  }
}

function sessionMeta(state: CodexState, p: Record<string, any>): void {
  if (state.metaSeen) return;
  state.metaSeen = true;
  const ctx = state.main;
  setCwd(ctx, p.cwd);
  const src = p.source;
  const sub = isObj(src) && isObj(src.subagent) ? src.subagent : undefined;
  if (!sub) return;
  const spawn = isObj(sub.thread_spawn) ? sub.thread_spawn : {};
  const parent = spawn.parent_thread_id ?? p.parent_thread_id;
  if (typeof parent === "string" && parent && parent !== ctx.workerId) ctx.parentId = parent;
  const role = spawn.agent_nickname ?? (typeof sub.other === "string" ? sub.other : undefined) ?? Object.keys(sub)[0];
  ctx.role = typeof role === "string" && role ? role : "subagent";
}

function event(state: CodexState, p: Record<string, any>, ts: string): RawEvent[] {
  const ctx = state.main;
  switch (p.type) {
    case "user_message":
      ctx.pending.clear();
      state.replied = state.sawMessage = false;
      return emit(ctx, "prompt", ts, { summary: "New prompt" });
    case "task_started":
      state.replied = state.sawMessage = false;
      return emit(ctx, "thinking", ts, { summary: "Thinking" });
    case "agent_reasoning":
    case "agent_reasoning_raw_content":
      return emit(ctx, "thinking", ts, { summary: "Thinking" });
    case "agent_message":
      if (p.phase === "final_answer") {
        state.replied = true;
        return emit(ctx, "reply", ts, { summary: "Replied" });
      }
      if (p.phase === undefined) state.sawMessage = true;
      return emit(ctx, "thinking", ts, { summary: "Thinking" });
    case "task_complete": {
      const out: RawEvent[] = [];
      if (!state.replied && (state.sawMessage || (typeof p.last_agent_message === "string" && p.last_agent_message))) {
        out.push(...emit(ctx, "reply", ts, { summary: "Replied" }));
      }
      state.replied = state.sawMessage = false;
      ctx.pending.clear();
      // Codex subagent threads are persistent: the parent's next message starts another turn in
      // the same thread, often within the second. The intern stays at its desk between turns and
      // leaves once it has been quiet a while (the ingest loop's housekeeping, INTERN_DONE_MS).
      out.push(...(ctx.parentId ? emit(ctx, "idle", ts, { summary: "Done" }) : emit(ctx, "waiting", ts, { summary: "Waiting" })));
      return out;
    }
    case "turn_aborted": {
      ctx.pending.clear();
      return emit(ctx, "error", ts, { summary: p.reason === "interrupted" ? "Interrupted" : "Turn aborted", isError: true });
    }
    case "error":
      return emit(ctx, "error", ts, { summary: "Error", isError: true });
    case "token_count": {
      const total = isObj(p.info) && isObj(p.info.total_token_usage) ? num(p.info.total_token_usage.total_tokens) : 0;
      if (total > state.lastTotalTokens) ctx.pendingTokens += total - state.lastTotalTokens;
      if (total) state.lastTotalTokens = total;
      return [];
    }
    case "exec_command_end": {
      // Its output rides along: piped and chained test runs are judged by it (never shown).
      const text = typeof p.aggregated_output === "string" ? p.aggregated_output.slice(-200_000) : "";
      return finish(state, p.call_id, text, ts, typeof p.exit_code === "number" ? p.exit_code : undefined, false, true);
    }
    case "patch_apply_end":
      return finish(state, p.call_id, "", ts, undefined, p.success === false, true);
    case "mcp_tool_call_end":
      return finish(state, p.call_id, "", ts, undefined, isObj(p.result) && "Err" in p.result, true);
    case "web_search_end": {
      if (typeof p.call_id === "string" && ctx.pending.has(p.call_id)) return finish(state, p.call_id, "", ts, undefined, false, true);
      return webSearch(ctx, p.action, ts);
    }
    default:
      return [];
  }
}

function webSearch(ctx: WorkerCtx, action: unknown, ts: string): RawEvent[] {
  const a = isObj(action) ? action : {};
  const host = a.type === "open_page" || a.type === "find_in_page" ? hostLabel(a.url) : "";
  const x = { tool: "web_search", category: "web" as ToolCategory, summary: host ? `Fetch ${host}` : "Web search" };
  return [...emit(ctx, "tool_start", ts, x), ...emit(ctx, "tool_end", ts, x)];
}

function item(state: CodexState, p: Record<string, any>, ts: string): RawEvent[] {
  const ctx = state.main;
  switch (p.type) {
    case "reasoning":
      return emit(ctx, "thinking", ts, { summary: "Thinking" });
    case "function_call":
      return functionCall(state, p, ts);
    case "custom_tool_call":
      return customCall(state, p, ts);
    case "local_shell_call": {
      const cmd = isObj(p.action) ? p.action.command : undefined;
      return start(state, callId(p), "local_shell", shellCategory(cmd), shellSummary(cmd), ts, testInfo(cmd));
    }
    case "web_search_call":
      return webSearch(ctx, p.action, ts);
    case "function_call_output":
    case "custom_tool_call_output":
    case "local_shell_call_output":
      return output(state, p, ts);
    default:
      return [];
  }
}

function callId(p: Record<string, any>): string {
  return typeof p.call_id === "string" && p.call_id ? p.call_id : typeof p.id === "string" ? p.id : "";
}

function testInfo(cmd: unknown): Partial<CodexPending> {
  return isTestCommand(cmd) ? { test: true, piped: testExitHidden(cmd), guarded: testGuarded(cmd) } : {};
}

function start(state: CodexState, id: string, tool: string, category: ToolCategory, summary: string, ts: string, extra: Partial<CodexPending> = {}): RawEvent[] {
  const ctx = state.main;
  const p: CodexPending = { test: false, ...extra, tool, category, summary };
  ctx.pending.set(id || `${ts}#${ctx.pending.size}`, p);
  return emit(ctx, "tool_start", ts, toolFields(p));
}

function functionCall(state: CodexState, p: Record<string, any>, ts: string): RawEvent[] {
  const ns = typeof p.namespace === "string" ? p.namespace : "";
  const name = typeof p.name === "string" && p.name ? p.name : "tool";
  const tool = ns && ns !== "collaboration" ? `${ns}__${name.replace(/^_+/, "")}` : name;
  let args: Record<string, any> = {};
  if (isObj(p.arguments)) args = p.arguments;
  else if (typeof p.arguments === "string") {
    try {
      const a = JSON.parse(p.arguments);
      if (isObj(a)) args = a;
    } catch {
      // Not JSON: treat as no arguments.
    }
  }
  const id = callId(p);
  if (SHELL_FNS.has(name)) {
    const cmd = args.cmd ?? args.command;
    return start(state, id, name, shellCategory(cmd), shellSummary(cmd), ts, testInfo(cmd));
  }
  if (name === "write_stdin") {
    return start(state, id, name, "bash", "$ stdin", ts, { session: String(args.session_id ?? "") });
  }
  if (name === "wait" && args.cell_id !== undefined) {
    return start(state, id, name, "bash", "Wait", ts, { cell: String(args.cell_id) });
  }
  const category = categorize(tool);
  const summary = tool.startsWith("mcp__")
    ? mcpSummary(tool)
    : toolSummary(tool, category, { file: args.path ?? args.file_path, url: args.url, path: args.path });
  return start(state, id, tool, category, summary, ts);
}

function customCall(state: CodexState, p: Record<string, any>, ts: string): RawEvent[] {
  const name = typeof p.name === "string" && p.name ? p.name : "tool";
  const input = typeof p.input === "string" ? p.input : "";
  const id = callId(p);
  if (name === "apply_patch") return start(state, id, name, "edit", toolSummary(name, "edit", { files: patchFiles(input) }), ts);
  if (name === "exec") return codeMode(state, id, input, ts);
  const category = categorize(name);
  return start(state, id, name, category, toolSummary(name, category, {}), ts);
}

/** "*** Update File: src/a.ts" lines of an apply_patch body. */
export function patchFiles(patch: string): string[] {
  const out: string[] = [];
  for (const m of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) out.push(m[1]!.trim());
  return out;
}

/** The tools a code-mode cell calls, in order: `tools.exec_command(...)`. */
export function cellTools(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\btools\s*(?:\.\s*([A-Za-z_][\w]*)|\[\s*["']([A-Za-z_][\w.-]*)["']\s*\])\s*\(/g)) {
    const t = m[1] ?? m[2]!;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** The literal `cmd:` strings a code-mode cell passes to exec_command. */
export function cellCommands(src: string): string[] {
  const out: string[] = [];
  const re = /["']?\bcmd["']?\s*:\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`)/g;
  for (const m of src.matchAll(re)) {
    let s = m[1] ?? m[2] ?? m[3] ?? "";
    s = s.replace(/\$\{[^}]*\}/g, "x").replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
    if (s.trim()) out.push(s);
  }
  return out;
}

function codeMode(state: CodexState, id: string, src: string, ts: string): RawEvent[] {
  const tools = cellTools(src);
  const primary = tools.find((t) => SHELL_FNS.has(t)) ?? tools.find((t) => t === "apply_patch") ?? tools[0];
  if (!primary) return start(state, id, "exec", "bash", "Run script", ts, { script: true });
  if (SHELL_FNS.has(primary)) {
    const cmds = cellCommands(src);
    const testCmd = cmds.find((c) => isTestCommand(c));
    const shown = testCmd ?? cmds[0];
    const category = shown ? shellCategory(shown) : "bash";
    return start(state, id, primary, category, shown ? shellSummary(shown) : "$ script", ts, { script: true, test: !!testCmd, piped: true });
  }
  if (primary === "apply_patch") return start(state, id, primary, "edit", toolSummary(primary, "edit", { files: patchFiles(src) }), ts, { script: true });
  const category = categorize(primary);
  const summary = primary.startsWith("mcp__") ? mcpSummary(primary) : toolSummary(primary, category, {});
  return start(state, id, primary, category, summary, ts, { script: true });
}

function output(state: CodexState, p: Record<string, any>, ts: string): RawEvent[] {
  const raw = p.output;
  let text = typeof raw === "string" ? raw : resultText(raw);
  let exit: number | undefined;
  let flagged = isObj(raw) && raw.success === false;
  if (text.startsWith("{")) {
    // Older shell tool: {"output": "...", "metadata": {"exit_code": 1}}
    try {
      const j = JSON.parse(text);
      if (isObj(j)) {
        if (isObj(j.metadata) && typeof j.metadata.exit_code === "number") exit = j.metadata.exit_code;
        if (typeof j.output === "string") text = j.output;
        if (j.success === false) flagged = true;
      }
    } catch {
      // Plain text that happens to start with a brace.
    }
  }
  const m = text.match(/Process exited with code (-?\d+)/) ?? text.match(/^Exit code:?\s*(-?\d+)/m);
  if (m) exit = Number(m[1]);
  return finish(state, callId(p), text, ts, exit, flagged, false);
}

function finish(state: CodexState, rawId: unknown, text: string, ts: string, exit: number | undefined, flagged: boolean, fromEvent: boolean): RawEvent[] {
  const ctx = state.main;
  const id = typeof rawId === "string" ? rawId : "";
  if (id && state.resolved.has(id)) return [];
  const p = ctx.pending.get(id) as CodexPending | undefined;
  // An end event for a call we never saw start (before the backfill window) says nothing useful.
  if (!p && fromEvent) return [];
  ctx.pending.delete(id);
  if (id) {
    state.resolved.add(id);
    if (state.resolved.size > 256) state.resolved.delete(state.resolved.values().next().value!);
  }
  const scriptFailed = !!p?.script && /^Script failed/m.test(text);
  const isError = flagged || scriptFailed || (exit !== undefined && exit !== 0);
  const out = emit(ctx, "tool_end", ts, { ...toolFields(p), ...(isError ? { isError: true } : {}) });
  if (!p) return out;

  if (p.test) {
    const running = text.match(/Process running with session ID (\d+)/)?.[1];
    const cell = p.script ? text.match(/^Script running with cell ID (\S+)/m)?.[1] : undefined;
    if (running) state.sessions.set(running, p);
    else if (cell) state.cells.set(cell, p);
    else out.push(...testResult(ctx, p, isError || scriptExitFailed(p, text) || (!!p.piped && outputLooksFailed(text)), text, ts));
  }
  // A later poll that saw an earlier test command finish.
  if (p.session && state.sessions.has(p.session) && exit !== undefined) {
    const t = state.sessions.get(p.session)!;
    state.sessions.delete(p.session);
    out.push(...testResult(ctx, t, exit !== 0 || (!!t.piped && outputLooksFailed(text)), text, ts));
  }
  if (p.cell && state.cells.has(p.cell) && /^Script (completed|failed)/m.test(text)) {
    const t = state.cells.get(p.cell)!;
    state.cells.delete(p.cell);
    out.push(...testResult(ctx, t, /^Script failed/m.test(text) || scriptExitFailed(t, text) || outputLooksFailed(text), text, ts));
  }
  return out;
}

/** Code mode prints whatever the script returns; look for a non-zero exit_code in it. */
function scriptExitFailed(p: CodexPending, text: string): boolean {
  if (!p.script) return false;
  for (const m of text.matchAll(/["']?\bexit_?code["']?\s*[:=]\s*(-?\d+)/gi)) if (m[1] !== "0") return true;
  return /Process exited with code [1-9]/.test(text);
}

function testResult(ctx: WorkerCtx, p: PendingTool, failed: boolean, text: string, ts: string): RawEvent[] {
  const verdict = testVerdict(p, failed, text);
  return verdict ? emit(ctx, verdict, ts, { ...toolFields(p), ...(verdict === "test_fail" ? { isError: true } : {}) }) : [];
}

/** rollout-2026-10-18T09-12-44-<uuid>.jsonl -> <uuid>. */
export function codexSessionId(path: string): string | undefined {
  return path.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)?.[1]?.toLowerCase();
}
