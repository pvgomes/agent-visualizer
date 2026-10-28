/*
 * Dev-only, in-memory control plane for the dev server (--scenario control):
 * every endpoint in src/shared/control.ts, no real agents, no real keys.
 * A hire emits session_start for "ctl:<id>", walks the session through
 * creating / installing / starting / running, then renames the worker to its
 * "real" session with OfficeEvent.replaces. The term stream plays a fake agent
 * TUI that echoes input and answers pasted prompts; the chat stream plays
 * fake items; approvals turn up now and then. `locked` answers 401.
 */
import { randomBytes } from "node:crypto";
import { pick } from "./chat-scripts.mjs";

const HOME = "/Users/dev";
const tidy = (p) => p.replace(/^\/Users\/[^/]+/, "~");
const base = (p) => p.split("/").filter(Boolean).pop() || p;
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const iso = (dt = 0) => new Date(Date.now() + dt).toISOString();

const FS = {
  [HOME]: ["Codes", "Desktop", "Documents", "Downloads"],
  [`${HOME}/Codes`]: ["agent-visualizer", "landing-page", "payments-svc", "side"],
  [`${HOME}/Codes/side`]: ["ascii", "dotfiles", "tui-kit"],
  [`${HOME}/Documents`]: ["notes"],
};
const GIT = new Set([`${HOME}/Codes/agent-visualizer`, `${HOME}/Codes/landing-page`, `${HOME}/Codes/payments-svc`, `${HOME}/Codes/side/ascii`, `${HOME}/Codes/side/dotfiles`, `${HOME}/Codes/side/tui-kit`]);

const NAMES = { claude: "Claude Code", codex: "Codex", opencode: "opencode", commandcode: "Command Code", droid: "Droid", gemini: "Gemini CLI", qwen: "Qwen Code", cursor: "Cursor" };

export function createControlMock({ locked = false, emitControl, emitOffice, empty = false, chatBare = false, chatSpeed = 1 }) {
  const keys = [
    { name: "ANTHROPIC_API_KEY", agents: ["claude"], preview: "sk-ant-…9f2c", addedAt: iso(-86_400_000 * 3) },
    { name: "OPENAI_API_KEY", agents: ["codex", "opencode"], preview: "sk-pro…41d0", addedAt: iso(-86_400_000) },
    { name: "DAYTONA_API_KEY", agents: [], preview: "dtn_3a…77b1", addedAt: iso(-3_600_000 * 5) },
  ];
  const providers = [
    {
      kind: "daytona", name: "Daytona", ready: true, via: "DAYTONA_API_KEY", canCreate: true,
      sandboxes: [
        { id: "dt-7f3a91", name: "auth-refactor", provider: "daytona", status: "running", ours: true, createdAt: iso(-1_800_000), expiresAt: iso(2_400_000), workers: 0 },
        { id: "dt-0dd1c4", name: "nightly-evals", provider: "daytona", status: "running", ours: false, createdAt: iso(-7_200_000), workers: 0 },
      ],
    },
    { kind: "vercel", name: "Vercel Sandbox", ready: true, via: "sandbox CLI login", canCreate: true, sandboxes: [] },
    { kind: "railway", name: "Railway", ready: false, canCreate: false, sandboxes: [] },
    { kind: "ssh", name: "ssh", ready: true, canCreate: false, sandboxes: [], hosts: ["gpu-box", "shubham", "build"] },
  ];
  const agents = [
    { agent: "claude", installed: true, version: "2.1.30", modes: ["terminal", "chat"], keyNames: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] },
    { agent: "codex", installed: true, version: "0.98.0", modes: ["terminal", "chat"], keyNames: ["OPENAI_API_KEY"] },
    { agent: "opencode", installed: true, version: "1.4.2", modes: ["terminal", "chat"], keyNames: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"] },
    { agent: "commandcode", installed: true, version: "3.2.0", modes: ["terminal"], keyNames: ["COMMANDCODE_API_KEY"] },
    { agent: "droid", installed: true, version: "0.22.1", modes: ["terminal"], keyNames: ["FACTORY_API_KEY"] },
    { agent: "gemini", installed: false, modes: ["terminal"], installCmd: "npm i -g @google/gemini-cli", keyNames: ["GEMINI_API_KEY"] },
    { agent: "qwen", installed: false, modes: ["terminal"], installCmd: "npm i -g @qwen-code/qwen-code", keyNames: ["DASHSCOPE_API_KEY"] },
    { agent: "cursor", installed: false, modes: ["terminal"], installCmd: "curl https://cursor.com/install -fsS | bash", keyNames: ["CURSOR_API_KEY"] },
  ];
  const service = { supported: true, installed: false, running: false, startAtLogin: false, platform: "darwin" };
  const recentFolders = [`${HOME}/Codes/agent-visualizer`, `${HOME}/Codes/payments-svc`, `${HOME}/Codes/landing-page`, `${HOME}/Codes/side/ascii`];
  /** id -> { s: ControlSession, term: {buf, line, clients:Set}, chat: {items, clients:Set}, timers:[] } */
  const sessions = new Map();

  const info = () => ({ enabled: true, agents, providers, keys, service, sessions: [...sessions.values()].map((x) => x.s), recentFolders });
  const changed = (x) => emitControl("control", x.s);
  const infoChanged = (patch) => emitControl("control_info", patch);

  /* ------------------------------------------------------------ helpers */
  function hostFor(place, sbxName) {
    if (place.kind === "local") return undefined;
    if (place.kind === "ssh") return { kind: "ssh", id: `ssh:${place.target}`, name: place.target };
    return { kind: place.kind, id: `${place.kind}:${place.target}`, name: sbxName || place.target };
  }

  function office(x, kind, extra = {}) {
    const s = x.s;
    emitOffice({ ts: iso(), agent: s.agent, workerId: s.workerId, project: s.title, host: s.host, cwd: x.cwd, model: x.model, kind, ...extra });
  }

  /* ----------------------------------------------------------- term TUI */
  const C = { dim: "\x1b[2m", reset: "\x1b[0m", bold: "\x1b[1m", orange: "\x1b[38;2;217;119;87m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m", gray: "\x1b[90m" };
  function write(x, text) {
    x.term.buf += text;
    if (x.term.buf.length > 200_000) x.term.buf = x.term.buf.slice(-150_000);
    for (const res of x.term.clients) res.write(`event: data\ndata: ${JSON.stringify({ d: b64(text) })}\n\n`);
  }
  const PROMPT = `${C.orange}>${C.reset} `;
  function banner(x) {
    const s = x.s;
    const w = Math.max(30, Math.min(52, (x.cols ?? 80) - 1));
    const line = (t, vis = t.length) => `${C.orange}│${C.reset} ${t}${" ".repeat(Math.max(0, w - 3 - vis))}${C.orange}│${C.reset}\r\n`;
    write(x, `${C.orange}╭${"─".repeat(w - 2)}╮${C.reset}\r\n`);
    const title = `✻ ${NAMES[s.agent]} (mock agent)`;
    write(x, line(`${C.bold}${title}${C.reset}`, title.length));
    write(x, line(""));
    const cwd = `cwd: ${x.cwd}`;
    write(x, line(`${C.gray}${cwd}${C.reset}`, cwd.length));
    const perm = `permissions: ${s.permission}`;
    write(x, line(`${C.gray}${perm}${C.reset}`, perm.length));
    write(x, `${C.orange}╰${"─".repeat(w - 2)}╯${C.reset}\r\n\r\n`);
    write(x, `${C.dim}  Type a prompt and press Enter. ↑/↓ history, Esc to interrupt.${C.reset}\r\n\r\n${PROMPT}`);
  }

  function answerTerm(x, text) {
    const t = text.trim();
    if (!t) return write(x, `\r\n${PROMPT}`);
    write(x, `\r\n\r\n${C.orange}●${C.reset} I'll look into "${t.slice(0, 60)}".\r\n`);
    const steps = [
      [`${C.green}●${C.reset} ${C.bold}Read${C.reset}(src/server/http.ts)`, `  ${C.gray}⎿  Read 214 lines${C.reset}`],
      [`${C.green}●${C.reset} ${C.bold}Grep${C.reset}("CONTROL_HEADER")`, `  ${C.gray}⎿  Found 3 files${C.reset}`],
      [`${C.green}●${C.reset} ${C.bold}Bash${C.reset}(npm test)`, `  ${C.gray}⎿  ${C.green}✓${C.gray} 198 passed${C.reset}`],
    ];
    office(x, "prompt");
    let i = 0;
    const tick = () => {
      if (!sessions.has(x.s.id) || x.s.status !== "running") return;
      if (i < steps.length) {
        const [a, b] = steps[i];
        write(x, `\r\n${a}\r\n${b}\r\n`);
        office(x, "tool_start", { tool: ["Read", "Grep", "Bash"][i], category: ["read", "search", "bash"][i], summary: ["Read http.ts", "Grep CONTROL_HEADER", "$ npm test"][i] });
        i++;
        x.timers.push(setTimeout(tick, 900));
        return;
      }
      if (Math.random() < 0.5 && !x.s.pendingApproval) return askApproval(x);
      write(x, `\r\n${C.orange}●${C.reset} Done. The header is checked on every control route.\r\n\r\n${PROMPT}`);
      office(x, "waiting");
    };
    x.timers.push(setTimeout(tick, 700));
  }

  function askApproval(x) {
    if (x.s.mode === "chat") {
      if (!x.chat.turn) chatPrompt(x, "clean the build and push a preview");
      return;
    }
    const ap = { id: randomBytes(4).toString("hex"), tool: "Bash", category: "bash", summary: "$ rm -rf dist", at: iso() };
    x.s.pendingApproval = ap;
    if (x.s.mode === "terminal") {
      write(x, `\r\n${C.yellow}╭─ Bash command ${"─".repeat(30)}╮${C.reset}\r\n${C.yellow}│${C.reset}  rm -rf dist${" ".repeat(33)}${C.yellow}│${C.reset}\r\n${C.yellow}╰${"─".repeat(46)}╯${C.reset}\r\n Do you want to proceed?\r\n ${C.bold}❯ 1. Yes${C.reset}\r\n   2. Yes, and don't ask again for rm\r\n   3. No, and tell me what to do differently\r\n`);
    } else {
      chatPut(x, { id: `ap-${ap.id}`, kind: "approval", tool: "Bash", category: "bash", summary: "$ rm -rf dist", text: "waiting for you", at: iso() });
    }
    office(x, "waiting", { summary: "Approve $ rm?" });
    changed(x);
  }

  function resolveApproval(x, a) {
    if (x.s.mode === "chat") return chatAnswer(x, a);
    const ap = x.s.pendingApproval;
    if (!ap || ap.id !== a.id) return false;
    delete x.s.pendingApproval;
    const verdict = a.decision === "allow" ? (a.always ? "allowed (always)" : "allowed") : "denied";
    if (x.s.mode === "terminal") {
      write(x, `\r\n${a.decision === "allow" ? C.green : C.red}  ${verdict}${C.reset}\r\n`);
      if (a.decision === "allow") write(x, `${C.green}●${C.reset} ${C.bold}Bash${C.reset}(rm -rf dist)\r\n  ${C.gray}⎿  (no output)${C.reset}\r\n`);
      write(x, `\r\n${C.orange}●${C.reset} ${a.decision === "allow" ? "Cleaned dist/. All done." : "Okay, I left dist/ alone."}\r\n\r\n${PROMPT}`);
    } else {
      chatPut(x, { id: `ap-${ap.id}`, kind: "approval", tool: "Bash", category: "bash", summary: "$ rm -rf dist", text: verdict, at: ap.at });
      if (a.decision === "allow") chatPut(x, { id: `t-${ap.id}`, kind: "tool", tool: "Bash", category: "bash", summary: "$ rm -rf dist", status: "ok", at: iso() });
      chatPut(x, { id: `a-${ap.id}`, kind: "assistant", text: a.decision === "allow" ? "Cleaned dist/. All done." : "Okay, I left dist/ alone.", at: iso() });
    }
    office(x, a.decision === "allow" ? "tool_start" : "thinking", a.decision === "allow" ? { tool: "Bash", category: "bash", summary: "$ rm" } : {});
    changed(x);
    return true;
  }

  function termInput(x, data) {
    if (x.s.status !== "running") return;
    x.term.used = true;
    // bracketed paste: the pasted text as typed
    data = data.replace(/\x1b\[200~([\s\S]*?)\x1b\[201~/g, (_, t) => t.replace(/\r?\n/g, " "));
    for (const ch of data) {
      if (x.s.pendingApproval && /[123]/.test(ch)) {
        resolveApproval(x, { id: x.s.pendingApproval.id, decision: ch === "3" ? "deny" : "allow", always: ch === "2" });
        continue;
      }
      if (ch === "\r") {
        const line = x.term.line;
        x.term.line = "";
        answerTerm(x, line);
      } else if (ch === "\x7f") {
        if (x.term.line) {
          x.term.line = x.term.line.slice(0, -1);
          write(x, "\b \b");
        }
      } else if (ch === "\x03") {
        x.term.line = "";
        write(x, `^C\r\n${PROMPT}`);
      } else if (ch === "\x1b") {
        interrupt(x);
      } else if (ch >= " ") {
        x.term.line += ch;
        write(x, ch);
      }
    }
  }

  function interrupt(x) {
    if (x.s.mode === "chat") return chatInterrupt(x);
    for (const t of x.timers) clearTimeout(t);
    x.timers = [];
    write(x, `\r\n  ${C.red}⎿  Interrupted by user${C.reset}\r\n\r\n${PROMPT}`);
    office(x, "error", { summary: "interrupted" });
  }

  /* --------------------------------------------------------------- chat */
  /*
   * A chat plays scripted turns (chat-scripts.mjs) the way the real adapters
   * emit them: items put again by id as they change, assistant text streamed
   * a few words at a time, a tool's `at` restamped when it ends. It also fills
   * the optional ChatItem fields (turnId, streaming, durationMs, detail, diff,
   * tokens, queued, turnEnd); --chat-bare strips them, to see the page on the
   * bare contract. Prompts sent mid-turn queue, Claude style.
   */
  const OPTIONAL = ["turnId", "streaming", "durationMs", "detail", "diff", "tokens", "queued", "turnEnd"];
  const ms = (n) => Math.max(10, Math.round(n * chatSpeed));

  function chatPut(x, item) {
    let out = item;
    if (chatBare) {
      out = { ...item };
      for (const k of OPTIONAL) delete out[k];
      if (item.turnEnd && item.kind === "system" && !item.text) return; // a bare stream has no end marker
    }
    const i = x.chat.items.findIndex((it) => it.id === out.id);
    if (i >= 0) x.chat.items[i] = out;
    else x.chat.items.push(out);
    if (x.chat.items.length > 2000) x.chat.items.splice(0, x.chat.items.length - 2000);
    for (const res of x.chat.clients) res.write(`event: item\ndata: ${JSON.stringify(out)}\n\n`);
  }

  const DEAD = Symbol("interrupted");

  function chatPrompt(x, text) {
    const c = x.chat;
    const turnId = `t${++c.n}`;
    const user = { id: `u-${turnId}`, kind: "user", text, turnId, at: iso() };
    if (c.turn) {
      // Claude queues it and runs it when the current turn ends
      chatPut(x, { ...user, queued: true });
      c.queue.push(user);
      return;
    }
    chatPut(x, user);
    runTurn(x, user);
  }

  function runTurn(x, user) {
    const c = x.chat;
    const s = x.s;
    const T = { id: user.turnId, t0: Date.now(), timers: [], dead: false, tokens: 0, running: new Map(), ask: null, k: 0 };
    c.turn = T;
    office(x, "prompt");
    const alive = () => !T.dead && sessions.has(s.id) && s.status === "running";
    const sleep = (n) => new Promise((res, rej) => {
      const t = setTimeout(() => (alive() ? res() : rej(DEAD)), ms(n));
      T.timers.push(t);
    });
    const p = {
      agent: s.agent,
      think: async (n) => {
        office(x, "thinking");
        await sleep(n);
      },
      say: async (text, o = {}) => {
        const id = `a-${T.id}-${++T.k}`;
        const words = text.match(/\S+\s*|\s+/g) ?? [text];
        let shown = "";
        for (let i = 0; i < words.length; ) {
          const n = 2 + Math.floor(Math.random() * 4);
          shown += words.slice(i, i + n).join("");
          i += n;
          if (i < words.length) {
            chatPut(x, { id, kind: "assistant", text: shown, turnId: T.id, streaming: true, at: iso() });
            await sleep(o.final ? 55 : 45);
          }
        }
        T.tokens += Math.round(text.length / 3.6);
        chatPut(x, { id, kind: "assistant", text, turnId: T.id, streaming: false, at: iso() });
        office(x, "reply");
      },
      tool: async (spec) => {
        const id = `t-${T.id}-${++T.k}`;
        const base = { id, kind: "tool", tool: spec.tool, category: spec.category, summary: spec.summary, turnId: T.id };
        const t0 = Date.now();
        T.running.set(id, base);
        chatPut(x, { ...base, status: "running", at: iso() });
        office(x, "tool_start", { tool: spec.tool, category: spec.category, summary: spec.summary });
        await sleep(spec.ms ?? 300);
        T.running.delete(id);
        const bad = spec.status === "error";
        const done = { ...base, status: bad ? "error" : "ok", durationMs: Date.now() - t0, at: iso() };
        if (spec.detail) done.detail = spec.detail;
        if (spec.diff) done.diff = spec.diff;
        chatPut(x, done);
        T.tokens += 400 + Math.round((spec.detail?.length ?? 0) / 3);
        if (/\btest\b/.test(spec.summary ?? "") && spec.category === "bash") office(x, bad ? "test_fail" : "test_pass", { summary: spec.summary });
        else if (bad) office(x, "tool_end", { tool: spec.tool, category: spec.category, summary: spec.summary, isError: true });
        return done;
      },
      ask: async (spec) => {
        const id = `t-${T.id}-${++T.k}`;
        const base = { id, kind: "tool", tool: spec.tool, category: spec.category, summary: spec.summary, turnId: T.id };
        T.running.set(id, base);
        chatPut(x, { ...base, status: "running", at: iso() });
        const ap = { id: randomBytes(4).toString("hex"), tool: spec.tool, category: spec.category, summary: spec.summary, at: iso() };
        const apItem = { id: `ap-${ap.id}`, kind: "approval", tool: ap.tool, category: ap.category, summary: ap.summary, turnId: T.id, at: ap.at };
        chatPut(x, { ...apItem, text: "Waiting for you" });
        s.pendingApproval = ap;
        changed(x);
        office(x, "waiting", { summary: `Approve ${spec.summary}?` });
        const answer = await new Promise((res) => (T.ask = { ap, apItem, res }));
        if (!alive()) throw DEAD;
        T.ask = null;
        chatPut(x, { ...apItem, text: answer.decision === "allow" ? (answer.always ? "Allowed for this session" : "Allowed") : "Denied" });
        if (answer.decision !== "allow") {
          T.running.delete(id);
          chatPut(x, { ...base, status: "error", durationMs: 0, at: iso() });
          office(x, "thinking");
          return "deny";
        }
        const t0 = Date.now();
        office(x, "tool_start", { tool: spec.tool, category: spec.category, summary: spec.summary });
        await sleep(spec.ms ?? 300);
        T.running.delete(id);
        chatPut(x, { ...base, status: "ok", durationMs: Date.now() - t0, ...(spec.detail ? { detail: spec.detail } : {}), at: iso() });
        return "allow";
      },
      fail: async (text, detail) => {
        chatPut(x, { id: `err-${T.id}`, kind: "error", text, ...(detail ? { detail } : {}), turnId: T.id, turnEnd: true, durationMs: Date.now() - T.t0, tokens: T.tokens, at: iso() });
        office(x, "error", { summary: "API error" });
        T.failed = true;
      },
    };
    const script = pick(s.agent, user.text, c.n - 1);
    script(p).then(
      () => endTurn(x, T),
      (err) => {
        if (err !== DEAD) console.error("[control mock] chat script failed", err);
      },
    );
  }

  function endTurn(x, T) {
    const c = x.chat;
    if (c.turn !== T) return;
    if (!T.failed) chatPut(x, { id: `end-${T.id}`, kind: "system", turnId: T.id, turnEnd: true, durationMs: Date.now() - T.t0, tokens: T.tokens, at: iso() });
    c.turn = null;
    office(x, T.failed ? "error" : "waiting");
    nextQueued(x);
  }

  function nextQueued(x) {
    const c = x.chat;
    const next = c.queue.shift();
    if (!next) return;
    setTimeout(() => {
      if (!sessions.has(x.s.id) || x.s.status !== "running") return;
      const user = { ...next, at: iso() };
      chatPut(x, user); // put again without `queued`: its turn starts now
      runTurn(x, user);
    }, ms(500));
  }

  function chatAnswer(x, a) {
    const T = x.chat.turn;
    const ap = x.s.pendingApproval;
    if (!T?.ask || !ap || ap.id !== a.id) return false;
    delete x.s.pendingApproval;
    changed(x);
    T.ask.res(a);
    return true;
  }

  function chatInterrupt(x) {
    const T = x.chat.turn;
    if (!T) return;
    T.dead = true;
    for (const t of T.timers) clearTimeout(t);
    if (T.ask) {
      chatPut(x, { ...T.ask.apItem, text: "Interrupted" });
      delete x.s.pendingApproval;
      changed(x);
      T.ask = null;
    }
    for (const base of T.running.values()) chatPut(x, { ...base, status: "error", at: iso() });
    T.running.clear();
    chatPut(x, { id: `int-${T.id}`, kind: "system", text: "Interrupted.", turnId: T.id, turnEnd: true, durationMs: Date.now() - T.t0, tokens: T.tokens, at: iso() });
    office(x, "error", { summary: "interrupted" });
    x.chat.turn = null;
    nextQueued(x);
  }

  /* --------------------------------------------------------------- hire */
  function hire(req) {
    const id = randomBytes(3).toString("hex");
    const place = req.place;
    const remote = place.kind !== "local";
    const prov = providers.find((p) => p.kind === place.kind);
    let sbx = prov?.sandboxes.find((s) => s.id === place.target);
    if (place.kind !== "local" && place.kind !== "ssh" && place.target === "new") {
      sbx = { id: `${place.kind.slice(0, 2)}-${randomBytes(3).toString("hex")}`, name: `office-${id}`, provider: place.kind, status: "starting", ours: true, createdAt: iso(), expiresAt: iso((req.sandbox?.timeoutMin ?? 30) * 60_000), workers: 0 };
      prov.sandboxes.push(sbx);
      infoChanged({ providers });
    }
    const title = place.kind === "local" ? base(place.target) : place.cwd ? base(place.cwd) : sbx?.name ?? place.target;
    const s = {
      id, agent: req.agent, place: { ...place, target: sbx?.id ?? place.target }, host: hostFor({ ...place, target: sbx?.id ?? place.target }, sbx?.name), mode: req.mode,
      workerId: `ctl:${id}`, status: place.target === "new" ? "creating" : remote ? "installing" : "starting",
      detail: place.target === "new" ? `Creating ${prov?.name ?? place.kind} sandbox…` : remote ? `Installing ${NAMES[req.agent]}…` : `Starting ${NAMES[req.agent]}…`,
      startedAt: iso(), title, permission: req.permission ?? "default",
    };
    const x = { s, cwd: place.kind === "local" ? place.target : place.cwd || (place.kind === "ssh" ? `/home/dev` : "/home/sandbox"), model: req.agent === "claude" ? "claude-opus-5-5" : req.agent === "codex" ? "gpt-5.6-sol" : "mock-model", term: { buf: "", line: "", clients: new Set() }, chat: { items: [], clients: new Set(), turn: null, queue: [], n: 0 }, timers: [] };
    sessions.set(id, x);
    office(x, "session_start");
    const steps = [];
    if (s.status === "creating") steps.push([2600, () => { if (sbx) sbx.status = "running"; s.status = "installing"; s.detail = `Installing ${NAMES[req.agent]}…`; infoChanged({ providers }); }]);
    if (remote) steps.push([2000, () => { s.status = "starting"; s.detail = `Starting ${NAMES[req.agent]}…`; }]);
    steps.push([1100, () => {
      s.status = "running";
      delete s.detail;
      if (s.mode === "terminal") banner(x);
      else chatPut(x, { id: "sys-0", kind: "system", text: `${NAMES[s.agent]} is ready in ${tidy(x.cwd)}.`, at: iso() });
      office(x, "waiting");
      if (req.prompt) x.timers.push(setTimeout(() => (s.mode === "terminal" ? (write(x, req.prompt), answerTerm(x, req.prompt)) : chatPrompt(x, req.prompt)), 600));
    }]);
    // the real transcript turns up: the worker is renamed in place
    steps.push([4200, () => {
      const old = s.workerId;
      s.workerId = `sess-${id}`;
      emitOffice({ ts: iso(), agent: s.agent, workerId: s.workerId, project: s.title, host: s.host, cwd: x.cwd, model: x.model, kind: "session_start", replaces: old });
      if (sbx) sbx.workers = 1;
    }]);
    let at = 0;
    for (const [ms, fn] of steps) {
      at += ms;
      x.timers.push(setTimeout(() => { if (sessions.has(id) && s.status !== "exited") { fn(); changed(x); } }, at));
    }
    // background chatter while it runs, so the worker looks alive
    x.chatter = setInterval(() => {
      if (s.status !== "running" || s.pendingApproval || s.mode === "chat") return;
      const r = Math.random();
      if (r < 0.5) office(x, "tool_start", { tool: "Read", category: "read", summary: `Read ${["cli.ts", "http.ts", "state.ts", "README.md"][Math.floor(Math.random() * 4)]}` });
      else if (r < 0.7) office(x, "thinking");
      else if (r < 0.75 && !x.s.pendingApproval) askApproval(x);
    }, 5200);
    return s;
  }

  function stop(x, code = 0) {
    for (const t of x.timers) clearTimeout(t);
    clearInterval(x.chatter);
    x.s.status = "exited";
    x.s.exitCode = code;
    delete x.s.pendingApproval;
    delete x.s.detail;
    if (x.s.mode === "terminal") write(x, `\r\n${C.dim}Goodbye.${C.reset}\r\n`);
    if (x.chat.turn) {
      const T = x.chat.turn;
      T.dead = true;
      for (const t of T.timers) clearTimeout(t);
      for (const base of T.running.values()) chatPut(x, { ...base, status: "error", at: iso() });
      x.chat.turn = null;
      x.chat.queue = [];
    }
    if (x.s.mode === "chat") chatPut(x, { id: "sys-end", kind: "system", text: `${NAMES[x.s.agent]} exited.`, at: iso() });
    for (const res of x.term.clients) res.write(`event: exit\ndata: ${JSON.stringify({ code })}\n\n`);
    office(x, "session_end");
    changed(x);
    setTimeout(() => {
      sessions.delete(x.s.id);
      emitControl("control_gone", { id: x.s.id });
    }, 90_000);
  }

  /* --------------------------------------------------------------- http */
  const json = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve(null); } });
  });
  const sse = (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => clearInterval(ping));
  };

  /** GET /setup: a plausible "Your setup" inventory (names only, like the real one). */
  function setupInventory(agent, folder) {
    const claude = agent === "claude", codex = agent === "codex";
    const login = claude
      ? [
          { kind: "subscription", label: "Claude subscription", detail: "expires ~Oct 2027", available: true, keys: ["CLAUDE_CODE_OAUTH_TOKEN"] },
          { kind: "key", label: "API key", detail: "ANTHROPIC_API_KEY, stored", available: true, keys: ["ANTHROPIC_API_KEY"] },
          { kind: "none", label: "Sign in there myself", available: true },
        ]
      : codex
        ? [
            { kind: "key", label: "API key", detail: "OPENAI_API_KEY, stored", available: true, keys: ["OPENAI_API_KEY"] },
            { kind: "device", label: "Device code", detail: "Codex shows a link and a code in the terminal", available: true },
            { kind: "copy", label: "This Mac's ChatGPT sign-in", detail: "~/.codex/auth.json", available: true },
          ]
        : [];
    const mcp = claude || codex
      ? [
          { name: "github", transport: "http", scope: "user", ok: true, what: "api.githubcopilot.com", secrets: 1 },
          { name: "linear", transport: "sse", scope: "user", ok: true, what: "mcp.linear.app" },
          { name: "playwright", transport: "stdio", scope: "user", ok: true, what: "npx -y @playwright/mcp" },
          { name: "postgres", transport: "stdio", scope: "local", ok: true, what: "uvx mcp-server-postgres", secrets: 1 },
          { name: "notes", transport: "stdio", scope: "user", ok: false, why: "runs ~/bin/notes-mcp, which the sandbox won't have" },
          { name: "figma", transport: "http", scope: "user", ok: false, why: "listens on this Mac's localhost", what: "127.0.0.1:3845" },
        ]
      : [];
    const instructions = claude
      ? [
          { id: "CLAUDE.md", label: "CLAUDE.md", files: 1, bytes: 4_200 },
          { id: "rules", label: "Rules", files: 3, bytes: 9_800 },
          { id: "skills", label: "Skills", files: 41, bytes: 512_000, count: 12, skipped: ["render/bin/ffmpeg: 40 MB binary"] },
          { id: "agents", label: "Agents", files: 2, bytes: 3_100 },
          { id: "settings.json", label: "settings.json", files: 1, bytes: 1_600, skipped: ["hooks: run files on this Mac"] },
        ]
      : codex
        ? [{ id: "AGENTS.md", label: "AGENTS.md", files: 1, bytes: 2_900 }, { id: "prompts", label: "Prompts", files: 4, bytes: 6_400 }]
        : [];
    const project = folder
      ? { folder, display: tidy(folder), files: 412, bytes: 3_250_000, git: { present: true, bytes: 8_400_000, ok: true }, envFiles: [".env.local"], ok: true }
      : undefined;
    const notes = claude || codex ? [] : [`MCP servers and instructions come along for Claude Code and Codex; ${NAMES[agent] ?? agent} gets its keys and the project.`];
    return { agent, login, shellKeys: ["GITHUB_TOKEN"], mcp, instructions, ...(project ? { project } : {}), notes };
  }

  async function handle(req, res, url) {
    if (!url.pathname.startsWith("/api/control")) return false;
    if (req.headers["x-agent-visualizer"] !== "1") return json(res, 403, { error: "Missing the X-Agent-Visualizer header." }), true;
    if (locked) return json(res, 401, { error: "Controls are locked in this browser." }), true;
    const path = url.pathname.slice("/api/control".length) || "/";
    const m = /^\/sessions\/([^/]+)\/(\w+)$/.exec(path);
    const method = req.method ?? "GET";

    if (path === "/" && method === "GET") return json(res, 200, info()), true;
    if (path === "/hire" && method === "POST") {
      const body = await readBody(req);
      if (!body?.agent || !body?.place?.kind || !body?.place?.target) return json(res, 400, { error: "Pick an agent and a place." }), true;
      const av = agents.find((a) => a.agent === body.agent);
      if (body.place.kind === "local" && !av?.installed) return json(res, 400, { error: `${NAMES[body.agent]} isn't installed on this Mac.` }), true;
      const s = hire(body);
      return json(res, 200, s), true;
    }
    if (path === "/setup" && method === "GET") {
      const agent = url.searchParams.get("agent") ?? "claude";
      const folder = url.searchParams.get("folder");
      return json(res, 200, setupInventory(agent, folder)), true;
    }
    if (path === "/fs" && method === "GET") {
      const p = url.searchParams.get("path") || HOME;
      if (!p.startsWith(HOME)) return json(res, 403, { error: "Only folders under your home." }), true;
      const dirs = (FS[p] ?? []).map((name) => ({ name, path: `${p}/${name}`, git: GIT.has(`${p}/${name}`) }));
      return json(res, 200, { path: tidy(p), parent: p === HOME ? undefined : p.slice(0, p.lastIndexOf("/")), dirs }), true;
    }
    if (m) {
      const x = sessions.get(decodeURIComponent(m[1]));
      if (!x) return json(res, 404, { error: "No such session." }), true;
      const what = m[2];
      if (what === "term" && method === "GET") {
        if (x.s.mode !== "terminal") return json(res, 404, { error: "Not a terminal session." }), true;
        sse(req, res);
        if (x.term.buf) res.write(`event: data\ndata: ${JSON.stringify({ d: b64(x.term.buf) })}\n\n`);
        if (x.s.status === "exited") res.write(`event: exit\ndata: ${JSON.stringify({ code: x.s.exitCode ?? 0 })}\n\n`);
        x.term.clients.add(res);
        req.on("close", () => x.term.clients.delete(res));
        return true;
      }
      if (what === "chat" && method === "GET") {
        if (x.s.mode !== "chat") return json(res, 404, { error: "Not a chat session." }), true;
        sse(req, res);
        for (const it of x.chat.items) res.write(`event: item\ndata: ${JSON.stringify(it)}\n\n`);
        x.chat.clients.add(res);
        req.on("close", () => x.chat.clients.delete(res));
        return true;
      }
      if (method !== "POST") return json(res, 405, { error: "POST only." }), true;
      const body = (await readBody(req)) ?? {};
      if (what === "input") { termInput(x, String(body.data ?? "")); return json(res, 204), true; }
      if (what === "resize") {
        const cols = Number(body.cols) || 80;
        // a real TUI redraws on SIGWINCH; the mock redraws its banner until someone types
        if (cols !== x.cols && !x.term.used && x.s.status === "running") {
          x.cols = cols;
          x.term.buf = "";
          write(x, "\x1b[2J\x1b[3J\x1b[H");
          banner(x);
        }
        x.cols = cols;
        return json(res, 204), true;
      }
      if (what === "prompt") {
        const text = String(body.text ?? "");
        if (x.s.status !== "running") return json(res, 409, { error: "The agent isn't running." }), true;
        if (x.s.mode === "terminal") { write(x, text.replace(/\n/g, " ")); x.term.line = ""; answerTerm(x, text); }
        else chatPrompt(x, text);
        return json(res, 204), true;
      }
      if (what === "interrupt") { interrupt(x); return json(res, 204), true; }
      if (what === "stop") { stop(x, 0); return json(res, 204), true; }
      if (what === "approval") {
        if (!resolveApproval(x, body)) return json(res, 409, { error: "That approval is no longer open." }), true;
        return json(res, 204), true;
      }
      return json(res, 404, { error: "Unknown action." }), true;
    }
    if (path === "/keys" && method === "POST") {
      const body = await readBody(req);
      const name = String(body?.name ?? "");
      const value = String(body?.value ?? "");
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !value) return json(res, 400, { error: "A key needs a name and a value." }), true;
      // the mock keeps only a preview; the value is dropped here
      const k = { name, agents: Array.isArray(body.agents) ? body.agents : [], preview: value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : "•••", addedAt: iso() };
      const i = keys.findIndex((x) => x.name === name);
      if (i >= 0) keys[i] = k;
      else keys.push(k);
      infoChanged({ keys });
      return json(res, 200, k), true;
    }
    if (path.startsWith("/keys/") && method === "DELETE") {
      const name = decodeURIComponent(path.slice(6));
      const i = keys.findIndex((x) => x.name === name);
      if (i < 0) return json(res, 404, { error: "No such key." }), true;
      keys.splice(i, 1);
      infoChanged({ keys });
      return json(res, 204), true;
    }
    if (path === "/keys/import" && method === "POST") {
      const add = ["OPENROUTER_API_KEY", "GEMINI_API_KEY"].filter((n) => !keys.some((k) => k.name === n));
      for (const n of add) keys.push({ name: n, agents: n === "GEMINI_API_KEY" ? ["gemini"] : ["opencode"], preview: n === "GEMINI_API_KEY" ? "AIzaSy…Q2x8" : "sk-or-…c07e", addedAt: iso() });
      if (add.length) infoChanged({ keys });
      return json(res, 200, { imported: add }), true;
    }
    if (path === "/sandboxes/delete" && method === "POST") {
      const body = await readBody(req);
      const prov = providers.find((p) => p.kind === body?.provider);
      const i = prov ? prov.sandboxes.findIndex((s) => s.id === body.id) : -1;
      if (i < 0) return json(res, 404, { error: "No such sandbox." }), true;
      if (!prov.sandboxes[i].ours && !body.force) return json(res, 409, { error: "The office didn't create that sandbox." }), true;
      prov.sandboxes.splice(i, 1);
      infoChanged({ providers });
      return json(res, 204), true;
    }
    if (path === "/service" && method === "POST") {
      const body = await readBody(req);
      service.startAtLogin = !!body?.startAtLogin;
      service.installed = service.startAtLogin;
      service.running = service.startAtLogin;
      infoChanged({ service });
      return json(res, 200, service), true;
    }
    if (path === "/install") {
      const applied = method === "POST";
      const plan = {
        applied,
        agents: agents.map((a) => ({
          agent: a.agent,
          found: a.installed,
          mcp: !a.installed ? "skip" : applied ? "ok" : a.agent === "claude" ? "ok" : "add",
          skill: !a.installed ? "skip" : applied ? "ok" : "add",
          files: a.installed ? [a.agent === "codex" ? "~/.codex/config.toml" : a.agent === "claude" ? "~/.claude.json" : `~/.${a.agent}/mcp.json`] : [],
          diff: a.installed && !applied && a.agent !== "claude" ? `--- ~/.${a.agent}/mcp.json\n+++ ~/.${a.agent}/mcp.json\n@@\n   "mcpServers": {\n+    "agent-visualizer": { "command": "npx", "args": ["-y", "agent-visualizer@0.1.0", "mcp"] }\n   }` : undefined,
        })),
      };
      return json(res, 200, plan), true;
    }
    return json(res, 404, { error: "Unknown control route." }), true;
  }

  if (!empty) {
    // one agent already running when the page opens, so the panel can be tried at once
    const s = hire({ agent: "claude", place: { kind: "local", target: `${HOME}/Codes/agent-visualizer` }, mode: "terminal", permission: "default" });
    void s;
  }

  /** Dev hooks for scripted screenshots: GET /__control?do=approval[&mode=chat]. */
  function poke(what, mode) {
    const x = [...sessions.values()].find((v) => v.s.status === "running" && !v.s.pendingApproval && (!mode || v.s.mode === mode));
    if (what === "approval" && x) askApproval(x);
    return !!x;
  }

  return { handle, poke };
}
