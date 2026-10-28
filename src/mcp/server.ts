/*
 * `agent-visualizer mcp`: a stdio MCP server written against the spec, no SDK.
 * Newline-delimited JSON-RPC 2.0 on stdin/stdout, logs (if any) on stderr.
 *
 * It is dual-era, as the 2026-07-28 revision describes:
 *  - legacy clients (2024-11-05 .. 2025-11-25) open with `initialize`; we
 *    negotiate the version, remember clientInfo for the process, answer
 *    ping, and may ask for roots/list to learn the workspace folder;
 *  - modern clients (2026-07-28) send protocolVersion, clientInfo and
 *    clientCapabilities in every request's _meta, start with server/discover,
 *    and get `resultType` plus serverInfo on every result.
 * Batches (2025-03-26) are accepted. Nothing but JSON-RPC ever goes to stdout.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { AgentKind } from "../shared/events.ts";
import { agentFromClient, agentFromEnv } from "./clients.ts";
import { createCooldown, createOutbox, sweepOutbox, userHome, type Cooldown, type Outbox } from "./outbox.ts";
import { fetchSnapshot, findOffice } from "./office.ts";
import { TOOLS, createHandlers, type ToolContext } from "./tools.ts";

export const MODERN_VERSIONS = ["2026-07-28"];
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT = "io.modelcontextprotocol/clientInfo";
const META_CAPS = "io.modelcontextprotocol/clientCapabilities";
const META_SERVER = "io.modelcontextprotocol/serverInfo";

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

/** Lines longer than this are dropped rather than buffered. */
const MAX_LINE = 4 << 20;

export const INSTRUCTIONS =
  "agent-visualizer is a live pixel-art office where the user watches their coding agents work; you are one of the workers. " +
  "Set office_status when you start a substantial task. Call office_peers before editing files in a repo other agents may share. " +
  "office_shout real milestones, office_celebrate genuine wins like tests going green after a fix, and office_flip only when something is truly maddening (once per task at most). " +
  "Every tool is instant and safe to call when the office is closed. Never put secrets or prompt text in these tools.";

type Id = string | number;
type Json = Record<string, unknown>;

interface Message {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export interface McpServerOptions {
  version: string;
  /** From `agent-visualizer mcp --agent <kind>`: set by the installer, beats clientInfo. */
  agentHint?: AgentKind;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: () => number;
  outbox?: Outbox;
  cooldown?: Cooldown;
  findOffice?: () => Promise<number | null>;
  fetchSnapshot?: ToolContext["fetchSnapshot"];
  /** Write one serialized message (no newline). */
  send: (line: string) => void;
  log?: (msg: string) => void;
}

export interface McpServer {
  /** Feed one line from stdin. Resolves when its response (if any) has been sent. */
  handleLine(line: string): Promise<void>;
  /** The client identity as last seen, for tests. */
  identity(): { agent?: AgentKind; client?: string };
  cwd(): string;
}

const isId = (v: unknown): v is Id => typeof v === "string" || (typeof v === "number" && Number.isFinite(v));
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

function cleanName(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/[^\w .:@/+-]/g, "").trim().slice(0, 64);
  return s || undefined;
}

export function createMcpServer(opts: McpServerOptions): McpServer {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const outbox = opts.outbox ?? createOutbox(env);
  const cooldown = opts.cooldown ?? createCooldown(env);
  const log = opts.log ?? (() => {});
  const serverInfo = { name: "agent-visualizer", title: "agent-visualizer", version: opts.version, websiteUrl: "https://github.com/pvgomes/agent-visualizer" };

  let legacyVersion: string | undefined; // set by initialize
  let legacyClient: string | undefined;
  let legacyRoots = false;
  let modernClient: string | undefined;
  let rootCwd: string | undefined;
  let rootsSeq = 0;
  const pendingRoots = new Set<Id>();

  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const home = real(userHome(env));
  const startCwd = real(opts.cwd ?? process.cwd());
  // Some agents launch MCP servers from / (a drive's root on Windows) or ~; that says nothing about the project.
  const vagueCwd = (p: string) => dirname(p) === p || real(p) === home;

  /** Best guess at the workspace: an explicit override, our cwd unless it's / or ~, the client's root, $PWD. */
  function cwd(): string {
    const override = env.AGENT_VISUALIZER_CWD?.trim();
    if (override) return resolve(override);
    if (!vagueCwd(startCwd)) return startCwd;
    if (rootCwd) return rootCwd;
    const pwd = env.PWD?.trim();
    if (pwd && !vagueCwd(pwd)) return real(pwd);
    return startCwd;
  }

  function identity(): { agent?: AgentKind; client?: string } {
    const client = modernClient ?? legacyClient;
    const agent = opts.agentHint ?? agentFromClient(client) ?? agentFromEnv(env);
    return { agent, client };
  }

  const handlers = createHandlers({
    outbox,
    cooldown,
    now,
    cwd,
    identity,
    findOffice: opts.findOffice ?? (() => findOffice(env)),
    fetchSnapshot: opts.fetchSnapshot ?? ((port) => fetchSnapshot(port)),
  });

  const send = (msg: Json) => {
    try {
      opts.send(JSON.stringify(msg));
    } catch (err) {
      log(`send failed: ${(err as Error).message}`);
    }
  };
  const ok = (id: Id, result: Json): Json => ({ jsonrpc: "2.0", id, result });
  const fail = (id: Id | null, code: number, message: string, data?: unknown): Json => ({
    jsonrpc: "2.0",
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  });

  function requestRoots(): void {
    if (!legacyRoots) return;
    const id = `agent-visualizer-roots-${++rootsSeq}`;
    pendingRoots.add(id);
    send({ jsonrpc: "2.0", id, method: "roots/list" });
  }

  function takeRoots(result: unknown): void {
    if (!isObj(result) || !Array.isArray(result.roots)) return;
    for (const r of result.roots) {
      if (!isObj(r) || typeof r.uri !== "string" || !r.uri.startsWith("file:")) continue;
      try {
        rootCwd = real(fileURLToPath(r.uri));
        return;
      } catch {
        // Not a local path.
      }
    }
  }

  /** Per-request era: modern if _meta names a protocol version. Returns an error response or the era. */
  function era(id: Id, params: Json): { modern: boolean; error?: Json } {
    const meta = isObj(params._meta) ? params._meta : undefined;
    const v = meta?.[META_VERSION];
    if (v === undefined) return { modern: false };
    if (typeof v !== "string") return { modern: true, error: fail(id, INVALID_PARAMS, `_meta["${META_VERSION}"] must be a string`) };
    if (!MODERN_VERSIONS.includes(v)) {
      return {
        modern: true,
        error: fail(id, UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version", { supported: MODERN_VERSIONS, requested: v }),
      };
    }
    if (!isObj(meta![META_CAPS])) {
      return { modern: true, error: fail(id, INVALID_PARAMS, `Missing _meta["${META_CAPS}"]`) };
    }
    const info = meta![META_CLIENT];
    if (isObj(info)) modernClient = cleanName(info.name) ?? modernClient;
    return { modern: true };
  }

  /** Results carry resultType + serverInfo for modern requests, and stay bare for legacy ones. */
  const shape = (modern: boolean, body: Json): Json =>
    modern ? { resultType: "complete", ...body, _meta: { [META_SERVER]: serverInfo } } : body;

  async function onRequest(id: Id, method: string, params: Json): Promise<Json> {
    if (method === "initialize") {
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      legacyVersion = LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0];
      if (isObj(params.clientInfo)) legacyClient = cleanName(params.clientInfo.name);
      legacyRoots = isObj(params.capabilities) && isObj(params.capabilities.roots);
      log(`initialize from ${legacyClient ?? "unknown client"} (${requested || "no version"} -> ${legacyVersion})`);
      return ok(id, {
        protocolVersion: legacyVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo,
        instructions: INSTRUCTIONS,
      });
    }
    if (method === "ping") return ok(id, {});

    const e = era(id, params);
    if (e.error) return e.error;
    const modern = e.modern;

    switch (method) {
      case "server/discover":
        if (!modern) return fail(id, INVALID_PARAMS, `server/discover needs _meta["${META_VERSION}"]; supported: ${MODERN_VERSIONS.join(", ")}`);
        return ok(id, shape(true, {
          supportedVersions: MODERN_VERSIONS,
          capabilities: { tools: {} },
          instructions: INSTRUCTIONS,
          ttlMs: 3_600_000,
          cacheScope: "public",
        }));
      case "tools/list":
        return ok(id, shape(modern, modern ? { tools: TOOLS, ttlMs: 3_600_000, cacheScope: "public" } : { tools: TOOLS }));
      case "tools/call": {
        const name = params.name;
        if (typeof name !== "string") return fail(id, INVALID_PARAMS, "tools/call needs a tool name");
        const handler = Object.prototype.hasOwnProperty.call(handlers, name) ? handlers[name] : undefined;
        if (!handler) return fail(id, INVALID_PARAMS, `Unknown tool: ${name.slice(0, 64)}`);
        const args = params.arguments ?? {};
        if (!isObj(args)) return fail(id, INVALID_PARAMS, "tools/call arguments must be an object");
        try {
          const r = await handler(args);
          return ok(id, shape(modern, { content: [{ type: "text", text: r.text }], isError: r.isError === true }));
        } catch (err) {
          log(`tool ${name} threw: ${(err as Error).stack ?? err}`);
          return ok(id, shape(modern, { content: [{ type: "text", text: "The office tool hit an internal error; nothing was posted. Carry on." }], isError: true }));
        }
      }
      // Not offered, but some clients ask anyway; empty beats an error toast.
      case "resources/list":
        return ok(id, shape(modern, { resources: [] }));
      case "resources/templates/list":
        return ok(id, shape(modern, { resourceTemplates: [] }));
      case "prompts/list":
        return ok(id, shape(modern, { prompts: [] }));
      case "logging/setLevel":
        return ok(id, shape(modern, {}));
      default:
        return fail(id, METHOD_NOT_FOUND, `Method not found: ${method.slice(0, 64)}`);
    }
  }

  function onNotification(method: string): void {
    if (method === "notifications/initialized") requestRoots();
    else if (method === "notifications/roots/list_changed") requestRoots();
    // notifications/cancelled: every tool finishes in milliseconds; nothing to stop.
  }

  async function handleOne(m: unknown): Promise<Json | null> {
    if (!isObj(m)) return fail(null, INVALID_REQUEST, "Invalid Request");
    const msg = m as Message;
    if (msg.jsonrpc !== "2.0") return fail(isId(msg.id) ? msg.id : null, INVALID_REQUEST, 'Invalid Request: jsonrpc must be "2.0"');
    if (typeof msg.method === "string") {
      const params = msg.params === undefined ? {} : msg.params;
      if (msg.id === undefined) {
        onNotification(msg.method);
        return null;
      }
      if (!isId(msg.id)) return fail(null, INVALID_REQUEST, "Invalid Request: id must be a string or number");
      if (!isObj(params)) return fail(msg.id, INVALID_PARAMS, "params must be an object");
      try {
        return await onRequest(msg.id, msg.method, params);
      } catch (err) {
        log(`request ${msg.method} failed: ${(err as Error).stack ?? err}`);
        return fail(msg.id, INTERNAL_ERROR, "Internal error");
      }
    }
    // A response to our roots/list request.
    if (isId(msg.id) && pendingRoots.has(msg.id)) {
      pendingRoots.delete(msg.id);
      if (msg.result !== undefined) takeRoots(msg.result);
      return null;
    }
    if (msg.result !== undefined || msg.error !== undefined) return null; // stray response: ignore
    return fail(isId(msg.id) ? msg.id : null, INVALID_REQUEST, "Invalid Request");
  }

  async function handleLine(line: string): Promise<void> {
    const text = line.trim();
    if (!text) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      send(fail(null, PARSE_ERROR, "Parse error"));
      return;
    }
    if (Array.isArray(parsed)) {
      if (!parsed.length) return send(fail(null, INVALID_REQUEST, "Invalid Request: empty batch"));
      const out = (await Promise.all(parsed.map(handleOne))).filter((r): r is Json => r !== null);
      if (out.length) {
        try {
          opts.send(JSON.stringify(out));
        } catch (err) {
          log(`send failed: ${(err as Error).message}`);
        }
      }
      return;
    }
    const r = await handleOne(parsed);
    if (r) send(r);
  }

  return { handleLine, identity, cwd };
}

/** Run on this process's stdio until stdin closes. */
export function runMcpStdio(opts: { version: string; agentHint?: AgentKind; verbose?: boolean }): Promise<void> {
  const log = opts.verbose ? (m: string) => process.stderr.write(`agent-visualizer mcp: ${m}\n`) : () => {};
  // stdout belongs to the protocol; make sure nothing else can write there.
  console.log = console.info = console.debug = console.warn = (...a: unknown[]) => log(a.map(String).join(" "));
  sweepOutbox();
  const server = createMcpServer({
    version: opts.version,
    agentHint: opts.agentHint,
    log,
    send: (line) => {
      process.stdout.write(line + "\n");
    },
  });

  return new Promise((done) => {
    let buf = "";
    let skipping = false;
    let ended = false;
    const inflight = new Set<Promise<void>>();
    // Requests run concurrently (a slow office_peers must not hold up a ping); JSON-RPC ids pair the answers.
    const handle = (line: string) => {
      const p = server.handleLine(line).catch(() => {});
      inflight.add(p);
      p.finally(() => inflight.delete(p));
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (skipping) skipping = false;
        else handle(line);
      }
      if (buf.length > MAX_LINE) {
        buf = "";
        skipping = true;
        handle("{"); // answers the oversized line with a parse error
      }
    });
    const end = () => {
      if (ended) return;
      ended = true;
      if (buf.trim() && !skipping) handle(buf);
      buf = "";
      Promise.all(inflight).then(() => done());
    };
    process.stdin.on("end", end);
    process.stdin.on("close", end);
    process.stdout.on("error", () => done()); // client went away
  });
}
