/*
 * The session panel for an agent the office started: who and where, its
 * status, and the agent itself, as a real terminal (its own TUI) or, for
 * agents with a headless protocol, a chat. Native controls sit around it: a
 * composer (Enter sends, Shift+Enter is a new line; in chat mode it turns into
 * Interrupt while a turn runs, Esc too, and prompts sent meanwhile queue),
 * Interrupt, Stop (asks twice), and approvals answered with the buttons or
 * 1 / 2 / 3 (Alt+1/2/3 from inside the terminal or the composer). A terminal
 * shows approvals as a banner on top, with Alt+1/2/3 on its keys since the
 * terminal has the focus and plain keys (Esc too) belong to the agent; a chat
 * shows them where the agent asked. Either way the whole request is shown
 * (Approval.detail), not just its label.
 * A side panel on desktop that can be maximised, a full-screen sheet on a phone.
 *
 * The panel itself is in the page from the start and opens at once; the
 * terminal (xterm.js) and the chat are chunks of their own, fetched ahead of
 * time (prefetchViews: on hover, on idle) or on first open, with a skeleton
 * where they go until they're here.
 */
import type { ApprovalAnswer, ControlSession } from "../../../src/shared/control.ts";
import type { OfficeEvent } from "../../../src/shared/events.ts";
import { h, setText } from "../dom.ts";
import { glyph, glyphFor, icon } from "../icons.ts";
import { agentColor, agentName, logo } from "../logos.ts";
import { api, ControlError, type StreamState } from "./api.ts";
import type { ChatActivity, ChatView } from "./chat.ts";
import { avatar, seedFor } from "./chat/avatar.ts";
import { PERMISSIONS, placeBadge, statusWord } from "./format.ts";
import type { ControlStore } from "./store.ts";
import type { TermView } from "./terminal.ts";

type TerminalModule = typeof import("./terminal.ts");
type ChatModule = typeof import("./chat.ts");
type ViewKind = "terminal" | "chat";

const loaded: { terminal?: TerminalModule; chat?: ChatModule } = {};
const loading: { terminal?: Promise<TerminalModule>; chat?: Promise<ChatModule> } = {};

/** A session view's code: at once when it's here, else its chunk (fetched once; a failed fetch is tried again next time). */
function loadView(kind: "terminal"): Promise<TerminalModule>;
function loadView(kind: "chat"): Promise<ChatModule>;
function loadView(kind: ViewKind): Promise<TerminalModule | ChatModule> {
  if (kind === "terminal") {
    return (loading.terminal ??= import("./terminal.ts").then(
      (m) => (loaded.terminal = m),
      (err: unknown) => {
        loading.terminal = undefined;
        throw err;
      },
    ));
  }
  return (loading.chat ??= import("./chat.ts").then(
    (m) => (loaded.chat = m),
    (err: unknown) => {
      loading.chat = undefined;
      throw err;
    },
  ));
}

/**
 * Fetch the session views' code before it is needed: a worker or a "Your agents" row under the
 * pointer, or the page idle after its first frame. `warm` also builds the terminal's xterm ahead
 * (idle only: it takes a few milliseconds of layout).
 */
export function prefetchViews(kinds: ViewKind[] = ["terminal", "chat"], o: { warm?: boolean } = {}): void {
  for (const k of kinds) {
    if (k === "terminal") {
      loadView("terminal").then((m) => o.warm && m.prewarmTerminal(), () => {});
    } else void loadView("chat").catch(() => {});
  }
}

export interface SessionPanel {
  el: HTMLElement;
  open(id: string): void;
  close(): void;
  current(): string | null;
  isOpen(): boolean;
  isMax(): boolean;
  /** The store changed: refresh the header, banner and enabled state. */
  sync(): void;
  /** An office event: the open session's worker posing tells the chat whether a turn still runs. */
  workerEvent(e: OfficeEvent): void;
}

export interface SessionPanelOpts {
  onClose(): void;
  /** Maximised or restored: the camera's free area changed. */
  onLayout(): void;
  onFocusWorker(workerId: string): void;
  toast(text: string, tone?: "plain" | "error"): void;
  /** The office's worker for a session: its model and last pose. */
  worker?(workerId: string): { model?: string; status?: string } | undefined;
}

const PERM_SHORT: Record<string, string> = { default: "asks first", acceptEdits: "accepts edits", plan: "plan only", bypass: "bypass" };

export function createSessionPanel(store: ControlStore, opts: SessionPanelOpts): SessionPanel {
  const logoSlot = h("button", { class: "ses-logo", attrs: { type: "button", "aria-label": "Show this worker in the office", title: "Show in the office" } });
  const projectEl = h("h2", { class: "ses-project" });
  const agentEl = h("span", { class: "ses-agent" });
  const placeSlot = h("span", { class: "ses-place" });
  const modelEl = h("span", { class: "ses-chip ses-model", attrs: { hidden: true } });
  const permEl = h("span", { class: "ses-chip ses-perm" });
  const pillDot = h("span", { class: "ses-pill-dot" });
  const pillWord = h("span", { class: "ses-pill-word" });
  const pillDetail = h("span", { class: "ses-pill-detail" });
  const pill = h("span", { class: "ses-pill", attrs: { role: "status" } }, pillDot, pillWord, pillDetail);

  const tab = (mode: "terminal" | "chat", label: string) =>
    h("button", { class: "ses-tab", attrs: { type: "button", role: "tab", "aria-selected": "false", "data-mode": mode } }, icon(mode === "terminal" ? "terminal" : "chat", 1), h("span", { text: label }));
  const termTab = tab("terminal", "Terminal");
  const chatTab = tab("chat", "Chat");
  const tabs = h("div", { class: "ses-tabs", attrs: { role: "tablist", "aria-label": "View" } }, termTab, chatTab);

  const actBtn = (cls: string, ic: Parameters<typeof icon>[0], label: string, text?: string) => {
    const b = h("button", { class: `ses-btn ${cls}`, attrs: { type: "button", "aria-label": label, title: label } }, icon(ic, 1));
    if (text) b.append(h("span", { class: "ses-btn-text", text }));
    return b;
  };
  const interruptBtn = actBtn("ses-interrupt", "pause", "Interrupt the current turn", "Interrupt");
  const stopBtn = actBtn("ses-stop", "power", "Stop the agent", "Stop");
  const maxBtn = actBtn("ses-max", "maximize", "Maximise");
  const focusBtn = actBtn("ses-focus", "target", "Show this worker in the office");
  const closeBtn = h("button", { class: "ses-btn ses-close", attrs: { type: "button", "aria-label": "Close the panel", title: "Close" } }, glyph("close", 1));

  const head = h(
    "header",
    { class: "ses-head" },
    logoSlot,
    h(
      "div",
      { class: "ses-title" },
      h("div", { class: "ses-title-row" }, projectEl, pill),
      h("div", { class: "ses-sub" }, agentEl, h("span", { class: "ses-sep", text: "·" }), placeSlot, modelEl, permEl),
    ),
    h("div", { class: "ses-actions" }, focusBtn, maxBtn, closeBtn),
  );
  const bar = h("div", { class: "ses-bar" }, tabs, h("span", { class: "ses-bar-gap" }), interruptBtn, stopBtn);

  /* approval banner (terminal mode; a chat shows its approvals inline) */
  const apGlyph = h("span", { class: "ses-ap-glyph" });
  const apTool = h("b", { class: "ses-ap-tool" });
  const apSummary = h("span", { class: "ses-ap-summary" });
  const apDetail = h("pre", { class: "ses-ap-detail", attrs: { hidden: true, tabindex: 0, "aria-label": "What it asks to do" } });
  // The banner is for the terminal, which has the focus: plain digits would type into the agent.
  const alt = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌥" : "Alt+";
  const apBtn = (cls: string, text: string, key: string) =>
    h("button", { class: `ap-btn ${cls}`, attrs: { type: "button", "aria-keyshortcuts": `Alt+${key}` } }, h("span", { text }), h("kbd", { text: `${alt}${key}` }));
  const allowBtn = apBtn("ap-allow", "Allow", "1");
  const alwaysBtn = apBtn("ap-always", "Always allow", "2");
  const denyBtn = apBtn("ap-deny", "Deny", "3");
  const approval = h(
    "div",
    { class: "ses-approval", attrs: { hidden: true, role: "alertdialog", "aria-label": "The agent asks for permission" } },
    h("div", { class: "ses-ap-what" }, apGlyph, h("div", { class: "ses-ap-text" }, h("span", { class: "ses-ap-ask", text: "Wants to" }), h("div", { class: "ses-ap-line" }, apTool, apSummary))),
    apDetail,
    h("div", { class: "ses-ap-btns" }, allowBtn, alwaysBtn, denyBtn),
  );

  /* something only the user can do now: Codex's device sign-in */
  const needsLink = h("a", { class: "ses-needs-link", attrs: { target: "_blank", rel: "noopener noreferrer" } });
  const needsCode = h("code", { class: "ses-needs-code" });
  const needsCopy = h("button", { class: "ap-btn", attrs: { type: "button" }, text: "Copy code" });
  const needs = h(
    "div",
    { class: "ses-approval ses-needs", attrs: { hidden: true, role: "status", "aria-label": "Sign in to Codex" } },
    h("div", { class: "ses-ap-what" }, icon("lock", 2), h("div", { class: "ses-ap-text" }, h("span", { class: "ses-ap-ask", text: "Sign in to Codex" }), h("div", { class: "ses-ap-line" }, h("span", { text: "Open " }), needsLink, h("span", { text: " and enter " }), needsCode))),
    h("div", { class: "ses-ap-btns" }, needsCopy),
  );
  needsCopy.addEventListener("click", () => {
    const code = needsCode.textContent ?? "";
    navigator.clipboard?.writeText(code).then(() => opts.toast("Copied the code"), () => opts.toast(code));
  });

  const body = h("div", { class: "ses-body" });
  const notice = h("div", { class: "ses-notice", attrs: { hidden: true, role: "status" } });

  const input = h("textarea", {
    class: "ses-input",
    attrs: { rows: 1, placeholder: "Message the agent", "aria-label": "Message", autocomplete: "off", spellcheck: "true", enterkeyhint: "send" },
  });
  const sendBtn = h("button", { class: "ses-send", attrs: { type: "submit", "aria-label": "Send", title: "Send  Enter" } }, icon("send", 1));
  const promptErr = h("p", { class: "ses-prompt-err", attrs: { hidden: true, role: "alert" } });
  const hintKeys = h(
    "span",
    { class: "ses-hint-keys" },
    h("kbd", { text: "Enter" }),
    h("span", { text: "send" }),
    h("kbd", { text: "⇧ Enter" }),
    h("span", { text: "new line" }),
  );
  const hintEsc = h("span", { class: "ses-hint-esc", attrs: { hidden: true } }, h("kbd", { text: "Esc" }), h("span", { text: "interrupt" }));
  const hintWhy = h("span", { class: "ses-hint-why", attrs: { hidden: true } });
  const form = h(
    "form",
    { class: "ses-prompt" },
    h("div", { class: "ses-input-wrap" }, input, sendBtn),
    h("p", { class: "ses-hint" }, hintKeys, hintEsc, hintWhy),
    promptErr,
  );

  const el = h(
    "section",
    { class: "session glass", attrs: { hidden: true, "aria-label": "Agent session" } },
    head,
    bar,
    approval,
    needs,
    body,
    notice,
    form,
  );

  let id: string | null = null;
  /** The mounted view; `loading` while its chunk is on the way (a skeleton shows meanwhile). */
  let view: { kind: ViewKind; term?: TermView; chat?: ChatView; deadAt?: number; loading?: boolean } | null = null;
  let max = false;
  let stopArmed = 0;
  let answered = "";
  let exitCode: number | undefined;
  let lastAgent = "";
  let activity: ChatActivity = { phase: "idle", busy: false, queued: 0, since: 0 };
  let sending = false;

  const cur = (): ControlSession | undefined => store.get(id);
  /** The session as the chat should see it: an approval answered here stops being actionable at once. */
  const curForChat = (): ControlSession | undefined => {
    const s = cur();
    if (s?.pendingApproval && s.pendingApproval.id === answered) {
      const { pendingApproval, ...rest } = s;
      void pendingApproval;
      return rest;
    }
    return s;
  };
  const ended = (s?: ControlSession) => !s || s.status === "exited" || s.status === "failed";
  const isChat = () => view?.kind === "chat";
  const busy = () => isChat() && activity.busy;

  /** The agent's stream exists once it runs (and replays after it ended); until then a placeholder. */
  const streamable = (s: ControlSession) => s.status === "running" || s.status === "exited" || s.status === "failed";

  /** Starting up: the worker walks in from the lift while the steps tick by. */
  function placeholder(s: ControlSession): void {
    unmount();
    const remote = s.place.kind !== "local";
    const cloud = remote && s.place.kind !== "ssh";
    const steps: { key: string; label: string }[] = [];
    if (cloud && (s.status === "creating" || s.place.target === "new")) steps.push({ key: "creating", label: "Sandbox" });
    if (remote) steps.push({ key: "installing", label: "Install" });
    if (s.setup) steps.push({ key: "setup", label: "Your setup" });
    steps.push({ key: "starting", label: "Start" });
    const at = s.status === "installing" && s.setup?.state === "running" ? "setup" : s.status;
    const now = steps.findIndex((x) => x.key === at);
    const su = s.setup;
    body.replaceChildren(
      h(
        "div",
        { class: "ses-wait", attrs: { role: "status" } },
        h("span", { class: "sw-stage" }, avatar(seedFor(s.id, s.workerId), s.agent, { pose: "walk", frames: [0, 1, 2, 3], crop: "full", scale: 3, cls: "sw-walker" }), h("span", { class: "sw-floor" })),
        h("p", { class: "sw-detail", text: s.detail || `${statusWord(s.status).word}…` }),
        steps.length > 1
          ? h(
              "ol",
              { class: "sw-steps", attrs: { "aria-label": "Progress" } },
              ...steps.map((x, i) => h("li", { class: i < now ? "is-done" : i === now ? "is-now" : "", attrs: { "aria-current": i === now ? "step" : undefined } }, h("span", { class: "sw-dot" }), h("span", { text: x.label }))),
            )
          : null,
        su && su.state !== "running"
          ? h(
              "div",
              { class: `sw-setup is-${su.state}` },
              h("p", { class: "sw-setup-line", text: `${su.state === "failed" ? "Your setup didn't all make it" : "Your setup"}: ${su.summary}` }),
              su.skipped?.length ? h("details", { class: "sw-setup-skipped" }, h("summary", { text: `${su.skipped.length} left out` }), h("ul", null, ...su.skipped.map((x) => h("li", { text: x })))) : null,
            )
          : null,
      ),
    );
    body.dataset.wait = `${s.status}|${s.detail ?? ""}|${s.setup?.state ?? ""}`;
  }

  /** A placeholder in the view's shape while its chunk loads: lines for a terminal, bubbles for a chat. */
  function skeleton(kind: ViewKind): HTMLElement {
    const lines = kind === "terminal" ? [62, 48, 71, 36, 55, 28] : [70, 46, 58];
    return h(
      "div",
      { class: `ses-skel is-${kind}`, attrs: { "aria-hidden": "true" } },
      ...lines.map((w) => h("span", { class: "ses-skel-line", attrs: { style: `width:${w}%` } })),
    );
  }

  function mount(s: ControlSession): void {
    unmount();
    const kind: ViewKind = s.mode === "chat" ? "chat" : "terminal";
    const mine = { kind } as NonNullable<typeof view>;
    view = mine;
    delete body.dataset.wait;
    el.dataset.mode = kind;
    termTab.setAttribute("aria-selected", String(kind === "terminal"));
    chatTab.setAttribute("aria-selected", String(kind === "chat"));
    for (const t of [termTab, chatTab]) {
      const own = t.dataset.mode === kind;
      t.disabled = !own;
      t.title = own ? "" : s.mode === "chat" ? "This agent was hired in chat mode" : "This agent was hired in terminal mode";
    }
    const mod = kind === "chat" ? loaded.chat : loaded.terminal;
    if (mod) return build(mine, s.id, mod);
    mine.loading = true;
    body.replaceChildren(skeleton(kind));
    const p = kind === "chat" ? loadView("chat") : loadView("terminal");
    p.then(
      (m) => {
        if (view !== mine || id !== s.id) return;
        mine.loading = false;
        build(mine, s.id, m);
        if (!el.hidden && kind === "terminal" && (!document.activeElement || document.activeElement === document.body || el.contains(document.activeElement))) {
          requestAnimationFrame(() => view === mine && mine.term?.focus());
        }
      },
      () => {
        if (view !== mine) return;
        // nothing to show: the next sync() (a store change) tries again
        mine.loading = false;
        mine.deadAt = Date.now();
        showNotice(`Couldn't load the ${kind}. Check the office is still running, then reopen the panel.`);
      },
    );
  }

  function build(mine: NonNullable<typeof view>, sid: string, mod: TerminalModule | ChatModule): void {
    const s = store.get(sid);
    if (!s) return;
    const onState = (st: StreamState, err?: string) => {
      if (st === "ended" && err === "locked") showNotice("Controls are locked in this browser.");
      else if (st === "ended") mine.deadAt = Date.now(); // not there (yet): sync() tries again
      else if (st === "retrying" && !ended(cur())) showNotice("Reconnecting to the agent…", true);
      else if (st === "open") hideNotice();
    };
    if (mine.kind === "chat") {
      const chat = (mod as ChatModule).createChat(s.id, {
        onState,
        onActivity: (a) => {
          activity = a;
          syncComposer();
          sync();
        },
        onAnswer: (d, always) => answer(d, always),
        onStarter: (text) => {
          input.value = text;
          autosize();
          input.focus();
          input.setSelectionRange(text.length, text.length);
          syncComposer();
        },
        session: curForChat,
        worker: () => opts.worker?.(cur()?.workerId ?? ""),
      });
      body.replaceChildren(chat.el);
      mine.chat = chat;
      chat.sync();
    } else {
      const term = (mod as TerminalModule).createTerminal(s.id, {
        onState,
        onExit: (code) => {
          exitCode = code;
          term.freeze(`[the agent exited${code !== undefined ? ` with code ${code}` : ""}]`);
          sync();
        },
      });
      body.replaceChildren(term.el);
      mine.term = term;
      requestAnimationFrame(() => term.fit());
    }
  }

  function unmount(): void {
    view?.term?.dispose();
    view?.chat?.dispose();
    view = null;
    activity = { phase: "idle", busy: false, queued: 0, since: 0 };
    body.replaceChildren();
  }

  function showNotice(text: string, soft = false): void {
    notice.hidden = false;
    notice.classList.toggle("is-soft", soft);
    setText(notice, text);
  }
  function hideNotice(): void {
    if (!ended(cur())) notice.hidden = true;
  }

  function sync(): void {
    if (!id) return;
    const s = cur();
    if (!s) {
      setPill("Closed", "done", "");
      showNotice("This session is over.");
      setEnabled(false, "The session is over.");
      approval.hidden = true;
      return;
    }
    // the stream comes up with the agent; a stream that wasn't there yet is retried
    if (streamable(s) && (!view || (view.deadAt && Date.now() - view.deadAt > 1500 && s.status === "running"))) mount(s);
    else if (!streamable(s) && (!view || body.dataset.wait !== `${s.status}|${s.detail ?? ""}|${s.setup?.state ?? ""}`)) placeholder(s);
    if (lastAgent !== s.agent) {
      lastAgent = s.agent;
      logoSlot.replaceChildren(logo(s.agent));
      el.style.setProperty("--accent", agentColor(s.agent));
      el.dataset.agent = s.agent;
    }
    el.dataset.mode = s.mode;
    // In a terminal Esc is the agent's (it interrupts Claude's turn), so it isn't the panel's close key there.
    closeBtn.title = s.mode === "chat" ? "Close  Esc" : "Close";
    setText(projectEl, s.title || "agent");
    projectEl.title = s.title || "";
    setText(agentEl, agentName(s.agent));
    placeSlot.replaceChildren(placeBadge(s));
    const model = opts.worker?.(s.workerId)?.model;
    modelEl.hidden = !model;
    if (model) {
      setText(modelEl, model.replace(/^claude-/, ""));
      modelEl.title = `Model: ${model}`;
    }
    setText(permEl, PERM_SHORT[s.permission] ?? s.permission);
    permEl.title = PERMISSIONS.find((p) => p.mode === s.permission)?.label ?? s.permission;
    permEl.classList.toggle("is-bypass", s.permission === "bypass");

    const st = statusWord(s.status);
    let detail = s.detail ?? "";
    if (s.status === "exited") detail = `code ${s.exitCode ?? exitCode ?? "?"}`;
    if (s.status === "failed") detail = s.error || detail;
    const ap = s.pendingApproval && s.pendingApproval.id !== answered ? s.pendingApproval : undefined;
    if (s.status === "running" && ap) setPill("Needs you", "wait", "");
    else if (s.status === "running" && isChat()) setPill(activity.busy ? "Working" : "Ready", activity.busy ? "work" : "ok", activity.queued ? `${activity.queued} queued` : "");
    // while the walk-in placeholder shows, it carries the detail; the pill and composer stay short
    else setPill(st.word, st.tone, body.dataset.wait ? "" : detail);
    const over = ended(s);
    setEnabled(!over && s.status === "running", body.dataset.wait ? "" : whyDisabled(s));
    if (over) {
      // An ended session's detail is what happened to a sandbox made for it ("… was deleted").
      const after = s.detail ? ` ${s.detail}.` : "";
      const failed = `Failed${s.error ? `: ${s.error}` : ""}`;
      showNotice(s.status === "failed" ? `${failed}${after && !/[.!?]$/.test(failed) ? "." : ""}${after}` : `The agent exited${(s.exitCode ?? exitCode) !== undefined ? ` with code ${s.exitCode ?? exitCode}` : ""}.${after || " Close the panel when you're done."}`);
      if (s.status === "exited") view?.term?.freeze("[the agent exited]");
    } else if (s.status !== "running") {
      if (!body.dataset.wait) showNotice(s.detail || `${st.word}…`, true);
      else notice.hidden = true;
    } else if (notice.classList.contains("is-soft")) {
      notice.hidden = true;
    }
    // approval: a banner for the terminal; the chat draws its own card and bar
    if (ap && !over && !isChat()) {
      approval.hidden = false;
      apGlyph.replaceChildren(glyph(glyphFor("tool_start", ap.category), 2));
      setText(apTool, ap.tool);
      setText(apSummary, ap.summary && ap.summary !== ap.tool ? ap.summary : "");
      apDetail.hidden = !ap.detail;
      setText(apDetail, ap.detail ?? "");
      alwaysBtn.hidden = !!ap.noAlways;
      for (const b of [allowBtn, alwaysBtn, denyBtn]) b.disabled = false;
    } else approval.hidden = true;
    const nd = !over && s.needs?.kind === "device-login" ? s.needs : undefined;
    needs.hidden = !nd;
    if (nd) {
      needsLink.href = /^https:\/\//.test(nd.url) ? nd.url : "#";
      setText(needsLink, nd.url.replace(/^https:\/\//, ""));
      setText(needsCode, nd.code);
    }
    focusBtn.hidden = !s.workerId;
    view?.chat?.sync();
  }

  function whyDisabled(s: ControlSession): string {
    if (s.status === "running") return "";
    if (s.status === "exited") return `${agentName(s.agent)} exited. Hire it again to keep going.`;
    if (s.status === "failed") return `${agentName(s.agent)} couldn't start${s.error ? `: ${s.error}` : "."}`;
    return s.detail || `${agentName(s.agent)} is ${statusWord(s.status).word.toLowerCase()}…`;
  }

  function setPill(word: string, tone: string, detail: string): void {
    pill.dataset.tone = tone;
    setText(pillWord, word);
    setText(pillDetail, detail);
    pillDetail.hidden = !detail;
    pill.title = detail ? `${word} · ${detail}` : word;
  }

  function setEnabled(on: boolean, why = ""): void {
    input.disabled = !on;
    const s = cur();
    stopBtn.disabled = !s || ended(s);
    const chat = s?.mode === "chat";
    const over = !s || ended(s);
    // an ended session says why once, in the notice above; the composer just says it's closed
    input.placeholder = on ? (chat ? `Message ${agentName(s!.agent)}` : "Send a prompt") : over ? "The session is over" : why || `Waiting for ${s ? agentName(s.agent) : "the agent"}…`;
    input.title = on && !chat ? "Pasted into the agent's terminal, then Enter" : "";
    hintWhy.hidden = on || over || !why;
    setText(hintWhy, why);
    hintKeys.hidden = !on;
    form.classList.toggle("is-off", !on);
    syncComposer();
  }

  /** Send, or Interrupt while a chat turn runs and nothing is typed. */
  function syncComposer(): void {
    const s = cur();
    const on = !!s && s.status === "running";
    const stop = on && busy() && !input.value.trim();
    sendBtn.classList.toggle("is-stop", stop);
    sendBtn.classList.toggle("is-queue", on && busy() && !stop);
    sendBtn.replaceChildren(stop ? h("span", { class: "stop-sq" }) : icon("send", 1));
    const label = stop ? "Interrupt" : busy() ? "Queue this prompt" : "Send";
    sendBtn.setAttribute("aria-label", label);
    sendBtn.title = stop ? "Interrupt  Esc" : busy() ? "Queue: runs when this turn ends  Enter" : "Send  Enter";
    sendBtn.disabled = !on || sending || (!stop && !input.value.trim());
    hintEsc.hidden = !(on && busy());
    interruptBtn.disabled = !on || (isChat() && !busy());
  }

  async function answer(decision: ApprovalAnswer["decision"], always = false): Promise<void> {
    const s = cur();
    const ap = s?.pendingApproval;
    if (!s || !ap || ap.id === answered) return;
    for (const b of [allowBtn, alwaysBtn, denyBtn]) b.disabled = true;
    try {
      answered = ap.id;
      view?.chat?.sync();
      await api.approval(s.id, { id: ap.id, decision, ...(always ? { always: true } : {}) });
      approval.hidden = true;
      sync();
    } catch (err) {
      answered = "";
      for (const b of [allowBtn, alwaysBtn, denyBtn]) b.disabled = false;
      sync();
      opts.toast(`Couldn't answer: ${(err as Error).message}`, "error");
    }
  }
  allowBtn.addEventListener("click", () => void answer("allow"));
  alwaysBtn.addEventListener("click", () => void answer("allow", true));
  denyBtn.addEventListener("click", () => void answer("deny"));

  const approvalOpen = () => {
    const s = cur();
    return !!s?.pendingApproval && s.pendingApproval.id !== answered && !ended(s) && (isChat() || !approval.hidden);
  };

  document.addEventListener("keydown", (ev) => {
    if (el.hidden || ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.repeat || !approvalOpen()) return;
    const t = ev.target;
    const typing = t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if (typing && !ev.altKey) return;
    const k = /^Digit([123])$/.exec(ev.code)?.[1];
    if (!k || (k === "2" && cur()?.pendingApproval?.noAlways)) return;
    ev.preventDefault();
    if (k === "1") void answer("allow");
    else if (k === "2") void answer("allow", true);
    else void answer("deny");
  });

  function interrupt(): void {
    const s = cur();
    if (!s) return;
    api.interrupt(s.id).catch((err: Error) => opts.toast(`Couldn't interrupt: ${err.message}`, "error"));
  }

  // Esc inside the panel interrupts a running chat turn instead of closing the panel
  el.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" || ev.defaultPrevented || !busy()) return;
    ev.preventDefault();
    interrupt();
  });

  async function send(): Promise<void> {
    const s = cur();
    const text = input.value;
    if (!s || input.disabled || sending) return;
    if (!text.trim()) {
      if (busy()) interrupt();
      return;
    }
    sending = true;
    syncComposer();
    promptErr.hidden = true;
    try {
      await api.prompt(s.id, text);
      if (input.value === text) input.value = "";
      autosize();
      view?.chat?.sent();
    } catch (err) {
      promptErr.hidden = false;
      setText(promptErr, err instanceof ControlError ? err.message : "Couldn't send.");
    } finally {
      sending = false;
      syncComposer();
      if (view?.kind === "terminal") view.term?.focus();
    }
  }
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void send();
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      void send();
    } else if (ev.key === "Escape" && !busy()) {
      input.blur();
    }
  });
  const autosize = () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(window.innerWidth < 640 ? 132 : 200, input.scrollHeight)}px`;
  };
  input.addEventListener("input", () => {
    autosize();
    syncComposer();
  });

  interruptBtn.addEventListener("click", interrupt);
  const disarm = () => {
    clearTimeout(stopArmed);
    stopArmed = 0;
    stopBtn.classList.remove("is-armed");
    setText(stopBtn.querySelector(".ses-btn-text")!, "Stop");
    stopBtn.setAttribute("aria-label", "Stop the agent");
  };
  stopBtn.addEventListener("click", () => {
    const s = cur();
    if (!s) return;
    if (!stopArmed) {
      stopBtn.classList.add("is-armed");
      setText(stopBtn.querySelector(".ses-btn-text")!, "Stop it?");
      stopBtn.setAttribute("aria-label", "Click again to stop the agent");
      stopArmed = window.setTimeout(disarm, 3200);
      return;
    }
    disarm();
    stopBtn.disabled = true;
    api.stop(s.id).catch((err: Error) => {
      stopBtn.disabled = false;
      opts.toast(`Couldn't stop: ${err.message}`, "error");
    });
  });
  stopBtn.addEventListener("blur", disarm);

  const setMax = (on: boolean) => {
    max = on;
    el.classList.toggle("is-max", on);
    maxBtn.replaceChildren(icon(on ? "minimize" : "maximize", 1));
    maxBtn.setAttribute("aria-label", on ? "Restore" : "Maximise");
    maxBtn.title = on ? "Restore" : "Maximise";
    maxBtn.setAttribute("aria-pressed", String(on));
    opts.onLayout();
    requestAnimationFrame(() => view?.term?.fit());
  };
  maxBtn.addEventListener("click", () => setMax(!max));
  closeBtn.addEventListener("click", () => opts.onClose());
  focusBtn.addEventListener("click", () => {
    const s = cur();
    if (s) opts.onFocusWorker(s.workerId);
  });
  logoSlot.addEventListener("click", () => {
    const s = cur();
    if (s) opts.onFocusWorker(s.workerId);
  });

  // a phone's on-screen keyboard: keep the composer above it
  const vv = window.visualViewport;
  vv?.addEventListener("resize", () => {
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    el.style.setProperty("--kb", `${kb > 80 ? kb : 0}px`);
  });

  return {
    el,
    open(next) {
      const s = store.get(next);
      if (!s) return;
      const fresh = next !== id;
      id = next;
      if (fresh) {
        answered = "";
        exitCode = undefined;
        notice.hidden = true;
        promptErr.hidden = true;
        disarm();
        unmount();
      }
      sync();
      if (el.hidden) {
        el.hidden = false;
        el.classList.remove("enter");
        void el.offsetWidth;
        el.classList.add("enter");
      }
      document.body.classList.add("has-session");
      requestAnimationFrame(() => {
        view?.term?.fit();
        if (view?.kind === "terminal") view.term?.focus();
        else if (!input.disabled && window.innerWidth >= 640) input.focus();
      });
    },
    close() {
      if (el.hidden) return;
      id = null;
      unmount();
      el.hidden = true;
      if (max) setMax(false);
      document.body.classList.remove("has-session");
    },
    current: () => id,
    isOpen: () => !el.hidden,
    isMax: () => max,
    sync,
    workerEvent(e) {
      const s = cur();
      if (!s || e.workerId !== s.workerId) return;
      view?.chat?.hint(e.kind);
      if (e.model && opts.worker?.(s.workerId)?.model !== modelEl.title.replace(/^Model: /, "")) sync();
    },
  };
}
