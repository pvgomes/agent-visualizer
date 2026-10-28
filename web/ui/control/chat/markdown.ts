/*
 * A small, safe Markdown renderer for assistant replies. The text is the
 * agent's (and so, indirectly, anyone's who can put words in front of it), so
 * it is parsed into a tiny tree and built with createElement / createTextNode
 * only: there is no innerHTML anywhere, HTML in the source is shown as the
 * characters it is, and a link becomes an <a> only for an absolute http(s) or
 * mailto URL, opened with rel="noopener noreferrer". Images are never loaded.
 *
 * Covers what agents write: paragraphs (single newlines kept, GitHub-comment
 * style), # headings, - / 1. lists (nested, task items), > quotes, ---,
 * pipe tables, fenced code (an unclosed fence runs to the end, so a reply
 * streams cleanly), `code`, **strong**, *em*, ~~del~~, [links](https://…),
 * <autolinks> and bare URLs, backslash escapes.
 *
 * MarkdownView re-renders only the blocks whose source changed, so a reply
 * streaming in at a few updates a second touches just its last block.
 */

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "br" }
  | { t: "em" | "strong" | "del"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] };

export interface ListItem {
  task?: "open" | "done";
  blocks: Block[];
}

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; level: number; c: Inline[] }
  | { t: "code"; lang: string; v: string; open: boolean }
  | { t: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { t: "quote"; blocks: Block[] }
  | { t: "hr" }
  | { t: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] };

export type Align = "" | "left" | "center" | "right";

/** A top-level block and the source lines it came from (the incremental renderer's key). */
export interface SourcedBlock {
  block: Block;
  src: string;
}

const MAX_DEPTH = 12;
/** How far ahead an emphasis opener looks for its closer. */
const SCAN_MAX = 4000;

/* ------------------------------------------------------------------ links */

/** An absolute http(s) or mailto URL, normalised; anything else (javascript:, data:, relative, odd whitespace) is null. */
export function safeHref(raw: string): string | null {
  const s = String(raw ?? "").trim();
  if (!s || s.length > 2048) return null;
  // whitespace or control characters anywhere: browsers strip some of them, which is how "java\tscript:" sneaks past naive checks
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (c <= 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return null;
  }
  if (!/^(?:https?:\/\/|mailto:)/i.test(s)) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "mailto:") return null;
  if (u.protocol !== "mailto:" && !u.hostname) return null;
  return u.href;
}

/** The fence's info string, reduced to a short safe label ("ts", "c++", "shell"). */
function langOf(info: string): string {
  const w = info.trim().split(/\s+/)[0] ?? "";
  return w.replace(/^\{\.?|\}$/g, "").toLowerCase().replace(/[^a-z0-9+#._-]/g, "").slice(0, 20);
}

/* ----------------------------------------------------------------- blocks */

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const ITEM = /^( *)([-*+•]|\d{1,9}[.)])(?:([ \t]+)(.*)|[ \t]*)$/;
const TABLE_SEP = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

const blank = (l: string) => !l.trim();
const indentOf = (l: string) => l.length - l.replace(/^ +/, "").length;
const detab = (l: string) => (l.includes("\t") ? l.replace(/^\t+/, (m) => "    ".repeat(m.length)) : l);

function startsBlock(line: string, next: string | undefined): boolean {
  if (FENCE.test(line) || HR.test(line) || QUOTE.test(line)) return true;
  if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(line)) return true;
  const m = ITEM.exec(line);
  if (m && m[4] !== undefined && m[4].trim() && m[1]!.length < 4 && (!/^\d/.test(m[2]!) || /^1[.)]$/.test(m[2]!))) return true;
  if (line.includes("|") && next !== undefined && TABLE_SEP.test(next) && next.includes("-")) return true;
  return false;
}

export function parseBlocks(src: string): Block[] {
  return parseSourced(src).map((b) => b.block);
}

/** Blocks with the source each came from, for incremental rendering. */
export function parseSourced(src: string): SourcedBlock[] {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n").map(detab);
  return parseLines(lines, 0);
}

function parseLines(lines: string[], depth: number): SourcedBlock[] {
  const out: SourcedBlock[] = [];
  let i = 0;
  const push = (block: Block, from: number, to: number) => out.push({ block, src: lines.slice(from, to).join("\n") });
  while (i < lines.length) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const from = i;
    // fenced code
    const f = FENCE.exec(line);
    if (f && !(f[1]![0] === "`" && f[2]!.includes("`"))) {
      const fence = f[1]!;
      const pad = indentOf(line);
      const body: string[] = [];
      let open = true;
      i++;
      while (i < lines.length) {
        const l = lines[i]!;
        const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(l);
        if (close && close[1]![0] === fence[0] && close[1]!.length >= fence.length) {
          open = false;
          i++;
          break;
        }
        body.push(pad ? l.replace(new RegExp(`^ {0,${pad}}`), "") : l);
        i++;
      }
      push({ t: "code", lang: langOf(f[2]!), v: body.join("\n"), open }, from, i);
      continue;
    }
    const hd = HEADING.exec(line);
    if (hd) {
      i++;
      push({ t: "h", level: hd[1]!.length, c: parseInline(hd[2] ?? "", depth) }, from, i);
      continue;
    }
    if (HR.test(line)) {
      i++;
      push({ t: "hr" }, from, i);
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && !blank(lines[i]!)) {
        const q = QUOTE.exec(lines[i]!);
        if (q) inner.push(q[1]!);
        else if (inner.length && !startsBlock(lines[i]!, lines[i + 1])) inner.push(lines[i]!); // lazy continuation
        else break;
        i++;
      }
      push({ t: "quote", blocks: depth < MAX_DEPTH ? parseLines(inner, depth + 1).map((b) => b.block) : [{ t: "p", c: [{ t: "text", v: inner.join("\n") }] }] }, from, i);
      continue;
    }
    const it = ITEM.exec(line);
    if (it && it[1]!.length < 4) {
      const r = parseList(lines, i, depth);
      i = r.next;
      push(r.block, from, i);
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!) && lines[i + 1]!.includes("-")) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]!).map((c): Align => {
        const t = c.trim();
        return t.startsWith(":") && t.endsWith(":") ? "center" : t.endsWith(":") ? "right" : t.startsWith(":") ? "left" : "";
      });
      if (head.length === align.length) {
        i += 2;
        const rows: Inline[][][] = [];
        while (i < lines.length && !blank(lines[i]!) && lines[i]!.includes("|") && !startsBlock(lines[i]!, undefined)) {
          const cells = splitRow(lines[i]!);
          rows.push(head.map((_, k) => parseInline(cells[k] ?? "", depth)));
          i++;
        }
        push({ t: "table", align, head: head.map((c) => parseInline(c, depth)), rows }, from, i);
        continue;
      }
    }
    // paragraph
    const para: string[] = [];
    while (i < lines.length && !blank(lines[i]!) && (para.length === 0 || !startsBlock(lines[i]!, lines[i + 1]))) {
      para.push(lines[i]!.replace(/^ {1,3}/, ""));
      i++;
    }
    push({ t: "p", c: parseInline(para.join("\n").replace(/[ \t]+$/, ""), depth) }, from, i);
  }
  return out;
}

function parseList(lines: string[], start: number, depth: number): { block: Block; next: number } {
  const first = ITEM.exec(lines[start]!)!;
  const ordered = /^\d/.test(first[2]!);
  const delim = ordered ? first[2]!.slice(-1) : first[2]!;
  const base = first[1]!.length;
  const items: ListItem[] = [];
  let i = start;
  while (i < lines.length) {
    const m = ITEM.exec(lines[i]!);
    if (!m || m[1]!.length !== base) break;
    const isOrd = /^\d/.test(m[2]!);
    if (isOrd !== ordered || (ordered ? m[2]!.slice(-1) !== delim : m[2] !== delim)) break;
    const gap = m[3] ?? " ";
    const contentCol = base + m[2]!.length + (gap.length > 4 ? 1 : Math.max(1, gap.length));
    const body: string[] = [m[4] ?? ""];
    i++;
    while (i < lines.length) {
      const l = lines[i]!;
      if (blank(l)) {
        // a blank line continues the item only if the next text is indented under it
        let j = i + 1;
        while (j < lines.length && blank(lines[j]!)) j++;
        if (j < lines.length && indentOf(lines[j]!) >= Math.min(contentCol, base + 2)) {
          for (; i < j; i++) body.push("");
          continue;
        }
        break;
      }
      const ind = indentOf(l);
      if (ind >= Math.min(contentCol, base + 2)) {
        body.push(l.slice(Math.min(ind, contentCol)));
        i++;
        continue;
      }
      // lazy continuation of the item's paragraph
      if (ind <= base && (ITEM.test(l) || startsBlock(l, lines[i + 1]))) break;
      if (body.length && !blank(body[body.length - 1]!) && !startsBlock(l, lines[i + 1])) {
        body.push(l.trim());
        i++;
        continue;
      }
      break;
    }
    let task: ListItem["task"];
    const tk = /^\[([ xX])\][ \t]+/.exec(body[0]!);
    if (tk) {
      task = tk[1] === " " ? "open" : "done";
      body[0] = body[0]!.slice(tk[0].length);
    }
    const blocks = depth < MAX_DEPTH ? parseLines(body, depth + 1).map((b) => b.block) : [{ t: "p" as const, c: [{ t: "text" as const, v: body.join("\n") }] }];
    items.push(task ? { task, blocks } : { blocks });
    // a blank line between items: the list goes on only if another item follows
    if (i < lines.length && blank(lines[i]!)) {
      let j = i;
      while (j < lines.length && blank(lines[j]!)) j++;
      const n = j < lines.length ? ITEM.exec(lines[j]!) : null;
      if (n && n[1]!.length === base && /^\d/.test(n[2]!) === ordered) i = j;
      else break;
    }
  }
  return { block: { t: "list", ordered, start: ordered ? Math.min(1e9, parseInt(first[2]!, 10) || 1) : 1, items }, next: i };
}

/** A table row's cells, split on pipes outside `code` and not escaped. */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let tick = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (ch === "`") tick = tick ? 0 : 1;
    if (ch === "|" && !tick) {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/* ---------------------------------------------------------------- inlines */

const PUNCT = /[!-/:-@[-`{-~]/;
const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);
const isWord = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** Where a run of `ch` starting at i ends. */
function runEnd(s: string, i: number, ch: string): number {
  let j = i;
  while (s[j] === ch) j++;
  return j;
}

/** A code span opening at i: [content, end] or null. */
function codeSpan(s: string, i: number): [string, number] | null {
  const n = runEnd(s, i, "`") - i;
  let j = i + n;
  while (j < s.length) {
    const k = s.indexOf("`", j);
    if (k < 0) return null;
    const e = runEnd(s, k, "`");
    if (e - k === n) {
      let v = s.slice(i + n, k).replace(/\n/g, " ");
      if (v.length > 2 && v.startsWith(" ") && v.endsWith(" ") && v.trim()) v = v.slice(1, -1);
      return [v, e];
    }
    j = e;
  }
  return null;
}

/** The ] matching the [ at i, skipping code spans and escapes. */
function closeBracket(s: string, i: number): number {
  let depth = 0;
  for (let j = i; j < s.length && j - i < SCAN_MAX; j++) {
    const ch = s[j];
    if (ch === "\\") {
      j++;
      continue;
    }
    if (ch === "`") {
      const c = codeSpan(s, j);
      if (c) {
        j = c[1] - 1;
        continue;
      }
      j = runEnd(s, j, "`") - 1;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) return j;
  }
  return -1;
}

/** `(dest "title")` at i: [dest, end] or null. */
function linkTail(s: string, i: number): [string, number] | null {
  if (s[i] !== "(") return null;
  let j = i + 1;
  while (s[j] === " ") j++;
  let dest = "";
  if (s[j] === "<") {
    const e = s.indexOf(">", j);
    if (e < 0 || s.slice(j, e).includes("\n")) return null;
    dest = s.slice(j + 1, e);
    j = e + 1;
  } else {
    let depth = 0;
    const st = j;
    for (; j < s.length; j++) {
      const ch = s[j]!;
      if (ch === "\\" && PUNCT.test(s[j + 1] ?? "")) {
        j++;
        continue;
      }
      if (/\s/.test(ch)) break;
      if (ch === "(") depth++;
      else if (ch === ")") {
        if (depth === 0) break;
        depth--;
      }
    }
    dest = s.slice(st, j).replace(/\\([!-/:-@[-`{-~])/g, "$1");
  }
  while (s[j] === " " || s[j] === "\n") j++;
  if (s[j] === '"' || s[j] === "'") {
    const q = s[j]!;
    const e = s.indexOf(q, j + 1);
    if (e < 0) return null;
    j = e + 1;
    while (s[j] === " ") j++;
  }
  if (s[j] !== ")") return null;
  return [dest, j + 1];
}

/** A bare URL starting at i (http(s):// or www.), trailing punctuation left out. */
function bareUrl(s: string, i: number): [string, number] | null {
  const m = /^(?:https?:\/\/|www\.)[^\s<>"'`]+/i.exec(s.slice(i, i + 2048));
  if (!m) return null;
  let u = m[0];
  for (;;) {
    const last = u[u.length - 1]!;
    if (/[.,:;!?*_~]/.test(last)) u = u.slice(0, -1);
    else if (last === ")" && (u.match(/\(/g)?.length ?? 0) < (u.match(/\)/g)?.length ?? 0)) u = u.slice(0, -1);
    else break;
  }
  if (u.length < 8) return null;
  return [u, i + u.length];
}

/** The closer for an emphasis opener of `n` x `ch` whose content starts at `from`, or -1. */
function findCloser(s: string, from: number, ch: string, n: number, first = false): number {
  const limit = Math.min(s.length, from + SCAN_MAX);
  for (let j = from; j < limit; j++) {
    const c = s[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "`") {
      const cs = codeSpan(s, j);
      j = (cs ? cs[1] : runEnd(s, j, "`")) - 1;
      continue;
    }
    if (c === "[") {
      // a link's label is one unit: emphasis doesn't close inside it
      const e = closeBracket(s, j);
      if (e > 0 && s[e + 1] === "(") {
        const t = linkTail(s, e + 1);
        if (t) {
          j = t[1] - 1;
          continue;
        }
      }
      continue;
    }
    if (c !== ch) continue;
    const e = runEnd(s, j, ch);
    const len = e - j;
    const before = s[j - 1];
    const after = s[e];
    const closes = j > from && !isSpace(before) && (ch !== "_" || !isWord(after));
    if (closes) {
      if (n === 1 && len === 1) return j;
      if (n === 1 && len >= 3) return j; // "*a **b***": the em closes on the run's first star
      // "**a *b***" closes on the run's last two; an inner "**b**" inside "*a **b***" on its first two
      if (n === 2 && len >= 2) return first ? j : e - 2;
      if (n === 3 && len >= 3) return e - 3;
    }
    // an inner opener of the same character: skip past its own pair
    if (n === 1 && len === 2 && !isSpace(after)) {
      const inner = findCloser(s, e, ch, 2, true);
      if (inner > 0) {
        j = inner + 1;
        continue;
      }
    }
    j = e - 1;
  }
  return -1;
}

export function parseInline(src: string, depth = 0): Inline[] {
  const s = String(src ?? "");
  const out: Inline[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ t: "text", v: buf });
    buf = "";
  };
  if (depth > MAX_DEPTH) return s ? [{ t: "text", v: s }] : [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === "\\") {
      const nx = s[i + 1];
      if (nx === "\n") {
        flush();
        out.push({ t: "br" });
        i += 2;
        continue;
      }
      if (nx !== undefined && PUNCT.test(nx)) {
        buf += nx;
        i += 2;
        continue;
      }
      buf += ch;
      i++;
      continue;
    }
    if (ch === "\n") {
      flush();
      out.push({ t: "br" });
      i++;
      continue;
    }
    if (ch === "`") {
      const c = codeSpan(s, i);
      if (c) {
        flush();
        out.push({ t: "code", v: c[0] });
        i = c[1];
      } else {
        const e = runEnd(s, i, "`");
        buf += s.slice(i, e);
        i = e;
      }
      continue;
    }
    if (ch === "[" || (ch === "!" && s[i + 1] === "[")) {
      const img = ch === "!";
      const open = img ? i + 1 : i;
      const close = closeBracket(s, open);
      const tail = close > 0 ? linkTail(s, close + 1) : null;
      if (tail) {
        flush();
        const label = s.slice(open + 1, close);
        const href = safeHref(tail[0]);
        // an image is never loaded: it becomes a link to itself, labelled by its alt text
        const kids = img ? [{ t: "text" as const, v: label || "image" }] : parseInline(label, depth + 1);
        if (href) out.push({ t: "link", href, c: kids.length ? kids : [{ t: "text", v: href }] });
        else out.push(...kids);
        i = tail[1];
        continue;
      }
      buf += ch;
      i++;
      continue;
    }
    if (ch === "<") {
      const m = /^<((?:https?:\/\/|mailto:)[^\s<>]*)>/i.exec(s.slice(i, i + 2100));
      const href = m ? safeHref(m[1]!) : null;
      if (m && href) {
        flush();
        out.push({ t: "link", href, c: [{ t: "text", v: m[1]! }] });
        i += m[0].length;
        continue;
      }
      buf += ch;
      i++;
      continue;
    }
    if ((ch === "h" || ch === "H" || ch === "w" || ch === "W") && !isWord(s[i - 1]) && s[i - 1] !== "/") {
      const u = bareUrl(s, i);
      if (u) {
        const href = safeHref(/^www\./i.test(u[0]) ? `https://${u[0]}` : u[0]);
        if (href) {
          flush();
          out.push({ t: "link", href, c: [{ t: "text", v: u[0] }] });
          i = u[1];
          continue;
        }
      }
    }
    if (ch === "~") {
      const e = runEnd(s, i, "~");
      if (e - i === 2 && !isSpace(s[e])) {
        const close = s.indexOf("~~", e);
        if (close > e && close - e < SCAN_MAX && !isSpace(s[close - 1]) && s[close + 2] !== "~") {
          flush();
          out.push({ t: "del", c: parseInline(s.slice(e, close), depth + 1) });
          i = close + 2;
          continue;
        }
      }
      buf += s.slice(i, e);
      i = e;
      continue;
    }
    if (ch === "*" || ch === "_") {
      const e = runEnd(s, i, ch);
      const len = e - i;
      const opens = !isSpace(s[e]) && (ch !== "_" || !isWord(s[i - 1]));
      if (opens) {
        for (const n of len >= 3 ? [3, 2, 1] : len === 2 ? [2, 1] : [1]) {
          const from = i + n;
          const close = findCloser(s, from, ch, n);
          if (close > from) {
            flush();
            // any extra opener characters stay literal before it
            const inner = parseInline(s.slice(from, close), depth + 1);
            const node: Inline = n === 1 ? { t: "em", c: inner } : n === 2 ? { t: "strong", c: inner } : { t: "strong", c: [{ t: "em", c: inner }] };
            out.push(node);
            i = close + n;
            break;
          }
          if (n === 1) {
            buf += s.slice(i, e);
            i = e;
          }
        }
        continue;
      }
      buf += s.slice(i, e);
      i = e;
      continue;
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

/* -------------------------------------------------------------------- DOM */

/** The few document methods the builder uses, so tests can pass a fake one. */
export interface DocLike {
  createElement(tag: string): any;
  createTextNode(text: string): any;
}

const ALLOWED_TAGS = new Set(["p", "h3", "h4", "h5", "h6", "div", "span", "pre", "code", "button", "ul", "ol", "li", "blockquote", "hr", "table", "thead", "tbody", "tr", "th", "td", "a", "strong", "em", "del", "br"]);

function el(doc: DocLike, tag: string, cls?: string): any {
  // a guard against this file ever growing an unsafe element by mistake
  if (!ALLOWED_TAGS.has(tag)) throw new Error(`markdown: <${tag}> is not allowed`);
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function inlines(doc: DocLike, parent: any, nodes: Inline[]): void {
  for (const n of nodes) {
    switch (n.t) {
      case "text":
        parent.appendChild(doc.createTextNode(n.v));
        break;
      case "br":
        parent.appendChild(el(doc, "br"));
        break;
      case "code": {
        const c = el(doc, "code", "md-ic");
        c.appendChild(doc.createTextNode(n.v));
        parent.appendChild(c);
        break;
      }
      case "em":
      case "strong":
      case "del": {
        const e = el(doc, n.t);
        inlines(doc, e, n.c);
        parent.appendChild(e);
        break;
      }
      case "link": {
        const href = safeHref(n.href);
        if (!href) {
          inlines(doc, parent, n.c);
          break;
        }
        const a = el(doc, "a", "md-a");
        a.setAttribute("href", href);
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener noreferrer");
        a.setAttribute("title", href);
        inlines(doc, a, n.c);
        parent.appendChild(a);
        break;
      }
    }
  }
}

export interface BuildOpts {
  /** A code block's Copy button was pressed. */
  onCopy?(text: string, button: any): void;
}

const LANG_NAME: Record<string, string> = { ts: "typescript", js: "javascript", sh: "shell", zsh: "shell", bash: "shell", py: "python", rb: "ruby", rs: "rust", yml: "yaml", md: "markdown" };

export function buildBlock(doc: DocLike, b: Block, opts: BuildOpts = {}): any {
  switch (b.t) {
    case "p": {
      const p = el(doc, "p", "md-p");
      inlines(doc, p, b.c);
      return p;
    }
    case "h": {
      const tag = b.level <= 1 ? "h3" : b.level === 2 ? "h4" : b.level === 3 ? "h5" : "h6";
      const h = el(doc, tag, `md-h md-h${b.level}`);
      inlines(doc, h, b.c);
      return h;
    }
    case "hr":
      return el(doc, "hr", "md-hr");
    case "quote": {
      const q = el(doc, "blockquote", "md-quote");
      for (const x of b.blocks) q.appendChild(buildBlock(doc, x, opts));
      return q;
    }
    case "list": {
      const l = el(doc, b.ordered ? "ol" : "ul", `md-list${b.items.some((x) => x.task) ? " md-tasks" : ""}`);
      if (b.ordered && b.start !== 1) l.setAttribute("start", String(b.start));
      for (const item of b.items) {
        const li = el(doc, "li", item.task ? `md-task is-${item.task}` : undefined);
        if (item.task) {
          const box = el(doc, "span", "md-check");
          box.setAttribute("aria-hidden", "true");
          box.appendChild(doc.createTextNode(item.task === "done" ? "✓" : ""));
          li.appendChild(box);
        }
        for (const x of item.blocks) li.appendChild(buildBlock(doc, x, opts));
        l.appendChild(li);
      }
      return l;
    }
    case "table": {
      const wrap = el(doc, "div", "md-table");
      const t = el(doc, "table");
      const thead = el(doc, "thead");
      const hr = el(doc, "tr");
      b.head.forEach((c, k) => {
        const th = el(doc, "th", b.align[k] ? `al-${b.align[k]}` : undefined);
        inlines(doc, th, c);
        hr.appendChild(th);
      });
      thead.appendChild(hr);
      t.appendChild(thead);
      const tbody = el(doc, "tbody");
      for (const row of b.rows) {
        const tr = el(doc, "tr");
        row.forEach((c, k) => {
          const td = el(doc, "td", b.align[k] ? `al-${b.align[k]}` : undefined);
          inlines(doc, td, c);
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      }
      t.appendChild(tbody);
      wrap.appendChild(t);
      return wrap;
    }
    case "code": {
      const box = el(doc, "div", `md-code${b.open ? " is-open" : ""}`);
      const head = el(doc, "div", "md-code-head");
      const lang = el(doc, "span", "md-lang");
      lang.appendChild(doc.createTextNode(b.lang ? LANG_NAME[b.lang] ?? b.lang : "code"));
      const copy = el(doc, "button", "md-copy");
      copy.setAttribute("type", "button");
      copy.setAttribute("aria-label", `Copy ${b.lang || "code"}`);
      copy.appendChild(doc.createTextNode("Copy"));
      if (typeof copy.addEventListener === "function") copy.addEventListener("click", () => opts.onCopy?.(b.v, copy));
      head.appendChild(lang);
      head.appendChild(copy);
      const pre = el(doc, "pre", "md-pre");
      pre.setAttribute("tabindex", "0");
      const code = el(doc, "code");
      if (b.lang === "diff" || b.lang === "patch") {
        const ls = b.v.split("\n");
        ls.forEach((ln, k) => {
          const cls = /^(\+\+\+|---)/.test(ln) ? "md-dl md-dfile" : ln.startsWith("+") ? "md-dl md-add" : ln.startsWith("-") ? "md-dl md-del" : ln.startsWith("@@") ? "md-dl md-hunk" : "md-dl";
          const span = el(doc, "span", cls);
          span.appendChild(doc.createTextNode(ln + (k < ls.length - 1 ? "\n" : "")));
          code.appendChild(span);
        });
      } else code.appendChild(doc.createTextNode(b.v));
      pre.appendChild(code);
      box.appendChild(head);
      box.appendChild(pre);
      return box;
    }
  }
}

/** Render a whole document into `parent` (no incremental state). */
export function renderMarkdown(doc: DocLike, parent: any, src: string, opts: BuildOpts = {}): void {
  for (const b of parseBlocks(src)) parent.appendChild(buildBlock(doc, b, opts));
}

/** The innermost element a streaming cursor should follow. */
function cursorHost(node: any): any {
  let n = node;
  for (let k = 0; k < 8 && n; k++) {
    const cls = String(n.className ?? "");
    if (cls.includes("md-code")) return n.querySelector?.("code") ?? n;
    if (cls.includes("md-table") || n.tagName === "HR") return null;
    const tag = String(n.tagName ?? "").toLowerCase();
    if (tag === "ul" || tag === "ol" || tag === "li" || tag === "blockquote") {
      const last = n.lastElementChild;
      if (!last) return n;
      if (String(last.className ?? "").includes("md-check")) return n;
      n = last;
      continue;
    }
    return n;
  }
  return n;
}

/**
 * A rendered reply that can be updated as it streams: blocks whose source is
 * unchanged keep their nodes (and the reader's selection), the rest are
 * rebuilt. With `streaming`, a blinking cursor follows the last character.
 */
export class MarkdownView {
  readonly el: HTMLElement;
  private parts: { src: string; node: HTMLElement }[] = [];
  private text = "";
  private cursor: HTMLElement | null = null;

  constructor(
    private readonly doc: Document,
    private readonly opts: BuildOpts = {},
    cls = "md",
  ) {
    this.el = doc.createElement("div");
    this.el.className = cls;
  }

  set(text: string, streaming = false): void {
    if (text !== this.text) {
      this.text = text;
      const next = parseSourced(text);
      let same = 0;
      while (same < next.length && same < this.parts.length && next[same]!.src === this.parts[same]!.src) same++;
      for (const p of this.parts.splice(same)) p.node.remove();
      for (const b of next.slice(same)) {
        const node = buildBlock(this.doc, b.block, this.opts) as HTMLElement;
        this.el.append(node);
        this.parts.push({ src: b.src, node });
      }
    }
    this.cursor?.remove();
    this.cursor = null;
    if (streaming) {
      const c = this.doc.createElement("span");
      c.className = "md-cursor";
      c.setAttribute("aria-hidden", "true");
      const last = this.parts[this.parts.length - 1]?.node;
      const host = last ? cursorHost(last) : null;
      (host ?? this.el).append(c);
      this.cursor = c;
    }
  }

  get value(): string {
    return this.text;
  }
}
