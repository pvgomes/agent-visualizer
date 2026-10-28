/*
 * A session's real terminal: xterm.js attached to the agent's PTY on the
 * server. Output arrives base64 on the term stream: the visible screen first
 * ("screen"), then the whole replay with the scrollback (the first "data",
 * marked full), each drawn from a reset terminal, then live bytes; a
 * reconnect starts from a clean screen the same way. Keystrokes go to /input
 * in order, coalesced per tick; the size follows the panel and is sent to
 * /resize. One PTY can have several viewers (a desktop and a phone): it takes
 * the size of the one in use, so a view re-sends its size when its stream
 * (re)opens, when it gets the focus or comes back into view, and when it
 * types after a pause, even if its own size never changed.
 *
 * This module is its own chunk (with xterm.js), loaded when a terminal panel
 * first opens or ahead of it (session.ts). One xterm is kept between panels
 * (and can be made ahead, prewarmTerminal), so opening a terminal doesn't
 * build and measure a new one each time.
 * xterm's DOM renderer injects <style> elements and colour style attributes,
 * which is why the page's CSP allows inline styles (scripts stay 'self').
 */
import { Terminal, type IDisposable, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import xtermCss from "@xterm/xterm/css/xterm.css";
import { adoptCss } from "../dom.ts";
import { api, stream, termPath, type Stream, type StreamState } from "./api.ts";

/** The office palette: near-black glass, warm off-white, the brand-ish ANSI colours. */
const THEME: ITheme = {
  background: "#0b0b10",
  foreground: "#e6e3dc",
  cursor: "#eceae4",
  cursorAccent: "#0b0b10",
  selectionBackground: "rgba(255, 255, 255, 0.22)",
  scrollbarSliderBackground: "rgba(255, 255, 255, 0.12)",
  scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.22)",
  black: "#16161d",
  red: "#ff6b62",
  green: "#4ade80",
  yellow: "#ffb547",
  blue: "#7aa2ff",
  magenta: "#c49bff",
  cyan: "#5fd4d0",
  white: "#d8d5ce",
  brightBlack: "#5c5c66",
  brightRed: "#ff8f87",
  brightGreen: "#86efac",
  brightYellow: "#ffd089",
  brightBlue: "#a5c0ff",
  brightMagenta: "#dcc2ff",
  brightCyan: "#9be8e5",
  brightWhite: "#f6f4ef",
};

let cssDone = false;

export interface TermView {
  el: HTMLElement;
  focus(): void;
  /** Re-fit to the container (after it is shown or resized). */
  fit(): void;
  /** Stops input, keeps the screen (the agent exited). */
  freeze(note: string): void;
  dispose(): void;
}

/* ------------------------------------------------- one xterm, kept between panels */

interface Pooled {
  term: Terminal;
  fitter: FitAddon;
  el: HTMLElement;
  opened: boolean;
  /** Writes xterm hasn't parsed yet: a terminal is only reused once they are done. */
  pending: number;
}

let spare: Pooled | null = null;
let parking: HTMLElement | null = null;

function fresh(): Pooled {
  if (!cssDone) {
    adoptCss(xtermCss);
    cssDone = true;
  }
  const el = document.createElement("div");
  el.className = "term";
  const term = new Terminal({
    theme: THEME,
    fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace',
    fontSize: 12.5,
    lineHeight: 1.15,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: false,
    macOptionIsMeta: true,
    convertEol: false,
  });
  const fitter = new FitAddon();
  term.loadAddon(fitter);
  return { term, fitter, el, opened: false, pending: 0 };
}

function take(): Pooled {
  const p = spare ?? fresh();
  spare = null;
  return p;
}

/** Back to the pool for the next panel, or gone if one is already waiting (or it is mid-write). */
function release(p: Pooled): void {
  if (spare || p.pending > 0 || !p.opened) {
    p.term.dispose();
    p.el.remove();
    return;
  }
  p.term.reset();
  p.term.options.cursorBlink = true;
  p.el.classList.remove("is-waiting");
  park(p);
  spare = p;
}

/** Off screen but laid out, so xterm can open and measure there. */
function park(p: Pooled): void {
  if (!parking) {
    parking = document.createElement("div");
    parking.setAttribute("aria-hidden", "true");
    parking.style.cssText = "position:fixed;left:-10000px;top:0;width:720px;height:420px;visibility:hidden;pointer-events:none;contain:strict;";
    document.body.append(parking);
  }
  parking.append(p.el);
}

/** Build and open the next panel's xterm now (on idle), so the first terminal opens without that work. */
export function prewarmTerminal(): void {
  if (spare) return;
  const p = fresh();
  park(p);
  try {
    p.term.open(p.el);
    p.opened = true;
  } catch {
    p.term.dispose();
    p.el.remove();
    return;
  }
  spare = p;
}

/* -------------------------------------------------------------------- view */

export function createTerminal(sessionId: string, opts: { onExit?(code: number | undefined): void; onState?(s: StreamState, err?: string): void } = {}): TermView {
  const p = take();
  const { term, fitter, el } = p;
  // until the screen arrives: a quiet placeholder (styles.css), not an empty black box
  el.classList.add("is-waiting");
  let frozen = false;
  let cols = 0, rows = 0;
  let decoder = new TextDecoder();
  const subs: IDisposable[] = [];
  const write = (data: string) => {
    p.pending++;
    term.write(data, () => void p.pending--);
  };

  /* Keystrokes: coalesced per tick, sent strictly in order. */
  let pending = "";
  let chain: Promise<unknown> = Promise.resolve();
  let flushQueued = false;
  const flush = () => {
    flushQueued = false;
    const data = pending;
    pending = "";
    if (!data) return;
    chain = chain.then(() => api.input(sessionId, data)).catch(() => undefined);
  };
  subs.push(
    term.onData((d) => {
      if (frozen) return;
      if (Date.now() - sizeAt > 2_000) assertSize();
      pending += d;
      if (!flushQueued) {
        flushQueued = true;
        setTimeout(flush, 8);
      }
    }),
  );
  // Alt+1/2/3 answer an approval from the panel; they never reach the agent.
  term.attachCustomKeyEventHandler((ev) => !(ev.altKey && /^Digit[123]$/.test(ev.code)));

  let resizeTimer = 0;
  let sizeAt = 0;
  const sendSize = (force = false) => {
    if (frozen || !p.opened || !term.cols || !term.rows) return;
    if (!force && term.cols === cols && term.rows === rows) return;
    cols = term.cols;
    rows = term.rows;
    sizeAt = Date.now();
    void api.resize(sessionId, cols, rows).catch(() => undefined);
  };
  /** This view is the one in use: the PTY takes its size, whatever another viewer set. */
  const assertSize = () => sendSize(true);
  el.addEventListener("focusin", assertSize);
  const onVisible = () => {
    if (document.visibilityState === "visible" && el.isConnected) assertSize();
  };
  document.addEventListener("visibilitychange", onVisible);
  const fit = () => {
    if (!el.isConnected || !el.clientWidth || !el.clientHeight) return;
    if (!p.opened) {
      term.open(el);
      p.opened = true;
    }
    try {
      fitter.fit();
    } catch {
      /* not laid out yet */
    }
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(sendSize, 60);
  };
  const ro = new ResizeObserver(() => fit());
  ro.observe(el);

  const b64 = (s: string): Uint8Array => {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  /**
   * A fresh screen to draw a replay on: a full reset (RIS) written in order with the bytes, since
   * term.reset() would act before writes xterm hasn't parsed yet. The replay's bytes start clean.
   */
  const restart = () => {
    write("\x1bc");
    decoder = new TextDecoder();
  };
  const shown = () => {
    if (el.classList.contains("is-waiting")) el.classList.remove("is-waiting");
  };

  const out: Stream = stream(
    termPath(sessionId),
    (event, data) => {
      let msg: { d?: unknown; code?: unknown; full?: unknown };
      try {
        msg = JSON.parse(data) as typeof msg;
      } catch {
        return;
      }
      if ((event === "screen" || event === "data") && typeof msg.d === "string") {
        // the visible screen, then the whole replay: each drawn from scratch
        if (event === "screen" || msg.full) restart();
        write(decoder.decode(b64(msg.d), { stream: true }));
        shown();
      } else if (event === "exit") {
        shown();
        opts.onExit?.(typeof msg.code === "number" ? msg.code : undefined);
      }
    },
    (s, reconnect, err) => {
      // the server replays the screen on every connect
      if (s === "open" && reconnect) restart();
      if (s === "open") assertSize();
      opts.onState?.(s, err);
    },
  );

  let gone = false;
  return {
    el,
    focus: () => term.focus(),
    fit,
    freeze(note) {
      if (frozen) return;
      frozen = true;
      term.options.cursorBlink = false;
      write(`\r\n\x1b[2m${note}\x1b[0m\r\n`);
    },
    dispose() {
      if (gone) return;
      gone = true;
      out.close();
      ro.disconnect();
      el.removeEventListener("focusin", assertSize);
      document.removeEventListener("visibilitychange", onVisible);
      clearTimeout(resizeTimer);
      flush();
      for (const s of subs) s.dispose();
      term.attachCustomKeyEventHandler(() => true);
      release(p);
    },
  };
}
