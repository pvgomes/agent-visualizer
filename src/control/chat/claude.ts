/*
 * Claude Code in chat mode: `claude -p --input-format stream-json
 * --output-format stream-json --verbose --include-partial-messages
 * --permission-prompt-tool stdio`, one long-lived process, one JSON object per
 * line each way (the Agent SDK's protocol).
 *
 *   in:  control_request initialize / interrupt, user turns (each with a
 *        uuid), control_response answers to can_use_tool
 *   out: system init (cwd), stream_event deltas, assistant / user messages
 *        (tool_result + tool_use_result), result per turn (duration_ms,
 *        usage, user_message_uuid(s)), control_request can_use_tool,
 *        control_cancel_request
 *
 * A prompt is written at once, even mid-turn: Claude holds it and reads it
 * at the next tool boundary of the running turn, or starts a turn with it
 * after the result, and can merge several sent close together. Each prompt
 * carries a uuid, and Claude echoes the one it is answering on the first
 * reply of a turn, on the first reply after it picks one up, and on the
 * result (user_message_uuids: every one that turn answered). That is what
 * moves a prompt out of the queue (ChatItem.queued) and starts its turn
 * (ChatItem.turnId). A Claude Code too old to echo is followed in order:
 * each result answers the oldest prompt.
 *
 * After an interrupted last turn the process exits 1 when stdin closes; that
 * is reported as is, not as a failure.
 */
import { randomUUID } from "node:crypto";
import type { ApprovalAnswer, ChatDiff, ChatItem } from "../../shared/control.ts";
import type { ToolCategory } from "../../shared/events.ts";
import { ApprovalQueue, claudeToolDetail, claudeToolLabel, DENY_MESSAGE, sessionPermissions } from "../approvals.ts";
import type { PipeProc } from "../types.ts";
import { APPROVAL_TEXT, approvalItem, ChatBase, endGracefully, jsonLines, longReason, num, outputTail, shortReason, tailOf, type TurnEnd } from "./common.ts";
import { addChange, chatDiff, replaceChange, type FileChange } from "./diff.ts";

interface Ask {
  requestId: string;
  toolUseId?: string;
  toolName: string;
  /** Claude's own session rules for "always"; null: no "always" for this ask. */
  always: unknown[] | null;
  turnId?: string;
}

export interface ClaudeChatOptions {
  proc: PipeProc;
  /** The pinned --session-id. */
  sessionId: string;
  /** "~/x" for the ready line. */
  where: string;
  /** Shown as "~" in an approval's detail (default: this machine's home; "" for none, on a remote). */
  home?: string;
  now?: () => number;
  /** How long the initialize handshake may take. */
  readyTimeoutMs?: number;
}

const RESULT_ERRORS: Record<string, string> = {
  error_max_turns: "Stopped: it hit the turn limit.",
  error_max_budget_usd: "Stopped: it hit the budget limit.",
  error_during_execution: "The turn failed.",
};

const INTERRUPT_MESSAGE = "Interrupted from agent-visualizer";
const SHELL = new Set(["Bash", "BashOutput", "PowerShell"]);

/** A prompt sent and not answered yet. */
interface Prompt {
  turnId: string;
  uuid: string;
  item: ChatItem;
  started: boolean;
}

/** The stretch of a Claude turn that answers one prompt (a prompt picked up mid-turn starts the next). */
interface Segment {
  turnId: string;
  t0: number;
  work: boolean;
}

interface Tool {
  tool: string;
  category: ToolCategory;
  summary: string;
  turnId?: string;
  /** When it started running: its tool_use, or the answer to its approval. */
  t0: number;
  /** An edit's change as its input states it. */
  edit?: { changes: FileChange[]; write: boolean };
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Every token the turn's main loop read or wrote (subagents aren't in `usage`). */
function usageTokens(u: any): number | undefined {
  if (!u || typeof u !== "object") return undefined;
  const parts = [u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens, u.output_tokens].map(num);
  return parts.some((x) => x !== undefined) ? parts.reduce<number>((a, b) => a + (b ?? 0), 0) : undefined;
}

/** The text of a tool_result's content (a string, or text blocks). */
function resultText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const t = content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
  return t || undefined;
}

/** +/- counts of Claude's structuredPatch hunks (numbers only: their lines include the file's own context). */
function patchCounts(patch: unknown): { added: number; removed: number } | undefined {
  if (!Array.isArray(patch) || !patch.length) return undefined;
  let added = 0, removed = 0;
  for (const h of patch) for (const l of Array.isArray(h?.lines) ? h.lines : []) {
    if (typeof l !== "string") continue;
    if (l[0] === "+") added++;
    else if (l[0] === "-") removed++;
  }
  return { added, removed };
}

export class ClaudeChat extends ChatBase {
  private readonly proc: PipeProc;
  private readonly queue = new ApprovalQueue<Ask>();
  private readonly stderr = tailOf();
  private reqSeq = 0;
  private interruptedAt = 0;
  private msgTexts = new Map<string, number>();
  /** stream index -> text ordinal, per message id. */
  private streamText = new Map<string, Map<number, number>>();
  private assistantTexts = new Map<string, number>();
  private texts = new Map<string, string>();
  private tools = new Map<string, Tool>();
  private currentMsg: string | undefined;
  private stopping = false;
  private readonly prompts: Prompt[] = [];
  private seg: Segment | undefined;
  /** This Claude turn's segments so far (more than one when it picked up a prompt). */
  private segs: Segment[] = [];
  /** This Claude Code echoes user_message_uuid. */
  private echoes = false;
  /** Claude's working folder, from its init message: diff file names are relative to it. */
  private cwd: string | undefined;
  readonly ready: Promise<void>;

  constructor(private readonly o: ClaudeChatOptions) {
    super(o.now);
    this.proc = o.proc;
    this.sessionId = o.sessionId;
    this.queue.changed.on((a) => this.approvals.emit(a));
    let ok!: () => void, fail!: (e: Error) => void;
    this.ready = new Promise<void>((res, rej) => ((ok = res), (fail = rej)));
    this.ready.catch(() => {});
    const timer = setTimeout(() => fail(new Error("Claude Code didn't answer its handshake.")), o.readyTimeoutMs ?? 60_000);
    this.onReady = (err) => {
      clearTimeout(timer);
      if (err) fail(err);
      else {
        ok();
        this.system(`Claude Code is ready in ${o.where}.`);
      }
    };
    this.proc.onStdout(jsonLines((m) => this.onMessage(m)));
    this.proc.onStderr((d) => this.stderr.push(d));
    this.proc.onExit((e) => {
      clearTimeout(timer);
      this.onReady?.(new Error(shortReason(this.stderr.text().trim().split("\n").pop() || `Claude Code exited (${e.code ?? "signal"}).`)));
      this.queue.drain();
      if (!this.stopping && this.prompts.length) this.system("Claude Code exited.", "error", this.seg ? { turnId: this.seg.turnId, turnEnd: true } : {});
      this.dropQueued(this.prompts.filter((p) => !p.started).map((p) => p.item), "Not sent: Claude Code exited.");
      this.finished(e);
    });
    this.write({ type: "control_request", request_id: "init", request: { subtype: "initialize" } });
  }

  private onReady: ((err?: Error) => void) | undefined;

  private write(o: unknown): void {
    this.proc.write(JSON.stringify(o) + "\n");
  }

  async send(text: string): Promise<void> {
    const turnId = this.newTurnId();
    const uuid = randomUUID();
    const queued = this.prompts.length > 0;
    const item = this.user(text, { turnId, queued });
    const p: Prompt = { turnId, uuid, item, started: !queued };
    this.prompts.push(p);
    if (!queued) this.begin(p);
    this.setBusy(true);
    this.write({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: this.sessionId, uuid });
  }

  async interrupt(): Promise<void> {
    if (!this.isBusy) return;
    this.interruptedAt = this.now();
    for (const p of this.queue.drain()) {
      this.respond(p.meta, { behavior: "deny", message: INTERRUPT_MESSAGE, interrupt: true, toolUseID: p.meta.toolUseId });
      this.put(approvalItem(p.approval, APPROVAL_TEXT.interrupted, p.meta.turnId));
    }
    // Prompts Claude holds stay queued: it runs them after the interrupt (its receipt lists them as still_queued).
    this.write({ type: "control_request", request_id: `int-${++this.reqSeq}`, request: { subtype: "interrupt" } });
  }

  async answer(a: ApprovalAnswer): Promise<void> {
    const p = this.queue.take(a.id);
    const m = p.meta;
    const allow = a.decision === "allow";
    this.respond(
      m,
      allow
        ? { behavior: "allow", toolUseID: m.toolUseId, ...(a.always && m.always ? { updatedPermissions: m.always } : {}) }
        : { behavior: "deny", message: DENY_MESSAGE, toolUseID: m.toolUseId },
    );
    // A tool's run time starts when it may run, not while it waited for the answer.
    const t = m.toolUseId ? this.tools.get(m.toolUseId) : undefined;
    if (t && allow) t.t0 = this.now();
    this.put(approvalItem(p.approval, allow ? (a.always && m.always ? APPROVAL_TEXT.always : APPROVAL_TEXT.allowed) : APPROVAL_TEXT.denied, m.turnId));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await endGracefully(this.proc, { endStdin: true, termAfterMs: 5000, killAfterMs: 3000 });
  }

  private respond(m: Ask, response: Record<string, unknown>): void {
    this.write({ type: "control_response", response: { subtype: "success", request_id: m.requestId, response } });
  }

  /* ------------------------------------------------------------ turns */

  /** A prompt's turn starts (the segment before it, if any, ends here). */
  private begin(p: Prompt): void {
    if (this.seg && this.seg.turnId !== p.turnId && this.seg.work) {
      // Picked up mid-turn: what came before answered the earlier prompt.
      this.settle(this.seg.turnId);
      this.endTurn(this.seg.turnId, { durationMs: this.now() - this.seg.t0 });
    }
    if (!p.started) {
      p.started = true;
      this.unqueue(p.item);
    }
    this.seg = { turnId: p.turnId, t0: this.now(), work: false };
    this.segs.push(this.seg);
  }

  /** Claude says which prompt it answers now: that one (and any merged in before it) starts. */
  private echo(m: any): void {
    const u = m?.user_message_uuid;
    if (typeof u !== "string") return;
    this.echoes = true;
    const i = this.prompts.findIndex((p) => p.uuid === u);
    if (i < 0 || this.seg?.turnId === this.prompts[i]!.turnId) return;
    for (let j = 0; j <= i; j++) if (!this.prompts[j]!.started) this.begin(this.prompts[j]!);
  }

  /** The turn new items belong to (with no echo, the oldest waiting prompt's). */
  private turn(): string | undefined {
    if (!this.seg) {
      const p = this.prompts.find((x) => !x.started);
      if (p) this.begin(p);
    }
    if (this.seg) this.seg.work = true;
    return this.seg?.turnId;
  }

  /* --------------------------------------------------------- messages */

  private onMessage(m: any): void {
    switch (m.type) {
      case "control_response": {
        const r = m.response ?? {};
        if (r.request_id === "init") {
          if (r.subtype === "success") this.onReady?.();
          else this.onReady?.(new Error(shortReason(r.error || "Claude Code refused the handshake.")));
          this.onReady = undefined;
        }
        return;
      }
      case "control_request":
        if (m.request?.subtype === "can_use_tool") this.ask(m);
        else if (typeof m.request_id === "string") {
          // Anything else Claude asks the client (hook callbacks, MCP messages) has no answer here.
          this.write({ type: "control_response", response: { subtype: "error", request_id: m.request_id, error: "Not supported by agent-visualizer" } });
        }
        return;
      case "control_cancel_request":
        if (typeof m.request_id === "string") {
          const p = this.queue.drop(m.request_id);
          if (p) this.put(approvalItem(p.approval, APPROVAL_TEXT.withdrawn, p.meta.turnId));
        }
        return;
      case "system":
        if (m.subtype === "init" && typeof m.cwd === "string") this.cwd = m.cwd;
        return;
      case "stream_event":
        if (m.parent_tool_use_id) return;
        if (m.event?.type !== "ping") this.echo(m);
        return this.onStream(m.event ?? {});
      case "assistant":
        if (m.parent_tool_use_id) return;
        this.echo(m);
        return this.onAssistant(m.message ?? {});
      case "user":
        if (m.isReplay || m.parent_tool_use_id) return;
        return this.onToolResults(m.message?.content, m.tool_use_result);
      case "result":
        return this.onResult(m);
      default:
        return;
    }
  }

  private ask(m: any): void {
    const r = m.request ?? {};
    const toolName = typeof r.tool_name === "string" ? r.tool_name : "tool";
    const { category, summary } = claudeToolLabel(toolName, r.input);
    const detail = claudeToolDetail(toolName, r.input, { reason: r.decision_reason, description: r.description, blockedPath: r.blocked_path }, this.o.home);
    const always = sessionPermissions(r.permission_suggestions, r.suppress_always_allow_rule);
    const approval = { id: String(m.request_id), tool: toolName, category, summary, ...(detail ? { detail } : {}), ...(always ? {} : { noAlways: true }), at: this.iso() };
    const turnId = (typeof r.tool_use_id === "string" ? this.tools.get(r.tool_use_id)?.turnId : undefined) ?? this.turn();
    this.queue.add(approval, { requestId: String(m.request_id), toolUseId: r.tool_use_id, toolName, always, turnId });
    this.put(approvalItem(approval, APPROVAL_TEXT.open, turnId));
  }

  private textId(msgId: string, ordinal: number): string {
    return `a-${msgId}-${ordinal}`;
  }

  private onStream(e: any): void {
    if (e.type === "message_start") {
      this.currentMsg = typeof e.message?.id === "string" ? e.message.id : undefined;
      return;
    }
    const msg = this.currentMsg;
    if (!msg) return;
    if (e.type === "content_block_start" && e.content_block?.type === "text") {
      const n = this.msgTexts.get(msg) ?? 0;
      this.msgTexts.set(msg, n + 1);
      let map = this.streamText.get(msg);
      if (!map) this.streamText.set(msg, (map = new Map()));
      map.set(e.index, n);
      if (this.streamText.size > 64) this.streamText.delete(this.streamText.keys().next().value!);
      return;
    }
    if (e.type === "content_block_delta" && e.delta?.type === "text_delta" && typeof e.delta.text === "string") {
      const n = this.streamText.get(msg)?.get(e.index);
      if (n === undefined) return;
      const id = this.textId(msg, n);
      const text = (this.texts.get(id) ?? "") + e.delta.text;
      this.texts.set(id, text);
      if (text.trim()) this.stream({ id, kind: "assistant", text, turnId: this.turn(), at: this.iso() });
    }
  }

  private onAssistant(msg: any): void {
    const msgId = typeof msg.id === "string" ? msg.id : this.nextId("m");
    for (const b of Array.isArray(msg.content) ? msg.content : []) {
      if (b?.type === "text" && typeof b.text === "string") {
        const n = this.assistantTexts.get(msgId) ?? 0;
        this.assistantTexts.set(msgId, n + 1);
        if (this.assistantTexts.size > 64) this.assistantTexts.delete(this.assistantTexts.keys().next().value!);
        const id = this.textId(msgId, n);
        const streamed = this.texts.delete(id);
        if (b.text.trim() || streamed) this.put({ id, kind: "assistant", text: b.text, turnId: this.turn(), streaming: false, at: this.iso() });
      } else if (b?.type === "tool_use" && typeof b.id === "string") {
        const tool = typeof b.name === "string" ? b.name : "tool";
        const { category, summary } = claudeToolLabel(tool, b.input);
        const t: Tool = { tool, category, summary, turnId: this.turn(), t0: this.now(), edit: this.editOf(tool, b.input) };
        this.tools.set(b.id, t);
        if (this.tools.size > 500) this.tools.delete(this.tools.keys().next().value!);
        this.put({ id: `t-${b.id}`, kind: "tool", tool, category, summary, ...(t.turnId ? { turnId: t.turnId } : {}), status: "running", at: this.iso() });
      }
    }
  }

  /** Edit / MultiEdit / Write: the change as the tool's input states it. */
  private editOf(tool: string, input: any): Tool["edit"] {
    const i = input && typeof input === "object" ? input : {};
    const file = str(i.file_path);
    if (!file) return undefined;
    if (tool === "Edit") return { changes: [replaceChange(file, [{ old: i.old_string, new: i.new_string }])], write: false };
    if (tool === "MultiEdit" && Array.isArray(i.edits)) return { changes: [replaceChange(file, i.edits.map((e: any) => ({ old: e?.old_string, new: e?.new_string })))], write: false };
    if (tool === "Write") return { changes: [addChange(file, i.content)], write: true };
    return undefined;
  }

  /**
   * The finished edit's diff: lines from its input, counts from Claude's own
   * structuredPatch when the result has one (exact for replace_all). A Write
   * over an existing file shows only the lines it wrote, under the patch's
   * hunk headers; with no patch to count, it has no diff.
   */
  private diffOf(t: Tool, result: any): ChatDiff | undefined {
    if (!t.edit) return undefined;
    const r = result && typeof result === "object" ? result : {};
    const counts = patchCounts(r.structuredPatch);
    let changes = t.edit.changes;
    if (t.edit.write && r.type === "update") {
      if (!counts) return undefined;
      const lines: string[] = [];
      for (const h of r.structuredPatch) {
        lines.push(`@@ -${num(h?.oldStart) ?? 0},${num(h?.oldLines) ?? 0} +${num(h?.newStart) ?? 0},${num(h?.newLines) ?? 0} @@`);
        for (const l of Array.isArray(h?.lines) ? h.lines : []) if (typeof l === "string" && l[0] === "+") lines.push(l);
      }
      changes = [{ path: changes[0]!.path, lines, ...counts }];
    } else if (counts && changes.length === 1) changes = [{ ...changes[0]!, ...counts }];
    return chatDiff(changes, { cwd: this.cwd, home: this.o.home });
  }

  private onToolResults(content: unknown, toolResult: unknown): void {
    if (!Array.isArray(content)) return;
    const results = content.filter((b) => b?.type === "tool_result" && typeof b.tool_use_id === "string");
    for (const b of results) {
      const t = this.tools.get(b.tool_use_id);
      if (!t) continue;
      this.tools.delete(b.tool_use_id);
      const ok = !b.is_error;
      const out = resultText(b.content);
      const own = out === DENY_MESSAGE || out === INTERRUPT_MESSAGE;
      // An output tail for shell commands that aren't reads or searches (whose output is file contents), and for failures.
      const detail = !own && ((SHELL.has(t.tool) && t.category === "bash") || !ok) ? outputTail(out, this.o.home) : undefined;
      const diff = ok ? this.diffOf(t, results.length === 1 ? toolResult : undefined) : undefined;
      this.put({ id: `t-${b.tool_use_id}`, kind: "tool", tool: t.tool, category: t.category, summary: t.summary, ...(t.turnId ? { turnId: t.turnId } : {}), status: ok ? "ok" : "error", durationMs: Math.max(0, this.now() - t.t0), ...(detail ? { detail } : {}), ...(diff ? { diff } : {}), at: this.iso() });
    }
  }

  private onResult(m: any): void {
    // Which prompts this result answered: every uuid it lists, and any sent before the last of them.
    const answered = new Set<string>(Array.isArray(m.user_message_uuids) ? m.user_message_uuids.filter((u: unknown) => typeof u === "string") : []);
    if (typeof m.user_message_uuid === "string") answered.add(m.user_message_uuid);
    if (answered.size) this.echoes = true;
    let last = -1;
    this.prompts.forEach((p, i) => answered.has(p.uuid) && (last = i));
    if (!answered.size && this.prompts.length) last = 0;
    for (let j = 0; j <= last; j++) if (!this.prompts[j]!.started) this.begin(this.prompts[j]!);

    const recent = !!this.interruptedAt && this.now() - this.interruptedAt < 60_000;
    const failed = m.subtype !== "success" || !!m.is_error;
    const end: TurnEnd = {};
    // terminal_reason "aborted_streaming" / "aborted_tools": an interrupted turn, whatever the subtype says.
    if (/^aborted/.test(String(m.terminal_reason ?? "")) || (recent && failed && (m.subtype === "error_during_execution" || m.subtype === "success"))) end.text = "Interrupted.";
    else if (failed) {
      end.kind = "error";
      end.text = RESULT_ERRORS[m.subtype] ?? (typeof m.result === "string" && m.result ? shortReason(m.result) : "The turn failed.");
      // The longer reason: the error result's `errors`, or a failed reply too long for the one line.
      const why = Array.isArray(m.errors) ? m.errors.filter((x: unknown) => typeof x === "string").join("\n") : typeof m.result === "string" && m.result.length > 300 ? m.result : "";
      const detail = why ? longReason(why, this.o.home) : undefined;
      if (detail && detail !== end.text) end.detail = detail;
    }
    if (recent) this.interruptedAt = 0;

    const seg = this.seg;
    // Tools that never got a result (interrupted mid-call) stop spinning; so does text cut off mid-stream.
    for (const [id, t] of this.tools) this.put({ id: `t-${id}`, kind: "tool", tool: t.tool, category: t.category, summary: t.summary, ...(t.turnId ? { turnId: t.turnId } : {}), status: "error", at: this.iso() });
    this.tools.clear();
    this.texts.clear();
    this.settle();
    if (seg) {
      // The result's duration and tokens are the whole Claude turn: they are this prompt's only if nothing before it in that turn did any work.
      const whole = !this.segs.some((s) => s !== seg && s.work);
      const ms = this.now() - seg.t0;
      this.endTurn(seg.turnId, { ...end, durationMs: whole ? num(m.duration_ms) ?? ms : ms, ...(whole ? { tokens: usageTokens(m.usage) } : {}) });
    } else if (end.text) this.system(end.text, end.kind ?? "system", end.detail ? { detail: end.detail } : {});

    this.prompts.splice(0, last + 1);
    this.seg = undefined;
    this.segs = [];
    if (!this.prompts.length) this.setBusy(false);
    // Without echoes, Claude runs what it holds in order: the next prompt's turn starts now.
    else if (!this.echoes) this.begin(this.prompts[0]!);
  }
}
