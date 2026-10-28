/*
 * GET /api/control/install and POST /api/control/install: the same
 * installer `agent-visualizer install` runs (MCP server + skill in every agent
 * on this machine), as a dry-run plan the page shows and an apply the page
 * confirms. The CLI's output is unchanged; the page reads the plan through
 * the installer's report hook. Under the service the registered command is
 * node + app/current/dist/cli.js, so an upgrade doesn't break it; from an
 * npx cache it is the pinned npx form, refused unless that version is on npm.
 */
import type { AgentKind } from "../shared/events.ts";
import type { InstallPlan } from "../shared/control.ts";
import { chooseLaunch, npmHasVersion, npxPackage } from "../install/command.ts";
import { install, type PlanRow } from "../install/installer.ts";
import { localSys, type Sys } from "../install/sys.ts";

export interface InstallApiDeps {
  version: string;
  /** The CLI script agents should launch (the service passes app/current/dist/cli.js). */
  script?: string;
  sys?: () => Sys;
  npmHasVersion?: (version: string) => Promise<boolean | null>;
}

const quiet = () => {};

export function createInstallApi(d: InstallApiDeps): { plan(): Promise<InstallPlan>; apply(agents?: AgentKind[]): Promise<InstallPlan> } {
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  async function rows(apply: boolean, agents?: AgentKind[]): Promise<PlanRow[]> {
    const launch = chooseLaunch({ remote: false, version: d.version, script: d.script });
    let blocked: string | undefined;
    if (launch.how === "npx") {
      const ok = await (d.npmHasVersion ?? npmHasVersion)(d.version);
      if (ok !== true) blocked = ok === false ? `${npxPackage(d.version)} isn't on npm yet, so agents couldn't launch the office tools.` : "Couldn't check npm for this version (no network?).";
    }
    let got: PlanRow[] = [];
    const sys = (d.sys ?? (() => localSys()))();
    await install(sys, { dryRun: !apply || !!blocked, yes: true, agents, launch, out: quiet, report: (r) => (got = r) });
    if (blocked) got = got.map((r) => (r.found && (r.mcp === "add" || r.mcp === "update") ? { ...r, error: blocked } : r));
    return got;
  }

  return {
    plan: () => serial(async () => ({ applied: false, agents: await rows(false) })),
    apply: (agents) =>
      serial(async () => {
        const planned = await rows(false, agents);
        await rows(true, agents);
        // What is in place now; anything that should have changed and didn't says so.
        const after = await rows(false, agents);
        const wanted = new Set(agents ?? planned.filter((r) => r.found).map((r) => r.agent));
        return {
          applied: true,
          agents: after.map((r) => {
            const before = planned.find((p) => p.agent === r.agent);
            const meant = wanted.has(r.agent) && before && (before.mcp === "add" || before.mcp === "update" || before.skill === "add" || before.skill === "update");
            const stuck = meant && (r.mcp === "add" || r.mcp === "update" || r.skill === "add" || r.skill === "update");
            return stuck && !r.error ? { ...r, error: "Didn't apply; run agent-visualizer doctor to see why." } : r;
          }),
        };
      }),
  };
}
