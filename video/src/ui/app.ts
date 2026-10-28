/*
 * The real web app (web/main.ts, unchanged) inside the stage's iframe. Before
 * it loads, EventSource and fetch are swapped for ones that talk to the
 * stage's Bridge instead of a server, the page is unlocked (a control token
 * in storage, as /unlock would leave), and the canvas reports the pixel ratio
 * the iframe is scaled by, so the office is drawn 1:1 with the video.
 */
import "./fakes.ts";
import "../../../web/main.ts";
