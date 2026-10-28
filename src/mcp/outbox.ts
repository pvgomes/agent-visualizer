/*
 * Where agent signals go. The MCP server appends one AgentSignal per line to
 * $AGENT_VISUALIZER_HOME/outbox/<pid>.jsonl (default ~/.agent-visualizer); ingest tails
 * that folder here and on remotes. Writes are synchronous appends of a single
 * short line, so a tool call never waits on anything slow, and every failure
 * is swallowed into a return value: the host agent must never crash because
 * the office's folder is read-only.
 */
import { appendFileSync, chmodSync, mkdirSync, readdirSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentSignal } from "../shared/events.ts";

/**
 * The user's home as the agents see it: $HOME, and on Windows the profile folder (%USERPROFILE%),
 * which the agents and the transcript watcher use there even when a Unix-style shell (MSYS2,
 * Cygwin) has pointed HOME somewhere else.
 */
export function userHome(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string {
  return (platform === "win32" ? env.USERPROFILE : env.HOME)?.trim() || homedir();
}

/** $AGENT_VISUALIZER_HOME, else ~/.agent-visualizer. */
export function officeHome(env: NodeJS.ProcessEnv = process.env): string {
  const h = env.AGENT_VISUALIZER_HOME?.trim();
  return h ? h : join(userHome(env), ".agent-visualizer");
}

export function outboxDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(officeHome(env), "outbox");
}

/** mkdir -p with 0700, tightening the mode if the folder already existed. */
function privateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    if ((statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700);
  } catch {
    // Not ours to fix (e.g. a shared mount); writing still works.
  }
}

export interface Outbox {
  readonly file: string;
  /** Append one signal. Returns an error message instead of throwing. */
  write(signal: AgentSignal): string | null;
}

export function createOutbox(env: NodeJS.ProcessEnv = process.env, pid = process.pid): Outbox {
  const dir = outboxDir(env);
  const file = join(dir, `${pid}.jsonl`);
  let ready = false;
  return {
    file,
    write(signal) {
      try {
        if (!ready) {
          privateDir(officeHome(env));
          privateDir(dir);
          ready = true;
        }
        appendFileSync(file, JSON.stringify(signal) + "\n", { mode: 0o600 });
        return null;
      } catch (err) {
        ready = false;
        return (err as NodeJS.ErrnoException).code ?? "write failed";
      }
    },
  };
}

/** Delete outbox files nobody has written to in a week. Best effort. */
export function sweepOutbox(env: NodeJS.ProcessEnv = process.env, now = Date.now(), maxAgeMs = 7 * 86_400_000): number {
  let removed = 0;
  try {
    const dir = outboxDir(env);
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const p = join(dir, name);
      try {
        if (now - statSync(p).mtimeMs > maxAgeMs) {
          unlinkSync(p);
          removed++;
        }
      } catch {
        // Raced with another sweeper.
      }
    }
  } catch {
    // No outbox yet.
  }
  return removed;
}

/**
 * A cooldown shared by every MCP server process on this machine, keyed by an
 * action and a cwd: one empty marker file whose mtime is the last use. Two
 * agents in the same repo share one table to flip.
 */
export interface Cooldown {
  /** ms left before the action is allowed again; 0 means go (and the clock restarts). */
  take(key: string, cwd: string, windowMs: number, now?: number): number;
}

export function createCooldown(env: NodeJS.ProcessEnv = process.env): Cooldown {
  const dir = join(officeHome(env), "cooldown");
  const memory = new Map<string, number>(); // fallback when the disk is not writable
  return {
    take(key, cwd, windowMs, now = Date.now()) {
      const id = `${key}-${createHash("sha256").update(cwd).digest("hex").slice(0, 16)}`;
      const file = join(dir, id);
      let last = memory.get(id) ?? 0;
      try {
        last = Math.max(last, statSync(file).mtimeMs);
      } catch {
        // Never used.
      }
      const left = last + windowMs - now;
      if (left > 0) return Math.ceil(left);
      memory.set(id, now);
      try {
        privateDir(officeHome(env));
        privateDir(dir);
        writeFileSync(file, "", { mode: 0o600 });
        utimesSync(file, now / 1000, now / 1000);
      } catch {
        // Memory still holds it for this process.
      }
      return 0;
    },
  };
}
