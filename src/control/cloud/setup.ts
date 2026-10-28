/*
 * "Bring my setup", there: applying a SetupBundle (src/control/setup.ts) to a
 * sandbox or ssh box, through three things every driver has:
 *
 *   run        a script with a deadline (its output comes back)
 *   upload     a tar of plain files into a folder there: Vercel's file upload,
 *              Daytona's upload-v2 then `tar xzf`, or a `tar xzf -` fed on the
 *              exec channel's stdin (Railway's bridge, ssh)
 *   runSecret  a script whose environment carries values (Daytona's per-command
 *              envs, Vercel's command env, Railway's bridge env, ssh's stdin):
 *              they are never on a command line, never in a log
 *
 * One probe reads $HOME and the agent's own config files there (base64, so
 * nothing in them can break the framing). The merges happen here, in memory,
 * and the merged files go back 0600 through runSecret: ~/.claude.json
 * (mcpServers, the project's local servers and .mcp.json choices,
 * hasCompletedOnboarding, the API key's approval), ~/.claude/settings.json,
 * ~/.codex/config.toml ([mcp_servers.*] appended), ~/.codex/auth.json, and
 * the project's .env files. Plain files (instructions, skills) land in a
 * 0700 staging folder first and move into place; outside a sandbox the office
 * created, a file that's already there is kept. The project goes into the
 * working folder, and only into an empty one outside office sandboxes.
 */
import { randomBytes } from "node:crypto";
import { shQuote } from "../../remote/source.ts";
import { scrubMessage } from "../../remote/util.ts";
import { hasMcpServer } from "../toml.ts";
import type { TarEntry } from "../tar.ts";
import { ControlError, type SetupApplied, type SetupBundle } from "../types.ts";
import { RUN_DIR } from "./launch.ts";

export interface SetupTransport {
  where: string;
  /** An office sandbox: overwrite what's there. Elsewhere only missing files and entries are added. */
  ours: boolean;
  /** The working folder there (absolute). */
  cwd: string;
  run(script: string, o: { timeoutMs: number }): Promise<string>;
  runSecret(script: string, env: Record<string, string>, o: { timeoutMs: number }): Promise<string>;
  /** Extract these entries into `dir` (absolute, already there). */
  upload(entries: TarEntry[], dir: string, o: { home: string; timeoutMs: number }): Promise<void>;
}

const PROBE_MS = 30_000;
const UPLOAD_MS = 10 * 60_000;
const SECRET_CHUNK = 96 << 10;
/** Claude records an approved key by its last 20 characters (customApiKeyResponses.approved). */
export const KEY_TAIL = 20;

/* --------------------------------------------------------------- merges */

const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

export class UnreadableConfig extends Error {}

/** ~/.claude.json there, with the bundle's entries added (or, in an office sandbox, set). */
export function mergeClaudeJson(text: string | undefined, c: NonNullable<SetupBundle["claude"]> | undefined, o: { cwd: string; over: boolean; keyTail?: string }): string {
  let j: Record<string, unknown> = {};
  if (text && text.trim()) {
    try {
      j = obj(JSON.parse(text)) ?? {};
    } catch {
      throw new UnreadableConfig("~/.claude.json there doesn't parse");
    }
  }
  const put = (t: Record<string, unknown>, k: string, v: unknown) => {
    if (o.over || t[k] === undefined) t[k] = v;
  };
  if (c?.onboarding && j.hasCompletedOnboarding === undefined) j.hasCompletedOnboarding = true;
  const servers = Object.entries(c?.mcpServers ?? {});
  if (servers.length) {
    const m = obj(j.mcpServers) ?? {};
    for (const [n, v] of servers) put(m, n, v);
    j.mcpServers = m;
  }
  const local = Object.entries(c?.projectMcpServers ?? {});
  const flags = Object.entries(c?.projectFlags ?? {});
  if (local.length || flags.length) {
    const projects = obj(j.projects) ?? {};
    const p = obj(projects[o.cwd]) ?? {};
    if (local.length) {
      const m = obj(p.mcpServers) ?? {};
      for (const [n, v] of local) put(m, n, v);
      p.mcpServers = m;
    }
    for (const [k, v] of flags) put(p, k, v);
    projects[o.cwd] = p;
    j.projects = projects;
  }
  if (o.keyTail) {
    const r = obj(j.customApiKeyResponses) ?? {};
    const approved = Array.isArray(r.approved) ? r.approved.filter((x) => typeof x === "string") : [];
    const rejected = Array.isArray(r.rejected) ? r.rejected.filter((x) => typeof x === "string" && x !== o.keyTail) : [];
    if (!approved.includes(o.keyTail)) approved.push(o.keyTail);
    j.customApiKeyResponses = { ...r, approved, rejected };
  }
  return JSON.stringify(j, null, 2) + "\n";
}

/** ~/.claude/settings.json there: ours where there is none; otherwise only the top-level keys it lacks. */
export function mergeSettings(text: string | undefined, settings: Record<string, unknown>, over: boolean): string {
  let j: Record<string, unknown> = {};
  if (text && text.trim()) {
    try {
      j = obj(JSON.parse(text)) ?? {};
    } catch {
      throw new UnreadableConfig("~/.claude/settings.json there doesn't parse");
    }
  }
  for (const [k, v] of Object.entries(settings)) if (over || j[k] === undefined) j[k] = v;
  return JSON.stringify(j, null, 2) + "\n";
}

/** config.toml there with the servers it doesn't define yet appended. */
export function mergeCodexToml(text: string | undefined, servers: { name: string; toml: string }[]): { text: string; added: string[]; kept: string[] } {
  let out = text ?? "";
  const added: string[] = [];
  const kept: string[] = [];
  for (const s of servers) {
    if (hasMcpServer(out, s.name)) {
      kept.push(s.name);
      continue;
    }
    out = `${out}${out && !out.endsWith("\n") ? "\n" : ""}${out ? "\n" : ""}${s.toml}`;
    added.push(s.name);
  }
  return { text: out, added, kept };
}

/* ---------------------------------------------------------------- probe */

interface Probe {
  home: string;
  tar: boolean;
  /** name -> its text; absent: no such file. */
  files: Record<string, string | undefined>;
  /** There, but it couldn't be read (permissions, no base64): never treated as empty, never overwritten. */
  unreadable: Set<string>;
  cwdEmpty: boolean;
}

export function probeScript(cwd: string): string {
  return [
    `printf 'home=%s\\n' "$HOME"`,
    `command -v tar >/dev/null 2>&1 && echo tar=1`,
    `if [ -d ${shQuote(cwd)} ] && [ -z "$(ls -A ${shQuote(cwd)} 2>/dev/null)" ]; then echo empty=1; fi`,
    ":",
  ].join("\n");
}

/** The agent's config files there (name -> path expression), base64 so nothing in them can break the framing. */
export function readScript(names: Record<string, string>): string {
  const lines: string[] = [];
  for (const [name, path] of Object.entries(names)) {
    lines.push(
      `if [ -e ${path} ]; then if [ -f ${path} ] && [ -r ${path} ] && b=$(base64 < ${path} 2>/dev/null); then printf 'file:${name}=%s\\n' "$(printf '%s' "$b" | tr -d '\\n\\r ')"; else echo 'unreadable:${name}'; fi; fi`,
    );
  }
  lines.push(":");
  return lines.join("\n");
}

export function parseProbe(out: string): Probe {
  const p: Probe = { home: "", tar: false, files: {}, unreadable: new Set(), cwdEmpty: false };
  for (const line of out.split("\n")) {
    if (line.startsWith("home=")) p.home = line.slice(5).trim();
    else if (line.trim() === "tar=1") p.tar = true;
    else if (line.trim() === "empty=1") p.cwdEmpty = true;
    else if (line.startsWith("unreadable:")) p.unreadable.add(line.slice(11).trim());
    else if (line.startsWith("file:")) {
      const i = line.indexOf("=");
      if (i > 5) p.files[line.slice(5, i)] = Buffer.from(line.slice(i + 1).trim(), "base64").toString("utf8");
    }
  }
  return p;
}

/** The same JSON, ignoring formatting: nothing to write. */
function sameJson(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  try {
    return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------- apply */

interface SecretFile {
  path: string;
  content: string;
  label: string;
}

/** Writes each file 0600 from its own variable; the values never leave the environment. */
function secretScript(files: { path: string; var: string }[]): string {
  const lines = ["umask 077", "ok=0"];
  for (const f of files) {
    const p = shQuote(f.path);
    lines.push(`mkdir -p "$(dirname ${p})" && printf '%s' "$${f.var}" > ${p}.ao-tmp && chmod 600 ${p}.ao-tmp && mv -f ${p}.ao-tmp ${p} && ok=$((ok+1))`);
  }
  lines.push(`echo "wrote=$ok"`);
  return lines.join("\n");
}

async function writeSecrets(t: SetupTransport, files: SecretFile[]): Promise<number> {
  let n = 0;
  let batch: SecretFile[] = [];
  let size = 0;
  const flush = async () => {
    if (!batch.length) return;
    const env: Record<string, string> = {};
    const refs = batch.map((f, i) => {
      env[`AO_SETUP_${i}`] = f.content;
      return { path: f.path, var: `AO_SETUP_${i}` };
    });
    const out = await t.runSecret(secretScript(refs), env, { timeoutMs: 60_000 });
    n += Number(/wrote=(\d+)/.exec(out)?.[1] ?? 0);
    batch = [];
    size = 0;
  };
  for (const f of files) {
    const len = Buffer.byteLength(f.content);
    if (size + len > SECRET_CHUNK) await flush();
    batch.push(f);
    size += len;
  }
  await flush();
  return n;
}

/** Plain files under $HOME: through a 0700 staging folder, then moved (kept when present, outside office sandboxes). */
function placeScript(stage: string, over: boolean): string {
  const s = shQuote(stage);
  return [
    `umask 077; s=${s}; [ -d "$s" ] || exit 0; cd "$s" || exit 1`,
    `find . \\( -type f -o -type l \\) | while IFS= read -r f; do r="\${f#./}"; d="$HOME/$r"; if ${over ? "true" : `[ ! -e "$d" ] && [ ! -L "$d" ]`}; then { mkdir -p "$(dirname "$d")" && mv -f "$f" "$d" && echo moved; } || echo failed; else echo kept; fi; done`,
    `cd / && rm -rf "$s"; :`,
  ].join("\n");
}

const sid = () => randomBytes(6).toString("hex");

export async function bringSetup(t: SetupTransport, b: SetupBundle, secrets: Record<string, string>, progress: (detail: string) => void): Promise<SetupApplied> {
  const skipped: string[] = [];
  const claude = b.agent === "claude";
  const codex = b.agent === "codex";
  progress("Looking at the sandbox…");
  const probe = parseProbe(await t.run(probeScript(t.cwd), { timeoutMs: PROBE_MS }));
  if (!probe.home.startsWith("/")) throw new ControlError(502, `${t.where}: couldn't read its home folder`);
  const home = probe.home;

  // Plain files first, each on its own: one that fails is said, and the rest still goes.
  if (b.home?.entries.length) {
    if (!probe.tar) skipped.push(`instructions and skills: ${t.where} has no tar`);
    else {
      progress(`Copying your instructions and skills (${b.home.files} file${b.home.files === 1 ? "" : "s"})…`);
      const stage = `${home}/${RUN_DIR}/${sid()}.home`;
      try {
        await t.run(`umask 077; mkdir -p ${shQuote(stage)}`, { timeoutMs: PROBE_MS });
        await t.upload(b.home.entries, stage, { home, timeoutMs: UPLOAD_MS });
        const out = await t.run(placeScript(stage, t.ours), { timeoutMs: 2 * 60_000 });
        const count = (w: string) => out.split("\n").filter((l) => l.trim() === w).length;
        if (count("kept")) skipped.push(`${count("kept")} instruction file${count("kept") === 1 ? " was" : "s were"} already there and kept`);
        if (count("failed")) skipped.push(`${count("failed")} instruction file${count("failed") === 1 ? "" : "s"} couldn't be put in place`);
      } catch (err) {
        skipped.push(`instructions and skills: ${setupError(err)}`);
        await t.run(`rm -rf ${shQuote(stage)}`, { timeoutMs: PROBE_MS }).catch(() => "");
      }
    }
  }
  let projectIn = false;
  if (b.project) {
    if (!t.ours && !probe.cwdEmpty) skipped.push(`the project: ${t.cwd} there isn't empty, so it wasn't uploaded`);
    else if (!probe.tar) skipped.push(`the project: ${t.where} has no tar`);
    else {
      progress(`Uploading ${b.project.display} (${mb(b.project.bytes)})…`);
      try {
        await t.upload(b.project.entries, t.cwd, { home, timeoutMs: UPLOAD_MS });
        projectIn = true;
      } catch (err) {
        skipped.push(`the project: ${setupError(err)}`);
      }
    }
  }

  // The agent's own config, read now (right before the write) and merged here; what couldn't be read is left alone.
  const codexDir = `"\${CODEX_HOME:-$HOME/.codex}"`;
  const reads: Record<string, string> = {};
  if (claude) {
    reads["claude.json"] = `"$HOME/.claude.json"`;
    if (b.claude?.settings) reads["settings.json"] = `"$HOME/.claude/settings.json"`;
  }
  if (codex) {
    reads["config.toml"] = `${codexDir}/config.toml`;
    reads["auth.json"] = `${codexDir}/auth.json`;
  }
  const cfg = Object.keys(reads).length ? parseProbe(await t.run(readScript(reads), { timeoutMs: PROBE_MS })) : parseProbe("");
  const unreadable = (name: string, what: string) => {
    if (!cfg.unreadable.has(name)) return false;
    skipped.push(`${what} there couldn't be read, so it was left as it is`);
    return true;
  };
  const files: SecretFile[] = [];
  if (claude && !unreadable("claude.json", "~/.claude.json")) {
    const key = secrets.ANTHROPIC_API_KEY;
    const keyTail = b.approveClaudeKey && key ? key.slice(-KEY_TAIL) : undefined;
    try {
      const was = cfg.files["claude.json"];
      const text = mergeClaudeJson(was, b.claude, { cwd: t.cwd, over: t.ours, keyTail });
      if (!sameJson(was, text)) files.push({ path: `${home}/.claude.json`, content: text, label: "~/.claude.json" });
    } catch (err) {
      if (!(err instanceof UnreadableConfig)) throw err;
      skipped.push(`${err.message}: MCP servers and first-run answers weren't added`);
    }
  }
  if (claude && b.claude?.settings && !unreadable("settings.json", "~/.claude/settings.json")) {
    try {
      const was = cfg.files["settings.json"];
      const text = mergeSettings(was, b.claude.settings, t.ours);
      if (!sameJson(was, text)) files.push({ path: `${home}/.claude/settings.json`, content: text, label: "settings.json" });
    } catch (err) {
      if (!(err instanceof UnreadableConfig)) throw err;
      skipped.push(err.message);
    }
  }
  if (codex && b.codex) {
    if (b.codex.mcp.length && !unreadable("config.toml", "~/.codex/config.toml")) {
      const m = mergeCodexToml(cfg.files["config.toml"], b.codex.mcp);
      if (m.added.length) files.push({ path: `${home}/.codex/config.toml`, content: m.text, label: "config.toml" });
      for (const k of m.kept) skipped.push(`MCP server ${k}: already set up there, kept`);
    }
    if (b.codex.authJson && !unreadable("auth.json", "~/.codex/auth.json")) {
      if (cfg.files["auth.json"] !== undefined && !t.ours) skipped.push("Codex sign-in: it already has one there, kept");
      else files.push({ path: `${home}/.codex/auth.json`, content: b.codex.authJson, label: "auth.json" });
    }
  }
  if (b.envFiles?.length) {
    if (!b.project || projectIn) for (const f of b.envFiles) files.push({ path: `${t.cwd}/${f.path}`, content: f.content, label: f.path });
    else skipped.push(".env files: the project wasn't uploaded");
  }

  if (files.length) {
    progress(claude || codex ? "Writing your MCP servers and settings (0600)…" : "Writing the .env files (0600)…");
    const wrote = await writeSecrets(t, files);
    if (wrote < files.length) skipped.push(`${files.length - wrote} config file${files.length - wrote === 1 ? "" : "s"} couldn't be written`);
  }
  return { skipped };
}

function mb(n: number): string {
  return n < 1 << 20 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

/** For the session's detail: what went wrong, never a value. */
export function setupError(err: unknown): string {
  return err instanceof ControlError ? err.message : scrubMessage((err as Error)?.message ?? String(err)).slice(0, 200);
}
