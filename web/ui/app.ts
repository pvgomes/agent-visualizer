/*
 * Mounts the chrome around a scene and wires it together: the model, HUD,
 * feed, inspector, toolbar, toasts, sound and keyboard, and the control plane
 * (Hire, the session panel, settings). main.ts owns the connection and calls
 * load / apply / connection / control on what this returns.
 */
import type { OfficeScene } from "../contract.ts";
import { BRAND, type OfficeEvent, type Snapshot } from "../../src/shared/events.ts";
import { canRecord, record, ReplayBuffer, screenshot, type Recording } from "./capture.ts";
import type { ConnState } from "./connection.ts";
import { h } from "./dom.ts";
import { createFeed } from "./feed.ts";
import { createInspector } from "./inspector.ts";
import { agentName, hostLabel, isRemote } from "./logos.ts";
import { cameraFlash, createConnPill, createEmpty, createHelp, createStreamHint } from "./overlays.ts";
import { createLocationPicker } from "./location.ts";
import { DEFAULT_CITY, cityOf, type CityId } from "../cities.ts";
import { Sound } from "./sound.ts";
import { OfficeModel } from "./state.ts";
import { Toasts } from "./toasts.ts";
import { createToolbar } from "./toolbar.ts";
import { createTopbar } from "./topbar.ts";
import type { HireDialog } from "./control/hire.ts";
import { createSessionPanel, prefetchViews } from "./control/session.ts";
import { createSessionList } from "./control/sessions.ts";
import type { SettingsDrawer, SettingsTab } from "./control/settings.ts";
import { ControlStore } from "./control/store.ts";
import { controlToken } from "./control/token.ts";
import type { ControlSession } from "../../src/shared/control.ts";

export interface Chrome {
  load(s: Snapshot): void;
  apply(e: OfficeEvent): void;
  connection(state: ConnState, retryInMs?: number): void;
  /** `control`, `control_gone` or `control_info` from /events. */
  control(name: string, data: unknown): void;
  /** This browser holds a control token: ask for the control plane now, alongside /events, not after its snapshot. */
  prime(): void;
}

/** How to unlock, for the empty office. The page can't tell how the office was installed: npx works either way. */
const LOCKED_HOW = "Locked in this browser: run npx @pvgomes/agent-visualizer open where the office runs (--print for a link to paste here)";
/** The same, short enough for a toolbar tooltip or a toast. */
const LOCKED_TIP = "Locked: run npx @pvgomes/agent-visualizer open to unlock";

const REC_MS = 10_000;
/** Height kept clear for the toast row under the top bar (desktop). */
const TOAST_ROW = 44;
/** A worker still waiting on its human after this long gets a toast. */
const WAIT_TOAST_MS = 15_000;
const PREFS_KEY = "agent-visualizer:ui";

interface Prefs {
  city?: CityId;
  crt?: boolean;
  feed?: boolean;
}

function readPrefs(): Prefs {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Prefs;
  } catch {
    return {};
  }
}

function writePrefs(p: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* private mode: prefs are a convenience */
  }
}

const isPhone = () => matchMedia("(max-width: 640px)").matches;

export function mountChrome(root: HTMLElement, scene: OfficeScene): Chrome {
  const model = new OfficeModel();
  const sound = new Sound();
  const toasts = new Toasts();
  const topbar = createTopbar({ onNeedsYou: nextWaiting });
  const prefs = readPrefs();
  let selected: string | null = null;
  let crt = !!prefs.crt;
  let city: CityId = cityOf(prefs.city ?? DEFAULT_CITY).id;
  let streamMode = false;
  let recording: Recording | null = null;
  let connState: ConnState = "connecting";
  let goneTimer = 0;
  let warned = false;

  const safe = (fn: () => void) => {
    try {
      fn();
    } catch (err) {
      if (!warned) console.warn("[agent-visualizer] scene error", err);
      warned = true;
    }
  };

  const inspector = createInspector({ onClose: () => select(null), onFocus: (id) => safe(() => scene.focus(id)) });
  const feed = createFeed({ onPick: (id) => select(id, true), onToggle: () => setFeed(!feed.isOpen()) });

  /* ---- the control plane ---- */
  const store = new ControlStore();
  const say = (text: string, tone: "plain" | "error" | "pass" = "plain") =>
    toasts.show({ text, tone, glyph: tone === "error" ? "error" : tone === "pass" ? "pass" : undefined, key: `ctl:${text}`, every: 1500 });
  const panel = createSessionPanel(store, {
    onClose: closePanel,
    onLayout: () => syncInsets(),
    onFocusWorker: (wid) => {
      if (!model.get(wid)) return;
      selected = wid;
      safe(() => scene.select(wid));
      safe(() => scene.focus(wid));
      feed.highlight(wid);
    },
    toast: say,
    worker: (wid) => model.get(wid),
  });
  /*
   * Hire and Settings are chunks of their own, like the session views: built on first use (or
   * ahead of it, on hover and on idle), each in the place its slot holds in the chrome.
   */
  let hire: HireDialog | null = null;
  let settings: SettingsDrawer | null = null;
  const hireSlot = document.createComment("hire");
  const settingsSlot = document.createComment("settings");
  let hireLoad: Promise<HireDialog> | null = null;
  let settingsLoad: Promise<SettingsDrawer> | null = null;
  function loadHire(): Promise<HireDialog> {
    return (hireLoad ??= import("./control/hire.ts").then(
      (m) => {
        const d = m.createHire(store, {
          onHired: (s) => {
            store.upsert(s);
            openSession(s);
            say(`Hiring ${agentName(s.agent)}…`);
          },
          openSettings: (tab) => {
            d.close();
            openSettings(tab);
          },
        });
        hireSlot.replaceWith(d.el);
        hire = d;
        return d;
      },
      (err: unknown) => {
        hireLoad = null;
        throw err;
      },
    ));
  }
  function loadSettings(): Promise<SettingsDrawer> {
    return (settingsLoad ??= import("./control/settings.ts").then(
      (m) => {
        const d = m.createSettings(store, { onClose: closeSettings, toast: say });
        settingsSlot.replaceWith(d.el);
        settings = d;
        ro.observe(d.el);
        syncInert();
        return d;
      },
      (err: unknown) => {
        settingsLoad = null;
        throw err;
      },
    ));
  }
  const sessionList = createSessionList(store, { onPick: (s) => openSession(s, true), onHire: openHire, onHover: (s) => prefetchViews([s.mode]) });

  const toolbar = createToolbar({
    hire: openHire,
    location: () => (locPicker.isOpen() ? locPicker.close() : locPicker.open(city)),
    sessions: (anchor) => sessionList.toggle(anchor),
    settings: () => (settings?.isOpen() ? closeSettings() : openSettings()),
    crt: () => setCrt(!crt),
    shot,
    rec: clipThat,
    full,
    stream: () => setStream(!streamMode),
    sound: toggleSound,
    feed: () => setFeed(!feed.isOpen()),
    help: () => help.toggle(),
  });
  const empty = createEmpty({ onHire: openHire });
  const conn = createConnPill();
  const help = createHelp();
  const locPicker = createLocationPicker({ onPick: (c) => setCity(c), preview: scene.previewCity ? (c, w, hh) => scene.previewCity!(c, w, hh) : undefined });
  const hint = createStreamHint(() => setStream(false));
  const flashRoot = h("div", { class: "flash-root" });

  root.append(topbar.el, feed.el, feed.tab, inspector.el, panel.el, settingsSlot, toolbar.el, toasts.el, conn.el, empty.el, hint.el, hint.corner, sessionList.el, toolbar.tip, help.el, locPicker.el, hireSlot, flashRoot);

  /*
   * Code before it is needed. The pointer on a worker the office started, or on a "Your agents"
   * row: that session's view. On Hire or Settings: theirs (and Hire's "Your setup", warmed on the
   * server). After the first frames, on idle: all of it, and an xterm built ahead.
   */
  const viewsFor = (workerId: string | null) => {
    const s = store.forWorker(workerId);
    if (s) prefetchViews([s.mode]);
  };
  scene.onHover?.((id) => viewsFor(id));
  toolbar.el.querySelector(".tb-sessions")?.addEventListener("pointerenter", () => prefetchViews([...new Set(store.list().map((s) => s.mode))]));
  const hireBtn = toolbar.el.querySelector(".tb-hire");
  for (const ev of ["pointerenter", "focus"]) {
    hireBtn?.addEventListener(ev, () => {
      if (store.state !== "enabled") return;
      void loadHire().then((d) => d.warm(), () => {});
    });
    toolbar.el.querySelector(".tb-settings")?.addEventListener(ev, () => store.state === "enabled" && void loadSettings().catch(() => {}));
  }
  let idleDone = false;
  /** Once the office has painted and the controls are known: everything a click may need, one piece per idle slot. */
  function idlePrefetch(): void {
    if (idleDone || store.state !== "enabled") return;
    idleDone = true;
    const idle = (fn: () => void) => (typeof requestIdleCallback === "function" ? requestIdleCallback(() => fn(), { timeout: 3000 }) : window.setTimeout(fn, 400));
    const steps = [
      () => prefetchViews(["terminal"], { warm: true }),
      () => prefetchViews(["chat"]),
      // the dialog's code, and its "Your setup" read on the office (cached there from then on)
      () => void loadHire().then((d) => d.warm(), () => {}),
      () => void loadSettings().catch(() => {}),
    ];
    const next = () => {
      const step = steps.shift();
      if (!step) return;
      step();
      idle(next);
    };
    window.setTimeout(() => idle(next), 600);
  }

  scene.onSelect((id) => select(id));
  setCrt(crt, false);
  setCity(city, false);
  setFeed(isPhone() ? false : prefs.feed !== false, false);
  toolbar.setSound(false);
  topbar.update(model, false);

  /* Auto-fit frames the office in the space the panels leave free. Offsets,
   * not rects: the feed slides out with a transform, and the camera should
   * glide to where it ends up, not chase the animation. */
  function syncInsets(): void {
    const vw = window.innerWidth, vh = window.innerHeight;
    const gap = 8;
    let top = 0, right = 0, bottom = 0, left = 0;
    // The inspector (a side panel, or a bottom sheet on a phone) comes and goes with a click:
    // the camera frames the selected worker clear of it, but the office isn't re-packed for it.
    const overlay = { top: 0, right: 0, bottom: 0, left: 0 };
    if (!streamMode) {
      // Room for one toast under the bar, so the big moments' toasts don't sit on the office.
      top = topbar.el.offsetTop + topbar.el.offsetHeight + gap + (isPhone() ? 0 : TOAST_ROW);
      bottom = Math.max(0, vh - toolbar.el.offsetTop + gap);
      if (!isPhone() && feed.isOpen()) right = Math.max(0, vw - feed.el.offsetLeft + gap);
      if (selected && model.get(selected) && !inspector.el.hidden) {
        if (!isPhone()) overlay.left = inspector.el.offsetLeft + inspector.el.offsetWidth + gap;
        else overlay.bottom = Math.max(0, vh - inspector.el.offsetTop + gap);
      }
      // the session panel and the settings drawer sit on the right, over the feed
      for (const side of [panel.isOpen() && !panel.isMax() ? panel.el : null, settings?.isOpen() ? settings.el : null]) {
        if (side && !isPhone()) overlay.right = Math.max(overlay.right, vw - side.offsetLeft + gap);
      }
      // On a phone the empty card sits low over the floor: frame the empty office above it.
      const card = empty.el.querySelector<HTMLElement>(".empty");
      if (isPhone() && !empty.el.hidden && card) overlay.bottom = Math.max(overlay.bottom, vh - card.getBoundingClientRect().top + gap);
    }
    // a right-hand panel is open: the toolbar centres in the room left of it
    const sideEl = !isPhone() && !streamMode ? (settings?.isOpen() ? settings.el : panel.isOpen() && !panel.isMax() ? panel.el : null) : null;
    if (sideEl) {
      const tbw = toolbar.el.offsetWidth;
      const freeRight = sideEl.offsetLeft - gap;
      const gutter = topbar.el.offsetLeft;
      toolbar.el.style.left = `${Math.round(Math.max(gutter + tbw / 2, Math.min(freeRight - tbw / 2, freeRight / 2)))}px`;
      document.body.classList.toggle("toolbar-cramped", freeRight < tbw + gutter);
    } else {
      toolbar.el.style.left = "";
      document.body.classList.remove("toolbar-cramped");
    }
    const insets = { top, right, bottom, left };
    const style = document.documentElement.style;
    for (const [k, v] of Object.entries(insets)) style.setProperty(`--scene-inset-${k}`, `${Math.max(v, overlay[k as keyof typeof overlay])}px`);
    safe(() => scene.setInsets?.(insets, overlay));
  }
  const ro = new ResizeObserver(() => syncInsets());
  for (const el of [topbar.el, toolbar.el, feed.el, inspector.el, panel.el]) ro.observe(el);
  window.addEventListener("resize", syncInsets);
  requestAnimationFrame(syncInsets);

  function save(): void {
    writePrefs({ city, crt, feed: isPhone() ? prefs.feed : feed.isOpen() });
  }

  function setCity(c: CityId, persist = true): void {
    city = c;
    safe(() => scene.setCity?.(c));
    toolbar.setCity(cityOf(c).name);
    if (persist) save();
  }

  function setCrt(on: boolean, persist = true): void {
    crt = on;
    safe(() => scene.setCrt(on));
    toolbar.setCrt(on);
    if (persist) save();
  }

  /* Panels hidden by CSS stay out of the tab order and the a11y tree. */
  function syncInert(): void {
    const phone = isPhone();
    for (const el of [topbar.el, toolbar.el, inspector.el, empty.el, panel.el, settings?.el]) if (el) el.inert = streamMode;
    feed.el.inert = streamMode || (!feed.isOpen() && !phone);
    feed.tab.inert = streamMode || feed.isOpen() || phone;
  }

  function setFeed(open: boolean, persist = true): void {
    feed.setOpen(open);
    toolbar.setFeed(open);
    syncInert();
    syncInsets();
    if (persist && !isPhone()) {
      prefs.feed = open;
      save();
    }
  }

  function setStream(on: boolean): void {
    streamMode = on;
    safe(() => scene.setDirector?.(on));
    document.body.classList.toggle("stream", on);
    toolbar.tip.hidden = true;
    syncInert();
    syncInsets();
    hint.flash(on);
  }

  function toggleSound(): void {
    sound.setEnabled(!sound.enabled);
    toolbar.setSound(sound.enabled);
    sound.play("on");
  }

  function full(): void {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.().catch(() => undefined);
  }
  document.addEventListener("fullscreenchange", () => toolbar.setFull(!!document.fullscreenElement));
  matchMedia("(max-width: 640px)").addEventListener("change", syncInert);

  function shot(): void {
    cameraFlash(flashRoot);
    screenshot(scene.canvas).then(
      (name) => toasts.show({ text: `Saved ${name}`, tone: "plain", glyph: "pass", key: name }),
      (err: Error) => toasts.show({ text: `Screenshot failed: ${err.message}`, tone: "error", glyph: "error" }),
    );
  }

  /* "Clip that": the replay buffer always holds the last 10-20s; R saves it, after the moment. */
  const replay = new ReplayBuffer(scene.canvas);
  const syncReplay = () => (document.hidden ? replay.stop() : replay.start());
  document.addEventListener("visibilitychange", syncReplay);
  window.setTimeout(syncReplay, 1500);

  function clipThat(): void {
    if (recording) return rec(); // the button stops a forward recording
    if (!canRecord()) {
      toasts.show({ text: "This browser can't record a canvas. Try Chrome or Firefox.", tone: "error", glyph: "error" });
      return;
    }
    const secs = Math.round(replay.seconds());
    cameraFlash(flashRoot);
    replay.save().then(
      (name) => toasts.show({ text: `Clipped the last ${secs}s · ${name}`, tone: "plain", glyph: "pass", key: name }),
      () => rec(), // nothing buffered yet: record the next 10s instead
    );
  }

  function rec(): void {
    if (recording) {
      recording.stop();
      return;
    }
    if (!canRecord()) {
      toasts.show({ text: "This browser can't record a canvas. Try Chrome or Firefox.", tone: "error", glyph: "error" });
      return;
    }
    try {
      recording = record(scene.canvas, REC_MS);
    } catch (err) {
      toasts.show({ text: `Recording failed: ${(err as Error).message}`, tone: "error", glyph: "error" });
      return;
    }
    const started = Date.now();
    toolbar.setRecording(true, REC_MS);
    toolbar.setRecLeft(REC_MS / 1000);
    const iv = window.setInterval(() => toolbar.setRecLeft(Math.max(0, Math.ceil((REC_MS - (Date.now() - started)) / 1000))), 200);
    recording.done
      .then(
        (name) => toasts.show({ text: `Saved ${name}`, tone: "plain", glyph: "pass", key: name }),
        (err: Error) => toasts.show({ text: `Recording failed: ${err.message}`, tone: "error", glyph: "error" }),
      )
      .finally(() => {
        clearInterval(iv);
        recording = null;
        toolbar.setRecording(false);
      });
  }

  /** Jump to the next worker waiting on its human, cycling from the one selected. */
  function nextWaiting(): void {
    const waiting = [...model.workers.values()].filter((w) => w.status === "waiting" && !w.parentId).map((w) => w.workerId);
    if (!waiting.length) return;
    select(waiting[(waiting.indexOf(selected ?? "") + 1) % waiting.length]!, true);
  }

  function select(id: string | null, focus = false): void {
    if (id && !model.get(id)) return;
    clearTimeout(goneTimer);
    selected = id;
    safe(() => scene.select(id));
    if (id && focus) safe(() => scene.focus(id));
    feed.highlight(id);
    const w = model.get(id);
    const s = store.forWorker(id);
    if (w && s) {
      // an agent the office started: its session panel, not the inspector
      inspector.close();
      panel.open(s.id);
    } else if (w) {
      if (panel.isOpen()) panel.close();
      inspector.open(w);
      syncOrigin();
    } else {
      inspector.close();
      if (panel.isOpen() && !id) panel.close();
    }
    syncInsets();
  }

  /** The inspector says when a worker can't be driven from here. */
  function syncOrigin(): void {
    const id = inspector.current();
    const known = store.state === "enabled" || store.state === "locked";
    inspector.setOrigin(id && known && !store.forWorker(id) ? "Started outside the office · watch only" : null);
  }

  function openSession(s: ControlSession, focus = false): void {
    inspector.close();
    panel.open(s.id);
    if (model.get(s.workerId)) {
      selected = s.workerId;
      safe(() => scene.select(s.workerId));
      if (focus) safe(() => scene.focus(s.workerId));
      feed.highlight(s.workerId);
    }
    syncInsets();
  }

  function closePanel(): void {
    panel.close();
    if (selected && store.forWorker(selected)) {
      selected = null;
      safe(() => scene.select(null));
      feed.highlight(null);
    }
    syncInsets();
  }

  /** Controls the snapshot promised but whose info is still loading: open `fn` when it arrives. */
  function whenLoaded(fn: () => void): boolean {
    if (store.state !== "unknown" || store.likely !== "enabled") return false;
    say("Loading…");
    void store.refresh().then(() => store.state !== "unknown" && fn());
    return true;
  }

  function openHire(): void {
    if (whenLoaded(openHire)) return;
    if (store.state !== "enabled") {
      say(store.state === "locked" ? `${LOCKED_TIP}.` : "This office server can't start agents.");
      return;
    }
    sessionList.close();
    // the sandboxes and logins as of now, behind the dialog (the office answers from its cache at once)
    void store.refresh({ keepSessions: true });
    if (hire) return hire.open();
    loadHire().then(
      (d) => store.state === "enabled" && d.open(),
      () => say("Couldn't load the Hire dialog. Check the office is still running.", "error"),
    );
  }

  function openSettings(tab?: SettingsTab): void {
    if (whenLoaded(() => openSettings(tab))) return;
    if (store.state !== "enabled") {
      say(store.state === "locked" ? `${LOCKED_TIP}.` : "This office server has no settings to change.");
      return;
    }
    const show = (d: SettingsDrawer) => {
      d.open(tab);
      toolbar.setSettings(true);
      syncInsets();
    };
    void store.refresh({ keepSessions: true });
    if (settings) return show(settings);
    loadSettings().then(
      (d) => store.state === "enabled" && show(d),
      () => say("Couldn't load Settings. Check the office is still running.", "error"),
    );
  }

  function closeSettings(): void {
    settings?.close();
    toolbar.setSettings(false);
    syncInsets();
  }

  /** Something in the control store changed: every piece that shows it catches up. */
  function syncControl(): void {
    const state = store.likely;
    toolbar.setControl(state, LOCKED_TIP);
    empty.setControl(state, LOCKED_HOW);
    const list = store.list();
    const live = list.filter((x) => x.status !== "exited" && x.status !== "failed");
    toolbar.setSessions(list.length, live.filter((x) => x.pendingApproval).length);
    panel.sync();
    hire?.sync();
    settings?.sync();
    sessionList.sync();
    syncOrigin();
    if (store.state !== "enabled") {
      if (hire?.isOpen()) hire.close();
      if (settings?.isOpen()) closeSettings();
    } else idlePrefetch();
    // a selected worker the office just took over (or let go of) switches panels
    if (selected && !panel.isOpen() && store.forWorker(selected) && model.get(selected)) select(selected);
  }
  store.subscribe(syncControl);

  function refreshEmpty(): void {
    if (model.loaded) {
      if (model.workers.size === 0 && !model.demo) empty.show("empty");
      else empty.hide();
    } else if (connState === "offline") {
      empty.show("offline");
    }
    requestAnimationFrame(syncInsets);
  }

  /** Workers whose last test run flipped the table, for the comeback toast. */
  const flipped = new Set<string>();
  const waitTimers = new Map<string, number>();

  function moments(e: OfficeEvent): void {
    const w = model.get(e.workerId);
    const project = w?.project || e.project || "an agent";
    const who = `${project} · ${agentName(e.agent)}`;
    const brand = BRAND[e.agent]?.color;
    // the clip's caption for each big moment
    if (e.kind === "test_fail") replay.moment(`${who} flipped a table${e.summary ? ` — ${e.summary}` : ""}`, "#ff5a52");
    else if (e.kind === "flip") replay.moment(`${who} flipped its own table${e.summary ? ` — "${e.summary}"` : ""}`, "#ff5a52");
    else if (e.kind === "shout" && e.summary) replay.moment(`${who}: ${e.summary}`, brand);
    else if (e.kind === "celebrate") replay.moment(`${who} is celebrating${e.summary ? ` — ${e.summary}` : ""}`, "#4ade80");
    switch (e.kind) {
      case "tool_start":
        if (e.category === "edit") sound.play("tick");
        break;
      case "subagent_start":
        if (e.parentId) sound.play("ding");
        break;
      case "test_fail":
        sound.play("crash");
        flipped.add(e.workerId);
        toasts.show({
          text: `${who} flipped a table${e.summary ? ` — ${e.summary}` : ""}`,
          tone: "fail",
          agent: e.agent,
          glyph: "flip",
          key: `fail:${e.workerId}`,
          every: 5000,
        });
        break;
      case "test_pass":
        sound.play("chime");
        // Green is the normal case: a toast only for a comeback after a flip.
        if (!flipped.delete(e.workerId)) break;
        toasts.show({
          text: `${who} is green again${e.summary ? ` — ${e.summary}` : ""}`,
          tone: "pass",
          agent: e.agent,
          glyph: "pass",
          key: `pass:${e.workerId}`,
          every: 8000,
        });
        break;
      case "waiting": {
        if (w?.parentId) break;
        sound.play("pop");
        // The raised hand says it at once; a toast only if nobody answers for a while.
        const id = e.workerId;
        clearTimeout(waitTimers.get(id));
        waitTimers.set(id, window.setTimeout(() => {
          waitTimers.delete(id);
          const still = model.get(id);
          if (still?.status === "waiting") toasts.show({ text: `${still.project || project} needs you`, tone: "wait", agent: e.agent, glyph: "wait", key: `wait:${id}`, every: 45_000 });
        }, WAIT_TOAST_MS));
        break;
      }
      // the agents' own MCP signals
      case "flip":
        sound.play("crash");
        toasts.show({
          text: `${who} flipped its own table${e.summary ? ` — "${e.summary}"` : ""}`,
          tone: "fail",
          agent: e.agent,
          glyph: "flip",
          key: `flip:${e.workerId}`,
          every: 5000,
        });
        break;
      case "shout":
        if (!e.summary) break;
        sound.play("pop");
        toasts.show({ text: `${who}: ${e.summary}`, tone: "shout", agent: e.agent, glyph: "shout", key: `shout:${e.workerId}:${e.summary}`, every: 6000, ttl: 6000 });
        break;
      case "celebrate":
        sound.play("chime");
        toasts.show({ text: `${who} is celebrating${e.summary ? ` — ${e.summary}` : ""}`, tone: "pass", agent: e.agent, glyph: "party", key: `party:${e.workerId}`, every: 8000 });
        break;
      case "error":
        if (isRemote(e.host) && /^remote offline/i.test(e.summary ?? "")) {
          toasts.show({ text: `${hostLabel(e.host)} went offline`, tone: "error", glyph: "unplug", key: `offline:${e.host.id}`, every: 60_000 });
        }
        break;
    }
  }

  let shiftR = false;
  document.addEventListener("keydown", (ev) => {
    if (ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const t = ev.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (help.isOpen() && ev.key !== "?") return;
    if (locPicker.isOpen()) return;
    if (hire?.isOpen()) return;
    if (ev.key === "Escape") {
      if (settings?.isOpen()) closeSettings();
      else if (panel.isOpen()) closePanel();
      else if (streamMode) setStream(false);
      else if (selected) select(null);
      return;
    }
    if (ev.repeat) return;
    const actions: Record<string, () => void> = {
      n: openHire,
      l: () => locPicker.open(city),
      c: () => setCrt(!crt),
      s: shot,
      r: () => (shiftR ? rec() : clipThat()),
      f: full,
      h: () => setStream(!streamMode),
      m: toggleSound,
      "\\": () => setFeed(!feed.isOpen()),
      "?": () => help.toggle(),
    };
    shiftR = ev.shiftKey;
    const fn = actions[ev.key.toLowerCase()];
    if (!fn) return;
    ev.preventDefault();
    fn();
  });

  window.setInterval(() => {
    const now = Date.now();
    feed.tick(now);
    inspector.tick(now);
  }, 1000);

  return {
    load(s) {
      // a (re)connect: the control plane may have changed while we were away
      void store.fromSnapshot(s.control);
      model.load(s);
      safe(() => scene.load(s));
      topbar.setDemo(!!s.demo);
      topbar.update(model, false);
      feed.reset(s.recent, model);
      toasts.clear();
      refreshEmpty();
      if (selected) {
        const w = model.get(selected);
        if (w && !store.forWorker(selected)) inspector.open(w);
        else if (!w) select(null);
      }
    },
    apply(e) {
      const change = model.apply(e);
      safe(() => scene.apply(e));
      if (panel.isOpen()) panel.workerEvent(e);
      if (change.renamed) {
        // the replacing worker takes over in place: selection, feed rows and panel follow it
        const { from, to } = change.renamed;
        feed.rename(from, to);
        if (selected === from) {
          selected = to;
          feed.highlight(to);
        }
        if (inspector.current() === from) {
          const w = model.get(to);
          if (w) inspector.open(w);
        }
      }
      // the worker of a session whose panel is open just walked in: select it
      if (change.joined && panel.isOpen() && store.forWorker(change.joined.workerId)?.id === panel.current()) {
        selected = change.joined.workerId;
        safe(() => scene.select(selected));
        feed.highlight(selected);
      }
      topbar.update(model, true);
      feed.push(e, model);
      if (selected && selected === e.workerId && !panel.isOpen()) {
        if (change.left) {
          inspector.gone();
          goneTimer = window.setTimeout(() => select(null), 2400);
        } else if (change.worker) inspector.update(change.worker);
      }
      moments(e);
      if (change.joined || change.left) refreshEmpty();
    },
    control(name, data) {
      store.onEvent(name, data);
    },
    prime() {
      if (controlToken()) void store.refresh();
    },
    connection(state, retryInMs) {
      connState = state;
      conn.set(state, retryInMs);
      topbar.setConnected(state === "live");
      refreshEmpty();
    },
  };
}
