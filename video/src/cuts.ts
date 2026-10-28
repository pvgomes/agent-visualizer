/*
 * The cuts: which stretches of the office to film, from where, for how long.
 * Timings sit on a 120 BPM grid (0.5 s a beat), so the cuts land on the pulse.
 */
import type { Cut } from "./stage.ts";
import { T } from "./script.ts";
import { boot, crtShot, cloud, command, end, flip, hook, interns, pose, setBack, supervise } from "./shots.ts";
import { uiApprove, uiHire, uiNeedsYou } from "./uishots.ts";
import { readme, readmeGif, stillsCut } from "./readme.ts";
import { TOUR } from "./tour.ts";

const main: Cut = {
  name: "main",
  w: 1920,
  h: 1080,
  shots: [
    hook(3.5),
    command(2.0),
    boot(5.5, { caption: "every agent session walks in from the lift" }),
    pose(1.0, { at: T.read + 600, who: "onboarding", word: "reading", color: "#ECEAE4" }),
    pose(1.0, { who: "payments", word: "typing", color: "#ECEAE4" }),
    pose(1.0, { who: "docs", word: "searching", color: "#ECEAE4" }),
    interns(2.5, { at: T.interns - 200, text: "subagents walk in as interns" }),
    supervise(1.5, { at: T.interns + 5_400 }),
    flip(4.0, { impact: 1.5 }),
    setBack(1.5, { text: "a failing test flips the table" }),
    cloud(4.0, { text: "sandboxes beam into the cloud wing" }),
    uiNeedsYou(3.0),
    uiHire(3.5),
    uiApprove(3.0),
    crtShot(3.0, { at: T.waiting + 14_000 }),
    end(4.5),
  ],
};

/** The short cuts for social: the hook, the boot, the money shot, the cloud wing, the card. */
const short = (name: string, w: number, h: number): Cut => ({
  name,
  w,
  h,
  shots: [
    hook(2.0, { line1At: 0.12, line2At: 1.0, outAt: 1.6 }),
    command(1.6, { typeAt: 0.12, enterAt: 1.25 }),
    boot(4.2, { holdTight: 1.4, caption: "every agent session walks in from the lift" }),
    flip(4.0, { impact: 1.4 }),
    setBack(1.4, { text: "a failing test flips the table" }),
    cloud(3.0, { beamAt: 0.35, text: "sandboxes beam into the cloud wing" }),
    end(3.6),
  ],
});

/** The first launch cut (feature-light); the product tour in tour.ts replaces it as "main". */
export const CUTS: Record<string, Cut> = {
  ...TOUR,
  "launch-v1": main,
  "launch-v1-vertical": short("vertical", 1080, 1920),
  readme,
  "readme-gif": readmeGif,
  stills: stillsCut,
};
