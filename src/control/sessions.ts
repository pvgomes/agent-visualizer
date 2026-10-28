/*
 * Hired agents: the registry behind /api/control/sessions.
 *
 * A hire becomes a worker at once ("ctl:<id>", held so no quiet timer sends
 * it home), then its process starts: the agent's TUI in a PTY here (terminal
 * mode), its headless protocol on pipes (chat mode), or either one in a
 * sandbox or ssh box through Places. When the agent's real transcript shows
 * up the office renames the worker in place, and the session follows it.
 *
 * Terminal sessions keep a headless screen (TermBuffer) so any number of
 * browsers can attach, leave and come back. Chat sessions keep their last
 * 500 items. Either way an exited session stays viewable for EXITED_KEEP_MS.
 *
 * Nothing secret is logged: log lines name the agent, project and mode,
 * never argv, prompts or keys.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, sep } from "node:path";
import { BRAND, type AgentKind, type EventKind, type RawEvent } from "../shared/events.ts";
import type {
  AgentAvailability, Approval, ApprovalAnswer, ChatItem, ControlSession, HireRequest, PermissionMode, SessionStatus, SetupChoice,
} from "../shared/control.ts";
import { safe } from "../ingest/redact.ts";
import { scrubMessage } from "../remote/util.ts";
import { chatLaunch, driveOf, findBin, permissionsOf, pinsSessionId, probeAgents, terminalLaunch, type FoundBins } from "./agents.ts";
import { ApprovalQueue, approvalPose, claudeToolDetail, claudeToolLabel, hookReply, sessionPermissions, tokenMatches, type HookOutcome } from "./approvals.ts";
import { AcpChat, ACP_PROFILES } from "./chat/acp.ts";
import { ClaudeChat } from "./chat/claude.ts";
import { CodexChat } from "./chat/codex.ts";
import { localPipe } from "./chat/common.ts";
import { OpencodeChat } from "./chat/opencode.ts";
import { Emitter, NOOP } from "./emitter.ts";
import { freePort, opencodeClient } from "./opencode-api.ts";
import { clampSize, loadPty } from "./pty.ts";
import { TermBuffer } from "./term.ts";
import { loginShellVars } from "./env.ts";
import { importableNames } from "./keys.ts";
import { collect, defaultRemoteCwd, shellKeyNames } from "./setup.ts";
import { setupError } from "./cloud/setup.ts";
import {
  AGENT_FACTS, ControlError, DEFAULT_TERM_SIZE, EXITED_KEEP_MS, MAX_SESSIONS,
  type ChatConn, type ChatSink, type ControlContext, type Disposable, type HookCall, type HookReply, type Launch, type PipeProc,
  type Places, type PtyBackend, type RemotePlace, type SessionManager, type SetupBundle, type Term, type TermDrive, type TermSink,
} from "./types.ts";

export interface SessionManagerOptions {
  /** The PTY backend; default loadPty(). null: no terminal mode here. */
  pty?: PtyBackend | null;
  /** A local child on pipes (chat mode); default child_process. */
  pipe?: (file: string, args: string[], cwd: string, env: Record<string, string>, o?: { watchdog?: boolean }) => Promise<PipeProc>;
  /** `<bin> --version`; default runs it. */
  version?: (bin: string) => Promise<string | undefined>;
  enterDelayMs?: number;
  /** Stop: SIGHUP, then SIGKILL this much later. */
  stopGraceMs?: number;
  exitedKeepMs?: number;
  /** How long a Claude hook approval may wait for the page. */
  hookWaitMs?: number;
  /** A free loopback port for opencode's server; default asks the OS. */
  port?: () => Promise<number>;
  /** "Bring my setup": these names from the login shell (default env.ts loginShellVars). Never stored. */
  shellVars?: (names: string[]) => Promise<Record<string, string> | null>;
}

const HIRES_PER_MINUTE = 10;
const AVAILABILITY_TTL_MS = 5 * 60_000;
const ESC_GAP_MS = 1_500;
const ESC_HOLD_MS = 50;
const HISTORY_MAX = 500;
const HOOK_WAIT_MS = 29 * 60_000;
const SHUTDOWN_KILL_MS = 3_000;
/** The screen is checked for a trust question this long after start, while the worker is unlinked. */
const TRUST_WATCH_MS = 3 * 60_000;
const TRUST_RE = /(trust (this|the contents of this) (folder|directory|workspace)|one you trust|Do you trust)/i;
const TRUST_DETAIL = "Answer the trust question in the terminal";
/** Codex's device sign-in: a link and a one-time code on screen (codex login --device-auth). The code lasts 15 minutes. */
const DEVICE_RE = /one-time code/i;
const DEVICE_WATCH_MS = 16 * 60_000;
const DEVICE_DETAIL = "Sign in to Codex: open the link and enter the code";
/** Codex signs in with its device code first when it isn't signed in there, then runs. */
const CODEX_DEVICE_LOGIN = `if ! "$0" login status >/dev/null 2>&1; then "$0" login --device-auth || exit $?; fi; exec "$0" "$@"`;

interface HookMeta {
  toolName: string;
  suggestions: unknown;
  resolve(o: HookOutcome): void;
}

interface Live {
  s: ControlSession;
  req: HireRequest;
  /** Absolute folder as the agent sees it (local: realpath). */
  cwd: string;
  hostId?: string;
  emitted: boolean;
  linked: boolean;
  drive: TermDrive;
  buf?: TermBuffer;
  term?: Term;
  conn?: ChatConn;
  proc?: PipeProc;
  history: Map<string, ChatItem>;
  chatSinks: Set<ChatSink>;
  hookToken?: string;
  /** The agent's own session id when known (pinned, or reported). */
  agentSession?: string;
  expectations: Disposable[];
  place?: RemotePlace;
  keep?: Disposable;
  hookApprovals: ApprovalQueue<HookMeta>;
  /** opencode's TUI, driven over its server. */
  oc?: OpencodeChat;
  lastEsc: number;
  holdUntil: number;
  held: (string | Uint8Array)[];
  heldTimer?: ReturnType<typeof setTimeout>;
  stopping: boolean;
  abort: AbortController;
  timers: Set<ReturnType<typeof setTimeout>>;
  subs: Disposable[];
  finished: boolean;
  startedMs: number;
  /** The agent got as far as running (a sandbox created for it is then left to its own timer). */
  ran?: boolean;
}

export function createSessionManager(ctx: ControlContext, places: Places | undefined, o: SessionManagerOptions = {}): SessionManager {
  const sessions = new Map<string, Live>();
  const changed = new Emitter<ControlSession>();
  const gone = new Emitter<string>();
  const hires: number[] = [];
  const enterDelay = o.enterDelayMs;
  const stopGrace = o.stopGraceMs ?? 4_000;
  const keepMs = o.exitedKeepMs ?? EXITED_KEEP_MS;
  const hookWait = o.hookWaitMs ?? HOOK_WAIT_MS;
  const pipe = o.pipe ?? localPipe;
  const port = o.port ?? freePort;
  let ptyP: Promise<PtyBackend | null> | undefined = o.pty !== undefined ? Promise.resolve(o.pty) : undefined;
  const pty = () => (ptyP ??= loadPty());

  let avail: { at: number; agents: AgentAvailability[]; bins: FoundBins } | undefined;
  let probing: Promise<{ agents: AgentAvailability[]; bins: FoundBins }> | undefined;
  function probe(): Promise<{ agents: AgentAvailability[]; bins: FoundBins }> {
    return (probing ??= (async () => {
      try {
        const r = await probeAgents({ env: ctx.agentEnv(), home: ctx.userHome, pty: await pty(), version: o.version });
        avail = { at: ctx.now(), ...r };
        return r;
      } finally {
        probing = undefined;
      }
    })());
  }
  let quickList: Promise<AgentAvailability[]> | undefined;
  async function availability(opts: { fresh?: boolean; quick?: boolean } = {}): Promise<AgentAvailability[]> {
    if (opts.quick && !avail && !opts.fresh) {
      // Not probed yet (the office just started): what's on PATH now, the versions when the probe is done.
      probe().catch(() => {});
      return (quickList ??= (async () => (await probeAgents({ env: ctx.agentEnv(), home: ctx.userHome, pty: await pty(), version: async () => undefined })).agents)());
    }
    if (opts.fresh || !avail) return (await probe()).agents;
    if (ctx.now() - avail.at > AVAILABILITY_TTL_MS) void probe().catch(() => {});
    return avail.agents;
  }

  const iso = () => new Date(ctx.now()).toISOString();
  const name = (a: AgentKind) => BRAND[a].name;

  function publish(l: Live): void {
    changed.emit({
      ...l.s,
      place: { ...l.s.place },
      ...(l.s.pendingApproval ? { pendingApproval: { ...l.s.pendingApproval } } : {}),
      ...(l.s.setup ? { setup: { ...l.s.setup, ...(l.s.setup.skipped ? { skipped: [...l.s.setup.skipped] } : {}) } } : {}),
      ...(l.s.needs ? { needs: { ...l.s.needs } } : {}),
    });
  }

  function setStatus(l: Live, status: SessionStatus, detail?: string): void {
    if (l.finished) return;
    l.s.status = status;
    if (status === "running") l.ran = true;
    if (detail === undefined) delete l.s.detail;
    else l.s.detail = detail;
    publish(l);
  }

  function later(l: Live, ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      l.timers.delete(t);
      fn();
    }, ms);
    t.unref?.();
    l.timers.add(t);
  }

  /* ---------------------------------------------------------- the office */

  function pose(l: Live, kind: EventKind, extra: Partial<RawEvent> = {}): void {
    if (!l.emitted) return;
    ctx.office.emit({
      ts: iso(),
      agent: l.s.agent,
      workerId: l.s.workerId,
      project: l.s.title,
      ...(l.s.host ? { host: l.s.host } : {}),
      kind,
      ...extra,
    });
  }

  function walkIn(l: Live): void {
    if (l.emitted) return;
    l.emitted = true;
    ctx.office.emit({
      ts: iso(),
      agent: l.s.agent,
      workerId: l.s.workerId,
      project: l.s.title,
      cwd: l.cwd,
      ...(l.s.host ? { host: l.s.host } : {}),
      kind: "session_start",
    });
    ctx.office.hold(l.s.workerId);
  }

  /** Follow the agent's transcript: exact when its session id is known, else agent + folder + time. */
  function expect(l: Live, sessionId?: string, exactOnly?: boolean): void {
    const x = ctx.office.expect({
      placeholder: l.s.workerId,
      agent: l.s.agent,
      ...(l.hostId ? { hostId: l.hostId } : {}),
      cwd: l.cwd,
      ...(sessionId ? { sessionId } : {}),
      since: sessionId && l.linked ? ctx.now() : l.startedMs,
      ...(exactOnly !== undefined ? { exactOnly } : {}),
      onLinked: (w) => {
        if (l.s.workerId === w) return;
        l.s.workerId = w;
        l.linked = true;
        if (l.s.detail === TRUST_DETAIL || l.s.detail === DEVICE_DETAIL) delete l.s.detail;
        delete l.s.needs;
        publish(l);
      },
    });
    l.expectations.push(x);
  }

  /* --------------------------------------------------------------- hire */

  async function hire(req: HireRequest): Promise<ControlSession> {
    const r = validateShape(req);
    const t = ctx.now();
    while (hires.length && t - hires[0]! > 60_000) hires.shift();
    if (hires.length >= HIRES_PER_MINUTE) throw new ControlError(429, "That's a lot of hiring: wait a minute.");
    const live = [...sessions.values()].filter((l) => !l.finished).length;
    if (live >= MAX_SESSIONS) throw new ControlError(409, `${MAX_SESSIONS} agents are already running. Stop one first.`);

    const local = r.place.kind === "local";
    let cwd = "";
    if (local) {
      cwd = localFolder(r.place.target);
      const { agents } = avail && !probing ? avail : await probe();
      const a = agents.find((x) => x.agent === r.agent)!;
      if (!a.installed) throw new ControlError(400, `${name(r.agent)} isn't installed on this machine.`);
      if (!a.modes.includes(r.mode)) {
        if (r.mode === "terminal") throw new ControlError(503, a.note ?? "Terminal mode isn't available on this machine.");
        throw new ControlError(400, `${name(r.agent)} has no chat mode. Use terminal mode.`);
      }
      if (r.mode === "terminal" && !(await pty())) throw new ControlError(503, "Terminal mode needs the PTY library (reinstall agent-visualizer with optional dependencies) or python3.");
    } else {
      if (!places) throw new ControlError(503, "Sandboxes and ssh boxes aren't available in this office.");
      if (r.agent === "opencode") throw new ControlError(400, "opencode runs on this machine only for now.");
      if (r.mode === "chat" && !AGENT_FACTS[r.agent].chat) throw new ControlError(400, `${name(r.agent)} has no chat mode. Use terminal mode.`);
      if (r.setup) {
        r.setup = normalizeSetup(r.agent, r.mode, r.setup, r.keys);
        if (r.setup.project) {
          r.setup.project = { ...r.setup.project, folder: localFolder(r.setup.project.folder) };
          if (!r.place.cwd) r.place.cwd = defaultRemoteCwd(r.setup.project.folder);
        }
      }
      if (r.keys.length) ctx.keys.reveal(r.keys); // throws 400 naming a missing key; the values are fetched again at launch
    }
    if (!permissionsOf(r.agent).includes(r.permission)) throw new ControlError(400, `${name(r.agent)} can't start in that permission mode.`);
    hires.push(t);

    const id = randomBytes(4).toString("hex");
    const title = local ? basename(cwd) || "~" : r.place.cwd ? basename(r.place.cwd) : r.place.target === "new" ? "sandbox" : r.place.target;
    const status: SessionStatus = local ? "starting" : r.place.target === "new" ? "creating" : "installing";
    const l: Live = {
      s: {
        id,
        agent: r.agent,
        place: { ...r.place },
        mode: r.mode,
        workerId: `ctl:${id}`,
        status,
        startedAt: new Date(t).toISOString(),
        title: safe(title, 40),
        permission: r.permission,
      },
      req: r,
      cwd,
      emitted: false,
      linked: false,
      drive: driveOf(r.agent),
      history: new Map(),
      chatSinks: new Set(),
      expectations: [],
      hookApprovals: new ApprovalQueue<HookMeta>(),
      lastEsc: 0,
      holdUntil: 0,
      held: [],
      stopping: false,
      abort: new AbortController(),
      timers: new Set(),
      subs: [],
      finished: false,
      startedMs: t,
    };
    if (r.mode === "terminal") l.buf = new TermBuffer({ ...DEFAULT_TERM_SIZE, reply: (d) => l.term?.write(d), now: ctx.now });
    l.subs.push(l.hookApprovals.changed.on((a) => setApproval(l, a)));
    sessions.set(id, l);
    ctx.log(`hired ${name(r.agent)} in ${l.s.title} (${r.mode}${local ? "" : `, ${r.place.kind}`})`);
    if (local) walkIn(l);
    publish(l);
    void (local ? startLocal(l) : startRemote(l)).catch((err) => fail(l, err));
    return { ...l.s, place: { ...l.s.place } };
  }

  function validateShape(req: HireRequest): HireRequest & { permission: PermissionMode; keys: string[]; setup?: SetupChoice } {
    if (!req || typeof req !== "object") throw new ControlError(400, "Bad hire request.");
    if (!Object.hasOwn(AGENT_FACTS, req.agent)) throw new ControlError(400, "Unknown agent.");
    if (req.mode !== "terminal" && req.mode !== "chat") throw new ControlError(400, "Unknown mode.");
    const p = req.place;
    if (!p || typeof p.target !== "string" || !p.target || !["local", "ssh", "daytona", "vercel", "railway"].includes(p.kind)) throw new ControlError(400, "Unknown place.");
    if (p.cwd !== undefined && (typeof p.cwd !== "string" || p.cwd.length > 1024 || /[\0\n]/.test(p.cwd))) throw new ControlError(400, "Bad working folder.");
    const permission = req.permission ?? "default";
    if (!["default", "acceptEdits", "plan", "bypass"].includes(permission)) throw new ControlError(400, "Unknown permission mode.");
    if (req.prompt !== undefined && typeof req.prompt !== "string") throw new ControlError(400, "Bad prompt.");
    const keys = Array.isArray(req.keys) && p.kind !== "local" ? req.keys.filter((k) => typeof k === "string") : [];
    const setup = p.kind !== "local" && req.setup && typeof req.setup === "object" ? req.setup : undefined;
    return { ...req, place: { kind: p.kind, target: p.target, ...(p.cwd ? { cwd: p.cwd } : {}) }, permission, keys, setup, ...(req.prompt?.trim() ? { prompt: req.prompt } : { prompt: undefined }) };
  }

  /**
   * The keys a sign-in choice implies, and none that would override it:
   * Claude's subscription token loses to an API key, Codex's ChatGPT sign-in
   * to OPENAI_API_KEY. `keys` (stored names) is edited in place.
   */
  function normalizeSetup(agent: AgentKind, mode: HireRequest["mode"], setup: SetupChoice, keys: string[]): SetupChoice {
    const allowed = new Set(shellKeyNames(importableNames()));
    const stored = new Set(ctx.keys.list().map((k) => k.name));
    let shell = (Array.isArray(setup.shellKeys) ? setup.shellKeys : []).filter((n) => typeof n === "string" && allowed.has(n) && !keys.includes(n));
    const login = setup.login ?? "none";
    const drop = (names: string[]) => {
      for (const n of names) {
        const i = keys.indexOf(n);
        if (i >= 0) keys.splice(i, 1);
      }
      shell = shell.filter((n) => !names.includes(n));
    };
    const need = (name: string, what: string) => {
      if (keys.includes(name) || shell.includes(name)) return;
      if (stored.has(name)) keys.push(name);
      else throw new ControlError(400, `${what} needs ${name}: ${name === "CLAUDE_CODE_OAUTH_TOKEN" ? "connect Claude in Settings, Logins" : "add it under Keys or export it in your shell"}.`);
    };
    if (agent === "claude" && login === "subscription") {
      need("CLAUDE_CODE_OAUTH_TOKEN", "Signing in with your Claude subscription");
      drop(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);
    } else if (agent === "claude" && login === "key") need("ANTHROPIC_API_KEY", "Signing in with an API key");
    else if (agent === "codex" && login === "key") need("OPENAI_API_KEY", "Signing in with an API key");
    else if (agent === "codex" && (login === "device" || login === "copy")) {
      if (login === "device" && mode !== "terminal") throw new ControlError(400, "Codex's device sign-in shows its code in the terminal: hire it in terminal mode.");
      drop(["OPENAI_API_KEY"]);
    }
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 200) : undefined);
    const p = setup.project;
    return {
      login,
      shellKeys: shell,
      ...(strings(setup.mcp) ? { mcp: strings(setup.mcp) } : {}),
      ...(strings(setup.instructions) ? { instructions: strings(setup.instructions) } : {}),
      ...(p && typeof p.folder === "string" && p.folder ? { project: { folder: p.folder, git: p.git !== false, env: p.env === true } } : {}),
    };
  }

  /** An existing folder under the user's home, or one the office has seen agents work in. */
  function localFolder(target: string): string {
    const raw = target === "~" ? ctx.userHome : target.startsWith("~/") ? ctx.userHome + target.slice(1) : target;
    if (!isAbsolute(raw)) throw new ControlError(400, "Pick a folder.");
    let real: string;
    try {
      real = realpathSync(raw);
      if (!statSync(real).isDirectory()) throw new Error("not a folder");
    } catch {
      throw new ControlError(400, "That folder doesn't exist.");
    }
    const realOf = (p: string) => {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    };
    const home = realOf(ctx.userHome);
    if (real === home || real.startsWith(home + sep)) return real;
    if (ctx.office.recentFolders().some((f) => realOf(f) === real)) return real;
    throw new ControlError(403, "Agents can only be hired in folders under your home.");
  }

  /* -------------------------------------------------------------- local */

  function localEnv(l: Live, launch: Launch): Record<string, string> {
    const env = ctx.agentEnv();
    env.TERM = "xterm-256color";
    env.COLORTERM = "truecolor";
    env.LANG ||= "en_US.UTF-8";
    env.PWD = l.cwd;
    return { ...env, ...launch.env };
  }

  function argvOf(launch: Launch): string[] {
    return launch.argv.map((a) => (typeof a === "string" ? a : launch.env[a.env] ?? ""));
  }

  async function startLocal(l: Live): Promise<void> {
    const { agent, mode, permission } = l.s;
    const bins = avail?.bins ?? (await probe()).bins;
    const bin = bins[agent] ?? findBin(agent, ctx.agentEnv());
    if (!bin) throw new ControlError(400, `${name(agent)} isn't installed on this machine.`);
    const pin = pinsSessionId(agent);
    if (mode === "terminal") {
      const backend = await pty();
      if (!backend) throw new ControlError(503, "Terminal mode needs the PTY library.");
      const sessionId = pin ? randomUUID() : undefined;
      let oc: { port: number; password: string } | undefined;
      if (agent === "opencode") oc = { port: await port(), password: randomBytes(24).toString("hex") };
      if (agent === "claude") l.hookToken = randomBytes(24).toString("hex");
      const launch = terminalLaunch({
        agent,
        bin,
        cwd: l.cwd,
        permission,
        prompt: l.req.prompt,
        sessionId,
        ...(l.hookToken ? { hook: { url: ctx.officeUrl(), token: l.hookToken, sessionId: l.s.id } } : {}),
        ...(oc ? { opencode: oc } : {}),
      });
      if (l.stopping) return finish(l, null);
      const [file, ...args] = argvOf(launch);
      const term = backend.spawn({ file: file!, args, cwd: l.cwd, env: localEnv(l, launch), cols: l.buf!.cols, rows: l.buf!.rows });
      l.agentSession = sessionId;
      expect(l, sessionId, pin === "hint" ? false : undefined);
      wireTerm(l, term);
      if (oc) driveOpencodeTui(l, oc);
      return;
    }
    // chat
    if (agent === "claude") {
      const sessionId = randomUUID();
      const launch = chatLaunch({ agent, bin, cwd: l.cwd, permission, sessionId });
      const [file, ...args] = argvOf(launch);
      const proc = await pipe(file!, args, l.cwd, localEnv(l, launch));
      l.agentSession = sessionId;
      expect(l, sessionId);
      await runChat(l, proc, new ClaudeChat({ proc, sessionId, where: l.s.title, home: ctx.userHome, now: ctx.now }));
    } else if (agent === "codex") {
      const launch = chatLaunch({ agent, bin, cwd: l.cwd, permission });
      const [file, ...args] = argvOf(launch);
      const proc = await pipe(file!, args, l.cwd, localEnv(l, launch));
      await runChat(l, proc, new CodexChat({ proc, cwd: l.cwd, where: l.s.title, permission, version: ctx.version, home: ctx.userHome, now: ctx.now }));
    } else if (agent === "opencode") {
      const oc = { port: await port(), password: randomBytes(24).toString("hex") };
      const launch = chatLaunch({ agent, bin, cwd: l.cwd, permission, opencode: oc });
      const [file, ...args] = argvOf(launch);
      const proc = await pipe(file!, args, l.cwd, localEnv(l, launch), { watchdog: true });
      const client = opencodeClient({ port: oc.port, password: oc.password, directory: l.cwd });
      await runChat(l, proc, new OpencodeChat({ client, mode: "chat", proc, where: l.s.title, permission, home: ctx.userHome, now: ctx.now }));
    } else if (AGENT_FACTS[agent].chat === "acp") {
      const launch = chatLaunch({ agent, bin, cwd: l.cwd, permission });
      const [file, ...args] = argvOf(launch);
      const proc = await pipe(file!, args, l.cwd, localEnv(l, launch));
      await runChat(l, proc, new AcpChat({ proc, cwd: l.cwd, where: l.s.title, name: name(agent), permission, version: ctx.version, home: ctx.userHome, now: ctx.now, ...ACP_PROFILES[agent] }));
    } else throw new ControlError(400, `${name(agent)} has no chat mode.`);
  }

  /* ------------------------------------------------------------- remote */

  async function startRemote(l: Live): Promise<void> {
    const { agent, mode, permission } = l.s;
    const progress = (status: "creating" | "installing" | "starting", detail: string) => setStatus(l, status, detail);
    const setup = l.req.setup;
    // Read on this machine while the sandbox comes up; nothing in it is logged.
    let bundleP: Promise<SetupBundle> | undefined;
    if (setup) {
      bundleP = collect(agent, setup, { home: ctx.userHome, env: ctx.agentEnv(), keys: ctx.keys.list(), shellKeys: [] });
      bundleP.catch(() => {});
    }
    const rp = await places!.open(l.s.place, { agent, ...(l.req.sandbox ? { sandbox: l.req.sandbox } : {}), progress, signal: l.abort.signal, ...(setup?.project ? { createCwd: true } : {}) });
    l.place = rp;
    if (l.stopping) return finish(l, null);
    l.s.host = rp.host;
    l.hostId = rp.host.id;
    l.cwd = rp.cwd;
    l.s.title = safe(l.s.place.cwd ? basename(l.s.place.cwd) : rp.host.name || l.s.title, 40);
    walkIn(l);
    publish(l);
    const pin = pinsSessionId(agent);
    if (l.s.status !== "installing") setStatus(l, "installing", `Checking ${name(agent)}…`);
    const got = await rp.ensureAgent(agent, progress);
    if (l.stopping) return finish(l, null);
    const keys = await launchKeys(l);
    if (bundleP) await bring(l, rp, await bundleP, keys);
    if (l.stopping) return finish(l, null);
    await rp.firstRun(agent, rp.cwd);
    if (l.stopping) return finish(l, null);
    setStatus(l, "starting", `Starting ${name(agent)}…`);
    if (mode === "terminal") {
      const sessionId = pin ? randomUUID() : undefined;
      let launch = terminalLaunch({ agent, bin: got.bin, cwd: rp.cwd, permission, prompt: l.req.prompt, sessionId, remote: true, keys, path: got.path });
      if (agent === "codex" && setup?.login === "device") launch = { ...launch, argv: ["sh", "-c", CODEX_DEVICE_LOGIN, ...launch.argv] };
      const term = await rp.attach(launch, { cols: l.buf!.cols, rows: l.buf!.rows });
      if (l.stopping) {
        term.kill();
        return finish(l, null);
      }
      l.agentSession = sessionId;
      expect(l, sessionId, pin === "hint" ? false : undefined);
      wireTerm(l, term);
    } else {
      if (!rp.pipe) throw new ControlError(400, "Chat mode isn't available there. Use terminal mode.");
      const sessionId = agent === "claude" ? randomUUID() : undefined;
      const launch = chatLaunch({ agent, bin: got.bin, cwd: rp.cwd, permission, sessionId, remote: true, keys, path: got.path });
      const proc = await rp.pipe(launch);
      if (l.stopping) {
        proc.kill("SIGTERM");
        return finish(l, null);
      }
      const where = `${l.s.title} on ${rp.host.name}`;
      if (sessionId) {
        l.agentSession = sessionId;
        expect(l, sessionId);
      }
      const conn = agent === "claude"
        ? new ClaudeChat({ proc, sessionId: sessionId!, where, home: "", now: ctx.now })
        : AGENT_FACTS[agent].chat === "acp"
          ? new AcpChat({ proc, cwd: rp.cwd, where, name: name(agent), permission, version: ctx.version, home: "", now: ctx.now, ...ACP_PROFILES[agent] })
          : new CodexChat({ proc, cwd: rp.cwd, where, permission, version: ctx.version, home: "", now: ctx.now });
      await runChat(l, proc, conn);
    }
    if (!l.finished) l.keep = rp.keepAlive();
  }

  /** The stored keys this hire hands over, plus the login shell's (read now, never stored). Never logged. */
  async function launchKeys(l: Live): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const names = l.req.setup?.shellKeys ?? [];
    if (names.length) {
      const got = await (o.shellVars ?? ((n: string[]) => loginShellVars(n)))(names);
      if (!got) throw new ControlError(502, "Couldn't read your login shell's environment for the keys to pass.");
      for (const n of names) {
        const v = got[n]?.trim();
        if (v && !/[\r\n\0]/.test(v)) out[n] = v;
      }
    }
    return { ...out, ...(l.req.keys?.length ? ctx.keys.reveal(l.req.keys) : {}) };
  }

  /** "Bring my setup" into the place: a step of its own in the panel; what didn't make it is said there, never fatal. */
  async function bring(l: Live, rp: RemotePlace, bundle: SetupBundle, keys: Record<string, string>): Promise<void> {
    l.s.setup = { state: "running", summary: bundle.summary };
    setStatus(l, "installing", "Copying your setup…");
    if (!rp.bring) {
      l.s.setup = { state: "failed", summary: bundle.summary, skipped: ["this place can't take files"] };
      publish(l);
      return;
    }
    // Only the value a merge needs there (Claude's key, for its approval); the rest stays in the launch.
    const secrets: Record<string, string> = bundle.approveClaudeKey && keys.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: keys.ANTHROPIC_API_KEY } : {};
    try {
      const r = await rp.bring(bundle, secrets, (d) => setStatus(l, "installing", d));
      // Left out on purpose here (hooks that run local files, big binaries) is still "done"; "partial" is what didn't land there.
      const skipped = [...r.skipped, ...bundle.skipped];
      l.s.setup = { state: r.skipped.length ? "partial" : "done", summary: bundle.summary, ...(skipped.length ? { skipped: skipped.slice(0, 30) } : {}) };
      ctx.log(`set up ${name(l.s.agent)} in ${l.s.title}: ${bundle.summary}${skipped.length ? ` (${skipped.length} skipped)` : ""}`);
    } catch (err) {
      const why = setupError(err);
      l.s.setup = { state: "failed", summary: bundle.summary, skipped: [why, ...bundle.skipped].slice(0, 30) };
      ctx.log(`copying the setup for ${name(l.s.agent)} in ${l.s.title} failed: ${why}`, "warn");
    }
    publish(l);
  }

  /* ----------------------------------------------------------- terminal */

  function wireTerm(l: Live, term: Term): void {
    l.term = term;
    const buf = l.buf!;
    term.resize(buf.cols, buf.rows);
    // A folder-trust question on screen while the transcript hasn't shown up yet: checked once the
    // screen settles (a TUI draws the dialog in several chunks, then goes quiet).
    let trustTimer: ReturnType<typeof setTimeout> | undefined;
    const device = l.s.agent === "codex" && l.req.setup?.login === "device";
    const checkTrust = () => {
      trustTimer = undefined;
      void buf.screen().then((text) => {
        if (l.finished || l.linked) return;
        if (device) {
          const code = deviceCode(text);
          if (code && (l.s.needs?.code !== code.code || l.s.needs.url !== code.url)) {
            l.s.needs = { kind: "device-login", ...code };
            setStatus(l, l.s.status, DEVICE_DETAIL);
            pose(l, "waiting");
            return;
          }
          if (!code && l.s.needs) {
            delete l.s.needs;
            setStatus(l, l.s.status, l.s.detail === DEVICE_DETAIL ? undefined : l.s.detail);
          }
          if (code) return;
        }
        const asking = TRUST_RE.test(text);
        if (asking && l.s.detail !== TRUST_DETAIL) setStatus(l, l.s.status, TRUST_DETAIL);
        else if (!asking && l.s.detail === TRUST_DETAIL) setStatus(l, l.s.status);
      });
    };
    const watchMs = device ? DEVICE_WATCH_MS : TRUST_WATCH_MS;
    l.subs.push(
      { dispose: () => trustTimer && clearTimeout(trustTimer) },
      term.onData((chunk) => {
        buf.write(chunk);
        if (l.s.status === "starting") {
          setStatus(l, "running");
          if (l.req.prompt) pose(l, "prompt");
          else pose(l, "waiting");
          ctx.log(`${name(l.s.agent)} is running in ${l.s.title}`);
        }
        if (!l.linked && ctx.now() - l.startedMs < watchMs) {
          if (trustTimer) clearTimeout(trustTimer);
          trustTimer = setTimeout(checkTrust, 300);
          trustTimer.unref?.();
        }
      }),
      term.onExit((e) => finish(l, e.code)),
    );
  }

  /** Bytes into the PTY, held back briefly after an Esc so it isn't read as Alt+key. */
  function writeTerm(l: Live, data: string | Uint8Array): void {
    if (!l.term || l.finished) return;
    const t = ctx.now();
    if (t < l.holdUntil || l.held.length) {
      l.held.push(data);
      if (!l.heldTimer) {
        l.heldTimer = setTimeout(() => {
          l.heldTimer = undefined;
          const q = l.held.splice(0);
          for (const d of q) l.term?.write(d);
        }, Math.max(1, l.holdUntil - t));
      }
      return;
    }
    l.term.write(data);
  }

  function pasteText(text: string): string {
    return text
      .replace(/\x1b\[20[01]~/g, "")
      .replace(/\r\n?/g, "\n")
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  }

  async function termPrompt(l: Live, text: string): Promise<void> {
    if (l.drive.submit === "opencode" && l.oc?.session) {
      try {
        await l.oc.client.tuiAppend(pasteText(text));
        await l.oc.client.tuiSubmit();
        return;
      } catch {
        // Its server didn't take it: type it instead.
      }
    }
    const clean = pasteText(text);
    const buf = l.buf!;
    if (buf.bracketedPaste) writeTerm(l, `\x1b[200~${clean}\x1b[201~`);
    else writeTerm(l, clean.replace(/\n/g, " "));
    later(l, enterDelay ?? l.drive.enterDelayMs, () => writeTerm(l, "\r"));
  }

  function sendEsc(l: Live): void {
    const t = ctx.now();
    // Never two within 1.5 s: a double Esc means "rewind" in Command Code.
    if (t - l.lastEsc < ESC_GAP_MS) return;
    l.lastEsc = t;
    writeTerm(l, "\x1b");
    l.holdUntil = ctx.now() + ESC_HOLD_MS;
  }

  /** opencode's TUI: its own server answers prompts, interrupts and approvals. */
  function driveOpencodeTui(l: Live, oc: { port: number; password: string }): void {
    const client = opencodeClient({ port: oc.port, password: oc.password, directory: l.cwd });
    const conn = new OpencodeChat({ client, mode: "tui", where: l.s.title, permission: l.s.permission, home: ctx.userHome, now: ctx.now });
    l.oc = conn;
    l.subs.push(
      conn.onApproval((a) => setApproval(l, a)),
      conn.onSessionId((sid) => {
        if (sid === l.agentSession) return;
        const first = !l.agentSession;
        l.agentSession = sid;
        // Its first session is the one the guess is waiting for; a later one (/new) re-links the desk.
        expect(l, sid, first ? undefined : true);
      }),
    );
    conn.ready.catch(() => ctx.log(`opencode's server didn't answer in ${l.s.title}; the terminal still works`, "warn"));
  }

  /* --------------------------------------------------------------- chat */

  async function runChat(l: Live, proc: PipeProc, conn: ClaudeChat | CodexChat | OpencodeChat | AcpChat): Promise<void> {
    l.proc = proc;
    l.conn = conn;
    l.subs.push(
      conn.onItem((it) => chatItem(l, it)),
      conn.onApproval((a) => setApproval(l, a)),
      conn.onTurn((state) => {
        if (l.linked) return;
        pose(l, state === "busy" ? "thinking" : "waiting");
      }),
      conn.onSessionId((sid) => {
        if (sid === l.agentSession) return;
        l.agentSession = sid;
        expect(l, sid, true);
      }),
      conn.onExit((e) => finish(l, e.code)),
    );
    if (l.stopping) {
      void conn.stop();
      return;
    }
    await conn.ready;
    if (l.finished) return;
    setStatus(l, "running");
    ctx.log(`${name(l.s.agent)} is running in ${l.s.title} (chat)`);
    if (l.req.prompt) await conn.send(l.req.prompt);
    else pose(l, "waiting");
  }

  function chatItem(l: Live, it: ChatItem): void {
    const prev = l.history.get(it.id);
    l.history.delete(it.id);
    l.history.set(it.id, it);
    if (l.history.size > HISTORY_MAX) l.history.delete(l.history.keys().next().value!);
    for (const sink of l.chatSinks) {
      try {
        sink.item(it);
      } catch {
        l.chatSinks.delete(sink);
      }
    }
    if (l.linked) return;
    // Until the transcript takes over, the desk follows the chat.
    if (it.kind === "tool" && it.status === "running" && !prev) pose(l, "tool_start", { tool: it.tool, category: it.category, summary: safe(it.summary ?? "") });
    else if (it.kind === "tool" && it.status !== "running" && prev?.status === "running") pose(l, "tool_end", { tool: it.tool, category: it.category, isError: it.status === "error" });
    else if (it.kind === "user" && !prev) pose(l, "prompt");
  }

  /* ---------------------------------------------------------- approvals */

  function setApproval(l: Live, a: Approval | null): void {
    if (l.finished) return;
    const had = l.s.pendingApproval;
    if (a) l.s.pendingApproval = a;
    else delete l.s.pendingApproval;
    publish(l);
    if (a) pose(l, "waiting", { tool: a.tool, ...(a.category ? { category: a.category } : {}), summary: safe(approvalPose(a)) });
    else if (had) pose(l, "thinking");
  }

  async function claudeHook(l: Live, call: HookCall): Promise<HookReply> {
    if (call.event === "session-start") {
      const b = (call.body ?? {}) as Record<string, unknown>;
      const sid = typeof b.session_id === "string" ? b.session_id : undefined;
      if (sid && sid !== l.agentSession) {
        // /clear or a resume: the desk follows the new transcript.
        l.agentSession = sid;
        expect(l, sid, true);
      }
      return { status: 200, body: {} };
    }
    if (call.event !== "permission") return { status: 404, body: { error: "Unknown hook." } };
    if (ctx.viewers() === 0) return { status: 200, body: {} };
    const b = (call.body ?? {}) as Record<string, any>;
    const toolName = typeof b.tool_name === "string" && b.tool_name ? b.tool_name : "tool";
    const { category, summary } = claudeToolLabel(toolName, b.tool_input);
    const detail = claudeToolDetail(toolName, b.tool_input, { reason: b.decision_reason, description: b.description, blockedPath: b.blocked_path }, ctx.userHome);
    const noAlways = !sessionPermissions(b.permission_suggestions, b.suppress_always_allow_rule);
    const approval: Approval = { id: randomBytes(6).toString("hex"), tool: toolName, category, summary, ...(detail ? { detail } : {}), ...(noAlways ? { noAlways } : {}), at: iso() };
    const outcome = await new Promise<HookOutcome>((resolve) => {
      let done = false;
      const settle = (x: HookOutcome) => {
        if (done) return;
        done = true;
        clearTimeout(cap);
        clearInterval(watch);
        call.signal?.removeEventListener("abort", onAbort);
        resolve(x);
      };
      const onAbort = () => {
        l.hookApprovals.drop(approval.id);
        settle({ withdrawn: true });
      };
      const cap = setTimeout(onAbort, hookWait);
      const watch = setInterval(() => ctx.viewers() === 0 && onAbort(), 2_000);
      cap.unref?.();
      watch.unref?.();
      call.signal?.addEventListener("abort", onAbort);
      if (call.signal?.aborted) return onAbort();
      l.hookApprovals.add(approval, { toolName, suggestions: b.permission_suggestions, resolve: settle });
    });
    return { status: 200, body: hookReply(outcome, { suggestions: b.permission_suggestions, suppress: b.suppress_always_allow_rule }) };
  }

  /* ---------------------------------------------------------- endings */

  function cleanup(l: Live): void {
    for (const x of l.expectations) x.dispose();
    l.expectations = [];
    for (const d of l.subs.splice(0)) d.dispose();
    for (const t of l.timers) clearTimeout(t);
    l.timers.clear();
    if (l.heldTimer) clearTimeout(l.heldTimer);
    for (const p of l.hookApprovals.drain()) p.meta.resolve({ withdrawn: true });
    l.oc?.close();
    l.keep?.dispose();
    try {
      l.place?.close();
    } catch {
      // Already closed.
    }
    if (l.emitted) ctx.office.end(l.s.workerId);
    const t = setTimeout(() => {
      sessions.delete(l.s.id);
      l.buf?.dispose();
      gone.emit(l.s.id);
    }, keepMs);
    t.unref?.();
  }

  function finish(l: Live, code: number | null): void {
    if (l.finished) return;
    l.s.status = "exited";
    if (code !== null) l.s.exitCode = code;
    delete l.s.pendingApproval;
    delete l.s.detail;
    delete l.s.needs;
    l.finished = true;
    l.buf?.exit(code);
    if (l.conn) chatItem(l, { id: "exit", kind: "system", text: `${name(l.s.agent)} exited${code !== null ? ` (${code})` : ""}.`, at: iso() });
    ctx.log(`${name(l.s.agent)} in ${l.s.title} exited${code !== null ? ` (${code})` : ""}`);
    cleanup(l);
    publish(l);
    discardUnused(l);
  }

  /** A sandbox created for this session whose agent never ran (Stopped, or it failed on the way): delete it. */
  function discardUnused(l: Live): void {
    const rp = l.place;
    if (l.ran || !rp?.discard) return;
    void rp.discard().then((gone) => {
      l.s.detail = gone ? "The sandbox created for it was deleted" : "The sandbox created for it is still running: delete it in Settings";
      publish(l);
    });
  }

  function fail(l: Live, err: unknown): void {
    if (l.finished) return;
    // Stopped while it was still being set up: that's an exit, not a failure.
    if (l.stopping) return finish(l, null);
    const msg = err instanceof ControlError ? err.message : scrubMessage((err as Error)?.message || "It didn't start.");
    try {
      l.term?.kill("SIGKILL");
      l.proc?.kill("SIGKILL");
    } catch {
      // Already gone.
    }
    l.s.status = "failed";
    l.s.error = msg;
    delete l.s.detail;
    delete l.s.pendingApproval;
    delete l.s.needs;
    if (l.s.setup?.state === "running") l.s.setup = { ...l.s.setup, state: "failed" };
    l.finished = true;
    l.buf?.exit(null);
    ctx.log(`${name(l.s.agent)} in ${l.s.title} failed to start: ${msg}`, "warn");
    cleanup(l);
    publish(l);
    discardUnused(l);
  }

  /* ------------------------------------------------------------ lookups */

  function must(id: string): Live {
    const l = sessions.get(id);
    if (!l) throw new ControlError(404, "No such session.");
    return l;
  }

  function running(l: Live): void {
    if (l.s.status !== "running") throw new ControlError(409, l.finished ? "That agent has exited." : "It isn't running yet.");
  }

  function terminalOnly(l: Live): void {
    if (l.s.mode !== "terminal") throw new ControlError(404, "That session is in chat mode.");
  }

  return {
    availability,
    hire,
    list: () => [...sessions.values()].map((l) => ({ ...l.s, place: { ...l.s.place } })),
    get: (id) => {
      const l = sessions.get(id);
      return l ? { ...l.s, place: { ...l.s.place } } : undefined;
    },

    input(id, data) {
      const l = must(id);
      terminalOnly(l);
      if (typeof data !== "string") throw new ControlError(400, "Bad input.");
      if (l.finished || !l.term) return;
      const clean = l.buf!.filterInput(data);
      if (!clean) return;
      if (clean === "\x1b") l.lastEsc = ctx.now();
      writeTerm(l, clean);
    },

    resize(id, cols, rows) {
      const l = must(id);
      terminalOnly(l);
      const s = clampSize(Number(cols), Number(rows));
      l.buf!.resize(s.cols, s.rows);
      l.term?.resize(s.cols, s.rows);
    },

    async prompt(id, text) {
      const l = must(id);
      if (typeof text !== "string" || !text.trim()) throw new ControlError(400, "Write a prompt first.");
      running(l);
      if (l.conn) return l.conn.send(text);
      await termPrompt(l, text);
    },

    async interrupt(id) {
      const l = must(id);
      running(l);
      if (l.conn) return l.conn.interrupt();
      const open = l.hookApprovals.drain();
      if (open.length) {
        // Claude is waiting on the hook: answering it with interrupt ends the turn, no key needed.
        for (const p of open) p.meta.resolve({ interrupt: true });
        return;
      }
      if (l.drive.interrupt === "opencode" && l.oc?.session) {
        try {
          await l.oc.interrupt();
          return;
        } catch {
          // Fall back to the key.
        }
      }
      sendEsc(l);
    },

    async stop(id) {
      const l = must(id);
      if (l.finished) return;
      if (l.stopping) {
        // A second Stop doesn't wait for the grace period.
        l.term?.kill("SIGKILL");
        l.proc?.kill("SIGKILL");
        return;
      }
      l.stopping = true;
      ctx.log(`stopping ${name(l.s.agent)} in ${l.s.title}`);
      if (!l.term && !l.conn) {
        // Still being set up: the start flow sees `stopping` at its next step.
        l.abort.abort();
        if (l.s.status === "creating" || l.s.status === "installing") setStatus(l, l.s.status, "Stopping…");
        return;
      }
      if (l.conn) {
        void l.conn.stop();
        return;
      }
      l.term!.kill("SIGHUP");
      later(l, stopGrace, () => l.term?.kill("SIGKILL"));
    },

    async answer(id, a) {
      const l = must(id);
      if (!a || typeof a.id !== "string" || (a.decision !== "allow" && a.decision !== "deny")) throw new ControlError(400, "Bad answer.");
      if (l.finished) throw new ControlError(409, "That approval is no longer open.");
      if (l.conn) return l.conn.answer(a);
      if (l.hookApprovals.get(a.id)) {
        const p = l.hookApprovals.take(a.id);
        p.meta.resolve({ answer: a });
        return;
      }
      if (l.oc) return l.oc.answer(a);
      throw new ControlError(409, "That approval is no longer open.");
    },

    attachTerm(id, sink: TermSink) {
      const l = must(id);
      terminalOnly(l);
      return l.buf!.attach(sink);
    },

    attachChat(id, sink: ChatSink) {
      const l = must(id);
      if (l.s.mode !== "chat") throw new ControlError(404, "That session is in terminal mode.");
      for (const it of l.history.values()) sink.item(it);
      if (l.finished) return NOOP;
      l.chatSinks.add(sink);
      return { dispose: () => void l.chatSinks.delete(sink) };
    },

    async hook(call) {
      const l = sessions.get(call.sessionId);
      if (!l || !l.hookToken) return { status: 404, body: { error: "No such session." } };
      if (!tokenMatches(call.token, l.hookToken)) return { status: 401, body: { error: "Bad token." } };
      if (l.finished) return { status: 410, body: { error: "That session has ended." } };
      return claudeHook(l, call);
    },

    ownedPids() {
      const out: number[] = [];
      for (const l of sessions.values()) {
        if (l.finished) continue;
        for (const pid of [l.term?.pid, l.proc?.pid]) if (pid) out.push(pid);
      }
      return out;
    },

    onChange: (fn) => changed.on(fn),
    onGone: (fn) => gone.on(fn),

    async shutdown() {
      const live = [...sessions.values()].filter((l) => !l.finished);
      if (!live.length) return;
      ctx.log(`ending ${live.length} hired agent${live.length === 1 ? "" : "s"}`);
      const exits = live.map(
        (l) =>
          new Promise<void>((resolve) => {
            if (l.finished) return resolve();
            const subs: Disposable[] = [];
            if (l.term) subs.push(l.term.onExit(() => resolve()));
            if (l.proc) subs.push(l.proc.onExit(() => resolve()));
            if (!l.term && !l.proc) {
              l.stopping = true;
              l.abort.abort();
              finish(l, null);
              return resolve();
            }
            l.stopping = true;
            l.term?.kill("SIGHUP");
            l.proc?.kill("SIGHUP");
          }),
      );
      const killAll = setTimeout(() => {
        for (const l of live) {
          l.term?.kill("SIGKILL");
          l.proc?.kill("SIGKILL");
        }
      }, SHUTDOWN_KILL_MS);
      await Promise.race([Promise.all(exits), new Promise((r) => setTimeout(r, SHUTDOWN_KILL_MS + 1_000))]);
      clearTimeout(killAll);
      for (const l of live) if (!l.finished) finish(l, null);
    },
  };
}

/** The link and the one-time code on Codex's device sign-in screen. */
export function deviceCode(screen: string): { url: string; code: string } | undefined {
  if (!DEVICE_RE.test(screen)) return undefined;
  const url = /https:\/\/\S+/.exec(screen.slice(0, screen.search(DEVICE_RE)))?.[0] ?? /https:\/\/\S+/.exec(screen)?.[0];
  const after = screen.slice(screen.search(DEVICE_RE));
  const code = /\b([A-Z0-9]{3,10}(?:-[A-Z0-9]{3,10})+)\b/.exec(after)?.[1];
  if (!url || !code) return undefined;
  return { url: url.replace(/[).,]+$/, ""), code };
}
