/*
 * Surgical edits to JSON and JSONC config files. Agents' configs are hand-
 * edited by their owners, so re-serializing them would throw away comments,
 * key order, odd spacing and trailing commas. Instead this parses the text
 * into spans and splices: setting a key rewrites only that value (or inserts
 * one member before the closing brace, in the file's own indentation), and
 * removing one cuts only its lines. Everything else stays byte-for-byte.
 */

export class JsoncError extends Error {
  constructor(message: string, readonly offset: number, readonly line: number) {
    super(`${message} at line ${line}`);
  }
}

interface Base {
  start: number;
  end: number;
}
export interface ObjectNode extends Base {
  type: "object";
  members: Member[];
}
export interface ArrayNode extends Base {
  type: "array";
  items: JsonNode[];
}
export interface ScalarNode extends Base {
  type: "string" | "number" | "boolean" | "null";
  value: string | number | boolean | null;
}
export type JsonNode = ObjectNode | ArrayNode | ScalarNode;
export interface Member {
  key: string;
  keyStart: number;
  value: JsonNode;
}

/** Parse JSON with // and /* comments and trailing commas. Throws JsoncError. */
export function parseJsonc(text: string): JsonNode {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const lineAt = (pos: number) => text.slice(0, pos).split("\n").length;
  const err = (msg: string, pos = i): never => {
    throw new JsoncError(msg, pos, lineAt(pos));
  };

  const skip = () => {
    for (;;) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") i++;
      else if (c === "/" && text[i + 1] === "/") {
        while (i < text.length && text[i] !== "\n") i++;
      } else if (c === "/" && text[i + 1] === "*") {
        const close = text.indexOf("*/", i + 2);
        if (close === -1) err("unterminated comment");
        i = close + 2;
      } else return;
    }
  };

  const str = (): ScalarNode => {
    const start = i++;
    let out = "";
    for (;;) {
      if (i >= text.length) err("unterminated string", start);
      const c = text[i]!;
      if (c === '"') break;
      if (c === "\n") err("newline in string");
      if (c === "\\") {
        const e = text[i + 1];
        const map: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        if (e && map[e] !== undefined) {
          out += map[e];
          i += 2;
        } else if (e === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
          out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
          i += 6;
        } else err("bad escape");
      } else {
        out += c;
        i++;
      }
    }
    i++;
    return { type: "string", start, end: i, value: out };
  };

  const value = (depth: number): JsonNode => {
    if (depth > 200) err("nested too deeply");
    skip();
    const start = i;
    const c = text[i];
    if (c === "{") {
      i++;
      const members: Member[] = [];
      for (;;) {
        skip();
        if (text[i] === "}") break;
        if (text[i] !== '"') err("expected a key");
        const key = str();
        skip();
        if (text[i] !== ":") err('expected ":"');
        i++;
        const v = value(depth + 1);
        members.push({ key: key.value as string, keyStart: key.start, value: v });
        skip();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") break;
        err('expected "," or "}"');
      }
      i++;
      return { type: "object", start, end: i, members };
    }
    if (c === "[") {
      i++;
      const items: JsonNode[] = [];
      for (;;) {
        skip();
        if (text[i] === "]") break;
        items.push(value(depth + 1));
        skip();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") break;
        err('expected "," or "]"');
      }
      i++;
      return { type: "array", start, end: i, items };
    }
    if (c === '"') return str();
    const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 400));
    if (!m) return err(i >= text.length ? "unexpected end of file" : `unexpected "${text[i]}"`);
    i += m[0].length;
    const t = m[0];
    if (t === "true" || t === "false") return { type: "boolean", start, end: i, value: t === "true" };
    if (t === "null") return { type: "null", start, end: i, value: null };
    return { type: "number", start, end: i, value: Number(t) };
  };

  const root = value(0);
  skip();
  if (i < text.length) err("unexpected content after the end");
  return root;
}

export function toValue(n: JsonNode): unknown {
  if (n.type === "object") return Object.fromEntries(n.members.map((m) => [m.key, toValue(m.value)]));
  if (n.type === "array") return n.items.map(toValue);
  return n.value;
}

/** Read a JSONC document as a plain value. Throws JsoncError. */
export function readJsonc(text: string): unknown {
  return toValue(parseJsonc(text));
}

function memberOf(obj: ObjectNode, key: string): Member | undefined {
  // Last one wins, as in JSON.parse.
  for (let k = obj.members.length - 1; k >= 0; k--) if (obj.members[k]!.key === key) return obj.members[k];
  return undefined;
}

/** The node at `path`, or undefined. */
export function nodeAt(root: JsonNode, path: string[]): JsonNode | undefined {
  let cur: JsonNode | undefined = root;
  for (const seg of path) {
    if (!cur || cur.type !== "object") return undefined;
    cur = memberOf(cur, seg)?.value;
  }
  return cur;
}

/** The file's indent unit: the first indented line's leading whitespace, else two spaces. */
export function detectIndent(text: string): string {
  const m = /\n([ \t]+)\S/.exec(text);
  if (!m) return "  ";
  const ws = m[1]!;
  return ws.startsWith("\t") ? "\t" : ws.length >= 2 && ws.length <= 8 ? ws : "  ";
}

function lineStart(text: string, pos: number): number {
  return text.lastIndexOf("\n", pos - 1) + 1;
}

/** Leading whitespace of the line holding `pos`. */
function indentOf(text: string, pos: number): string {
  const s = lineStart(text, pos);
  return /^[ \t]*/.exec(text.slice(s))![0];
}

function onlyWsBefore(text: string, pos: number): boolean {
  return /^[ \t]*$/.test(text.slice(lineStart(text, pos), pos));
}

/** JSON.stringify, then shifted so nested lines sit under `indent`. */
function render(value: unknown, unit: string, indent: string): string {
  return JSON.stringify(value, null, unit).replace(/\n/g, "\n" + indent);
}

interface Splice {
  start: number;
  end: number;
  insert: string;
}

function apply(text: string, splices: Splice[]): string {
  let out = text;
  for (const s of [...splices].sort((a, b) => b.start - a.start)) out = out.slice(0, s.start) + s.insert + out.slice(s.end);
  return out;
}

/** End of the meaningful content before `pos` (skips back over whitespace only). */
function trimBack(text: string, pos: number): number {
  let p = pos;
  while (p > 0 && /\s/.test(text[p - 1]!)) p--;
  return p;
}

/** Is there a comma between `from` and the object's closing brace, ignoring whitespace and comments? */
function hasTrailingComma(text: string, from: number, close: number): number {
  let i = from;
  while (i < close) {
    const c = text[i];
    if (c === ",") return i;
    if (c === "/" && text[i + 1] === "/") {
      while (i < close && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 2;
    } else i++;
  }
  return -1;
}

/** Insert `"key": value` as the last member of `obj`. */
function insertMember(text: string, obj: ObjectNode, key: string, value: unknown, unit: string): Splice[] {
  const close = obj.end - 1;
  const objIndent = indentOf(text, obj.start);
  const last = obj.members[obj.members.length - 1];
  const memberIndent = last && onlyWsBefore(text, last.keyStart) ? indentOf(text, last.keyStart) : objIndent + unit;
  const body = `${JSON.stringify(key)}: ${render(value, unit, memberIndent)}`;
  if (!last) {
    return [{ start: obj.start + 1, end: close, insert: `\n${memberIndent}${body}\n${objIndent}` }];
  }
  const comma = hasTrailingComma(text, last.value.end, close);
  const pretty = onlyWsBefore(text, last.keyStart);
  // Pretty-printed: a new line after whatever ends the last member (a comment, say), keeping
  // a trailing-comma style if the file has one. All on one line: stay on one line.
  const piece = pretty ? `\n${memberIndent}${body}${comma !== -1 ? "," : ""}` : ` ${JSON.stringify(key)}: ${JSON.stringify(value)}`;
  const at = trimBack(text, close);
  if (comma !== -1) return [{ start: at, end: at, insert: piece }];
  if (at === last.value.end) return [{ start: at, end: at, insert: "," + piece }];
  return [
    { start: last.value.end, end: last.value.end, insert: "," },
    { start: at, end: at, insert: piece },
  ];
}

/** Nest `value` under the remaining path segments: (["a","b"], v) -> { a: { b: v } }. */
function wrap(path: string[], value: unknown): unknown {
  return path.reduceRight<unknown>((v, k) => ({ [k]: v }), value);
}

/**
 * Set `path` to `value`, creating parent objects as needed. Returns the new
 * text. An empty or whitespace-only document becomes a new object.
 * Throws JsoncError if the text doesn't parse, or if a parent on the path
 * exists but isn't an object.
 */
export function setPath(text: string, path: string[], value: unknown): string {
  const unit = detectIndent(text);
  if (!text.trim()) return render(wrap(path, value), "  ", "") + "\n";
  const root = parseJsonc(text);
  if (root.type !== "object") throw new JsoncError("the top level is not an object", root.start, 1);
  let obj: ObjectNode = root;
  for (let k = 0; k < path.length; k++) {
    const seg = path[k]!;
    const m = memberOf(obj, seg);
    if (!m) return apply(text, insertMember(text, obj, seg, wrap(path.slice(k + 1), value), unit));
    if (k === path.length - 1) {
      const indent = onlyWsBefore(text, m.keyStart) ? indentOf(text, m.keyStart) : "";
      const rendered = indent || text.slice(obj.start, obj.end).includes("\n") ? render(value, unit, indent) : JSON.stringify(value);
      return apply(text, [{ start: m.value.start, end: m.value.end, insert: rendered }]);
    }
    if (m.value.type !== "object") {
      throw new JsoncError(`"${path.slice(0, k + 1).join(".")}" is not an object`, m.value.start, text.slice(0, m.value.start).split("\n").length);
    }
    obj = m.value;
  }
  return text;
}

/** Remove the member at `path` (and only it). Returns the text unchanged if it isn't there. */
export function deletePath(text: string, path: string[]): string {
  if (!path.length || !text.trim()) return text;
  const root = parseJsonc(text);
  const parent = nodeAt(root, path.slice(0, -1));
  if (!parent || parent.type !== "object") return text;
  const key = path[path.length - 1]!;
  const idx = parent.members.findIndex((m, k) => m.key === key && !parent.members.slice(k + 1).some((x) => x.key === key));
  if (idx === -1) return text;
  const m = parent.members[idx]!;
  const next = parent.members[idx + 1];
  const prev = parent.members[idx - 1];
  const close = parent.end - 1;
  if (next) {
    const pretty = onlyWsBefore(text, m.keyStart) && onlyWsBefore(text, next.keyStart);
    const from = pretty ? lineStart(text, m.keyStart) : m.keyStart;
    const to = pretty ? lineStart(text, next.keyStart) : next.keyStart;
    return apply(text, [{ start: from, end: to, insert: "" }]);
  }
  if (prev) {
    const trailing = hasTrailingComma(text, m.value.end, close);
    const between = hasTrailingComma(text, prev.value.end, m.keyStart); // the comma after prev
    if (onlyWsBefore(text, m.keyStart)) {
      // Pretty-printed: drop our lines (with our trailing comma, if the file uses them), and the
      // comma after prev only when that comma would now be a trailing one the file doesn't use.
      // Comments on prev's line stay where they are.
      const endPos = trailing === -1 ? m.value.end : trailing + 1;
      const eol = text.indexOf("\n", endPos);
      const restOfLine = eol === -1 ? text.slice(endPos) : text.slice(endPos, eol);
      const to = /^[ \t]*$/.test(restOfLine) && eol !== -1 ? eol + 1 : endPos;
      const splices: Splice[] = [{ start: lineStart(text, m.keyStart), end: to, insert: "" }];
      if (trailing === -1 && between !== -1) splices.push({ start: between, end: between + 1, insert: "" });
      return apply(text, splices);
    }
    // All on one line: cut from the end of the previous value, which takes the comma between them.
    // A trailing comma after the removed member (JSONC style) is kept for the new last member.
    const end = trailing === -1 ? m.value.end : trailing;
    return apply(text, [{ start: prev.value.end, end, insert: "" }]);
  }
  // Only member: leave an empty object.
  return apply(text, [{ start: parent.start + 1, end: close, insert: "" }]);
}

/** True when `path` holds an object with no members. */
export function isEmptyObject(text: string, path: string[]): boolean {
  try {
    const n = path.length ? nodeAt(parseJsonc(text), path) : parseJsonc(text);
    return !!n && n.type === "object" && n.members.length === 0;
  } catch {
    return false;
  }
}
