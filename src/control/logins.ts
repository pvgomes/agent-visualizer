/*
 * Settings, Logins: sign-ins the office runs on this machine for agents it
 * hires elsewhere. Connect Claude runs `claude setup-token`, Claude Code's
 * documented way to sign a headless box in with a subscription: it opens the
 * browser sign-in and prints a one-year OAuth token for
 * CLAUDE_CODE_OAUTH_TOKEN. The office reads that token off the screen, keeps
 * it in the key store (agents: claude) and ends the process.
 *
 * The token never reaches the page, a log or anything that outlives the
 * capture: the process runs in a PTY 500 columns wide, read unwrapped (so the
 * token is one line), its bytes go only into a headless screen here, and the page gets
 * that screen as text with anything token-shaped cut out. On capture the
 * screen is thrown away and the process killed; there is no scrollback, no
 * replay and no TermBuffer left holding it.
 */
import type { LoginFlow } from "../shared/control.ts";
import { findBin } from "./agents.ts";
import { Emitter } from "./emitter.ts";
import { oauthExpiry } from "./setup.ts";
import { TermBuffer } from "./term.ts";
import { ControlError, type ControlContext, type Disposable, type KeyStore, type PtyBackend, type Term } from "./types.ts";

export const OAUTH_KEY = "CLAUDE_CODE_OAUTH_TOKEN";
/** As wide as a PTY goes here, and the screen is read unwrapped: the token and the sign-in URL (~340 characters) come back whole. */
const COLS = 500;
const ROWS = 60;
const WAIT_MS = 10 * 60_000;
const CHECK_MS = 120;

export interface LoginsOptions {
  ctx: ControlContext;
  keys: KeyStore;
  pty: () => Promise<PtyBackend | null>;
  /** The claude binary (tests); default: found on the agents' PATH. */
  bin?: () => string | undefined;
  waitMs?: number;
}

export interface Logins {
  status(): LoginFlow[];
  start(agent: string): Promise<LoginFlow>;
  input(agent: string, data: string): void;
  cancel(agent: string): void;
  onChange(fn: (flows: LoginFlow[]) => void): Disposable;
  /** The sign-in's own process: presence leaves it alone (it is Claude, but not a session). */
  pids(): number[];
  shutdown(): void;
}

/** The token on setup-token's success screen: the line after "Your OAuth token (valid for …):", or anything sk-ant-oat-shaped. */
export function tokenOf(screen: string): string | undefined {
  const lines = screen.split("\n").map((l) => l.trim());
  const at = lines.findIndex((l) => /Your OAuth token/i.test(l));
  if (at >= 0) {
    for (const l of lines.slice(at + 1, at + 4)) {
      if (!l) continue;
      if (/^[A-Za-z0-9._~+/=-]{40,}$/.test(l)) return l;
      break;
    }
  }
  return /\bsk-ant-oat\d*-[A-Za-z0-9_-]{20,}/.exec(screen)?.[0];
}

/** "valid for 1 year" / "valid for 364 days" -> ms, else a year. */
export function validFor(screen: string): number {
  const m = /valid for\s+(\d+)\s+(year|day)s?/i.exec(screen);
  if (!m) return 365 * 86400_000;
  return Number(m[1]) * (m[2]!.toLowerCase() === "year" ? 365 : 1) * 86400_000;
}

/** The screen as the page may see it: nothing token-shaped, nothing after the token heading. */
export function scrubScreen(screen: string): string {
  const out: string[] = [];
  let cut = false;
  for (const line of screen.split("\n")) {
    if (/Your OAuth token/i.test(line)) {
      out.push(line);
      cut = true;
      continue;
    }
    if (cut && line.trim() && !/Store this token|Use this token/i.test(line)) {
      out.push("  •••");
      cut = false;
      continue;
    }
    out.push(
      line
        .replace(/\bsk-ant-[A-Za-z0-9_-]+/g, "sk-ant-•••")
        // a long token-ish run that isn't part of a URL
        .replace(/(^|[\s"'])([A-Za-z0-9_-]{60,})(?=$|[\s"'])/g, "$1•••"),
    );
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function createLogins(o: LoginsOptions): Logins {
  const { ctx, keys } = o;
  const changed = new Emitter<LoginFlow[]>();
  let run: { term: Term; buf: TermBuffer; timer?: ReturnType<typeof setTimeout>; deadline: ReturnType<typeof setTimeout>; screen: string; url?: string; wantsCode: boolean; done: boolean } | undefined;
  let last: { state: "failed"; error: string } | undefined;

  function claude(): LoginFlow {
    const k = keys.list().find((x) => x.name === OAUTH_KEY);
    if (run && !run.done) return { agent: "claude", state: "running", screen: run.screen, ...(run.url ? { url: run.url } : {}), ...(run.wantsCode ? { wantsCode: true } : {}) };
    if (last) return { agent: "claude", state: "failed", error: last.error, ...(k ? { expiresAt: oauthExpiry(k), connectedAt: k.addedAt } : {}) };
    if (k) return { agent: "claude", state: "connected", ...(oauthExpiry(k) ? { expiresAt: oauthExpiry(k) } : {}), connectedAt: k.addedAt };
    return { agent: "claude", state: "idle" };
  }
  const status = () => [claude()];
  const emit = () => changed.emit(status());

  function end(): void {
    if (!run) return;
    const r = run;
    r.done = true;
    if (r.timer) clearTimeout(r.timer);
    clearTimeout(r.deadline);
    try {
      r.term.kill("SIGKILL");
    } catch {
      // Gone already.
    }
    // The headless screen held the token for a moment: drop it, scrollback and all.
    r.buf.dispose();
    r.screen = "";
    run = undefined;
  }

  function fail(error: string): void {
    end();
    last = { state: "failed", error };
    emit();
  }

  async function check(): Promise<void> {
    const r = run;
    if (!r || r.done) return;
    r.timer = undefined;
    const text = await r.buf.screen({ unwrap: true });
    if (r.done) return;
    const token = tokenOf(text);
    if (token) {
      const expiresAt = new Date(ctx.now() + validFor(text)).toISOString();
      end();
      try {
        keys.put({ name: OAUTH_KEY, value: token, agents: ["claude"] }, { expiresAt });
      } catch (err) {
        last = { state: "failed", error: err instanceof ControlError ? err.message : "Couldn't store the token." };
        emit();
        return;
      }
      last = undefined;
      ctx.log("connected Claude: a setup-token is stored for remote agents");
      emit();
      return;
    }
    const screen = scrubScreen(text);
    const url = /https:\/\/\S+/.exec(text)?.[0]?.replace(/[)>.,]+$/, "");
    const wantsCode = /paste code/i.test(text);
    if (screen !== r.screen || url !== r.url || wantsCode !== r.wantsCode) {
      r.screen = screen;
      r.url = url;
      r.wantsCode = wantsCode;
      emit();
    }
  }

  return {
    status,
    async start(agent) {
      if (agent !== "claude") throw new ControlError(404, "Only Claude has a sign-in here.");
      if (run && !run.done) return claude();
      const bin = (o.bin ?? (() => findBin("claude", ctx.agentEnv())))();
      if (!bin) throw new ControlError(400, "Claude Code isn't installed on this machine: install it, then connect.");
      const pty = await o.pty();
      if (!pty) throw new ControlError(503, "Connecting Claude needs the PTY library (or python3) on this machine.");
      last = undefined;
      const env: Record<string, string> = { ...ctx.agentEnv(), TERM: "xterm-256color", COLORTERM: "truecolor" };
      // Its own sign-in, not a key the environment already has.
      delete env.ANTHROPIC_API_KEY;
      delete env[OAUTH_KEY];
      let term: Term;
      try {
        term = pty.spawn({ file: bin, args: ["setup-token"], cwd: ctx.userHome, env, cols: COLS, rows: ROWS });
      } catch {
        throw new ControlError(500, "Couldn't start claude setup-token.");
      }
      const buf = new TermBuffer({ cols: COLS, rows: ROWS, reply: (d) => term.write(d), now: ctx.now, scrollback: 0 });
      const deadline = setTimeout(() => fail("The sign-in took longer than 10 minutes. Try again."), o.waitMs ?? WAIT_MS);
      deadline.unref?.();
      const r = { term, buf, deadline, screen: "", wantsCode: false, done: false } as NonNullable<typeof run>;
      run = r;
      term.onData((c) => {
        if (r.done) return;
        buf.write(c);
        if (!r.timer) {
          r.timer = setTimeout(() => void check(), CHECK_MS);
          r.timer.unref?.();
        }
      });
      term.onExit((e) => {
        if (r.done) return;
        // A last look: the token may have arrived with the exit.
        void check().then(() => {
          if (run === r && !r.done) fail(`claude setup-token ended (${e.code ?? "signal"}) without a token.`);
        });
      });
      ctx.log("connecting Claude: claude setup-token is running");
      emit();
      return claude();
    },
    input(agent, data) {
      if (agent !== "claude" || !run || run.done) throw new ControlError(409, "No sign-in is running.");
      if (typeof data !== "string" || data.length > 4096) throw new ControlError(400, "Bad input.");
      run.term.write(data);
    },
    cancel(agent) {
      if (agent !== "claude") return;
      const was = !!run;
      end();
      last = undefined;
      if (was) emit();
    },
    onChange: (fn) => changed.on(fn),
    pids: () => (run && !run.done && run.term.pid ? [run.term.pid] : []),
    shutdown() {
      end();
    },
  };
}
