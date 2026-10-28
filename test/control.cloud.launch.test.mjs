// Tests for the remote launch pieces under src/control/cloud: the launch line (quoting, {env}
// references, "~" folders, PATH, the env file sourced and deleted before the agent starts, the pid
// file and stopScript), the env-file writers (from a variable, stdin, a heredoc with an awkward
// value), the agent probe and install plans, first-run seeding that never overwrites, and the
// Codex provider flags. Every line is run for real with sh under a scratch HOME; keys are dummies.
import nodeTest from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { load, runIn, tmp, writeBin } from "./remote.fakes.mjs";
import { CONTROL, skipAll } from "./platform.mjs";

const test = skipAll(nodeTest, CONTROL);

const M = await load("src/control/cloud/launch.ts", "src/control/cloud/install.ts", "src/control/cloud/firstrun.ts", "src/control/cloud/place.ts");

const AGENT = `const fs = require("fs");
const out = { argv: process.argv.slice(2), cwd: process.cwd(), key: process.env.ANTHROPIC_API_KEY ?? null, prompt: process.env.AO_PROMPT ?? null, path0: (process.env.PATH || "").split(":")[0], files: fs.existsSync(process.env.HOME + "/.agent-visualizer/run") ? fs.readdirSync(process.env.HOME + "/.agent-visualizer/run") : [] };
process.stdout.write(JSON.stringify(out));`;

const AWKWARD = `it's "quoted" $HOME \`id\` $(id)\nsecond line; rm -rf /`;

test("the launch line quotes literals, renders {env} as \"$N\", and starts in a ~ folder", async () => {
  const home = tmp();
  mkdirSync(join(home, "my repo"), { recursive: true });
  writeBin(join(home, "bin"), "fake-agent", AGENT);
  const launch = { argv: ["fake-agent", "--flag", "a b", "it's", { env: "AO_PROMPT" }], cwd: "~/my repo", env: {}, secret: [], path: ["~/bin"] };
  const line = M.launchLine(launch, { sid: "s1" });
  assert.ok(line.startsWith(" "), "a leading space keeps it out of history");
  assert.match(line, /"\$AO_PROMPT"/);
  assert.doesNotMatch(line, /umask/, "the agent keeps the user's umask");
  const r = await runIn(home, "sh", ["-c", `${M.envLines({ AO_PROMPT: AWKWARD })}${line}`]);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.argv, ["--flag", "a b", "it's", AWKWARD]);
  assert.equal(out.cwd.endsWith("/my repo"), true);
  assert.equal(out.path0, join(home, "bin"));
  assert.throws(() => M.launchLine({ ...launch, cwd: "relative/dir" }, { sid: "s1" }), /absolute/);
  assert.throws(() => M.launchLine({ ...launch, argv: [{ env: "BAD NAME" }] }, { sid: "s1" }), /bad env reference/);
  assert.throws(() => M.runFile("../x", "env"), /bad session id/);
});

test("env file: written 0600 from one command's variable, sourced and deleted before the agent runs", async () => {
  const home = tmp();
  writeBin(join(home, "bin"), "fake-agent", AGENT);
  const env = { ANTHROPIC_API_KEY: "sk-ant-dummy-0000", AO_PROMPT: AWKWARD };
  const lines = M.envLines(env);
  assert.match(lines, /^ANTHROPIC_API_KEY='sk-ant-dummy-0000'; export ANTHROPIC_API_KEY$/m);
  const w = await runIn(home, "env", [`AO_ENV=${lines}`, "sh", "-c", M.envFromVarScript("s2")]);
  assert.equal(w.code, 0, w.stderr);
  const file = join(home, ".agent-visualizer/run/s2.env");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(home, ".agent-visualizer/run")).mode & 0o077, 0, "the run folder is private too");
  const launch = { argv: ["fake-agent", { env: "AO_PROMPT" }], cwd: "~", env, secret: ["ANTHROPIC_API_KEY"], path: ["~/bin"] };
  const line = M.launchLine(launch, { sid: "s2", envFile: true, pidFile: true });
  assert.ok(!line.includes("sk-ant-dummy"), "no value in the line");
  const r = await runIn(home, "sh", ["-c", line]);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.key, "sk-ant-dummy-0000");
  assert.equal(out.prompt, AWKWARD);
  assert.deepEqual(out.argv, [AWKWARD]);
  assert.deepEqual(out.files, ["s2.pid"], "the env file is gone before the agent starts; the pid file stays");
  // A missing env file stops the launch rather than starting an agent without its keys.
  const miss = await runIn(home, "sh", ["-c", M.launchLine(launch, { sid: "nope", envFile: true })]);
  assert.equal(miss.code, 97);
  assert.match(miss.stderr, /environment file is missing/);
});

test("env file over stdin and as a heredoc inside a script; the heredoc delimiter never collides", async () => {
  const home = tmp();
  const env = { K1: "v1", K2: AWKWARD, K3: "AO_EOF_fixed" };
  const a = await runIn(home, "sh", ["-c", M.envFromStdinScript("s3")], M.envLines(env));
  assert.equal(a.code, 0, a.stderr);
  const script = M.envHeredocScript("s4", env, () => "fixed");
  // "AO_EOF_fixed" is a value, but the delimiter must be a whole line of its own: no clash.
  const b = await runIn(home, "sh", ["-s"], script);
  assert.equal(b.code, 0, b.stderr);
  for (const sid of ["s3", "s4"]) {
    const r = await runIn(home, "sh", ["-c", `. "$HOME/.agent-visualizer/run/${sid}.env"; printf '%s|%s|%s' "$K1" "$K2" "$K3"`]);
    assert.equal(r.stdout, `v1|${AWKWARD}|AO_EOF_fixed`);
  }
  // A value line equal to the candidate delimiter forces another pick.
  let n = 0;
  const s = M.envHeredocScript("s6", { X: "1\nAO_EOF_a\n2" }, () => (n++ === 0 ? "a" : "b"));
  assert.ok(s.includes("<<'AO_EOF_b'"), "picked a delimiter that isn't a line of the content");
  assert.throws(() => M.envLines({ "bad-name": "x" }), /bad environment name/);
});

test("stopScript signals the pid the launch recorded; cleanupScript removes leftovers", async () => {
  const home = tmp();
  mkdirSync(join(home, ".agent-visualizer/run"), { recursive: true });
  const launch = { argv: ["sleep", "30"], cwd: "~", env: {}, secret: [] };
  const { spawn } = await import("node:child_process");
  const child = spawn("sh", ["-c", M.launchLine(launch, { sid: "s7", pidFile: true })], { env: { PATH: process.env.PATH, HOME: home } });
  const exited = new Promise((r) => child.on("exit", (code, sig) => r(sig)));
  for (let i = 0; i < 50 && !existsSync(join(home, ".agent-visualizer/run/s7.pid")); i++) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 50));
  const r = await runIn(home, "sh", ["-c", M.stopScript("s7", "TERM")]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(await exited, "SIGTERM");
  writeFileSync(join(home, ".agent-visualizer/run/s8.env"), "X=1");
  await runIn(home, "sh", ["-c", M.cleanupScript("s8")]);
  assert.equal(existsSync(join(home, ".agent-visualizer/run/s8.env")), false);
  // A pid file holding something that isn't a number is ignored.
  writeFileSync(join(home, ".agent-visualizer/run/s9.pid"), "1; touch /tmp/x");
  assert.equal((await runIn(home, "sh", ["-c", M.stopScript("s9")])).code, 0);
});

test("cwdScript resolves a folder, creates one only for office sandboxes, and reports a missing one", async () => {
  const home = tmp();
  const r = await runIn(home, "sh", ["-c", M.cwdScript(undefined, false)]);
  assert.equal(M.parseCwd(r.stdout, undefined, "box"), (await runIn(home, "sh", ["-c", "cd ~ && pwd -P"])).stdout.trim());
  const miss = await runIn(home, "sh", ["-c", M.cwdScript("~/nope", false)]);
  assert.throws(() => M.parseCwd(miss.stdout, "~/nope", "box"), /No folder ~\/nope on box/);
  const made = await runIn(home, "sh", ["-c", M.cwdScript("~/work/x", true)]);
  assert.ok(M.parseCwd(made.stdout, "~/work/x", "box").endsWith("/work/x"));
});

test("probe finds the agent (Cursor's bare `agent` only if it is Cursor's), node and npm", async () => {
  const home = tmp();
  writeBin(join(home, ".local/bin"), "claude", `console.log("2.1.302 (Claude Code)")`);
  const r = await runIn(home, "sh", ["-c", M.probeScript("claude")]);
  const p = M.parseProbe(r.stdout);
  assert.equal(p.bin, "claude");
  assert.equal(p.version, "2.1.302");
  assert.equal(p.binPath, join(home, ".local/bin/claude"));
  assert.equal(p.node, Number(process.versions.node.split(".")[0]));
  writeBin(join(home, ".local/bin"), "agent", `console.log("1.0.0")`);
  assert.equal(M.parseProbe((await runIn(home, "sh", ["-c", M.probeScript("cursor")])).stdout).bin, undefined, "an unrelated `agent` is not Cursor");
  writeBin(join(home, ".local/share/cursor-agent"), "agent", `console.log("2026.10.16")`);
  const { symlinkSync, rmSync } = await import("node:fs");
  rmSync(join(home, ".local/bin/agent"));
  symlinkSync(join(home, ".local/share/cursor-agent/agent"), join(home, ".local/bin/agent"));
  assert.equal(M.parseProbe((await runIn(home, "sh", ["-c", M.probeScript("cursor")])).stdout).bin, "agent");
});

test("install plans follow AGENT_FACTS: npm with a new enough Node, scripts otherwise, a clear refusal else", () => {
  const p = (x) => ({ npm: true, curl: true, node: 22, ...x });
  assert.equal(M.installPlan("gemini", p({})).how, "npm i -g @google/gemini-cli");
  assert.match(M.installPlan("gemini", p({})).script, /--prefix "\$HOME\/.local"/, "falls back to a user prefix");
  assert.equal(M.installPlan("claude", p({ node: 18 })).how, "curl claude.ai/install.sh | bash");
  assert.equal(M.installPlan("droid", p({})).how, "curl app.factory.ai/cli | sh");
  assert.equal(M.installPlan("cursor", p({})).how, "curl cursor.com/install | bash");
  assert.doesNotMatch(M.installPlan("cursor", p({})).script, /npm i -g cursor-agent/);
  assert.throws(() => M.installPlan("gemini", p({ node: 18 })), /Gemini CLI needs Node 20\+ in this sandbox \(it has 18\)/);
  assert.throws(() => M.installPlan("qwen", p({ node: undefined, npm: false })), /needs Node 22\+ in this sandbox \(it has none\)/);
  assert.throws(() => M.installPlan("cursor", p({ curl: false })), /needs curl/);
});

test("ensureAgent installs a missing npm agent with a fake npm, then finds it", async () => {
  const home = tmp();
  writeBin(join(home, "fakebin"), "npm", `const fs = require("fs"); const a = process.argv.slice(2);
if (a[0] === "-v") { console.log("10.0.0"); process.exit(0); }
if (!a.includes("--prefix")) { console.error("npm error code EACCES"); process.exit(243); }
const dir = a[a.indexOf("--prefix") + 1] + "/bin"; fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(dir + "/gemini", "#!/bin/sh\\necho 0.64.0\\n", { mode: 0o755 });`);
  const run = async (script) => {
    const r = await runIn(home, "env", [`PATH=${join(home, "fakebin")}:${process.env.PATH}`, "sh", "-c", script]);
    if (r.code !== 0) throw new Error(`exit ${r.code}: ${r.stderr.trim().split("\n").pop()}`);
    return r.stdout;
  };
  const steps = [];
  const got = await M.ensureAgent("gemini", run, (s, d) => steps.push([s, d]), "ssh box");
  assert.deepEqual(steps, [["installing", "Installing Gemini CLI (npm i -g @google/gemini-cli)…"]]);
  assert.deepEqual(got, { bin: "gemini", version: "0.64.0", path: [join(home, ".local/bin")] });
  // Already there: no install.
  steps.length = 0;
  await M.ensureAgent("gemini", run, (s, d) => steps.push([s, d]), "ssh box");
  assert.equal(steps.length, 0);
  // A failing install says where and why.
  writeBin(join(home, "fakebin"), "npm", `if (process.argv[2] === "-v") { console.log("10"); process.exit(0); } console.error("npm error network ETIMEDOUT"); process.exit(1);`);
  await assert.rejects(M.ensureAgent("qwen", run, () => {}, "Daytona box"), /Installing Qwen Code failed on Daytona box: .*ETIMEDOUT/);
});

test("first-run seeding writes only what is absent, and never touches what the user set", async () => {
  const home = tmp();
  const cwd = "/home/u/my \"repo\"";
  assert.equal((await runIn(home, "sh", ["-c", M.claudeScript(cwd)])).code, 0);
  const cj = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
  assert.deepEqual(cj, { hasCompletedOnboarding: true, projects: { [cwd]: { hasTrustDialogAccepted: true } } });
  assert.equal(statSync(join(home, ".claude.json")).mode & 0o777, 0o600);
  // Existing file: only missing keys are added (with node), the user's values stay.
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: false, theme: "dark", projects: { "/other": { x: 1 } } }));
  assert.equal((await runIn(home, "sh", ["-c", M.claudeScript(cwd)])).code, 0);
  const merged = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
  assert.equal(merged.hasCompletedOnboarding, false);
  assert.equal(merged.theme, "dark");
  assert.deepEqual(merged.projects["/other"], { x: 1 });
  assert.equal(merged.projects[cwd].hasTrustDialogAccepted, true);

  await runIn(home, "sh", ["-c", M.codexScript(cwd)]);
  await runIn(home, "sh", ["-c", M.codexScript(cwd)]);
  const toml = readFileSync(join(home, ".codex/config.toml"), "utf8");
  assert.equal(toml.split("[projects.").length - 1, 1, "appended once");
  assert.ok(toml.includes(`[projects."/home/u/my \\"repo\\""]\ntrust_level = "trusted"`));

  mkdirSync(join(home, ".gemini"), { recursive: true });
  writeFileSync(join(home, ".gemini/settings.json"), '{"mine":true}');
  await runIn(home, "sh", ["-c", M.geminiScript()]);
  assert.equal(readFileSync(join(home, ".gemini/settings.json"), "utf8"), '{"mine":true}');
});

test("Codex with an OpenAI key gets the provider flags right after its bin; others are untouched", () => {
  const base = { argv: ["codex", "-c", "check_for_update_on_startup=false", { env: "AO_PROMPT" }], cwd: "~", env: { OPENAI_API_KEY: "sk-dummy" }, secret: ["OPENAI_API_KEY"] };
  const l = M.adjustLaunch("codex", base);
  assert.deepEqual(l.argv.slice(0, 5), ["codex", ...M.CODEX_PROVIDER_ARGS]);
  assert.ok(!JSON.stringify(l.argv).includes("sk-dummy"));
  assert.deepEqual(M.adjustLaunch("codex", { ...base, env: {} }).argv, base.argv);
  assert.deepEqual(M.adjustLaunch("claude", base).argv, base.argv);
});

test("sandbox names start agent-visualizer-; the registry file is 0600 and survives a reload", async () => {
  assert.match(M.sandboxName(), /^agent-visualizer-[0-9a-f]{6}$/);
  assert.equal(M.sandboxName("My Box!"), "agent-visualizer-my-box");
  assert.equal(M.sandboxName("agent-visualizer-x"), "agent-visualizer-x");
  const home = join(tmp(), "ao");
  const reg = new M.Registry(home);
  reg.add({ provider: "railway", id: "r1", name: "agent-visualizer-a", createdAt: "2026-10-18T00:00:00.000Z", environmentId: "e1", projectId: "p1" });
  reg.add({ provider: "daytona", id: "d1", name: "agent-visualizer-b", createdAt: "2026-10-18T00:00:00.000Z" });
  assert.equal(statSync(join(home, "sandboxes.json")).mode & 0o777, 0o600);
  assert.equal(statSync(home).mode & 0o777, 0o700);
  const again = new M.Registry(home);
  assert.deepEqual(again.list("railway").map((r) => r.id), ["r1"]);
  again.remove("railway", "r1");
  assert.deepEqual(new M.Registry(home).list().map((r) => r.id), ["d1"]);
});
