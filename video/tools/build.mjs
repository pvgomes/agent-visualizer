// Bundles the stage (video/src/stage.ts) and the real web app wired to it (video/src/ui/app.ts)
// for the browser. Node built-ins resolve to video/src/shims/node.ts; nothing in web/ or src/ is changed.
//
//   node tools/build.mjs [--work <dir>]
import { build } from "esbuild";
import { copyFileSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const VIDEO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(VIDEO, "..");

const nodeShim = {
  name: "node-shim",
  setup(b) {
    b.onResolve({ filter: /^node:/ }, () => ({ path: join(VIDEO, "src/shims/node.ts") }));
  },
};

const STAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>agent-visualizer: launch video</title>
<style>
html,body{margin:0;background:#000;overflow:hidden}
#stage,#over{position:absolute;left:0;top:0}
#office{position:absolute;left:0;top:0;visibility:hidden}
#app{position:absolute;left:0;top:0;border:0;transform-origin:0 0;display:none;background:#060608}
</style>
<script src="vt.js"></script>
</head><body>
<canvas id="stage"></canvas><div id="office"></div><iframe id="app" title="agent-visualizer"></iframe><canvas id="over"></canvas>
<script type="module" src="stage.js"></script>
</body></html>
`;

const APP_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="color-scheme" content="dark">
<title>agent-visualizer</title>
<script>parent.__vt.install(window)</script>
<script type="module" src="app.js"></script>
</head><body>
<main id="office" aria-label="The office"></main>
<div id="chrome"></div>
</body></html>
`;

export async function buildVideo(work) {
  const out = join(work, "site");
  mkdirSync(out, { recursive: true });
  const common = {
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    sourcemap: "inline",
    loader: { ".svg": "text", ".css": "text" },
    plugins: [nodeShim],
    logLevel: "warning",
    absWorkingDir: ROOT,
  };
  await build({ ...common, entryPoints: [join(VIDEO, "src/stage.ts")], outfile: join(out, "stage.js") });
  await build({ ...common, entryPoints: [join(VIDEO, "src/ui/app.ts")], outfile: join(out, "app.js") });
  copyFileSync(join(VIDEO, "src/vt.js"), join(out, "vt.js"));
  cpSync(join(VIDEO, "src/fonts"), join(out, "fonts"), { recursive: true });
  writeFileSync(join(out, "stage.html"), STAGE_HTML);
  writeFileSync(join(out, "app.html"), APP_HTML);
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--work");
  const work = i > 0 ? resolve(process.argv[i + 1]) : join(tmpdir(), "agent-visualizer-video");
  console.log("built", await buildVideo(work));
}
