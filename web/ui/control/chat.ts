/*
 * Chat mode: the conversation of an agent driven through its headless
 * protocol, from the chat stream (history first, then live). Items update in
 * place by id; chat/model.ts folds them into turns, this draws them:
 *
 *   ── 10:42 ──                                   a separator per turn
 *                          add retries to the client   the prompt, compact
 *   [worker] Claude Code
 *   ▸ Worked for 42s · 9 tools  Read 4  Edit 3  Bash 2   the work log: tools,
 *       ✓ Edit retry.ts  +38 −0   0.2s  ›                answered approvals and
 *       ✕ $ npm test  (╯°□°)╯︵ ┻━┻ 3.1s ›                in-between notes, open
 *   the reply, as Markdown                                while it works
 *   Done in 42s · 9 tools · 2 files +47 −3 · 12k tokens
 *
 * An approval is a card where the agent asked (and a bar above the composer
 * while that card is out of view); answered, it becomes a line in the log.
 * Prompts sent mid-turn wait in a queue above the composer. The view sticks to
 * the bottom while the agent writes unless the reader scrolled up, then offers
 * a "↓ New" pill, and keeps at most a few hundred items in the DOM.
 *
 * Prompt and reply text appear here and nowhere else in the office. Replies
 * go through the safe Markdown renderer (chat/markdown.ts); everything else is
 * set as text, never markup.
 */
import type { ChatItem, ControlSession } from "../../../src/shared/control.ts";
import type { ToolCategory } from "../../../src/shared/events.ts";
import { h, reducedMotion, setText } from "../dom.ts";
import { glyph, glyphFor, type Glyph } from "../icons.ts";
import { agentName, logo } from "../logos.ts";
import { chatPath, stream, type Stream, type StreamState } from "./api.ts";
import { avatar, seedFor, thoughtBubble } from "./chat/avatar.ts";
import { MarkdownView } from "./chat/markdown.ts";
import { approvalState, CATEGORY_LABEL, ChatModel, compact, dur, isTestRun, READY_RE, stamp, type Phase, type Rec, type Turn } from "./chat/model.ts";
import { PERMISSIONS, placeLabel } from "./format.ts";

export interface ChatActivity {
  phase: Phase;
  /** A turn is running: Send becomes Interrupt. */
  busy: boolean;
  queued: number;
  /** When the current step started (server ms), for elapsed labels. */
  since: number;
}

export interface ChatOpts {
  onState?(s: StreamState, err?: string): void;
  /** The turn started, finished, or the queue changed: the composer and the pill follow. */
  onActivity?(a: ChatActivity): void;
  /** Answer the session's pending approval. */
  onAnswer(decision: "allow" | "deny", always: boolean): Promise<void>;
  /** A starter chip: put this in the composer. */
  onStarter(text: string): void;
  session(): ControlSession | undefined;
  /** The office's worker for this session (its model, its last pose). */
  worker?(): { model?: string; status?: string } | undefined;
}

export interface ChatView {
  el: HTMLElement;
  /** The session changed (status, pending approval). */
  sync(): void;
  /** An office event for this session's worker: a hint for "still working?". */
  hint(kind: string): void;
  activity(): ChatActivity;
  /** The reader sent a prompt: follow the conversation again. */
  sent(): void;
  /** Bring the open approval into view (the sticky bar's label). */
  showApproval(): void;
  dispose(): void;
}

/** Items kept in the DOM before "Show earlier" takes over. */
const DOM_CAP = 400;
/** Rows a work log shows before folding the oldest. */
const LOG_CAP = 80;

const STARTERS: { label: string; prompt: string }[] = [
  { label: "Explain this repo", prompt: "Explain what this repo does and how it's laid out." },
  { label: "Run the tests", prompt: "Run the tests and tell me what fails." },
  { label: "Find TODOs", prompt: "Find the TODOs and FIXMEs in this repo and group them by area." },
];

const VERB: Partial<Record<ToolCategory, string>> = { bash: "run", edit: "edit", read: "read", search: "search", web: "fetch", mcp: "use", agent: "start", todo: "update" };

const FLIP = "(╯°□°)╯︵ ┻━┻";
const AP_WORD: Record<string, string> = { allowed: "Allowed", always: "Always allowed", denied: "Denied", interrupted: "Interrupted", withdrawn: "Answered elsewhere", answered: "Answered" };
const UNFLIP = "┬─┬ノ( º _ ºノ)";

function catGlyph(c: ToolCategory | undefined): Glyph {
  return glyphFor("tool_start", c);
}

/** "Edit src/auth.ts" -> ["Edit", "src/auth.ts"]; "$ npm test" -> ["$", "npm test"]. */
function splitLabel(label: string): [string, string] {
  if (label.startsWith("$ ")) return ["$", label.slice(2)];
  const m = /^([A-Z][A-Za-z]{1,15})\s+(.+)$/.exec(label);
  return m ? [m[1]!, m[2]!] : ["", label];
}

function labelEl(it: ChatItem, cls: string): HTMLElement {
  const text = it.summary || it.tool || "tool";
  const [verb, rest] = splitLabel(text);
  return h("span", { class: cls, attrs: { title: text } }, verb ? h("span", { class: verb === "$" ? "lb-sh" : "lb-verb", text: verb }) : null, h("span", { class: "lb-rest", text: rest }));
}

function reconcile(parent: Element, nodes: Element[]): void {
  let cur = parent.firstElementChild;
  for (const n of nodes) {
    if (n === cur) {
      cur = cur.nextElementSibling;
      continue;
    }
    parent.insertBefore(n, cur);
  }
  while (cur) {
    const nx = cur.nextElementSibling;
    cur.remove();
    cur = nx;
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h("textarea", { attrs: { readonly: true, "aria-hidden": "true" } });
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

function flash(btn: HTMLElement, ok: boolean): void {
  const label = btn.querySelector(".copy-word") ?? btn;
  const was = btn.dataset.word ?? label.textContent ?? "Copy";
  btn.dataset.word = was;
  setText(label, ok ? "Copied" : "Couldn't copy");
  btn.classList.toggle("is-done", ok);
  window.setTimeout(() => {
    setText(label, was);
    btn.classList.remove("is-done");
  }, 1400);
}

const onCopy = (text: string, btn: HTMLElement) => void copyText(text).then((ok) => flash(btn, ok));

/* ------------------------------------------------------------------ rows */

interface RowCtx {
  agent: string;
  expanded: Set<string>;
  pairs: Map<Rec, Rec>;
  /** Passing test runs that followed a failing one: the table goes back up. */
  unflip: Set<string>;
  streaming(r: Rec): boolean;
  toggleRow(id: string): void;
}

/** A row of the work log: a tool, an answered approval, or a note from the agent. */
class Row {
  el: HTMLElement;
  private sig = "";
  private md: MarkdownView | null = null;
  constructor(readonly id: string) {
    this.el = h("li", { class: "wrow" });
  }

  update(r: Rec, ctx: RowCtx): void {
    const it = r.item;
    if (it.kind === "assistant") return this.note(it, ctx.streaming(r));
    const ap = it.kind === "tool" ? ctx.pairs.get(r) : undefined;
    const ms = ChatModel.toolMs(r);
    const open = ctx.expanded.has(this.id);
    const sig = JSON.stringify([it.kind, it.status, it.summary, it.tool, it.text, it.category, it.detail, it.diff, ms, open, ap?.item.text, ctx.unflip.has(this.id)]);
    if (sig === this.sig) return;
    this.sig = sig;
    if (it.kind === "approval") return this.approval(it);
    this.tool(r, it, ms, open, ap, ctx);
  }

  private note(it: ChatItem, streaming: boolean): void {
    if (!this.md) {
      this.md = new MarkdownView(document, { onCopy }, "md md-note");
      this.el.className = "wnote";
      this.el.replaceChildren(this.md.el);
    }
    this.md.set(it.text ?? "", streaming);
  }

  private approval(it: ChatItem): void {
    const st = approvalState(it);
    const word = st === "always" ? "Always allowed" : st === "allowed" ? "Allowed" : st === "denied" ? "Denied" : st === "withdrawn" ? "Answered elsewhere" : st === "interrupted" ? "Interrupted" : "Answered";
    this.el.className = `wap is-${st}`;
    this.el.replaceChildren(
      h("span", { class: "wap-ic" }, glyph(st === "denied" || st === "interrupted" ? "close" : st === "withdrawn" ? "leave" : "pass", 1)),
      h("span", { class: "wap-word", text: word }),
      h("span", { class: "wap-dot", text: "·" }),
      labelEl(it, "wap-label"),
    );
  }

  private tool(r: Rec, it: ChatItem, ms: number | undefined, open: boolean, ap: Rec | undefined, ctx: RowCtx): void {
    const apSt = ap ? approvalState(ap.item) : undefined;
    const denied = apSt === "denied" || apSt === "interrupted" || (apSt === "withdrawn" && it.status === "error");
    const waiting = apSt === "open" && it.status !== "ok" && it.status !== "error";
    const state = denied ? "denied" : waiting ? "wait" : it.status === "error" ? "err" : it.status === "ok" ? "ok" : "run";
    const test = isTestRun(it);
    const diff = it.diff && typeof it.diff.file === "string" ? it.diff : undefined;
    const hasDetail = !!(it.detail?.trim() || diff?.lines?.length);
    const cat = it.category && it.category in CATEGORY_LABEL ? it.category : "other";
    this.el.className = `wrow c-${cat} is-${state}${test ? " is-test" : ""}${hasDetail ? " has-detail" : ""}${open && hasDetail ? " is-open" : ""}`;

    const status =
      state === "run"
        ? h("span", { class: "spin", attrs: { role: "img", "aria-label": "running" } })
        : state === "wait"
          ? h("span", { class: "wrow-tag tag-wait", text: "needs you" })
          : state === "denied"
            ? null
            : h("span", { class: "wrow-st", attrs: { role: "img", "aria-label": state === "ok" ? "done" : "failed" } }, glyph(state === "ok" ? "pass" : "close", 1));
    const apWord = apSt && apSt !== "open" ? AP_WORD[apSt] : "";
    const bits: (Node | null)[] = [
      h("span", { class: "wrow-ic" }, glyph(catGlyph(it.category), 1)),
      apWord ? h("span", { class: `wrow-ap is-${apSt}` }, h("span", { text: apWord }), h("span", { class: "wrow-ap-dot", text: "·" })) : null,
      labelEl(it, "wrow-label"),
      diff ? h("span", { class: "wrow-diff" }, h("span", { class: "d-add", text: `+${diff.added | 0}` }), h("span", { class: "d-del", text: `−${diff.removed | 0}` })) : null,
      test && state === "err" ? h("span", { class: "wrow-flip", attrs: { title: "A test failed. The table did not survive." }, text: FLIP }) : null,
      test && state === "ok" && ctx.unflip.has(this.id) ? h("span", { class: "wrow-flip is-back", attrs: { title: "Tests pass. The table is back." }, text: UNFLIP }) : null,
      h("span", { class: "wrow-gap" }),
      ms !== undefined && state !== "run" && state !== "denied" && state !== "wait" ? h("span", { class: "wrow-dur", text: dur(ms) }) : null,
      status,
      hasDetail ? h("span", { class: "wrow-chev", attrs: { "aria-hidden": "true" } }) : null,
    ];
    const name = `${apWord ? `${apWord}: ` : ""}${it.summary || it.tool || "tool"}: ${state === "run" ? "running" : state === "wait" ? "needs your approval" : state === "denied" ? "not run" : state === "ok" ? "done" : "failed"}${ms !== undefined && state !== "denied" ? `, ${dur(ms)}` : ""}`;
    const main = hasDetail
      ? h("button", { class: "wrow-main", attrs: { type: "button", "aria-expanded": String(open), "aria-label": `${name}. ${open ? "Hide" : "Show"} details` }, on: { click: () => ctx.toggleRow(this.id) } }, ...bits)
      : h("div", { class: "wrow-main", attrs: { "aria-label": name, role: "group" } }, ...bits);
    const kids: Node[] = [main];
    if (hasDetail && open) {
      const det = h("div", { class: "wrow-detail" });
      if (diff?.lines?.length) det.append(diffView(diff.file, diff.added, diff.removed, diff.lines));
      if (it.detail?.trim()) det.append(outputView(it.detail, state === "err"));
      kids.push(det);
    }
    this.el.replaceChildren(...kids);
  }
}

function diffView(file: string, added: number, removed: number, lines: string[]): HTMLElement {
  const body = h("pre", { class: "dv-body", attrs: { tabindex: "0", "aria-label": `Diff of ${file}` } });
  for (const ln of lines.slice(0, 400)) {
    const cls = ln.startsWith("@@") ? "dv-hunk" : ln.startsWith("+") ? "dv-add" : ln.startsWith("-") ? "dv-del" : "dv-ctx";
    body.append(h("span", { class: `dv-line ${cls}`, text: ln || " " }));
  }
  return h(
    "div",
    { class: "dv" },
    h("div", { class: "dv-head" }, glyph("edit", 1), h("span", { class: "dv-file", text: file }), h("span", { class: "d-add", text: `+${added | 0}` }), h("span", { class: "d-del", text: `−${removed | 0}` })),
    body,
  );
}

function outputView(text: string, failed: boolean): HTMLElement {
  const pre = h("pre", { class: `ov${failed ? " is-err" : ""}`, attrs: { tabindex: "0", "aria-label": "Output" } });
  const lines = text.replace(/\s+$/, "").split("\n").slice(-60);
  for (const ln of lines) {
    const bad = /(^|\s)(✗|✕|×|FAIL\b|FAILED\b|Error\b|error:|AssertionError|not ok\b|panicked)/.test(ln);
    const good = /(^|\s)(✓|✔|PASS\b|ok\b|passed\b)/.test(ln) && !bad;
    pre.append(h("span", { class: `ov-line${bad ? " is-bad" : good ? " is-good" : ""}`, text: ln || " " }));
  }
  return pre;
}

/* -------------------------------------------------------------- the log */

class WorkLog {
  el: HTMLElement;
  private head: HTMLButtonElement;
  private headText: HTMLElement;
  private chips: HTMLElement;
  private badges: HTMLElement;
  private list: HTMLOListElement;
  private more: HTMLButtonElement;
  private rows = new Map<string, Row>();
  private showAll = false;

  constructor(
    key: string,
    private readonly toggle: () => void,
    private readonly changed: () => void,
  ) {
    const id = `wlog-${key.replace(/[^\w-]/g, "_")}`;
    this.headText = h("span", { class: "wlog-text" });
    this.chips = h("span", { class: "wlog-chips" });
    this.badges = h("span", { class: "wlog-badges" });
    this.head = h(
      "button",
      { class: "wlog-head", attrs: { type: "button", "aria-expanded": "false", "aria-controls": id }, on: { click: () => this.toggle() } },
      h("span", { class: "wlog-chev", attrs: { "aria-hidden": "true" } }),
      h("span", { class: "wlog-live", attrs: { "aria-hidden": "true" } }),
      this.headText,
      this.chips,
      this.badges,
    );
    this.list = h("ol", { class: "wlog-rows", attrs: { id, "aria-label": "Work log" } });
    this.more = h("button", { class: "wlog-more", attrs: { type: "button" }, on: { click: () => ((this.showAll = true), this.changed()) } });
    this.el = h("section", { class: "wlog" }, this.head, h("div", { class: "wlog-body" }, this.more, this.list));
  }

  update(recs: Rec[], st: ReturnType<ChatModel["stats"]>, running: boolean, open: boolean, ctx: RowCtx, liveLabel: string): void {
    this.el.classList.toggle("is-open", open);
    this.el.classList.toggle("is-live", running);
    this.el.classList.toggle("has-fail", st.lastTest === "error" || st.failed - (st.lastTest === "ok" ? st.testsFailed : 0) > 0);
    this.head.setAttribute("aria-expanded", String(open));
    const tools = `${st.tools} tool${st.tools === 1 ? "" : "s"}`;
    const took = st.endAt > st.startAt ? dur(st.endAt - st.startAt) : "";
    setText(this.headText, running ? liveLabel : st.tools ? (took ? `Worked for ${took} · ${tools}` : tools) : took ? `Worked for ${took}` : "Notes");
    this.chips.replaceChildren(
      ...st.byCategory.map(([c, n]) => h("span", { class: `wchip c-${c}` }, glyph(catGlyph(c), 1), h("span", { text: `${CATEGORY_LABEL[c]} ${n}` }))),
    );
    const badges: Node[] = [];
    const fixed = st.testsFailed > 0 && st.lastTest === "ok";
    const otherFails = st.failed - (fixed ? st.testsFailed : 0);
    if (fixed) badges.push(h("span", { class: "wbadge is-good", attrs: { title: `Tests failed, then passed. ${UNFLIP}` }, text: "tests red → green" }));
    else if (st.testsFailed && st.lastTest === "error") badges.push(h("span", { class: "wbadge is-bad", attrs: { title: FLIP }, text: `tests failing ┻━┻` }));
    if (otherFails > (st.lastTest === "error" ? st.testsFailed : 0)) badges.push(h("span", { class: "wbadge is-bad", text: `${otherFails} failed` }));
    if (st.denied) badges.push(h("span", { class: "wbadge is-denied", text: `${st.denied} denied` }));
    if (st.files && !running) badges.push(h("span", { class: "wbadge is-files" }, h("span", { text: `${st.files} file${st.files === 1 ? "" : "s"}` }), st.added || st.removed ? h("span", { class: "d-add", text: `\u00a0+${st.added}` }) : null, st.added || st.removed ? h("span", { class: "d-del", text: `\u00a0−${st.removed}` }) : null));
    this.badges.replaceChildren(...badges);

    const shown = !open ? [] : this.showAll || recs.length <= LOG_CAP ? recs : recs.slice(-LOG_CAP);
    this.more.hidden = !open || shown.length === recs.length;
    setText(this.more, `Show ${recs.length - shown.length} earlier steps`);
    const keep = new Set<string>();
    const els: HTMLElement[] = [];
    for (const r of shown) {
      let row = this.rows.get(r.item.id);
      if (!row) this.rows.set(r.item.id, (row = new Row(r.item.id)));
      row.update(r, ctx);
      keep.add(r.item.id);
      els.push(row.el);
    }
    for (const k of this.rows.keys()) if (!keep.has(k)) this.rows.delete(k);
    reconcile(this.list, els);
  }
}

/* ------------------------------------------------------------- the turn */

interface ViewCtx {
  model: ChatModel;
  s: ControlSession;
  seed: string;
  pendingId?: string;
  expanded: Set<string>;
  logOpen: Map<string, boolean>;
  userOpen: Set<string>;
  unflip: Set<string>;
  rerender(t: Turn): void;
  answer(decision: "allow" | "deny", always: boolean): void;
}

class TurnView {
  el: HTMLElement;
  private sep: HTMLElement;
  private sepTime: HTMLElement;
  private userEl: HTMLElement | null = null;
  private userSig = "";
  private agentEl: HTMLElement;
  private agentRow: HTMLElement | null = null;
  private agentAva: HTMLElement | null = null;
  private agentState: HTMLElement | null = null;
  private rowBubble: SVGSVGElement | null = null;
  private log: WorkLog | null = null;
  private afterEl: HTMLElement;
  private parts = new Map<string, { el: HTMLElement; sig: string; md?: MarkdownView }>();
  private liveEl: HTMLElement | null = null;
  private liveText: HTMLElement | null = null;
  private foot: HTMLElement;
  rev = -1;

  constructor(readonly turn: Turn) {
    this.sepTime = h("span", { class: "turn-time" });
    this.sep = h("div", { class: "turn-sep", attrs: { role: "separator" } }, this.sepTime);
    this.afterEl = h("div", { class: "turn-after" });
    this.foot = h("div", { class: "turn-foot", attrs: { hidden: true } });
    this.agentEl = h("div", { class: "turn-agent" });
    this.el = h("article", { class: "turn" }, this.sep, this.agentEl);
  }

  /** Draw the turn; returns its approval card if one can be answered now. */
  render(c: ViewCtx): HTMLElement | null {
    const t = this.turn;
    const m = c.model;
    const running = m.running(t);
    const phase = running ? m.phase() : "idle";
    const st = m.stats(t);
    const pre = t.key === "pre";
    this.el.classList.toggle("is-pre", pre);
    this.el.classList.toggle("is-live", running);
    this.el.dataset.turn = t.key;

    // separator and prompt
    this.sep.hidden = pre;
    setText(this.sepTime, stamp(st.startAt));
    if (st.startAt) this.sepTime.title = new Date(st.startAt).toLocaleString();
    if (t.user) this.renderUser(t.user, c);
    else if (this.userEl) {
      this.userEl.remove();
      this.userEl = null;
    }

    const { log, after } = m.parts(t);
    const hasAgent = log.length > 0 || after.length > 0 || running;
    this.agentEl.hidden = !hasAgent;
    if (!hasAgent) return null;

    // the agent's line: its worker, its name
    if (!this.agentRow && !pre) {
      this.agentAva = h("span", { class: "think-ava agent-ava-wrap" }, avatar(c.seed, c.s.agent, { scale: 1.5, cls: "agent-ava" }));
      this.agentState = h("span", { class: "think-text agent-state", attrs: { hidden: true } });
      this.agentRow = h("div", { class: "agent-row" }, this.agentAva, h("span", { class: "agent-row-name", text: agentName(c.s.agent) }), this.agentState);
    }

    const kids: HTMLElement[] = [];
    if (this.agentRow) kids.push(this.agentRow);

    // the work log
    if (log.length) {
      if (!this.log)
        this.log = new WorkLog(
          t.key,
          () => {
            c.logOpen.set(t.key, !this.logOpenNow(c));
            c.rerender(t);
          },
          () => c.rerender(t),
        );
      const tool = phase === "tool" ? [...log].reverse().find((r) => r.item.kind === "tool" && r.item.status !== "ok" && r.item.status !== "error") : undefined;
      const elapsed = dur(Math.max(0, Date.now() - st.startAt));
      const liveLabel =
        phase === "waiting"
          ? `Waiting for you · ${elapsed}`
          : `Working · ${elapsed}${tool ? ` · ${tool.item.summary || tool.item.tool}` : st.tools ? ` · ${st.tools} tool${st.tools === 1 ? "" : "s"}` : ""}`;
      this.log.el.classList.toggle("is-waiting", phase === "waiting");
      this.log.update(log, st, running, this.logOpenNow(c), { agent: c.s.agent, expanded: c.expanded, pairs: m.pairs(t), unflip: c.unflip, streaming: (r) => m.streaming(r), toggleRow: (id) => this.toggleRow(id, c) }, liveLabel);
      kids.push(this.log.el);
    }

    // what comes after: the reply, open approvals, errors, notes
    const keep = new Set<string>();
    const afterEls: HTMLElement[] = [];
    let card: HTMLElement | null = null;
    for (const r of after) {
      const el = this.renderAfter(r, c);
      keep.add(r.item.id);
      afterEls.push(el);
      if (r.item.kind === "approval" && el.classList.contains("is-actionable")) card = el;
    }
    for (const k of this.parts.keys()) if (!keep.has(k)) this.parts.delete(k);
    reconcile(this.afterEl, afterEls);
    if (afterEls.length) kids.push(this.afterEl);

    // thinking: the worker's thought bubble and how long; on its own line once there is something above it
    const early = phase === "thinking" && !log.length && !afterEls.length && !!this.agentRow;
    if (this.agentRow && this.agentAva && this.agentState) {
      this.agentRow.classList.toggle("is-thinking", early);
      this.agentState.hidden = !early;
      if (early) {
        setText(this.agentState, `Thinking · ${dur(Math.max(0, Date.now() - m.since()))}`);
        if (!this.rowBubble) this.agentAva.append((this.rowBubble = thoughtBubble()));
      } else if (this.rowBubble) {
        this.rowBubble.remove();
        this.rowBubble = null;
      }
    }
    if (phase === "thinking" && !early) {
      if (!this.liveEl) {
        this.liveText = h("span", { class: "think-text" });
        this.liveEl = h("div", { class: "turn-think" }, h("span", { class: "think-ava" }, avatar(c.seed, c.s.agent, { scale: 1.5 }), thoughtBubble()), this.liveText);
      }
      setText(this.liveText!, `Thinking · ${dur(Math.max(0, Date.now() - m.since()))}`);
      kids.push(this.liveEl);
    }

    // the footer, once the turn is over
    const showFoot = !running && !pre && (log.length > 0 || after.some((r) => r.item.kind === "assistant"));
    this.foot.hidden = !showFoot;
    if (showFoot) {
      this.renderFoot(t, st, after, c);
      kids.push(this.foot);
    }
    reconcile(this.agentEl, kids);
    return card;
  }

  private logOpenNow(c: ViewCtx): boolean {
    const set = c.logOpen.get(this.turn.key);
    return set ?? c.model.running(this.turn);
  }

  private toggleRow(id: string, c: ViewCtx): void {
    if (c.expanded.has(id)) c.expanded.delete(id);
    else c.expanded.add(id);
    c.rerender(this.turn);
  }

  private renderUser(r: Rec, c: ViewCtx): void {
    const text = r.item.text ?? "";
    const long = text.length > 900 || text.split("\n").length > 14;
    const open = c.userOpen.has(r.item.id);
    const sig = `${text}|${open}`;
    if (this.userEl && sig === this.userSig) return;
    this.userSig = sig;
    const body = h("div", { class: `msg-user-text${long && !open ? " is-clamped" : ""}`, text });
    const el = h(
      "div",
      { class: "msg-user", attrs: { "aria-label": "You said" } },
      body,
      long
        ? h("button", {
            class: "msg-more",
            attrs: { type: "button", "aria-expanded": String(open) },
            text: open ? "Show less" : "Show more",
            on: {
              click: () => {
                if (open) c.userOpen.delete(r.item.id);
                else c.userOpen.add(r.item.id);
                c.rerender(this.turn);
              },
            },
          })
        : null,
    );
    if (this.userEl) this.userEl.replaceWith(el);
    else this.sep.after(el);
    this.userEl = el;
  }

  private renderAfter(r: Rec, c: ViewCtx): HTMLElement {
    const it = r.item;
    const key = it.id;
    let p = this.parts.get(key);
    if (it.kind === "assistant") {
      if (!p?.md) {
        const md = new MarkdownView(document, { onCopy }, "md md-reply");
        p = { el: h("div", { class: "msg-agent" }, md.el), sig: "", md };
        this.parts.set(key, p);
      }
      p.md!.set(it.text ?? "", c.model.streaming(r));
      return p.el;
    }
    let sig: string;
    if (it.kind === "approval") sig = JSON.stringify([it.text, it.summary, it.tool, it.detail, c.pendingId, c.s.status, c.s.pendingApproval?.noAlways]);
    else sig = JSON.stringify([it.kind, it.text, it.detail, it.summary]);
    if (p && p.sig === sig) return p.el;
    let el: HTMLElement;
    if (it.kind === "approval") el = this.card(r, c);
    else if (it.kind === "error") el = errorCard(it);
    else if (it.kind === "user") el = h("div", { class: "msg-user is-mid" }, h("div", { class: "msg-user-text", text: it.text ?? "" }), h("span", { class: "msg-tag", text: "sent while it worked" }));
    else el = h("div", { class: `sys-note${/interrupt/i.test(it.text ?? "") ? " is-int" : ""}`, attrs: { role: "note" } }, glyph(/interrupt/i.test(it.text ?? "") ? "error" : "other", 1), h("span", { text: it.text || it.summary || "" }));
    if (p) p.el.replaceWith(el);
    this.parts.set(key, { el, sig });
    return el;
  }

  private card(r: Rec, c: ViewCtx): HTMLElement {
    const it = r.item;
    const pend = c.s.pendingApproval;
    const actionable = !!pend && c.s.status === "running" && (it.id === `ap-${pend.id}` || it.id === pend.id || (it.summary === pend.summary && it.tool === pend.tool));
    const verb = VERB[it.category ?? "other"] ?? "use";
    const btn = (cls: string, text: string, key: string, fn: () => void) =>
      h("button", { class: `ap-btn ${cls}`, attrs: { type: "button", "aria-keyshortcuts": key, disabled: !actionable }, on: { click: fn } }, h("span", { text }), h("kbd", { text: key }));
    const el = h(
      "div",
      { class: `apcard${actionable ? " is-actionable" : " is-queued"}`, attrs: { role: "group", "aria-label": `${agentName(c.s.agent)} asks for permission` } },
      h(
        "div",
        { class: "apcard-top" },
        h("span", { class: "apcard-ava" }, avatar(c.seed, c.s.agent, { pose: "raise", frames: [0, 1], crop: "full", scale: 1.5 })),
        h(
          "div",
          { class: "apcard-text" },
          h("span", { class: "apcard-ask", text: actionable ? `${agentName(c.s.agent)} wants to ${verb}` : c.s.status !== "running" ? "Asked, never answered" : "Waiting in line" }),
          h("span", { class: "apcard-what" }, h("span", { class: "apcard-ic" }, glyph(catGlyph(it.category), 1)), labelEl(it, "apcard-label"), it.tool ? h("span", { class: "apcard-tool", text: it.tool }) : null),
        ),
      ),
      it.detail || (actionable && pend?.detail) ? h("pre", { class: "apcard-detail", text: it.detail || pend!.detail!, attrs: { tabindex: 0, "aria-label": "What it asks to do" } }) : null,
      actionable
        ? h(
            "div",
            { class: "apcard-btns" },
            btn("ap-allow", "Allow", "1", () => c.answer("allow", false)),
            pend?.noAlways ? null : btn("ap-always", "Always allow", "2", () => c.answer("allow", true)),
            btn("ap-deny", "Deny", "3", () => c.answer("deny", false)),
          )
        : null,
    );
    return el;
  }

  private renderFoot(t: Turn, st: ReturnType<ChatModel["stats"]>, after: Rec[], c: ViewCtx): void {
    const out = c.model.outcome(t);
    const took = st.endAt > st.startAt ? dur(st.endAt - st.startAt) : "";
    const lead = out === "failed" ? (took ? `Failed after ${took}` : "Failed") : out === "interrupted" ? (took ? `Interrupted after ${took}` : "Interrupted") : took ? `Done in ${took}` : "Done";
    const bits: string[] = [lead];
    if (st.tools) bits.push(`${st.tools} tool${st.tools === 1 ? "" : "s"}`);
    const reply = after.filter((r) => r.item.kind === "assistant").map((r) => r.item.text ?? "").join("\n\n").trim();
    const kids: Node[] = [h("span", { class: `foot-dot is-${out}` }), h("span", { class: "foot-text", text: bits.join(" · ") })];
    if (st.files)
      kids.push(
        h(
          "span",
          { class: "foot-bit foot-files" },
          h("span", { text: `${st.files} file${st.files === 1 ? "" : "s"}` }),
          st.added || st.removed ? h("span", { class: "d-add", text: `\u00a0+${st.added}` }) : null,
          st.added || st.removed ? h("span", { class: "d-del", text: `\u00a0−${st.removed}` }) : null,
        ),
      );
    if (st.tokens) kids.push(h("span", { class: "foot-bit foot-tok", text: `${compact(st.tokens)} tokens` }));
    kids.push(h("span", { class: "foot-gap" }));
    if (reply) {
      const b = h("button", { class: "foot-copy", attrs: { type: "button", "aria-label": "Copy the reply" } }, glyph("prompt", 1), h("span", { class: "copy-word", text: "Copy" }));
      b.addEventListener("click", () => onCopy(reply, b));
      kids.push(b);
    }
    this.foot.replaceChildren(...kids);
  }
}

function errorCard(it: ChatItem): HTMLElement {
  const text = it.text || it.summary || "Something went wrong.";
  return h(
    "div",
    { class: "errcard" },
    h("span", { class: "errcard-ic" }, glyph("error", 2)),
    h("div", { class: "errcard-body" }, h("b", { class: "errcard-title", text: "Error" }), h("p", { class: "errcard-text", text }), it.detail?.trim() ? h("pre", { class: "errcard-detail", attrs: { tabindex: "0" }, text: it.detail.trim() }) : null),
  );
}

/* ------------------------------------------------------------- the view */

export function createChat(sessionId: string, opts: ChatOpts): ChatView {
  const model = new ChatModel();
  const views = new Map<string, TurnView>();
  const expanded = new Set<string>();
  const logOpen = new Map<string, boolean>();
  const userOpen = new Set<string>();
  const dirty = new Set<Turn>();
  let extra = 0;
  let pinned = true;
  let fresh = 0;
  let raf = 0;
  let structure = true;
  let openedAt = 0;
  let card: HTMLElement | null = null;
  let cardVisible = true;
  let lastActivity = "";
  /** The stream brought something since the last frame (not the reader expanding a row). */
  let grew = false;
  const announced = new Set<string>();

  const col = h("div", { class: "chat-col" });
  const earlier = h("button", { class: "chat-earlier", attrs: { type: "button", hidden: true } });
  const startLine = h("div", { class: "chat-start", attrs: { hidden: true } });
  const emptyEl = h("div", { class: "chat-empty", attrs: { hidden: true } });
  const turnsEl = h("div", { class: "chat-turns" });
  col.append(earlier, startLine, emptyEl, turnsEl);
  const scroller = h("div", { class: "chat-scroll", attrs: { role: "region", "aria-label": "Conversation", tabindex: "-1" } }, col);
  const jump = h("button", { class: "chat-jump", attrs: { type: "button", hidden: true } });
  const main = h("div", { class: "chat-main" }, scroller, jump);

  const apbar = h("div", { class: "apbar", attrs: { hidden: true, role: "group", "aria-label": "The agent asks for permission" } });
  const queueEl = h("div", { class: "chat-queue", attrs: { hidden: true, "aria-label": "Queued prompts" } });
  const dock = h("div", { class: "chat-dock" }, apbar, queueEl);
  const live = h("div", { class: "sr-only", attrs: { "aria-live": "polite", "aria-atomic": "true" } });
  const el = h("div", { class: "chat" }, main, dock, live);

  const s0 = opts.session();
  const seed = seedFor(sessionId, s0?.workerId ?? `ctl:${sessionId}`);

  const ctx = (s: ControlSession, unflip: Set<string>): ViewCtx => ({
    model,
    s,
    seed,
    pendingId: s.pendingApproval?.id,
    expanded,
    logOpen,
    userOpen,
    unflip,
    rerender: (t) => {
      dirty.add(t);
      schedule();
    },
    answer: (d, always) => void opts.onAnswer(d, always),
  });

  /** Passing test runs right after a failing one (the table goes back up). */
  function unflips(): Set<string> {
    const out = new Set<string>();
    let lastFailed = false;
    for (const r of model.recs.values()) {
      const it = r.item;
      if (it.kind !== "tool" || !isTestRun(it) || (it.status !== "ok" && it.status !== "error")) continue;
      if (it.status === "ok" && lastFailed) out.add(it.id);
      lastFailed = it.status === "error";
    }
    return out;
  }

  /* ---- scrolling ---- */
  const distance = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  const toBottom = (smooth = false) => {
    if (smooth && !reducedMotion()) scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
    else scroller.scrollTop = scroller.scrollHeight;
  };
  scroller.addEventListener(
    "scroll",
    () => {
      const near = distance() < 56;
      if (near !== pinned) {
        pinned = near;
        if (near) fresh = 0;
        syncJump();
      } else if (!near) syncJump();
    },
    { passive: true },
  );
  jump.addEventListener("click", () => {
    pinned = true;
    fresh = 0;
    syncJump();
    toBottom(true);
  });
  function syncJump(): void {
    const far = distance() > scroller.clientHeight * 0.6;
    jump.hidden = pinned || (!fresh && !far);
    jump.classList.toggle("is-new", fresh > 0);
    jump.replaceChildren(h("span", { class: "jump-arrow", text: "↓" }), h("span", { text: fresh ? "New" : "Latest" }));
    jump.setAttribute("aria-label", fresh ? "New messages below. Jump to the latest" : "Jump to the latest");
  }
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => pinned && toBottom()) : null;
  ro?.observe(col);

  /* ---- the open approval, and its bar when the card is out of view ---- */
  const io =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver(
          (entries) => {
            for (const e of entries) if (e.target === card) cardVisible = e.isIntersecting && e.intersectionRatio > 0.6;
            syncBar();
          },
          { root: scroller, threshold: [0, 0.6, 1] },
        )
      : null;
  function watchCard(c: HTMLElement | null): void {
    if (c === card) return;
    if (card) io?.unobserve(card);
    card = c;
    cardVisible = true;
    if (card) io?.observe(card);
    syncBar();
  }
  function syncBar(): void {
    const s = opts.session();
    const ap = s?.pendingApproval;
    const show = !!(ap && s?.status === "running" && (!card || !cardVisible));
    apbar.hidden = !show;
    if (!show || !s || !ap) return;
    const key = `${ap.id}|${!!card}|${!!ap.noAlways}`;
    if (apbar.dataset.key === key) return;
    apbar.dataset.key = key;
    const btn = (cls: string, text: string, k: string, fn: () => void) =>
      h("button", { class: `ap-btn ${cls}`, attrs: { type: "button", "aria-keyshortcuts": k }, on: { click: fn } }, h("span", { class: "ap-word", text }), h("kbd", { text: k }));
    apbar.replaceChildren(
      h("span", { class: "apbar-ava" }, avatar(seed, s.agent, { pose: "raise", frames: [0, 1], scale: 1 })),
      h(
        "button",
        { class: "apbar-what", attrs: { type: "button", title: card ? "Show where it asked" : "" }, on: { click: () => showApproval() } },
        h("span", { class: "apbar-ask", text: `Wants to ${VERB[ap.category ?? "other"] ?? "use"}` }),
        h("code", { class: "apbar-label", text: ap.summary || ap.tool }),
      ),
      h(
        "span",
        { class: "apbar-btns" },
        btn("ap-allow", "Allow", "1", () => void opts.onAnswer("allow", false)),
        ap.noAlways ? null : btn("ap-always", "Always", "2", () => void opts.onAnswer("allow", true)),
        btn("ap-deny", "Deny", "3", () => void opts.onAnswer("deny", false)),
      ),
    );
  }
  function showApproval(): void {
    if (card) {
      pinned = false;
      card.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
      card.querySelector<HTMLElement>(".ap-allow")?.focus({ preventScroll: true });
    }
  }

  /* ---- rendering ---- */
  function schedule(all = false): void {
    if (all) structure = true;
    if (raf) return;
    raf = requestAnimationFrame(render);
  }

  function announce(text: string): void {
    live.textContent = "";
    window.setTimeout(() => (live.textContent = text.length > 400 ? `${text.slice(0, 400)}…` : text), 30);
  }

  function render(): void {
    raf = 0;
    const s = opts.session();
    if (!s) return;
    model.live = s.status === "running";
    const before = scroller.scrollHeight;
    const turns = model.turns;
    // the DOM cap: newest turns first until the budget is spent
    let budget = DOM_CAP + extra;
    let from = turns.length;
    while (from > 0) {
      const t = turns[from - 1]!;
      const cost = t.recs.length + (t.user ? 1 : 0);
      if (from < turns.length && budget - cost < 0) break;
      budget -= cost;
      from--;
    }
    const hiddenItems = turns.slice(0, from).reduce((n, t) => n + t.recs.length + (t.user ? 1 : 0), 0);
    earlier.hidden = from === 0;
    setText(earlier, `Show ${hiddenItems} earlier item${hiddenItems === 1 ? "" : "s"}`);

    // the session line, and the empty state before the first prompt
    const prompted = turns.some((t) => t.user) || model.queue.length > 0;
    renderStart(s, prompted);
    emptyEl.hidden = prompted || s.status !== "running";
    if (!emptyEl.hidden) renderEmpty(s);

    const keep = new Set<string>();
    const els: HTMLElement[] = [];
    const lastTurn = turns[turns.length - 1];
    const c = ctx(s, unflips());
    let found: HTMLElement | null = null;
    for (let i = from; i < turns.length; i++) {
      const t = turns[i]!;
      if (t.key === "pre" && !model.parts(t).after.length) continue;
      let v = views.get(t.key);
      if (!v) views.set(t.key, (v = new TurnView(t)));
      keep.add(t.key);
      if (structure || dirty.has(t) || v.rev !== t.rev || t === lastTurn) {
        found = v.render(c) ?? found;
        v.rev = t.rev;
      } else found = v.el.querySelector<HTMLElement>(".apcard.is-actionable") ?? found;
      els.push(v.el);
    }
    watchCard(found);
    for (const k of views.keys()) if (!keep.has(k)) views.delete(k);
    reconcile(turnsEl, els);
    dirty.clear();
    structure = false;

    renderQueue();
    syncBar();
    if (pinned) toBottom();
    else if (grew && scroller.scrollHeight > before) fresh++;
    grew = false;
    syncJump();
    emitActivity();
  }

  function renderStart(s: ControlSession, prompted: boolean): void {
    const r = model.ready;
    startLine.hidden = !prompted || !r;
    if (startLine.hidden || !r) return;
    const m = READY_RE.exec(r.text ?? "");
    const sig = `${r.text}|${r.at}`;
    if (startLine.dataset.sig === sig) return;
    startLine.dataset.sig = sig;
    startLine.replaceChildren(logo(s.agent), h("span", { text: m ? `${m[1]} started in ${m[2]}` : r.text ?? "" }), h("span", { class: "chat-start-time", text: stamp(Date.parse(r.at)) }));
  }

  function renderEmpty(s: ControlSession): void {
    const r = model.ready ? READY_RE.exec(model.ready.text ?? "") : null;
    const where = r?.[2] ?? (s.place.kind === "local" ? placeLabel(s.place).replace(/^This Mac · /, "") : s.place.cwd || s.host?.name || s.place.target);
    const w = opts.worker?.();
    const perm = PERMISSIONS.find((p) => p.mode === s.permission)?.label ?? s.permission;
    const sig = `${s.agent}|${where}|${w?.model ?? ""}|${perm}|${s.place.kind}`;
    if (emptyEl.dataset.sig === sig) return;
    emptyEl.dataset.sig = sig;
    const chips = STARTERS.map((x) => h("button", { class: "starter", attrs: { type: "button" }, on: { click: () => opts.onStarter(x.prompt) } }, h("span", { class: "starter-arrow", text: "›" }), h("span", { text: x.label })));
    emptyEl.replaceChildren(
      h("div", { class: "ce-art" }, h("span", { class: "ce-logo" }, logo(s.agent)), h("span", { class: "ce-worker" }, avatar(seed, s.agent, { crop: "full", scale: 3, pose: "raise", frames: [0, 1] }))),
      h("h3", { class: "ce-title" }, h("span", { class: "ce-agent", text: agentName(s.agent) }), h("span", { text: " is ready" })),
      h("p", { class: "ce-where" }, h("span", { text: "in " }), h("code", { text: where })),
      h("p", { class: "ce-meta" }, ...[w?.model, perm, s.place.kind === "local" ? "This Mac" : s.host?.name].filter(Boolean).flatMap((x, i) => (i ? [h("span", { class: "ce-sep", text: "·" }), h("span", { text: String(x) })] : [h("span", { text: String(x) })]))),
      h("div", { class: "ce-chips", attrs: { role: "group", "aria-label": "Ideas to start with" } }, ...chips),
    );
  }

  function renderQueue(): void {
    const q = model.queued();
    queueEl.hidden = !q.length;
    const sig = q.map((r) => `${r.item.id}:${r.item.text}`).join("|");
    if (queueEl.dataset.sig === sig) return;
    queueEl.dataset.sig = sig;
    if (!q.length) return queueEl.replaceChildren();
    queueEl.replaceChildren(
      h("div", { class: "queue-head" }, h("span", { class: "queue-label", text: `Queued · ${q.length}` }), h("span", { class: "queue-hint", text: "runs when this turn ends" })),
      h("ol", { class: "queue-list" }, ...q.map((r) => h("li", { class: "queue-item" }, glyph("prompt", 1), h("span", { class: "queue-text", text: r.item.text ?? "" })))),
    );
  }

  function activityNow(): ChatActivity {
    const phase = model.phase();
    return { phase, busy: phase !== "idle", queued: model.queued().length, since: model.since() };
  }

  function emitActivity(): void {
    const a = activityNow();
    const key = `${a.phase}|${a.queued}`;
    if (key === lastActivity) return;
    lastActivity = key;
    opts.onActivity?.(a);
  }

  /* ---- the stream ---- */
  function onItem(it: ChatItem): void {
    const changed = model.put(it);
    if (!changed.length) return;
    if (openedAt && Date.now() - openedAt > 600) grew = true;
    for (const t of changed) dirty.add(t);
    const rec = model.recs.get(it.id);
    const liveNow = openedAt && Date.now() - openedAt > 700;
    if (rec && liveNow) {
      // announcements for screen readers: finished replies, approvals, errors
      if (it.kind === "assistant" && it.streaming !== true && it.text && !announced.has(it.id)) {
        const turn = rec.turn;
        const p = model.parts(turn);
        if (p.after.includes(rec)) {
          announced.add(it.id);
          window.setTimeout(() => {
            const cur = model.recs.get(it.id);
            if (cur && !model.streaming(cur) && model.parts(cur.turn).after.includes(cur)) announce(`${agentName(opts.session()?.agent ?? "claude")}: ${cur.item.text ?? ""}`);
          }, 1800);
        }
      } else if (it.kind === "approval" && approvalState(it) === "open" && !announced.has(it.id)) {
        announced.add(it.id);
        const keys = opts.session()?.pendingApproval?.noAlways ? "Press 1 to allow, 3 to deny." : "Press 1 to allow, 2 to always allow, 3 to deny.";
        announce(`${agentName(opts.session()?.agent ?? "claude")} wants to ${VERB[it.category ?? "other"] ?? "use"} ${it.summary || it.tool}. ${keys}`);
      } else if (it.kind === "error" && !announced.has(it.id)) {
        announced.add(it.id);
        announce(`Error: ${it.text ?? ""}`);
      }
    }
    schedule();
  }

  const s: Stream = stream(
    chatPath(sessionId),
    (event, data) => {
      if (event !== "item") return;
      let it: ChatItem;
      try {
        it = JSON.parse(data) as ChatItem;
      } catch {
        return; // a bad line is skipped
      }
      onItem(it);
    },
    (state, reconnect, err) => {
      if (state === "open") {
        openedAt = Date.now();
        // history is replayed on every connect: start clean
        if (reconnect) {
          model.reset();
          views.clear();
          turnsEl.replaceChildren();
          announced.clear();
        }
        // the worker's pose at connect time speaks for the replayed history
        const w = opts.worker?.();
        if (w?.status) model.hint(w.status, Date.now() + 1500);
        schedule(true);
      }
      opts.onState?.(state, err);
    },
  );

  earlier.addEventListener("click", () => {
    const h0 = scroller.scrollHeight;
    const top = scroller.scrollTop;
    extra += DOM_CAP;
    render();
    scroller.scrollTop = top + (scroller.scrollHeight - h0);
  });

  // live timers ("Thinking · 12s", "Working · 18s") move once a second
  const ticker = window.setInterval(() => {
    const last = model.current();
    if (last && (model.running(last) || last.recs.some((r) => r.grewAt && Date.now() - r.grewAt < 2600))) {
      dirty.add(last);
      schedule();
    }
  }, 500);

  return {
    el,
    sync() {
      schedule(true);
    },
    hint(kind) {
      if (model.hint(kind)) schedule(true);
    },
    activity: activityNow,
    sent() {
      pinned = true;
      fresh = 0;
      toBottom();
      syncJump();
    },
    showApproval,
    dispose() {
      s.close();
      cancelAnimationFrame(raf);
      clearInterval(ticker);
      ro?.disconnect();
      io?.disconnect();
    },
  };
}
