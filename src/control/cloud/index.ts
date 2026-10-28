/*
 * Places: everywhere an agent can run that isn't this machine. Sandboxes on
 * Daytona, Vercel and Railway (created from the page, or already running),
 * and ssh boxes. One Cloud driver per platform, one ssh driver.
 *
 * Status is cached (30 s; Railway 2 min, its API quota is tight). A row past
 * that is answered at once and refreshed behind it; a platform not seen yet
 * gets 3 s (less when the caller says so), then shows just its login state.
 * Either way the fresh row arrives later through onChange.
 *
 * Cost guard: a new sandbox lives 30 minutes by default (1 to 240), the
 * office keeps at most MAX_OFFICE_SANDBOXES of its own at once (the next
 * create is a 409 naming them), nothing is ever extended, heartbeats stop
 * when the session ends, and only sandboxes the office created are deleted
 * without force. Every create is recorded in sandboxes.json before the
 * sandbox is even up, so a crash mid-create can't orphan one silently.
 *
 * Watching: an opened place's target is handed to ctx.watch, so its
 * transcripts are polled even outside auto-detect's scope (that's how the
 * hired worker links), and released 2 minutes after the session closes it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Place, ProviderStatus, SandboxInfo } from "../../shared/control.ts";
import { readRemoteConfig } from "../../remote/config.ts";
import type { RailwayBudget } from "../../remote/railway.ts";
import { homeOf, which, type FetchFn } from "../../remote/util.ts";
import {
  ControlError, MAX_OFFICE_SANDBOXES, SANDBOX_TIMEOUT_MIN,
  type Disposable, type OpenOptions, type Places, type PlacesContext, type RemotePlace,
} from "../types.ts";
import { daytonaCloud } from "./daytona.ts";
import { Listeners, Registry, asControlError, sandboxName, type BasePlace, type Cloud, type CloudDeps, type CloudKind } from "./place.ts";
import { railwayCloud } from "./railway.ts";
import { openSsh, sshConfigHosts } from "./ssh.ts";
import { vercelCloud } from "./vercel.ts";

export { Registry } from "./place.ts";

const TTL_MS: Record<ProviderStatus["kind"], number> = { daytona: 30_000, vercel: 30_000, railway: 120_000, ssh: 30_000 };
const DEADLINE_MS = 3_000;
const UNWATCH_AFTER_MS = 2 * 60_000;
const ORDER: ProviderStatus["kind"][] = ["daytona", "vercel", "railway", "ssh"];

export interface PlacesOptions {
  fetch?: FetchFn;
  /** Share the watcher's Railway budget (the integrator passes the same instance to both). */
  railwayBudget?: RailwayBudget;
  /** Platform CLIs and ssh (tests). */
  bins?: CloudDeps["bins"] & { ssh?: string };
  /** How often a starting sandbox is checked (tests). */
  pollMs?: number;
  /** Replace a driver (tests). */
  clouds?: Partial<Record<CloudKind, Cloud>>;
  /** Per-platform answer deadline for status() (default 3 s). */
  deadlineMs?: number;
  unwatchAfterMs?: number;
}

interface Cached {
  at: number;
  value: ProviderStatus;
}

export function createPlaces(ctx: PlacesContext, o: PlacesOptions = {}): Places {
  const registry = new Registry(ctx.home);
  const deps: CloudDeps = { ctx, registry, fetch: o.fetch, pollMs: o.pollMs, bins: o.bins, railwayBudget: o.railwayBudget };
  const clouds: Record<CloudKind, Cloud> = {
    daytona: o.clouds?.daytona ?? daytonaCloud(deps),
    vercel: o.clouds?.vercel ?? vercelCloud(deps),
    railway: o.clouds?.railway ?? railwayCloud(deps),
  };
  const cache = new Map<ProviderStatus["kind"], Cached>();
  const inflight = new Map<ProviderStatus["kind"], Promise<ProviderStatus>>();
  /** When the look under way for a platform with no row yet was first waited on. */
  const waitingSince = new Map<ProviderStatus["kind"], number>();
  const changes = new Listeners<ProviderStatus[]>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const watches = new Set<Disposable>();
  /** Host id -> releases of the watches its places hold, so deleting a sandbox stops polling it at once. */
  const byHost = new Map<string, Set<() => void>>();
  const deadline = o.deadlineMs ?? DEADLINE_MS;
  /** "<provider>:<id>" -> when the office deleted it: a platform can keep listing a sandbox for a minute or two after. */
  const deleted = new Map<string, number>();
  const DELETED_HIDE_MS = 5 * 60_000;
  let creating = 0;
  let down = false;

  function sshStatus(): ProviderStatus {
    const env = ctx.providerEnv();
    const ssh = o.bins?.ssh ?? which("ssh", env);
    const hosts: string[] = [];
    try {
      hosts.push(...sshConfigHosts(readFileSync(join(homeOf(env), ".ssh", "config"), "utf8")));
    } catch {
      // No ssh config.
    }
    for (const s of readRemoteConfig(env).selectors) if (s.kind === "ssh" && !hosts.includes(s.id)) hosts.push(s.id);
    return { kind: "ssh", name: "ssh", ready: !!ssh, ...(ssh ? { via: "ssh" } : { note: "No ssh client on this machine" }), canCreate: false, sandboxes: [], hosts };
  }

  /** Just the login state: what a platform shows before (or instead of) its first answer. */
  function offline(kind: CloudKind): ProviderStatus {
    const c = clouds[kind];
    const l = c.login();
    return { kind, name: c.name, ready: l.ready, ...(l.via ? { via: l.via } : {}), canCreate: false, sandboxes: [], ...(l.why ? { note: l.why } : {}) };
  }

  function refresh(kind: ProviderStatus["kind"]): Promise<ProviderStatus> {
    let p = inflight.get(kind);
    if (p) return p;
    p = (async () => {
      try {
        if (kind === "ssh") return sshStatus();
        return await clouds[kind].status();
      } catch (err) {
        const prev = cache.get(kind)?.value;
        const base = kind === "ssh" ? sshStatus() : offline(kind);
        return { ...(prev ?? base), note: asControlError(err).message };
      }
    })().then((v) => {
      inflight.delete(kind);
      if (deleted.size && v.sandboxes.length) {
        const t = ctx.now();
        for (const [k, at] of deleted) if (t - at > DELETED_HIDE_MS) deleted.delete(k);
        v = { ...v, sandboxes: v.sandboxes.filter((x) => !deleted.has(`${kind}:${x.id}`)) };
      }
      const prev = cache.get(kind)?.value;
      cache.set(kind, { at: ctx.now(), value: v });
      if (prev && JSON.stringify(prev) !== JSON.stringify(v)) emit();
      return v;
    });
    inflight.set(kind, p);
    return p;
  }

  function emit(): void {
    if (down) return;
    const all = ORDER.map((k) => cache.get(k)?.value ?? (k === "ssh" ? sshStatus() : offline(k)));
    changes.emit(all);
  }

  async function one(kind: ProviderStatus["kind"], fresh: boolean, wait = deadline): Promise<ProviderStatus> {
    const hit = cache.get(kind);
    if (hit && !fresh && ctx.now() - hit.at < TTL_MS[kind]) return hit.value;
    // Stale: the last known row now, the refresh behind it (refresh() emits when it differs).
    if (hit && !fresh) {
      refresh(kind).catch(() => {});
      return hit.value;
    }
    const fresh0 = !inflight.has(kind);
    const p = refresh(kind);
    // A look already under way since earlier: only what is left of its deadline (one wait, not one per caller).
    if (fresh0) waitingSince.set(kind, ctx.now());
    p.finally(() => waitingSince.delete(kind)).catch(() => {});
    const left = wait - (ctx.now() - (waitingSince.get(kind) ?? ctx.now()));
    let t: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<undefined>((r) => {
      t = setTimeout(() => r(undefined), Math.max(0, left));
      t.unref?.();
    });
    const v = await Promise.race([p, late]);
    if (t) clearTimeout(t);
    if (v) return v;
    // Too slow: the last known row, or the login state; the real answer comes through onChange.
    p.then(() => emit(), () => {});
    return hit?.value ?? (kind === "ssh" ? sshStatus() : offline(kind));
  }

  async function status(so?: { fresh?: boolean; deadlineMs?: number }): Promise<ProviderStatus[]> {
    return Promise.all(ORDER.map((k) => one(k, !!so?.fresh, Math.min(deadline, so?.deadlineMs ?? deadline))));
  }

  /** Office sandboxes alive right now, from a fresh look at every platform. */
  async function ourLive(): Promise<SandboxInfo[]> {
    const rows = await Promise.all((["daytona", "vercel", "railway"] as CloudKind[]).map((k) => refresh(k).catch(() => cache.get(k)?.value)));
    const live: SandboxInfo[] = [];
    for (const r of rows) for (const s of r?.sandboxes ?? []) if (s.ours && (s.status === "running" || s.status === "starting")) live.push(s);
    // Recorded but not confirmed either way (a platform that didn't answer) still counts.
    for (const rec of registry.list()) if (!live.some((s) => s.provider === rec.provider && s.id === rec.id) && !rows.some((r) => r?.kind === rec.provider && r.ready)) {
      live.push({ id: rec.id, name: rec.name, provider: rec.provider, status: "unknown", ours: true, workers: 0 });
    }
    return live;
  }

  function hold(place: BasePlace): RemotePlace {
    const w = ctx.watch(place.target);
    watches.add(w);
    const hostId = place.host.id;
    let t: ReturnType<typeof setTimeout> | undefined;
    const release = () => {
      if (t) {
        clearTimeout(t);
        timers.delete(t);
      }
      const set = byHost.get(hostId);
      if (set?.delete(release) && !set.size) byHost.delete(hostId);
      if (!watches.delete(w)) return;
      w.dispose();
    };
    let held = byHost.get(hostId);
    if (!held) byHost.set(hostId, (held = new Set()));
    held.add(release);
    place.onClose(() => {
      // A last transcript poll after the agent quit still links its lines; then stop watching.
      t = setTimeout(release, o.unwatchAfterMs ?? UNWATCH_AFTER_MS);
      t.unref?.();
      timers.add(t);
    });
    return place;
  }

  async function open(place: Place, oo: OpenOptions): Promise<RemotePlace> {
    if (down) throw new ControlError(409, "The office is shutting down");
    try {
      if (place.kind === "local") throw new ControlError(400, "This machine isn't a remote place");
      if (place.kind === "ssh") return hold(await openSsh(ctx, place, oo, { bin: o.bins?.ssh }));
      const cloud = clouds[place.kind as CloudKind];
      if (!cloud) throw new ControlError(400, `Unknown place ${String(place.kind).slice(0, 20)}`);
      if (!place.target) throw new ControlError(400, "Which sandbox?");
      if (place.target !== "new") return hold(await cloud.open(place.target, place.cwd, oo));

      const timeoutMin = Math.round(Math.min(SANDBOX_TIMEOUT_MIN.max, Math.max(1, oo.sandbox?.timeoutMin ?? SANDBOX_TIMEOUT_MIN.default)));
      // Two hires at once must not both slip under the cap.
      if (creating >= MAX_OFFICE_SANDBOXES) throw new ControlError(409, `The office is already creating ${creating} sandboxes`);
      creating++;
      try {
        const live = await ourLive();
        if (live.length + creating - 1 >= MAX_OFFICE_SANDBOXES) {
          const names = live.map((s) => s.name).slice(0, MAX_OFFICE_SANDBOXES).join(", ");
          throw new ControlError(409, `The office already runs ${live.length} sandboxes it created (${names}); delete one first`);
        }
        const kind = place.kind as CloudKind;
        let made: string | undefined;
        let place2: BasePlace;
        try {
          const { project, environment } = oo.sandbox ?? {};
          const onCreated = (id: string) => {
            made = id;
            // A name used again (Vercel's ids are names) is a new sandbox, not the one deleted just now.
            deleted.delete(`${kind}:${id}`);
          };
          place2 = await cloud.create({ name: sandboxName(oo.sandbox?.name), timeoutMin, cwd: place.cwd, ...(project ? { project } : {}), ...(environment ? { environment } : {}), onCreated }, oo);
        } catch (err) {
          // Stopped while it was being created, or it never came up: nobody will use it.
          if (!made) throw err;
          const gone = await discard(kind, made, oo.signal?.aborted ? "stopped while it was being created" : "it didn't come up");
          const e = asControlError(err);
          throw new ControlError(e.status, `${e.message.replace(/[.\s]+$/, "")}; ${gone ? "the sandbox was deleted" : "the sandbox is still running: delete it in Settings"}`);
        }
        refresh(kind).then(() => emit(), () => {});
        const id = made;
        if (id) place2.discard = () => discard(kind, id, "its agent never started");
        return hold(place2);
      } finally {
        creating--;
      }
    } catch (err) {
      throw asControlError(err);
    }
  }

  /** Delete a sandbox the office just created for a session that never got going. Never throws: false when it is still there. */
  async function discard(kind: CloudKind, id: string, why: string): Promise<boolean> {
    try {
      await deleteSandbox(kind, id, false, `${clouds[kind].name} sandbox ${id.slice(0, 40)} deleted: ${why}`);
      return true;
    } catch (err) {
      ctx.log(`${clouds[kind].name} sandbox ${id.slice(0, 40)} is still running (${asControlError(err).message}); delete it in Settings`, "warn");
      return false;
    }
  }

  async function deleteSandbox(provider: SandboxInfo["provider"], id: string, force?: boolean, logLine?: string): Promise<void> {
    const cloud = clouds[provider];
    if (!cloud) throw new ControlError(400, "Unknown provider");
    if (typeof id !== "string" || !id || id.length > 200) throw new ControlError(400, "Which sandbox?");
    // Only what sandboxes.json records: the platform's label can be set by anyone (a teammate's office too).
    const ours = !!registry.get(provider, id);
    if (!ours && !force) throw new ControlError(409, "The office didn't create this sandbox; delete it with force, or on the platform");
    try {
      await cloud.remove(id);
    } catch (err) {
      throw asControlError(err);
    }
    ctx.log(logLine ?? `${cloud.name} sandbox ${id.slice(0, 40)} deleted`);
    deleted.set(`${provider}:${id}`, ctx.now());
    // Nothing left to poll there: release its watches now rather than after the linger.
    for (const release of [...(byHost.get(`${provider}:${id}`) ?? [])]) release();
    await refresh(provider).catch(() => {});
    emit();
  }

  return {
    status,
    open,
    deleteSandbox,
    onChange: (fn) => changes.on(fn),
    shutdown() {
      down = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const w of watches) w.dispose();
      watches.clear();
      byHost.clear();
    },
  };
}
