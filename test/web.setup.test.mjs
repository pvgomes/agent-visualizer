// Tests for the hire form's "Your setup" section (web/ui/control/setup.ts) against a fake DOM and a
// fake /api/control/setup: what the page shows while the office is asked again, and a project
// folder that was shown once and has since gone.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function load(...entries) {
  const dir = mkdtempSync(join(tmpdir(), "agent-visualizer-setup-test-"));
  dirs.push(dir);
  const outfile = join(dir, "mod.mjs");
  await build({
    stdin: { contents: entries.map((e) => `export * from ${JSON.stringify(`./${e}`)};`).join("\n"), resolveDir: ROOT, loader: "ts" },
    bundle: true, platform: "node", format: "esm", target: "node18", outfile, logLevel: "error",
    loader: { ".svg": "text", ".css": "text" },
  });
  return import(pathToFileURL(outfile).href);
}

/* ---- the little DOM the section builds with ---- */

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.attrs = {};
    this.listeners = {};
    this.className = "";
    this.hidden = false;
    this.style = {};
    this.dataset = {};
    this._text = "";
  }
  get textContent() {
    return this._text + this.childNodes.map((c) => (typeof c === "string" ? c : c.textContent)).join("");
  }
  set textContent(v) {
    this._text = String(v);
    this.childNodes = [];
  }
  append(...ns) {
    for (const n of ns) this.childNodes.push(n);
  }
  appendChild(n) {
    this.childNodes.push(n);
    return n;
  }
  replaceChildren(...ns) {
    this._text = "";
    this.childNodes = [...ns];
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  removeAttribute(k) {
    delete this.attrs[k];
  }
  getAttribute(k) {
    return this.attrs[k] ?? null;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
}
globalThis.document = { createElement: (t) => new FakeNode(t), createElementNS: (_ns, t) => new FakeNode(t) };

const M = await load("web/ui/control/setup.ts", "web/ui/control/store.ts");

const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

const FOLDER = "/w/app";
function inventory(folder) {
  return {
    agent: "claude",
    login: [{ kind: "none", label: "Sign in there myself", available: true }],
    shellKeys: [],
    mcp: [],
    instructions: [],
    notes: [],
    ...(folder ? { project: { folder, display: "~/app", files: 3, bytes: 300, git: { present: true, bytes: 100, ok: true }, envFiles: [], ok: true } } : {}),
  };
}

test("a project folder shown once and deleted since is dropped when the office says it's gone, not uploaded from the old answer", async () => {
  const store = new M.ControlStore();
  store.state = "enabled";
  store.info = { enabled: true, agents: [], providers: [], keys: [], sessions: [], recentFolders: [FOLDER], service: {} };
  let gone = false;
  const asked = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(String(url), "http://office");
    asked.push(u.search);
    const folder = u.searchParams.get("folder");
    if (folder && gone) return new Response(JSON.stringify({ error: "That folder doesn't exist." }), { status: 404 });
    return new Response(JSON.stringify(inventory(folder)), { status: 200 });
  };
  try {
    const sec = M.createSetupSection(store, { openSettings() {}, changed() {} });
    const remote = { agent: "claude", remote: true, mode: "terminal" };
    sec.update(remote);
    await until(() => sec.summary().includes("~/app"));
    // the folder is deleted; the dialog opens again
    gone = true;
    sec.refresh();
    sec.update(remote);
    await until(() => asked.length >= 2);
    await new Promise((r) => setTimeout(r, 60));
    const req = { agent: "claude", place: { kind: "ssh", target: "box" }, mode: "terminal" };
    sec.apply(req);
    assert.equal(req.setup.project, undefined, "the gone folder doesn't go with the hire");
    assert.ok(!sec.summary().includes("~/app"), sec.summary());
    assert.equal(sec.problem(), "");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a hiccup while asking again keeps what was shown", async () => {
  const store = new M.ControlStore();
  store.state = "enabled";
  store.info = { enabled: true, agents: [], providers: [], keys: [], sessions: [], recentFolders: [FOLDER], service: {} };
  let down = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (down) return new Response(JSON.stringify({ error: "Internal error" }), { status: 500 });
    return new Response(JSON.stringify(inventory(new URL(String(url), "http://office").searchParams.get("folder"))), { status: 200 });
  };
  try {
    const sec = M.createSetupSection(store, { openSettings() {}, changed() {} });
    const remote = { agent: "claude", remote: true, mode: "terminal" };
    sec.update(remote);
    await until(() => sec.summary().includes("~/app"));
    down = true;
    sec.refresh();
    sec.update(remote);
    await new Promise((r) => setTimeout(r, 50));
    const req = { agent: "claude", place: { kind: "ssh", target: "box" }, mode: "terminal" };
    sec.apply(req);
    assert.equal(req.setup.project.folder, FOLDER, "the last answer stands");
  } finally {
    globalThis.fetch = realFetch;
  }
});
