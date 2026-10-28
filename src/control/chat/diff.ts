/*
 * ChatItem.diff from what an agent's edit tool was given: Claude's Edit /
 * MultiEdit / Write input, Codex's fileChange (the patch it applied), opencode's
 * edit / write / apply_patch input. The lines are only ones the agent itself
 * sent (its old and new text, the lines of its patch): never context an agent
 * runtime read from the file around them, and never a deleted file's contents.
 * Every line is masked like chat text (keys, the home folder as "~") and the
 * whole is capped.
 */
import type { ChatDiff } from "../../shared/control.ts";
import { basename } from "../../ingest/common.ts";
import { redactSecrets, safe } from "../../ingest/redact.ts";

/** ChatDiff.lines holds at most this many lines ("~80" in the contract). */
export const DIFF_LINES = 80;
const LINE_CHARS = 400;
/** Past this many line pairs (8 MB of table) a replacement is shown as all "-" then all "+" instead of diffed. */
const LCS_MAX = 2_000_000;
/** Unchanged lines kept before the first and after the last change. */
const EDGE_CONTEXT = 3;

/** One file's part of an edit: its unified-diff lines and counts. */
export interface FileChange {
  path: string;
  lines: string[];
  added: number;
  removed: number;
}

function split(s: unknown): string[] {
  if (typeof s !== "string" || s === "") return [];
  const out = s.replace(/\r\n?/g, "\n").split("\n");
  if (out[out.length - 1] === "") out.pop();
  return out;
}

function count(lines: string[]): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const l of lines) {
    if (l.startsWith("@@")) continue;
    if (l[0] === "+") added++;
    else if (l[0] === "-") removed++;
  }
  return { added, removed };
}

/** old -> new text as " " / "-" / "+" lines, by the longest common run of lines; both texts are the agent's own. */
export function replaceLines(oldText: unknown, newText: unknown): string[] {
  const a = split(oldText), b = split(newText);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const x = a.slice(pre, a.length - suf), y = b.slice(pre, b.length - suf);
  const mid: string[] = [];
  if (x.length * y.length > LCS_MAX) {
    mid.push(...x.map((l) => `-${l}`), ...y.map((l) => `+${l}`));
  } else {
    // dp[i][j]: the longest common run of x[i..] and y[j..]
    const w = y.length + 1;
    const dp = new Uint32Array((x.length + 1) * w);
    for (let i = x.length - 1; i >= 0; i--)
      for (let j = y.length - 1; j >= 0; j--)
        dp[i * w + j] = x[i] === y[j] ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
    let i = 0, j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) {
        mid.push(` ${x[i]}`);
        i++, j++;
      } else if (i < x.length && (j >= y.length || dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!)) mid.push(`-${x[i++]}`);
      else mid.push(`+${y[j++]}`);
    }
  }
  const head = a.slice(Math.max(0, pre - EDGE_CONTEXT), pre).map((l) => ` ${l}`);
  const tail = a.slice(a.length - suf, a.length - suf + EDGE_CONTEXT).map((l) => ` ${l}`);
  return [...head, ...mid, ...tail];
}

/** A replacement (Edit's old_string / new_string), or several in one file joined as hunks. */
export function replaceChange(path: string, edits: { old: unknown; new: unknown }[]): FileChange {
  const lines: string[] = [];
  for (const e of edits) {
    const part = replaceLines(e.old, e.new);
    if (!part.length) continue;
    if (lines.length) lines.push("@@");
    lines.push(...part);
  }
  return { path, lines, ...count(lines) };
}

/**
 * Only a change's +/- lines, runs apart split by "@@": for an old and new
 * text that may be whole files (an ACP diff), whose unchanged lines the agent
 * didn't write.
 */
export function changedOnly(c: FileChange): FileChange {
  const lines: string[] = [];
  let gap = false;
  for (const l of c.lines) {
    if (l[0] === "+" || l[0] === "-") {
      if (gap && lines.length) lines.push("@@");
      gap = false;
      lines.push(l);
    } else gap = true;
  }
  return { ...c, lines };
}

/** A whole new file the agent wrote. */
export function addChange(path: string, content: unknown): FileChange {
  const body = split(content).map((l) => `+${l}`);
  return { path, lines: body.length ? [`@@ -0,0 +1,${body.length} @@`, ...body] : [], added: body.length, removed: 0 };
}

/**
 * A unified diff an agent runtime computed (Codex's fileChange update):
 * hunk headers (without the section text after them) and the +/- lines,
 * which are the agent's own patch. Context lines come from the file, so
 * they are dropped.
 */
export function unifiedChange(path: string, diff: unknown): FileChange {
  const lines: string[] = [];
  let hunk = false;
  for (const l of split(diff)) {
    if (l.startsWith("@@")) {
      lines.push(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(l)?.[0] ?? "@@");
      hunk = true;
    } else if (!hunk && /^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/.test(l)) continue;
    else if (l[0] === "+" || l[0] === "-") lines.push(l);
  }
  return { path, lines, ...count(lines) };
}

/**
 * A patch in the apply_patch format, as the agent wrote it (opencode's
 * apply_patch input). Everything in it is the agent's own text, context lines
 * included. A deleted file carries no lines, so it is left out (its size isn't
 * known).
 */
export function applyPatchChanges(patch: unknown): FileChange[] {
  const out: FileChange[] = [];
  const added = new Set<FileChange>();
  let cur: FileChange | undefined;
  for (const l of split(patch)) {
    const m = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(l);
    if (m) {
      cur = m[1] === "Delete" ? undefined : { path: m[2]!.trim(), lines: [], added: 0, removed: 0 };
      if (cur) out.push(cur);
      if (cur && m[1] === "Add") added.add(cur);
      continue;
    }
    const mv = /^\*\*\* Move to: (.+)$/.exec(l);
    if (mv && cur) cur.path = mv[1]!.trim();
    if (!cur || l.startsWith("***")) continue;
    if (l[0] === "+") {
      cur.lines.push(l);
      cur.added++;
    } else if (added.has(cur)) continue;
    else if (l.startsWith("@@")) cur.lines.push(l);
    else if (l[0] === "-") {
      cur.lines.push(l);
      cur.removed++;
    } else if (l[0] === " " || l === "") cur.lines.push(l === "" ? " " : l);
  }
  for (const c of added) if (c.added) c.lines.unshift(`@@ -0,0 +1,${c.added} @@`);
  return out;
}

/** "/Users/me" -> "~", but not "/Users/me2". */
export function tildeHome(text: string, home: string | undefined): string {
  const h = (home ?? "").replace(/\/+$/, "");
  if (!h) return text;
  let out = "";
  let i = 0;
  for (let j = text.indexOf(h); j >= 0; j = text.indexOf(h, i)) {
    const next = text[j + h.length];
    out += text.slice(i, j) + (next === undefined || next === "/" || !/[\w.-]/.test(next) ? "~" : h);
    i = j + h.length;
  }
  return out + text.slice(i);
}

/** A file as the diff names it: its path inside the working folder ("src/ledger/retry.ts"), else its name. */
export function diffName(path: string, cwd: string | undefined): string {
  const p = path.trim().replace(/\\/g, "/");
  const root = (cwd ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  let rel: string;
  if (root && p.startsWith(root + "/")) rel = p.slice(root.length + 1);
  else if (!/^([/~]|[A-Za-z]:)/.test(p)) rel = p.replace(/^\.\//, "");
  else rel = basename(p);
  if (!rel || rel.split("/").includes("..")) rel = basename(p);
  return safe(rel, 96);
}

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;

function cleanLine(l: string, home: string | undefined): string {
  const s = redactSecrets(tildeHome(l.replace(CONTROL, ""), home));
  return s.length > LINE_CHARS ? s.slice(0, LINE_CHARS - 1) + "…" : s;
}

/**
 * The ChatDiff for one tool call. Several files (one Codex patch, one
 * apply_patch) are one diff: the names joined, the counts summed, each file's
 * lines under an "@@ name @@" line. Undefined when nothing names a file.
 */
export function chatDiff(changes: FileChange[], o: { cwd?: string; home?: string } = {}): ChatDiff | undefined {
  const files = changes.filter((c) => c.path.trim());
  if (!files.length) return undefined;
  const names = files.map((c) => diffName(c.path, o.cwd));
  const uniq = [...new Set(names)];
  const file = uniq.length <= 3 ? uniq.join(", ") : `${uniq.slice(0, 3).join(", ")} +${uniq.length - 3}`;
  const lines: string[] = [];
  let added = 0, removed = 0;
  files.forEach((c, i) => {
    added += c.added;
    removed += c.removed;
    if (files.length > 1) lines.push(`@@ ${names[i]} @@`);
    lines.push(...c.lines);
  });
  const shown = lines.slice(0, DIFF_LINES).map((l) => cleanLine(l, o.home));
  return { file, added, removed, ...(shown.some((l) => l !== "@@") ? { lines: shown } : {}) };
}
