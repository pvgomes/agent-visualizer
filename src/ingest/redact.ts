/*
 * Turns tool inputs into short labels that are safe to screen-record.
 * Nothing here ever passes prompt text, file contents, regexes or command
 * arguments through: a file becomes its basename, a URL its hostname, a shell
 * command its program plus (for tools that have them) one subcommand, so
 * `cd ~/x && FOO=1 npm run test:unit -- --grep "secret"` reads "$ npm run test:unit".
 * Also decides whether a shell command is a test run.
 */
import { SUMMARY_MAX, type ToolCategory } from "../shared/events.ts";
import { basename } from "./common.ts";

const MASK = "•••";

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk)-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{8,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{8,}/g,
  /\bglpat-[A-Za-z0-9_-]{8,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{12,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]*)?/g,
  /\b(?:npm|pypi|hf|dop|shpat|sq0atp|rnd)_[A-Za-z0-9_-]{12,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  // key=value / key: value where the key says it's a secret.
  /\b([A-Za-z0-9_-]*(?:token|secret|passw(?:or)?d|api[_-]?key|auth|credential|cookie|session)[A-Za-z0-9_-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
  // user:pass@host
  /\/\/[^/\s:@]+:[^/\s@]+@/g,
];

/** Mask anything that looks like a credential. */
export function redactSecrets(s: string): string {
  let out = s;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m, k, sep) => {
      if (typeof k === "string" && typeof sep === "string") return `${k}${sep}${MASK}`;
      if (m.startsWith("//")) return "//";
      return MASK;
    });
  }
  // Long hex runs (hashes, keys) and long opaque base64-ish runs with digits and letters mixed.
  out = out.replace(/\b[0-9a-fA-F]{24,}\b/g, MASK);
  out = out.replace(/[A-Za-z0-9+/_=-]{28,}/g, (m) =>
    (m.match(/\d/g)?.length ?? 0) >= 3 && (m.match(/[A-Za-z]/g)?.length ?? 0) >= 3 && !/^[a-z_]+$/i.test(m)
      ? MASK
      : m,
  );
  return out;
}

/** Strip control characters, collapse whitespace, cap at SUMMARY_MAX. */
export function clip(s: string, max = SUMMARY_MAX): string {
  const flat = s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length <= max ? flat : chars.slice(0, max - 1).join("").trimEnd() + "…";
}

export function safe(s: string, max = SUMMARY_MAX): string {
  return clip(redactSecrets(clip(s, 400)), max);
}

/**
 * Free text an agent wrote itself (MCP status, shout, flip reason) -> one safe
 * line: no paths (a path keeps its last segment), URLs (their host), emails or
 * secrets, <= SUMMARY_MAX. Used by the MCP server before writing a signal and
 * again by ingest before showing one, so a signal that skipped the server
 * (another writer, a sandbox's outbox) is held to the same rule.
 */
export function scrubText(v: unknown): string {
  if (typeof v !== "string") return "";
  let s = v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, 400);
  s = s.replace(/\b[a-z][a-z0-9+.-]*:\/\/([^\s/?#@]*@)?([^\s/?#:]+)[^\s]*/gi, (_m, _u, host: string) => host.replace(/^www\./, ""));
  s = s.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, MASK);
  s = s.replace(/(^|[\s("'`=])(?:~|[A-Za-z]:)?(?:[\\/][^\s\\/"'`)]+)+[\\/]?/g, (m, lead: string) => {
    const parts = m.slice(lead.length).split(/[\\/]+/).filter(Boolean);
    const last = parts[parts.length - 1] ?? "";
    return lead + (last === "~" ? "" : last);
  });
  s = redactSecrets(s).replace(/\s+/g, " ").trim();
  const chars = [...s];
  return chars.length <= SUMMARY_MAX ? s : chars.slice(0, SUMMARY_MAX - 1).join("").trimEnd() + "…";
}

/** "/Users/me/app/src/cli.ts" -> "cli.ts". */
export function fileLabel(p: unknown): string {
  if (typeof p !== "string" || !p.trim()) return "";
  const b = basename(p.trim().replace(/[\\/]+$/, ""));
  return safe(b, 40);
}

/** "https://docs.python.org/3/x?y" -> "docs.python.org". */
export function hostLabel(url: unknown): string {
  if (typeof url !== "string") return "";
  try {
    const u = new URL(url.trim());
    return safe(u.hostname.replace(/^www\./, ""), 48);
  } catch {
    return "";
  }
}

/** The last segment of a glob, "src/**\/*.tsx" -> "*.tsx". */
export function globLabel(g: unknown): string {
  if (typeof g !== "string" || !g.trim()) return "";
  const segs = g.trim().split(/[\\/]+/).filter(Boolean);
  const last = segs[segs.length - 1] ?? "";
  if (!last || last === "**") return "";
  return safe(last, 32);
}

/* ------------------------------------------------------------------ shell */

type Tok = { w: string; op?: false } | { w: string; op: true };

/** A small POSIX-ish lexer: words (quotes removed) and the operators && || ; | & and newlines. */
export function lexShell(src: string): Tok[] {
  const out: Tok[] = [];
  let cur = "";
  let has = false;
  const flush = () => {
    if (has) out.push({ w: cur });
    cur = "";
    has = false;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === "\\" && i + 1 < src.length) {
      if (src[i + 1] === "\n") {
        i++;
        continue;
      }
      cur += src[++i];
      has = true;
    } else if (c === "'") {
      const j = src.indexOf("'", i + 1);
      const end = j < 0 ? src.length : j;
      cur += src.slice(i + 1, end);
      has = true;
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < src.length) j++;
        j++;
      }
      cur += src.slice(i + 1, j).replace(/\\(["\\$`])/g, "$1");
      has = true;
      i = j;
    } else if (c === "$" && src[i + 1] === "(") {
      // Keep $(...) as part of the word; we never print it anyway.
      let depth = 0;
      let j = i + 1;
      for (; j < src.length; j++) {
        if (src[j] === "(") depth++;
        else if (src[j] === ")" && --depth === 0) break;
      }
      cur += src.slice(i, j + 1);
      has = true;
      i = j;
    } else if (c === "\n") {
      flush();
      out.push({ w: "\n", op: true });
    } else if (c === " " || c === "\t" || c === "\r") {
      flush();
    } else if (c === "#" && !has) {
      while (i + 1 < src.length && src[i + 1] !== "\n") i++;
    } else if (c === "&" || c === "|" || c === ";") {
      const two = src.slice(i, i + 2);
      if (c === "&" && src[i + 1] === ">") {
        // &> file : a redirect, not an operator.
        cur += "&>";
        has = true;
        i++;
        continue;
      }
      if (c === "&" && /[0-9>]$/.test(cur) && has) {
        // 2>&1
        cur += c;
        continue;
      }
      flush();
      if (two === "&&" || two === "||" || two === ";;") {
        out.push({ w: two, op: true });
        i++;
      } else {
        out.push({ w: c, op: true });
      }
    } else if (c === "(" || c === ")") {
      // Subshell parens separate words; $(...) was handled above.
      flush();
    } else if ((c === "{" || c === "}") && !has) {
      // Group braces: ignore. Inside a word (${VAR}) they are kept.
    } else {
      cur += c;
      has = true;
    }
  }
  flush();
  return out;
}

interface Segment {
  words: string[];
  /** Operator that follows this segment ("|", "&&", ...). */
  next?: string;
}

/** Split a command line into simple commands, skipping heredoc bodies. */
export function splitShell(src: string): Segment[] {
  const text = stripHeredocs(src);
  const segs: Segment[] = [];
  let words: string[] = [];
  for (const t of lexShell(text)) {
    if (t.op) {
      if (words.length) segs.push({ words, next: t.w });
      words = [];
    } else {
      words.push(t.w);
    }
  }
  if (words.length) segs.push({ words });
  return segs;
}

function stripHeredocs(src: string): string {
  if (!src.includes("<<")) return src;
  const lines = src.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    out.push(line);
    const m = line.match(/<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/);
    if (!m) continue;
    const delim = m[2]!;
    while (i + 1 < lines.length && lines[i + 1]!.trim() !== delim) i++;
    i++; // the delimiter line itself
  }
  return out.join("\n");
}

const NOISE = new Set([
  "cd", "pushd", "popd", "export", "set", "source", ".", "unset", "ulimit", "alias", "shopt",
  "trap", "umask", "true", ":", "local", "declare", "typeset", "eval",
]);
const WRAPPERS = new Set(["sudo", "doas", "env", "time", "nohup", "exec", "command", "builtin", "nice", "ionice", "caffeinate", "xvfb-run", "stdbuf", "chronic", "unbuffer", "timeout", "gtimeout", "dotenv"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "fish", "ksh"]);
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const REDIRECT = /^(\d*|&)(>>?|<<?<?|>&|<&)(.*)$/;

function progName(w: string): string {
  let b = basename(w);
  if (/^python[\d.]*$/.test(b)) b = "python";
  else if (/^pip[\d.]*$/.test(b)) b = "pip";
  else if (/^node[\d.]*$/.test(b) && b !== "nodemon") b = "node";
  return b;
}

/** Drop env assignments, wrappers (sudo, env, timeout 60 ...) and redirects; basename the program. */
export function normalizeWords(words: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  // Leading assignments and wrappers.
  for (; i < words.length; i++) {
    const w = words[i]!;
    if (ASSIGN.test(w)) continue;
    const p = progName(w);
    if (WRAPPERS.has(p)) {
      // Skip the wrapper's own flags and a numeric/duration argument (timeout 60, nice -n 10).
      while (i + 1 < words.length && (/^-/.test(words[i + 1]!) || /^\d+[smhd]?$/.test(words[i + 1]!) || ASSIGN.test(words[i + 1]!))) {
        const f = words[i + 1]!;
        i++;
        if ((p === "sudo" && /^-[ugCDhpRrT]$/.test(f)) || (p === "nice" && f === "-n") || (p === "timeout" && /^-[sk]$/.test(f))) i++;
      }
      continue;
    }
    break;
  }
  for (; i < words.length; i++) {
    const w = words[i]!;
    const r = w.match(REDIRECT);
    if (r && w !== "-" && !/^\d+$/.test(w)) {
      if (!r[3]) i++; // "> file": the target is the next word
      continue;
    }
    out.push(out.length === 0 ? progName(w) : w);
  }
  return out;
}

/** Programs whose first word argument is a subcommand worth showing. */
const SUBCOMMANDS = new Set(`
  git npm pnpm yarn bun npx bunx pnpx cargo go docker docker-compose podman kubectl helm gh brew
  pip uv poetry pipenv hatch pdm deno make just rake bundle rails mix dotnet swift flutter dart
  rustup nix turbo nx lerna vercel wrangler railway fly flyctl heroku netlify terraform tofu pulumi
  aws gcloud az systemctl launchctl apt apt-get yum dnf pacman apk conda mamba mvn gradle gradlew
  sbt lein stack cabal zig bazel meson vitest playwright prisma drizzle-kit supabase firebase expo
  eas pm2 composer php artisan tox nox jj hg svn ollama hf huggingface-cli
  openssl xcodebuild xcrun simctl adb kubectx minikube kind k3d vagrant packer ansible
  ansible-playbook tsc biome eslint prettier oxlint changeset release-it semantic-release
`.split(/\s+/).filter(Boolean));
/** Subcommands that take one more word worth showing ("npm run build"). */
const TWO_LEVEL: Record<string, Set<string>> = {
  npm: new Set(["run", "run-script", "exec", "x"]),
  pnpm: new Set(["run", "exec", "dlx", "x"]),
  yarn: new Set(["run", "exec", "dlx", "workspace"]),
  bun: new Set(["run", "x"]),
  docker: new Set(["compose", "buildx"]),
  gh: new Set(["pr", "issue", "run", "repo", "release", "workflow", "api"]),
  uv: new Set(["run", "pip", "tool"]),
  poetry: new Set(["run"]),
  pipenv: new Set(["run"]),
  bundle: new Set(["exec"]),
  cargo: new Set(["+nightly", "+stable"]),
};
const WORD = /^[A-Za-z][A-Za-z0-9:_+-]{0,30}$/;
/** What a program name in a label may look like (after basename). */
const PROG = /^[A-Za-z0-9_][A-Za-z0-9._+@-]{0,39}$/;

/** Leading word arguments. Stops at the first flag: a flag's value must never be shown. */
function firstWords(args: string[], n: number): string[] {
  const out: string[] = [];
  for (const a of args) {
    if (out.length >= n || a.startsWith("-") || !WORD.test(a)) break;
    out.push(a);
  }
  return out;
}

/** Keywords that open a compound command; what follows them is a command ("if npm test; then"). */
const LEAD_KEYWORDS = new Set(["do", "then", "else", "elif", "if", "while", "until", "!", "{"]);
/** Segments that are pure shell syntax ("for f in *.ts", "done"). */
const SYNTAX = new Set(["for", "case", "select", "done", "fi", "esac", "function", "}", "[", "[[", "test"]);

/** Every simple command in a shell line, normalized, with `bash -c "..."` unwrapped. */
export function simpleCommands(cmd: unknown, depth = 0): string[][] {
  const src = commandText(cmd);
  if (!src) return [];
  const out: string[][] = [];
  for (const s of splitShell(src)) {
    let w = normalizeWords(s.words);
    while (w.length && LEAD_KEYWORDS.has(w[0]!)) w = normalizeWords(w.slice(1));
    if (!w.length || SYNTAX.has(w[0]!)) continue;
    const inner = shellInner(w);
    if (inner !== undefined && depth < 2) {
      const sub = simpleCommands(inner, depth + 1);
      if (sub.length) {
        out.push(...sub);
        continue;
      }
    }
    out.push(w);
  }
  return out;
}

/** Commands that are rarely the point of a chain (`echo --- && cargo build`). */
const DULL = new Set(["echo", "printf", "sleep", "clear", "date", "wait"]);

/** The command a label should describe: a test run if there is one, else the first that isn't cd/echo. */
function pickCommand(cmd: unknown): string[] {
  const cmds = simpleCommands(cmd);
  return (
    cmds.find((w) => isTestWords(w)) ??
    cmds.find((w) => !NOISE.has(w[0]!) && !DULL.has(w[0]!)) ??
    cmds.find((w) => !NOISE.has(w[0]!)) ??
    cmds[0] ??
    []
  );
}

/** "cd x && FOO=1 sudo npm run test -- --grep y | tail" -> "$ npm run test". */
export function shellSummary(cmd: unknown): string {
  const words = pickCommand(cmd);
  // A quoted phrase, $(...) or a glob in program position is not a name worth showing.
  if (!words.length || !PROG.test(words[0]!)) return "$ shell";
  const prog = safe(words[0]!, 24);
  let label = prog;
  const args = words.slice(1);
  if (prog === "python" && args[0] === "-m" && args[1] && WORD.test(args[1])) {
    label = `python -m ${args[1]}`;
  } else if (prog === "node" && args.includes("--test")) {
    label = "node --test";
  } else if (SUBCOMMANDS.has(prog)) {
    const [sub, sub2] = firstWords(args, 2);
    if (sub) {
      label += " " + sub;
      if (sub2 && TWO_LEVEL[prog]?.has(sub)) label += " " + sub2;
    }
  }
  return safe("$ " + label);
}

const READ_PROGS = new Set(["cat", "bat", "head", "tail", "less", "more", "nl", "awk", "wc", "jq", "yq", "xxd", "hexdump", "od", "strings", "file", "stat", "diff", "cmp", "column", "sort", "uniq", "cut", "tac"]);
const SEARCH_PROGS = new Set(["rg", "grep", "egrep", "fgrep", "ag", "ack", "fd", "fdfind", "find", "locate", "tree", "ls", "eza", "exa", "lsd", "du"]);
const WEB_PROGS = new Set(["curl", "wget", "http", "https", "xh", "httpie"]);

/**
 * Which animation a shell command deserves. A shell call is "bash", but agents
 * (Codex especially) read and search through the shell too: `sed -n 1,80p f`
 * is reading, `rg foo` is searching, `curl` is the web. Test runs stay "bash".
 */
export function shellCategory(cmd: unknown): ToolCategory {
  const words = pickCommand(cmd);
  const prog = words[0];
  if (!prog || isTestWords(words)) return "bash";
  if (prog === "sed") return words.some((w) => w === "-i" || w.startsWith("--in-place") || /^-[a-z]*i/.test(w)) ? "bash" : "read";
  if (READ_PROGS.has(prog)) return "read";
  if (SEARCH_PROGS.has(prog)) return "search";
  if (WEB_PROGS.has(prog)) return "web";
  if (prog === "git" && /^(grep|ls-files)$/.test(words[1] ?? "")) return "search";
  if (prog === "git" && /^(show|log|blame|diff)$/.test(words[1] ?? "")) return "read";
  return "bash";
}

/** For `bash -lc "script"` return the script. */
function shellInner(words: string[]): string | undefined {
  if (!SHELLS.has(words[0]!)) return undefined;
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    if (/^-[a-z]*c[a-z]*$/.test(w)) return words[i + 1];
    if (!w.startsWith("-")) return undefined;
  }
  return undefined;
}

/** Commands come as a string, or an argv array (Codex `["bash","-lc","npm test"]`). */
export function commandText(cmd: unknown): string {
  if (typeof cmd === "string") return cmd;
  if (Array.isArray(cmd) && cmd.every((c) => typeof c === "string")) {
    const argv = cmd as string[];
    if (argv.length >= 3 && SHELLS.has(progName(argv[0]!)) && /^-[a-z]*c[a-z]*$/.test(argv[1]!)) return argv[2]!;
    return argv.map((a) => (/[\s"'$&|;<>]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a)).join(" ");
  }
  return "";
}

/* ------------------------------------------------------------- test runs */

const RUNNERS = new Set([
  "vitest", "jest", "mocha", "ava", "tap", "karma", "pytest", "py.test", "rspec", "phpunit", "pest",
  "tox", "nox", "ctest", "gotestsum", "nextest", "bats", "jasmine", "uvu", "cucumber-js", "behave",
]);
const PM = new Set(["npm", "pnpm", "yarn", "bun", "cnpm"]);
const PM_VALUE_FLAGS = new Set(["--filter", "-F", "--prefix", "-C", "--cwd", "--dir", "-w", "--workspace"]);
const TEST_SCRIPT = /(?:^|[:_-])(test|tests|spec|e2e)(?:$|[:_-])/;

function nonFlags(args: string[], valueFlags?: Set<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") break;
    if (a.startsWith("-")) {
      if (valueFlags?.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/** Flags that make a runner list, build or describe tests instead of running them. */
const NO_RUN = new Set([
  "--collect-only", "--co", "--no-run", "--listTests", "--list-tests", "--list", "--help", "-h", "--version",
  "--showConfig", "--show-config", "--fixtures", "--markers",
]);

function isTestWords(w: string[], depth = 0): boolean {
  if (!w.length || depth > 3) return false;
  const prog = w[0]!;
  const args = w.slice(1);
  if (args.some((a) => NO_RUN.has(a))) return false;
  const nf = nonFlags(args, PM.has(prog) ? PM_VALUE_FLAGS : undefined);
  if (RUNNERS.has(prog)) return true;
  if (PM.has(prog)) {
    // `yarn workspace <name> test`
    const [a, b] = prog === "yarn" && nf[0] === "workspace" ? nf.slice(2) : nf;
    if (a === "test" || a === "t" || a === "tst") return true;
    if ((a === "run" || a === "run-script") && b) return TEST_SCRIPT.test(b);
    if (a === "exec" || a === "dlx" || a === "x") return !!b && isTestWords([b, ...args.slice(args.indexOf(b) + 1)], depth + 1);
    return false;
  }
  if (prog === "npx" || prog === "bunx" || prog === "pnpx") {
    const i = args.findIndex((a) => !a.startsWith("-"));
    return i >= 0 && isTestWords(args.slice(i), depth + 1);
  }
  const [a, b] = nf;
  switch (prog) {
    case "python":
      return args[0] === "-m" && /^(pytest|unittest|nose2?|tox|nox)$/.test(args[1] ?? "");
    case "uv":
    case "poetry":
    case "pipenv":
    case "pdm":
    case "hatch":
      if (prog === "hatch" && a === "test") return true;
      if (a === "run") {
        const rest = args.slice(args.indexOf("run") + 1);
        const j = rest.findIndex((x) => !x.startsWith("-"));
        return j >= 0 && isTestWords(normalizeWords(rest.slice(j)), depth + 1);
      }
      return false;
    case "cargo":
      return a === "test" || a === "t" || a === "nextest" || (a === "llvm-cov" && b === "test");
    case "go":
      // `go test -c` compiles the test binary and runs nothing.
      return a === "test" && !args.includes("-c");
    case "bundle":
      return a === "exec" && !!b && isTestWords(args.slice(args.indexOf(b)), depth + 1);
    case "rails":
    case "rake":
      return a === "test" || a === "spec" || !!a?.startsWith("test:");
    case "playwright":
      return a === "test";
    case "cypress":
      return a === "run";
    case "make":
    case "just":
    case "task":
      return !!a && /^(test|tests|check|spec)([-_:].*)?$/.test(a);
    case "deno":
    case "swift":
    case "mix":
    case "dotnet":
    case "flutter":
    case "dart":
    case "zig":
    case "sbt":
    case "lein":
    case "stack":
    case "cabal":
    case "meson":
    case "gradle":
    case "gradlew":
    case "mvn":
    case "bazel":
    case "turbo":
    case "nx":
      if (prog === "mvn") return nf.some((x) => x === "test" || x === "verify");
      if (prog === "zig") return (a === "build" && b === "test") || a === "test";
      if (prog === "turbo") return a === "test" || (a === "run" && b === "test");
      if (prog === "nx") return a === "test" || (a === "run-many" && args.includes("test"));
      if (prog === "gradle" || prog === "gradlew") return nf.some((x) => /^(test|check)$|:test$/.test(x));
      return a === "test";
    case "node":
      return args.includes("--test");
    default:
      return false;
  }
}

/** Does any simple command in this shell line run a test suite? */
export function isTestCommand(cmd: unknown): boolean {
  return simpleCommands(cmd).some((w) => isTestWords(w));
}

/**
 * Is the test's own exit code hidden? `npm test | tail`, `npm test; echo $?` and
 * `npm test || true` all exit 0 when tests fail, so the output has to be read instead.
 */
export function testExitHidden(cmd: unknown): boolean {
  const src = commandText(cmd);
  if (!src) return false;
  const segs = splitShell(src);
  return segs.some((s, i) => i < segs.length - 1 && s.next !== "&&" && isTestWords(normalizeWords(s.words)));
}

/**
 * Does a real command run before the test in its && chain (`npm run build && npm test`)?
 * Then a non-zero exit may be the build's, and only the output can say the tests failed.
 * cd/export-style setup doesn't count.
 */
export function testGuarded(cmd: unknown): boolean {
  const src = commandText(cmd);
  if (!src) return false;
  const segs = splitShell(src);
  const i = segs.findIndex((s) => isTestWords(normalizeWords(s.words)));
  if (i <= 0) return false;
  for (let k = i - 1; k >= 0 && segs[k]!.next === "&&"; k--) {
    const w = normalizeWords(segs[k]!.words);
    if (w.length && !NOISE.has(w[0]!) && !DULL.has(w[0]!)) return true;
  }
  return false;
}

/**
 * The verdict for a finished test call: fail, pass, or nothing to say (a guarded
 * run that failed without any test failure in its output, e.g. the build broke).
 */
export function testVerdict(p: { guarded?: boolean }, failed: boolean, output: string): "test_fail" | "test_pass" | null {
  if (!failed) return "test_pass";
  if (p.guarded && !outputLooksFailed(output)) return null;
  return "test_fail";
}

/** Failure markers test runners print, for when the exit code can't be trusted. */
export function outputLooksFailed(text: string): boolean {
  if (!text) return false;
  const t = text.length > 400_000 ? text.slice(-400_000) : text;
  return (
    /\b([1-9]\d*)\s+(?:tests?\s+)?(failed|failing|failures?)\b/i.test(t) ||
    /^(?:\s*(?:FAIL|FAILED)\b|--- FAIL|not ok \d+)/m.test(t) ||
    /test result: FAILED/.test(t) ||
    /\bTests?:\s+[1-9]\d* failed/.test(t) ||
    /^# fail\s+[1-9]/m.test(t) ||
    /\bERR_TEST_FAILURE\b/.test(t)
  );
}

/* ---------------------------------------------------------- tool labels */

export interface ToolInput {
  file?: unknown;
  files?: unknown[];
  command?: unknown;
  url?: unknown;
  glob?: unknown;
  path?: unknown;
  subagentType?: unknown;
  skill?: unknown;
}

/** One label per tool call. `name` is the raw tool name, `input` already pulled out of the call. */
export function toolSummary(name: string, category: string, input: ToolInput): string {
  const n = name.toLowerCase();
  if (n.startsWith("mcp__")) return mcpSummary(name);
  // Shell calls keep their "$ prog" label whatever animation shellCategory picked.
  if (input.command !== undefined) return shellSummary(input.command);
  switch (category) {
    case "bash": {
      if (n === "write_stdin") return "$ stdin";
      if (n === "taskstop" || n === "killshell" || n === "kill_shell") return "Stop task";
      if (n === "taskoutput" || n === "bashoutput" || n === "bash_output") return "Check output";
      if (n === "wait" || n === "await") return "Wait";
      if (n.startsWith("monitor")) return "Monitor";
      if (n.startsWith("pty_")) return "Terminal";
      if (n === "aside_repl") return "REPL";
      return "$ shell";
    }
    case "read": {
      if (n === "view_image") return "View image";
      if (input.files?.length) return input.files.length === 1 ? withFile("Read", input.files[0]) : `Read ${input.files.length} files`;
      if (n === "read_multiple_files" || n === "read_many_files") return "Read files";
      if (n === "get_command_code_knowledge") return "Read docs";
      return withFile("Read", input.file);
    }
    case "edit": {
      const verb = /^(write|write_file|create_file|create)$/.test(n) ? "Write" : /^(delete|delete_file)$/.test(n) ? "Delete" : "Edit";
      if (input.files?.length) {
        const names = [...new Set(input.files.map(fileLabel).filter(Boolean))];
        if (names.length) {
          const shown = names.slice(0, 3).join(", ");
          return safe(`${verb} ${shown}${names.length > 3 ? ` +${names.length - 3}` : ""}`);
        }
      }
      return withFile(verb, input.file);
    }
    case "search": {
      if (/^(ls|list|read_directory|read_dir|list_directory|list_dir|list_files)$/.test(n)) {
        const d = fileLabel(input.path);
        return d ? `List ${d}` : "List files";
      }
      if (n === "toolsearch") return "Find tools";
      if (n === "lsp") return "Code lookup";
      const g = globLabel(input.glob);
      return g ? safe(`Search ${g}`) : "Search";
    }
    case "web": {
      if (/search/.test(n)) return "Web search";
      const h = hostLabel(input.url);
      return h ? safe(`Fetch ${h}`) : "Browse";
    }
    case "agent": {
      if (/^(task|agent)$/.test(n)) {
        const t = typeof input.subagentType === "string" && input.subagentType ? input.subagentType : "agent";
        return safe(`Spawn ${t}`, 40);
      }
      if (n === "explore") return "Spawn explorer";
      if (n === "spawn_agent") return "Spawn agent";
      if (n === "wait_agent") return "Wait for agents";
      if (n === "workflow") return "Run workflow";
      if (n === "list_agents") return "List agents";
      if (n === "interrupt_agent" || n === "close_agent") return "Stop agent";
      if (n === "subagenthandback" || n === "agent_output") return "Hand back";
      return "Message agent";
    }
    case "todo":
      if (/plan/.test(n)) return "Update plan";
      if (/goal/.test(n)) return "Check goal";
      if (/^task/.test(n)) return "Update tasks";
      return "Update todos";
    default: {
      if (/^cron/.test(n)) return "Schedule";
      if (n === "config") return "Settings";
      if (/image_?gen/.test(n)) return "Generate image";
      if (n === "skill" || n === "activate_skill") {
        // The first word, without a leading slash or plugin prefix: "/review-pr 123 --x" -> "review-pr".
        const first = typeof input.skill === "string" ? input.skill.trim().split(/\s+/)[0]!.replace(/^\/+/, "") : "";
        const s = first.split(":").pop() ?? "";
        return /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(s) ? safe(`Skill ${s}`, 40) : "Use skill";
      }
      if (n === "askuserquestion" || n === "ask_user_question" || n === "ask_user" || n === "question") return "Question for you";
      if (n === "save_memory" || n === "memory") return "Remember";
      if (n === "structuredoutput") return "Report";
      if (n === "taste") return "Learn taste";
      if (n === "sleep") return "Sleep";
      return humanize(name);
    }
  }
}

/** "codex_app__load_workspace_dependencies" -> "Load workspace dependencies". */
function humanize(name: string): string {
  const leaf = name.split("__").filter(Boolean).pop() ?? name;
  const words = leaf.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return words ? safe(words[0]!.toUpperCase() + words.slice(1), 40) : "Tool";
}

function withFile(verb: string, file: unknown): string {
  const f = fileLabel(file);
  return f ? safe(`${verb} ${f}`) : verb;
}

/** "mcp__context7__query-docs" -> "context7 · query-docs". */
export function mcpSummary(name: string): string {
  const rest = name.replace(/^mcp__/, "");
  // The tool is what follows the last run of 2+ underscores ("codex_apps__github___fetch_file").
  const m = rest.match(/^(.*[^_])_{2,}([^_].*)$/);
  if (!m) return safe(rest, 48);
  return safe(`${m[1]!.replace(/_{2,}/g, "/")} · ${m[2]}`);
}
