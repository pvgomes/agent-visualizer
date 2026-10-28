// Bundles the CLI for node and the web app for the browser into dist/.
//
// The web app is split: the office and its chrome load first (app-<hash>.js and the chunks it
// imports), and the terminal (xterm.js), chat, Hire and Settings code arrive as their own chunks
// when the page asks for them (on hover, on idle, on first use). Every name carries a content
// hash, so the server can let the browser keep them for good; index.html, which names them, is
// revalidated on every load. Each script also gets a .br and a .gz copy the server can send as is.
import { build, transform } from "esbuild";
import { cpSync, mkdirSync, rmSync, chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/web/assets", { recursive: true });

await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  // The PTY library is an optionalDependency with a native binary per platform: loaded at runtime, never inlined.
  external: ["@lydell/node-pty"],
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "warning",
});
chmodSync("dist/cli.js", 0o755);

// The session terminals' headless screens run in a worker thread next to the CLI (src/control/term-worker.ts, dist/term-worker.mjs).
await build({
  entryPoints: ["src/control/term-worker.ts"],
  outfile: "dist/term-worker.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  logLevel: "warning",
});

/** CSS is imported as text (adopted as a constructed stylesheet): minified on the way in. */
const cssText = {
  name: "css-text",
  setup(b) {
    b.onLoad({ filter: /\.css$/ }, async (a) => ({ contents: (await transform(readFileSync(a.path, "utf8"), { loader: "css", minify: true })).code, loader: "text" }));
  },
};

const web = await build({
  entryPoints: { app: "web/main.ts" },
  outdir: "dist/web/assets",
  entryNames: "[name]-[hash]",
  chunkNames: "[name]-[hash]",
  bundle: true,
  splitting: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  minify: true,
  metafile: true,
  loader: { ".svg": "text" },
  plugins: [cssText],
  logLevel: "warning",
});

// index.html names the hashed entry, and preloads the chunks it imports so they load alongside it.
const outputs = Object.entries(web.metafile.outputs);
const [entryPath, entry] = outputs.find(([, o]) => o.entryPoint === "web/main.ts");
const url = (p) => `/assets/${basename(p)}`;
const preload = [...new Set(entry.imports.filter((i) => i.kind === "import-statement").map((i) => i.path))];
let html = readFileSync("web/index.html", "utf8");
if (!html.includes('src="/assets/app.js"')) throw new Error("web/index.html: expected <script type=\"module\" src=\"/assets/app.js\">");
html = html.replace(
  /( *)<script type="module" src="\/assets\/app\.js"><\/script>/,
  (_, sp) => [...preload.map((p) => `${sp}<link rel="modulepreload" href="${url(p)}" />`), `${sp}<script type="module" src="${url(entryPath)}"></script>`].join("\n"),
);
writeFileSync("dist/web/index.html", html);
if (existsSync("assets")) cpSync("assets", "dist/web/assets", { recursive: true });

// Precompressed copies, served when the browser accepts them (src/server/static.ts).
for (const name of readdirSync("dist/web/assets")) {
  if (!/\.(js|css|svg)$/.test(name)) continue;
  const file = join("dist/web/assets", name);
  const data = readFileSync(file);
  if (data.length < 1024) continue;
  writeFileSync(`${file}.br`, brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } }));
  writeFileSync(`${file}.gz`, gzipSync(data, { level: 9 }));
}
