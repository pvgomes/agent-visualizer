/*
 * The hire form's "Your setup": for a sandbox or an ssh box, set the agent up
 * there the way it is on this Mac. Five rows, each opening into checkboxes:
 * how it signs in (and which keys go along), its MCP servers, its
 * instructions and skills, the project, and one summary line. Only names
 * reach the page (GET /api/control/setup); the values are read by the office
 * at hire time. Choices are remembered per agent in this browser.
 *
 * What the page last heard for an agent and folder is shown at once (on open,
 * on switching back), while the office is asked again; the office answers
 * from its own cache too, and when that may be stale (`refreshing`) a second
 * request waits for its fresh look. The dialog never waits on it.
 */
import type {
  ControlMode, HireRequest, KeyInfo, SetupInventory, SetupLogin, SetupLoginKind, SetupMcp,
} from "../../../src/shared/control.ts";
import type { AgentKind } from "../../../src/shared/events.ts";
import { h, setText } from "../dom.ts";
import { tidyPath } from "../format.ts";
import { icon } from "../icons.ts";
import { agentName } from "../logos.ts";
import { api, ControlError } from "./api.ts";
import type { ControlStore } from "./store.ts";

export interface SetupSection {
  el: HTMLElement;
  /** The form's agent, place or mode changed (or the store did). */
  update(o: { agent: AgentKind; remote: boolean; mode: ControlMode }): void;
  readonly on: boolean;
  /** Put the choices into the request: req.setup, and the stored keys to pass in req.keys. */
  apply(req: HireRequest): void;
  /** Why Hire can't go yet ("Connect Claude first"), or "". */
  problem(): string;
  /** "Claude subscription · 4 of 6 MCP servers · instructions + 12 skills · ~/Codes/app (3.1 MB)". */
  summary(): string;
  /** Where the project goes there when "Folder there" is empty: "~/app". */
  cwdHint(): string | undefined;
  /** The dialog opened again: ask again (a key stored or Claude connected meanwhile), showing what we had until then. */
  refresh(): void;
}

interface Memory {
  on: boolean;
  login?: SetupLoginKind;
  mcpOff: string[];
  mcpOn: string[];
  insOff: string[];
  /** undefined: the most recent folder; null: none. */
  project?: string | null;
  git: boolean;
  env: boolean;
  keysOff: string[];
  keysOn: string[];
}

const STORE = "ao.hire.setup.v1";
/** Names the sign-in choice decides for these agents (not offered as plain key rows). */
const LOGIN_KEYS: Partial<Record<AgentKind, string[]>> = {
  claude: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"],
  codex: ["OPENAI_API_KEY"],
};

function loadAll(): Record<string, Memory> {
  try {
    const j = JSON.parse(localStorage.getItem(STORE) ?? "{}");
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

function saveAll(all: Record<string, Memory>): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(all));
  } catch {
    // Private window: remembered for this page only.
  }
}

const fresh = (): Memory => ({ on: true, mcpOff: [], mcpOn: [], insOff: [], git: true, env: false, keysOff: [], keysOn: [] });

function size(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1 << 20) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export function createSetupSection(store: ControlStore, opts: { openSettings(tab: "keys" | "logins"): void; changed(): void }): SetupSection {
  const all = loadAll();
  let agent: AgentKind = "claude";
  let remote = false;
  let mode: ControlMode = "terminal";
  let inv: SetupInventory | null = null;
  let invKey = "";
  let loading = false;
  let loadErr = "";
  /** The dialog reopened: the next load asks again even for the same agent and folder. */
  let stale = false;
  let gen = 0;
  /** Agent|folder -> what the office last said: shown at once next time while it is asked again. */
  const seen = new Map<string, SetupInventory>();
  const open = new Set<string>();

  const mem = (): Memory => (all[agent] ??= fresh());
  const save = () => saveAll(all);

  /* ---- elements ---- */
  const toggle = h("button", { class: "switch", attrs: { type: "button", role: "switch", "aria-checked": "true", "aria-label": "Bring my setup" } }, h("span", { class: "switch-thumb" }));
  const lede = h("p", { class: "hire-hint setup-lede" });
  const rows = h("div", { class: "setup-rows" });
  const line = h("p", { class: "setup-line", attrs: { "aria-live": "polite" } });
  const el = h(
    "section",
    { class: "hire-section hire-setup", attrs: { hidden: true } },
    h("div", { class: "setup-head" }, h("h3", { class: "hire-h", text: "Your setup" }), toggle),
    lede,
    rows,
    line,
  );
  toggle.addEventListener("click", () => {
    mem().on = !mem().on;
    save();
    render();
    opts.changed();
  });

  /* ---- data ---- */
  const folderOf = (): string | undefined => {
    const m = mem();
    if (m.project === null) return undefined;
    if (m.project) return m.project;
    return store.info?.recentFolders[0];
  };

  async function load(): Promise<void> {
    const folder = folderOf();
    const key = `${agent}|${folder ?? ""}`;
    if (key === invKey && !stale && (inv || loading || loadErr)) return;
    stale = false;
    const my = ++gen;
    const switched = key !== invKey;
    invKey = key;
    // what we had for it, until the office answers
    if (switched) inv = seen.get(key) ?? null;
    loading = !inv;
    loadErr = "";
    render();
    if (inv) opts.changed();
    const take = (got: SetupInventory) => {
      seen.set(key, got);
      if (my !== gen) return false;
      inv = got;
      loading = false;
      render();
      opts.changed();
      return true;
    };
    try {
      const got = await api.setup(agent, folder);
      // from the office's cache: shown now, and the fresh look follows
      if (take(got) && got.refreshing) take(await api.setup(agent, folder, true));
    } catch (e) {
      if (my !== gen) return;
      loading = false;
      // A folder that went away: forget it (and what was shown for it) and fall back to none.
      if (folder && e instanceof ControlError && (e.status === 404 || e.status === 403)) {
        seen.delete(key);
        inv = null;
        mem().project = null;
        save();
        invKey = "";
        void load();
        return;
      }
      // a hiccup with something on screen already: keep showing it
      if (inv) return;
      loadErr = e instanceof ControlError ? e.message : "Couldn't read your setup.";
      render();
      opts.changed();
    }
  }

  const logins = (): SetupLogin[] => (inv?.agent === agent ? inv.login : []).filter((l) => !(l.kind === "device" && mode !== "terminal"));
  function login(): SetupLogin | undefined {
    const ls = logins();
    if (!ls.length) return undefined;
    const want = mem().login;
    return ls.find((l) => l.kind === want && l.available) ?? ls.find((l) => l.available);
  }

  const storedKeys = (): KeyInfo[] => store.info?.keys ?? [];
  const keyNamesOf = () => store.info?.agents.find((a) => a.agent === agent)?.keyNames ?? [];
  /** Key rows: stored keys, then shell keys not stored; the sign-in's own names left to the sign-in. */
  function keyRows(): { name: string; shell: boolean; preview?: string; dflt: boolean }[] {
    const skip = logins().length ? new Set(LOGIN_KEYS[agent] ?? []) : new Set<string>();
    const mine = new Set(keyNamesOf());
    const out: { name: string; shell: boolean; preview?: string; dflt: boolean }[] = [];
    for (const k of storedKeys()) if (!skip.has(k.name) && !/^(DAYTONA_API_KEY|VERCEL_TOKEN|RAILWAY_API_TOKEN|BOAT_API_KEY)$/.test(k.name)) out.push({ name: k.name, shell: false, preview: k.preview, dflt: mine.has(k.name) || k.agents.includes(agent) });
    for (const n of inv?.shellKeys ?? []) if (!skip.has(n) && !out.some((r) => r.name === n)) out.push({ name: n, shell: true, dflt: true });
    return out;
  }
  const keyOn = (r: { name: string; dflt: boolean }) => (r.dflt ? !mem().keysOff.includes(r.name) : mem().keysOn.includes(r.name));

  const mcpOn = (m: SetupMcp) => (m.ok ? !mem().mcpOff.includes(m.name) : mem().mcpOn.includes(m.name));
  const movable = () => (inv?.mcp ?? []).filter((m) => m.scope !== "project");
  const insOn = (id: string) => !mem().insOff.includes(id);

  /* ---- render ---- */
  function row(id: string, ic: Parameters<typeof icon>[0], title: string, sum: string, body: Node[]): HTMLElement {
    const d = h("details", { class: "setup-row", attrs: { "data-row": id } }, h("summary", null, icon(ic, 1), h("b", { text: title }), h("span", { class: "setup-sum", text: sum })), h("div", { class: "setup-body" }, ...body));
    if (open.has(id)) d.open = true;
    d.addEventListener("toggle", () => {
      if (d.open) open.add(id);
      else open.delete(id);
    });
    return d;
  }

  function check(label: Node[], on: boolean, change: (on: boolean) => void, o: { disabled?: boolean; title?: string; sub?: string } = {}): HTMLElement {
    const box = h("input", { attrs: { type: "checkbox" } });
    box.checked = on;
    box.disabled = !!o.disabled;
    box.addEventListener("change", () => {
      change(box.checked);
      save();
      render();
      opts.changed();
    });
    return h("label", { class: `setup-check${o.disabled ? " is-off" : ""}`, attrs: o.title ? { title: o.title } : {} }, box, h("span", { class: "setup-check-main" }, ...label, o.sub ? h("small", { class: "setup-why", text: o.sub }) : null));
  }

  const toggleIn = (list: string[], name: string, on: boolean) => {
    const i = list.indexOf(name);
    if (on && i < 0) list.push(name);
    if (!on && i >= 0) list.splice(i, 1);
  };

  function loginRow(): HTMLElement {
    const body: Node[] = [];
    const ls = logins();
    const cur = login();
    if (ls.length) {
      const group = h("div", { class: "setup-radios", attrs: { role: "radiogroup", "aria-label": "Sign in with" } });
      for (const l of ls) {
        const b = h("input", { attrs: { type: "radio", name: `ao-setup-login-${agent}` } });
        b.checked = cur?.kind === l.kind;
        b.disabled = !l.available;
        b.addEventListener("change", () => {
          mem().login = l.kind;
          save();
          render();
          opts.changed();
        });
        const action = !l.available && l.kind === "subscription"
          ? h("button", { class: "btn btn-quiet btn-sm", attrs: { type: "button" }, text: "Connect Claude", on: { click: (ev: Event) => { ev.preventDefault(); opts.openSettings("logins"); } } })
          : !l.available && l.kind === "key"
            ? h("button", { class: "btn btn-quiet btn-sm", attrs: { type: "button" }, text: "Add a key", on: { click: (ev: Event) => { ev.preventDefault(); opts.openSettings("keys"); } } })
            : null;
        group.append(h("label", { class: `setup-check${l.available ? "" : " is-off"}` }, b, h("span", { class: "setup-check-main" }, h("span", { text: l.label }), h("small", { class: "setup-why", text: l.available ? (l.detail ?? "") : (l.why ?? "") })), action));
      }
      body.push(group);
      if (cur?.kind === "device") body.push(h("p", { class: "hire-hint", text: "Codex shows a link and a code in the panel; open it on this Mac and sign in. Device sign-in has to be on in ChatGPT's security settings." }));
      if (cur?.kind === "copy") body.push(h("p", { class: "hire-hint", text: "Your ChatGPT tokens go into ~/.codex/auth.json there (0600). Anyone who can open the sandbox can use them while it runs." }));
    }
    const krs = keyRows();
    if (krs.length) {
      body.push(h("span", { class: "hire-mini setup-sub", text: ls.length ? "Other keys" : "Keys" }));
      for (const r of krs) {
        body.push(
          check(
            [h("code", { class: "hire-key-name", text: r.name }), h("span", { class: "setup-tag", text: r.shell ? "from your shell" : (r.preview ?? "stored") })],
            keyOn(r),
            (on) => toggleIn(r.dflt ? mem().keysOff : mem().keysOn, r.name, r.dflt ? !on : on),
          ),
        );
      }
      if (krs.some((r) => r.shell)) body.push(h("p", { class: "hire-hint", text: "Keys from your shell are read when you hire and handed to this agent only; the office doesn't store them." }));
    } else if (!ls.length) {
      body.push(h("p", { class: "hire-hint", text: `No keys stored or exported in your shell. ${agentName(agent)} will sign in by itself in the terminal.` }));
    }
    const extra = krs.filter(keyOn).length;
    const sum = [cur?.label ?? (extra ? "" : "none"), extra ? `${extra} key${extra === 1 ? "" : "s"}` : ""].filter(Boolean).join(" + ");
    return row("login", "key", "Login", sum, body);
  }

  function mcpRow(): HTMLElement | null {
    const list = inv?.mcp ?? [];
    if (agent !== "claude" && agent !== "codex") return null;
    const body: Node[] = [];
    const mv = movable();
    if (!list.length) body.push(h("p", { class: "hire-hint", text: `No MCP servers in ${agent === "claude" ? "~/.claude.json" : "~/.codex/config.toml"}.` }));
    for (const m of mv) {
      body.push(
        check(
          [
            h("span", { class: "setup-name", text: m.name }),
            h("span", { class: "setup-tag", text: m.transport }),
            m.scope === "local" ? h("span", { class: "setup-tag", text: "this project" }) : null,
            m.secrets ? h("span", { class: "setup-tag setup-tag-key", attrs: { title: "Env or header values, written 0600 there" }, text: `${m.secrets} secret${m.secrets === 1 ? "" : "s"}` }) : null,
          ].filter(Boolean) as Node[],
          mcpOn(m),
          (on) => toggleIn(m.ok ? mem().mcpOff : mem().mcpOn, m.name, m.ok ? !on : on),
          { sub: m.ok ? (m.what ?? "") : `${m.why ?? "not pre-ticked"}${m.what ? ` · ${m.what}` : ""}` },
        ),
      );
    }
    const proj = list.filter((m) => m.scope === "project");
    if (proj.length) body.push(h("p", { class: "hire-hint", text: `In the project's .mcp.json, so they come with the code: ${proj.map((m) => m.name).join(", ")}.` }));
    if (agent === "claude") body.push(h("p", { class: "hire-hint", text: "claude.ai connectors don't come along with a setup-token sign-in; servers set up on this Mac do." }));
    const on = mv.filter(mcpOn).length;
    return row("mcp", "server", "MCP servers", mv.length ? `${on} of ${mv.length}` : "none", body);
  }

  function insRow(): HTMLElement | null {
    if (agent !== "claude" && agent !== "codex") return null;
    const items = inv?.instructions ?? [];
    const body: Node[] = [];
    if (!items.length) body.push(h("p", { class: "hire-hint", text: `Nothing in ${agent === "claude" ? "~/.claude" : "~/.codex"} to bring.` }));
    for (const it of items) {
      const what = it.id === "skills" ? `${it.count ?? 0} skill${it.count === 1 ? "" : "s"} · ${size(it.bytes)}` : it.files > 1 ? `${it.files} files · ${size(it.bytes)}` : size(it.bytes);
      body.push(check([h("span", { class: "setup-name", text: it.label }), h("span", { class: "setup-tag", text: what })], insOn(it.id), (on) => toggleIn(mem().insOff, it.id, !on), it.skipped?.length ? { sub: `Left out: ${it.skipped.slice(0, 4).join("; ")}${it.skipped.length > 4 ? `; +${it.skipped.length - 4} more` : ""}` } : {}));
    }
    if (items.length) body.push(h("p", { class: "hire-hint", text: "Copied 0600 into the agent's own folder there. Links that leave the folder, big binaries and more than 20 MB stay here." }));
    return row("instructions", "feed", "Instructions and skills", insSummary() || "none", body);
  }

  function insSummary(): string {
    const items = (inv?.instructions ?? []).filter((i) => insOn(i.id));
    const skills = items.find((i) => i.id === "skills")?.count ?? 0;
    const main = items.some((i) => i.id === "CLAUDE.md" || i.id === "AGENTS.md") ? "instructions" : items.filter((i) => i.id !== "skills").map((i) => i.label.toLowerCase()).join(", ");
    return [main, skills ? `${skills} skill${skills === 1 ? "" : "s"}` : ""].filter(Boolean).join(" + ");
  }

  function projectRow(): HTMLElement {
    const body: Node[] = [];
    const recent = (store.info?.recentFolders ?? []).slice(0, 6);
    const cur = folderOf();
    const chips = h("div", { class: "hire-recent" });
    const pick = (f: string | null) => {
      mem().project = f;
      save();
      void load();
      render();
      opts.changed();
    };
    chips.append(h("button", { class: "chip-btn", attrs: { type: "button", "aria-pressed": String(!cur) }, text: "None", on: { click: () => pick(null) } }));
    for (const f of [...new Set([...(cur && !recent.includes(cur) ? [cur] : []), ...recent])]) {
      chips.append(h("button", { class: "chip-btn", attrs: { type: "button", "aria-pressed": String(f === cur), title: tidyPath(f) }, text: f.split("/").filter(Boolean).pop() || f, on: { click: () => pick(f) } }));
    }
    body.push(chips);
    const p = inv?.project;
    let sum = "none";
    if (cur && p && p.folder) {
      const m = mem();
      sum = p.ok ? `${p.display} (${size(p.bytes + (m.git && p.git.ok ? p.git.bytes : 0))})` : `${p.display}: too big`;
      body.push(h("p", { class: `setup-proj${p.ok ? "" : " is-err"}`, text: p.ok ? `${p.display} · ${p.files.toLocaleString()} file${p.files === 1 ? "" : "s"} · ${size(p.bytes)}` : (p.why ?? "Too big to upload") }));
      if (p.ok) {
        body.push(check([h("span", { text: "History (.git)" }), h("span", { class: "setup-tag", text: p.git.present ? size(p.git.bytes) : "not a git repo" })], m.git && p.git.ok, (on) => (m.git = on), { disabled: !p.git.ok, sub: p.git.ok ? "So the agent can diff and commit there. Hooks stay here; credentials come out of remote URLs." : (p.git.why ?? "") }));
        if (p.envFiles.length) body.push(check([h("span", { text: ".env files" }), h("span", { class: "setup-tag setup-tag-key", text: p.envFiles.slice(0, 3).join(", ") + (p.envFiles.length > 3 ? ` +${p.envFiles.length - 3}` : "") })], m.env, (on) => (m.env = on), { sub: "Off unless you tick it. Written 0600 there." }));
        if (p.skipped?.length) body.push(h("p", { class: "hire-hint", text: `Left out: ${p.skipped.slice(0, 4).join("; ")}${p.skipped.length > 4 ? `; +${p.skipped.length - 4} more` : ""}` }));
        body.push(h("p", { class: "hire-hint", text: `Tracked files plus untracked ones .gitignore doesn't exclude, into ${cwdHint() ?? "the folder there"} (only if it's empty, outside a sandbox the office made).` }));
      }
    } else if (cur && loading) body.push(h("p", { class: "hire-hint", text: "Reading the folder…" }));
    else body.push(h("p", { class: "hire-hint", text: "Pick a folder to upload it into the sandbox: its files, its history, not what .gitignore excludes." }));
    return row("project", "folder", "Project", sum, body);
  }

  function cwdHint(): string | undefined {
    const f = folderOf();
    if (!f || !inv?.project?.ok) return undefined;
    const name = (f.split("/").filter(Boolean).pop() ?? "project").replace(/[^\w.-]+/g, "-").replace(/^[.-]+/, "") || "project";
    return `~/${name}`;
  }

  function summary(): string {
    if (!remote || !mem().on || !inv) return "";
    const bits: string[] = [];
    const l = login();
    if (l && l.kind !== "none") bits.push(l.label);
    const k = keyRows().filter(keyOn).length;
    if (k) bits.push(`${k} key${k === 1 ? "" : "s"}`);
    const mv = movable();
    if (mv.length) bits.push(`${mv.filter(mcpOn).length} of ${mv.length} MCP servers`);
    const ins = insSummary();
    if (ins) bits.push(ins);
    const p = inv.project;
    if (folderOf() && p?.ok) bits.push(`${p.display} (${size(p.bytes + (mem().git && p.git.ok ? p.git.bytes : 0))})`);
    return bits.join(" · ") || "Nothing to bring";
  }

  function render(): void {
    el.hidden = !remote;
    if (!remote) return;
    const on = mem().on;
    toggle.setAttribute("aria-checked", String(on));
    rows.hidden = !on;
    line.hidden = !on;
    setText(lede, on ? `Sets ${agentName(agent)} up there the way it is on this Mac. This page sees names only; the values go to that one agent, in 0600 files there.` : "Off: an empty folder there, and only the keys you tick below.");
    if (!on) return;
    if (!inv && loading) {
      rows.replaceChildren(h("p", { class: "hire-hint", text: "Reading your setup…" }));
      setText(line, "");
      return;
    }
    if (!inv && loadErr) {
      rows.replaceChildren(h("p", { class: "hire-err", text: loadErr }));
      setText(line, "");
      return;
    }
    rows.replaceChildren(...[loginRow(), mcpRow(), insRow(), projectRow()].filter(Boolean) as HTMLElement[]);
    setText(line, summary());
    for (const n of inv?.notes.filter((x) => !/connectors/.test(x)) ?? []) rows.append(h("p", { class: "hire-hint", text: n }));
  }

  return {
    el,
    update(o) {
      agent = o.agent;
      remote = o.remote;
      mode = o.mode;
      // asked for while the place is still this Mac too, so switching to a sandbox finds it ready
      if (mem().on) void load();
      render();
    },
    get on() {
      return remote && mem().on;
    },
    apply(req) {
      if (!remote || !mem().on || !inv) return;
      const l = login();
      const stored = new Set(storedKeys().map((k) => k.name));
      const keys = new Set(req.keys ?? []);
      const shell: string[] = [];
      for (const r of keyRows()) {
        if (!keyOn(r)) continue;
        if (r.shell) shell.push(r.name);
        else keys.add(r.name);
      }
      for (const n of l?.keys ?? []) {
        if (stored.has(n)) keys.add(n);
        else if ((inv.shellKeys ?? []).includes(n)) shell.push(n);
      }
      const folder = folderOf();
      req.keys = [...keys];
      req.setup = {
        login: l?.kind ?? "none",
        shellKeys: [...new Set(shell)],
        mcp: movable().filter(mcpOn).map((m) => m.name),
        instructions: (inv.instructions ?? []).filter((i) => insOn(i.id)).map((i) => i.id),
        ...(folder && inv.project?.ok ? { project: { folder, git: mem().git && !!inv.project.git.ok, env: mem().env } } : {}),
      };
    },
    problem() {
      if (!remote || !mem().on) return "";
      if (loading && !inv) return "Reading your setup…";
      if (!inv) return `${loadErr || "Couldn't read your setup"}. Turn Your setup off to hire without it.`;
      const l = login();
      if (logins().length && !l) return "Pick how it signs in.";
      return "";
    },
    summary,
    cwdHint,
    refresh() {
      stale = true;
    },
  };
}
