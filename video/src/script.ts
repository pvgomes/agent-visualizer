/*
 * What happens in the office, in world time (ms). One script for every cut:
 * the cuts only choose which stretches of it to film and from where. Every
 * project, file, command and model comes from the demo cast (src/demo/cast.ts).
 */
import { MOODS } from "../../src/demo/cast.ts";
import type { World } from "./world.ts";

/** World ms of each beat. */
export const T = {
  /** first worker out of the lift; the rest follow every `gap` */
  arrive: 300,
  gap: 520,
  /** the three poses: read, edit, search (each held ~3s) */
  read: 19_400,
  edit: 19_400,
  search: 19_400,
  /** the hero hands work to three interns */
  interns: 29_000,
  /** the hero's tests fail: the flip's t0 */
  flip: 58_000,
  /** first sandbox worker walks into the cloud-room (the room appears) */
  cloud: 71_000,
  cloudGap: 160,
  /** a hand goes up: the amber "needs you" */
  waiting: 81_500,
  /** the README demo's stretch of the world starts here (after everything the launch video films) */
  readme: 104_000,
  readmeIntern: 117_900,
  readmeFlip: 121_300,
};

export function script(w: World) {
  // The opening cast, Claude Code and Cursor, in the order they walk out of the lift.
  const cast: [string, Parameters<World["persona"]>][] = [
    ["hero", ["claude", "api-gateway"]],
    ["payments", ["cursor", "payments-svc"]],
    ["onboarding", ["cursor", "Onboarding", undefined, 1]],
    ["portfolio", ["claude", "portfolio", undefined, 1]],
    ["docs", ["cursor", "docs-site", undefined, 1]],
    ["ga", ["cursor", "GA-task"]],
    ["etl", ["claude", "data-etl"]],
    ["auth", ["claude", "auth-svc", undefined, 1]],
  ];
  cast.forEach(([name, args], i) => w.hire(name, w.persona(...args), T.arrive + i * T.gap, 6_000 + (i % 3) * 900));

  w.status("hero", 9_000, MOODS[0]!);

  // Three poses for the montage, held for the length of their shots.
  w.pose("onboarding", T.read - 600, "read", "Read train.py", T.read + 4_000);
  w.pose("payments", T.edit - 600, "edit", "Edit ledger.go", T.edit + 4_000);
  w.pose("docs", T.search - 600, "search", "Search *.mdx", T.search + 4_000);

  // Delegation: three interns walk in, the boss leans back.
  w.interns("hero", T.interns, ["Explore", "general-purpose", "Plan"], 11_000);
  w.resume("hero", T.interns + 17_500);

  // The money shot.
  w.flip("hero", T.flip);
  w.pass("hero", T.flip + 9_500);
  w.resume("hero", T.flip + 12_000);

  // The cloud-room: devops and website on Vercel, incidents-check on Railway.
  w.hire("devops", w.persona("claude", "search-api", "devops"), T.cloud, 3_200);
  w.hire("website", w.persona("cursor", "chat-bot", "website"), T.cloud + T.cloudGap, 3_200);
  w.hire("incidents", w.persona("cursor", "incidents-check", "incidents-check", 1), T.cloud + T.cloudGap * 2, 3_200);
  w.status("incidents", T.cloud + 6_000, MOODS[4]!);

  // Somebody finishes and waits on you; you answer after the click.
  w.waiting("payments", T.waiting, 60_000);
  w.resume("payments", T.waiting + 9_000);

  // The README demo: an intern, then the flip, while the app is on screen.
  w.interns("hero", T.readmeIntern, ["Explore"], 5_000);
  w.flip("hero", T.readmeFlip);
  w.pass("hero", T.readmeFlip + 9_000);
  w.resume("hero", T.readmeFlip + 11_000);
}

/** World ms of the tour's beats (the product-tour cuts in tour.ts). */
export const TT = {
  arrive: 300,
  gap: 520,
  /** reading, typing, searching */
  poses: 19_400,
  interns: 26_000,
  /** a hand goes up: "needs you" */
  waiting: 37_500,
  /** the hero's tests fail: the flip's t0 */
  flip: 49_000,
  /** the agents talk back over MCP: a shout, confetti, a table flipped on purpose */
  mcp: 124_600,
  /** "Edit auth.ts": the label the privacy beat shows */
  privacy: 129_000,
};

/** The tour's office. Command Code is the first one out of the lift. */
export function tourScript(w: World) {
  const cast: [string, Parameters<World["persona"]>][] = [
    ["cc", ["commandcode", "portfolio"]],
    ["hero", ["claude", "api-gateway"]],
    ["codex", ["codex", "payments-svc"]],
    ["gemini", ["gemini", "Onboarding"]],
    ["opencode", ["opencode", "docs-site"]],
    ["cursor", ["cursor", "GA-task"]],
    ["qwen", ["qwen", "data-etl"]],
    ["droid", ["droid", "auth-svc"]],
  ];
  cast.forEach(([name, args], i) => w.hire(name, w.persona(...args), TT.arrive + i * TT.gap, 6_000 + (i % 3) * 900));
  w.status("hero", 9_000, MOODS[0]!);

  w.pose("gemini", TT.poses - 600, "read", "Read train.py", TT.poses + 4_000);
  w.pose("cc", TT.poses - 600, "edit", "Edit Hero.tsx", TT.poses + 4_000);
  w.pose("opencode", TT.poses - 600, "search", "Search *.mdx", TT.poses + 4_000);

  w.interns("hero", TT.interns, ["Explore", "general-purpose", "Plan"], 11_000);
  w.resume("hero", TT.interns + 17_000);

  w.waiting("codex", TT.waiting, 40_000);
  w.resume("codex", TT.waiting + 6_000);

  w.flip("hero", TT.flip);
  w.pass("hero", TT.flip + 9_500);
  w.resume("hero", TT.flip + 12_000);

  // Over MCP: Command Code shouts and asks for confetti; Gemini flips its own table, in its own words.
  w.shout("cc", TT.mcp, "shipped v2 🚀");
  w.celebrate("cc", TT.mcp + 600);
  w.selfFlip("gemini", TT.mcp + 2_200, "this cache is haunted");

  w.pose("hero", TT.privacy - 400, "edit", "Edit auth.ts", TT.privacy + 6_000);
}

/** World ms of the product tour's beats, in the order the tour films them. */
export const TV = {
  arrive: 300,
  gap: 520,
  /** the app opens and the hire starts (after the boot) */
  app: 8_500,
  /** the "and also" montage, after the centrepiece */
  interns: 106_000,
  waiting: 118_000,
  flip: 130_000,
  mcp: 142_000,
  privacy: 152_000,
};

/** The tour's office: Command Code first out of the lift; the montage's beats after the centrepiece. */
export function tourScript2(w: World) {
  const cast: [string, Parameters<World["persona"]>][] = [
    ["cc", ["commandcode", "portfolio"]],
    ["hero", ["claude", "api-gateway"]],
    ["codex", ["codex", "payments-svc"]],
    ["gemini", ["gemini", "Onboarding"]],
    ["opencode", ["opencode", "docs-site"]],
    ["cursor", ["cursor", "GA-task"]],
    ["qwen", ["qwen", "data-etl"]],
    ["droid", ["droid", "auth-svc"]],
  ];
  cast.forEach(([name, args], i) => w.hire(name, w.persona(...args), TV.arrive + i * TV.gap, 6_000 + (i % 3) * 900));
  w.status("hero", 9_000, MOODS[0]!);

  w.interns("hero", TV.interns, ["Explore", "general-purpose", "Plan"], 11_000);
  w.resume("hero", TV.interns + 17_000);

  w.waiting("codex", TV.waiting, 30_000);
  w.resume("codex", TV.waiting + 8_000);

  w.flip("hero", TV.flip);
  w.pass("hero", TV.flip + 9_500);
  w.resume("hero", TV.flip + 12_000);

  w.shout("cc", TV.mcp, "shipped v2 🚀");
  w.celebrate("cc", TV.mcp + 900);

  w.pose("hero", TV.privacy - 400, "edit", "Edit auth.ts", TV.privacy + 6_000);
}
