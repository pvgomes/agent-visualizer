/*
 * The chat turns the launch video plays, written for the control mock's
 * player API exactly like web/ui/dev/chat-scripts.mjs (say, tool, ask, think).
 * Tool names are each agent's own: Command Code's chat runs over ACP, where
 * the office names calls by their kind (read, edit, shell); Claude Code uses
 * Read / Edit / Bash. Labels are the office's redacted ones. The projects are
 * the demo's fictional cli-kit and payments-svc. A test run asks first, with
 * the full command in the card, so it can be allowed with one key.
 */

const ARGS_DIFF = [
  "@@ -12,6 +12,7 @@ export interface Flags {",
  "   color: boolean;",
  "   width?: number;",
  "+  json: boolean;",
  " }",
];

const TABLE_DIFF = [
  "@@ -31,4 +31,6 @@ export function table(rows: Row[], f: Flags) {",
  "+  if (f.json) return JSON.stringify(rows, null, 2);",
  "+",
  "   const widths = columns(rows, f.width);",
  "   return rows.map((r) => line(r, widths)).join(\"\\n\");",
];

const TEST_GREEN = `> cli-kit@1.4.0 test
> node --test test/table.test.ts test/args.test.ts

 ✔ args parses --json (2.1ms)
 ✔ table prints rows as JSON (1.4ms)
 ✔ table pads columns (0.9ms)
 ℹ tests 24  pass 24  fail 0`;

const V = {
  commandcode: { read: "read", edit: "edit", sh: "shell" },
  claude: { read: "Read", edit: "Edit", sh: "Bash" },
  codex: { read: "shell", edit: "apply_patch", sh: "shell" },
};

/** Read, edit with diffs, ask to run the tests (the full command in the card), answer. */
async function jsonFlag(p) {
  const v = V[p.agent] ?? V.claude;
  await p.think(500);
  await p.tool({ tool: v.read, category: "read", summary: "Read table.ts", ms: 220, detail: "88 lines" });
  await p.tool({ tool: v.read, category: "read", summary: "Read args.ts", ms: 160, detail: "64 lines" });
  await p.say("The table only prints padded text. I'll add a `--json` flag that hands back the rows as JSON instead.");
  await p.tool({ tool: v.edit, category: "edit", summary: "Edit args.ts", ms: 260, diff: { file: "src/args.ts", added: 1, removed: 0, lines: ARGS_DIFF } });
  await p.tool({ tool: v.edit, category: "edit", summary: "Edit table.ts", ms: 300, diff: { file: "src/table.ts", added: 2, removed: 0, lines: TABLE_DIFF } });
  const run = await p.ask({ tool: v.sh, category: "bash", summary: "$ npm test", full: "npm test -- test/table.test.ts test/args.test.ts", ms: 1400, detail: TEST_GREEN });
  await p.think(400);
  if (run === "allow") await p.say("Done: `cli-kit list --json` prints the rows as JSON, and all **24 tests pass**.", { final: true });
  else await p.say("Okay, I didn't run the tests. The change is in `src/args.ts` and `src/table.ts`.", { final: true });
}

/** A review that reads and edits, no approval: an agent that keeps working on its own. */
async function review(p) {
  const v = V[p.agent] ?? V.claude;
  await p.think(700);
  await p.tool({ tool: v.read, category: "read", summary: "Read ledger.go", ms: 900, detail: "212 lines" });
  await p.tool({ tool: v.read, category: "read", summary: "Read refund.go", ms: 700, detail: "143 lines" });
  await p.think(1200);
  await p.say("Refunds retry without an idempotency key, so a timeout can refund twice. Adding the key from the original charge.");
  await p.tool({ tool: v.edit, category: "edit", summary: "Edit refund.go", ms: 1600, diff: { file: "internal/refund.go", added: 3, removed: 1 } });
  await p.tool({ tool: v.edit, category: "edit", summary: "Edit refund_test.go", ms: 1400, diff: { file: "internal/refund_test.go", added: 18, removed: 0 } });
  await p.think(900);
  await p.say("The key now comes from the charge. I added a test for the double refund.", { final: true });
}

export function pick(agent, prompt) {
  return /review|refund|ledger/i.test(prompt) ? review : jsonFlag;
}
