/*
 * GitHub Copilot sessions: ~/.copilot/session-state/<sessionId>/events.jsonl
 * ($COPILOT_HOME moves it). The Copilot CLI writes it, and so does the agent
 * runtime VS Code's Copilot runs (copilot-runtime), so one parser covers the
 * terminal and the editor. Every line is {type, data, timestamp, agentId?}:
 * session.start / session.resume carry context.cwd and the model, a
 * user.message is a prompt, assistant.turn_start..turn_end wrap one model
 * call, tool.execution_start / _complete bracket a tool (success, and the
 * shell's exit code), and session.shutdown is a clean exit. A reply with no
 * tool calls followed by its turn_end hands the turn back to the human.
 * Subagents run in the same file: subagent.started names the spawning call,
 * and their own lines carry that call's id as agentId.
 */
import type { RawEvent } from "../shared/events.ts";
import { categorize } from "./categories.ts";
import {
  emit, endIntern, isObj, isoTs, newCtx, num, parseJson, resultText, setCwd, spawnIntern, toolFields,
  type InternHost, type PendingTool, type WorkerCtx,
} from "./common.ts";
import { isTestCommand, outputLooksFailed, shellCategory, testExitHidden, testGuarded, testVerdict, toolSummary } from "./redact.ts";

export interface CopilotFile {
  sessionId: string;
}

export interface CopilotState extends InternHost {
  /** Interns by the id of the call that spawned them (their lines' agentId). */
  subs: Map<string, WorkerCtx>;
  /** The main agent's last message had no tool calls: its turn_end means it's the human's turn. */
  replied: boolean;
}

const SHELL_TOOLS = new Set(["bash", "powershell"]);
const ASKS_HUMAN = new Set(["ask_user", "exit_plan_mode"]);
/** Bookkeeping the agent does on itself, not work worth a pose. */
const QUIET_TOOLS = new Set(["report_intent", "rename_session", "task_complete", "list_canvas_capabilities"]);

export function createCopilotState(f: CopilotFile): CopilotState {
  const main = newCtx("copilot", f.sessionId, {});
  return { main, workers: new Map([[main.workerId, main]]), internSeq: 0, subs: new Map(), replied: false };
}

export function parseCopilotLine(state: CopilotState, line: string): RawEvent[] {
  const o = parseJson(line);
  if (!o || typeof o.type !== "string") return [];
  const d: Record<string, any> = isObj(o.data) ? o.data : {};
  const main = state.main;
  const agentId = typeof o.agentId === "string" && o.agentId ? o.agentId : undefined;
  const ctx = (agentId && state.subs.get(agentId)) || main;
  const ts = isoTs(o.timestamp, ctx.lastTs);
  switch (o.type) {
    case "session.start":
    case "session.resume":
      if (isObj(d.context)) setCwd(main, d.context.cwd);
      model(main, d.selectedModel);
      return [];
    case "session.model_change":
      model(main, d.newModel);
      return [];
    case "session.auto_mode_resolved":
      model(main, d.chosenModel);
      return [];
    case "user.message": {
      // A subagent's brief arrives as its own user.message; only the human's prompts count.
      if (agentId || typeof d.content !== "string" || !d.content.trim()) return [];
      state.replied = false;
      return emit(main, "prompt", ts, { summary: "New prompt" });
    }
    case "assistant.turn_start":
      return emit(ctx, "thinking", ts, { summary: "Thinking" });
    case "assistant.message": {
      model(ctx, d.model);
      const calls = Array.isArray(d.toolRequests) ? d.toolRequests.length : 0;
      const text = typeof d.content === "string" && d.content.trim() !== "";
      if (ctx !== main) return [];
      state.replied = !calls && text;
      return state.replied ? emit(main, "reply", ts, { summary: "Replied" }) : [];
    }
    case "assistant.turn_end":
      if (ctx !== main || !state.replied) return [];
      state.replied = false;
      return emit(main, "waiting", ts, { summary: "Waiting" });
    case "session.usage_record":
      if (isObj(d.usage)) ctx.pendingTokens += num(d.usage.inputTokens) + num(d.usage.outputTokens);
      return [];
    case "tool.execution_start":
      return toolStart(ctx, d, ts);
    case "tool.execution_complete":
      return toolEnd(state, ctx, d, ts);
    case "subagent.started":
      return subStart(state, d, ts);
    case "subagent.completed":
    case "subagent.failed": {
      const id = typeof d.toolCallId === "string" ? d.toolCallId : "";
      state.subs.delete(id);
      return endIntern(state, main.pending.get(id), ts);
    }
    case "session.error":
      return emit(main, "error", ts, { summary: "Error", isError: true });
    case "session.shutdown": {
      const out: RawEvent[] = [];
      for (const p of main.pending.values()) out.push(...endIntern(state, p, ts));
      state.subs.clear();
      state.replied = false;
      out.push(...emit(main, "session_end", ts));
      return out;
    }
    default:
      return [];
  }
}

function model(ctx: WorkerCtx, m: unknown): void {
  // A custom model provider prefixes its id: "<uuid>/claude-opus-5".
  if (typeof m === "string" && m && m !== "auto") ctx.model = m.replace(/^[0-9a-f]{8}-[0-9a-f-]{27}\//i, "");
}

function toolStart(ctx: WorkerCtx, d: Record<string, any>, ts: string): RawEvent[] {
  const id = typeof d.toolCallId === "string" ? d.toolCallId : "";
  let name = typeof d.toolName === "string" && d.toolName ? d.toolName : "tool";
  if (!id || QUIET_TOOLS.has(name)) return [];
  const args: Record<string, any> = isObj(d.arguments) ? d.arguments : {};
  const server = typeof d.mcpServerName === "string" && d.mcpServerName ? d.mcpServerName : undefined;
  if (server) name = `mcp__${server}__${typeof d.mcpToolName === "string" && d.mcpToolName ? d.mcpToolName : name}`;
  const shell = !server && SHELL_TOOLS.has(name);
  const category = shell ? shellCategory(args.command) : categorize(name);
  const summary = toolSummary(name, category, {
    file: args.path ?? args.file_path,
    command: shell ? args.command ?? "" : undefined,
    url: args.url,
    glob: name === "glob" ? args.pattern : args.glob,
    path: args.path,
    subagentType: args.agent_type ?? args.subagent_type,
    skill: args.skill ?? args.name,
  });
  const p: PendingTool = { tool: name, category, summary, test: false };
  // A detached or async shell returns before the tests do: its result says nothing about them.
  if (shell && args.mode !== "async" && args.detach !== true && isTestCommand(args.command)) {
    p.test = true;
    p.piped = testExitHidden(args.command);
    p.guarded = testGuarded(args.command);
  }
  ctx.pending.set(id, p);
  const out = emit(ctx, "tool_start", ts, toolFields(p));
  if (ASKS_HUMAN.has(name)) out.push(...emit(ctx, "waiting", ts, { summary: "Needs you" }));
  return out;
}

function toolEnd(state: CopilotState, ctx: WorkerCtx, d: Record<string, any>, ts: string): RawEvent[] {
  const id = typeof d.toolCallId === "string" ? d.toolCallId : "";
  const p = ctx.pending.get(id);
  if (!p) return [];
  ctx.pending.delete(id);
  const code = isObj(d.shellExecution) && typeof d.shellExecution.exitCode === "number" ? d.shellExecution.exitCode : undefined;
  const isError = d.success === false || (code !== undefined && code !== 0);
  const out = emit(ctx, "tool_end", ts, { ...toolFields(p), ...(isError ? { isError: true } : {}) });
  if (p.test) {
    const text = isObj(d.result) ? resultText(d.result.content).slice(-200_000) : "";
    const verdict = testVerdict(p, isError || (!!p.piped && outputLooksFailed(text)), text);
    if (verdict) out.push(...emit(ctx, verdict, ts, { ...toolFields(p), ...(verdict === "test_fail" ? { isError: true } : {}) }));
  }
  if (p.internId) state.subs.delete(id);
  out.push(...endIntern(state, p, ts));
  return out;
}

/** A subagent took over the call that spawned it: an intern sits down until that call returns. */
function subStart(state: CopilotState, d: Record<string, any>, ts: string): RawEvent[] {
  const id = typeof d.toolCallId === "string" ? d.toolCallId : "";
  const main = state.main;
  if (!id || state.subs.has(id)) return [];
  let p = main.pending.get(id);
  if (!p) {
    p = { tool: "task", category: "agent", summary: "Agent", test: false };
    main.pending.set(id, p);
  }
  const role = [d.agentDisplayName, d.agentName, d.agentType].find((v) => typeof v === "string" && v) ?? "subagent";
  const out = spawnIntern(state, main, p, id, role, ts);
  const intern = p.internId ? state.workers.get(p.internId) : undefined;
  if (intern) state.subs.set(id, intern);
  return out;
}
