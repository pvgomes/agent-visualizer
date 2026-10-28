/*
 * The soundtrack, synthesised offline (OfflineAudioContext) from the cues the
 * shots record as they play: no samples, no music by anyone else. A quiet
 * pulse at 120 BPM under the office, and small sounds for what happens on
 * screen (keys, the lift's ding, the beam, the flip). Returned as a 48 kHz
 * stereo 16-bit WAV, base64, for the renderer to encode and mux.
 */
export interface Cue {
  t: number;
  kind: string;
  dur?: number;
  vol?: number;
  pitch?: number;
  soft?: boolean;
  level?: number;
}

const SR = 48_000;
const BPM = 120;

/** Seeded noise, so every render sounds the same. */
function noiseBuffer(ctx: BaseAudioContext, secs: number, seed: number): AudioBuffer {
  const b = ctx.createBuffer(1, Math.max(1, Math.floor(secs * SR)), SR);
  const d = b.getChannelData(0);
  let s = seed >>> 0;
  for (let i = 0; i < d.length; i++) {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    d[i] = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  }
  return b;
}

export async function synth(cues: Cue[], total: number): Promise<string> {
  const len = Math.ceil((total + 0.5) * SR);
  const ctx = new OfflineAudioContext(2, len, SR);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.ratio.value = 3;
  comp.attack.value = 0.004;
  comp.release.value = 0.2;
  const master = ctx.createGain();
  master.gain.value = 0.9;
  comp.connect(master).connect(ctx.destination);
  // a little room, so dry clicks don't sound like they're in a box
  const verb = ctx.createConvolver();
  const ir = ctx.createBuffer(2, SR * 1.6, SR);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    const n = noiseBuffer(ctx, 1.6, 77 + ch).getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = n[i]! * Math.pow(1 - i / d.length, 3.2) * 0.5;
  }
  verb.buffer = ir;
  const verbIn = ctx.createGain();
  verbIn.gain.value = 0.22;
  verbIn.connect(verb).connect(comp);
  const noise = noiseBuffer(ctx, 3, 1234);
  let seed = 1;

  const out = (pan = 0, wet = 0.3) => {
    const g = ctx.createGain();
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    g.connect(p);
    p.connect(comp);
    const w = ctx.createGain();
    w.gain.value = wet;
    p.connect(w).connect(verbIn);
    return g;
  };
  const env = (g: GainNode, t: number, peak: number, a: number, d: number) => {
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  };
  const tone = (t: number, f0: number, f1: number, dur: number, vol: number, type: OscillatorType = "sine", pan = 0, wet = 0.3, attack = 0.004) => {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const g = ctx.createGain();
    env(g, t, vol, attack, dur);
    o.connect(g).connect(out(pan, wet));
    o.start(t);
    o.stop(t + attack + dur + 0.05);
  };
  const hiss = (t: number, dur: number, vol: number, type: BiquadFilterType, f0: number, f1 = f0, q = 1, pan = 0, attack = 0.002, wet = 0.3) => {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    env(g, t, vol, attack, dur);
    src.connect(f).connect(g).connect(out(pan, wet));
    src.start(t, (seed++ * 0.137) % 2.5);
    src.stop(t + attack + dur + 0.05);
  };

  const kick = (t: number, vol: number) => {
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    const g = ctx.createGain();
    env(g, t, vol, 0.003, 0.32);
    o.connect(g).connect(out(0, 0.05));
    o.start(t);
    o.stop(t + 0.4);
  };

  // the bed: a pulse on every beat while the office is on screen, a hat on the off-beat
  for (const c of cues.filter((c) => c.kind === "bed" && (c.level ?? 1) > 0)) {
    const t0 = c.t, t1 = c.t + (c.dur ?? 0);
    const lvl = c.level ?? 1;
    const first = Math.ceil(t0 / (60 / BPM) - 1e-6);
    for (let i = first; i * (60 / BPM) < t1 - 0.01; i++) {
      const t = i * (60 / BPM);
      kick(t, 0.22 * lvl);
      hiss(t + 30 / BPM, 0.035, 0.018 * lvl, "highpass", 7000, 7000, 0.7, i % 2 ? 0.25 : -0.25, 0.001, 0.1);
    }
    // a low pad under it, A minor, breathing
    for (const [f, pan] of [[110, -0.3], [164.81, 0.3], [261.63, 0]] as const) {
      const o = ctx.createOscillator();
      o.type = "triangle";
      o.frequency.value = f;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 900;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.018 * lvl, t0 + 0.6);
      g.gain.setValueAtTime(0.018 * lvl, Math.max(t0 + 0.6, t1 - 0.4));
      g.gain.linearRampToValueAtTime(0, t1);
      o.connect(lp).connect(g).connect(out(pan, 0.5));
      o.start(t0);
      o.stop(t1 + 0.05);
    }
  }

  let ki = 0;
  for (const c of cues) {
    const t = c.t;
    const v = c.vol ?? 1;
    switch (c.kind) {
      case "key": {
        const p = 0.85 + ((ki++ * 0.37) % 0.3);
        hiss(t, 0.02, 0.3 * v, "bandpass", 3800 * p, 3800 * p, 1.4, -0.1 + (ki % 3) * 0.1, 0.001, 0.15);
        tone(t, 1700 * p, 900, 0.03, 0.1 * v, "triangle", 0, 0.1);
        tone(t, 180, 120, 0.04, 0.12 * v, "sine", 0, 0.05);
        break;
      }
      case "enter":
        hiss(t, 0.03, 0.22, "bandpass", 2400, 2400, 1.2, 0, 0.001, 0.2);
        tone(t, 220, 110, 0.12, 0.3, "sine", 0, 0.2);
        break;
      case "hum": {
        const d = c.dur ?? 3;
        hiss(t, d, 0.16, "bandpass", 420, 620, 0.8, 0, 0.3, 0.2);
        tone(t, 55, 55, d, 0.08, "sawtooth", 0, 0.1, 0.4);
        for (let i = 0; i < d * 26; i++) {
          const tt = t + i / 26 + ((i * 0.618) % 1) * 0.02;
          tone(tt, 1800 + ((i * 397) % 1600), 1800 + ((i * 397) % 1600), 0.012, 0.045, "square", ((i * 0.31) % 1.6) - 0.8, 0.1);
        }
        break;
      }
      case "thud":
        tone(t, 90, 38, 0.5, 0.55 * v, "sine", 0, 0.25);
        hiss(t, 0.12, 0.2 * v, "lowpass", 900, 200, 0.7);
        break;
      case "whoosh": {
        const d = c.dur ?? 0.5;
        hiss(t, d, c.soft ? 0.05 : 0.12, "bandpass", c.soft ? 500 : 300, c.soft ? 1800 : 3500, 1.5, 0, d * 0.6, 0.4);
        break;
      }
      case "power":
        tone(t, 60, 1100, 0.22, 0.12, "sawtooth", 0, 0.2, 0.01);
        hiss(t, 0.25, 0.12, "highpass", 2000, 6000, 0.7);
        tone(t + 0.05, 15_700, 15_700, 0.9, 0.006, "sine");
        break;
      case "ding": {
        // the lift: a soft two-partial bell
        tone(t, 1318.5, 1318.5, 1.1, 0.07 * v, "sine", -0.35, 0.5, 0.003);
        tone(t + 0.12, 1046.5, 1046.5, 1.3, 0.06 * v, "sine", -0.35, 0.5, 0.003);
        tone(t, 3955, 3955, 0.25, 0.012 * v, "sine", -0.35, 0.5);
        break;
      }
      case "tick":
        tone(t, 880, 660, 0.05, 0.12, "triangle", 0, 0.2);
        hiss(t, 0.02, 0.06, "highpass", 5000);
        break;
      case "riser": {
        const d = c.dur ?? 1;
        hiss(t, d, 0.1, "bandpass", 300, 4000, 2, 0, d * 0.95, 0.3);
        tone(t, 110, 440, d, 0.05, "sawtooth", 0, 0.2, d * 0.9);
        break;
      }
      case "impact":
        tone(t, 70, 26, 1.2, 0.9, "sine", 0, 0.3, 0.002);
        tone(t, 160, 50, 0.35, 0.35, "square", 0, 0.2, 0.001);
        hiss(t, 0.5, 0.5, "lowpass", 4000, 300, 0.7, 0, 0.001, 0.5);
        hiss(t + 0.02, 0.9, 0.12, "highpass", 3000, 3000, 0.7, 0.2, 0.001, 0.6);
        break;
      case "slowmo": {
        // the world slowed down: a low swell under the flying desk
        const d = c.dur ?? 1.5;
        tone(t, 46, 34, d, 0.3, "sine", 0, 0.3, d * 0.3);
        hiss(t, d, 0.08, "lowpass", 500, 160, 0.7, 0, d * 0.4, 0.6);
        break;
      }
      case "crash":
        // the desk lands: wood, then a rattle
        tone(t, 210, 140, 0.18, 0.4, "triangle", -0.2, 0.3);
        hiss(t, 0.35, 0.3, "bandpass", 1600, 700, 1.1, -0.2, 0.001, 0.4);
        hiss(t + 0.09, 0.25, 0.15, "bandpass", 3200, 2000, 2, 0.2, 0.001, 0.4);
        tone(t + 0.16, 180, 160, 0.1, 0.2, "triangle", 0.2, 0.3);
        break;
      case "beam": {
        const p = 1 + (c.pitch ?? 0) * 0.19;
        const o = ctx.createOscillator();
        o.type = "sine";
        o.frequency.setValueAtTime(380 * p, t);
        o.frequency.exponentialRampToValueAtTime(1500 * p, t + 0.55);
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 22;
        const lg = ctx.createGain();
        lg.gain.value = 40 * p;
        lfo.connect(lg).connect(o.frequency);
        const g = ctx.createGain();
        env(g, t, 0.09, 0.08, 0.7);
        o.connect(g).connect(out(0.4, 0.6));
        o.start(t);
        lfo.start(t);
        o.stop(t + 0.9);
        lfo.stop(t + 0.9);
        hiss(t, 0.7, 0.05, "highpass", 6000, 9000, 0.7, 0.4, 0.05, 0.6);
        break;
      }
      case "chime":
        tone(t, 1318.5, 1318.5, 0.6, 0.06, "sine", 0.1, 0.5);
        tone(t + 0.11, 1760, 1760, 0.8, 0.05, "sine", 0.1, 0.5);
        break;
      case "click":
        tone(t, 2600, 1800, 0.012, 0.09 * v, "square", 0, 0.1);
        hiss(t, 0.01, 0.08 * v, "highpass", 4000);
        break;
      case "keycap":
        hiss(t, 0.03, 0.2, "bandpass", 2000, 1400, 1, 0, 0.001, 0.2);
        tone(t, 150, 90, 0.08, 0.3, "sine", 0, 0.1);
        break;
      case "crt":
        tone(t, 15_700, 15_700, 0.8, 0.008, "sine");
        hiss(t, 0.35, 0.07, "highpass", 3000, 1500, 0.7, 0, 0.002, 0.2);
        break;
      case "chord": {
        const d = c.dur ?? 4;
        const notes: [number, number][] = [[220, -0.4], [329.63, 0.4], [392, -0.2], [493.88, 0.2], [587.33, 0]];
        for (const [f, pan] of notes) {
          for (const det of [-3, 3]) {
            const o = ctx.createOscillator();
            o.type = "triangle";
            o.frequency.value = f;
            o.detune.value = det;
            const lp = ctx.createBiquadFilter();
            lp.type = "lowpass";
            lp.frequency.setValueAtTime(500, t);
            lp.frequency.linearRampToValueAtTime(2200, t + 1.2);
            const g = ctx.createGain();
            g.gain.setValueAtTime(0, t);
            g.gain.linearRampToValueAtTime(0.022, t + 0.9);
            g.gain.setValueAtTime(0.022, t + Math.max(1, d - 1.6));
            g.gain.linearRampToValueAtTime(0, t + d);
            o.connect(lp).connect(g).connect(out(pan, 0.6));
            o.start(t);
            o.stop(t + d + 0.05);
          }
        }
        tone(t + 0.05, 1318.5, 1318.5, 1.6, 0.04, "sine", 0, 0.7);
        break;
      }
    }
  }

  const buf = await ctx.startRendering();
  // fade the very end, then 16-bit PCM WAV
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  const n = Math.floor(total * SR);
  const fade = Math.floor(0.4 * SR);
  const bytes = new DataView(new ArrayBuffer(44 + n * 4));
  const w4 = (o: number, s: string) => [...s].forEach((ch, i) => bytes.setUint8(o + i, ch.charCodeAt(0)));
  w4(0, "RIFF");
  bytes.setUint32(4, 36 + n * 4, true);
  w4(8, "WAVE");
  w4(12, "fmt ");
  bytes.setUint32(16, 16, true);
  bytes.setUint16(20, 1, true);
  bytes.setUint16(22, 2, true);
  bytes.setUint32(24, SR, true);
  bytes.setUint32(28, SR * 4, true);
  bytes.setUint16(32, 4, true);
  bytes.setUint16(34, 16, true);
  w4(36, "data");
  bytes.setUint32(40, n * 4, true);
  // makeup gain, and a soft knee above -3 dBFS so the impact saturates instead of clipping
  const G = 2.3;
  const knee = (x: number) => {
    const a = Math.abs(x);
    return a < 0.7 ? x : Math.sign(x) * (0.7 + 0.28 * Math.tanh((a - 0.7) / 0.28));
  };
  for (let i = 0; i < n; i++) {
    const f = i > n - fade ? (n - i) / fade : 1;
    bytes.setInt16(44 + i * 4, knee(L[i]! * G * f) * 32767, true);
    bytes.setInt16(46 + i * 4, knee(R[i]! * G * f) * 32767, true);
  }
  const u8 = new Uint8Array(bytes.buffer);
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
