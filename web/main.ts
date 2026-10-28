/*
 * Browser entry: inject the chrome's CSS, create the canvas scene, mount the
 * chrome around it and stream the office from GET /events.
 */
import css from "./ui/styles.css";
import { createOfficeScene } from "./scene/index.ts";
import { mountChrome } from "./ui/app.ts";
import { connect } from "./ui/connection.ts";
import { eventsUrl, redeemUnlock } from "./ui/control/token.ts";
import { adoptCss } from "./ui/dom.ts";

function mountPoint(id: string): HTMLElement {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement("div");
    el.id = id;
    document.body.append(el);
  }
  return el;
}

adoptCss(css);
const scene = createOfficeScene(mountPoint("office"));
const chrome = mountChrome(mountPoint("chrome"), scene);

// Fresh from /unlock: the token first, so the very first snapshot already says "enabled". An
// unlocked browser asks for the control plane alongside /events rather than after its snapshot.
void redeemUnlock().finally(() => {
  chrome.prime();
  connect(() => eventsUrl(), {
    snapshot: (s) => chrome.load(s),
    event: (e) => chrome.apply(e),
    state: (s, retryInMs) => chrome.connection(s, retryInMs),
    control: (name, data) => chrome.control(name, data),
  });
});
