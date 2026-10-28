/*
 * The hire form's folder browser and its recent folders. Listing is
 * confined to the user's home: the path is resolved through symlinks first
 * and must still be inside realpath($HOME), so "..", a symlink out or an
 * absolute path elsewhere is a 403. Only folder names come back, never
 * files. On macOS the privacy-protected folders directly under home
 * (Desktop, Documents, Downloads, ...) are listed but never looked into, so
 * opening the browser doesn't set off permission prompts; they are only
 * read when the user opens one.
 */
import { accessSync, constants, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";
import type { FsListing } from "../shared/control.ts";
import { ControlError, FILES } from "./types.ts";
import { privateDir, writePrivate } from "./auth.ts";

export const MAX_DIRS = 500;
export const MAX_RECENT_HIRED = 12;
const PROTECTED = new Set(["Desktop", "Documents", "Downloads", "Library", "Movies", "Music", "Pictures", "Applications"]);

const inside = (root: string, p: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/** "~", "~/x" or an absolute path, as an absolute path (not yet resolved). */
export function expandPath(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  if (isAbsolute(p)) return p;
  throw new ControlError(400, "Give a folder as ~, ~/path or an absolute path.");
}

/** The real path of an existing folder under home; ControlError otherwise. */
export function folderUnderHome(p: string, home: string): string {
  if (typeof p !== "string" || !p || p.length > 4096 || p.includes("\0")) throw new ControlError(400, "Bad folder.");
  const root = realpathSync(home);
  let real: string;
  try {
    real = realpathSync(expandPath(p, home));
  } catch {
    throw new ControlError(404, "That folder doesn't exist.");
  }
  if (!inside(root, real)) throw new ControlError(403, "Only folders under your home folder.");
  let st;
  try {
    st = statSync(real);
  } catch {
    throw new ControlError(404, "That folder doesn't exist.");
  }
  if (!st.isDirectory()) throw new ControlError(400, "That isn't a folder.");
  return real;
}

/** "~/Codes/x" for a path under home. */
export function displayPath(p: string, home: string): string {
  let root = home;
  try {
    root = realpathSync(home);
  } catch {
    // Use it as given.
  }
  if (p === root || p === home) return "~";
  for (const r of [root, home]) if (inside(r, p)) return "~" + p.slice(r.length);
  return p;
}

export function listFolders(home: string, path?: string, platform = process.platform): FsListing {
  const dir = folderUnderHome(path || "~", home);
  const root = realpathSync(home);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    throw new ControlError(403, "Can't read that folder.");
  }
  const atHome = dir === root;
  const dirs: FsListing["dirs"] = [];
  for (const d of entries) {
    if (d.name.startsWith(".")) continue;
    const full = join(dir, d.name);
    const guarded = atHome && platform === "darwin" && PROTECTED.has(d.name);
    let isDir = d.isDirectory();
    if (!isDir && d.isSymbolicLink()) {
      try {
        const target = realpathSync(full);
        isDir = inside(root, target) && statSync(target).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (!isDir) continue;
    let git = false;
    if (!guarded) {
      try {
        accessSync(full, constants.R_OK | constants.X_OK);
      } catch {
        continue;
      }
      try {
        statSync(join(full, ".git")); // a folder, or a file in a worktree or submodule
        git = true;
      } catch {
        git = false;
      }
    }
    dirs.push({ name: d.name, path: full, git });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const out: FsListing = { path: displayPath(dir, home), dirs: dirs.slice(0, MAX_DIRS) };
  if (!atHome) out.parent = dirname(dir);
  return out;
}

/** The last folders agents were hired into, in $AGENT_VISUALIZER_HOME/control-state.json. */
export class HiredFolders {
  private readonly file: string;
  private cache?: string[];

  constructor(private readonly home: string) {
    this.file = join(home, FILES.state);
  }

  list(): string[] {
    if (this.cache) return [...this.cache];
    try {
      const j = JSON.parse(readFileSync(this.file, "utf8"));
      this.cache = Array.isArray(j?.recentFolders) ? j.recentFolders.filter((p: unknown) => typeof p === "string" && isAbsolute(p)).slice(0, MAX_RECENT_HIRED) : [];
    } catch {
      this.cache = [];
    }
    return [...this.cache!];
  }

  add(folder: string): void {
    const next = [folder, ...this.list().filter((p) => p !== folder)].slice(0, MAX_RECENT_HIRED);
    this.cache = next;
    try {
      // The file keeps other remembered choices too (the last Railway project).
      let j: unknown;
      try {
        j = JSON.parse(readFileSync(this.file, "utf8"));
      } catch {
        j = undefined;
      }
      const rest = j && typeof j === "object" && !Array.isArray(j) ? j : {};
      privateDir(this.home);
      writePrivate(this.file, JSON.stringify({ ...rest, v: 1, recentFolders: next }, null, 2) + "\n");
    } catch {
      // Only a convenience.
    }
  }
}

export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
