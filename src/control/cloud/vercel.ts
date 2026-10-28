/*
 * Vercel Sandboxes as places, over the REST API and login the watcher uses
 * (src/remote/vercel.ts).
 *
 *   project  VERCEL_PROJECT_ID, else vercel-sandbox-default-project in the default team.
 *            When that one is missing, creating a sandbox creates it first (POST
 *            /v11/projects), as the SDK and CLI do; ProviderStatus.note says so before.
 *   create   POST /v3/sandboxes {projectId, name: "agent-visualizer-…", tags: {agent-visualizer: "1"},
 *            persistent: false, timeout}: no runtime, so the universal image (Node 24;
 *            claude, codex and opencode preinstalled); not persistent, so nothing an agent
 *            wrote survives in a snapshot. A plan that caps the timeout (Hobby: 45 min) gets
 *            a retry at 45. Never extended.
 *   ours     what sandboxes.json records; the tag only finds them
 *            (GET /v2/sandboxes?project&tags=agent-visualizer:1): anyone on the
 *            team can set it, a teammate's own office included
 *   delete   DELETE /v2/sandboxes/{name}?projectId&deleteOrphanSnapshots=true
 *   exec     POST /v2/sandboxes/sessions/{sid}/cmd {command: "sh", args: ["-c", script], wait}
 *   TTY      POST /v2/sandboxes/sessions/{sid}/interactive -> {url, token} (undocumented, the
 *            SDK's), GET https://<host>/health, then the WebSocket url?token=; the first frame
 *            {type: "start", command, args, env, cwd, cols, rows}; resize frames; binary I/O;
 *            {type: "exit", code}. Fallback: `npx --yes sandbox@4.8.1 exec --interactive` under a
 *            local PTY (never a bare `sandbox`: another tool by that name is common).
 *   chat     POST …/cmd {command: "sh", args: ["-c", line], env, attachStdin: true} (detached), as
 *            the SDK's runCommand({stdin: true, detached: true}) does: stdin is a pipe written by
 *            POST …/cmd/{id}/stdin {data: base64, offset} -> {bytesWritten}; with the offset a
 *            resend is safe (the server skips what it has), {close: true} is EOF. Output is the
 *            ndjson stream GET …/cmd/{id}/logs ({stream: "stdout" | "stderr", data}), which
 *            replays from the start: one cut while the command runs (or as it finishes) is
 *            opened again, skipping what was delivered. It is read over node:https on its own socket, never
 *            fetch: with that stream open in Node 26's fetch, the stdin posts to the same host
 *            hung until it closed. GET …/cmd/{id}?wait=true has the exit code, and then the
 *            log is read once more to its end (a stream's end can't tell a cut from the
 *            command's own). POST …/cmd/{id}/kill {signal} signals it. Checked against Vercel's
 *            API on 2026-10-19.
 *
 * Keys: Vercel keeps every command's args (GET …/cmd lists them), so a key or a prompt is
 * never in args. On the WebSocket they ride the start frame's env, and in chat mode the
 * command's own env: the process environment of that one command, no file at all. The CLI
 * fallback writes the 0600 env file with one command whose per-command env holds the values.
 * Vercel keeps a command's output after it ends (…/logs still answers), so a chat's stream,
 * the conversation itself, can be read back through the API afterwards.
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { ProviderStatus, SandboxInfo } from "../../shared/control.ts";
import type { RemoteTarget } from "../../shared/events.ts";
import { VERCEL_API, VERCEL_DEFAULT_PROJECT, vercelLogin } from "../../remote/vercel.ts";
import { RemoteError, displayName, http, jsonOf, scrubMessage, str, which, type HttpResult } from "../../remote/util.ts";
import { ControlError, type Launch, type OpenOptions, type PipeProc, type PlacesContext, type Term, type TermExit } from "../types.ts";
import { connectWs, type Ws } from "../ws.ts";
import { tgzOf, type TarEntry } from "../tar.ts";
import { cleanupScript, cwdScript, envFromVarScript, envLines, launchLine, parseCwd, stopScript } from "./launch.ts";
import {
  BasePlace, Listeners, Once, StreamTerm, afterExit, failed, helperEnv, sandboxRow, sid as newSid, sleep,
  type Cloud, type CloudDeps, type CreateOptions,
} from "./place.ts";

export const VERCEL_CLI = "sandbox@4.8.1";
const API_TIMEOUT_MS = 20_000;
const START_WAIT_MS = 2 * 60_000;
const HOBBY_MAX_MIN = 45;
const TEAM_TTL_MS = 10 * 60_000;
/** Per stdin request, as the SDK sends: the base64 body stays under the API's 1 MB. */
const STDIN_CHUNK = 512 << 10;
/** Reopen a chat's log stream this many times in a row (one that lasted a minute resets the count). */
const CHAT_RECONNECTS = 3;
const SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };

interface Scope {
  token: string;
  via: string;
  team: string;
  project: string;
}

interface Box {
  name: string;
  session: string;
  team: string;
  project: string;
}

function stateOf(s: string | undefined): SandboxInfo["status"] {
  if (s === "running") return "running";
  if (s === "pending") return "starting";
  if (s === "stopped" || s === "stopping" || s === "snapshotting" || s === "failed" || s === "aborted") return "stopped";
  return "unknown";
}

const iso = (ms: unknown) => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined);

export function vercelCloud(d: CloudDeps): Cloud {
  const ctx = d.ctx;
  const env = () => ctx.providerEnv();
  const base = () => (str(env().AGENT_VISUALIZER_VERCEL_API) ?? VERCEL_API).replace(/\/+$/, "");
  const pollMs = d.pollMs ?? 2_000;
  let teamCache: { at: number; token: string; team: string } | undefined;
  let projectSeen: { key: string; exists: boolean; at: number } | undefined;
  /** name -> where it lives, from the last listing (an existing sandbox is opened by name). */
  const known = new Map<string, { team: string; project: string }>();

  const call = async (s: { token: string }, path: string, o: { method?: string; body?: unknown; what: string; timeoutMs?: number } = { what: "Vercel" }) =>
    jsonOf(await http(base() + path, { method: o.method, headers: { authorization: `Bearer ${s.token}` }, body: o.body, timeoutMs: o.timeoutMs ?? API_TIMEOUT_MS, fetch: d.fetch }), o.what);

  async function scope(): Promise<Scope> {
    const l = vercelLogin({ env: env() });
    if ("why" in l) throw new ControlError(502, `Vercel Sandbox: ${l.why}`);
    let team = l.teams?.[0];
    if (!team) {
      if (teamCache && teamCache.token === l.token && ctx.now() - teamCache.at < TEAM_TTL_MS) team = teamCache.team;
      else {
        const u = await call(l, "/v2/user", { what: "Vercel user" });
        team = str(u?.user?.defaultTeamId) ?? str(u?.user?.id);
        if (!team) throw new ControlError(502, "Vercel: no default team for this login");
        teamCache = { at: ctx.now(), token: l.token, team };
      }
    }
    return { token: l.token, via: l.via, team, project: l.projects?.[0] ?? VERCEL_DEFAULT_PROJECT };
  }

  /** Does the project exist? Only the default project is ever created, and only on a create. */
  async function projectExists(s: Scope, fresh = false): Promise<boolean> {
    const key = `${s.team}/${s.project}`;
    if (!fresh && projectSeen?.key === key && (projectSeen.exists || ctx.now() - projectSeen.at < 60_000)) return projectSeen.exists;
    let exists = true;
    try {
      await call(s, `/v2/projects/${encodeURIComponent(s.project)}?${new URLSearchParams({ teamId: s.team })}`, { what: "Vercel project" });
    } catch (err) {
      if ((err as RemoteError).code !== "gone") throw err;
      exists = false;
    }
    projectSeen = { key, exists, at: ctx.now() };
    return exists;
  }

  async function get(s: Scope, name: string, where = known.get(name) ?? { team: s.team, project: s.project }): Promise<{ sb: any; team: string; project: string }> {
    const q = new URLSearchParams({ projectId: where.project, teamId: where.team });
    const j = await call(s, `/v2/sandboxes/${encodeURIComponent(name)}?${q}`, { what: "Vercel sandbox" });
    return { sb: j?.sandbox ?? j, ...where };
  }

  async function ready(s: Scope, sb: any, where: { team: string; project: string }, asked: string | undefined, ours: boolean, o: OpenOptions): Promise<VercelPlace> {
    const box: Box = { name: String(sb.name), session: String(sb.currentSessionId), team: where.team, project: where.project };
    const probe = new VercelPlace(ctx, d, s.token, base(), box, "/", ours, o.agent);
    const cwd = parseCwd(await probe.run(cwdScript(asked, ours || !!o.createCwd), { timeoutMs: 30_000 }), asked, `Vercel ${box.name}`);
    return new VercelPlace(ctx, d, s.token, base(), box, cwd, ours, o.agent);
  }

  return {
    kind: "vercel",
    name: "Vercel Sandbox",
    login() {
      const l = vercelLogin({ env: env() });
      return "why" in l ? { ready: false, why: l.why } : { ready: true, via: l.via };
    },

    async status(): Promise<ProviderStatus> {
      const row: ProviderStatus = { kind: "vercel", name: "Vercel Sandbox", ready: false, canCreate: false, sandboxes: [] };
      const l = vercelLogin({ env: env() });
      if ("why" in l) return { ...row, note: l.why };
      let s: Scope;
      try {
        s = await scope();
      } catch (err) {
        return { ...row, via: l.via, note: (err as Error).message };
      }
      const out: ProviderStatus = { ...row, ready: true, via: s.via, canCreate: true };
      let exists = true;
      try {
        exists = await projectExists(s);
      } catch (err) {
        if ((err as RemoteError).code === "auth") return { ...out, ready: false, canCreate: false, note: (err as Error).message };
      }
      if (!exists) out.note = `Creating a sandbox first creates the project ${s.project} in your default team`;
      const rows = new Map<string, SandboxInfo>();
      const recorded = d.registry.list("vercel");
      if (exists) {
        try {
          let cursor: string | undefined;
          for (let page = 0; page < 5; page++) {
            const q = new URLSearchParams({ teamId: s.team, project: s.project, tags: "agent-visualizer:1", limit: "50" });
            if (cursor) q.set("cursor", cursor);
            const j = await call(s, `/v2/sandboxes?${q}`, { what: "Vercel sandboxes" });
            for (const sb of Array.isArray(j?.sandboxes) ? j.sandboxes : []) {
              const name = str(sb?.name);
              if (!name) continue;
              known.set(name, { team: s.team, project: s.project });
              const ours = !!d.registry.get("vercel", name);
              // Tagged by another office (a teammate's): like any sandbox someone else made, shown only while it runs.
              if (!ours && sb.status !== "running") continue;
              rows.set(name, sandboxRow(ctx, "vercel", {
                id: name, name: displayName(name), status: stateOf(sb.status), ours,
                ...(iso(sb.createdAt) ? { createdAt: iso(sb.createdAt) } : {}), ...(iso(sb.expiresAt) ? { expiresAt: iso(sb.expiresAt) } : {}),
              }, `vercel:${name}`));
            }
            cursor = str(j?.pagination?.next);
            if (!cursor) break;
          }
          for (const r of recorded) {
            if (!rows.has(r.id) && (r.projectId ?? s.project) === s.project && ctx.now() - Date.parse(r.createdAt) > 2 * 60_000) d.registry.remove("vercel", r.id);
          }
          // Running sandboxes in the same project the user made themselves can be hired into too.
          const q = new URLSearchParams({ teamId: s.team, project: s.project, limit: "50" });
          const j = await call(s, `/v2/sandboxes?${q}`, { what: "Vercel sandboxes" });
          for (const sb of Array.isArray(j?.sandboxes) ? j.sandboxes : []) {
            const name = str(sb?.name);
            if (!name || rows.has(name) || sb.status !== "running") continue;
            known.set(name, { team: s.team, project: s.project });
            rows.set(name, sandboxRow(ctx, "vercel", { id: name, name: displayName(name), status: "running", ours: !!d.registry.get("vercel", name) }, `vercel:${name}`));
          }
        } catch (err) {
          if ((err as RemoteError).code === "auth") return { ...out, ready: false, canCreate: false, note: (err as Error).message };
        }
      }
      return { ...out, sandboxes: [...rows.values()] };
    },

    async create(c: CreateOptions, o: OpenOptions): Promise<BasePlace> {
      const s = await scope();
      if (!(await projectExists(s, true))) {
        if (s.project !== VERCEL_DEFAULT_PROJECT) throw new ControlError(409, `Vercel project ${s.project} not found`);
        o.progress("creating", `Creating Vercel project ${s.project}…`);
        await call(s, `/v11/projects?${new URLSearchParams({ teamId: s.team })}`, { method: "POST", body: { name: s.project }, what: "Vercel project create" });
        projectSeen = { key: `${s.team}/${s.project}`, exists: true, at: ctx.now() };
      }
      o.progress("creating", "Creating Vercel sandbox…");
      const body = (min: number) => ({ projectId: s.project, name: c.name, tags: { "agent-visualizer": "1" }, persistent: false, timeout: min * 60_000 });
      const q = new URLSearchParams({ teamId: s.team });
      let made: any;
      try {
        made = await call(s, `/v3/sandboxes?${q}`, { method: "POST", body: body(c.timeoutMin), what: "Vercel create" });
      } catch (err) {
        // Hobby caps a session at 45 minutes.
        if (c.timeoutMin <= HOBBY_MAX_MIN || (err as RemoteError).code !== "failed" || !/timeout|duration|limit|plan/i.test((err as Error).message)) throw err;
        o.progress("creating", `Creating Vercel sandbox (this plan allows ${HOBBY_MAX_MIN} minutes)…`);
        made = await call(s, `/v3/sandboxes?${q}`, { method: "POST", body: body(HOBBY_MAX_MIN), what: "Vercel create" });
      }
      const sb0 = made?.sandbox ?? made;
      const name = str(sb0?.name) ?? c.name;
      d.registry.add({ provider: "vercel", id: name, name, createdAt: iso(sb0?.createdAt) ?? new Date(ctx.now()).toISOString(), projectId: s.project, teamId: s.team });
      c.onCreated?.(name);
      known.set(name, { team: s.team, project: s.project });
      let sb = sb0;
      const t0 = Date.now();
      while (!(sb?.status === "running" && str(sb.currentSessionId))) {
        if (sb?.status === "failed" || sb?.status === "aborted" || sb?.status === "stopped") throw new ControlError(502, `Vercel sandbox didn't start (${sb.status})`);
        if (Date.now() - t0 > START_WAIT_MS) throw new ControlError(502, "Vercel sandbox didn't start within 2 minutes");
        await sleep(pollMs, o.signal);
        sb = (await get(s, name)).sb;
      }
      return ready(s, sb, { team: s.team, project: s.project }, c.cwd, true, o);
    },

    async open(id: string, cwd: string | undefined, o: OpenOptions): Promise<BasePlace> {
      const s = await scope();
      const rec = d.registry.get("vercel", id);
      let got;
      try {
        got = await get(s, id, known.get(id) ?? (rec?.projectId && rec.teamId ? { team: rec.teamId, project: rec.projectId } : undefined));
      } catch (err) {
        if ((err as RemoteError).code === "gone") throw new ControlError(404, "No such Vercel sandbox");
        throw err;
      }
      if (got.sb?.status !== "running" || !str(got.sb.currentSessionId)) throw new ControlError(409, `Vercel sandbox ${displayName(id)} is ${str(got.sb?.status) ?? "not running"}`);
      // The tag alone doesn't make it ours: first-run seeding only goes into sandboxes this office made.
      const ours = !!rec;
      return ready(s, got.sb, { team: got.team, project: got.project }, cwd, ours, o);
    },

    async remove(id: string): Promise<void> {
      const s = await scope();
      const rec = d.registry.get("vercel", id);
      const where = known.get(id) ?? (rec?.projectId && rec.teamId ? { team: rec.teamId, project: rec.projectId } : { team: s.team, project: s.project });
      const q = new URLSearchParams({ projectId: where.project, teamId: where.team, deleteOrphanSnapshots: "true" });
      try {
        await call(s, `/v2/sandboxes/${encodeURIComponent(id)}?${q}`, { method: "DELETE", what: "Vercel delete" });
      } catch (err) {
        if ((err as RemoteError).code !== "gone") throw err;
      }
      d.registry.remove("vercel", id);
      known.delete(id);
    },
  };
}

export class VercelPlace extends BasePlace {
  constructor(
    private readonly ctx: PlacesContext,
    private readonly deps: CloudDeps,
    private readonly token: string,
    private readonly api: string,
    private readonly box: Box,
    cwd: string,
    ours: boolean,
    agent: OpenOptions["agent"],
  ) {
    const target: RemoteTarget = {
      host: { kind: "vercel", id: `vercel:${box.name}`, name: displayName(box.name) },
      exec: async (script, eo) => (await this.cmd(["-c", script], eo?.timeoutMs ?? 20_000)).stdout,
    };
    super({ host: target.host, cwd, ours, target, agent, where: `Vercel ${displayName(box.name)}`, log: ctx.log });
  }

  private q(): string {
    return new URLSearchParams({ teamId: this.box.team }).toString();
  }

  /** One `sh` command, waited for. Args are retained by Vercel: callers never put a secret in them. */
  private async cmd(args: string[], timeoutMs: number, env?: Record<string, string>): Promise<{ stdout: string }> {
    const r = await http(`${this.api}/v2/sandboxes/sessions/${encodeURIComponent(this.box.session)}/cmd?${this.q()}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}` },
      body: { command: "sh", args, wait: true, logs: true, timeout: timeoutMs, ...(env ? { env } : {}) },
      timeoutMs: timeoutMs + 5_000,
      fetch: this.deps.fetch,
    });
    if (r.status >= 400) jsonOf(r, `Vercel ${this.box.name}`);
    let stdout = "";
    let stderr = "";
    let exit: number | null | undefined;
    for (const line of r.text.split("\n")) {
      if (!line.trim()) continue;
      let j: any;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      if (j?.command && typeof j.command.exitCode === "number") exit = j.command.exitCode;
      else if (j?.stream === "stdout" && typeof j.data === "string") stdout += j.data;
      else if (j?.stream === "stderr" && typeof j.data === "string") stderr += j.data.slice(0, 4096);
      else if (j?.stream === "error") throw new RemoteError("failed", `Vercel ${this.box.name}: ${j.data?.code ?? "error"} ${j.data?.message ?? ""}`);
    }
    if (exit === undefined || exit === null) throw new RemoteError("unreachable", `Vercel ${this.box.name}: command stream ended early`);
    if (exit !== 0) throw failed(`Vercel ${this.box.name}`, exit, stderr || stdout);
    return { stdout };
  }

  run(script: string, o: { timeoutMs: number }): Promise<string> {
    return this.cmd(["-c", script], o.timeoutMs).then((r) => r.stdout);
  }

  /** The values are this one command's environment; Vercel keeps a command's args, so they are never there. */
  protected runSecret(script: string, env: Record<string, string>, o: { timeoutMs: number }): Promise<string> {
    return this.cmd(["-c", script], o.timeoutMs, env).then((r) => r.stdout);
  }

  /** Vercel's own file upload (what the SDK's writeFiles sends): a tar.gz extracted at "/" as the sandbox's user. */
  protected async upload(entries: TarEntry[], dir: string, o: { home: string; timeoutMs: number }): Promise<void> {
    const tgz = await tgzOf(entries, dir);
    const r = await http(`${this.api}/v2/sandboxes/sessions/${encodeURIComponent(this.box.session)}/fs/write?${this.q()}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/gzip", "x-cwd": "/" },
      body: tgz,
      timeoutMs: o.timeoutMs,
      fetch: this.deps.fetch,
    });
    if (r.status >= 400) jsonOf(r, `Vercel ${this.box.name} upload`);
    void o.home;
  }

  private bg(script: string): void {
    this.cmd(["-c", script], 15_000).catch(() => {});
  }

  protected async openTerm(launch: Launch, size: { cols: number; rows: number }, id: string, path: string[] | undefined): Promise<Term> {
    let ws: Ws;
    try {
      ws = await this.interactive();
    } catch (err) {
      if ((err as RemoteError).code === "auth") throw err;
      return this.cliTerm(launch, size, id, path, err as Error);
    }
    const line = launchLine(launch, { sid: id, pidFile: true, path });
    // The values ride this frame's env: that one command's environment, nothing on args.
    ws.send(JSON.stringify({
      type: "start",
      command: "sh",
      args: ["-c", line],
      env: [["TERM", "xterm-256color"], ...Object.entries(launch.env)].map(([k, v]) => `${k}=${v}`),
      cwd: this.cwd,
      cols: size.cols,
      rows: size.rows,
    }));
    const term = new StreamTerm({
      write: (b) => ws.send(b),
      resize: (cols, rows) => ws.send(JSON.stringify({ type: "resize", cols, rows })),
      kill: (signal) => {
        // Whether closing the socket ends the command is UNVERIFIED: signal it by its pid too.
        this.bg(stopScript(id, signal === "SIGKILL" ? "KILL" : signal === "SIGTERM" ? "TERM" : "HUP"));
        setTimeout(() => {
          if (!term.ended) {
            ws.close();
            term.end({ code: null });
          }
        }, 4_000).unref?.();
      },
    });
    ws.onMessage((m) => {
      if (typeof m !== "string") return term.push(m);
      try {
        const j = JSON.parse(m);
        if (j?.type === "exit") {
          term.end({ code: typeof j.code === "number" ? j.code : null });
          ws.close();
          return;
        }
        if (j && typeof j === "object" && typeof j.type === "string") return;
      } catch {
        // Plain text is output.
      }
      term.push(Buffer.from(m, "utf8"));
    });
    ws.onClose((code, reason) => {
      // Closed without an exit frame: say why, so a dropped terminal isn't mistaken for the agent quitting.
      if (!term.ended) this.log(`${this.where}: terminal connection closed (${code}${reason ? ` ${scrubMessage(reason).slice(0, 80)}` : ""})`, "warn");
      term.end({ code: null });
    });
    return afterExit(term, () => this.bg(cleanupScript(id)));
  }

  private async interactive(): Promise<Ws> {
    const r = await http(`${this.api}/v2/sandboxes/sessions/${encodeURIComponent(this.box.session)}/interactive?${this.q()}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}` },
      body: {},
      timeoutMs: API_TIMEOUT_MS,
      fetch: this.deps.fetch,
    });
    const j = jsonOf(r, `Vercel ${this.box.name} terminal`);
    const url = str(j?.url);
    const token = str(j?.token);
    if (!url || !token) throw new RemoteError("failed", `Vercel ${this.box.name}: no terminal URL`);
    const u = new URL(url);
    // The terminal server may still be starting, cross-region: wait for it as the CLI does.
    const health = `${u.protocol === "wss:" ? "https:" : "http:"}//${u.host}/health`;
    for (let i = 0; ; i++) {
      try {
        const h = await http(health, { timeoutMs: 5_000, fetch: this.deps.fetch });
        if (h.status < 400) break;
        if (i >= 4) throw new RemoteError("unreachable", `Vercel ${this.box.name}: terminal server not healthy (${h.status})`);
      } catch (err) {
        if (i >= 4) throw err;
      }
      await sleep(100 * 2 ** i);
    }
    return connectWs(`${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`, { timeoutMs: 15_000 });
  }

  /** `npx --yes sandbox@4.8.1 exec --interactive` under a local PTY, with the env file. */
  private async cliTerm(launch: Launch, size: { cols: number; rows: number }, id: string, path: string[] | undefined, why: Error): Promise<Term> {
    const pty = await this.ctx.pty();
    const npx = this.deps.bins?.npx ?? which("npx", this.ctx.providerEnv());
    if (!pty || !npx) throw why;
    this.log(`Vercel ${this.box.name}: the interactive endpoint failed (${scrubMessage(why.message)}); using the sandbox CLI`, "warn");
    const withFile = Object.keys(launch.env).length > 0;
    if (withFile) await this.cmd(["-c", envFromVarScript(id)], 30_000, { AO_ENV: envLines(launch.env) });
    const line = launchLine(launch, { sid: id, envFile: withFile, pidFile: true, path });
    // UNVERIFIED: that the CLI's parser (cmd-ts) takes `--` before the sandbox name.
    const args = ["--yes", VERCEL_CLI, "exec", "--interactive", "--no-extend-timeout", "--workdir", this.cwd, "--project", this.box.project, "--scope", this.box.team, "--", this.box.name, "sh", "-c", line];
    // Its login: the token in the environment, never --token on the command line.
    const env = { ...helperEnv(this.ctx.providerEnv(), true), VERCEL_AUTH_TOKEN: this.token };
    let term: Term;
    try {
      term = pty.spawn({ file: npx, args, cwd: this.ctx.userHome, env, cols: size.cols, rows: size.rows });
    } catch (err) {
      this.bg(cleanupScript(id));
      throw err;
    }
    return afterExit(term, () => this.bg(cleanupScript(id)));
  }

  /** Chat mode: a detached command with its stdin attached (see the top of this file). */
  async pipe(launch: Launch): Promise<PipeProc> {
    const l = this.prepare(launch);
    const line = launchLine(l, { sid: newSid(), path: l.path?.length ? l.path : this.path });
    const what = `Vercel ${this.box.name} chat`;
    const base = `${this.api}/v2/sandboxes/sessions/${encodeURIComponent(this.box.session)}`;
    const auth = { authorization: `Bearer ${this.token}` };
    const url = (path: string) => `${base}${path}${path.includes("?") ? "&" : "?"}${this.q()}`;
    const call = (path: string, o: { body?: unknown; timeoutMs?: number } = {}) =>
      http(url(path), { headers: auth, body: o.body, timeoutMs: o.timeoutMs ?? API_TIMEOUT_MS, fetch: this.deps.fetch });
    // The keys are this one command's environment, never its args (which Vercel keeps).
    const env = Object.keys(l.env).length ? l.env : undefined;
    const made = jsonOf(await call("/cmd", { body: { command: "sh", args: ["-c", line], cwd: this.cwd, ...(env ? { env } : {}), attachStdin: true } }), what);
    const cmd = str(made?.command?.id);
    if (!cmd) throw new RemoteError("failed", `${what}: no command id`);
    const cPath = `/cmd/${encodeURIComponent(cmd)}`;

    const out = new Listeners<Uint8Array>();
    const err = new Listeners<Uint8Array>();
    const exit = new Once<TermExit>();
    /** Characters of each stream delivered so far, and what a reopened stream (a replay from the start) skips. */
    const seen = { stdout: 0, stderr: 0 };
    let skip = { ...seen };
    let logs: { close(): void } | undefined;
    let tries = 0;
    /** The command has ended and its log is being read once more, to the end. */
    let draining = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const end = (e: TermExit) => {
      if (exit.fired) return;
      if (killTimer) clearTimeout(killTimer);
      logs?.close();
      logs = undefined;
      exit.fire(e);
    };
    const onLine = (text: string) => {
      let j: any;
      try {
        j = JSON.parse(text);
      } catch {
        return;
      }
      const k = j?.stream;
      if ((k !== "stdout" && k !== "stderr") || typeof j.data !== "string") return;
      const n = Math.min(skip[k as "stdout"], j.data.length);
      skip[k as "stdout"] -= n;
      const d: string = n ? j.data.slice(n) : j.data;
      if (!d) return;
      seen[k as "stdout"] += d.length;
      (k === "stderr" ? err : out).emit(Buffer.from(d, "utf8"));
    };
    const follow = () => {
      skip = { ...seen };
      const at = Date.now();
      const s = streamLines(url(`${cPath}/logs`), auth, onLine, (why) => {
        if (logs !== s) return;
        logs = undefined;
        if (Date.now() - at > 60_000) tries = 0;
        void settle(why === "end");
      });
      logs = s;
    };
    // The stream ended: the command did (its exit code), or the stream was cut (open it again,
    // and the replay skips what came already). A plain GET lags the end by a few seconds;
    // ?wait=true answers at once for a finished command and holds for a running one, so a short
    // deadline tells the two apart. A stream's end can't say whether it was cut just before the
    // command ended, so once it has, the log is read once more, to its end: only a stream opened
    // after the exit and read whole is known to hold the agent's last words.
    const settle = async (clean: boolean): Promise<void> => {
      if (exit.fired) return;
      let code: number | undefined;
      try {
        const j = jsonOf(await call(`${cPath}?wait=true`, { timeoutMs: 3_000 }), what);
        if (typeof j?.command?.exitCode === "number") code = j.command.exitCode;
      } catch (e) {
        const c = (e as RemoteError).code;
        if (c === "gone" || c === "auth") return end({ code: null });
        // "timeout": still running.
      }
      if (exit.fired) return;
      if (code !== undefined) {
        if (draining && (clean || tries++ >= CHAT_RECONNECTS)) return end({ code });
        draining = true;
        return follow();
      }
      if (tries++ >= CHAT_RECONNECTS) {
        this.log(`${this.where}: the chat's connection kept dropping; stopping the agent`, "warn");
        kill("SIGKILL");
        return end({ code: null });
      }
      await sleep(500 * tries);
      if (!exit.fired) follow();
    };
    const kill = (signal?: NodeJS.Signals) => {
      if (exit.fired) return;
      call(`${cPath}/kill`, { body: { signal: SIGNALS[signal ?? "SIGTERM"] ?? 15 } }).catch(() => {});
      killTimer ??= setTimeout(() => end({ code: null }), 10_000);
      killTimer.unref?.();
    };
    follow();

    // In order, one request at a time; the offset makes a resend after a dropped request safe.
    let offset = 0;
    let offsets = true;
    let queue: Promise<void> = Promise.resolve();
    const stdin = async (data: Buffer | undefined, close: boolean): Promise<void> => {
      for (let i = 0; ; i++) {
        let r: HttpResult;
        try {
          r = await call(`${cPath}/stdin`, { body: { ...(data?.length ? { data: data.toString("base64") } : {}), ...(offsets ? { offset } : {}), ...(close ? { close: true } : {}) } });
        } catch (e) {
          if (!offsets || i >= 3 || exit.fired) throw e;
          await sleep(400 * 2 ** i);
          continue;
        }
        // 404: the command has ended, and the log stream is about to say how.
        if (r.status === 404 || exit.fired) return;
        if ((r.status === 429 || (offsets && r.status >= 502)) && i < 3) {
          await sleep(400 * 2 ** i);
          continue;
        }
        const j = jsonOf(r, what);
        if (typeof j?.bytesWritten === "number") offset = j.bytesWritten;
        else {
          offsets = false;
          offset += data?.length ?? 0;
        }
        return;
      }
    };
    const send = (data: Buffer | undefined, close: boolean) => {
      queue = queue
        .then(async () => {
          for (let i = 0; data && i < data.length; i += STDIN_CHUNK) await stdin(data.subarray(i, i + STDIN_CHUNK), false);
          if (close) await stdin(undefined, true);
        })
        .catch((e) => {
          if (exit.fired) return;
          // A message lost on the way would leave the chat waiting for nothing: end it, and say why.
          this.log(`${this.where}: a chat message didn't reach the agent (${scrubMessage((e as Error).message)}); stopping it`, "warn");
          kill("SIGTERM");
        });
    };
    return {
      write(d) {
        if (exit.fired) return;
        const b = typeof d === "string" ? Buffer.from(d, "utf8") : Buffer.from(d);
        if (b.length) send(b, false);
      },
      end: () => {
        if (!exit.fired) send(undefined, true);
      },
      onStdout: (fn) => out.on(fn),
      onStderr: (fn) => err.on(fn),
      onExit: (fn) => exit.on(fn),
      kill,
    };
  }
}

/**
 * A GET read line by line as it arrives, on a socket of its own (node:http, not fetch: see the
 * top of this file). `onEnd` runs once, however it ends; close() ends it without that.
 */
function streamLines(url: string, headers: Record<string, string>, onLine: (line: string) => void, onEnd: (why: string) => void): { close(): void } {
  const u = new URL(url);
  let done = false;
  const finish = (why: string) => {
    if (done) return;
    done = true;
    onEnd(why);
  };
  const req = (u.protocol === "https:" ? httpsRequest : httpRequest)(u, { headers: { accept: "application/x-ndjson", ...headers } }, (res) => {
    if ((res.statusCode ?? 0) >= 400) {
      res.resume();
      return finish(String(res.statusCode));
    }
    let buf = "";
    res.setEncoding("utf8");
    res.on("data", (c: string) => {
      buf += c;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line && !done) onLine(line);
      }
      if (buf.length > 32 << 20) buf = "";
    });
    res.on("end", () => {
      if (buf.trim() && !done) onLine(buf.trim());
      finish("end");
    });
    res.on("error", () => finish("error"));
    res.on("close", () => finish("closed"));
  });
  // A connection that died without a word would otherwise wait forever.
  req.on("socket", (s) => s.setKeepAlive(true, 30_000));
  req.on("error", (e) => finish(scrubMessage(e.message)));
  req.end();
  return {
    close() {
      done = true;
      req.destroy();
    },
  };
}
