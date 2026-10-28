#!/usr/bin/env node
/*
 * Dev-only harness for the chrome: bundles web/main.ts into --out, serves it
 * with the same strict CSP the real server should send, and streams a
 * synthetic office over GET /events. Nothing here touches real transcripts.
 *
 *   node web/ui/dev/dev-server.mjs --out /tmp/ui-dev [--port 4399]
 *        [--scenario busy|cloud|empty|demo|quiet|hostile|crowded|control] [--seed 7] [--rate 450]
 *        [--interns 5] [--control] [--locked]
 *
 * --scenario control (or --control with any scenario) serves the in-memory
 * control plane from control-mock.mjs: Hire, session terminals and chats,
 * approvals, keys, sandboxes, the service. --locked answers every control
 * call with 401, like a browser that wasn't opened from the office's link.
 * --scenario crowded is one Claude pod with a main worker and --interns N.
 * Chat sessions play scripted turns (chat-scripts.mjs); --chat-speed 0.5 plays
 * them twice as fast, --chat-bare strips the optional ChatItem fields so the
 * page can be checked against the bare contract.
 *
 * --scenario cloud adds every agent kind, workers in Daytona / Vercel /
 * Railway / boat sandboxes and over ssh, one remote offline, and the agents'
 * own MCP signals (moods, shouts, celebrations, a self-inflicted table flip).
 * GET /__emit?kind=<EventKind>&worker=<id>&summary=..&tool=.. pushes one event
 * (dev only) so screenshots can catch exact moments.
 */
import { build } from "esbuild";
import { createServer } from "node:http";
import { cpSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, extname, join, resolve, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createControlMock } from "./control-mock.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]?.startsWith("--") ? "1" : all[i + 1] ?? "1"]] : acc), []),
);
const OUT = resolve(args.out ?? join(tmpdir(), "agent-visualizer-ui-dev"));
const PORT = Number(args.port ?? 4399);
const SCENARIO = args.scenario ?? "busy";
const RATE = Number(args.rate ?? 450);
let seed = Number(args.seed ?? 7);
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];

mkdirSync(join(OUT, "assets"), { recursive: true });
// Split like the real build (scripts/build.mjs): the terminal, chat, Hire and Settings load as their own
// chunks. The entry keeps its plain name, so index.html is copied as is.
await build({
  entryPoints: { app: join(ROOT, "web/main.ts") },
  outdir: join(OUT, "assets"),
  entryNames: "[name]",
  chunkNames: "[name]-[hash]",
  splitting: true,
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  sourcemap: true,
  loader: { ".svg": "text", ".css": "text" },
  logLevel: "warning",
});
const CONTROL = SCENARIO === "control" || !!args.control || !!args.locked;
cpSync(join(ROOT, "web/index.html"), join(OUT, "index.html"));
if (existsSync(join(ROOT, "assets"))) cpSync(join(ROOT, "assets"), join(OUT, "assets"), { recursive: true });

/* ---- synthetic office ---- */
const CAST = [
  { workerId: "w-pay", agent: "claude", project: "payments-svc", cwd: "/Users/dev/Codes/payments-svc", model: "claude-opus-4-1" },
  { workerId: "w-ascii", agent: "claude", project: "ascii", cwd: "/Users/dev/Codes/side/ascii", model: "claude-sonnet-4-5" },
  { workerId: "w-land", agent: "commandcode", project: "landing-page", cwd: "/Users/dev/Codes/landing-page", model: "claude-sonnet-4-5" },
  { workerId: "w-infra", agent: "codex", project: "infra", cwd: "/home/dev/work/infra-terraform-modules", model: "gpt-5-codex" },
  { workerId: "w-ao", agent: "codex", project: "agent-visualizer", cwd: "/Users/dev/Codes/agent-visualizer", model: "gpt-5-codex" },
];
const INTERN = { workerId: "w-pay-sub1", parentId: "w-pay", agent: "claude", project: "payments-svc", cwd: CAST[0].cwd, model: "claude-haiku-4-5", role: "Explore" };
const HOSTS = {
  daytona: { kind: "daytona", id: "daytona:7f3a", name: "auth-refactor" },
  vercel: { kind: "vercel", id: "vercel:sbx_92ac", name: "landing-v2" },
  railway: { kind: "railway", id: "railway:4c1e", name: "api-sandbox" },
  boat: { kind: "boat", id: "boat:b-11", name: "devbox" },
  ssh: { kind: "ssh", id: "ssh:shubham", name: "shubham" },
  dead: { kind: "daytona", id: "daytona:0dd1", name: "nightly-evals" },
};
if (SCENARIO === "cloud") {
  CAST.push(
    { workerId: "w-oc", agent: "opencode", project: "tui-kit", cwd: "/Users/dev/Codes/tui-kit", model: "deepseek/deepseek-v4-pro" },
    { workerId: "w-gem", agent: "gemini", project: "docs-site", cwd: "/Users/dev/Codes/docs-site", model: "gemini-3-pro" },
    { workerId: "w-droid", agent: "droid", project: "infra", cwd: "/Users/dev/Codes/infra", model: "droid-core" },
    { workerId: "w-cur", agent: "cursor", project: "web-app", cwd: "/Users/dev/Codes/web-app", model: "cursor-agent" },
    { workerId: "r-day", agent: "claude", project: "payments-svc", cwd: "/home/daytona/payments-svc", model: "claude-opus-4-5", host: HOSTS.daytona },
    { workerId: "r-day2", agent: "codex", project: "payments-svc", cwd: "/home/daytona/payments-svc", model: "gpt-5-codex", host: HOSTS.daytona },
    { workerId: "r-ver", agent: "codex", project: "landing", cwd: "/vercel/sandbox/landing", model: "gpt-5-codex", host: HOSTS.vercel },
    { workerId: "r-rail", agent: "opencode", project: "api", cwd: "/app/api", model: "kimi-k3", host: HOSTS.railway },
    { workerId: "r-boat", agent: "qwen", project: "ml-pipeline", cwd: "/home/ubuntu/ml-pipeline", model: "qwen3.5-coder", host: HOSTS.boat },
    { workerId: "r-ssh", agent: "claude", project: "dotfiles", cwd: "/home/shubham/dotfiles", model: "claude-sonnet-4-5", host: HOSTS.ssh },
  );
}
/* --scenario crowded: one Claude pod with a main worker and --interns N subagents (default 5), the owner's crunched-pod repro. */
const CROWD = [];
if (SCENARIO === "crowded") {
  CAST.splice(2);
  const main = { workerId: "w-codes", agent: "claude", project: "Codes", cwd: "/Users/dev/Codes", model: "claude-opus-4-5" };
  CAST.push(main);
  const roles = ["fork", "fork", "fork", "fork", "general-purpose", "Explore", "Plan", "code-reviewer", "fork", "test-runner", "Explore"];
  const n = Number(args.interns ?? 5);
  for (let i = 0; i < n; i++) CROWD.push({ workerId: `w-codes-sub${i}`, parentId: main.workerId, agent: "claude", project: "Codes", cwd: main.cwd, model: "claude-haiku-4-5", role: roles[i % roles.length] });
}
const MOODS = ["🧠 deep in the auth refactor", "🔥 shipping v2 tonight", "☕ waiting on CI", "🐛 hunting a flaky test"];
const TOOLS = [
  ["Edit", "edit", () => `Edit ${pick(["cli.ts", "server.ts", "ledger.go", "index.tsx", "styles.css", "README.md"])}`],
  ["Read", "read", () => `Read ${pick(["events.ts", "package.json", "schema.sql", "main.rs", "routes.ts"])}`],
  ["Bash", "bash", () => pick(["$ git status", "$ git diff", "$ npm run build", "$ ls", "$ cargo check"])],
  ["Grep", "search", () => `Grep ${pick(["TODO", "invoice", "useEffect", "retry"])}`],
  ["Glob", "search", () => "Glob **/*.ts"],
  ["WebFetch", "web", () => `WebFetch ${pick(["docs.stripe.com", "developer.mozilla.org", "nodejs.org"])}`],
  ["TodoWrite", "todo", () => "TodoWrite 4 items"],
  ["mcp__github__list_prs", "mcp", () => "mcp github list_prs"],
];

let seq = 0;
const now = () => new Date().toISOString();
const workers = new Map();
const recent = [];

function stateOf(w) {
  return { ...w, status: "tool_start", tool: "Read", category: "read", summary: "Read package.json", lastTs: now(), toolCalls: 0, tokens: 0, filesTouched: 0 };
}

function ev(w, kind, extra = {}, ts = now()) {
  return { seq: ++seq, ts, agent: w.agent, workerId: w.workerId, parentId: w.parentId, project: w.project, cwd: w.cwd, model: w.model, role: w.role, host: w.host, kind, ...extra };
}

function randomEvent(w, ts) {
  const r = rand();
  // --scenario hostile: markup-looking summaries must render as plain text.
  if (SCENARIO === "hostile" && r < 0.3) return ev(w, "tool_start", { tool: "Edit", category: "edit", summary: '<img src=x onerror=alert(1)>"><b>x</b>' }, ts);
  if (r < 0.62) {
    const [tool, category, sum] = pick(TOOLS);
    return ev(w, "tool_start", { tool, category, summary: sum(), tokens: Math.floor(200 + rand() * 4000) }, ts);
  }
  if (r < 0.72) return ev(w, "thinking", {}, ts);
  if (r < 0.77) return ev(w, "tool_start", { tool: "Bash", category: "bash", summary: pick(["$ npm test", "$ pnpm test", "$ cargo test", "$ go test ./..."]) }, ts);
  if (r < 0.81) return ev(w, "test_fail", { summary: pick(["$ npm test", "$ pnpm test", "$ cargo test"]) }, ts);
  if (r < 0.86) return ev(w, "test_pass", { summary: pick(["$ npm test", "$ go test ./...", "$ cargo test"]) }, ts);
  if (r < 0.9) return ev(w, "waiting", {}, ts);
  if (r < 0.93) return ev(w, "prompt", {}, ts);
  if (r < 0.95) return ev(w, "tool_end", { tool: "Bash", category: "bash", summary: "$ npm run lint", isError: true }, ts);
  return ev(w, "tool_end", { tool: "Read", category: "read" }, ts);
}

function fold(e) {
  const w = workers.get(e.workerId);
  if (!w) return;
  w.status = e.kind === "tool_end" ? w.status : e.kind;
  w.lastTs = e.ts;
  if (e.kind === "tool_start") {
    w.toolCalls++;
    w.tool = e.tool;
    w.category = e.category;
    w.summary = e.summary;
    if (e.category === "edit") w.filesTouched++;
  }
  if (e.tokens) w.tokens += e.tokens;
  if (e.kind === "status") w.mood = e.summary;
}

if (SCENARIO !== "empty") {
  for (const c of CAST) workers.set(c.workerId, stateOf(c));
  if (SCENARIO !== "crowded") workers.set(INTERN.workerId, stateOf(INTERN));
  for (const c of CROWD) workers.set(c.workerId, stateOf(c));
  for (const w of workers.values()) {
    w.toolCalls = Math.floor(20 + rand() * 300);
    w.tokens = Math.floor(30_000 + rand() * 900_000);
    w.filesTouched = Math.floor(rand() * 18);
  }
  const t0 = Date.now() - 4 * 60_000;
  const cast = [...workers.values()];
  for (let i = 0; i < 46; i++) {
    const e = randomEvent(pick(cast), new Date(t0 + i * 5200).toISOString());
    fold(e);
    recent.push(e);
  }
  if (SCENARIO !== "crowded") recent.push(ev(INTERN, "subagent_start", {}, new Date(Date.now() - 9000).toISOString()));
  if (CAST[3]) recent.push(ev(CAST[3], "test_fail", { summary: "$ go test ./..." }, new Date(Date.now() - 6000).toISOString()));
  recent.push(ev(CAST[2], "waiting", {}, new Date(Date.now() - 3000).toISOString()));
  if (SCENARIO === "cloud") {
    workers.get("r-day").mood = MOODS[0];
    workers.get("w-gem").mood = MOODS[1];
    recent.push(ev(workers.get("r-day"), "status", { summary: MOODS[0] }, new Date(Date.now() - 20000).toISOString()));
    recent.push(ev(workers.get("w-gem"), "status", { summary: MOODS[1] }, new Date(Date.now() - 15000).toISOString()));
    recent.push({ seq: ++seq, ts: new Date(Date.now() - 12000).toISOString(), agent: "claude", workerId: "host:" + HOSTS.dead.id, project: "nightly-evals", host: HOSTS.dead, kind: "error", summary: "remote offline" });
  }
}

const clients = new Set();
function broadcast(e) {
  fold(e);
  recent.push(e);
  if (recent.length > 200) recent.shift();
  for (const res of clients) res.write(`event: office\ndata: ${JSON.stringify(e)}\n\n`);
}

/* the control mock's office events: workers come, are renamed in place (replaces), and go */
function emitOffice(partial) {
  const e = { seq: ++seq, ...partial };
  if (e.kind === "session_start") {
    const old = e.replaces && workers.get(e.replaces);
    if (old) {
      workers.delete(e.replaces);
      workers.set(e.workerId, { ...old, workerId: e.workerId });
    } else if (!workers.has(e.workerId)) {
      workers.set(e.workerId, { workerId: e.workerId, agent: e.agent, project: e.project, host: e.host, cwd: e.cwd, model: e.model, status: "session_start", lastTs: e.ts, toolCalls: 0, tokens: 0, filesTouched: 0 });
    }
  }
  broadcast(e);
  if (e.kind === "session_end") workers.delete(e.workerId);
}
function emitControl(name, data) {
  for (const res of clients) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}
const control = CONTROL ? createControlMock({ locked: !!args.locked, empty: SCENARIO === "empty", emitControl, emitOffice, chatBare: !!args["chat-bare"], chatSpeed: Number(args["chat-speed"] ?? 1) || 1 }) : null;

let tickN = 0;
if (SCENARIO === "crowded") {
  // every intern talks at once, the main worker waits on its human, one intern runs gh
  const main = workers.get("w-codes");
  setInterval(() => {
    tickN++;
    for (const c of CROWD) {
      const w = workers.get(c.workerId);
      if (c === CROWD[CROWD.length - 1]) broadcast(ev(w, "tool_start", { tool: "Bash", category: "bash", summary: "$ gh api" }));
      else if (c === CROWD[CROWD.length - 2]) broadcast(ev(w, "tool_start", { tool: "WebFetch", category: "web", summary: "Fetch code.claude.com" }));
      else broadcast(ev(w, tickN % 3 ? "reply" : "thinking", tickN % 3 ? { summary: "Here's what I found" } : {}));
    }
    if (tickN % 4 === 1) broadcast(ev(main, "waiting", {}));
  }, 2500);
} else if (SCENARIO !== "empty" && SCENARIO !== "quiet" && SCENARIO !== "crowded") {
  setInterval(() => {
    tickN++;
    // workers the control mock hired act out their own scripts; random beats would contradict them
    const cast = [...workers.values()].filter((w) => !/^(ctl:|sess-)/.test(w.workerId));
    if (!cast.length) return;
    // A scripted beat every so often so screenshots catch the big moments.
    if (tickN % 23 === 0) return broadcast(ev(pick(cast.filter((w) => !w.parentId)), "test_fail", { summary: "$ pnpm test" }));
    if (tickN % 31 === 0) return broadcast(ev(pick(cast.filter((w) => !w.parentId)), "test_pass", { summary: "$ npm test" }));
    if (tickN % 41 === 0 && !workers.has("w-ao-sub")) {
      const intern = { workerId: "w-ao-sub", parentId: "w-ao", agent: "codex", project: "agent-visualizer", cwd: CAST[4].cwd, model: "gpt-5-codex", role: "general-purpose" };
      workers.set(intern.workerId, stateOf(intern));
      return broadcast(ev(intern, "subagent_start"));
    }
    if (SCENARIO === "cloud" && tickN % 17 === 0) return broadcast(ev(pick(cast.filter((w) => !w.parentId)), "status", { summary: pick(MOODS) }));
    if (SCENARIO === "cloud" && tickN % 29 === 0) return broadcast(ev(pick(cast.filter((w) => !w.parentId)), "shout", { summary: pick(["shipped v2 🚀", "all 412 tests green", "PR #88 is up"]) }));
    if (SCENARIO === "cloud" && tickN % 37 === 0) return broadcast(ev(pick(cast.filter((w) => !w.parentId)), "flip", { summary: "the linter disagrees with physics" }));
    if (tickN % 67 === 0 && workers.has("w-ao-sub")) {
      const w = workers.get("w-ao-sub");
      broadcast(ev(w, "subagent_end"));
      workers.delete("w-ao-sub");
      return;
    }
    broadcast(randomEvent(pick(cast), now()));
  }, RATE);
}

/* ---- http ---- */
/* The same policy src/server/http.ts sends. Inline styles are allowed for
 * xterm.js (the session terminal), whose DOM renderer injects <style>
 * elements and colour style attributes; scripts stay 'self' only. */
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".map": "application/json", ".svg": "image/svg+xml", ".css": "text/css" };

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname.startsWith("/api/control")) {
    if (!control) return void res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "no control plane in this dev scenario" }));
    if (await control.handle(req, res, url)) return;
  }
  if (url.pathname === "/__control" && control) {
    const ok = control.poke(url.searchParams.get("do") ?? "", url.searchParams.get("mode") ?? undefined);
    res.writeHead(204, { "x-poked": String(ok) }).end();
    return;
  }
  if (url.pathname === "/__emit") {
    const w = workers.get(url.searchParams.get("worker") ?? "") ?? [...workers.values()][0];
    const extra = {};
    for (const k of ["summary", "tool", "category"]) if (url.searchParams.has(k)) extra[k] = url.searchParams.get(k);
    if (w) broadcast(ev(w, url.searchParams.get("kind") ?? "thinking", extra));
    res.writeHead(204).end();
    return;
  }
  if (url.pathname === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    const snapshot = { version: 1, startedAt: now(), demo: SCENARIO === "demo", workers: [...workers.values()], recent: recent.slice(-200), control: CONTROL ? (args.locked ? "locked" : "enabled") : "off" };
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }
  const rel = url.pathname === "/" ? "index.html" : normalize(url.pathname).replace(/^[/\\]+/, "");
  const file = join(OUT, rel);
  if (!file.startsWith(OUT) || !existsSync(file)) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "content-security-policy": CSP, "cache-control": "no-store" });
  res.end(readFileSync(file));
}).listen(PORT, "127.0.0.1", () => console.log(`ui dev: http://127.0.0.1:${PORT}  scenario=${SCENARIO}  out=${OUT}`));
