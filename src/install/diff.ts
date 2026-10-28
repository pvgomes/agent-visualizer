/*
 * Dry-run diffs. Our edits touch one contiguous region of a file, so a
 * common-prefix/common-suffix pass finds the hunk in linear time (no LCS on a
 * 5,000-line ~/.claude.json). Every shown line can hold the user's own config
 * (a minified file is one line, so even the + and - lines are mostly theirs),
 * so every line is masked before it reaches the terminal: values under
 * secret-looking keys, and anything token-shaped.
 */
import { redactSecrets } from "../ingest/redact.ts";

const SECRET_KEY = /(key|token|secret|passw|auth|cookie|bearer|credential|session|header)/i;
const MASKED = "•••";

/** `"key": "value"` pairs anywhere in a line (minified JSON puts a whole file on one). */
const JSON_PAIR = /"((?:[^"\\]|\\.)*)"(\s*:\s*)"((?:[^"\\]|\\.)*)"/g;
/** `key = "value"` pairs (TOML), also inside inline tables. */
const TOML_PAIR = /(^|[\s{,])([A-Za-z0-9_.-]+|"(?:[^"\\]|\\.)*")(\s*=\s*)("(?:[^"\\]|\\.)*"|'[^']*')/g;
/** Absolute and home paths: kept whole, so the generic scrubber doesn't mangle a long node path. */
const PATHLIKE = /(?:~|[A-Za-z]:)?(?:[\\/][\w.@+-]+){2,}[\\/]?/g;

/**
 * Mask every value under a secret-looking key (JSON or TOML, anywhere on the line), then run the
 * generic secret scrubber over the rest. Paths are set aside first: the scrubber would read a long
 * versioned node path as a token, and our own entry is mostly paths.
 */
export function maskLine(line: string): string {
  let out = line.replace(JSON_PAIR, (m, k: string, sep: string) => (SECRET_KEY.test(k) ? `"${k}"${sep}"${MASKED}"` : m));
  out = out.replace(TOML_PAIR, (m, lead: string, k: string, sep: string) => (SECRET_KEY.test(k) ? `${lead}${k}${sep}"${MASKED}"` : m));
  const kept: string[] = [];
  out = out.replace(PATHLIKE, (m) => `\u0000${kept.push(m) - 1}\u0000`);
  out = redactSecrets(out);
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => kept[Number(i)] ?? "");
}

export interface Hunk {
  /** 1-based line number of the first shown line in the old file. */
  line: number;
  lines: { op: " " | "-" | "+"; text: string }[];
}

export function diffHunk(before: string | null, after: string | null, context = 2): Hunk | null {
  const a = before == null ? [] : before.split("\n");
  const b = after == null ? [] : after.split("\n");
  if (before === after) return null;
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const from = Math.max(0, p - context);
  const lines: Hunk["lines"] = [];
  for (let k = from; k < p; k++) lines.push({ op: " ", text: maskLine(a[k]!) });
  for (let k = p; k < a.length - s; k++) lines.push({ op: "-", text: maskLine(a[k]!) });
  for (let k = p; k < b.length - s; k++) lines.push({ op: "+", text: maskLine(b[k]!) });
  for (let k = a.length - s; k < Math.min(a.length, a.length - s + context); k++) lines.push({ op: " ", text: maskLine(a[k]!) });
  return { line: from + 1, lines };
}
