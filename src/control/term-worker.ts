/*
 * The terminal worker: every hired terminal session's headless screen
 * (term-screen.ts), in one worker thread beside the office (dist/term-worker.mjs,
 * started by term.ts). The office posts PTY bytes in; replies to the agent's
 * terminal queries, bracketed-paste changes and snapshots come back. Messages:
 *
 *   in   {t:"new", id, cols, rows, scrollback}  {t:"w", id, d, seq}  {t:"rs", id, cols, rows}
 *        {t:"snap", id, req, kinds}  {t:"text", id, req, unwrap}  {t:"del", id}
 *   out  {t:"reply", id, d}  {t:"modes", id, bp}  {t:"snap", req, kind, data, upTo}  {t:"text", req, text}
 */
import { parentPort } from "node:worker_threads";
import { HeadlessScreen, type SnapshotKind } from "./term-screen.ts";

export type WorkerIn =
  | { t: "new"; id: number; cols: number; rows: number; scrollback: number }
  | { t: "w"; id: number; d: Uint8Array; seq: number }
  | { t: "rs"; id: number; cols: number; rows: number }
  | { t: "snap"; id: number; req: number; kinds: SnapshotKind[] }
  | { t: "text"; id: number; req: number; unwrap: boolean }
  | { t: "del"; id: number };

export type WorkerOut =
  | { t: "reply"; id: number; d: string }
  | { t: "modes"; id: number; bp: boolean }
  | { t: "snap"; req: number; kind: SnapshotKind; data: string; upTo: number }
  | { t: "text"; req: number; text: string };

const port = parentPort;
if (port) {
  const screens = new Map<number, HeadlessScreen>();
  const post = (m: WorkerOut) => port.postMessage(m);
  port.on("message", (m: WorkerIn) => {
    const s = screens.get(m.id);
    switch (m.t) {
      case "new":
        screens.get(m.id)?.dispose();
        screens.set(m.id, new HeadlessScreen({
          cols: m.cols,
          rows: m.rows,
          scrollback: m.scrollback,
          reply: (d) => post({ t: "reply", id: m.id, d }),
          modes: (bp) => post({ t: "modes", id: m.id, bp }),
        }));
        break;
      case "w":
        s?.write(m.d, m.seq);
        break;
      case "rs":
        s?.resize(m.cols, m.rows);
        break;
      case "snap":
        if (!s) {
          for (const kind of m.kinds) post({ t: "snap", req: m.req, kind, data: "", upTo: 0 });
          break;
        }
        s.snapshot(m.kinds, (kind, data, upTo) => post({ t: "snap", req: m.req, kind, data, upTo }));
        break;
      case "text":
        if (!s) post({ t: "text", req: m.req, text: "" });
        else void s.text(m.unwrap).then((text) => post({ t: "text", req: m.req, text }));
        break;
      case "del":
        s?.dispose();
        screens.delete(m.id);
        break;
    }
  });
}
