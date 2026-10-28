/*
 * Any agent that speaks the Agent Client Protocol (ACP, protocol version 1,
 * agentclientprotocol.com): JSON-RPC 2.0 as JSON lines on the agent's
 * stdin / stdout, the office as the client.
 *
 *   initialize {protocolVersion: 1, clientCapabilities: no fs, no terminal}
 *   session/new {cwd, mcpServers: []} -> {sessionId, modes?}
 *   session/set_mode {sessionId, modeId}   the hire's permission, when offered
 *   session/prompt {sessionId, prompt: [text]} -> {stopReason, usage?}
 *   session/cancel {sessionId}             notification: Interrupt
 *   from the agent:
 *     session/update {sessionId, update}   agent_message_chunk (text),
 *                                          agent_thought_chunk, tool_call,
 *                                          tool_call_update, plan, ...
 *     session/request_permission {sessionId, toolCall, options}
 *                                          -> {outcome: {outcome: "selected", optionId} | {outcome: "cancelled"}}
 *     anything else (fs/*, terminal/*: not offered) gets -32601
 *
 * One prompt runs at a time per session (Command Code refuses a second), so
 * the office holds one sent mid-turn (ChatItem.queued) and sends it when the
 * running prompt returns; an interrupt drops what it holds. Everything
 * between a prompt and its response is that prompt's turn (ChatItem.turnId).
 *
 * Reasoning (agent_thought_chunk) stays out of the chat, as with the other
 * adapters: it only ends the reply text before it. A tool's label comes from
 * its kind and raw input through the office's redaction, never its title
 * (which can hold a whole command line).
 */
import type { Approval, ApprovalAnswer, ChatDiff, ChatItem, PermissionMode } from "../../shared/control.ts";
import type { AgentKind, ToolCategory } from "../../shared/events.ts";
import { shellCategory, shellSummary, toolSummary } from "../../ingest/redact.ts";
import { approvalDetail, ApprovalQueue, changeLines } from "../approvals.ts";
import { ControlError, type PipeProc } from "../types.ts";
import { APPROVAL_TEXT, approvalItem, ChatBase, endGracefully, jsonLines, longReason, num, outputTail, shortReason, tailOf, type TurnEnd } from "./common.ts";
import { addChange, chatDiff, changedOnly, replaceChange, type FileChange } from "./diff.ts";

export const ACP_PROTOCOL_VERSION = 1;

/** What an agent's ACP side does that the protocol leaves open. */
export interface AcpProfile {
  /** The ACP session mode for each of the office's permissions (session/set_mode). */
  modes?: Partial<Record<PermissionMode, string>>;
  /**
   * What PromptResponse.usage counts: "turn" (the end-turn usage RFD's
   * meaning), "session" (a running total, so a turn is what it grew by).
   * Absent: the office doesn't show tokens (the field isn't settled yet).
   */
  usage?: "turn" | "session";
  /** A diff with no oldText: "new" (the spec: a new file) or "unknown" (sent for overwrites too, so what it replaced isn't known). */
  nullOldText?: "new" | "unknown";
}

/**
 * Per agent, from its own ACP side. Command Code 1.84 (`command-code acp`):
 * modes default / auto-accept / plan / dont-ask / bypass; PromptResponse.usage
 * is the session's running total (the turn's own is in _meta); write_file's
 * diff has oldText null whether or not the file existed.
 */
export const ACP_PROFILES: Partial<Record<AgentKind, AcpProfile>> = {
  commandcode: {
    modes: { default: "default", acceptEdits: "auto-accept", plan: "plan", bypass: "bypass" },
    usage: "session",
    nullOldText: "unknown",
  },
};

export interface AcpChatOptions extends AcpProfile {
  proc: PipeProc;
  /** The folder the session works in (session/new cwd, absolute as the agent sees it). */
  cwd: string;
  /** "~/x" for the ready line. */
  where: string;
  /** "Command Code": for the ready line and errors. */
  name: string;
  permission: PermissionMode;
  /** The office's version, as clientInfo. */
  version: string;
  /** Shown as "~" in details (default: this machine's home; "" for none, on a remote). */
  home?: string;
  now?: () => number;
  readyTimeoutMs?: number;
}

interface Label {
  tool: string;
  category: ToolCategory;
  summary: string;
}

/** A tool call as the updates so far describe it (tool_call_update patches it). */
interface Call extends Label {
  kind?: string;
  status?: string;
  rawInput?: unknown;
  locations?: unknown;
  content?: unknown;
  turnId?: string;
  /** When it started running here. */
  t0: number;
  done?: boolean;
}

interface Turn {
  id: string;
  t0: number;
  /** The reply text being streamed now, if any. */
  text?: { id: string; text: string };
  texts: number;
}

interface Waiting {
  text: string;
  item: ChatItem;
  turnId: string;
}

interface Ask {
  rpcId: number | string;
  toolCallId?: string;
  options: { optionId: string; kind: string }[];
  turnId?: string;
}

const NOT_FOUND = -32601;
const AUTH_REQUIRED = -32000;

const STOPS: Record<string, TurnEnd> = {
  cancelled: { text: "Interrupted." },
  max_tokens: { kind: "error", text: "Stopped: it hit the token limit." },
  max_turn_requests: { kind: "error", text: "Stopped: it hit the turn limit." },
};

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const obj = (v: unknown): Record<string, any> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {});

/** The file a call is about: its first location, else a path in its input. */
function callPath(c: { rawInput?: unknown; locations?: unknown }): string | undefined {
  const loc = Array.isArray(c.locations) ? str(c.locations[0]?.path) : undefined;
  const i = obj(c.rawInput);
  return loc ?? str(i.path) ?? str(i.file_path) ?? str(i.filePath) ?? str(i.absolute_path) ?? str(i.file);
}

/** An ACP tool kind + raw input -> the office's label (redacted like every label). */
export function acpLabel(kind: unknown, rawInput: unknown, locations?: unknown): Label {
  const i = obj(rawInput);
  const file = callPath({ rawInput, locations });
  switch (kind) {
    case "execute": {
      const cmd = typeof i.command === "string" || Array.isArray(i.command) ? i.command : undefined;
      return { tool: "shell", category: cmd ? shellCategory(cmd) : "bash", summary: cmd ? shellSummary(cmd) : "$ shell" };
    }
    case "read":
      return { tool: "read", category: "read", summary: toolSummary("read", "read", { file }) };
    case "edit":
    case "delete":
    case "move":
      return { tool: kind, category: "edit", summary: toolSummary(kind === "delete" ? "delete" : "edit", "edit", { file }) };
    case "search":
      // Never the pattern: a regex is input, not a label. A glob filter is.
      return { tool: "search", category: "search", summary: toolSummary("search", "search", { glob: i.glob }) };
    case "fetch":
      return { tool: "fetch", category: "web", summary: toolSummary("fetch", "web", { url: i.url }) };
    case "think":
      return { tool: "think", category: "todo", summary: "Think" };
    case "switch_mode":
      return { tool: "switch_mode", category: "other", summary: "Switch mode" };
    default:
      return { tool: "tool", category: "other", summary: "Tool" };
  }
}

/** Text in a call's content blocks ({type: "content", content: {type: "text"}}). */
function contentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const t = content.filter((c) => c?.type === "content" && c.content?.type === "text" && typeof c.content.text === "string").map((c) => c.content.text).join("\n");
  return t || undefined;
}

/**
 * A call's diff blocks ({type: "diff", path, oldText, newText}) as changes:
 * only the changed lines, since an agent may send whole files as old and new
 * text. No oldText is a new file, unless the profile says the agent sends none
 * for overwrites too.
 */
function contentChanges(content: unknown, nullOldText: "new" | "unknown"): FileChange[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const out: FileChange[] = [];
  for (const c of content) {
    if (c?.type !== "diff" || typeof c.path !== "string" || typeof c.newText !== "string") continue;
    if (typeof c.oldText === "string") out.push(changedOnly(replaceChange(c.path, [{ old: c.oldText, new: c.newText }])));
    else if (nullOldText === "new") out.push(addChange(c.path, c.newText));
    else return undefined;
  }
  return out.length ? out : undefined;
}

/** What a permission ask is about, for Approval.detail: the command, the file and its change, the URL, else the raw input. */
function askDetail(c: Call, home: string | undefined): string | undefined {
  const i = obj(c.rawInput);
  const cmd = Array.isArray(i.command) ? i.command.join(" ") : str(i.command);
  const diffs = Array.isArray(c.content) ? c.content.filter((x) => x?.type === "diff" && typeof x.path === "string") : [];
  const parts: (string | undefined)[] = [];
  if (cmd) parts.push(cmd, str(i.cwd) && `in ${i.cwd}`);
  else if (diffs.length) for (const d of diffs) parts.push(d.path, changeLines(d.oldText ?? "", d.newText));
  else if (str(i.url)) parts.push(i.url);
  else if (callPath(c)) parts.push(callPath(c));
  else if (c.rawInput !== undefined) {
    try {
      const j = JSON.stringify(c.rawInput, null, 1);
      if (j !== "{}") parts.push(j);
    } catch {
      // Not JSON: nothing to show.
    }
  }
  return approvalDetail(parts, home);
}

const PLAN_MARK: Record<string, string> = { completed: "✓", in_progress: "→" };

export class AcpChat extends ChatBase {
  private readonly proc: PipeProc;
  private readonly queue = new ApprovalQueue<Ask>();
  private readonly stderr = tailOf();
  private rpc = 0;
  private readonly waiting = new Map<number, { ok(v: any): void; fail(e: Error & { code?: number }): void }>();
  private readonly backlog: Waiting[] = [];
  private dropped: ChatItem[] = [];
  private cur: Turn | undefined;
  private readonly calls = new Map<string, Call>();
  /** The session's token total at the last prompt response (profile usage "session"). */
  private usageSeen = 0;
  private authHint: string | undefined;
  private stopping = false;
  readonly ready: Promise<void>;

  constructor(private readonly o: AcpChatOptions) {
    super(o.now);
    this.proc = o.proc;
    this.queue.changed.on((a) => this.approvals.emit(a));
    this.proc.onStdout(jsonLines((m) => this.onMessage(m)));
    this.proc.onStderr((d) => this.stderr.push(d));
    this.proc.onExit((e) => {
      for (const w of this.waiting.values()) w.fail(new Error(this.deathReason(e.code)));
      this.waiting.clear();
      this.queue.drain();
      if (!this.stopping && this.isBusy) this.system(`${o.name} exited.`, "error", this.cur ? { turnId: this.cur.id, turnEnd: true } : {});
      this.dropQueued(this.dropped.splice(0));
      this.dropQueued(this.backlog.splice(0).map((w) => w.item), `Not sent: ${o.name} exited.`);
      this.finished(e);
    });
    this.ready = this.start(o.readyTimeoutMs ?? 60_000);
    this.ready.catch(() => {});
  }

  private deathReason(code: number | null): string {
    const last = this.stderr.text().trim().split("\n").pop();
    return shortReason(last || `${this.o.name} exited (${code ?? "signal"}).`);
  }

  private async start(timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error(`${this.o.name} didn't answer its handshake.`)), timeoutMs);
    });
    try {
      await Promise.race([this.handshake(), deadline]);
      this.system(`${this.o.name} is ready in ${this.o.where}.`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async handshake(): Promise<void> {
    const init = await this.request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "agent-visualizer", title: "agent-visualizer", version: this.o.version },
    });
    if (init?.protocolVersion !== ACP_PROTOCOL_VERSION) throw new Error(`${this.o.name} speaks ACP version ${shortReason(init?.protocolVersion, 20)}; the office speaks ${ACP_PROTOCOL_VERSION}.`);
    const auth = Array.isArray(init.authMethods) ? init.authMethods.find((m: any) => typeof m?.description === "string") : undefined;
    this.authHint = auth ? shortReason(auth.description, 200) : undefined;
    let s: any;
    try {
      s = await this.request("session/new", { cwd: this.o.cwd, mcpServers: [] });
    } catch (err) {
      if ((err as { code?: number }).code === AUTH_REQUIRED) throw new Error(`${this.o.name} isn't signed in.${this.authHint ? ` ${this.authHint}` : ""}`);
      throw err;
    }
    const id = s?.sessionId;
    if (typeof id !== "string" || !id) throw new Error(`${this.o.name} started no session.`);
    this.setSessionId(id);
    // The hire's permission: a mode the agent offers, or no start at all (never quietly looser or stricter).
    const want = this.o.modes?.[this.o.permission];
    const modes = obj(s.modes);
    if (want && modes.currentModeId !== want) {
      const offered = Array.isArray(modes.availableModes) && modes.availableModes.some((m: any) => m?.id === want);
      if (!offered) throw new Error(`${this.o.name} didn't offer its "${want}" mode.`);
      await this.request("session/set_mode", { sessionId: id, modeId: want });
    }
  }

  private write(o: unknown): void {
    this.proc.write(JSON.stringify({ jsonrpc: "2.0", ...(o as object) }) + "\n");
  }

  private request(method: string, params: unknown): Promise<any> {
    const id = ++this.rpc;
    return new Promise((ok, fail) => {
      this.waiting.set(id, { ok, fail });
      this.write({ id, method, params });
    });
  }

  async send(text: string): Promise<void> {
    if (!this.sessionId) await this.ready.catch(() => {});
    if (!this.sessionId) throw new ControlError(409, `${this.o.name} isn't running.`);
    const turnId = this.newTurnId();
    const queued = this.isBusy;
    const item = this.user(text, { turnId, queued });
    if (queued) {
      this.backlog.push({ text, item, turnId });
      return;
    }
    void this.prompt({ text, item, turnId }, false);
  }

  private async prompt(w: Waiting, queued: boolean): Promise<void> {
    this.setBusy(true);
    const t: Turn = { id: w.turnId, t0: this.now(), texts: 0 };
    this.cur = t;
    if (queued) this.unqueue(w.item);
    let end: TurnEnd;
    let tokens: number | undefined;
    try {
      const r = await this.request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text: w.text }] });
      const stop = str(r?.stopReason) ?? "end_turn";
      end = STOPS[stop] ?? (stop === "refusal" ? { kind: "error", text: `${this.o.name} refused to go on.` } : {});
      tokens = this.tokensOf(r?.usage);
    } catch (err) {
      // It exited: its exit already closed the turn.
      if (this.exit.fired) return;
      end = { kind: "error", text: shortReason((err as Error).message || `${this.o.name} failed the turn.`) };
      const more = longReason((err as { data?: unknown }).data && JSON.stringify((err as { data?: unknown }).data), this.o.home);
      if (more && more !== end.text) end.detail = more;
    }
    this.closeTurn(t, { ...end, durationMs: this.now() - t.t0, tokens });
  }

  private tokensOf(u: unknown): number | undefined {
    const total = num(obj(u).totalTokens);
    if (total === undefined || !this.o.usage) return undefined;
    if (this.o.usage === "turn") return total;
    const grew = total - this.usageSeen;
    this.usageSeen = total;
    return grew > 0 ? grew : undefined;
  }

  private closeTurn(t: Turn, end: TurnEnd): void {
    this.endText(t);
    for (const [id, c] of this.calls) {
      if (c.turnId !== t.id) continue;
      if (!c.done) this.put({ ...this.toolItem(id, c), status: "error", at: this.iso() });
      this.calls.delete(id);
    }
    this.settle(t.id);
    this.endTurn(t.id, end);
    if (this.cur === t) this.cur = undefined;
    this.setBusy(false);
    this.dropQueued(this.dropped.splice(0));
    const w = this.backlog.shift();
    if (w) void this.prompt(w, true);
  }

  async interrupt(): Promise<void> {
    this.dropped.push(...this.backlog.splice(0).map((w) => w.item));
    // The client answers every open ask "cancelled" when the turn is cancelled.
    for (const p of this.queue.drain()) {
      this.write({ id: p.meta.rpcId, result: { outcome: { outcome: "cancelled" } } });
      this.put(approvalItem(p.approval, APPROVAL_TEXT.interrupted, p.meta.turnId));
    }
    if (!this.isBusy) return this.dropQueued(this.dropped.splice(0));
    if (this.sessionId) this.write({ method: "session/cancel", params: { sessionId: this.sessionId } });
  }

  async answer(a: ApprovalAnswer): Promise<void> {
    const p = this.queue.take(a.id);
    const m = p.meta;
    const pick = (...kinds: string[]) => kinds.map((k) => m.options.find((x) => x.kind === k)).find(Boolean);
    const allow = a.decision === "allow";
    const always = allow && a.always && !!pick("allow_always");
    const opt = allow ? (always ? pick("allow_always") : pick("allow_once", "allow_always")) : pick("reject_once", "reject_always");
    this.write({ id: m.rpcId, result: { outcome: opt ? { outcome: "selected", optionId: opt.optionId } : { outcome: "cancelled" } } });
    const c = m.toolCallId ? this.calls.get(m.toolCallId) : undefined;
    if (c && allow) c.t0 = this.now();
    this.put(approvalItem(p.approval, !opt ? APPROVAL_TEXT.withdrawn : allow ? (always ? APPROVAL_TEXT.always : APPROVAL_TEXT.allowed) : APPROVAL_TEXT.denied, m.turnId));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await endGracefully(this.proc, { endStdin: true, termAfterMs: 3000, killAfterMs: 3000 });
  }

  /* --------------------------------------------------------- messages */

  private onMessage(m: any): void {
    if (m.id !== undefined && m.method === undefined) {
      const w = typeof m.id === "number" ? this.waiting.get(m.id) : undefined;
      if (!w) return;
      this.waiting.delete(m.id);
      if (m.error) w.fail(Object.assign(new Error(shortReason(m.error.message || `${this.o.name} error ${m.error.code}`)), { code: m.error.code, data: m.error.data }));
      else w.ok(m.result);
      return;
    }
    if (typeof m.method !== "string") return;
    if (m.id !== undefined) return this.onRequest(m.method, m.id, m.params ?? {});
    if (m.method === "session/update") this.onUpdate(m.params ?? {});
  }

  private onRequest(method: string, id: number | string, p: any): void {
    if (method === "session/request_permission" && p.sessionId === this.sessionId) return this.ask(id, p);
    this.write({ id, error: { code: NOT_FOUND, message: `agent-visualizer doesn't offer ${method}` } });
  }

  private ask(rpcId: number | string, p: any): void {
    const tc = obj(p.toolCall);
    const toolCallId = str(tc.toolCallId);
    const known = toolCallId ? this.calls.get(toolCallId) : undefined;
    const c: Call = this.merge(known, tc);
    const options = (Array.isArray(p.options) ? p.options : []).filter((x: any) => typeof x?.optionId === "string").map((x: any) => ({ optionId: x.optionId, kind: String(x.kind ?? "") }));
    const detail = askDetail(c, this.o.home);
    const always = options.some((x: { kind: string }) => x.kind === "allow_always");
    const approval: Approval = { id: String(rpcId), tool: c.tool, category: c.category, summary: c.summary, ...(detail ? { detail } : {}), ...(always ? {} : { noAlways: true }), at: this.iso() };
    const turnId = known?.turnId ?? this.cur?.id;
    this.queue.add(approval, { rpcId, toolCallId, options, turnId });
    this.put(approvalItem(approval, APPROVAL_TEXT.open, turnId));
  }

  /** A tool call with an update's fields laid over it (omitted fields stay), relabelled. */
  private merge(c: Call | undefined, u: Record<string, any>): Call {
    const next: Call = { ...(c ?? { tool: "tool", category: "other", summary: "Tool", t0: this.now(), turnId: this.cur?.id }) };
    for (const k of ["kind", "status", "rawInput", "locations", "content"] as const) if (u[k] !== undefined && u[k] !== null) (next as any)[k] = u[k];
    Object.assign(next, acpLabel(next.kind, next.rawInput, next.locations));
    return next;
  }

  private toolItem(id: string, c: Call): ChatItem {
    return { id: `t-${id}`, kind: "tool", tool: c.tool, category: c.category, summary: c.summary, ...(c.turnId ? { turnId: c.turnId } : {}), at: this.iso() };
  }

  private onUpdate(p: any): void {
    if (p.sessionId !== this.sessionId) return;
    const u = obj(p.update);
    const t = this.cur;
    switch (u.sessionUpdate) {
      case "agent_message_chunk": {
        const text = u.content?.type === "text" && typeof u.content.text === "string" ? u.content.text : "";
        if (!t || !text) return;
        const id = typeof u.messageId === "string" ? `a-${u.messageId}` : t.text?.id ?? `a-${t.id}-${++t.texts}`;
        if (t.text && t.text.id !== id) this.endText(t);
        t.text = { id, text: (t.text?.text ?? "") + text };
        if (t.text.text.trim()) this.stream({ id, kind: "assistant", text: t.text.text, turnId: t.id, at: this.iso() });
        return;
      }
      case "agent_thought_chunk":
        if (t) this.endText(t);
        return;
      case "tool_call":
      case "tool_call_update":
        return this.onCall(u);
      case "plan": {
        if (!t || !Array.isArray(u.entries)) return;
        this.endText(t);
        const entries = u.entries.filter((e: any) => typeof e?.content === "string");
        const lines = entries.map((e: any) => `${PLAN_MARK[e.status] ?? "·"} ${e.content.replace(/\s+/g, " ")}`);
        const detail = approvalDetail([lines.join("\n")], this.o.home);
        this.put({ id: `plan-${t.id}`, kind: "tool", tool: "plan", category: "todo", summary: `Plan ${entries.length} step${entries.length === 1 ? "" : "s"}`, status: "ok", turnId: t.id, ...(detail ? { detail } : {}), at: this.iso() });
        return;
      }
      default:
        // user_message_chunk (our own prompt back), usage_update (context size, not the turn's tokens), modes, commands: nothing to show.
        return;
    }
  }

  private onCall(u: Record<string, any>): void {
    const id = str(u.toolCallId);
    if (!id) return;
    if (u.sessionUpdate === "tool_call" && this.cur) this.endText(this.cur);
    const before = this.calls.get(id);
    const c = this.merge(before, u);
    if (before?.status !== "in_progress" && c.status === "in_progress") c.t0 = this.now();
    this.calls.set(id, c);
    if (this.calls.size > 500) this.calls.delete(this.calls.keys().next().value!);
    const ended = c.status === "completed" || c.status === "failed";
    if (!ended) return this.put({ ...this.toolItem(id, c), status: "running" });
    if (c.done) return;
    c.done = true;
    const ok = c.status === "completed";
    const out = contentText(c.content);
    // Output of commands that aren't reads or searches (whose output is file contents), and of failures.
    const detail = (c.kind === "execute" && c.category === "bash") || !ok ? outputTail(out, this.o.home) : undefined;
    const changes = ok && (c.kind === "edit" || c.kind === "delete" || c.kind === "move") ? contentChanges(c.content, this.o.nullOldText ?? "new") : undefined;
    const diff: ChatDiff | undefined = changes ? chatDiff(changes, { cwd: this.o.cwd, home: this.o.home }) : undefined;
    this.put({ ...this.toolItem(id, c), status: ok ? "ok" : "error", durationMs: Math.max(0, this.now() - c.t0), ...(detail ? { detail } : {}), ...(diff ? { diff } : {}) });
  }

  /** The reply text streamed so far is final (a tool call, a thought or the turn's end came after it). */
  private endText(t: Turn): void {
    const x = t.text;
    t.text = undefined;
    if (x && x.text.trim()) this.put({ id: x.id, kind: "assistant", text: x.text, turnId: t.id, streaming: false, at: this.iso() });
  }
}
