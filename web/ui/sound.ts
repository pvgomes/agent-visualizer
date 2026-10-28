/*
 * Tiny synthesised sound design, off by default. Everything is generated with
 * WebAudio at low gain (no audio files): key ticks for edits, an elevator ding
 * for a new intern, a crash for a flipped table, a chime for green tests and a
 * pop when an agent waits on you.
 */

export type Cue = "tick" | "ding" | "crash" | "chime" | "pop" | "on";

export class Sound {
  enabled = false;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private lastTick = 0;

  /** Must be called from a user gesture the first time (autoplay rules). */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on && !this.ctx) {
      try {
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        this.ctx = new Ctor();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.22;
        this.master.connect(this.ctx.destination);
        const len = Math.floor(this.ctx.sampleRate * 0.6);
        this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const ch = this.noise.getChannelData(0);
        for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
      } catch {
        this.enabled = false;
        return;
      }
    }
    if (on) void this.ctx?.resume();
  }

  play(cue: Cue): void {
    if (!this.enabled || !this.ctx || !this.master || this.ctx.state !== "running") return;
    const t = this.ctx.currentTime + 0.005;
    switch (cue) {
      case "tick": {
        const now = performance.now();
        if (now - this.lastTick < 55) return;
        this.lastTick = now;
        this.burst(t, 0.025, 2800 + Math.random() * 1800, 0.14, "bandpass", 6);
        break;
      }
      case "ding":
        this.bell(t, 1318.5, 0.16, 1.4);
        this.bell(t + 0.16, 1046.5, 0.13, 1.6);
        break;
      case "crash":
        this.burst(t, 0.42, 5200, 0.5, "lowpass", 0.7, 700);
        this.tone(t, "sine", 120, 42, 0.32, 0.5);
        this.burst(t + 0.09, 0.05, 1500, 0.3, "bandpass", 3);
        this.burst(t + 0.19, 0.04, 1100, 0.22, "bandpass", 3);
        break;
      case "chime":
        [1046.5, 1318.5, 1568, 2093].forEach((f, i) => this.tone(t + i * 0.07, "triangle", f, f, 0.6, 0.09));
        break;
      case "pop":
        this.tone(t, "sine", 720, 210, 0.11, 0.28);
        break;
      case "on":
        this.tone(t, "square", 880, 880, 0.05, 0.05);
        this.tone(t + 0.06, "square", 1320, 1320, 0.07, 0.05);
        break;
    }
  }

  private tone(t: number, type: OscillatorType, from: number, to: number, dur: number, gain: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(from, t);
    if (to !== from) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master!);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private bell(t: number, f: number, gain: number, dur: number): void {
    this.tone(t, "sine", f, f, dur, gain);
    this.tone(t, "sine", f * 2.76, f * 2.76, dur * 0.35, gain * 0.25);
    this.tone(t, "sine", f * 5.4, f * 5.4, dur * 0.15, gain * 0.08);
  }

  private burst(t: number, dur: number, freq: number, gain: number, type: BiquadFilterType, q: number, sweepTo?: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master!);
    src.start(t);
    src.stop(t + dur + 0.02);
  }
}
