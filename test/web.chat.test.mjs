// Tests for the chat view's DOM-free parts: the safe Markdown renderer
// (web/ui/control/chat/markdown.ts), checked against a fake document so every
// element and attribute it can produce is held to an allowlist, and the
// conversation model (web/ui/control/chat/model.ts) that folds ChatItems into turns.
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

async function load(...entries) {
  const dir = mkdtempSync(join(tmpdir(), "agent-visualizer-chat-test-"));
  const outfile = join(dir, "mod.mjs");
  await build({
    stdin: { contents: entries.map((e) => `export * from ${JSON.stringify(`./${e}`)};`).join("\n"), resolveDir: ROOT, loader: "ts" },
    bundle: true, platform: "node", format: "esm", target: "node18", outfile, logLevel: "error",
    loader: { ".svg": "text", ".css": "text" },
  });
  try {
    return await import(pathToFileURL(outfile).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const M = await load("web/ui/control/chat/markdown.ts", "web/ui/control/chat/model.ts");
const { renderMarkdown, safeHref, parseInline, ChatModel, approvalState, isTestRun, dur, compact } = M;

/* ------------------------------------------------------------ fake DOM */

class FakeText {
  constructor(text) {
    this.nodeType = 3;
    this.text = String(text);
  }
}
class FakeEl {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attrs = {};
    this.className = "";
    this.listeners = [];
  }
  appendChild(n) {
    this.children.push(n);
    return n;
  }
  append(...ns) {
    for (const n of ns) this.appendChild(typeof n === "string" ? new FakeText(n) : n);
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  addEventListener(type, fn) {
    this.listeners.push(type);
  }
}
const doc = { createElement: (t) => new FakeEl(t), createTextNode: (t) => new FakeText(t) };

function render(src) {
  const root = new FakeEl("div");
  renderMarkdown(doc, root, src);
  return root;
}
function* walk(n) {
  yield n;
  for (const c of n.children ?? []) yield* walk(c);
}
const text = (n) => [...walk(n)].filter((x) => x.nodeType === 3).map((x) => x.text).join("");
const elements = (root) => [...walk(root)].filter((x) => x.nodeType === 1 && x !== root);

const TAGS = new Set(["P", "H3", "H4", "H5", "H6", "DIV", "SPAN", "PRE", "CODE", "BUTTON", "UL", "OL", "LI", "BLOCKQUOTE", "HR", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD", "A", "STRONG", "EM", "DEL", "BR"]);
const ATTRS = new Set(["href", "target", "rel", "title", "type", "aria-label", "aria-hidden", "tabindex", "start"]);

/** Whatever the input, only known elements and attributes come out, and links are safe. */
function assertSafe(root, src) {
  for (const el of elements(root)) {
    assert.ok(TAGS.has(el.tagName), `<${el.tagName}> from ${JSON.stringify(src).slice(0, 80)}`);
    for (const [k, v] of Object.entries(el.attrs)) {
      assert.ok(ATTRS.has(k), `attribute ${k} on <${el.tagName}> from ${JSON.stringify(src).slice(0, 80)}`);
      assert.ok(!/^on/i.test(k));
      if (k === "href") assert.match(v, /^(https?:\/\/|mailto:)/i, `href ${v}`);
    }
    if (el.tagName === "A") {
      assert.equal(el.attrs.rel, "noopener noreferrer");
      assert.equal(el.attrs.target, "_blank");
      assert.ok(el.attrs.href, "every link has a vetted href");
    }
    assert.ok(!/^on/i.test(el.className));
  }
}

/* -------------------------------------------------------- the escaping */

test("markdown: a script tag is text, never an element", () => {
  const src = "Before <script>alert(document.cookie)</script> after\n\n<script src=https://evil.example/x.js></script>";
  const root = render(src);
  assertSafe(root, src);
  assert.ok(!elements(root).some((e) => e.tagName === "SCRIPT"));
  assert.match(text(root), /<script>alert\(document\.cookie\)<\/script>/);
  assert.match(text(root), /<script src=https:\/\/evil\.example\/x\.js><\/script>/);
});

test("markdown: raw HTML and its attributes stay text", () => {
  const cases = [
    '<img src=x onerror="alert(1)">',
    '<a href="https://ok.example" onclick="alert(1)">click</a>',
    '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    '<div style="position:fixed;inset:0" onmouseover=alert(1)>hover</div>',
    '<svg><animate onbegin=alert(1) attributeName=x dur=1s>',
    "<details open ontoggle=alert(1)>",
    '"><b>x</b>',
  ];
  for (const src of cases) {
    const root = render(src);
    assertSafe(root, src);
    // a paragraph, and at most a bare https URL turned into a vetted link
    assert.ok(!elements(root).some((e) => !["P", "A"].includes(e.tagName)), `only a paragraph for ${src}`);
    for (const a of elements(root).filter((e) => e.tagName === "A")) assert.equal(a.attrs.href, "https://ok.example/");
    assert.equal(text(root), src, "the characters come through exactly");
  }
});

test("markdown: javascript:, data: and other schemes never become links", () => {
  const cases = [
    "[click](javascript:alert(1))",
    "[click](JaVaScRiPt:alert(1))",
    "[click](javascript&colon;alert(1))",
    "[click](  javascript:alert(1))",
    "[click](java\tscript:alert(1))",
    "[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
    "[click](vbscript:msgbox(1))",
    "[click](file:///etc/passwd)",
    "[click](//evil.example/x)",
    "[click](/relative/path)",
    "[click](#top)",
    "<javascript:alert(1)>",
    "![x](javascript:alert(1))",
    "[click](https://ok.example\"onmouseover=\"alert(1))",
  ];
  for (const src of cases) {
    const root = render(src);
    assertSafe(root, src);
    const links = elements(root).filter((e) => e.tagName === "A");
    for (const a of links) assert.match(a.attrs.href, /^https:\/\/ok\.example/, src);
    if (!src.includes("ok.example")) assert.equal(links.length, 0, src);
  }
});

test("markdown: safe links get rel=noopener noreferrer and open in a new tab", () => {
  const src = "See [the docs](https://docs.example.com/a_(b)?q=1 \"Docs\"), <https://x.example>, mailto: [me](mailto:me@example.com) and https://bare.example/path.";
  const root = render(src);
  assertSafe(root, src);
  const links = elements(root).filter((e) => e.tagName === "A");
  assert.deepEqual(
    links.map((a) => a.attrs.href),
    ["https://docs.example.com/a_(b)?q=1", "https://x.example/", "mailto:me@example.com", "https://bare.example/path"],
  );
  assert.equal(text(links[0]), "the docs");
  assert.ok(text(root).endsWith("path."), "trailing punctuation stays outside the link");
});

test("markdown: safeHref allows only absolute http(s) and mailto", () => {
  assert.equal(safeHref("https://a.example/x"), "https://a.example/x");
  assert.equal(safeHref("HTTP://A.example"), "http://a.example/");
  assert.equal(safeHref("mailto:a@b.c"), "mailto:a@b.c");
  for (const bad of ["javascript:alert(1)", " javascript:alert(1)", "java\nscript:alert(1)", "https://a b.example", "https://", "data:,x", "blob:https://a.example/x", "/x", "x", "", "https:\\\\evil.example", "\u0000https://a.example"]) {
    assert.equal(safeHref(bad), null, JSON.stringify(bad));
  }
});

test("markdown: code keeps HTML as text, with a language label and a copy button", () => {
  const src = "```html\n<script>alert(1)</script>\n<b onclick=x>hi</b>\n```\n\nand `<img src=x onerror=alert(1)>` inline";
  const root = render(src);
  assertSafe(root, src);
  const pre = elements(root).find((e) => e.tagName === "PRE");
  assert.match(text(pre), /<script>alert\(1\)<\/script>\n<b onclick=x>hi<\/b>/);
  const button = elements(root).find((e) => e.tagName === "BUTTON");
  assert.equal(text(button), "Copy");
  assert.deepEqual(button.listeners, ["click"]);
  assert.ok(elements(root).some((e) => e.className.includes("md-lang") && text(e) === "html"));
  assert.ok(elements(root).some((e) => e.tagName === "CODE" && text(e) === "<img src=x onerror=alert(1)>"));
});

test("markdown: the blocks agents write", () => {
  const src = "## Plan\n\n1. read\n2. **edit** `a.ts`\n   - nested *item*\n- [x] done\n- [ ] todo\n\n> quoted\n\n| a | b |\n|---|--:|\n| 1 | 2 |\n\n---\n\n~~old~~ new";
  const root = render(src);
  assertSafe(root, src);
  const tags = elements(root).map((e) => e.tagName);
  for (const t of ["H4", "OL", "UL", "LI", "STRONG", "CODE", "EM", "BLOCKQUOTE", "TABLE", "TH", "TD", "HR", "DEL"]) assert.ok(tags.includes(t), t);
  assert.ok(elements(root).some((e) => e.className.includes("md-task is-done")));
  assert.ok(elements(root).some((e) => e.tagName === "TD" && e.className === "al-right"));
});

test("markdown: an unclosed fence streams as code to the end", () => {
  const root = render("Here:\n\n```ts\nconst a = 1;\nconst b =");
  const pre = elements(root).find((e) => e.tagName === "PRE");
  assert.equal(text(pre), "const a = 1;\nconst b =");
  assert.ok(elements(root).some((e) => e.className.includes("md-code is-open")));
});

test("markdown: emphasis nests and leaves snake_case and lone stars alone", () => {
  const kinds = (s) => JSON.stringify(parseInline(s));
  assert.equal(kinds("*a **b***"), '[{"t":"em","c":[{"t":"text","v":"a "},{"t":"strong","c":[{"t":"text","v":"b"}]}]}]');
  assert.equal(kinds("**a *b***"), '[{"t":"strong","c":[{"t":"text","v":"a "},{"t":"em","c":[{"t":"text","v":"b"}]}]}]');
  assert.equal(kinds("snake_case_name"), '[{"t":"text","v":"snake_case_name"}]');
  assert.equal(kinds("2 * 3 * 4"), '[{"t":"text","v":"2 * 3 * 4"}]');
  assert.equal(kinds("\\*literal\\*"), '[{"t":"text","v":"*literal*"}]');
});

test("markdown: random and hostile input never throws, stays safe and stays fast", () => {
  const parts = ["*", "**", "_", "`", "```", "[", "]", "(", ")", "<", ">", "!", "~~", "|", "\n", "\n\n", "- ", "1. ", "> ", "#", " ", "a", "https://x.example/", "javascript:", "<script>", "onerror=", '"', "\\", "    ", "---"];
  let seed = 42;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let i = 0; i < 400; i++) {
    let src = "";
    const n = 1 + Math.floor(rnd() * 60);
    for (let k = 0; k < n; k++) src += parts[Math.floor(rnd() * parts.length)];
    assertSafe(render(src), src);
  }
  const t0 = Date.now();
  render("*".repeat(20000) + "_a".repeat(10000) + "[".repeat(5000) + "`".repeat(5000) + "\n- ".repeat(2000));
  assert.ok(Date.now() - t0 < 4000, `pathological input took ${Date.now() - t0}ms`);
});

/* ---------------------------------------------------------- the model */

let clock = Date.parse("2026-10-18T10:00:00Z");
const at = (s) => new Date(Date.parse("2026-10-18T10:00:00Z") + s * 1000).toISOString();
const model = () => new ChatModel(() => clock);

test("model: the bare contract folds into one turn: log, notes, reply", () => {
  const m = model();
  m.put({ id: "sys", kind: "system", text: "Claude Code is ready in ~/x.", at: at(0) });
  m.put({ id: "u1", kind: "user", text: "add retries", at: at(1) });
  assert.equal(m.phase(), "thinking");
  m.put({ id: "a1", kind: "assistant", text: "Looking.", at: at(2) });
  m.put({ id: "t1", kind: "tool", tool: "Read", category: "read", summary: "Read client.ts", status: "running", at: at(3) });
  assert.equal(m.phase(), "tool");
  m.put({ id: "t1", kind: "tool", tool: "Read", category: "read", summary: "Read client.ts", status: "ok", at: at(5) });
  assert.equal(m.phase(), "thinking", "a finished step with nothing after it: still working");
  m.put({ id: "a2", kind: "assistant", text: "Done.", at: at(9) });
  assert.equal(m.phase(), "idle");
  assert.ok(m.ready, "the ready line is picked up");
  const t = m.current();
  const { log, after } = m.parts(t);
  assert.deepEqual(log.map((r) => r.item.id), ["a1", "t1"], "the note before a tool goes in the log");
  assert.deepEqual(after.map((r) => r.item.id), ["a2"]);
  assert.equal(ChatModel.toolMs(m.recs.get("t1")), 2000, "timed from the at stamps it was seen with");
  const st = m.stats(t);
  assert.equal(st.tools, 1);
  assert.equal(st.endAt - st.startAt, 8000);
});

test("model: a prompt sent mid-turn waits in the queue, then shows where it was sent", () => {
  const m = model();
  m.put({ id: "u1", kind: "user", text: "one", at: at(0) });
  m.put({ id: "t1", kind: "tool", tool: "Bash", category: "bash", summary: "$ npm test", status: "running", at: at(1) });
  m.put({ id: "u2", kind: "user", text: "two", at: at(2) });
  assert.deepEqual(m.queued().map((r) => r.item.id), ["u2"]);
  assert.equal(m.turns.filter((t) => t.user).length, 1, "it doesn't start a turn of its own");
  m.put({ id: "t1", kind: "tool", tool: "Bash", category: "bash", summary: "$ npm test", status: "ok", at: at(3) });
  m.put({ id: "a1", kind: "assistant", text: "ok", at: at(4) });
  assert.deepEqual(m.queued(), []);
  assert.ok(m.parts(m.current()).after.some((r) => r.item.id === "u2"));
});

test("model: without turnId, the office's next prompt event starts the queued prompt's turn", () => {
  const m = model();
  m.put({ id: "u1", kind: "user", text: "one", at: at(0) });
  m.put({ id: "t1", kind: "tool", tool: "Read", category: "read", summary: "Read a.ts", status: "running", at: at(1) });
  clock += 100;
  m.put({ id: "u2", kind: "user", text: "two", at: at(2) });
  m.put({ id: "u3", kind: "user", text: "three", at: at(2) });
  assert.deepEqual(m.queued().map((r) => r.item.id), ["u2", "u3"]);
  m.put({ id: "t1", kind: "tool", tool: "Read", category: "read", summary: "Read a.ts", status: "ok", at: at(3) });
  m.put({ id: "a1", kind: "assistant", text: "done one", at: at(4) });
  clock += 500;
  assert.ok(m.hint("prompt"), "a change");
  assert.equal(m.current().user.item.id, "u2");
  assert.equal(m.turns.filter((t) => t.user).length, 2);
  assert.deepEqual(m.queued().map((r) => r.item.id), ["u3"], "the one behind it still waits");
  m.put({ id: "a2", kind: "assistant", text: "done two", at: at(5) });
  assert.equal(m.recs.get("a2").turn.user.item.id, "u2", "what follows belongs to the new turn");
});

test("model: turnId and queued place prompts exactly; turnEnd closes a turn", () => {
  const m = model();
  m.put({ id: "u1", kind: "user", text: "one", turnId: "A", at: at(0) });
  m.put({ id: "a1", kind: "assistant", text: "wor", streaming: true, turnId: "A", at: at(1) });
  assert.equal(m.phase(), "streaming");
  m.put({ id: "u2", kind: "user", text: "two", turnId: "B", queued: true, at: at(2) });
  assert.deepEqual(m.queued().map((r) => r.item.id), ["u2"]);
  m.put({ id: "a1", kind: "assistant", text: "working", streaming: false, turnId: "A", at: at(3) });
  m.put({ id: "endA", kind: "system", turnId: "A", turnEnd: true, durationMs: 4200, tokens: 1234, at: at(4) });
  const A = m.turns.find((t) => t.turnId === "A");
  assert.ok(A.ended);
  assert.equal(m.stats(A).endAt - m.stats(A).startAt, 4200, "durationMs wins over stamps");
  assert.equal(m.stats(A).tokens, 1234);
  assert.equal(m.phase(), "idle");
  assert.deepEqual(m.parts(A).after.map((r) => r.item.id), ["a1"], "a text-less end marker isn't drawn");
  m.put({ id: "u2", kind: "user", text: "two", turnId: "B", at: at(5) });
  assert.deepEqual(m.queued(), []);
  assert.equal(m.current().turnId, "B");
  assert.equal(m.current().user.item.text, "two");
});

test("model: an approval pairs with its tool; a denial isn't a failure", () => {
  const m = model();
  m.put({ id: "u1", kind: "user", text: "push it", at: at(0) });
  m.put({ id: "t1", kind: "tool", tool: "Bash", category: "bash", summary: "$ git push", status: "running", at: at(1) });
  m.put({ id: "ap-1", kind: "approval", tool: "Bash", category: "bash", summary: "$ git push", text: "Waiting for you", at: at(1) });
  assert.equal(m.phase(), "waiting");
  assert.deepEqual(m.parts(m.current()).after.map((r) => r.item.id), ["ap-1"], "an open approval is drawn as a card");
  m.put({ id: "ap-1", kind: "approval", tool: "Bash", category: "bash", summary: "$ git push", text: "Denied", at: at(1) });
  m.put({ id: "t1", kind: "tool", tool: "Bash", category: "bash", summary: "$ git push", status: "error", at: at(2) });
  const t = m.current();
  assert.equal(m.pairs(t).get(m.recs.get("t1"))?.item.id, "ap-1");
  assert.deepEqual(m.parts(t).log.map((r) => r.item.id), ["t1"], "the answer folds into the tool's row");
  const st = m.stats(t);
  assert.equal(st.failed, 0);
  assert.equal(st.approvals, 1);
  assert.equal(st.denied, 1);
});

test("model: a reconnect starts over, and the office hint settles an ambiguous moment", () => {
  const m = model();
  m.put({ id: "u1", kind: "user", text: "x", at: at(0) });
  clock += 1000;
  m.put({ id: "t1", kind: "tool", tool: "Read", category: "read", summary: "Read a.ts", status: "ok", at: at(1) });
  assert.equal(m.phase(), "thinking");
  clock += 1000;
  m.hint("waiting");
  assert.equal(m.phase(), "idle", "the worker went back to waiting after the last step");
  m.live = false;
  assert.equal(m.running(), false);
  m.reset();
  assert.equal(m.size, 0);
  assert.equal(m.current(), null);
});

test("model: a failure reported as both reply and error shows once", () => {
  const m = model();
  m.put({ id: "u1", kind: "user", text: "hi", at: at(0) });
  m.put({ id: "a1", kind: "assistant", text: "Invalid API key · Fix external API key", at: at(1) });
  m.put({ id: "e1", kind: "error", text: "Invalid API key  ·  Fix external API key", at: at(1) });
  assert.deepEqual(m.parts(m.current()).after.map((r) => r.item.id), ["e1"]);
  assert.equal(m.outcome(m.current()), "failed");
});

test("model: words", () => {
  assert.equal(approvalState({ text: "Waiting for you" }), "open");
  assert.equal(approvalState({ text: "Allowed for this session" }), "always");
  assert.equal(approvalState({ text: "Allowed" }), "allowed");
  assert.equal(approvalState({ text: "Denied" }), "denied");
  assert.equal(approvalState({ text: "Answered elsewhere" }), "withdrawn");
  assert.ok(isTestRun({ category: "bash", summary: "$ npm test" }));
  assert.ok(isTestRun({ category: "bash", summary: "$ cargo test" }));
  assert.ok(isTestRun({ category: "bash", summary: "$ python -m pytest" }));
  assert.ok(!isTestRun({ category: "bash", summary: "$ npm run build" }));
  assert.ok(!isTestRun({ category: "read", summary: "Read test.ts" }));
  assert.equal(dur(420), "0.4s");
  assert.equal(dur(42_000), "42s");
  assert.equal(dur(65_000), "1m 05s");
  assert.equal(compact(12_345), "12k");
  assert.equal(compact(4_321), "4.3k");
});
