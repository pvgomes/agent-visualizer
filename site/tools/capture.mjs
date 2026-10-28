// Regenerates the page's images from the real thing, in headless Chromium:
//
//   assets/office-wide.webp       the hero office at 16:10 (shown until the live one starts, and under reduced motion)
//   assets/office-square.webp     the same at 1:1, for phones
//   assets/og.jpg                 the 1200x630 Open Graph / Twitter card, from the real hero
//   assets/shots/app-chat-*.webp  the office with a chat session and an approval open, and
//   assets/shots/hire-*.webp      the Hire dialog: both from the app's own dev harness
//                                 (web/ui/dev/dev-server.mjs --control), which this starts and stops
//
// Needs playwright-core and a Chromium, neither of them a dependency of the project:
//   npm i --no-save playwright-core && npx playwright-core install chromium
//   npm run site && node site/tools/capture.mjs [wide] [square] [og] [shots]
// The built page is served on 127.0.0.1:5039 and the dev harness on 127.0.0.1:5038 while it runs.
// CHROMIUM=/path/to/chrome overrides the browser; PLAYWRIGHT_CORE=/path/to/playwright-core the module;
// SITE_OUT=<dir> captures a build made somewhere other than site/dist.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(SITE, "..");
const DIST = resolve(process.env.SITE_OUT || join(SITE, "dist"));
const ASSETS = join(SITE, "assets");
const PORT = 5039;
const MOCK_PORT = 5038;
const jobs = new Set(process.argv.slice(2).length ? process.argv.slice(2) : ["wide", "square", "og", "shots"]);
const pageJobs = ["wide", "square", "og"].some((j) => jobs.has(j));

if (pageJobs && !existsSync(join(DIST, "index.html"))) {
  console.error("site/dist is missing: run `npm run site` first.");
  process.exit(1);
}

const { chromium } = await import(process.env.PLAYWRIGHT_CORE ? pathToFileURL(join(process.env.PLAYWRIGHT_CORE, "index.mjs")).href : "playwright-core");

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg" };
const server = createServer((req, res) => {
  let p = join(DIST, decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname));
  if (!p.startsWith(DIST)) return void res.writeHead(403).end();
  if (existsSync(p) && statSync(p).isDirectory()) p = join(p, "index.html");
  if (!existsSync(p)) return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": TYPES[extname(p)] ?? "application/octet-stream" });
  res.end(readFileSync(p));
});
if (pageJobs) await new Promise((ok) => server.listen(PORT, "127.0.0.1", ok));
const URL_ = `http://127.0.0.1:${PORT}/`;

const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}) });

/** PNG bytes -> WebP (or JPEG) bytes at `width`, resampled by Chromium's canvas. */
async function encode(png, width, type = "image/webp", quality = 0.8) {
  const page = await browser.newPage();
  const b64 = await page.evaluate(
    async ({ src, width, type, quality }) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const w = Math.min(width, img.naturalWidth);
      const h = Math.round((img.naturalHeight * w) / img.naturalWidth);
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const g = c.getContext("2d");
      g.imageSmoothingQuality = "high";
      g.drawImage(img, 0, 0, w, h);
      return c.toDataURL(type, quality).split(",")[1];
    },
    { src: `data:image/png;base64,${png.toString("base64")}`, width, type, quality },
  );
  await page.close();
  return Buffer.from(b64, "base64");
}

// the window flat and booted, so the capture is the office itself
const STILL = `.window{transform:none!important;animation:none!important}.boot{display:none!important}`;
async function officePage(viewport, dpr, css = "") {
  const page = await browser.newPage({ viewport, deviceScaleFactor: dpr, reducedMotion: "no-preference", colorScheme: "dark" });
  await page.goto(URL_);
  await page.addStyleTag({ content: STILL + css });
  await page.waitForFunction(() => window.__agentVisualizer?.running, null, { timeout: 15_000 });
  // past the opening flip and its punch-in: the whole office, everyone at a desk
  await page.waitForTimeout(10_500);
  return page;
}

if (jobs.has("wide")) {
  const page = await officePage({ width: 1440, height: 900 }, 2);
  const png = await page.locator("#office").screenshot();
  writeFileSync(join(ASSETS, "office-wide.webp"), await encode(png, 2000));
  await page.close();
  console.log("assets/office-wide.webp");
}

if (jobs.has("square")) {
  const page = await officePage({ width: 390, height: 844 }, 3);
  const png = await page.locator("#office").screenshot();
  writeFileSync(join(ASSETS, "office-square.webp"), await encode(png, 1000));
  await page.close();
  console.log("assets/office-square.webp");
}

if (jobs.has("og")) {
  // the hero, tightened to a card: the headline over the live office
  const css = `
    .nav, .badge, .sub, .ctas, .meta, .beats { display: none !important; }
    .hero { padding-top: 44px !important; }
    .hero h1 { max-width: none !important; font-size: 52px !important; }
    .journey { margin-top: 36px !important; --win-w: 1104px !important; }
    .stage { position: relative !important; top: 0 !important; }
  `;
  const page = await officePage({ width: 1200, height: 630 }, 2, css);
  await page.evaluate(() => window.scrollTo(0, 0));
  const png = await page.screenshot();
  writeFileSync(join(ASSETS, "og.jpg"), await encode(png, 1200, "image/jpeg", 0.9));
  await page.close();
  console.log("assets/og.jpg");
}

if (jobs.has("shots")) {
  // the app's dev harness: a synthetic office and the in-memory control plane, nothing real
  const out = join(tmpdir(), "agent-visualizer-site-shots");
  rmSync(out, { recursive: true, force: true });
  const mock = spawn(process.execPath, [join(ROOT, "web/ui/dev/dev-server.mjs"), "--out", out, "--port", String(MOCK_PORT), "--scenario", "busy", "--control", "--seed", "7"], { stdio: "ignore" });
  try {
    const url = `http://127.0.0.1:${MOCK_PORT}/`;
    for (let i = 0; ; i++) {
      if (i > 120) throw new Error("the dev harness didn't start");
      if (await fetch(url).then((r) => r.ok, () => false)) break;
      await new Promise((ok) => setTimeout(ok, 250));
    }
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "dark" });
    await page.goto(url);
    await page.waitForTimeout(2500);
    // hire Claude Code in chat mode with a first prompt
    await page.keyboard.press("n");
    await page.waitForTimeout(600);
    await page.click(".hire-agent[data-agent=claude]");
    await page.click('.hire-mode[data-mode="chat"]');
    await page.fill(".hire-prompt", "add retries to the ledger client");
    await page.waitForTimeout(300);
    const hire = await page.locator(".hire").screenshot();
    await page.click(".hire .btn-primary");
    // let the first turn finish, then ask for something that needs an approval
    await page.waitForSelector(".chat-empty:not([hidden]) .starter, .turn", { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await page.waitForFunction(() => !document.querySelector(".turn.is-live") && document.querySelector(".ses-pill")?.dataset.tone === "ok", null, { timeout: 90_000 });
    await page.waitForTimeout(800);
    await page.fill(".ses-input", "clean the build and push a preview");
    await page.press(".ses-input", "Enter");
    await page.waitForSelector(".apcard.is-actionable", { timeout: 30_000 });
    await page.waitForTimeout(900);
    await page.mouse.move(5, 5);
    const chat = await page.screenshot();
    await page.close();
    mkdirSync(join(ASSETS, "shots"), { recursive: true });
    for (const w of [1280, 2000]) writeFileSync(join(ASSETS, "shots", `app-chat-${w}.webp`), await encode(chat, w, "image/webp", 0.82));
    for (const w of [560, 900]) writeFileSync(join(ASSETS, "shots", `hire-${w}.webp`), await encode(hire, w, "image/webp", 0.84));
    console.log("assets/shots/app-chat-{1280,2000}.webp, assets/shots/hire-{560,900}.webp");
  } finally {
    mock.kill();
    rmSync(out, { recursive: true, force: true });
  }
}

await browser.close();
if (pageJobs) server.close();
