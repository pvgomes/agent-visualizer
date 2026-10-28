/*
 * Just enough TOML for Codex's `[mcp_servers.*]` tables: read a config.toml
 * into plain values (tables, dotted keys, strings, numbers, booleans, arrays
 * and inline tables, values that span lines), and write one server back as
 * its own `[mcp_servers.<name>]` table. Anything it can't read is skipped
 * line by line rather than guessed at.
 */

export type TomlValue = string | number | boolean | TomlValue[] | { [k: string]: TomlValue };
export type TomlTable = { [k: string]: TomlValue };

class Reader {
  i = 0;
  constructor(readonly s: string) {}
  ws(lines = false): void {
    for (;;) {
      const c = this.s[this.i];
      if (c === " " || c === "\t" || (lines && (c === "\n" || c === "\r"))) this.i++;
      else if (c === "#" && lines) {
        while (this.i < this.s.length && this.s[this.i] !== "\n") this.i++;
      } else break;
    }
  }
  key(): string[] {
    const parts: string[] = [];
    for (;;) {
      this.ws();
      const c = this.s[this.i];
      if (c === '"') parts.push(this.basic());
      else if (c === "'") parts.push(this.literal());
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(this.s.slice(this.i));
        if (!m) throw new Error("bad key");
        parts.push(m[0]);
        this.i += m[0].length;
      }
      this.ws();
      if (this.s[this.i] === ".") {
        this.i++;
        continue;
      }
      return parts;
    }
  }
  basic(): string {
    if (this.s.startsWith('"""', this.i)) {
      this.i += 3;
      if (this.s[this.i] === "\n") this.i++;
      const end = this.s.indexOf('"""', this.i);
      if (end < 0) throw new Error("open string");
      const raw = this.s.slice(this.i, end);
      this.i = end + 3;
      return unescape(raw.replace(/\\\r?\n\s*/g, ""));
    }
    this.i++;
    let out = "";
    for (;;) {
      const c = this.s[this.i];
      if (c === undefined || c === "\n") throw new Error("open string");
      if (c === '"') {
        this.i++;
        return unescape(out);
      }
      if (c === "\\") {
        out += c + (this.s[this.i + 1] ?? "");
        this.i += 2;
        continue;
      }
      out += c;
      this.i++;
    }
  }
  literal(): string {
    if (this.s.startsWith("'''", this.i)) {
      this.i += 3;
      if (this.s[this.i] === "\n") this.i++;
      const end = this.s.indexOf("'''", this.i);
      if (end < 0) throw new Error("open string");
      const raw = this.s.slice(this.i, end);
      this.i = end + 3;
      return raw;
    }
    this.i++;
    const end = this.s.indexOf("'", this.i);
    const nl = this.s.indexOf("\n", this.i);
    if (end < 0 || (nl >= 0 && nl < end)) throw new Error("open string");
    const v = this.s.slice(this.i, end);
    this.i = end + 1;
    return v;
  }
  value(): TomlValue {
    this.ws();
    const c = this.s[this.i];
    if (c === '"') return this.basic();
    if (c === "'") return this.literal();
    if (c === "[") {
      this.i++;
      const out: TomlValue[] = [];
      for (;;) {
        this.ws(true);
        if (this.s[this.i] === "]") {
          this.i++;
          return out;
        }
        out.push(this.value());
        this.ws(true);
        if (this.s[this.i] === ",") this.i++;
        else if (this.s[this.i] !== "]") throw new Error("bad array");
      }
    }
    if (c === "{") {
      this.i++;
      const out: TomlTable = {};
      for (;;) {
        this.ws(true);
        if (this.s[this.i] === "}") {
          this.i++;
          return out;
        }
        const k = this.key();
        if (this.s[this.i] !== "=") throw new Error("bad inline table");
        this.i++;
        setPath(out, k, this.value());
        this.ws(true);
        if (this.s[this.i] === ",") this.i++;
        else if (this.s[this.i] !== "}") throw new Error("bad inline table");
      }
    }
    const m = /^[^\s,\]\}#]+/.exec(this.s.slice(this.i));
    if (!m) throw new Error("bad value");
    this.i += m[0].length;
    const t = m[0];
    if (t === "true") return true;
    if (t === "false") return false;
    const n = Number(t.replace(/_/g, ""));
    if (Number.isFinite(n)) return n;
    // Dates and the like: kept as text.
    return t;
  }
}

function unescape(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, e: string) => {
    if (e[0] === "u" || e[0] === "U") return String.fromCodePoint(parseInt(e.slice(1), 16));
    return ({ b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" } as Record<string, string>)[e] ?? e;
  });
}

const UNSAFE = new Set(["__proto__", "constructor", "prototype"]);
/** A config from another machine must not reach Object.prototype. */
function safeKeys(path: string[]): string[] {
  if (path.some((p) => UNSAFE.has(p))) throw new Error("unsafe key");
  return path;
}

function setPath(t: TomlTable, path: string[], v: TomlValue): void {
  safeKeys(path);
  let cur = t;
  for (const p of path.slice(0, -1)) {
    const next = cur[p];
    if (!next || typeof next !== "object" || Array.isArray(next)) cur[p] = {};
    cur = cur[p] as TomlTable;
  }
  cur[path[path.length - 1]!] = v;
}

function tableAt(t: TomlTable, path: string[]): TomlTable {
  safeKeys(path);
  let cur = t;
  for (const p of path) {
    const next = cur[p];
    if (!next || typeof next !== "object" || Array.isArray(next)) cur[p] = {};
    cur = cur[p] as TomlTable;
  }
  return cur;
}

/** Parse what it can; a line it can't read is skipped (with whatever it started). */
export function parseToml(text: string): TomlTable {
  const root: TomlTable = {};
  let table = root;
  const r = new Reader(text.replace(/\r\n/g, "\n"));
  while (r.i < r.s.length) {
    r.ws(true);
    if (r.i >= r.s.length) break;
    const start = r.i;
    try {
      if (r.s[r.i] === "[") {
        const arr = r.s[r.i + 1] === "[";
        r.i += arr ? 2 : 1;
        const path = r.key();
        if (r.s.slice(r.i, r.i + (arr ? 2 : 1)) !== (arr ? "]]" : "]")) throw new Error("bad header");
        r.i += arr ? 2 : 1;
        if (arr) {
          const parent = tableAt(root, path.slice(0, -1));
          const last = path[path.length - 1]!;
          const list = Array.isArray(parent[last]) ? (parent[last] as TomlValue[]) : [];
          const t: TomlTable = {};
          list.push(t);
          parent[last] = list;
          table = t;
        } else table = tableAt(root, path);
      } else {
        const k = r.key();
        if (r.s[r.i] !== "=") throw new Error("no =");
        r.i++;
        setPath(table, k, r.value());
      }
      r.ws();
      if (r.s[r.i] === "#") while (r.i < r.s.length && r.s[r.i] !== "\n") r.i++;
      if (r.i < r.s.length && r.s[r.i] !== "\n") throw new Error("trailing");
    } catch {
      r.i = Math.max(r.i, start + 1);
      while (r.i < r.s.length && r.s[r.i] !== "\n") r.i++;
    }
  }
  return root;
}

const BARE = /^[A-Za-z0-9_-]+$/;
export const tomlKey = (k: string) => (BARE.test(k) ? k : JSON.stringify(k));

export function tomlValue(v: TomlValue): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(", ")}]`;
  return `{ ${Object.entries(v).map(([k, x]) => `${tomlKey(k)} = ${tomlValue(x)}`).join(", ")} }`;
}

/** `[mcp_servers.<name>]` and its keys, sub-tables inline. */
export function mcpServerToml(name: string, t: TomlTable): string {
  const lines = [`[mcp_servers.${tomlKey(name)}]`];
  for (const [k, v] of Object.entries(t)) lines.push(`${tomlKey(k)} = ${tomlValue(v)}`);
  return lines.join("\n") + "\n";
}

/** Does this config.toml text already define that server? */
export function hasMcpServer(text: string, name: string): boolean {
  const t = parseToml(text);
  const s = t.mcp_servers;
  return !!s && typeof s === "object" && !Array.isArray(s) && Object.hasOwn(s, name);
}
