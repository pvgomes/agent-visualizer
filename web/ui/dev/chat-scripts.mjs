/*
 * Dev-only: the turns the control mock plays in chat mode, one small script
 * per kind of request, in each agent's own tool vocabulary (Claude Code's
 * Read / Edit / Bash, Codex's shell / apply_patch, opencode's read / edit /
 * bash). A script is an async function over a tiny player API:
 *
 *   say(text)          stream an assistant message in, a few words at a time
 *   tool(spec)         a tool call: running, then ok / error with its duration,
 *                      output tail (detail) and diff
 *   ask(spec)          a tool that needs approval: resolves "allow" | "deny"
 *   think(ms)          the model thinking (nothing on screen but the indicator)
 *   fail(text, detail) an error item; the turn ends there
 *
 * pick(agent, prompt, n) chooses one by the prompt's words, else by turn number.
 */

/* ------------------------------------------------------------- the text */

const RETRY_TS = `export async function withRetry<T>(fn: () => Promise<T>, o: RetryOptions = {}): Promise<T> {
  const tries = o.tries ?? 3;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= tries || !retryable(err)) throw err;
      await sleep((o.baseMs ?? 200) * 2 ** (i - 1));
    }
  }
}`;

const RETRY_NEW = [
  "@@ -0,0 +1,24 @@",
  "+import { HttpError, isNetworkError } from \"./errors.ts\";",
  "+",
  "+export interface RetryOptions {",
  "+  tries?: number;",
  "+  baseMs?: number;",
  "+}",
  "+",
  "+const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));",
  "+",
  "+function retryable(err: unknown): boolean {",
  "+  return isNetworkError(err);",
  "+}",
  "+",
  ...RETRY_TS.split("\n").map((l) => `+${l}`),
];

const CLIENT_DIFF = [
  "@@ -1,4 +1,5 @@",
  " import { parse } from \"./parse.ts\";",
  "+import { withRetry } from \"./retry.ts\";",
  " ",
  "@@ -38,8 +39,12 @@ export class LedgerClient {",
  "   async post(path: string, body: unknown) {",
  "-    const res = await fetch(this.url(path), this.init(\"POST\", body));",
  "-    return parse(res);",
  "+    return withRetry(async () => {",
  "+      const res = await fetch(this.url(path), this.init(\"POST\", body));",
  "+      if (res.status >= 500) throw new HttpError(res.status);",
  "+      return parse(res);",
  "+    });",
  "   }",
];

const RETRY_FIX = [
  "@@ -11,5 +11,6 @@ const sleep = (ms: number) => …",
  " function retryable(err: unknown): boolean {",
  "-  return isNetworkError(err);",
  "+  // a 5xx is the server's problem: worth another go. A 4xx is ours.",
  "+  return isNetworkError(err) || (err instanceof HttpError && err.status >= 500);",
  " }",
];

const TEST_RED = `> payments-svc@2.3.0 test
> vitest run

 ✓ src/ledger/client.test.ts (11 tests) 41ms
 ✓ src/ledger/webhooks.test.ts (6 tests) 18ms
 ✗ src/ledger/retry.test.ts (4 tests | 1 failed) 212ms
   ✗ withRetry > retries a 503 until it succeeds
     AssertionError: expected "fetch" to be called 3 times, but got 1 times
      ❯ src/ledger/retry.test.ts:27:22

 Test Files  1 failed | 2 passed (3)
      Tests  1 failed | 20 passed (21)
   Duration  3.12s`;

const TEST_GREEN = `> payments-svc@2.3.0 test
> vitest run

 ✓ src/ledger/client.test.ts (11 tests) 39ms
 ✓ src/ledger/webhooks.test.ts (6 tests) 17ms
 ✓ src/ledger/retry.test.ts (4 tests) 604ms

 Test Files  3 passed (3)
      Tests  21 passed (21)
   Duration  2.87s`;

const FEATURE_REPLY = `Added retries to the ledger client.

**What changed**
- \`src/ledger/retry.ts\`: a small \`withRetry\` helper. Three tries, exponential backoff from 200 ms, and it retries network errors and 5xx answers.
- \`src/ledger/client.ts\`: \`post()\` goes through it; a 4xx still fails at once.
- \`src/ledger/retry.test.ts\`: covers *503 then success*, *400 never retried* and the give-up path.

The core of it:

\`\`\`ts
${RETRY_TS}
\`\`\`

The first test run caught that 503s weren't retried (only network errors were). Fixed, and all **21 tests pass**. Want me to add jitter, or make \`tries\` configurable per call?`;

const EXPLAIN_REPLY = `## payments-svc

A small TypeScript service that sits between the shop and the bank's ledger API. It takes payment intents, books them in the ledger, and turns the bank's webhooks back into order updates.

### How it's laid out
- **\`src/http/\`**: the public API (Hono), one file per route
  - \`intents.ts\`: create, confirm and cancel a payment intent
  - \`webhooks.ts\`: verifies the bank's signature, then queues the event
- **\`src/ledger/\`**: the client for the bank's ledger, with typed errors
- **\`src/jobs/\`**: a worker that drains the webhook queue and retries failed bookings
- **\`migrations/\`**: SQL, applied in order by \`npm run migrate\`

### Running it
\`\`\`sh
npm install
cp .env.example .env   # LEDGER_URL, LEDGER_KEY, DATABASE_URL
npm run migrate && npm run dev
\`\`\`

> Webhooks need a public URL. The README suggests \`npx localtunnel --port 8787\` while developing.

### Worth knowing
1. Every ledger call is **idempotent** through an \`Idempotency-Key\` header built from the intent id.
2. Money is kept in minor units (\`amount: 1999\` is 19.99) everywhere; there's no float math.
3. The tests use a fake ledger in \`test/fake-ledger.ts\`, so they run offline.

The bank's API reference is linked from the README: [ledger API docs](https://docs.example-bank.dev/ledger). Want me to go deeper on the webhook flow?`;

const TODO_REPLY = `Found **7 TODOs** and **2 FIXMEs** across 5 files:

| Area | Where | What it says |
| --- | --- | --- |
| ledger | \`client.ts:112\` | honour \`Retry-After\` on 429 |
| ledger | \`errors.ts:30\` | map the bank's \`E_DUPLICATE\` to a typed error |
| webhooks | \`webhooks.ts:58\` | **FIXME** signature check is skipped on redelivery |
| webhooks | \`webhooks.ts:91\` | **FIXME** events can be processed twice |
| jobs | \`drain.ts:22\` | back off when the queue is empty |
| http | \`intents.ts:140\` | validate currency against the shop's list |
| tests | \`fake-ledger.ts:12\` | simulate partial outages |

The two FIXMEs in \`webhooks.ts\` look like real bugs: a redelivered event skips the signature check *and* can be booked twice. I'd start there.`;

const TESTS_REPLY = `The suite was red because of one test, and it was the test that was wrong:

- \`intents.test.ts\` expected \`amount\` as a decimal (\`19.99\`), but the service has used minor units (\`1999\`) since the last migration.
- I updated the fixture, not the code. Nothing else depended on the old shape.

\`\`\`diff
-  expect(body.amount).toBe(19.99);
+  expect(body.amount).toBe(1999);
\`\`\`

All **48 tests pass** now (2.4s).`;

/* -------------------------------------------------------------- vocab */

/** Each agent names its tools its own way; the labels follow the office's redaction (file names, the subcommand only). */
const VOCAB = {
  claude: {
    read: (f) => ({ tool: "Read", category: "read", summary: `Read ${f}` }),
    edit: (f) => ({ tool: "Edit", category: "edit", summary: `Edit ${f}` }),
    write: (f) => ({ tool: "Write", category: "edit", summary: `Write ${f}` }),
    grep: (q) => ({ tool: "Grep", category: "search", summary: `Grep ${q}` }),
    glob: (q) => ({ tool: "Glob", category: "search", summary: `Glob ${q}` }),
    sh: (c) => ({ tool: "Bash", category: c === "$ rg" || c === "$ ls" ? "search" : "bash", summary: c }),
    todo: (n) => ({ tool: "TodoWrite", category: "todo", summary: `TodoWrite ${n} items` }),
  },
  codex: {
    read: (f) => ({ tool: "shell", category: "read", summary: `Read ${f}` }),
    edit: (f) => ({ tool: "apply_patch", category: "edit", summary: `Edit ${f}` }),
    write: (f) => ({ tool: "apply_patch", category: "edit", summary: `Edit ${f}` }),
    grep: () => ({ tool: "shell", category: "search", summary: "$ rg" }),
    glob: () => ({ tool: "shell", category: "search", summary: "$ ls" }),
    sh: (c) => ({ tool: "shell", category: c === "$ rg" || c === "$ ls" ? "search" : "bash", summary: c }),
    todo: (n) => ({ tool: "update_plan", category: "todo", summary: `Plan ${n} steps` }),
  },
  opencode: {
    read: (f) => ({ tool: "read", category: "read", summary: `Read ${f}` }),
    edit: (f) => ({ tool: "edit", category: "edit", summary: `Edit ${f}` }),
    write: (f) => ({ tool: "write", category: "edit", summary: `Write ${f}` }),
    grep: (q) => ({ tool: "grep", category: "search", summary: `Grep ${q}` }),
    glob: (q) => ({ tool: "glob", category: "search", summary: `Glob ${q}` }),
    sh: (c) => ({ tool: "bash", category: c === "$ rg" || c === "$ ls" ? "search" : "bash", summary: c }),
    todo: (n) => ({ tool: "todowrite", category: "todo", summary: `Todo ${n} items` }),
  },
};
const vocab = (agent) => VOCAB[agent] ?? VOCAB.claude;

/* ------------------------------------------------------------ scripts */

/** Add a feature: notes, reads, edits with diffs, a red test run, a fix, a green run, a reply with code. */
async function feature(p) {
  const v = vocab(p.agent);
  await p.think(1100);
  await p.say("I'll start with how the ledger client sends its requests.");
  await p.tool({ ...v.read("client.ts"), ms: 260, detail: "142 lines" });
  await p.tool({ ...v.grep("fetch("), ms: 180, detail: "src/ledger/client.ts:41:    const res = await fetch(this.url(path), this.init(\"GET\"));\nsrc/ledger/client.ts:52:    const res = await fetch(this.url(path), this.init(\"POST\", body));\nsrc/ledger/webhooks.ts:17:  await fetch(ackUrl, { method: \"POST\" });" });
  await p.tool({ ...v.read("errors.ts"), ms: 140, detail: "48 lines" });
  await p.think(900);
  await p.say("The client calls `fetch` directly, with no retry, and turns a 5xx into a thrown `HttpError`. I'll add a `withRetry` helper and wrap the idempotent calls with it.");
  await p.tool({ ...v.write("retry.ts"), ms: 420, diff: { file: "src/ledger/retry.ts", added: 24, removed: 0, lines: RETRY_NEW } });
  await p.tool({ ...v.edit("client.ts"), ms: 310, diff: { file: "src/ledger/client.ts", added: 6, removed: 2, lines: CLIENT_DIFF } });
  await p.tool({ ...v.write("retry.test.ts"), ms: 380, diff: { file: "src/ledger/retry.test.ts", added: 41, removed: 0 } });
  await p.tool({ ...v.sh("$ npm test"), ms: 3100, status: "error", detail: TEST_RED });
  await p.think(1000);
  await p.say("One test fails: the fake ledger answers **503**, but `withRetry` only retries network errors. Widening the check to any 5xx.");
  await p.tool({ ...v.edit("retry.ts"), ms: 240, diff: { file: "src/ledger/retry.ts", added: 2, removed: 1, lines: RETRY_FIX } });
  await p.tool({ ...v.sh("$ npm test"), ms: 2900, detail: TEST_GREEN });
  await p.think(700);
  await p.say(FEATURE_REPLY, { final: true });
}

/** Two approvals in one turn, so one can be allowed and the other denied. */
async function approvals(p) {
  const v = vocab(p.agent);
  await p.think(800);
  await p.say("I'll clear the stale build output first, then rebuild from scratch.");
  const clean = await p.ask({ ...v.sh("$ rm -rf dist"), ms: 140, detail: "(no output)" });
  if (clean === "allow") {
    await p.tool({ ...v.sh("$ npm run build"), ms: 1800, detail: "> tsc -p . && esbuild src/index.ts --bundle --outdir=dist\n\n  dist/index.js      48.2kb\n  dist/index.js.map  131.0kb\n\n⚡ Done in 412ms" });
  } else {
    await p.say("Skipping the clean; building over the old output.");
    await p.tool({ ...v.sh("$ npm run build"), ms: 1600, detail: "⚡ Done in 398ms" });
  }
  await p.think(600);
  await p.say("The build is green. Pushing the branch so the preview deploys.");
  const push = await p.ask({ ...v.sh("$ git push"), ms: 900, detail: "To github.com:shop/payments-svc.git\n * [new branch]      preview -> preview" });
  await p.think(500);
  if (push === "allow") await p.say("Pushed. The preview deploy starts from the `preview` branch; it usually takes a minute or two.", { final: true });
  else await p.say("Okay, I didn't push. `dist/` is freshly built, so when you're ready:\n\n```sh\ngit push -u origin preview\n```", { final: true });
}

/** Reads a little, then the API falls over: an error card. */
async function broken(p) {
  const v = vocab(p.agent);
  await p.think(700);
  await p.say("Checking the deploy config before I touch anything.");
  await p.tool({ ...v.read("fly.toml"), ms: 160, detail: "36 lines" });
  await p.tool({ ...v.read("Dockerfile"), ms: 120, detail: "22 lines" });
  await p.think(2400);
  await p.fail("API error 529: the model is overloaded right now. Nothing was changed; send the message again in a moment.", '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011CXb…"}');
}

/** Read around and explain, with headings, nested lists, a shell block, a quote and a link. */
async function explain(p) {
  const v = vocab(p.agent);
  await p.think(900);
  await p.tool({ ...v.glob("**/*.ts"), ms: 120, detail: "38 files" });
  await p.tool({ ...v.read("package.json"), ms: 90, detail: "54 lines" });
  await p.tool({ ...v.read("README.md"), ms: 110, detail: "118 lines" });
  await p.tool({ ...v.read("index.ts"), ms: 100, detail: "61 lines" });
  await p.tool({ ...v.read("webhooks.ts"), ms: 130, detail: "143 lines" });
  await p.think(1200);
  await p.say(EXPLAIN_REPLY, { final: true });
}

/** Search the repo, answer with a table. */
async function todos(p) {
  const v = vocab(p.agent);
  await p.think(600);
  await p.tool({ ...v.sh("$ rg"), ms: 240, detail: "src/ledger/client.ts:112:  // TODO: honour Retry-After on 429\nsrc/ledger/errors.ts:30:  // TODO: map E_DUPLICATE\nsrc/http/webhooks.ts:58:  // FIXME: signature check skipped on redelivery\nsrc/http/webhooks.ts:91:  // FIXME: can be processed twice\nsrc/jobs/drain.ts:22:  // TODO: back off when empty\nsrc/http/intents.ts:140: // TODO: validate currency\ntest/fake-ledger.ts:12:  // TODO: partial outages" });
  await p.tool({ ...v.read("webhooks.ts"), ms: 140, detail: "143 lines" });
  await p.think(800);
  await p.say(TODO_REPLY, { final: true });
}

/** Run the tests: red, read, fix, green. */
async function tests(p) {
  const v = vocab(p.agent);
  await p.think(500);
  await p.tool({ ...v.sh("$ npm test"), ms: 2600, status: "error", detail: " ✓ test/ledger.test.ts (21 tests)\n ✗ test/intents.test.ts (27 tests | 1 failed)\n   ✗ POST /intents > returns the amount\n     AssertionError: expected 1999 to be 19.99\n\n Tests  1 failed | 47 passed (48)" });
  await p.tool({ ...v.read("intents.test.ts"), ms: 120, detail: "212 lines" });
  await p.tool({ ...v.read("0007_minor_units.sql"), ms: 90, detail: "14 lines" });
  await p.think(900);
  await p.say("The service stores minor units since migration 0007; the test still expects decimals. Fixing the fixture.");
  await p.tool({ ...v.edit("intents.test.ts"), ms: 200, diff: { file: "test/intents.test.ts", added: 1, removed: 1, lines: ["@@ -88,7 +88,7 @@ describe(\"POST /intents\", () => {", "   const body = await res.json();", "-  expect(body.amount).toBe(19.99);", "+  expect(body.amount).toBe(1999);", "   expect(body.currency).toBe(\"EUR\");"] } });
  await p.tool({ ...v.sh("$ npm test"), ms: 2400, detail: " ✓ test/ledger.test.ts (21 tests)\n ✓ test/intents.test.ts (27 tests)\n\n Tests  48 passed (48)\n Duration  2.41s" });
  await p.say(TESTS_REPLY, { final: true });
}

/** A quick one: a short answer, no tools. */
async function quick(p) {
  await p.think(900);
  await p.say("Sure. The retry helper lives in `src/ledger/retry.ts`; `tries` defaults to **3** and the backoff doubles from 200 ms, so a call gives up after about 600 ms of waiting.", { final: true });
}

const BY_WORD = [
  [/\b(clean|build|push|publish|preview|release)\b/i, approvals],
  [/\b(deploy|staging|broken|error|crash)\b/i, broken],
  [/\b(explain|overview|repo|walk me)\b/i, explain],
  [/\b(todo|fixme)s?\b/i, todos],
  [/\b(test|tests|suite)\b/i, tests],
  [/\b(add|retry|retries|implement|fix|ledger)\b/i, feature],
  [/\b(where|what|how|why)\b.*\?$/i, quick],
];

const ROTATION = {
  claude: [feature, approvals, broken, explain],
  codex: [todos, tests, feature, approvals],
  opencode: [explain, feature, approvals, broken],
};

export function pick(agent, prompt, n) {
  for (const [re, fn] of BY_WORD) if (re.test(prompt)) return fn;
  const rot = ROTATION[agent] ?? ROTATION.claude;
  return rot[n % rot.length];
}
