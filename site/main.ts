/*
 * The landing page. The office is site/office.ts (the real scene, demo and
 * state, in the browser), imported as a separate chunk once the page has
 * painted; until it runs, a still of it stands in. Around it:
 *
 *   - the hero: the command types itself, the office boots in its window, and
 *     a small HUD counts what happens while you're here;
 *   - the journey: the office stays pinned while its story scrolls past, and
 *     each beat makes its moment happen, with the camera on it;
 *   - live views: small canvases further down copy the middle of the one
 *     running scene, pixel for pixel, while a moment holds the camera there
 *     (there is no second scene);
 *   - the delights: a transcript line scrubbing down to its label, magnetic
 *     buttons, a pixel confetti puff on copy, F to flip a table, the tour.
 *
 * The office pauses whenever none of it can be seen, and with
 * prefers-reduced-motion it waits for a press of play and nothing animates.
 */
import type { Moment, Office } from "./office.ts";
import type { OfficeEvent } from "../src/shared/events.ts";

const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T | null;
const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll(sel)] as T[];
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const fine = matchMedia("(hover: hover) and (pointer: fine)");
const root = document.documentElement;
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/* ------------------------------------------------------------------ theme */

const prefersLight = matchMedia("(prefers-color-scheme: light)");
const themeBtn = $<HTMLButtonElement>("[data-theme-toggle]");
const isLight = () => (root.dataset.theme ? root.dataset.theme === "light" : prefersLight.matches);
const paintTheme = () => themeBtn?.setAttribute("aria-label", isLight() ? "Switch to the dark theme" : "Switch to the light theme");
themeBtn?.addEventListener("click", () => {
  const next = isLight() ? "dark" : "light";
  root.dataset.theme = next;
  try {
    localStorage.setItem("ao-theme", next);
  } catch {
    /* private mode: the choice lasts this page view */
  }
  paintTheme();
});
prefersLight.addEventListener("change", paintTheme);
paintTheme();

/* ------------------------------------------------------------------ copy, with a confetti puff */

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:-100px;opacity:0";
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

/** The office's confetti colours, as square pixels flung out of a point. */
const CONFETTI = ["#8e75ff", "#d97757", "#10a37f", "#ffd36c", "#f293b5", "#4888cf", "#ededed"];
function puff(x: number, y: number) {
  if (reduced.matches) return;
  for (let i = 0; i < 22; i++) {
    const b = document.createElement("i");
    b.className = "bit";
    const s = 4 + Math.floor(Math.random() * 3);
    b.style.cssText = `left:${x - s / 2}px;top:${y - s / 2}px;width:${s}px;height:${s}px;background:${CONFETTI[i % CONFETTI.length]}`;
    document.body.append(b);
    const a = Math.random() * Math.PI * 2;
    const v = 40 + Math.random() * 70;
    const dx = Math.cos(a) * v;
    const dy = Math.sin(a) * v * 0.7 - 30;
    const anim = b.animate(
      [
        { transform: "translate(0, 0)", opacity: 1 },
        { transform: `translate(${dx * 0.8}px, ${dy}px)`, opacity: 1, offset: 0.55 },
        { transform: `translate(${dx}px, ${dy + 46}px)`, opacity: 0 },
      ],
      { duration: 760 + Math.random() * 300, easing: "cubic-bezier(.2,.7,.3,1)" },
    );
    anim.onfinish = () => b.remove();
  }
}

for (const btn of $$<HTMLButtonElement>("[data-copy]")) {
  let t = 0;
  btn.addEventListener("click", async () => {
    const ok = await copyText(btn.dataset.copy ?? "");
    const status = btn.parentElement?.querySelector(".copied");
    btn.classList.toggle("is-copied", ok);
    if (status) status.textContent = ok ? "Copied to the clipboard" : "Couldn't copy; select the command instead";
    if (ok) {
      const r = btn.querySelector(".cmd-i")?.getBoundingClientRect() ?? btn.getBoundingClientRect();
      puff(r.left + r.width / 2, r.top + r.height / 2);
    }
    clearTimeout(t);
    t = window.setTimeout(() => {
      btn.classList.remove("is-copied");
      if (status) status.textContent = "";
    }, 1600);
  });
}

/* ------------------------------------------------------------------ fade-ups and the marquee */

const reveals = $$("[data-reveal]");
if (reveals.length) {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("is-in");
        io.unobserve(e.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px" },
  );
  for (const el of reveals) io.observe(el);
}

// the marquee loops by sliding half its width: a second, hidden copy of the logos makes the seam
for (const track of $$(".marquee-track")) {
  for (const li of [...track.children]) {
    const c = li.cloneNode(true) as HTMLElement;
    c.setAttribute("aria-hidden", "true");
    track.append(c);
  }
}

/* ---------------------------------------------------------------- office */

const win = $("#office-window");
const mount = $("#office");
const stage = $(".stage");
const journey = $(".journey");
const caption = $("#caption");
const announce = $("#announce");
const playBtn = $<HTMLButtonElement>(".play");
const IDLE = "The real office, running its --demo in your browser.";
let office: Office | null = null;
let loading: Promise<Office | null> | null = null;
let userPaused = false;
let inView = false;
let minisInView = 0;
let captionAt = 0;
let onRunning: (() => void) | null = null;

function say(text: string, live = true) {
  if (caption) {
    caption.textContent = text;
    caption.classList.remove("flash");
    void caption.offsetWidth;
    caption.classList.add("flash");
  }
  if (live && announce) announce.textContent = text;
  captionAt = performance.now();
}

/* the HUD: what has happened since you opened the page */
const hud = { crew: $("[data-hud=crew]"), tools: $("[data-hud=tools]"), flips: $("[data-hud=flips]") };
const counts = { tools: 0, flips: 0 };
function bump(el: HTMLElement | null, n: number) {
  if (!el || el.textContent === String(n)) return;
  el.textContent = n.toLocaleString("en-US");
  if (reduced.matches) return;
  el.classList.remove("tick");
  void el.offsetWidth;
  el.classList.add("tick");
}
setInterval(() => {
  const s = office?.running ? office.scene?.stats() : null;
  if (s) bump(hud.crew, s.workers);
}, 1000);

/* the activity feed: the office's own events, as the app's feed shows them (labels, never content) */
const feedEl = $(".feed");
const wide = matchMedia("(min-width: 1100px)");
let feedAt = 0;
function feedText(e: OfficeEvent, remote?: string): [string, string] | null {
  switch (e.kind) {
    case "session_start": return [remote ? `beamed into ${remote}` : "walked in", ""];
    case "session_end": return ["went home", ""];
    case "prompt": return ["got a prompt", ""];
    case "tool_start": return e.summary ? [e.summary, ""] : null;
    case "subagent_start": return [`intern: ${e.role ?? "subagent"}`, ""];
    case "waiting": return ["needs you", "hot"];
    case "test_fail": return [`${e.summary ?? "tests"} failed, table flipped`, "bad"];
    case "test_pass": return [`${e.summary ?? "tests"} passed`, ""];
    case "flip": return ["flipped its own table", "bad"];
    case "shout": return e.summary ? [`on the TV: ${e.summary.replace(/\s*\p{Extended_Pictographic}.*$/u, "")}`, ""] : null;
    case "celebrate": return ["confetti", ""];
    default: return null;
  }
}
function feed(e: OfficeEvent, w: { name: string; colour: string; remote?: string }) {
  if (!feedEl || !wide.matches || !inView || e.parentId && e.kind !== "subagent_start") return;
  const t = feedText(e, w.remote);
  if (!t) return;
  // a busy office emits a lot: a line at most every 0.9 s, and the big ones always
  const now = performance.now();
  if (!t[1] && now - feedAt < 900) return;
  feedAt = now;
  const li = document.createElement("li");
  if (t[1]) li.className = t[1];
  li.style.setProperty("--c", w.colour);
  const dot = document.createElement("i");
  dot.className = "fd-dot";
  const name = document.createElement("span");
  name.className = "fd-who";
  name.textContent = w.name;
  const what = document.createElement("span");
  what.className = "fd-what";
  what.textContent = `${e.project} · ${t[0]}`;
  li.append(dot, name, what);
  feedEl.append(li);
  const live = [...feedEl.children].filter((x) => !x.classList.contains("out"));
  for (const old of live.slice(0, Math.max(0, live.length - 4))) {
    old.classList.add("out");
    setTimeout(() => old.remove(), reduced.matches ? 0 : 360);
  }
}

/* "needs you": an amber call when an agent in the demo finishes its turn, at most every 30 s */
const toastEl = $(".toast");
const pageAt = performance.now();
let toastAt = -Infinity;
let toastTimer = 0;
let toastWorker = "";
function toast(e: OfficeEvent, w: { name: string }) {
  if (!toastEl || !inView) return;
  const now = performance.now();
  if (now - pageAt < 8_000 || now - toastAt < 30_000) return;
  toastAt = now;
  toastWorker = e.workerId;
  const text = toastEl.querySelector(".toast-text");
  if (text) text.textContent = `${w.name} on ${e.project} needs you`;
  toastEl.classList.add("is-on");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove("is-on"), 5_200);
}
toastEl?.querySelector(".toast-go")?.addEventListener("click", async () => {
  toastEl.classList.remove("is-on");
  const o = await ready(true);
  if (o && toastWorker) o.focus(toastWorker);
});

function load(): Promise<Office | null> {
  if (!mount || !win) return Promise.resolve(null);
  loading ??= Promise.all([import("./office.ts"), import("../src/shared/events.ts")])
    .then(([{ createOffice }, { BRAND, HOST_BRAND }]) => {
      const o = createOffice(mount, { fastForward: 10_000, hour: 21.5 });
      const who = (e: OfficeEvent) => ({ name: BRAND[e.agent]?.name ?? e.agent, colour: BRAND[e.agent]?.color ?? "#8e75ff", remote: e.host && e.host.kind !== "local" ? HOST_BRAND[e.host.kind]?.name : undefined });
      o.onEvent((e) => {
        if (e.kind === "tool_start") bump(hud.tools, ++counts.tools);
        else if (e.kind === "test_fail" || e.kind === "flip") bump(hud.flips, ++counts.flips);
        if (!office?.running) return;
        const w = who(e);
        feed(e, w);
        if (e.kind === "waiting" && !e.parentId) toast(e, w);
        // the office's own big moments make the caption too, when nobody is driving it
        if (performance.now() - captionAt < 6_000) return;
        if (e.kind === "test_fail") say(`${e.project}: a test failed and the table flipped`, false);
        else if (e.kind === "flip") say(`${e.project}: the agent flipped its own table, "${e.summary ?? ""}"`, false);
        else if (e.kind === "shout" && e.summary) say(`${e.project} on the office TV: ${e.summary.replace(/\s*\p{Extended_Pictographic}.*$/u, "")}`, false);
      });
      o.onSelect((w) => say(w ? w.text : IDLE, false));
      office = o;
      (window as unknown as { __agentVisualizer?: Office }).__agentVisualizer = o;
      return o;
    })
    .catch((err) => {
      console.error(err);
      win.classList.add("is-broken");
      return null;
    });
  return loading;
}

function sync() {
  if (!office || !win) return;
  const want = !userPaused && !document.hidden && (inView || minisInView > 0);
  if (want && !office.running) office.start();
  if (!want && office.running) office.pause();
  if (office.running) {
    win.classList.add("is-live");
    onRunning?.();
  }
  paintPause();
}

function paintPause() {
  if (!win) return;
  win.classList.toggle("is-paused", userPaused);
  const pause = $<HTMLButtonElement>('[data-toggle="pause"]', win);
  if (pause) {
    pause.setAttribute("aria-pressed", String(userPaused));
    pause.setAttribute("aria-label", userPaused ? "Play the office" : "Pause the office");
    pause.title = userPaused ? "Play" : "Pause";
  }
  if (playBtn) playBtn.hidden = !userPaused;
}

async function play() {
  userPaused = false;
  const o = await load();
  if (!o) return;
  sync();
}

/** Resolves once the office is running, scrolling the pinned window into view first if asked. */
async function ready(scroll = false): Promise<Office | null> {
  if (!win) return null;
  if (scroll && !inView) {
    journey?.scrollIntoView({ behavior: reduced.matches ? "auto" : "smooth", block: "start" });
    for (let i = 0, y = -1, still = 0; i < 40 && still < 3; i++) {
      still = scrollY === y ? still + 1 : 0;
      y = scrollY;
      await wait(50);
    }
  }
  await play();
  for (let i = 0; i < 40 && !office?.running; i++) await wait(50);
  return office?.running ? office : null;
}

/* the last worker each moment landed on: when the office is too full or busy for a new one, the camera goes back to it */
const lastFor = new Map<string, string>();
function fire(o: Office, m: Moment, focus: boolean, live: boolean) {
  const fired = o.trigger(m, { focus });
  if (fired) {
    lastFor.set(m, fired.workerId);
    say(fired.text, live);
    return fired;
  }
  const again = lastFor.get(m);
  if (again && focus) o.focus(again);
  return null;
}

/* ------------------------------------------------------------------ the boot */

const typer = $<HTMLButtonElement>("[data-type]");
async function typeCommand(): Promise<void> {
  const t = typer?.querySelector(".cmd-t");
  if (!typer || !t) return;
  const text = typer.dataset.copy ?? t.textContent ?? "";
  typer.classList.add("type-ready");
  if (reduced.matches) return;
  t.textContent = "";
  typer.classList.add("is-typing");
  await wait(320);
  for (const ch of text) {
    t.textContent += ch;
    await wait(ch === " " ? 90 : 42 + Math.random() * 30);
  }
  await wait(500);
  typer.classList.remove("is-typing");
}

async function boot() {
  if (!win) return;
  const r = win.getBoundingClientRect();
  const visible = r.top < innerHeight && r.bottom > 0;
  if (reduced.matches || !visible) {
    win.classList.add("is-booted");
    void typeCommand();
    return;
  }
  const typed = typeCommand();
  const running = new Promise<void>((ok) => {
    onRunning = () => {
      onRunning = null;
      ok();
    };
  });
  await typed;
  win.classList.add("b1");
  await wait(260);
  win.classList.add("b2");
  await Promise.race([Promise.all([running, wait(700)]), wait(7000)]);
  win.classList.add("b3");
  await wait(320);
  win.classList.add("is-booted");
}

/* ------------------------------------------------------------------ the journey */

const beats = $$(".beat");
let activeBeat = -1;
let beatTimer = 0;
const narrow = matchMedia("(max-width: 899.98px)");
const phone = matchMedia("(max-width: 639.98px)");

function layoutStage() {
  if (!stage || !journey) return;
  const h = stage.offsetHeight;
  journey.style.setProperty("--stage-h", `${h}px`);
  const nav = $(".nav")?.offsetHeight ?? 56;
  const top = narrow.matches ? nav + 8 : nav + Math.max(16, Math.round((innerHeight - nav - h) / 2));
  stage.style.top = `${top}px`;
}

function checkBeats() {
  if (!beats.length || !stage) return;
  const nav = $(".nav")?.offsetHeight ?? 56;
  const sh = stage.offsetHeight;
  const line = narrow.matches ? nav + sh + (innerHeight - nav - sh) / 2 : innerHeight / 2;
  let best = -1;
  let bestD = Infinity;
  beats.forEach((b, i) => {
    const r = (b.firstElementChild ?? b).getBoundingClientRect();
    const d = Math.abs(r.top + r.height / 2 - line);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  if (bestD > innerHeight * 0.32) best = -1;
  if (best === activeBeat) return;
  activeBeat = best;
  beats.forEach((b, i) => b.classList.toggle("is-on", i === best));
  journey?.classList.toggle("is-telling", best >= 0);
  $$(".rail i").forEach((t, i) => t.classList.toggle("is-on", i === best));
  clearTimeout(beatTimer);
  const m = best >= 0 ? (beats[best]!.dataset.beat as Moment | undefined) : undefined;
  if (!m) return;
  // a beat has to stay put for a moment before it plays: scrolling fast past it doesn't fire it
  beatTimer = window.setTimeout(async () => {
    const o = office?.running ? office : null;
    if (!o || activeBeat !== best) return;
    if (!fire(o, m, !reduced.matches, false)) {
      await wait(1500);
      if (activeBeat === best && office?.running) fire(office, m, !reduced.matches, false);
    }
  }, 380);
}

/* the office window stands tilted back on its floor under the headline, and straightens as it reaches its pinned place */
function tiltWindow() {
  if (!win || !stage || !journey) return;
  if (reduced.matches || narrow.matches) return void (win.style.transform = "");
  const pinAt = journey.offsetTop - parseFloat(stage.style.top || "0");
  const p = pinAt > 0 ? Math.min(1, Math.max(0, scrollY / pinAt)) : 1;
  // flat means no transform at all, so the canvas is drawn pixel for pixel
  win.style.transform = p >= 1 ? "" : `perspective(1600px) rotateX(${(11 * (1 - p) ** 1.4).toFixed(2)}deg) scale(${(0.94 + 0.06 * p).toFixed(4)})`;
}

/* on narrow screens the pinned office gets a solid backing, so the story scrolls under it; only once it is pinned */
function markPinned() {
  if (!stage || !journey) return;
  const pinned = narrow.matches && stage.getBoundingClientRect().top <= parseFloat(stage.style.top || "0") + 1 && journey.getBoundingClientRect().top < 0;
  journey.classList.toggle("is-pinned", pinned);
}

let scrollQueued = false;
function onScroll() {
  if (scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => {
    scrollQueued = false;
    checkBeats();
    tiltWindow();
    markPinned();
    tiltShowcase();
  });
}

/* ------------------------------------------------------------------ live views cut from the running office */

interface Mini {
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  moment: Moment;
  /** Where in the view the camera's centre lands (0-1 each way), to keep the moment clear of overlays. */
  ax: number;
  ay: number;
  visible: boolean;
  until: number;
}
const minis: Mini[] = $$(".mini[data-mini]").map((el) => {
  const [ax = 0.5, ay = 0.5] = (el.dataset.anchor ?? "").split(",").map(Number).filter((n) => n >= 0 && n <= 1);
  return { el, canvas: el.querySelector("canvas")!, moment: el.dataset.mini as Moment, ax, ay, visible: false, until: 0 };
});
let current: Mini | null = null;
let copyRaf = 0;
let directorTimer = 0;
let turn = 0;

function copyFrame() {
  copyRaf = 0;
  const m = current;
  const src = office?.scene?.canvas;
  if (!m || !src || !src.width || performance.now() > m.until) {
    m?.el.classList.remove("is-live");
    return;
  }
  const c = m.canvas;
  const dpr = devicePixelRatio || 1;
  const w = Math.max(1, Math.round(c.clientWidth * dpr));
  const h = Math.max(1, Math.round(c.clientHeight * dpr));
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  // the middle of the scene's own canvas, where the camera has put the moment: a little more than the
  // view's own size, so a worker the camera can't centre (by a wall) still makes it into the frame
  const k = Math.min(src.width / w, src.height / h, 1.5);
  const sw = w * k;
  const sh = h * k;
  const g = c.getContext("2d");
  if (g) {
    g.imageSmoothingEnabled = k !== 1;
    g.imageSmoothingQuality = "high";
    // on a phone the code card sits under the view rather than over it, so the moment can take the middle
    const ax = phone.matches ? 0.5 : m.ax;
    const ay = phone.matches ? 0.5 : m.ay;
    const sx = Math.min(Math.max(0, src.width / 2 - sw * ax), src.width - sw);
    const sy = Math.min(Math.max(0, src.height / 2 - sh * ay), src.height - sh);
    g.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
  }
  copyRaf = requestAnimationFrame(copyFrame);
}

async function direct() {
  directorTimer = 0;
  const vis = minis.filter((m) => m.visible);
  // the pinned office has the camera while it's on screen
  if (!vis.length || inView) return;
  const m = vis[turn++ % vis.length]!;
  const o = await ready();
  if (!o || !m.visible) {
    directorTimer = window.setTimeout(direct, 1200);
    return;
  }
  const fired = fire(o, m.moment, true, false);
  if (fired || lastFor.has(m.moment)) {
    if (m.moment === "rage" && fired) typeReason(fired.text);
    current?.el.classList.remove("is-live");
    current = m;
    m.until = performance.now() + 5200;
    m.el.classList.add("is-live");
    if (!copyRaf) copyRaf = requestAnimationFrame(copyFrame);
  }
  directorTimer = window.setTimeout(direct, fired ? 7600 : 2500);
}

const reasonEl = $("[data-reason]");
async function typeReason(text: string) {
  const why = /"([^"]+)"\s*$/.exec(text)?.[1];
  if (!reasonEl || !why) return;
  if (reduced.matches) {
    reasonEl.textContent = `"${why}"`;
    return;
  }
  reasonEl.textContent = '"';
  reasonEl.classList.add("is-typing");
  for (const ch of `${why}"`) {
    reasonEl.textContent += ch;
    await wait(34);
  }
  reasonEl.classList.remove("is-typing");
}

if (minis.length) {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const m = minis.find((x) => x.el === e.target);
        if (m) m.visible = e.isIntersecting;
      }
      minisInView = reduced.matches ? 0 : minis.filter((m) => m.visible).length;
      if (minisInView && !userPaused) void load().then(() => {
        sync();
        if (!directorTimer) directorTimer = window.setTimeout(direct, 500);
      });
      else sync();
    },
    { threshold: 0.4 },
  );
  for (const m of minis) io.observe(m.el);
}

/* ------------------------------------------------------------------ the redaction */

const redact = $(".redact");
if (redact) {
  if (reduced.matches) redact.classList.add("s3");
  else {
    let on = false;
    let running = false;
    const loop = async () => {
      running = true;
      while (on) {
        redact.classList.remove("s1", "s2", "s3");
        await wait(1300);
        redact.classList.add("s1");
        await wait(1100);
        redact.classList.add("s2");
        await wait(700);
        redact.classList.add("s3");
        await wait(3400);
      }
      running = false;
    };
    new IntersectionObserver((es) => {
      on = es.some((e) => e.isIntersecting);
      if (on && !running) void loop();
    }, { threshold: 0.5 }).observe(redact);
  }
}

/* ------------------------------------------------------------------ the showcase tilts flat as it arrives */

const showcase = $(".showcase");
function tiltShowcase() {
  if (!showcase || reduced.matches) return;
  const r = showcase.getBoundingClientRect();
  if (r.bottom < 0 || r.top > innerHeight) return;
  const p = Math.min(1, Math.max(0, (innerHeight - r.top) / (innerHeight * 0.75)));
  showcase.style.setProperty("--tilt", `${(8 * (1 - p)).toFixed(2)}deg`);
  showcase.style.setProperty("--lift", `${(-36 * p).toFixed(1)}px`);
}

/* ------------------------------------------------------------------ magnetic buttons and the spotlight */

const magnets = $$(".magnetic");
const beam = $(".beam");
let pointer: { x: number; y: number } | null = null;
let pointerQueued = false;
function pull() {
  pointerQueued = false;
  if (!pointer) return;
  for (const el of magnets) {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dx = pointer.x - cx;
    const dy = pointer.y - cy;
    const near = Math.abs(dx) < r.width / 2 + 28 && Math.abs(dy) < r.height / 2 + 28;
    el.style.transform = near ? `translate(${(dx * 0.14).toFixed(1)}px, ${(dy * 0.24).toFixed(1)}px)` : "";
  }
  if (beam && pointer.y < innerHeight) beam.style.transform = `translateX(${((pointer.x - innerWidth / 2) * 0.05).toFixed(1)}px)`;
}
if (!reduced.matches) {
  addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse" || !fine.matches) return;
    pointer = { x: e.clientX, y: e.clientY };
    if (!pointerQueued) {
      pointerQueued = true;
      requestAnimationFrame(pull);
    }
  }, { passive: true });
}

/* ------------------------------------------------------------------ the night */

const night = $(".night");
if (night) {
  night.classList.add("is-asleep");
  new IntersectionObserver((es) => night.classList.toggle("is-asleep", !es.some((e) => e.isIntersecting)), { rootMargin: "80px 0px" }).observe(night);
}

/* ------------------------------------------------------------------ sparkles over the hero */

const hero = $(".hero");
if (hero && !reduced.matches) {
  let last = { x: 0, y: 0, t: 0 };
  let alive = 0;
  hero.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse" || !fine.matches || alive > 28) return;
    const now = performance.now();
    if (now - last.t < 40 || Math.hypot(e.clientX - last.x, e.clientY - last.y) < 8) return;
    last = { x: e.clientX, y: e.clientY, t: now };
    const r = hero.getBoundingClientRect();
    const b = document.createElement("i");
    b.className = "spark";
    const s = Math.random() < 0.3 ? 3 : 4;
    b.style.cssText = `left:${Math.round(e.clientX - r.left)}px;top:${Math.round(e.clientY - r.top)}px;width:${s}px;height:${s}px;background:${CONFETTI[Math.floor(Math.random() * CONFETTI.length)]}`;
    hero.append(b);
    alive++;
    const dx = (Math.random() - 0.5) * 24;
    const a = b.animate(
      [
        { transform: "translate(0, 0)", opacity: 0.95 },
        { transform: `translate(${dx}px, ${-18 - Math.random() * 18}px)`, opacity: 0 },
      ],
      { duration: 650 + Math.random() * 250, easing: "cubic-bezier(.2,.7,.3,1)" },
    );
    a.onfinish = () => {
      b.remove();
      alive--;
    };
  }, { passive: true });
}

/* ------------------------------------------------------------------ the tour */

const tourDlg = $<HTMLDialogElement>(".tour-dlg");
const tourVideo = tourDlg?.querySelector("video");
for (const b of $$("[data-tour]")) {
  b.addEventListener("click", () => {
    if (!tourDlg) return;
    tourDlg.showModal();
    void tourVideo?.play().catch(() => {});
  });
}
tourDlg?.querySelector(".tour-close")?.addEventListener("click", () => tourDlg.close());
tourDlg?.addEventListener("click", (e) => {
  if (e.target === tourDlg) tourDlg.close();
});
tourDlg?.addEventListener("close", () => tourVideo?.pause());

/* ------------------------------------------------------------------ wiring the office */

if (win && mount) {
  userPaused = reduced.matches;
  paintPause();
  playBtn?.addEventListener("click", () => void play());

  const io = new IntersectionObserver(
    (entries) => {
      inView = entries.some((e) => e.isIntersecting);
      if (inView && !userPaused) void load().then(sync);
      else sync();
    },
    { rootMargin: "120px 0px" },
  );
  // Let the page paint first: the still is up, the office chunk can wait a beat.
  const begin = () => io.observe(win);
  if (document.readyState === "complete") setTimeout(begin, 60);
  else addEventListener("load", () => setTimeout(begin, 60), { once: true });
  document.addEventListener("visibilitychange", sync);
  void boot();

  $('[data-toggle="pause"]', win)?.addEventListener("click", () => {
    if (userPaused) return void play();
    userPaused = true;
    sync();
  });

  /* the "your turn" chips */
  let last: { m: string; id: string; at: number } | null = null;
  for (const btn of $$<HTMLButtonElement>("[data-moment]")) {
    btn.addEventListener("click", async () => {
      const m = btn.dataset.moment as Moment;
      const o = await ready(true);
      if (!o) return;
      if (last && last.m === m && performance.now() - last.at < 2_500) {
        // a double press brings the camera back to the same worker instead of starting another
        o.focus(last.id);
        return;
      }
      const fired = fire(o, m, true, true);
      btn.classList.remove("fired", "busy");
      void btn.offsetWidth;
      clearTimeout(Number(btn.dataset.t));
      btn.dataset.t = String(window.setTimeout(() => btn.classList.remove("fired", "busy"), 2_400));
      if (fired) {
        last = { m, id: fired.workerId, at: performance.now() };
        btn.classList.add("fired");
      } else {
        btn.classList.add("busy");
        say(m === "arrive" ? "The office is full for now; try again in a moment." : "Everyone's in the middle of something; try again in a moment.");
      }
    });
  }

  /* F flips a table, wherever you are on the page */
  addEventListener("keydown", async (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || e.key.toLowerCase() !== "f") return;
    if ((e.target as HTMLElement).closest("input, textarea, select, [contenteditable], dialog")) return;
    const o = await ready(true);
    if (o) fire(o, "flip", !reduced.matches, true);
  });

  layoutStage();
  new ResizeObserver(() => {
    layoutStage();
    checkBeats();
    tiltWindow();
  }).observe(stage ?? win);
  addEventListener("resize", layoutStage);
  addEventListener("scroll", onScroll, { passive: true });
  checkBeats();
  tiltWindow();
  markPinned();
  tiltShowcase();
}

