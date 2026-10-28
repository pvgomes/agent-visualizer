/*
 * PNG screenshots, 10-second clips, and the replay buffer behind "clip that":
 * the office is kept recording in two staggered 20-second takes, so pressing
 * R right after a table flip saves the take that holds the last ~15 seconds.
 * Only the canvas is captured, never the chrome; the replay buffer burns a
 * caption for each big moment and a small "npx @pvgomes/agent-visualizer" mark into its
 * own copy of the frame, so a clip explains itself when it's posted.
 */
import { stamp } from "./format.ts";

export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function screenshot(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (!blob) return reject(new Error("The canvas is empty."));
        const name = `agent-visualizer-${stamp()}.png`;
        download(blob, name);
        resolve(name);
      }, "image/png");
    } catch (err) {
      reject(err);
    }
  });
}

const TYPES: [string, string][] = [
  ["video/mp4;codecs=avc1.640028", "mp4"],
  ["video/mp4;codecs=avc1", "mp4"],
  ["video/mp4", "mp4"],
  ["video/webm;codecs=vp9", "webm"],
  ["video/webm;codecs=vp8", "webm"],
  ["video/webm", "webm"],
];

export const canRecord = (): boolean =>
  typeof MediaRecorder !== "undefined" && typeof HTMLCanvasElement.prototype.captureStream === "function";

export interface Recording {
  stop(): void;
  done: Promise<string>;
}

export function record(canvas: HTMLCanvasElement, ms: number): Recording {
  const stream = canvas.captureStream(60);
  const [mimeType, ext] = TYPES.find(([t]) => MediaRecorder.isTypeSupported(t)) ?? ["", "webm"];
  const rec = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 16_000_000 } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  const done = new Promise<string>((resolve, reject) => {
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      if (!chunks.length) return reject(new Error("Nothing was recorded."));
      const name = `agent-visualizer-${stamp()}.${ext}`;
      download(new Blob(chunks, { type: mimeType || "video/webm" }), name);
      resolve(name);
    };
    rec.onerror = () => reject(new Error("The recorder stopped unexpectedly."));
  });
  rec.start(250);
  const timer = setTimeout(() => rec.state !== "inactive" && rec.stop(), ms);
  return {
    stop() {
      clearTimeout(timer);
      if (rec.state !== "inactive") rec.stop();
    },
    done,
  };
}

/* ------------------------------------------------------------ replay buffer */

const SLOT_MS = 20_000;
const CLIP_W = 1280;
const CAPTION_MS = 3_600;

interface Slot {
  rec: MediaRecorder | null;
  chunks: Blob[];
  startedAt: number;
  keep: ((name: string) => void) | null;
  fail: ((err: Error) => void) | null;
  timer: number;
}

export class ReplayBuffer {
  private readonly comp = document.createElement("canvas");
  private readonly g = this.comp.getContext("2d")!;
  private stream: MediaStream | null = null;
  private slots: Slot[] = [];
  private raf = 0;
  private stagger = 0;
  private running = false;
  private caption: { text: string; color: string; t0: number } | null = null;
  private mime = "";
  private ext = "webm";

  constructor(private readonly src: HTMLCanvasElement) {}

  start(): void {
    if (this.running || !canRecord()) return;
    this.running = true;
    const w = Math.min(CLIP_W, this.src.width || CLIP_W);
    const h = Math.round((w * (this.src.height || 720)) / (this.src.width || 1280)) & ~1;
    this.comp.width = w & ~1;
    this.comp.height = Math.max(2, h);
    [this.mime, this.ext] = TYPES.find(([t]) => MediaRecorder.isTypeSupported(t)) ?? ["", "webm"];
    this.stream = this.comp.captureStream(30);
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.draw();
    };
    loop();
    this.slots = [this.slot(), this.slot()];
    this.begin(this.slots[0]!);
    this.stagger = window.setTimeout(() => this.begin(this.slots[1]!), SLOT_MS / 2);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.stagger);
    for (const s of this.slots) {
      clearTimeout(s.timer);
      s.keep = null;
      if (s.rec && s.rec.state !== "inactive") s.rec.stop();
      s.rec = null;
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  /** Seconds the best take holds right now (0 when nothing is recording). */
  seconds(): number {
    const now = performance.now();
    return Math.max(0, ...this.slots.filter((s) => s.rec).map((s) => (now - s.startedAt) / 1000));
  }

  /** Burn a caption into the clip for the moment that just happened. */
  moment(text: string, color = "#f4f1ea"): void {
    this.caption = { text, color, t0: performance.now() };
  }

  /** Save the take that covers the most recent stretch (10-20s, ~15 on average). */
  save(): Promise<string> {
    const live = this.slots.filter((s) => s.rec && s.rec.state === "recording");
    if (!live.length) return Promise.reject(new Error("The replay buffer isn't running."));
    const best = live.reduce((a, b) => (a.startedAt < b.startedAt ? a : b));
    if (performance.now() - best.startedAt < 2_000) return Promise.reject(new Error("Nothing to save yet."));
    return new Promise<string>((resolve, reject) => {
      best.keep = resolve;
      best.fail = reject;
      clearTimeout(best.timer);
      best.rec!.stop();
    });
  }

  private slot(): Slot {
    return { rec: null, chunks: [], startedAt: 0, keep: null, fail: null, timer: 0 };
  }

  /** (Re)start a take; when it ends it is saved if asked for, else dropped, and the next take starts. */
  private begin(s: Slot): void {
    if (!this.running || !this.stream) return;
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime, videoBitsPerSecond: 6_000_000 } : undefined);
    } catch {
      this.stop();
      return;
    }
    s.rec = rec;
    s.chunks = [];
    s.startedAt = performance.now();
    rec.ondataavailable = (e) => {
      if (e.data.size) s.chunks.push(e.data);
    };
    rec.onstop = () => {
      const keep = s.keep, chunks = s.chunks;
      s.keep = s.fail = null;
      s.chunks = [];
      if (keep) {
        const name = `agent-visualizer-clip-${stamp()}.${this.ext}`;
        download(new Blob(chunks, { type: this.mime || "video/webm" }), name);
        keep(name);
      }
      if (this.running && s.rec === rec) this.begin(s);
    };
    rec.onerror = () => {
      s.fail?.(new Error("The recorder stopped unexpectedly."));
      s.keep = s.fail = null;
    };
    rec.start(1_000);
    s.timer = window.setTimeout(() => rec.state !== "inactive" && rec.stop(), SLOT_MS);
  }

  /** The office, scaled into the clip frame, plus the caption and the watermark. */
  private draw(): void {
    const { comp: c, g, src } = this;
    if (!src.width || !src.height) return;
    g.fillStyle = "#060608";
    g.fillRect(0, 0, c.width, c.height);
    const k = Math.min(c.width / src.width, c.height / src.height);
    const w = src.width * k, h = src.height * k;
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    g.drawImage(src, (c.width - w) / 2, (c.height - h) / 2, w, h);
    const u = c.height / 720;
    // the caption: a lower third that slides in and fades out
    const cap = this.caption;
    const age = cap ? performance.now() - cap.t0 : Infinity;
    if (cap && age < CAPTION_MS) {
      const a = Math.min(1, age / 220, (CAPTION_MS - age) / 400);
      g.globalAlpha = a;
      g.font = `600 ${Math.round(22 * u)}px ui-monospace, "SF Mono", Menlo, monospace`;
      const tw = Math.min(g.measureText(cap.text).width, c.width * 0.8);
      const x = Math.round(32 * u - (1 - Math.min(1, age / 220)) * 24 * u), y = Math.round(c.height - 92 * u);
      g.fillStyle = "rgba(8,8,12,0.82)";
      g.fillRect(x, y, tw + 36 * u, 46 * u);
      g.fillStyle = cap.color;
      g.fillRect(x, y, 5 * u, 46 * u);
      g.fillStyle = "#f4f1ea";
      g.fillText(cap.text, x + 20 * u, y + 30 * u, c.width * 0.8);
      g.globalAlpha = 1;
    }
    // the mark: so a posted clip says where it came from
    g.font = `600 ${Math.round(15 * u)}px ui-monospace, "SF Mono", Menlo, monospace`;
    const mark = "npx @pvgomes/agent-visualizer";
    const mw = g.measureText(mark).width;
    g.fillStyle = "rgba(8,8,12,0.6)";
    g.fillRect(c.width - mw - 34 * u, c.height - 40 * u, mw + 20 * u, 26 * u);
    g.fillStyle = "rgba(244,241,234,0.85)";
    g.fillText(mark, c.width - mw - 24 * u, c.height - 22 * u);
  }
}
