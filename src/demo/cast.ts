/*
 * Who works in the demo office: the projects they're on, the files and
 * commands those projects have, how each agent names its tools and models,
 * and the sandboxes some of them run in. All of it is invented; nothing here
 * comes from a real transcript or a real sandbox.
 */
import type { AgentKind, Host, ToolCategory } from "../shared/events.ts";

export interface Project {
  name: string;
  /** Files read and edited, as basenames. */
  files: string[];
  /** Test files, read while fixing a failure. */
  testFiles: string[];
  /** Files an agent might create. */
  newFiles: string[];
  /** The test command, program + subcommand only. */
  test: string;
  /** Other commands: lint, build, git. */
  bash: string[];
  globs: string[];
  /** Domains for web fetches. */
  docs: string[];
}

export const PROJECTS: Record<string, Project> = {
  "api-gateway": {
    name: "api-gateway",
    files: ["router.ts", "rate-limit.ts", "auth.ts", "middleware.ts", "server.ts", "config.ts", "upstream.ts"],
    testFiles: ["router.test.ts", "rate-limit.test.ts"],
    newFiles: ["circuit-breaker.ts", "retry.ts"],
    test: "$ pnpm test",
    bash: ["$ pnpm lint", "$ pnpm tsc", "$ git diff", "$ git status"],
    globs: ["*.ts", "src/routes/**", "*.test.ts"],
    docs: ["developer.mozilla.org", "nodejs.org", "fastify.dev"],
  },
  "payments-svc": {
    name: "payments-svc",
    files: ["ledger.go", "refund.go", "webhook.go", "idempotency.go", "stripe.go", "money.go"],
    testFiles: ["ledger_test.go", "refund_test.go"],
    newFiles: ["reconcile.go", "outbox.go"],
    test: "$ go test",
    bash: ["$ go vet", "$ go build", "$ golangci-lint run", "$ git diff"],
    globs: ["*.go", "internal/**", "*_test.go"],
    docs: ["pkg.go.dev", "stripe.com", "go.dev"],
  },
  tplay: {
    name: "tplay",
    files: ["decoder.rs", "render.rs", "main.rs", "audio.rs", "term.rs", "lib.rs"],
    testFiles: ["render.rs", "tests.rs"],
    newFiles: ["sixel.rs", "dither.rs"],
    test: "$ cargo test",
    bash: ["$ cargo clippy", "$ cargo build", "$ cargo fmt", "$ git diff"],
    globs: ["*.rs", "src/**", "Cargo.toml"],
    docs: ["docs.rs", "crates.io", "doc.rust-lang.org"],
  },
  "GA-task": {
    name: "GA-task",
    files: ["convert.py", "palette.py", "dither.py", "cli.py", "glyphs.py", "pyproject.toml"],
    testFiles: ["test_convert.py", "test_palette.py"],
    newFiles: ["braille.py", "edges.py"],
    test: "$ pytest",
    bash: ["$ ruff check", "$ uv sync", "$ mypy", "$ git status"],
    globs: ["*.py", "tests/**", "src/ga_task/**"],
    docs: ["docs.python.org", "pillow.readthedocs.io", "pypi.org"],
  },
  portfolio: {
    name: "portfolio",
    files: ["page.tsx", "Hero.tsx", "layout.tsx", "Projects.tsx", "globals.css", "next.config.ts"],
    testFiles: ["Hero.test.tsx", "page.test.tsx"],
    newFiles: ["Marquee.tsx", "og-image.tsx"],
    test: "$ pnpm test",
    bash: ["$ pnpm build", "$ pnpm lint", "$ git diff", "$ git status"],
    globs: ["*.tsx", "app/**", "components/**"],
    docs: ["nextjs.org", "react.dev", "tailwindcss.com"],
  },
  "docs-site": {
    name: "docs-site",
    files: ["index.mdx", "sidebar.ts", "search.ts", "astro.config.mjs", "Header.astro", "quickstart.mdx"],
    testFiles: ["search.test.ts", "links.test.ts"],
    newFiles: ["changelog.mdx", "Callout.astro"],
    test: "$ npm test",
    bash: ["$ npm run", "$ npx astro", "$ git diff", "$ git status"],
    globs: ["*.mdx", "src/content/**", "*.astro"],
    docs: ["docs.astro.build", "developer.mozilla.org", "web.dev"],
  },
  Onboarding: {
    name: "Onboarding",
    files: ["train.py", "features.py", "loader.py", "eval.py", "config.yaml", "model.py"],
    testFiles: ["test_features.py", "test_loader.py"],
    newFiles: ["schedule.py", "metrics.py"],
    test: "$ pytest",
    bash: ["$ ruff check", "$ uv run", "$ nvidia-smi", "$ git diff"],
    globs: ["*.py", "pipelines/**", "configs/**"],
    docs: ["pytorch.org", "huggingface.co", "arxiv.org"],
  },
  "search-api": {
    name: "search-api",
    files: ["query.ts", "index.ts", "ranker.ts", "tokenizer.ts", "cache.ts", "schema.ts"],
    testFiles: ["ranker.test.ts", "query.test.ts"],
    newFiles: ["synonyms.ts", "highlight.ts"],
    test: "$ bun test",
    bash: ["$ bun run", "$ bunx tsc", "$ git diff", "$ git status"],
    globs: ["*.ts", "src/**", "*.test.ts"],
    docs: ["bun.sh", "developer.mozilla.org", "elastic.co"],
  },
  "incidents-check": {
    name: "incidents-check",
    files: ["proxy.rs", "lru.rs", "headers.rs", "config.rs", "main.rs", "purge.rs"],
    testFiles: ["lru.rs", "integration.rs"],
    newFiles: ["stale.rs", "metrics.rs"],
    test: "$ cargo test",
    bash: ["$ cargo clippy", "$ cargo bench", "$ git diff", "$ git status"],
    globs: ["*.rs", "src/**", "benches/**"],
    docs: ["docs.rs", "httpwg.org", "tokio.rs"],
  },
  infra: {
    name: "infra",
    files: ["main.tf", "variables.tf", "outputs.tf", "vpc.tf", "iam.tf", "dns.tf"],
    testFiles: ["main.tftest.hcl", "vpc.tftest.hcl"],
    newFiles: ["alarms.tf", "backup.tf"],
    test: "$ terraform test",
    bash: ["$ terraform validate", "$ terraform plan", "$ tflint", "$ git diff"],
    globs: ["*.tf", "modules/**", "envs/**"],
    docs: ["registry.terraform.io", "docs.aws.amazon.com", "developer.hashicorp.com"],
  },
  "ios-app": {
    name: "ios-app",
    files: ["ContentView.swift", "FeedModel.swift", "APIClient.swift", "Theme.swift", "AppDelegate.swift"],
    testFiles: ["FeedModelTests.swift", "APIClientTests.swift"],
    newFiles: ["Haptics.swift", "Paywall.swift"],
    test: "$ swift test",
    bash: ["$ swift build", "$ swiftlint", "$ xcodebuild", "$ git diff"],
    globs: ["*.swift", "Sources/**", "Tests/**"],
    docs: ["developer.apple.com", "swift.org", "swiftpackageindex.com"],
  },
  "cli-kit": {
    name: "cli-kit",
    files: ["args.ts", "prompt.ts", "spinner.ts", "color.ts", "index.ts", "table.ts"],
    testFiles: ["args.test.ts", "table.test.ts"],
    newFiles: ["progress.ts", "tree.ts"],
    test: "$ npm test",
    bash: ["$ npm run", "$ npx tsc", "$ git diff", "$ git status"],
    globs: ["*.ts", "src/**", "examples/**"],
    docs: ["nodejs.org", "npmjs.com", "github.com"],
  },
  "chat-bot": {
    name: "chat-bot",
    files: ["handler.ts", "intents.ts", "slack.ts", "memory.ts", "prompts.ts", "index.ts"],
    testFiles: ["intents.test.ts", "handler.test.ts"],
    newFiles: ["threads.ts", "reactions.ts"],
    test: "$ vitest run",
    bash: ["$ pnpm build", "$ pnpm lint", "$ git diff", "$ git status"],
    globs: ["*.ts", "src/**", "test/**"],
    docs: ["api.slack.com", "nodejs.org", "vitest.dev"],
  },
  "data-etl": {
    name: "data-etl",
    files: ["extract.py", "transform.py", "load.py", "schema.sql", "dag.py", "settings.py"],
    testFiles: ["test_transform.py", "test_load.py"],
    newFiles: ["dedupe.py", "backfill.py"],
    test: "$ pytest",
    bash: ["$ ruff check", "$ dbt run", "$ uv run", "$ git diff"],
    globs: ["*.py", "dags/**", "models/**"],
    docs: ["docs.getdbt.com", "airflow.apache.org", "duckdb.org"],
  },
  "auth-svc": {
    name: "auth-svc",
    files: ["session.go", "oauth.go", "jwt.go", "store.go", "handlers.go", "main.go"],
    testFiles: ["jwt_test.go", "oauth_test.go"],
    newFiles: ["passkeys.go", "audit.go"],
    test: "$ go test",
    bash: ["$ go vet", "$ go build", "$ golangci-lint run", "$ git status"],
    globs: ["*.go", "internal/**", "*_test.go"],
    docs: ["pkg.go.dev", "oauth.net", "datatracker.ietf.org"],
  },
  "game-jam": {
    name: "game-jam",
    files: ["player.gd", "level.gd", "enemy.gd", "hud.gd", "main.tscn", "project.godot"],
    testFiles: ["test_player.gd", "test_level.gd"],
    newFiles: ["boss.gd", "particles.gd"],
    test: "$ godot --headless",
    bash: ["$ git diff", "$ git status", "$ gdlint", "$ gdformat"],
    globs: ["*.gd", "scenes/**", "assets/**"],
    docs: ["docs.godotengine.org", "itch.io", "github.com"],
  },
};

export interface Toolset {
  tools: Record<Exclude<ToolCategory, "mcp" | "other">, string> & { write: string; glob: string };
  web: string[];
  todoSummary: string;
}

export const TOOLSETS: Record<AgentKind, Toolset> = {
  claude: {
    tools: {
      read: "Read", edit: "Edit", write: "Write", bash: "Bash", search: "Grep", glob: "Glob",
      web: "WebFetch", agent: "Agent", todo: "TodoWrite",
    },
    web: ["WebFetch", "WebSearch"],
    todoSummary: "Update todos",
  },
  commandcode: {
    tools: {
      read: "read_file", edit: "edit_file", write: "write_file", bash: "shell_command", search: "grep",
      glob: "glob", web: "web_fetch", agent: "agent", todo: "todo_write",
    },
    web: ["web_fetch", "web_search"],
    todoSummary: "Update todos",
  },
  codex: {
    tools: {
      read: "exec_command", edit: "apply_patch", write: "apply_patch", bash: "exec_command",
      search: "exec_command", glob: "exec_command", web: "web_search", agent: "spawn_agent", todo: "update_plan",
    },
    web: ["web_search"],
    todoSummary: "Update plan",
  },
  opencode: {
    tools: {
      read: "read", edit: "edit", write: "write", bash: "bash", search: "grep", glob: "glob",
      web: "webfetch", agent: "task", todo: "todowrite",
    },
    web: ["webfetch"],
    todoSummary: "Update todos",
  },
  droid: {
    tools: {
      read: "Read", edit: "Edit", write: "Create", bash: "Execute", search: "Grep", glob: "Glob",
      web: "FetchUrl", agent: "Task", todo: "TodoWrite",
    },
    web: ["FetchUrl", "WebSearch"],
    todoSummary: "Update todos",
  },
  gemini: {
    tools: {
      read: "read_file", edit: "replace", write: "write_file", bash: "run_shell_command", search: "search_file_content",
      glob: "glob", web: "web_fetch", agent: "delegate_to_agent", todo: "write_todos",
    },
    web: ["web_fetch", "google_web_search"],
    todoSummary: "Update todos",
  },
  qwen: {
    tools: {
      read: "read_file", edit: "edit", write: "write_file", bash: "run_shell_command", search: "grep_search",
      glob: "glob", web: "web_fetch", agent: "task", todo: "todo_write",
    },
    web: ["web_fetch", "web_search"],
    todoSummary: "Update todos",
  },
  cursor: {
    tools: {
      read: "read_file", edit: "edit_file", write: "edit_file", bash: "run_terminal_cmd", search: "grep",
      glob: "glob_file_search", web: "web_search", agent: "task", todo: "todo_write",
    },
    web: ["web_search"],
    todoSummary: "Update todos",
  },
  copilot: {
    tools: {
      read: "view", edit: "edit", write: "create", bash: "bash", search: "rg",
      glob: "glob", web: "web_fetch", agent: "task", todo: "update_todo",
    },
    web: ["web_fetch", "web_search"],
    todoSummary: "Update todos",
  },
};

export const MODELS: Record<AgentKind, string[]> = {
  claude: ["claude-opus-5-5", "claude-sonnet-5-5"],
  commandcode: ["deepseek/deepseek-v4-pro", "moonshotai/Kimi-K3", "zai-org/GLM-5.2"],
  codex: ["gpt-5.6-sol", "gpt-5.5", "gpt-5.3-codex-spark"],
  opencode: ["anthropic/claude-sonnet-5-5", "openai/gpt-5.5", "zai-org/GLM-5.2"],
  droid: ["claude-opus-5-5", "gpt-5.5"],
  gemini: ["gemini-3-pro", "gemini-3-flash"],
  qwen: ["qwen3.5-coder-plus", "qwen3-coder-flash"],
  cursor: ["composer-2", "claude-sonnet-5-5"],
  copilot: ["claude-sonnet-5.5", "gpt-5.5"],
};

/** MCP calls as [server, tool]; summaries read "github.get_issue". */
export const MCP_CALLS: readonly (readonly [string, string])[] = [
  ["github", "get_issue"],
  ["github", "create_pull_request"],
  ["linear", "get_issue"],
  ["sentry", "get_event"],
  ["postgres", "query"],
  ["figma", "get_frame"],
];

export const ERRORS = ["API overloaded", "Request interrupted", "Rate limited, retrying", "Tool timed out"];

export const INTERN_ROLES: readonly (readonly [string, number])[] = [
  ["Explore", 5],
  ["general-purpose", 3],
  ["Plan", 2],
];

/** Who's in the office when the demo opens; `agent` is a preference, --agents may remap it. */
export interface Seat {
  project: string;
  agent: AgentKind;
  model: number;
  opening?: "hero" | "interns";
  /** Key into DEMO_HOSTS: this worker runs in a sandbox. */
  host?: string;
}

/** The sandboxes of the demo: Vercel ones, and incidents-check on Railway, with the home dir their images use. */
export const DEMO_HOSTS: Record<string, { host: Host; home: string }> = {
  devops: { host: { kind: "vercel", id: "vercel:devops", name: "devops" }, home: "/vercel/sandbox" },
  "ai-agents": { host: { kind: "vercel", id: "vercel:ai-agents", name: "ai-agents" }, home: "/vercel/sandbox" },
  "incidents-check": { host: { kind: "railway", id: "railway:8c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f", name: "incidents-check" }, home: "/root" },
  website: { host: { kind: "vercel", id: "vercel:website", name: "website" }, home: "/vercel/sandbox" },
};

/** Who walks in as the demo opens, one desk per agent; `agent` is a preference, --agents may remap it. */
export const OPENING_CAST: Seat[] = [
  { project: "api-gateway", agent: "claude", model: 0, opening: "hero" },
  { project: "payments-svc", agent: "cursor", model: 0, opening: "interns" },
  { project: "portfolio", agent: "claude", model: 1 },
  { project: "Onboarding", agent: "cursor", model: 1 },
  { project: "GA-task", agent: "cursor", model: 0 },
  { project: "data-etl", agent: "claude", model: 0 },
  { project: "docs-site", agent: "cursor", model: 1 },
  { project: "auth-svc", agent: "claude", model: 1 },
];

/** In the cloud from the start: two agents in the devops sandbox, one in each of the others. */
export const REMOTE_CAST: Seat[] = [
  { project: "search-api", agent: "claude", model: 0, host: "devops" },
  { project: "infra", agent: "cursor", model: 1, host: "devops" },
  { project: "game-jam", agent: "claude", model: 1, host: "ai-agents" },
  { project: "incidents-check", agent: "cursor", model: 1, host: "incidents-check" },
  { project: "chat-bot", agent: "claude", model: 0, host: "website" },
];

/** Status lines agents set through the office MCP server: [emoji, text]. */
export const MOODS: readonly (readonly [string, string])[] = [
  ["🧠", "deep in the auth refactor"],
  ["🔎", "hunting a flaky test"],
  ["☕", "waiting on CI"],
  ["🧹", "deleting dead code"],
  ["🔥", "perf pass on the hot path"],
  ["🧪", "writing the missing tests"],
  ["🎯", "one bug left"],
  ["📦", "cutting a release"],
];

/** Posts to the office TV after a green run. */
export const SHOUTS = ["shipped v2 🚀", "all green ✅", "p99 down 40% 📉", "migration done 🎉", "zero lint errors ✨", "PR is up 👀"];

/** Why an agent flipped its own table. */
export const FLIP_REASONS = ["this cache is haunted", "flaky test, again", "who wrote this regex", "works on my sandbox"];
