/*
 * opencode, driven over its own HTTP server: `opencode serve` in chat mode,
 * and the server inside its TUI (`opencode --port`) in terminal mode, where
 * the page's prompt box, Interrupt and Approve/Deny use the same API while
 * the TUI shows everything too. In the TUI the first answer wins: an
 * approval answered there arrives as permission.replied and closes here.
 *
 *   events  GET /event: message.updated (roles, an assistant message's
 *           tokens), message.part.updated / message.part.delta (text and
 *           tool parts: a tool's input, state.time, output / error),
 *           session.status / session.idle, session.error,
 *           permission.updated (v1) / permission.asked (v2),
 *           permission.replied, session.created and tui.session.select
 *           (which session the TUI shows)
 *
 * opencode has no turn id and no queue of its own here: the office holds a
 * prompt sent mid-turn (ChatItem.queued) and sends it when the session goes
 * idle, so everything between a prompt and that idle is its turn
 * (ChatItem.turnId). An interrupt drops what it holds.
 */
import type { Approval, ApprovalAnswer, ChatItem, PermissionMode } from "../../shared/control.ts";
import type { ToolCategory } from "../../shared/events.ts";
import { categorize } from "../../ingest/categories.ts";
import { shellCategory, shellSummary, toolSummary } from "../../ingest/redact.ts";
import { approvalDetail, ApprovalQueue } from "../approvals.ts";
import type { OpencodeClient, OpencodeEvent } from "../opencode-api.ts";
import { ControlError, type PipeProc } from "../types.ts";
import { APPROVAL_TEXT, approvalItem, ChatBase, endGracefully, num, outputTail, shortReason, tailOf, type TurnEnd } from "./common.ts";
import { addChange, applyPatchChanges, chatDiff, replaceChange, type FileChange } from "./diff.ts";

export interface OpencodeChatOptions {
  client: OpencodeClient;
  /** chat: our own `opencode serve`; tui: the server inside the TUI (no process of its own here). */
  mode: "chat" | "tui";
  proc?: PipeProc;
  where: string;
  permission: PermissionMode;
  /** Shown as "~" in an approval's detail (default: this machine's home). */
  home?: string;
  now?: () => number;
  readyTimeoutMs?: number;
}

const SHELLS = new Set(["bash", "shell"]);

/** opencode tool or permission + its input -> the office's label. */
export function opencodeLabel(tool: string, input: Record<string, any>): { category: ToolCategory; summary: string } {
  const name = tool || "tool";
  if (SHELLS.has(name)) {
    const cmd = input.command ?? "";
    return { category: shellCategory(cmd), summary: shellSummary(cmd) };
  }
  const category = categorize(name);
  return {
    category,
    summary: toolSummary(name, category, {
      file: input.filePath ?? input.file_path ?? input.filepath ?? (category === "edit" || category === "read" ? input.path : undefined),
      url: input.url,
      glob: input.pattern ?? input.include,
      path: input.path,
      subagentType: input.subagent_type,
    }),
  };
}

/** An edit tool's change, from its input: edit / multiedit / write / apply_patch (patch). */
function opencodeChanges(tool: string, input: Record<string, any>, metadata: Record<string, any>): FileChange[] | undefined {
  const file = typeof input.filePath === "string" ? input.filePath : typeof input.path === "string" ? input.path : undefined;
  switch (tool) {
    case "edit":
      return file ? [replaceChange(file, [{ old: input.oldString, new: input.newString }])] : undefined;
    case "multiedit":
      return file && Array.isArray(input.edits) ? [replaceChange(file, input.edits.map((e: any) => ({ old: e?.oldString, new: e?.newString })))] : undefined;
    case "write":
      // Only a file it created: over an existing one, what it replaced isn't in the input.
      return file && metadata.exists === false ? [addChange(file, input.content)] : undefined;
    case "apply_patch":
    case "patch":
      return applyPatchChanges(input.patchText);
    default:
      return undefined;
  }
}

/** opencode's own token total for a message (its `total`, else the sum of its parts). */
function messageTokens(t: any): number | undefined {
  if (!t || typeof t !== "object") return undefined;
  const total = num(t.total);
  if (total !== undefined) return total;
  const parts = [t.input, t.output, t.reasoning, t.cache?.read, t.cache?.write].map(num);
  return parts.some((x) => x !== undefined) ? parts.reduce<number>((a, b) => a + (b ?? 0), 0) : undefined;
}

interface Turn {
  id: string;
  t0: number;
  /** How it ended, if opencode said before going idle (an abort, an error). */
  end?: TurnEnd;
}

interface Waiting {
  text: string;
  item: ChatItem;
  turnId: string;
}

interface Tool {
  tool: string;
  category: ToolCategory;
  summary: string;
  turnId?: string;
  t0: number;
  /** The latest non-empty input (a completed state may repeat it or not). */
  input: Record<string, any>;
}

export class OpencodeChat extends ChatBase {
  private readonly queue = new ApprovalQueue<{ sessionId: string; turnId?: string }>();
  private readonly stderr = tailOf();
  private readonly roles = new Map<string, string>();
  /** Text parts seen before their message's role. */
  private readonly unrouted = new Map<string, { messageId: string; text: string }>();
  private readonly texts = new Map<string, string>();
  private readonly tools = new Map<string, Tool>();
  private readonly backlog: Waiting[] = [];
  /** Prompts an interrupt took out of the backlog: said so once the turn ends. */
  private dropped: ChatItem[] = [];
  private cur: Turn | undefined;
  /** Assistant message id -> its turn and latest token total. */
  private readonly msgTokens = new Map<string, { turnId: string; tokens: number }>();
  private cwd: string | undefined;
  private stream_: { close(): void } | undefined;
  private stopping = false;
  readonly ready: Promise<void>;

  constructor(private readonly o: OpencodeChatOptions) {
    super(o.now);
    this.queue.changed.on((a) => this.approvals.emit(a));
    if (o.proc) {
      o.proc.onStderr((d) => this.stderr.push(d));
      o.proc.onStdout(() => {});
      o.proc.onExit((e) => {
        this.stream_?.close();
        this.queue.drain();
        if (!this.stopping && this.isBusy) this.system("opencode exited.", "error", this.cur ? { turnId: this.cur.id, turnEnd: true } : {});
        this.dropQueued(this.dropped.splice(0));
        this.dropQueued(this.backlog.splice(0).map((w) => w.item), "Not sent: opencode exited.");
        this.finished(e);
      });
    }
    this.ready = this.start(o.readyTimeoutMs ?? 90_000);
    this.ready.catch(() => {});
  }

  get client(): OpencodeClient {
    return this.o.client;
  }

  /** The session the page drives: ours in chat mode, the one the TUI shows in terminal mode. */
  get session(): string | undefined {
    return this.sessionId;
  }

  private async start(timeoutMs: number): Promise<void> {
    const ac = new AbortController();
    const dead = this.o.proc ? new Promise<never>((_, rej) => this.o.proc!.onExit(() => {
      ac.abort();
      rej(new Error(shortReason(this.stderr.text().trim().split("\n").pop() || "opencode exited before it was ready.")));
    })) : undefined;
    dead?.catch(() => {});
    const go = async () => {
      await this.o.client.ready(timeoutMs, ac.signal);
      this.stream_ = this.o.client.events((e) => this.onEvent(e));
      if (this.o.mode === "chat") {
        this.setSessionId(await this.o.client.createSession());
        this.system(`opencode is ready in ${this.o.where}.`);
      }
    };
    await (dead ? Promise.race([go(), dead]) : go());
  }

  async send(text: string): Promise<void> {
    await this.ready;
    if (!this.sessionId) throw new ControlError(409, "opencode has no session yet.");
    const turnId = this.newTurnId();
    const queued = this.isBusy;
    const item = this.user(text, { turnId, queued });
    if (queued) {
      this.backlog.push({ text, item, turnId });
      return;
    }
    await this.prompt({ text, item, turnId }, false);
  }

  private async prompt(w: Waiting, queued: boolean): Promise<void> {
    this.setBusy(true);
    const t: Turn = { id: w.turnId, t0: this.now() };
    this.cur = t;
    if (queued) this.unqueue(w.item);
    try {
      await this.o.client.promptAsync(this.sessionId!, w.text, this.o.permission === "plan" ? "plan" : undefined);
    } catch (err) {
      if (this.cur !== t) return;
      this.endTurn(t.id, { kind: "error", text: shortReason((err as Error).message || "opencode refused the prompt."), durationMs: this.now() - t.t0 });
      this.turnDone();
    }
  }

  /** The turn new items belong to; in terminal mode one the TUI started has an id of its own. */
  private turn(): Turn | undefined {
    if (!this.cur && this.isBusy) this.cur = { id: this.newTurnId(), t0: this.now() };
    return this.cur;
  }

  /** The running turn is over: the next held prompt, if any, gets its turn. */
  private turnDone(): void {
    this.cur = undefined;
    this.setBusy(false);
    this.dropQueued(this.dropped.splice(0));
    const w = this.backlog.shift();
    if (w) void this.prompt(w, true);
  }

  async interrupt(): Promise<void> {
    this.dropped.push(...this.backlog.splice(0).map((w) => w.item));
    if (!this.isBusy) this.dropQueued(this.dropped.splice(0));
    if (!this.sessionId) return;
    await this.o.client.abort(this.sessionId).catch(() => {});
  }

  async answer(a: ApprovalAnswer): Promise<void> {
    const p = this.queue.get(a.id);
    if (!p) throw new ControlError(409, "That approval is no longer open.");
    const response = a.decision === "allow" ? (a.always ? "always" : "once") : "reject";
    await this.o.client.replyPermission(p.meta.sessionId, a.id, response);
    if (this.queue.drop(a.id)) this.put(approvalItem(p.approval, response === "reject" ? APPROVAL_TEXT.denied : response === "always" ? APPROVAL_TEXT.always : APPROVAL_TEXT.allowed, p.meta.turnId));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.stream_?.close();
    if (this.o.proc) await endGracefully(this.o.proc, { endStdin: false, termAfterMs: 3000, killAfterMs: 1 });
  }

  /** Terminal mode: stop listening (the TUI's own exit ends the session). */
  close(): void {
    this.stream_?.close();
    this.queue.drain();
  }

  private ours(sessionId: unknown): boolean {
    return typeof sessionId === "string" && sessionId === this.sessionId;
  }

  private onEvent(e: OpencodeEvent): void {
    const p = e.properties ?? {};
    switch (e.type) {
      case "session.created":
      case "session.updated": {
        const info = p.info ?? {};
        // The TUI's session: the newest top-level one (subagents have a parent).
        if (this.o.mode === "tui" && e.type === "session.created" && typeof info.id === "string" && !info.parentID) this.setSessionId(info.id);
        return;
      }
      case "tui.session.select":
        if (this.o.mode === "tui" && typeof p.sessionID === "string") this.setSessionId(p.sessionID);
        return;
      case "message.updated": {
        const info = p.info ?? {};
        if (typeof info.id !== "string" || typeof info.role !== "string") return;
        this.roles.set(info.id, info.role);
        if (this.roles.size > 500) this.roles.delete(this.roles.keys().next().value!);
        const mine = info.role === "assistant" && this.ours(info.sessionID);
        // An assistant message names the folder it works in: diff file names are relative to it.
        if (mine && typeof info.path?.cwd === "string") this.cwd = info.path.cwd;
        const tokens = mine ? messageTokens(info.tokens) : undefined;
        if (tokens !== undefined) {
          // A message counts toward the turn it was first seen in.
          const turnId = this.msgTokens.get(info.id)?.turnId ?? this.turn()?.id;
          if (turnId) this.msgTokens.set(info.id, { turnId, tokens });
          if (this.msgTokens.size > 500) this.msgTokens.delete(this.msgTokens.keys().next().value!);
        }
        for (const [partId, u] of this.unrouted) {
          if (u.messageId !== info.id) continue;
          this.unrouted.delete(partId);
          if (info.role === "assistant") this.text(partId, u.text, true);
        }
        return;
      }
      case "message.part.updated": {
        const part = p.part ?? {};
        if (!this.ours(part.sessionID) || typeof part.id !== "string") return;
        if (part.type === "text" && typeof part.text === "string") {
          const role = this.roles.get(part.messageID);
          if (role === "user" || part.synthetic) return;
          if (role === "assistant") this.text(part.id, part.text, !!part.time?.end);
          else this.unrouted.set(part.id, { messageId: part.messageID, text: part.text });
          return;
        }
        if (part.type === "tool") this.tool(part);
        return;
      }
      case "message.part.delta": {
        if (!this.ours(p.sessionID) || typeof p.partID !== "string" || p.field !== "text" || typeof p.delta !== "string") return;
        const id = `p-${p.partID}`;
        if (this.roles.get(p.messageID) !== "assistant") return;
        this.text(p.partID, (this.texts.get(id) ?? "") + p.delta, false);
        return;
      }
      case "session.status":
        if (!this.ours(p.sessionID)) return;
        if (p.status?.type === "busy") this.setBusy(true);
        else if (p.status?.type === "idle") this.idle();
        return;
      case "session.idle":
        if (this.ours(p.sessionID)) this.idle();
        return;
      case "session.error": {
        if (p.sessionID && !this.ours(p.sessionID)) return;
        const name = p.error?.name;
        const end: TurnEnd = name === "MessageAbortedError" ? { text: "Interrupted." } : { kind: "error", text: shortReason(p.error?.data?.message || name || "opencode reported an error.") };
        // The idle that follows closes the turn, on this item.
        if (this.cur && this.isBusy) this.cur.end = end;
        else this.system(end.text!, end.kind ?? "system");
        return;
      }
      case "permission.updated":
      case "permission.asked":
        return this.ask(p);
      case "permission.replied": {
        const id = p.permissionID ?? p.requestID;
        if (typeof id !== "string") return;
        const gone = this.queue.drop(id);
        if (gone) this.put(approvalItem(gone.approval, p.response === "reject" || p.reply === "reject" ? APPROVAL_TEXT.denied : APPROVAL_TEXT.withdrawn));
        return;
      }
      default:
        return;
    }
  }

  private text(partId: string, text: string, final: boolean): void {
    const id = `p-${partId}`;
    this.texts.set(id, text);
    if (this.texts.size > 200) this.texts.delete(this.texts.keys().next().value!);
    if (!text.trim()) return;
    const turnId = this.turn()?.id;
    const item = { id, kind: "assistant" as const, text, ...(turnId ? { turnId } : {}), at: this.iso() };
    if (final) this.put({ ...item, streaming: false });
    else this.stream(item);
  }

  private tool(part: any): void {
    const id = `t-${part.callID ?? part.id}`;
    const st = part.state ?? {};
    const input: Record<string, any> = st.input && typeof st.input === "object" ? st.input : {};
    let t = this.tools.get(id);
    if (!t || Object.keys(input).length) {
      const tool = typeof part.tool === "string" ? part.tool : "tool";
      t = { tool, ...opencodeLabel(tool, input), turnId: t?.turnId ?? this.turn()?.id, t0: t?.t0 ?? this.now(), input: Object.keys(input).length ? input : t?.input ?? {} };
      this.tools.set(id, t);
      if (this.tools.size > 500) this.tools.delete(this.tools.keys().next().value!);
    }
    const status = st.status === "completed" ? "ok" : st.status === "error" ? "error" : "running";
    const base = { id, kind: "tool" as const, tool: t.tool, category: t.category, summary: t.summary, ...(t.turnId ? { turnId: t.turnId } : {}) };
    if (status === "running") return this.put({ ...base, status, at: this.iso() });
    this.tools.delete(id);
    // opencode stamps a tool's start and end (ms); failing that, as seen here.
    const start = num(st.time?.start), end = num(st.time?.end);
    const durationMs = start !== undefined && end !== undefined ? end - start : this.now() - t.t0;
    // Output of shell commands that aren't reads or searches (whose output is file contents), and a failure's error.
    const detail = status === "error" ? outputTail(st.error, this.o.home) : SHELLS.has(t.tool) && t.category === "bash" ? outputTail(st.output, this.o.home) : undefined;
    const changes = status === "ok" ? opencodeChanges(t.tool, t.input, st.metadata && typeof st.metadata === "object" ? st.metadata : {}) : undefined;
    const diff = changes ? chatDiff(changes, { cwd: this.cwd, home: this.o.home }) : undefined;
    this.put({ ...base, status, ...(durationMs >= 0 ? { durationMs } : {}), ...(detail ? { detail } : {}), ...(diff ? { diff } : {}), at: this.iso() });
  }

  private ask(p: any): void {
    if (typeof p.id !== "string" || typeof p.sessionID !== "string") return;
    const tool = String(p.type ?? p.permission ?? "tool");
    const patterns: string[] = Array.isArray(p.patterns) ? p.patterns : Array.isArray(p.pattern) ? p.pattern : typeof p.pattern === "string" ? [p.pattern] : [];
    const meta = p.metadata ?? {};
    const input = SHELLS.has(tool) ? { command: meta.command ?? patterns[0] ?? "" } : { filePath: meta.filepath ?? meta.filePath ?? meta.path ?? patterns[0], url: meta.url };
    const { category, summary } = opencodeLabel(tool, input);
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    const detail = approvalDetail(
      SHELLS.has(tool)
        ? [str(meta.command) ?? patterns.join("\n")]
        : [str(meta.filepath) ?? str(meta.filePath) ?? str(meta.path), str(meta.url), str(meta.diff), !meta.diff && !meta.filepath && !meta.filePath && !meta.path ? patterns.join("\n") : undefined],
      this.o.home,
    );
    const approval: Approval = { id: p.id, tool, category, summary, ...(detail ? { detail } : {}), at: this.iso() };
    if (this.o.mode === "chat" && this.o.permission === "bypass") {
      // Bypass in chat mode: serve has no --auto, so the office says yes to each request itself.
      void this.o.client.replyPermission(p.sessionID, p.id, "once").catch(() => {});
      return;
    }
    if (this.queue.get(p.id)) return;
    const turnId = this.ours(p.sessionID) ? this.turn()?.id : undefined;
    this.queue.add(approval, { sessionId: p.sessionID, turnId });
    this.put(approvalItem(approval, APPROVAL_TEXT.open, turnId));
  }

  private idle(): void {
    if (!this.isBusy) return;
    for (const [id, t] of this.tools) this.put({ id, kind: "tool", tool: t.tool, category: t.category, summary: t.summary, ...(t.turnId ? { turnId: t.turnId } : {}), status: "error", at: this.iso() });
    this.tools.clear();
    this.settle();
    const t = this.cur;
    if (t) {
      let tokens: number | undefined;
      for (const m of this.msgTokens.values()) if (m.turnId === t.id) tokens = (tokens ?? 0) + m.tokens;
      this.endTurn(t.id, { ...t.end, durationMs: this.now() - t.t0, tokens });
    }
    this.turnDone();
  }
}
