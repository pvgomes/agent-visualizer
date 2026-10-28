/*
 * Codex in chat mode: `codex app-server` on stdio, JSON-RPC as JSON lines
 * without the "jsonrpc" field.
 *
 *   initialize -> initialized -> thread/start {cwd, approvalPolicy, sandbox}
 *   turn/start per prompt (queued here while a turn runs), turn/interrupt
 *   notifications: item/started {startedAtMs}, item/agentMessage/delta,
 *                  item/completed {completedAtMs}, turn/started,
 *                  turn/completed {turn.status, turn.durationMs},
 *                  thread/tokenUsage/updated, error, serverRequest/resolved
 *   server requests: item/commandExecution/requestApproval and
 *                    item/fileChange/requestApproval (answered here), anything
 *                    else gets -32601 and a note that only its terminal can answer
 *
 * The office holds a prompt sent mid-turn (ChatItem.queued) and starts its
 * turn when the running one completes; an interrupt drops what it holds.
 * Each office turn (ChatItem.turnId) is bound to Codex's turn id, which every
 * item notification names, so items land in their turn exactly.
 *
 * thread/start records the folder as trusted in ~/.codex/config.toml, the
 * same as answering "yes" in Codex's own TUI; the user chose the folder.
 * The thread id names the rollout file, so it is the exact link to the
 * transcript worker.
 */
import type { ApprovalAnswer, ChatItem, PermissionMode } from "../../shared/control.ts";
import type { ToolCategory } from "../../shared/events.ts";
import { categorize } from "../../ingest/categories.ts";
import { mcpSummary, shellCategory, shellSummary, toolSummary } from "../../ingest/redact.ts";
import { CODEX_POLICY } from "../agents.ts";
import { approvalDetail, ApprovalQueue } from "../approvals.ts";
import { ControlError, type PipeProc } from "../types.ts";
import { APPROVAL_TEXT, approvalItem, ChatBase, endGracefully, jsonLines, longReason, num, outputTail, shortReason, tailOf, type TurnEnd } from "./common.ts";
import { addChange, chatDiff, unifiedChange, type FileChange } from "./diff.ts";

export interface CodexChatOptions {
  proc: PipeProc;
  cwd: string;
  where: string;
  permission: PermissionMode;
  version: string;
  /** Shown as "~" in an approval's detail (default: this machine's home; "" for none, on a remote). */
  home?: string;
  now?: () => number;
  readyTimeoutMs?: number;
}

interface Label {
  tool: string;
  category: ToolCategory;
  summary: string;
}

/** A tool item seen starting. */
interface Running extends Label {
  turnId?: string;
  startedAtMs?: number;
  t0: number;
  /** A fileChange's change, from its item/started. */
  changes?: FileChange[];
}

/** One office turn: a prompt and what Codex did for it. */
interface Turn {
  id: string;
  t0: number;
  codex?: string;
  /** thread/tokenUsage/updated totals before this turn's first model call and after its latest. */
  usageFrom?: number;
  usageTo?: number;
}

interface Waiting {
  text: string;
  item: ChatItem;
  turnId: string;
}

const NOT_FOUND = -32601;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * A fileChange's changes as diffs: an added file's lines (the patch's own),
 * an update's +/- lines, a deleted file's line count only (its contents are
 * the file's, not the patch's).
 */
function codexChanges(changes: unknown): FileChange[] {
  const out: FileChange[] = [];
  for (const c of Array.isArray(changes) ? changes : []) {
    const path = str(c?.path);
    if (!path) continue;
    const kind = typeof c.kind === "string" ? c.kind : str(c.kind?.type);
    const target = str(c.kind?.move_path) ?? str(c.kind?.movePath) ?? path;
    const diff = str(c.diff) ?? str(c.unified_diff) ?? str(c.content);
    if (kind === "add") out.push(addChange(target, diff));
    else if (kind === "delete") out.push({ path, lines: [], added: 0, removed: diff ? diff.replace(/\n$/, "").split("\n").length : 0 });
    else out.push(unifiedChange(target, diff));
  }
  return out;
}

export class CodexChat extends ChatBase {
  private readonly proc: PipeProc;
  private readonly queue = new ApprovalQueue<{ rpcId: number | string; turnId?: string }>();
  private readonly stderr = tailOf();
  private rpc = 0;
  private readonly waiting = new Map<number, { ok(v: any): void; fail(e: Error): void }>();
  private threadId: string | undefined;
  private turnId: string | undefined;
  private readonly backlog: Waiting[] = [];
  /** Prompts an interrupt took out of the backlog: said so once the turn ends. */
  private dropped: ChatItem[] = [];
  private cur: Turn | undefined;
  private readonly byCodex = new Map<string, Turn>();
  /** The thread's token total so far (thread/tokenUsage/updated). */
  private usageTotal = 0;
  private readonly labels = new Map<string, Running>();
  /** itemId -> what an edit changes (its files and diffs), for the approval that follows. */
  private readonly changes = new Map<string, string>();
  private readonly texts = new Map<string, string>();
  private stopping = false;
  readonly ready: Promise<void>;

  constructor(private readonly o: CodexChatOptions) {
    super(o.now);
    this.proc = o.proc;
    this.queue.changed.on((a) => this.approvals.emit(a));
    this.proc.onStdout(jsonLines((m) => this.onMessage(m)));
    this.proc.onStderr((d) => this.stderr.push(d));
    this.proc.onExit((e) => {
      for (const w of this.waiting.values()) w.fail(new Error(this.deathReason(e.code)));
      this.waiting.clear();
      this.queue.drain();
      if (!this.stopping && this.isBusy) this.system("Codex exited.", "error", this.cur ? { turnId: this.cur.id, turnEnd: true } : {});
      this.dropQueued(this.dropped.splice(0));
      this.dropQueued(this.backlog.splice(0).map((w) => w.item), "Not sent: Codex exited.");
      this.finished(e);
    });
    this.ready = this.start(o.readyTimeoutMs ?? 60_000);
    this.ready.catch(() => {});
  }

  private deathReason(code: number | null): string {
    const last = this.stderr.text().trim().split("\n").pop();
    return shortReason(last || `Codex exited (${code ?? "signal"}).`);
  }

  private async start(timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error("Codex didn't answer its handshake.")), timeoutMs);
    });
    try {
      await Promise.race([
        (async () => {
          await this.request("initialize", { clientInfo: { name: "agent-visualizer", title: "agent-visualizer", version: this.o.version }, capabilities: null });
          this.notify("initialized");
          const policy = CODEX_POLICY[this.o.permission] ?? CODEX_POLICY.default;
          const r = await this.request("thread/start", { cwd: this.o.cwd, approvalPolicy: policy.approvalPolicy, sandbox: policy.sandbox });
          const id = r?.thread?.id;
          if (typeof id !== "string" || !id) throw new Error("Codex started no thread.");
          this.threadId = id;
          this.setSessionId(id);
        })(),
        deadline,
      ]);
      this.system(`Codex is ready in ${this.o.where}.`);
    } finally {
      clearTimeout(timer);
    }
  }

  private write(o: unknown): void {
    this.proc.write(JSON.stringify(o) + "\n");
  }

  private request(method: string, params: unknown): Promise<any> {
    const id = ++this.rpc;
    return new Promise((ok, fail) => {
      this.waiting.set(id, { ok, fail });
      this.write({ method, id, params });
    });
  }

  private notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  async send(text: string): Promise<void> {
    if (!this.threadId) await this.ready.catch(() => {});
    if (!this.threadId) throw new ControlError(409, "Codex isn't running.");
    const turnId = this.newTurnId();
    const queued = this.isBusy;
    const item = this.user(text, { turnId, queued });
    if (queued) {
      this.backlog.push({ text, item, turnId });
      return;
    }
    await this.startTurn({ text, item, turnId }, false);
  }

  private async startTurn(w: Waiting, queued: boolean): Promise<void> {
    if (!this.threadId) return;
    this.setBusy(true);
    const t: Turn = { id: w.turnId, t0: this.now() };
    this.cur = t;
    if (queued) this.unqueue(w.item);
    try {
      const r = await this.request("turn/start", { threadId: this.threadId, input: [{ type: "text", text: w.text, text_elements: [] }] });
      // turn/started may have bound it already, or the turn may even be over by now.
      if (typeof r?.turn?.id === "string" && this.cur === t) {
        this.turnId = r.turn.id;
        this.bind(t, r.turn.id);
      }
    } catch (err) {
      // It exited: its exit already closed the turn.
      if (this.exit.fired) return;
      this.endTurn(t.id, { kind: "error", text: shortReason((err as Error).message || "Codex refused the turn."), durationMs: this.now() - t.t0 });
      this.turnDone();
    }
  }

  private bind(t: Turn, codexTurn: string): void {
    if (t.codex) return;
    t.codex = codexTurn;
    this.byCodex.set(codexTurn, t);
    if (this.byCodex.size > 64) this.byCodex.delete(this.byCodex.keys().next().value!);
  }

  /** The office turn a notification is about: by Codex's turn id, else the running one. */
  private turnOf(p: any): Turn | undefined {
    return (typeof p?.turnId === "string" ? this.byCodex.get(p.turnId) : undefined) ?? this.cur;
  }

  /** The running turn is over: the next held prompt, if any, gets its turn. */
  private turnDone(): void {
    this.cur = undefined;
    this.turnId = undefined;
    this.setBusy(false);
    this.dropQueued(this.dropped.splice(0));
    const w = this.backlog.shift();
    if (w) void this.startTurn(w, true);
  }

  async interrupt(): Promise<void> {
    this.dropped.push(...this.backlog.splice(0).map((w) => w.item));
    for (const p of this.queue.drain()) {
      this.write({ id: p.meta.rpcId, result: { decision: "cancel" } });
      this.put(approvalItem(p.approval, APPROVAL_TEXT.interrupted, p.meta.turnId));
    }
    if (!this.isBusy) this.dropQueued(this.dropped.splice(0));
    if (!this.threadId || !this.turnId || !this.isBusy) return;
    try {
      await this.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId });
    } catch {
      // -32600 "no active turn": it had already finished.
    }
  }

  async answer(a: ApprovalAnswer): Promise<void> {
    const p = this.queue.take(a.id);
    const decision = a.decision === "allow" ? (a.always ? "acceptForSession" : "accept") : "decline";
    this.write({ id: p.meta.rpcId, result: { decision } });
    this.put(approvalItem(p.approval, a.decision === "allow" ? (a.always ? APPROVAL_TEXT.always : APPROVAL_TEXT.allowed) : APPROVAL_TEXT.denied, p.meta.turnId));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await endGracefully(this.proc, { endStdin: true, termAfterMs: 3000, killAfterMs: 3000 });
  }

  private onMessage(m: any): void {
    if (m.id !== undefined && m.method === undefined) {
      const w = this.waiting.get(m.id);
      if (!w) return;
      this.waiting.delete(m.id);
      if (m.error) w.fail(new Error(shortReason(m.error.message || `Codex error ${m.error.code}`)));
      else w.ok(m.result);
      return;
    }
    if (typeof m.method !== "string") return;
    if (m.id !== undefined) return this.onServerRequest(m.method, m.id, m.params ?? {});
    this.onNotification(m.method, m.params ?? {});
  }

  private onServerRequest(method: string, id: number | string, p: any): void {
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      const known = typeof p.itemId === "string" ? this.labels.get(p.itemId) : undefined;
      const label: Label =
        method === "item/commandExecution/requestApproval"
          ? { tool: "Bash", category: shellCategory(p.command ?? ""), summary: p.command ? shellSummary(p.command) : known?.summary ?? "$ shell" }
          : known ? { tool: known.tool, category: known.category, summary: known.summary } : { tool: "Edit", category: "edit", summary: "Edit files" };
      const command = Array.isArray(p.command) ? p.command.join(" ") : typeof p.command === "string" ? p.command : undefined;
      const why = typeof p.reason === "string" ? `Why it asks: ${p.reason}` : undefined;
      const detail =
        method === "item/commandExecution/requestApproval"
          ? approvalDetail([command, typeof p.cwd === "string" && `in ${p.cwd}`, why], this.o.home)
          : approvalDetail([typeof p.itemId === "string" ? this.changes.get(p.itemId) : undefined, typeof p.grantRoot === "string" && `Write access to ${p.grantRoot}`, why], this.o.home);
      const approval = { id: String(id), ...label, ...(detail ? { detail } : {}), at: this.iso() };
      const turnId = known?.turnId ?? this.turnOf(p)?.id;
      this.queue.add(approval, { rpcId: id, turnId });
      this.put(approvalItem(approval, APPROVAL_TEXT.open, turnId));
      return;
    }
    this.write({ id, error: { code: NOT_FOUND, message: "agent-visualizer can't answer this; use the terminal" } });
    if (/requestUserInput|elicitation|permissions/.test(method)) this.system("Codex asked for input only its own terminal can give. Hire it in terminal mode for that.", "system", this.turnTag(p));
  }

  private turnTag(p: any): Partial<ChatItem> {
    const t = this.turnOf(p);
    return t ? { turnId: t.id } : {};
  }

  private label(item: any): Label | undefined {
    switch (item?.type) {
      case "commandExecution":
        return { tool: "Bash", category: shellCategory(item.command ?? ""), summary: shellSummary(item.command ?? "") };
      case "fileChange": {
        const files = Array.isArray(item.changes) ? item.changes.map((c: any) => c?.path).filter((x: unknown) => typeof x === "string") : [];
        return { tool: "apply_patch", category: "edit", summary: toolSummary("apply_patch", "edit", { files }) };
      }
      case "mcpToolCall": {
        const name = `mcp__${item.server ?? "mcp"}__${item.tool ?? "tool"}`;
        return { tool: name, category: "mcp", summary: mcpSummary(name) };
      }
      case "dynamicToolCall": {
        const tool = typeof item.tool === "string" ? item.tool : "tool";
        const category = categorize(tool);
        return { tool, category, summary: toolSummary(tool, category, {}) };
      }
      case "webSearch":
        return { tool: "web_search", category: "web", summary: "Web search" };
      case "plan":
        return { tool: "update_plan", category: "todo", summary: "Update plan" };
      case "collabAgentToolCall":
        return { tool: "spawn_agent", category: "agent", summary: "Spawn agent" };
      case "imageView":
        return { tool: "view_image", category: "read", summary: "View image" };
      default:
        return undefined;
    }
  }

  private onNotification(method: string, p: any): void {
    if (p.threadId && this.threadId && p.threadId !== this.threadId) return;
    switch (method) {
      case "turn/started":
        if (typeof p.turn?.id === "string") {
          this.turnId = p.turn.id;
          if (this.cur) this.bind(this.cur, p.turn.id);
        }
        this.setBusy(true);
        return;
      case "item/started": {
        const item = p.item ?? {};
        if (typeof item.id !== "string") return;
        const turnId = this.turnOf(p)?.id;
        if (item.type === "agentMessage") {
          if (item.text) this.stream({ id: `i-${item.id}`, kind: "assistant", text: item.text, ...(turnId ? { turnId } : {}), at: this.iso() });
          return;
        }
        const label = this.label(item);
        if (!label) return;
        const run: Running = { ...label, turnId, startedAtMs: num(p.startedAtMs), t0: this.now() };
        if (item.type === "fileChange" && Array.isArray(item.changes)) {
          run.changes = codexChanges(item.changes);
          const text = item.changes
            .map((c: any) => [typeof c?.path === "string" ? c.path : "", typeof c?.diff === "string" ? c.diff : typeof c?.unified_diff === "string" ? c.unified_diff : ""].filter(Boolean).join("\n"))
            .join("\n");
          if (text) this.changes.set(item.id, text);
          if (this.changes.size > 100) this.changes.delete(this.changes.keys().next().value!);
        }
        this.labels.set(item.id, run);
        if (this.labels.size > 500) this.labels.delete(this.labels.keys().next().value!);
        this.put({ id: `i-${item.id}`, kind: "tool", ...label, ...(turnId ? { turnId } : {}), status: "running", at: this.iso() });
        return;
      }
      case "item/agentMessage/delta": {
        if (typeof p.itemId !== "string" || typeof p.delta !== "string") return;
        const id = `i-${p.itemId}`;
        const text = (this.texts.get(id) ?? "") + p.delta;
        this.texts.set(id, text);
        const turnId = this.turnOf(p)?.id;
        this.stream({ id, kind: "assistant", text, ...(turnId ? { turnId } : {}), at: this.iso() });
        return;
      }
      case "item/completed": {
        const item = p.item ?? {};
        if (typeof item.id !== "string") return;
        const id = `i-${item.id}`;
        if (item.type === "agentMessage") {
          const streamed = this.texts.delete(id);
          const turnId = this.turnOf(p)?.id;
          if (typeof item.text === "string" && (item.text.trim() || streamed)) this.put({ id, kind: "assistant", text: item.text, ...(turnId ? { turnId } : {}), streaming: false, at: this.iso() });
          return;
        }
        const run = this.labels.get(item.id);
        const label = run ?? this.label(item);
        if (!label) return;
        this.labels.delete(item.id);
        const bad = item.status === "failed" || item.status === "declined";
        const turnId = run?.turnId ?? this.turnOf(p)?.id;
        // Codex's own durationMs (commands, MCP and dynamic tools), else its started/completed stamps, else as seen here.
        const started = run?.startedAtMs, done = num(p.completedAtMs);
        const durationMs = num(item.durationMs) ?? (started !== undefined && done !== undefined ? done - started : run ? this.now() - run.t0 : undefined);
        let detail: string | undefined;
        // Output of commands that aren't reads or searches (whose output is file contents), and of failed ones.
        if (item.type === "commandExecution" && (label.category === "bash" || bad)) detail = outputTail(item.aggregatedOutput, this.o.home);
        else if (bad && item.type === "mcpToolCall") detail = outputTail(item.error?.message, this.o.home);
        const changes = item.type === "fileChange" && item.status === "completed" ? (Array.isArray(item.changes) && item.changes.length ? codexChanges(item.changes) : run?.changes) : undefined;
        const diff = changes ? chatDiff(changes, { cwd: this.o.cwd, home: this.o.home }) : undefined;
        this.put({
          id,
          kind: "tool",
          tool: label.tool,
          category: label.category,
          summary: label.summary,
          ...(turnId ? { turnId } : {}),
          status: bad ? "error" : "ok",
          ...(durationMs !== undefined && durationMs >= 0 ? { durationMs } : {}),
          ...(detail ? { detail } : {}),
          ...(diff ? { diff } : {}),
          at: this.iso(),
        });
        return;
      }
      case "thread/tokenUsage/updated": {
        // `total` is the thread's running sum: a turn used what it grew by over that turn's updates.
        const total = num(p.tokenUsage?.total?.totalTokens);
        if (total === undefined) return;
        const t = this.turnOf(p);
        if (t) {
          if (t.usageFrom === undefined) t.usageFrom = this.usageTotal;
          t.usageTo = total;
        }
        this.usageTotal = total;
        return;
      }
      case "serverRequest/resolved": {
        const rid = p.requestId ?? p.id;
        if (rid === undefined) return;
        const gone = this.queue.drop(String(rid));
        if (gone) this.put(approvalItem(gone.approval, APPROVAL_TEXT.withdrawn, gone.meta.turnId));
        return;
      }
      case "turn/completed": {
        const t = (typeof p.turn?.id === "string" ? this.byCodex.get(p.turn.id) : undefined) ?? this.cur;
        const status = p.turn?.status;
        const end: TurnEnd = {};
        if (status === "interrupted") end.text = "Interrupted.";
        else if (status === "failed") {
          end.kind = "error";
          end.text = shortReason(p.turn?.error?.message || "The turn failed.");
          const more = longReason(p.turn?.error?.additionalDetails, this.o.home);
          if (more && more !== end.text) end.detail = more;
        }
        for (const [itemId, r] of this.labels) this.put({ id: `i-${itemId}`, kind: "tool", tool: r.tool, category: r.category, summary: r.summary, ...(r.turnId ? { turnId: r.turnId } : {}), status: "error", at: this.iso() });
        this.labels.clear();
        this.texts.clear();
        this.settle();
        if (t) {
          const tokens = t.usageTo !== undefined ? t.usageTo - (t.usageFrom ?? 0) : undefined;
          this.endTurn(t.id, { ...end, durationMs: num(p.turn?.durationMs) ?? this.now() - t.t0, tokens });
        } else if (end.text) this.system(end.text, end.kind ?? "system", end.detail ? { detail: end.detail } : {});
        this.turnDone();
        return;
      }
      case "error":
        // Retries update one line in place ("Reconnecting... 2/5"); a final error gets its own.
        if (p.willRetry) this.put({ id: `retry-${p.turnId ?? this.turnId ?? "x"}`, kind: "system", text: shortReason(p.error?.message || "Retrying…"), ...this.turnTag(p), at: this.iso() });
        else this.system(shortReason(p.error?.message || "Codex reported an error."), "error", this.turnTag(p));
        return;
      default:
        return;
    }
  }
}
