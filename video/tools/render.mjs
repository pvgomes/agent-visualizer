// Renders the launch video frame by frame in headless Chromium and encodes it with
// macOS VideoToolbox (tools/encode.swift); the sound is synthesised in the page with an
// OfflineAudioContext and muxed in. No ffmpeg.
//
//   node tools/render.mjs [cut...] [--fps 60] [--work <dir>] [--out <dir>]
//        [--review <seconds>]   save a PNG every <seconds> instead of encoding (fast pass)
//        [--stills t1,t2,...]   also save these moments (video seconds) as PNG stills
//        [--from s --to s]      only capture this stretch (earlier frames still run, unseen)
//
// cuts: main (1920x1080), vertical (1080x1920), square (1080x1080), readme (the README's
// demo.mp4 + demo.gif, 1200x750 @ 30 fps), stills (the README's PNGs at 2x). Default: main.
import { chromium } from "playwright-core";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { buildVideo } from "./build.mjs";
import { encodeGif } from "./gif.mjs";

const VIDEO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const cuts = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
if (!cuts.length) cuts.push("main");
const FPS_FLAG = flag("fps");
/** The README's recording is a screen capture, not a launch film: 30 fps is plenty (and the GIF takes every other frame). */
const FPS_OF = { readme: 30, "readme-gif": 30, stills: 30 };
const WORK = resolve(flag("work", join(tmpdir(), "agent-visualizer-video")));
const OUT = resolve(flag("out", join(WORK, "out")));
const REVIEW = flag("review") ? Number(flag("review")) : 0;
const STILLS = (flag("stills") ?? "").split(",").filter(Boolean).map(Number);
const FROM = Number(flag("from", 0));
const TO = Number(flag("to", Infinity));
const BITRATE = { main: 16_000_000, social: 16_000_000, vertical: 14_000_000, square: 12_000_000, readme: 3_000_000 };
/**
 * More encodes of a cut from the same frames: a lighter main cut for X, and the website's tour
 * (1280x720, 30 fps, with a JPEG poster at `poster` seconds).
 */
const EXTRA = {
  main: [
    { file: "agent-visualizer-main-x", bitrate: 10_000_000 },
    { file: "tour", w: 1280, h: 720, fps: 30, bitrate: 2_750_000, poster: 79.9 },
  ],
};
/** Output names; the README's files keep the names the README uses. */
const FILE = { readme: "demo", "readme-gif": "demo" };
/** Cuts with no film to encode, only stills. */
const STILLS_ONLY = new Set(["stills", "readme-gif"]);
/** Cuts with no soundtrack (a README video plays muted anyway). */
const SILENT = new Set(["readme", "readme-gif"]);
const PORTS = [5051, 5099];

mkdirSync(WORK, { recursive: true });
mkdirSync(OUT, { recursive: true });

/* ------------------------------------------------------------------ tools */

function encoder() {
  const bin = join(WORK, "encode");
  const src = join(VIDEO, "tools/encode.swift");
  if (!existsSync(bin) || statSync(bin).mtimeMs < statSync(src).mtimeMs) {
    console.log("compiling the encoder (swiftc)...");
    execFileSync("swiftc", ["-O", "-swift-version", "5", src, "-o", bin], { stdio: ["ignore", "ignore", "inherit"] });
  }
  return bin;
}

/** A headless Chromium: $CHROME, else the newest chrome-headless-shell in Playwright's cache, else Playwright's own pick. */
function chrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  const found = existsSync(cache)
    ? readdirSync(cache)
        .filter((d) => d.startsWith("chromium_headless_shell-"))
        .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
        .map((d) => join(cache, d, "chrome-headless-shell-mac-arm64/chrome-headless-shell"))
        .find((p) => existsSync(p))
    : undefined;
  return found;
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
async function serve(dir) {
  const srv = createServer((req, res) => {
    const p = join(dir, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!p.startsWith(dir) || !existsSync(p) || statSync(p).isDirectory()) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": TYPES[extname(p)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(readFileSync(p));
  });
  for (let port = PORTS[0]; port <= PORTS[1]; port++) {
    const ok = await new Promise((r) => {
      srv.once("error", () => r(false));
      srv.listen(port, "127.0.0.1", () => r(true));
    });
    if (ok) return { srv, port };
  }
  throw new Error("no free port in 5051-5099");
}

function writeWav(path, b64) {
  writeFileSync(path, Buffer.from(b64, "base64"));
}

/* ------------------------------------------------------------------ render */

const site = await buildVideo(WORK);
const { srv, port } = await serve(site);
const enc = REVIEW || cuts.every((c) => STILLS_ONLY.has(c)) ? null : encoder();
const browser = await chromium.launch({ executablePath: chrome(), headless: true, args: ["--disable-gpu-vsync", "--autoplay-policy=no-user-gesture-required"] });

try {
  for (const name of cuts) {
    const t0 = Date.now();
    const FPS = Number(FPS_FLAG ?? FPS_OF[name] ?? 60);
    const file = FILE[name] ?? `agent-visualizer-${name}`;
    const page = await browser.newPage({ viewport: { width: 64, height: 64 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text()}`);
    });
    await page.goto(`http://127.0.0.1:${port}/stage.html?cut=${name}&fps=${FPS}`);
    await page.waitForFunction(() => window.__stage, null, { timeout: 20_000 });
    const info = await page.evaluate(() => window.__stage.init());
    await page.setViewportSize({ width: info.w, height: info.h });
    const cdp = await page.context().newCDPSession(page);
    console.log(`${name}: ${info.w}x${info.h} @ ${FPS} fps, ${info.duration.toFixed(2)} s, ${info.frames} frames`);
    for (const s of info.shots) console.log(`  ${s.t0.toFixed(2).padStart(6)}  ${s.name}`);

    const reviewDir = join(WORK, "review", name);
    if (REVIEW) {
      rmSync(reviewDir, { recursive: true, force: true });
      mkdirSync(reviewDir, { recursive: true });
    }
    const stillDir = STILLS_ONLY.has(name) ? OUT : join(OUT, "stills");
    mkdirSync(stillDir, { recursive: true });
    // one encoder per output, all fed the same frames
    const outputs = enc && !STILLS_ONLY.has(name)
      ? [{ file, w: info.w, h: info.h, fps: FPS, bitrate: BITRATE[name] ?? 14_000_000 }, ...(EXTRA[name] ?? []).map((o) => ({ w: info.w, h: info.h, fps: FPS, ...o }))]
      : [];
    const encoders = outputs.map((o) => {
      const video = join(WORK, `${o.file}-video.mp4`);
      const p = spawn(enc, ["video", video, String(o.w), String(o.h), String(o.fps), String(o.bitrate)], { stdio: ["pipe", "inherit", "inherit"] });
      return { ...o, video, every: Math.max(1, Math.round(FPS / o.fps)), p, done: new Promise((r, j) => p.on("exit", (c) => (c === 0 ? r() : j(new Error(`encoder exited ${c}`))))) };
    });
    const proc = encoders.length ? encoders[0].p : null;
    const reviewEvery = REVIEW ? Math.max(1, Math.round(REVIEW * FPS)) : 0;
    const stillFrames = new Map(STILLS.map((s) => [Math.round(s * FPS), String(s.toFixed(2))]));
    for (const s of info.stills ?? []) stillFrames.set(Math.round(s.t * FPS), s.name);
    const gifEvery = !REVIEW && info.gif ? info.gif.every : 0;
    const gifFrames = [];
    let last = Date.now();
    for (let i = 0; i < info.frames; i++) {
      const r = await page.evaluate((i) => window.__stage.frame(i), i);
      const t = i / FPS;
      const inRange = t >= FROM && t < TO;
      const wantReview = REVIEW && inRange && i % reviewEvery === 0;
      const wantStill = stillFrames.has(i);
      const wantGif = gifEvery && i % gifEvery === 0;
      if ((proc && inRange) || wantReview || wantStill || wantGif) {
        const shot = await cdp.send("Page.captureScreenshot", { format: "png", optimizeForSpeed: !wantStill && !wantReview && !wantGif });
        const buf = Buffer.from(shot.data, "base64");
        if (wantGif) gifFrames.push(buf);
        if (wantStill && r.clip) {
          // a crop at full resolution, straight from the compositor
          const c = r.clip;
          const cropped = await cdp.send("Page.captureScreenshot", { format: "png", clip: { x: c.x, y: c.y, width: c.w, height: c.h, scale: 1 } });
          writeFileSync(join(stillDir, `${stillFrames.get(i)}.png`), Buffer.from(cropped.data, "base64"));
          stillFrames.delete(i);
        }
        if (inRange) {
          const len = Buffer.alloc(4);
          len.writeUInt32BE(buf.length);
          for (const o of encoders) {
            if (i % o.every) continue;
            const okLen = o.p.stdin.write(len);
            if (!o.p.stdin.write(buf) || !okLen) await new Promise((ok) => o.p.stdin.once("drain", ok));
          }
        }
        for (const o of encoders) {
          if (o.poster === undefined || i !== Math.round(o.poster * FPS)) continue;
          const shot = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 88, clip: { x: 0, y: 0, width: info.w, height: info.h, scale: o.w / info.w } });
          writeFileSync(join(OUT, `${o.file}-poster.jpg`), Buffer.from(shot.data, "base64"));
        }
        if (wantReview) writeFileSync(join(reviewDir, `${t.toFixed(2).padStart(6, "0")}-${r.shot}.png`), buf);
        if (stillFrames.has(i)) {
          const n = stillFrames.get(i);
          writeFileSync(join(stillDir, /^[\d.]+$/.test(n) ? `${name}-${n}.png` : `${n}.png`), buf);
        }
      }
      if (Date.now() - last > 5000) {
        last = Date.now();
        console.log(`  frame ${i}/${info.frames}  ${r.shot}  world ${(r.world / 1000).toFixed(1)} s  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
      }
    }
    if (errors.length) console.log(`  page said:\n    ${[...new Set(errors)].slice(0, 20).join("\n    ")}`);
    if (encoders.length) {
      for (const o of encoders) o.p.stdin.end();
      await Promise.all(encoders.map((o) => o.done));
      const wav = SILENT.has(name) ? "" : await page.evaluate(() => window.__stage.audio());
      let m4a = "";
      if (wav) {
        const wavPath = join(WORK, `${name}.wav`);
        m4a = join(WORK, `${name}.m4a`);
        writeWav(wavPath, wav);
        execFileSync("afconvert", ["-f", "m4af", "-d", "aac", "-b", "192000", "-q", "127", wavPath, m4a]);
      }
      for (const o of encoders) {
        const final = join(OUT, `${o.file}.mp4`);
        if (m4a) execFileSync(enc, ["mux", o.video, m4a, final], { stdio: "inherit" });
        else execFileSync("cp", [o.video, final]);
        console.log(`${name}: ${final}  (${o.w}x${o.h} @ ${o.fps} fps, ${(statSync(final).size / 1e6).toFixed(1)} MB)`);
      }
      console.log(`${name}: rendered in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    } else if (REVIEW) {
      console.log(`${name}: review frames in ${reviewDir} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    } else {
      console.log(`${name}: stills in ${stillDir} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    }
    if (gifFrames.length) {
      const step = 1000 / (FPS / gifEvery);
      const g = encodeGif(gifFrames, join(OUT, `${file}.gif`), (k) => Math.round(((k + 1) * step) / 10) * 10 - Math.round((k * step) / 10) * 10);
      console.log(`${name}: ${join(OUT, `${file}.gif`)}  (${g.width}x${g.height}, ${g.frames} frames, ${(g.bytes / 1e6).toFixed(2)} MB)`);
    }
    await page.close();
  }
} finally {
  await browser.close();
  srv.close();
}
