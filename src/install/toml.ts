/*
 * Just enough TOML for one table in Codex's config.toml. We never re-emit the
 * user's file: we find the `[mcp_servers.agent-visualizer]` table (and any
 * `[mcp_servers.agent-visualizer.*]` subtables) by scanning header lines, cut
 * exactly those lines, and append our own table at the end. Multi-line
 * strings are tracked so a `[` inside one is never mistaken for a header.
 * Definitions we can't edit by lines (an inline `mcp_servers = { ... }`, or
 * dotted keys under `[mcp_servers]`) are reported instead of guessed at.
 */

export class TomlEditError extends Error {}

interface Header {
  /** Line index of the header. */
  line: number;
  path: string[];
  array: boolean;
}

/** Split `a."b.c".'d'` into ["a", "b.c", "d"]. */
export function splitKey(src: string): string[] | null {
  const out: string[] = [];
  let i = 0;
  const s = src.trim();
  while (i < s.length) {
    while (s[i] === " " || s[i] === "\t") i++;
    let seg = "";
    if (s[i] === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\" && i + 1 < s.length) {
          const e = s[i + 1]!;
          seg += e === "n" ? "\n" : e === "t" ? "\t" : e;
          i += 2;
        } else seg += s[i++];
      }
      if (s[i] !== '"') return null;
      i++;
    } else if (s[i] === "'") {
      i++;
      while (i < s.length && s[i] !== "'") seg += s[i++];
      if (s[i] !== "'") return null;
      i++;
    } else {
      while (i < s.length && /[A-Za-z0-9_-]/.test(s[i]!)) seg += s[i++];
      if (!seg) return null;
    }
    out.push(seg);
    while (s[i] === " " || s[i] === "\t") i++;
    if (i < s.length) {
      if (s[i] !== ".") return null;
      i++;
    }
  }
  return out.length ? out : null;
}

/** `[a.b]` or `[[a.b]]` with an optional trailing comment; null if the line isn't a header. */
function parseHeader(line: string): { path: string[]; array: boolean } | null {
  const t = line.trim();
  if (!t.startsWith("[")) return null;
  const array = t.startsWith("[[");
  let i = array ? 2 : 1;
  let inQ: string | null = null;
  for (; i < t.length; i++) {
    const c = t[i]!;
    if (inQ) {
      if (c === "\\" && inQ === '"') i++;
      else if (c === inQ) inQ = null;
    } else if (c === '"' || c === "'") inQ = c;
    else if (c === "]") break;
  }
  if (i >= t.length) return null;
  const key = t.slice(array ? 2 : 1, i);
  const close = array ? "]]" : "]";
  if (t.slice(i, i + close.length) !== close) return null;
  const rest = t.slice(i + close.length).trim();
  if (rest && !rest.startsWith("#")) return null;
  const path = splitKey(key);
  return path ? { path, array } : null;
}

type Open = '"""' | "'''" | null;

/**
 * Lex one line just far enough to know whether a multi-line string is still open at its end.
 * Strings and comments are skipped as TOML does, so a `"""` inside a comment or a one-line
 * string ("# prompts go in \"\"\" blocks") never opens one.
 */
function scanLine(line: string, open: Open): Open {
  let i = 0;
  if (open) {
    const end = closeAt(line, 0, open);
    if (end < 0) return open;
    i = end;
  }
  while (i < line.length) {
    const c = line[i]!;
    if (c === "#") return null;
    if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
      const q = line.slice(i, i + 3) as Exclude<Open, null>;
      const end = closeAt(line, i + 3, q);
      if (end < 0) return q;
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < line.length && line[i] !== c) i += c === '"' && line[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    i++;
  }
  return null;
}

/** Index just past the closing quotes of a multi-line string opened before `from`, or -1. */
function closeAt(line: string, from: number, q: Exclude<Open, null>): number {
  for (let i = from; i <= line.length - 3; i++) {
    if (q === '"""' && line[i] === "\\") {
      i++;
      continue;
    }
    if (line.startsWith(q, i)) {
      // Up to two extra quotes right before the delimiter belong to the string ("""a"""").
      let j = i + 3;
      while (j < line.length && line[j] === q[0] && j < i + 5) j++;
      return j;
    }
  }
  return -1;
}

/** Header lines, skipping anything inside multi-line strings. */
function headers(lines: string[]): Header[] {
  const out: Header[] = [];
  let open: Open = null;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!;
    if (!open) {
      const h = parseHeader(line);
      if (h) {
        out.push({ line: n, ...h });
        continue;
      }
    }
    open = scanLine(line, open);
  }
  return out;
}

/** How many times the document defines the table at `path` (more than one is invalid TOML). */
export function tableCount(text: string, path: string[]): number {
  return headers(text.split("\n")).filter((h) => !h.array && h.path.length === path.length && h.path.every((p, k) => p === path[k])).length;
}

const startsWith = (path: string[], prefix: string[]) => prefix.every((p, k) => path[k] === p);

/** Line ranges [from, to) of the table at `path` and its subtables. */
function tableRanges(lines: string[], path: string[]): [number, number][] {
  const hs = headers(lines);
  const ranges: [number, number][] = [];
  hs.forEach((h, k) => {
    if (!startsWith(h.path, path)) return;
    const to = k + 1 < hs.length ? hs[k + 1]!.line : lines.length;
    ranges.push([h.line, to]);
  });
  return ranges;
}

/** Throw if `path` is defined in a way we can't edit by whole lines. */
function assertLineEditable(lines: string[], path: string[]): void {
  const hs = headers(lines);
  const parent = path.slice(0, -1);
  const leaf = path[path.length - 1]!;
  // Root-level `mcp_servers = {...}` or `mcp_servers.agent-visualizer.command = ...` before any header.
  const firstHeader = hs.length ? hs[0]!.line : lines.length;
  for (let n = 0; n < firstHeader; n++) {
    const key = /^\s*([^=#\[]+?)\s*=/.exec(lines[n]!)?.[1];
    const kp = key ? splitKey(key) : null;
    if (kp && startsWith(path, kp.slice(0, Math.min(kp.length, path.length)))) {
      throw new TomlEditError(`"${kp.join(".")}" is set inline at line ${n + 1}; edit it by hand or remove it first`);
    }
  }
  // Under a parent table header, `agent-visualizer = {...}` or `agent-visualizer.x = ...`.
  hs.forEach((h, k) => {
    if (h.path.length !== parent.length || !startsWith(h.path, parent)) return;
    const to = k + 1 < hs.length ? hs[k + 1]!.line : lines.length;
    for (let n = h.line + 1; n < to; n++) {
      const key = /^\s*([^=#\[]+?)\s*=/.exec(lines[n]!)?.[1];
      const kp = key ? splitKey(key) : null;
      if (kp && kp[0] === leaf) throw new TomlEditError(`"${[...parent, ...kp].join(".")}" is set inside [${parent.join(".")}] at line ${n + 1}; edit it by hand`);
    }
  });
}

/** Does the document define the table at `path` (as a header)? */
export function hasTable(text: string, path: string[]): boolean {
  return tableRanges(text.split("\n"), path).length > 0;
}

/** Remove the table at `path` and its subtables. Returns the text unchanged if absent. */
export function removeTable(text: string, path: string[]): string {
  const lines = text.split("\n");
  const ranges = tableRanges(lines, path);
  if (!ranges.length) return text;
  const drop = new Set<number>();
  for (const [from, to] of ranges) for (let n = from; n < to; n++) drop.add(n);
  // Also take one blank line that separated the table from what came before.
  const first = ranges[0]![0];
  if (first > 0 && lines[first - 1]!.trim() === "") drop.add(first - 1);
  const kept = lines.filter((_, n) => !drop.has(n));
  // Removing the last table can leave the file ending in blank lines: keep exactly one newline.
  let out = kept.join("\n");
  if (text.endsWith("\n")) out = out.replace(/\n*$/, "\n");
  return out === "\n" ? "" : out;
}

/** Replace (or add) the table at `path` with `body` lines ("key = value"). */
export function setTable(text: string, path: string[], body: string[]): string {
  const lines = text.split("\n");
  assertLineEditable(lines, path);
  const header = `[${path.map((p) => (/^[A-Za-z0-9_-]+$/.test(p) ? p : JSON.stringify(p))).join(".")}]`;
  const block = [header, ...body].join("\n");
  const base = removeTable(text, path);
  if (!base.trim()) return block + "\n";
  return base.replace(/\n*$/, "\n") + "\n" + block + "\n";
}

/**
 * Set `keys` inside the existing table at `path`, keeping every other key, comment and
 * subtable the user put there (env, startup_timeout_sec, [mcp_servers.agent-visualizer.env]).
 * A key set to null is removed. Falls back to setTable when the table isn't there yet.
 */
export function updateTable(text: string, path: string[], keys: Record<string, string | null>): string {
  const lines = text.split("\n");
  assertLineEditable(lines, path);
  const hs = headers(lines);
  const k = hs.findIndex((h) => !h.array && h.path.length === path.length && startsWith(h.path, path));
  if (k < 0) {
    const body = Object.entries(keys).filter(([, v]) => v !== null).map(([key, v]) => `${key} = ${v}`);
    return setTable(text, path, body);
  }
  const from = hs[k]!.line + 1;
  const to = k + 1 < hs.length ? hs[k + 1]!.line : lines.length;
  const out = lines.slice(0, from);
  const done = new Set<string>();
  let open: Open = null;
  for (let n = from; n < to; n++) {
    const line = lines[n]!;
    const key = open ? undefined : /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line)?.[1];
    if (key && key in keys) {
      // Skip the old value, however many lines it spans (a multi-line array or string).
      let end = n;
      let depth = bracketDepth(line.slice(line.indexOf("=") + 1));
      let st = scanLine(line, null);
      while ((depth > 0 || st) && end + 1 < to) {
        end++;
        depth += bracketDepth(lines[end]!, st);
        st = scanLine(lines[end]!, st);
      }
      if (keys[key] !== null && !done.has(key)) out.push(`${key} = ${keys[key]}`);
      done.add(key);
      n = end;
      continue;
    }
    out.push(line);
    open = scanLine(line, open);
  }
  // Keys the table didn't have yet go right under its header.
  const missing = Object.entries(keys).filter(([key, v]) => v !== null && !done.has(key)).map(([key, v]) => `${key} = ${v}`);
  out.splice(from, 0, ...missing);
  out.push(...lines.slice(to));
  return out.join("\n");
}

/** Keys set directly in the table at `path`, plus the names of its subtables ("env" for [..agent-visualizer.env]). */
export function tableKeys(text: string, path: string[]): string[] {
  const lines = text.split("\n");
  const hs = headers(lines);
  const out: string[] = [];
  hs.forEach((h, k) => {
    if (!startsWith(h.path, path)) return;
    if (h.path.length > path.length) {
      out.push(h.path[path.length]!);
      return;
    }
    const to = k + 1 < hs.length ? hs[k + 1]!.line : lines.length;
    let open: Open = null;
    for (let n = h.line + 1; n < to; n++) {
      const key = open ? undefined : /^\s*([A-Za-z0-9_-]+)\s*=/.exec(lines[n]!)?.[1];
      if (key) out.push(key);
      open = scanLine(lines[n]!, open);
    }
  });
  return [...new Set(out)];
}

/** Net [ minus ] outside strings and comments on one line. */
function bracketDepth(line: string, open: Open = null): number {
  let d = 0;
  let i = 0;
  if (open) {
    const end = closeAt(line, 0, open);
    if (end < 0) return 0;
    i = end;
  }
  while (i < line.length) {
    const c = line[i]!;
    if (c === "#") break;
    if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
      const end = closeAt(line, i + 3, line.slice(i, i + 3) as Exclude<Open, null>);
      if (end < 0) break;
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < line.length && line[i] !== c) i += c === '"' && line[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (c === "[") d++;
    else if (c === "]") d--;
    i++;
  }
  return d;
}

/** A TOML basic string. JSON's escapes are all valid TOML escapes. */
export function tomlString(s: string): string {
  return JSON.stringify(s);
}

export function tomlArray(items: string[]): string {
  return `[${items.map(tomlString).join(", ")}]`;
}

/** Read `command` and `args` from the table at `path`, best effort. */
export function readCommand(text: string, path: string[]): { command?: string; args?: string[]; enabled?: boolean } | null {
  const lines = text.split("\n");
  const own = tableRanges(lines, path).find(([from]) => headers(lines).find((h) => h.line === from)!.path.length === path.length);
  if (!own) return null;
  const body = lines.slice(own[0] + 1, own[1]).join("\n");
  const out: { command?: string; args?: string[]; enabled?: boolean } = {};
  const en = /^\s*enabled\s*=\s*(true|false)\b/m.exec(body)?.[1];
  if (en) out.enabled = en === "true";
  const cmd = /^\s*command\s*=\s*("(?:\\.|[^"\\])*"|'[^']*')/m.exec(body)?.[1];
  if (cmd) out.command = parseTomlString(cmd);
  const argsAt = /^\s*args\s*=\s*\[/m.exec(body);
  if (argsAt) {
    const items: string[] = [];
    const re = /"(?:\\.|[^"\\])*"|'[^']*'|\]/g;
    re.lastIndex = argsAt.index + argsAt[0].length;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) {
      if (m[0] === "]") break;
      items.push(parseTomlString(m[0]));
    }
    out.args = items;
  }
  return out;
}

function parseTomlString(tok: string): string {
  if (tok.startsWith("'")) return tok.slice(1, -1);
  try {
    return JSON.parse(tok.replace(/\\U([0-9a-fA-F]{8})/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16))));
  } catch {
    return tok.slice(1, -1);
  }
}
