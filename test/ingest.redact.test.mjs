// Tests for src/ingest/redact.ts and categories.ts: labels, secrets, shell parsing, test-run detection.
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

async function load(...entries) {
  const dir = mkdtempSync(join(tmpdir(), "agent-visualizer-test-"));
  const outfile = join(dir, "mod.mjs");
  await build({
    stdin: { contents: entries.map((e) => `export * from ${JSON.stringify(`./${e}`)};`).join("\n"), resolveDir: ROOT, loader: "ts" },
    bundle: true, platform: "node", format: "esm", target: "node18", outfile, logLevel: "error",
  });
  try {
    return await import(pathToFileURL(outfile).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const R = await load("src/ingest/redact.ts", "src/ingest/categories.ts", "src/shared/events.ts");

test("shell summaries keep program + subcommand only", () => {
  const cases = [
    ["npm test", "$ npm test"],
    ["cd /Users/me/secret-project && npm test", "$ npm test"],
    ["FOO=1 BAR=baz npm run test:unit -- --grep 'private words'", "$ npm run test:unit"],
    ["sudo -u root apt-get install -y secretpkg", "$ apt-get install"],
    ["git commit -m 'leak me please'", "$ git commit"],
    ["git -C /secret/path status", "$ git"],
    ["bash -lc 'cd x && pytest -q tests/test_secret.py'", "$ pytest"],
    [["bash", "-lc", "cargo test --release"], "$ cargo test"],
    [["ls", "-la", "/secret"], "$ ls"],
    ["python3 - <<'EOF'\nimport os\nprint(os.environ['TOKEN'])\nEOF", "$ python"],
    ["python3 -m pytest -k secret", "$ python -m pytest"],
    ["for f in src/*.ts; do wc -l \"$f\"; done", "$ wc"],
    ["echo --- && make build", "$ make build"],
    ["claude -p hello", "$ claude"],
    ["curl -H 'Authorization: Bearer sk-ant-abcdefghijklmnopqrstu' https://api.example.com", "$ curl"],
    ["/usr/local/bin/node ./scripts/x.js --token abc", "$ node"],
    ["timeout 60 npm test", "$ npm test"],
    ["env -i PATH=/bin HOME=/x npm test", "$ npm test"],
    ["(cd sub && go test ./...)", "$ go test"],
    ["docker compose up -d", "$ docker compose up"],
    ["./node_modules/.bin/vitest run src/secret.test.ts", "$ vitest run"],
    ["npm test 2>&1 | tail -20", "$ npm test"],
    ["cargo fmt --check && cargo test -p secret_crate", "$ cargo test"],
    ["node --test test/", "$ node --test"],
    ["export TOKEN=ghp_abcdefghijklmnopqrstuvwxyz012345 && gh pr create --title secret", "$ gh pr create"],
    ["", "$ shell"],
  ];
  for (const [cmd, want] of cases) assert.equal(R.shellSummary(cmd), want, JSON.stringify(cmd));
});

test("test commands are detected, other commands are not", () => {
  const yes = [
    "npm test", "npm t", "pnpm test", "yarn test", "bun test", "npm run test", "npm run test:unit", "pnpm run e2e",
    "pnpm -r test", "pnpm --filter web test", "yarn workspace api test", "npx vitest run", "npx jest --ci", "vitest",
    "jest", "mocha", "pytest -x", "python -m pytest", "python3 -m unittest", "uv run pytest", "poetry run pytest",
    "cargo test", "cargo nextest run", "go test ./...", "rspec", "bundle exec rspec", "rails test", "phpunit",
    "vendor/bin/phpunit", "npx playwright test", "playwright test", "make test", "make test-unit", "make check",
    "tox -e py311", "deno test", "swift test", "mix test", "dotnet test", "./gradlew test", "mvn test", "node --test",
    "cd app && CI=1 npm test 2>&1 | tail -30", "bash -lc 'go test ./...'", "if npm test; then echo ok; fi",
  ];
  const no = [
    "npm install", "npm run build", "npm run lint", "npm run check", "git commit -m 'npm test passes'", "echo npm test",
    "cargo build", "go vet ./...", "ls test/", "cat test.txt", "make", "make build", "vitest --version", "npx tsc",
    "python test.py", "grep -r test .", "pip install pytest",
  ];
  for (const c of yes) assert.equal(R.isTestCommand(c), true, c);
  for (const c of no) assert.equal(R.isTestCommand(c), false, c);
});

test("a test's exit code is hidden behind pipes, ; and ||", () => {
  assert.equal(R.testExitHidden("npm test | tail -5"), true);
  assert.equal(R.testExitHidden("npm test; echo EXIT=$?"), true);
  assert.equal(R.testExitHidden("npm test || true"), true);
  assert.equal(R.testExitHidden("npm test && echo ok"), false);
  assert.equal(R.testExitHidden("cd x && npm test"), false);
  assert.equal(R.testExitHidden("npm test"), false);
});

test("failure markers in test output", () => {
  for (const t of ["Tests:       1 failed, 4 passed", "FAIL src/a.test.ts", " FAIL  src/a.test.ts", "--- FAIL: TestX (0.00s)", "test result: FAILED. 1 passed; 2 failed", "=== 2 failed, 3 passed in 0.2s ===", "not ok 3 - adds", "# fail 1", "3 failing"]) {
    assert.equal(R.outputLooksFailed(t), true, t);
  }
  for (const t of ["Tests: 4 passed", "0 failed", "test result: ok. 3 passed; 0 failed", "PASS src/a.test.ts", ""]) {
    assert.equal(R.outputLooksFailed(t), false, t);
  }
});

test("secrets are masked", () => {
  const s = R.redactSecrets(
    "sk-ant-api03-abcdefghijklmnop ghp_abcdefghijklmnopqrstuvwx AKIAABCDEFGHIJKLMNOP " +
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig_abc_123 deadbeefdeadbeefdeadbeefdeadbeef " +
      "api_key=hunter2 password: 'pa ss' https://user:pw@host.example.com/x xoxb-1234567890-abcdefghij",
  );
  for (const leak of ["sk-ant", "ghp_", "AKIA", "eyJ", "deadbeef", "hunter2", "pa ss", "user:pw", "xoxb-"]) assert.ok(!s.includes(leak), leak + " in " + s);
  assert.ok(s.includes("api_key=•••"));
  // Ordinary text survives.
  assert.equal(R.redactSecrets("Edit cli.ts"), "Edit cli.ts");
  assert.equal(R.redactSecrets("$ npm run test:unit"), "$ npm run test:unit");
  assert.equal(R.redactSecrets("Read some_really_long_snake_case_module_name.py"), "Read some_really_long_snake_case_module_name.py");
});

test("clip caps at SUMMARY_MAX with an ellipsis", () => {
  const long = "Edit " + "a".repeat(200) + ".ts";
  const c = R.clip(long);
  assert.equal([...c].length, R.SUMMARY_MAX);
  assert.ok(c.endsWith("…"));
  assert.equal(R.clip("a\nb\tc\u202ed"), "a b c d");
});

test("tool labels never carry arguments", () => {
  const s = (name, input) => R.toolSummary(name, R.categorize(name), input);
  assert.equal(s("Read", { file: "/Users/me/secret/src/cli.ts" }), "Read cli.ts");
  assert.equal(s("Edit", { file: "C:\\work\\app\\main.go" }), "Edit main.go");
  assert.equal(s("Write", { file: "/x/notes.md" }), "Write notes.md");
  assert.equal(s("write_file", { file: "/x/notes.md" }), "Write notes.md");
  assert.equal(s("apply_patch", { files: ["src/a.rs", "src/b.rs", "c.rs", "d.rs", "e.rs"] }), "Edit a.rs, b.rs, c.rs +2");
  assert.equal(s("Grep", { glob: "*.ts" }), "Search *.ts");
  assert.equal(s("Grep", {}), "Search");
  assert.equal(s("Glob", { glob: "src/**/*.tsx" }), "Search *.tsx");
  assert.equal(s("WebFetch", { url: "https://www.docs.example.com/a?token=sk-ant-abcdefghijkl" }), "Fetch docs.example.com");
  assert.equal(s("WebFetch", { url: "not a url" }), "Browse");
  assert.equal(s("WebSearch", {}), "Web search");
  assert.equal(s("Task", { subagentType: "Explore" }), "Spawn Explore");
  assert.equal(s("Agent", {}), "Spawn agent");
  assert.equal(s("mcp__context7__query-docs", {}), "context7 · query-docs");
  assert.equal(s("mcp__codex_apps__github___fetch_file", {}), "codex_apps/github · fetch_file");
  assert.equal(s("TodoWrite", {}), "Update todos");
  assert.equal(s("read_directory", { path: "/x/secret/src" }), "List src");
  assert.equal(s("Bash", { command: "cd x && npm test" }), "$ npm test");
  assert.equal(s("codex_app__load_workspace_dependencies", {}), "Load workspace dependencies");
});

test("categories for all three agents", () => {
  const want = {
    Read: "read", Edit: "edit", Write: "edit", MultiEdit: "edit", NotebookEdit: "edit", Bash: "bash", Grep: "search",
    Glob: "search", WebFetch: "web", WebSearch: "web", Task: "agent", Agent: "agent", TodoWrite: "todo", Workflow: "agent",
    TaskCreate: "todo", TaskStop: "bash", ToolSearch: "search", "mcp__github__create_issue": "mcp", Skill: "other",
    read_file: "read", write_file: "edit", edit_file: "edit", shell_command: "bash", run_command: "bash",
    read_directory: "search", glob: "search", grep: "search", web_fetch: "web", web_search: "web", explore: "agent",
    agent: "agent", todo_write: "todo", read_multiple_files: "read",
    exec_command: "bash", shell: "bash", apply_patch: "edit", write_stdin: "bash", update_plan: "todo",
    spawn_agent: "agent", wait_agent: "agent", view_image: "read", web__run: "web", mcp__node_repl__js: "mcp",
    some_new_search_tool: "search", fetch_url_thing: "web", brand_new_tool: "other",
  };
  for (const [name, cat] of Object.entries(want)) assert.equal(R.categorize(name), cat, name);
  assert.equal(R.categorize(undefined), "other");
});

test("shell commands that only read or search get those animations", () => {
  assert.equal(R.shellCategory("sed -n '1,80p' src/lib.rs"), "read");
  assert.equal(R.shellCategory("sed -i 's/a/b/' src/lib.rs"), "bash");
  assert.equal(R.shellCategory("cd x && rg -n foo src"), "search");
  assert.equal(R.shellCategory("cat package.json | jq .name"), "read");
  assert.equal(R.shellCategory("curl -s https://example.com"), "web");
  assert.equal(R.shellCategory("git diff --stat"), "read");
  assert.equal(R.shellCategory("npm test"), "bash");
  assert.equal(R.shellCategory("npm run build"), "bash");
});

test("categories and labels for the newer agents' tools", () => {
  const want = {
    // Droid
    Execute: "bash", Create: "edit", LS: "search", FetchUrl: "web", ApplyPatch: "edit", ExitSpecMode: "todo",
    // Cursor
    Shell: "bash", StrReplace: "edit", Delete: "edit", SemanticSearch: "search", ReadLints: "read", UpdateCurrentStep: "todo", Await: "bash",
    // Gemini CLI / Qwen Code
    run_shell_command: "bash", replace: "edit", search_file_content: "search", grep_search: "search", list_directory: "search",
    google_web_search: "web", write_todos: "todo", read_many_files: "read", codebase_investigator: "agent", save_memory: "other",
    // opencode
    bash: "bash", list: "search", webfetch: "web", codesearch: "search", todowrite: "todo", question: "other", pty_read: "read",
  };
  for (const [name, cat] of Object.entries(want)) assert.equal(R.categorize(name), cat, name);
  assert.equal(R.toolSummary("Delete", "edit", { file: "/a/b/old.ts" }), "Delete old.ts");
  assert.equal(R.toolSummary("Create", "edit", { file: "/a/b/new.ts" }), "Write new.ts");
  assert.equal(R.toolSummary("question", "other", {}), "Question for you");
  assert.equal(R.toolSummary("save_memory", "other", {}), "Remember");
  assert.equal(R.toolSummary("Await", "bash", {}), "Wait");
  assert.equal(R.toolSummary("pty_spawn", "bash", {}), "Terminal");
});

test("program position: a quoted phrase, $(...) or a glob is never shown", () => {
  assert.equal(R.shellSummary('"PROMPT_CANARY_7731 my secret words here" arg'), "$ shell");
  assert.equal(R.shellSummary("$(echo PROMPT_CANARY_7731) --x"), "$ shell");
  assert.equal(R.shellSummary("`whoami` x"), "$ shell");
  assert.equal(R.shellSummary("./scripts/release.sh --tag v2"), "$ release.sh");
  assert.equal(R.shellSummary("python3.12 -m pytest -q"), "$ python -m pytest");
  // Skill calls: the skill's name, never what was passed to it.
  assert.equal(R.toolSummary("Skill", "other", { skill: "/review-pr 123 --token SECRETCANARY99" }), "Skill review-pr");
  assert.equal(R.toolSummary("Skill", "other", { skill: "frontend-design:frontend-design" }), "Skill frontend-design");
  assert.equal(R.toolSummary("Skill", "other", { skill: "$(curl x) y" }), "Use skill");
});

test("runs that execute no tests are not test runs; a chained test is judged by its output", () => {
  for (const c of ["pytest --collect-only -q", "pytest --co", "cargo test --no-run", "go test -c ./pkg", "jest --listTests", "bun test --help", "npx vitest --version", "npm test -- --listTests"]) {
    assert.equal(R.isTestCommand(c), false, c);
  }
  for (const c of ["pytest -q", "go test ./...", "cargo test", "npm run build && npm test"]) assert.equal(R.isTestCommand(c), true, c);
  assert.equal(R.testGuarded("npm run build && npm test"), true);
  assert.equal(R.testGuarded("cd web && npm test"), false, "cd/echo setup doesn't guard");
  assert.equal(R.testGuarded("npm test && npm run build"), false);
  const p = { guarded: true };
  assert.equal(R.testVerdict(p, true, "error TS2304: Cannot find name 'x'"), null, "the build broke, the tests never ran");
  assert.equal(R.testVerdict(p, true, "Tests: 2 failed, 40 passed"), "test_fail");
  assert.equal(R.testVerdict(p, false, ""), "test_pass");
  assert.equal(R.testVerdict({}, true, ""), "test_fail");
});

test("scrubText: paths keep their last segment, URLs their host, emails and secrets go", () => {
  assert.equal(R.scrubText("edit ~/Codes/secret-co/payroll.ts"), "edit payroll.ts");
  assert.equal(R.scrubText("see https://user:pw@git.internal.co/x?y=1 or mail a.b@c.io"), "see git.internal.co or mail •••");
  assert.equal(R.scrubText("token=hunter2hunter2"), "token=•••");
});
