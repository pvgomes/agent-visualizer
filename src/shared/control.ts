/*
 * The control plane: hiring, driving and firing agents from the office page.
 * Shared by the server (src/control/**) and the web UI (web/ui/**), the same
 * way events.ts is for the read-only office.
 *
 * Everything under /api/control needs an unlocked browser: the HttpOnly
 * SameSite=Strict cookie `ao_key` (set by GET /unlock?t=<token>, the link the
 * CLI and the service open) AND the header `X-Agent-Visualizer: 1` on every
 * request, so a cross-site page can neither read nor forge a call, AND the
 * page token in `X-Agent-Visualizer-Token` (`?k=` on /events), because a cookie
 * for 127.0.0.1 also goes to every other port there. /unlock redirects to
 * `/#unlock=<handoff>`; the page trades that once for the token
 * (POST /api/control/token {handoff} -> {token}, cookie only) and keeps it in
 * localStorage. A locked browser gets 401 and the office stays watch-only.
 *
 * Wire format (all JSON unless noted):
 *   POST   /api/control/token                   {handoff} -> {token} (the cookie is enough here)
 *   GET    /api/control                         -> ControlInfo
 *   POST   /api/control/hire                    HireRequest -> ControlSession
 *   GET    /api/control/fs?path=<dir>           -> FsListing (folders only, under $HOME)
 *   GET    /api/control/sessions/:id/term       SSE: `event: screen` {d} (the visible screen,
 *                                               at once), then `event: data` {d: base64 bytes,
 *                                               full: 1} (the whole replay with the scrollback;
 *                                               both drawn from a reset terminal), then live
 *                                               `event: data` {d}; `event: exit` {code}.
 *                                               Terminal-mode sessions only.
 *   POST   /api/control/sessions/:id/input      {data: string}   raw keystrokes into the PTY
 *   POST   /api/control/sessions/:id/resize     {cols, rows}
 *   POST   /api/control/sessions/:id/prompt     {text}  terminal: bracketed paste + Enter;
 *                                               chat: a new user turn
 *   POST   /api/control/sessions/:id/interrupt  stop the current turn, keep the session
 *   POST   /api/control/sessions/:id/stop       end the agent; its worker walks to the lift
 *   POST   /api/control/sessions/:id/approval   ApprovalAnswer
 *   GET    /api/control/sessions/:id/chat       SSE: `event: item` ChatItem (history first).
 *                                               Chat-mode sessions only.
 *   POST   /api/control/keys                    KeyInput -> KeyInfo
 *   DELETE /api/control/keys/:name
 *   POST   /api/control/keys/import             -> {imported: string[]} known key names found
 *                                               in the login shell's environment
 *   POST   /api/control/sandboxes/delete        {provider, id} (only ones the office created,
 *                                               unless {force: true})
 *   POST   /api/control/service                 {startAtLogin: boolean} -> ServiceStatus
 *   GET    /api/control/install                 -> InstallPlan (the dry run)
 *   POST   /api/control/install                 {agents?: AgentKind[]} -> InstallPlan (applied)
 *   GET    /api/control/setup?agent=&folder=    -> SetupInventory (names only; from a cache,
 *                                               `refreshing` when that may be stale: &wait=1
 *                                               answers with the fresh look)
 *   POST   /api/control/logins/claude           -> LoginFlow: runs `claude setup-token` here
 *   POST   /api/control/logins/claude/input     {data}  keystrokes (a pasted code) into it
 *   DELETE /api/control/logins/claude           cancel it
 *   (disconnect: DELETE /api/control/keys/CLAUDE_CODE_OAUTH_TOKEN)
 *
 * Live updates ride the existing /events stream as extra SSE events:
 *   `event: control`         ControlSession (created or changed)
 *   `event: control_gone`    {id}
 *   `event: control_info`    Partial<ControlInfo> (keys, providers, service changed; the
 *                            agents' versions once probed, when GET /api/control came first)
 * A hired agent is a worker at once (workerId "ctl:<id>"); when its real
 * transcript shows up the worker is renamed through OfficeEvent.replaces, and
 * ControlSession.workerId follows. Always look a session's worker up by it.
 */
import type { AgentKind, Host, ToolCategory } from "./events.ts";

export type ControlMode = "terminal" | "chat";
export type PlaceKind = "local" | "ssh" | "daytona" | "vercel" | "railway";
export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypass";

/** Where an agent runs. */
export interface Place {
  kind: PlaceKind;
  /** local: absolute folder. ssh: host alias. Cloud: sandbox id, or "new". */
  target: string;
  /** Working folder inside an ssh box or sandbox (default: its home). */
  cwd?: string;
}

export interface HireRequest {
  agent: AgentKind;
  place: Place;
  mode: ControlMode;
  /** First prompt, sent once the agent is ready. */
  prompt?: string;
  permission?: PermissionMode;
  /** Names of stored keys to hand to a remote agent. Ignored for local. */
  keys?: string[];
  /** For place.target === "new". Railway: `project` and `environment` (ids, or names) say where it goes; absent, ProviderStatus.dest. */
  sandbox?: { name?: string; timeoutMin?: number; project?: string; environment?: string };
  /** "Bring my setup": what of this machine's setup to copy there. Remote places only; absent: nothing. */
  setup?: SetupChoice;
}

/**
 * What "Bring my setup" copies into a sandbox or ssh box, by name (GET
 * /api/control/setup lists what there is). Values are read on this machine
 * at hire time and go only to that one agent's process and its own 0600
 * config files there.
 */
export interface SetupChoice {
  /**
   * How the agent signs in there. "subscription": the stored
   * CLAUDE_CODE_OAUTH_TOKEN (Settings, Logins); "key": the agent's API key
   * (stored or from the login shell), pre-approved for Claude; "device":
   * Codex's device code, shown in the panel; "copy": this machine's Codex
   * sign-in (~/.codex/auth.json); "none": it signs in by itself.
   */
  login?: SetupLoginKind;
  /** Key names found in the login shell, read at hire time and never stored. */
  shellKeys?: string[];
  /** MCP server names (SetupInventory.mcp) to write into the agent's own config there. */
  mcp?: string[];
  /** SetupItem ids (SetupInventory.instructions) to copy. */
  instructions?: string[];
  /** A folder on this machine to upload into the working folder there. */
  project?: { folder: string; git?: boolean; env?: boolean };
}

export type SetupLoginKind = "subscription" | "key" | "device" | "copy" | "none";

/** GET /api/control/setup?agent=&folder= : what "Bring my setup" can copy for that agent. Names only, never a value. */
export interface SetupInventory {
  agent: AgentKind;
  login: SetupLogin[];
  /** Known key names set in the login shell (allowlisted, values never read for this). */
  shellKeys: string[];
  mcp: SetupMcp[];
  instructions: SetupItem[];
  project?: SetupProject;
  /** Facts the form shows once ("claude.ai connectors don't come along with a setup-token login"). */
  notes: string[];
  /**
   * Part of this came from the office's cache and may be out of date: a fresh look is under way,
   * and GET /setup?...&wait=1 answers with it once it's done.
   */
  refreshing?: boolean;
}

export interface SetupLogin {
  kind: SetupLoginKind;
  label: string;
  /** "expires ~Oct 2027", "ANTHROPIC_API_KEY from your shell". */
  detail?: string;
  available: boolean;
  /** Why it isn't available ("Connect Claude in Settings, Logins"). */
  why?: string;
  /** The key names this choice hands over. */
  keys?: string[];
}

export interface SetupMcp {
  name: string;
  transport: "stdio" | "http" | "sse" | "ws";
  /** user: ~/.claude.json or ~/.codex/config.toml; local: this project's entry in ~/.claude.json; project: the project's .mcp.json (travels with the code). */
  scope: "user" | "local" | "project";
  /** Pre-ticked: an http/sse server, or a stdio one run through npx, uvx, bunx or docker. */
  ok: boolean;
  /** Why it isn't pre-ticked ("runs /Users/…/bin/server, which the sandbox won't have"). */
  why?: string;
  /** "npx -y @acme/mcp" or a host name: what it runs, never an env or header value. */
  what?: string;
  /** Env or header values it carries (written 0600 there, never shown). */
  secrets?: number;
}

export interface SetupItem {
  /** "CLAUDE.md", "rules", "skills", "agents", "commands", "settings.json", "AGENTS.md", "prompts". */
  id: string;
  label: string;
  files: number;
  bytes: number;
  /** skills: how many. */
  count?: number;
  /** What was left out and why ("hooks: run files on this Mac", "big.bin: 40 MB binary"). */
  skipped?: string[];
}

export interface SetupProject {
  folder: string;
  /** Home as "~". */
  display: string;
  files: number;
  bytes: number;
  git: { present: boolean; bytes: number; ok: boolean; why?: string };
  /** .env* files there, by name; off unless ticked. */
  envFiles: string[];
  /** Over the size or file cap: nothing is uploaded. */
  ok: boolean;
  why?: string;
  skipped?: string[];
}

/** "Bring my setup" on its way into a session's sandbox, for the starting steps. */
export interface SetupProgress {
  state: "running" | "done" | "partial" | "failed";
  /** "Claude subscription · 4 MCP servers · CLAUDE.md + 12 skills · app (3.1 MB)". */
  summary: string;
  /** What didn't make it, and why. */
  skipped?: string[];
}

/** A sign-in the office runs on this machine for the remote agents (Settings, Logins). */
export interface LoginFlow {
  agent: "claude";
  /** idle: nothing stored; running: `claude setup-token` is open; connected: a token is stored. */
  state: "idle" | "running" | "connected" | "failed";
  /** The sign-in screen while it runs, with the token cut out; for the panel. */
  screen?: string;
  /** The sign-in page, when the screen shows one. */
  url?: string;
  /** It asks for a code pasted from the browser. */
  wantsCode?: boolean;
  error?: string;
  /** When the stored token expires (setup-token: one year), approximate. */
  expiresAt?: string;
  connectedAt?: string;
}

export type SessionStatus = "creating" | "installing" | "starting" | "running" | "exited" | "failed";

export interface ControlSession {
  id: string;
  agent: AgentKind;
  place: Place;
  host?: Host;
  mode: ControlMode;
  /** The office worker this session drives ("ctl:<id>" until its transcript appears). */
  workerId: string;
  status: SessionStatus;
  /** What it is doing right now, for the status pill ("Creating Daytona sandbox…"). */
  detail?: string;
  exitCode?: number;
  error?: string;
  startedAt: string;
  /** Project name, as on the worker's pod sign. */
  title: string;
  permission: PermissionMode;
  pendingApproval?: Approval;
  /** "Bring my setup": where it is (a starting step of its own). */
  setup?: SetupProgress;
  /** Something only the user can do in the terminal now: Codex's device sign-in. */
  needs?: { kind: "device-login"; url: string; code: string };
}

export interface Approval {
  id: string;
  tool: string;
  category?: ToolCategory;
  /** Redacted, like every other label: "Edit auth.ts", "$ rm". */
  summary: string;
  at: string;
  /**
   * What is being approved, in full: the whole command, the file and its
   * change ("-old" / "+new" lines), the URL, plus why the agent asks.
   * Secrets masked, home as "~", <= ~4 KB. Unlocked browsers only (control
   * frames, the chat stream); never a label or a log line.
   */
  detail?: string;
  /** The agent offers no "always" for this one (Claude sent no rule, or said a rule would be broader than the ask): show Allow and Deny only. */
  noAlways?: boolean;
}

export interface ApprovalAnswer {
  id: string;
  decision: "allow" | "deny";
  /** Allow this tool for the rest of the session. */
  always?: boolean;
}

export interface ChatItem {
  id: string;
  kind: "user" | "assistant" | "tool" | "approval" | "system" | "error";
  /** The text of a user or assistant message. Chat mode is the one place prompt text appears. */
  text?: string;
  tool?: string;
  category?: ToolCategory;
  summary?: string;
  status?: "running" | "ok" | "error";
  at: string;
  /*
   * Everything below is optional: the page renders a plain conversation
   * without any of it, and gets richer (exact turns, durations, diffs) as an
   * adapter fills them in.
   */
  /** The turn this item belongs to, the user's prompt included. A prompt whose turn has no other items yet, while another turn runs, is shown as queued. */
  turnId?: string;
  /** On an assistant item: its text is still arriving (the page shows a cursor). False or absent: final. */
  streaming?: boolean;
  /** On a tool: how long it ran. On an item with turnEnd: how long the whole turn took. */
  durationMs?: number;
  /** On a tool: a short, already-redacted tail of its output (a few lines, <= ~2 KB), shown when the row is expanded. On an error: the longer reason. On an approval: Approval.detail. */
  detail?: string;
  /** On an edit tool: what it changed. */
  diff?: ChatDiff;
  /** On an item with turnEnd (or an assistant item): tokens the turn used, input + output. */
  tokens?: number;
  /** On a user item: accepted while another turn runs. Put the item again without it when its turn starts. */
  queued?: boolean;
  /** This item closes its turn (a "done" system item may have no text; an interrupted or failed turn can set it on its system or error item). */
  turnEnd?: boolean;
}

export interface ChatDiff {
  /** Display name, redacted like every label ("auth.ts", "src/ledger/retry.ts"). */
  file: string;
  added: number;
  removed: number;
  /** Unified-diff lines ("@@ …", "+…", "-…", " …"), redacted and capped (~80 lines). */
  lines?: string[];
}

export interface KeyInput {
  name: string;
  value: string;
  agents?: AgentKind[];
}

/** A stored key as the page sees it: never the value. */
export interface KeyInfo {
  name: string;
  /** Agents this key is for (preselected when hiring one of them remotely). */
  agents: AgentKind[];
  /** "sk-ant-…a1b2": the first 6 and last 4 characters at most. */
  preview: string;
  addedAt: string;
  /** When it expires, if known (a Claude token from Connect Claude: a year after). */
  expiresAt?: string;
}

export interface SandboxInfo {
  id: string;
  name: string;
  provider: "daytona" | "vercel" | "railway";
  status: "running" | "starting" | "stopped" | "unknown";
  /** Created from the office; only these can be deleted without force. */
  ours: boolean;
  createdAt?: string;
  expiresAt?: string;
  /** Workers in the office from this sandbox. */
  workers: number;
}

export interface ProviderStatus {
  kind: "daytona" | "vercel" | "railway" | "ssh";
  name: string;
  /** Logged in, through an env key or the provider's CLI. */
  ready: boolean;
  via?: string;
  canCreate: boolean;
  sandboxes: SandboxInfo[];
  /** ssh only: hosts from ~/.ssh/config and the office config. */
  hosts?: string[];
  /** Why canCreate is false, or what creating will do ("creates vercel-sandbox-default-project first"). */
  note?: string;
  /** Railway: the projects (and their environments) a new sandbox can go in. */
  projects?: CloudProject[];
  /** Railway: where a new sandbox goes when the hire doesn't pick (ids), and why there ("last used"). Absent: the hire has to pick. */
  dest?: { project: string; environment: string; why: string };
}

export interface CloudProject {
  id: string;
  name: string;
  /** Named when the login sees more than one workspace. */
  workspace?: string;
  environments: { id: string; name: string }[];
}

export interface AgentAvailability {
  agent: AgentKind;
  /** On this machine. */
  installed: boolean;
  version?: string;
  modes: ControlMode[];
  /** Shown when not installed. */
  installCmd?: string;
  /** Names of keys this agent can use, most preferred first. */
  keyNames: string[];
  /** Permission modes it can be started in. Absent: all four. */
  permissions?: PermissionMode[];
  /** Why a mode or permission is missing ("Terminal mode needs the PTY library"), for the hire form. */
  note?: string;
}

export interface ServiceStatus {
  supported: boolean;
  installed: boolean;
  running: boolean;
  startAtLogin: boolean;
  platform: string;
}

export interface InstallPlan {
  applied: boolean;
  agents: { agent: AgentKind; found: boolean; mcp: "add" | "update" | "ok" | "skip"; skill: "add" | "update" | "ok" | "skip"; files: string[]; diff?: string; error?: string }[];
}

export interface FsListing {
  /** Display path, home as "~". */
  path: string;
  parent?: string;
  dirs: { name: string; path: string; git: boolean }[];
}

export interface ControlInfo {
  /** False when this browser isn't unlocked; everything else is then empty. */
  enabled: boolean;
  agents: AgentAvailability[];
  providers: ProviderStatus[];
  keys: KeyInfo[];
  service: ServiceStatus;
  sessions: ControlSession[];
  /** Project folders the office has seen agents work in, most recent first. */
  recentFolders: string[];
  /** Sign-ins for remote agents (Settings, Logins). Absent: an office without them. */
  logins?: LoginFlow[];
}

export const CONTROL_HEADER = "X-Agent-Visualizer";
/** The page token (auth.ts): sent with the cookie on every control request; ?k= on /events. */
export const CONTROL_TOKEN_HEADER = "X-Agent-Visualizer-Token";
