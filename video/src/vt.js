/*
 * Virtual time for the launch video. Loaded first, as a classic script, in the
 * stage page and in the real web app's iframe: from then on setTimeout,
 * setInterval, requestAnimationFrame, performance.now, Date and Math.random in
 * that window run on one clock the renderer moves a frame at a time, so every
 * frame of the video is a pure function of its timestamp. CSS animations and
 * transitions are paused and scrubbed to the same clock (syncAnimations).
 *
 *   __vt.install(window)    patch a window (the iframe calls parent.__vt.install(window))
 *   __vt.advance(t)         run every timer due up to virtual ms t
 *   __vt.raf(t)             run the queued animation-frame callbacks at t
 *   __vt.settle()           let promise chains and stream reads finish (real event loop hops)
 */
(() => {
  if (window.__vt) return;
  /** The wall clock the office sees at virtual 0: a fixed evening, so the sky and the clock on the wall never change between renders. */
  const EPOCH = new Date(2026, 9, 20, 21, 40, 0).getTime();
  const realSetTimeout = window.setTimeout.bind(window);
  const chan = new MessageChannel();
  const hops = [];
  chan.port1.onmessage = () => hops.shift()?.();

  let now = 0;
  let seq = 0;
  /** id -> { at, every, fn, args, win, seq } */
  const timers = new Map();
  /** id -> { fn, win } */
  let rafs = new Map();
  const wins = new Set();

  // one seeded stream for every window (mulberry32)
  let seed = 0x2f6b9e1d;
  const random = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  function install(win) {
    if (wins.has(win)) return;
    wins.add(win);
    const RealDate = win.Date;
    function VDate(...a) {
      if (!new.target) return new RealDate(EPOCH + now).toString();
      return a.length ? new RealDate(...a) : new RealDate(EPOCH + now);
    }
    VDate.prototype = RealDate.prototype;
    VDate.now = () => EPOCH + now;
    VDate.parse = RealDate.parse;
    VDate.UTC = RealDate.UTC;
    Object.setPrototypeOf(VDate, RealDate);
    win.Date = VDate;
    win.performance.now = () => now;
    win.Math.random = random;
    const add = (fn, ms, args, every) => {
      const id = ++seq;
      const d = Math.max(0, Number(ms) || 0);
      timers.set(id, { at: now + d, every: every ? Math.max(1, d) : 0, fn, args, win, seq: id });
      return id;
    };
    win.setTimeout = (fn, ms, ...args) => add(fn, ms, args, false);
    win.setInterval = (fn, ms, ...args) => add(fn, ms, args, true);
    win.clearTimeout = win.clearInterval = (id) => void timers.delete(id);
    win.requestAnimationFrame = (fn) => {
      const id = ++seq;
      rafs.set(id, { fn, win });
      return id;
    };
    win.cancelAnimationFrame = (id) => void rafs.delete(id);
    win.requestIdleCallback = (fn) => add(() => fn({ didTimeout: false, timeRemaining: () => 8 }), 1, [], false);
    win.cancelIdleCallback = (id) => void timers.delete(id);
  }

  /** Forget a window (an iframe being removed): its timers and frames never run again. */
  function uninstall(win) {
    wins.delete(win);
    for (const [id, t] of timers) if (t.win === win) timers.delete(id);
    for (const [id, r] of rafs) if (r.win === win) rafs.delete(id);
  }

  const call = (fn, args) => {
    try {
      typeof fn === "function" ? fn(...args) : (0, eval)(String(fn));
    } catch (err) {
      console.error("[vt] timer threw", err);
    }
  };

  function advance(t) {
    for (let guard = 0; guard < 100_000; guard++) {
      let next = null;
      for (const [id, x] of timers) if (x.at <= t && (!next || x.at < next[1].at || (x.at === next[1].at && x.seq < next[1].seq))) next = [id, x];
      if (!next) break;
      const [id, x] = next;
      now = Math.max(now, x.at);
      if (x.every) {
        x.at += x.every;
        x.seq = ++seq;
      } else timers.delete(id);
      call(x.fn, x.args);
    }
    now = Math.max(now, t);
  }

  function raf(t) {
    now = Math.max(now, t);
    const q = rafs;
    rafs = new Map();
    for (const { fn } of q.values()) call(fn, [t]);
  }

  /** Real event-loop hops, so fetch bodies and stream reads resolve before the frame is drawn. */
  async function settle(n = 4) {
    for (let i = 0; i < n; i++) await new Promise((r) => (hops.push(r), chan.port2.postMessage(0)));
  }

  const starts = new WeakMap();
  /** Pause every CSS animation and transition in `doc` and scrub it to the virtual clock. */
  function syncAnimations(doc) {
    if (!doc?.getAnimations) return;
    void doc.documentElement?.offsetWidth;
    for (const a of doc.getAnimations()) {
      let s = starts.get(a);
      if (s === undefined) {
        s = now;
        starts.set(a, s);
      }
      if (a.playState === "running") a.pause();
      try {
        a.currentTime = now - s;
      } catch {
        /* a finished one with no effect left */
      }
    }
  }

  install(window);
  window.__vt = {
    install,
    uninstall,
    advance,
    raf,
    settle,
    syncAnimations,
    get now() {
      return now;
    },
    epoch: EPOCH,
    realSetTimeout,
    random,
  };
})();
