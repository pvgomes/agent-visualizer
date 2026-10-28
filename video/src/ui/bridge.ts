/*
 * The server, for the real web app running in the stage's iframe: GET /events
 * (the snapshot, then every office event of the video's world, plus the
 * control plane's frames) and /api/control/* (answered by the control mock,
 * running here on the virtual clock). The iframe's fake EventSource and fetch
 * (app.ts) call in through window.__bridge. Office events the mock makes for
 * the agents it "hires" go into the same OfficeState as the rest of the cast.
 */
import type { World } from "../world.ts";
// @ts-expect-error plain JS, copied from web/ui/dev
import { createControlMock } from "./control-mock.js";

interface Source {
  open(): void;
  emit(name: string, data: string): void;
}

interface Reply {
  status: number;
  headers: Record<string, string>;
  body?: string;
  stream?: { subscribe(chunk: (s: string) => void, end: () => void): void };
}

declare const __vt: { install(w: Window): void; uninstall(w: Window): void };

export class Bridge {
  doc: Document | null = null;
  win: Window | null = null;
  private sources = new Set<Source>();
  private mock: { handle(req: unknown, res: unknown, url: URL): Promise<boolean>; hire(req: unknown): { id: string } };

  constructor(readonly world: World) {
    this.mock = createControlMock({
      empty: true,
      emitControl: (name: string, data: unknown) => this.broadcast(name, JSON.stringify(data)),
      emitOffice: (e: Record<string, unknown>) => {
        const { seq: _seq, ...raw } = e;
        world.ingest(raw as never);
      },
    });
    world.on((e) => this.broadcast("office", JSON.stringify(e)));
    (window as unknown as { __bridge: Bridge }).__bridge = this;
  }

  /** Hire an agent the way the page's Hire button does, without the dialog (sessions that are already running when a shot opens). */
  hire(req: Record<string, unknown>) {
    return this.mock.hire(req);
  }

  private broadcast(name: string, data: string) {
    for (const s of this.sources) s.emit(name, data);
  }

  connect(src: Source): () => void {
    this.sources.add(src);
    setTimeout(() => {
      if (!this.sources.has(src)) return;
      src.open();
      src.emit("snapshot", JSON.stringify({ ...this.world.state.snapshot(), control: "enabled" }));
    }, 0);
    return () => this.sources.delete(src);
  }

  async request(method: string, path: string, headers: Record<string, string>, body: string | undefined, signal?: AbortSignal): Promise<Reply> {
    const url = new URL(path, "http://127.0.0.1");
    const on: Record<string, ((x?: unknown) => void)[]> = {};
    const req = {
      method,
      url: path,
      headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
      on(ev: string, fn: (x?: unknown) => void) {
        (on[ev] ??= []).push(fn);
        return req;
      },
      destroy() {},
    };
    let status = 200;
    let head: Record<string, string> = {};
    let buf = "";
    let chunkFn: ((s: string) => void) | null = null;
    let endFn: (() => void) | null = null;
    const pending: string[] = [];
    let done!: (r: Reply) => void;
    const reply = new Promise<Reply>((r) => (done = r));
    const res = {
      writeHead(code: number, h?: Record<string, string>) {
        status = code;
        head = h ?? {};
        if (/event-stream/.test(head["content-type"] ?? "")) {
          done({
            status,
            headers: head,
            stream: {
              subscribe(chunk, end) {
                chunkFn = chunk;
                endFn = end;
                for (const p of pending.splice(0)) chunk(p);
              },
            },
          });
        }
        return res;
      },
      write(chunk: string) {
        if (chunkFn) chunkFn(String(chunk));
        else if (/event-stream/.test(head["content-type"] ?? "")) pending.push(String(chunk));
        else buf += chunk;
        return true;
      },
      end(chunk?: string) {
        if (chunk) buf += chunk;
        if (/event-stream/.test(head["content-type"] ?? "")) endFn?.();
        else done({ status, headers: head, body: buf });
      },
    };
    signal?.addEventListener("abort", () => {
      for (const fn of on.close ?? []) fn();
      endFn?.();
    });
    queueMicrotask(() => {
      if (body) for (const fn of on.data ?? []) fn(body);
      for (const fn of on.end ?? []) fn();
    });
    const handled = await this.mock.handle(req, res, url);
    if (!handled) done({ status: 404, headers: {}, body: "" });
    return reply;
  }

  /** Load the real app into the iframe at cssW x cssH, its own virtual-time install first. */
  async open(el: HTMLIFrameElement, cssW: number, cssH: number, dpr: number) {
    el.style.width = `${cssW}px`;
    el.style.height = `${cssH}px`;
    el.style.display = "block";
    const loaded = new Promise<void>((r) => el.addEventListener("load", () => r(), { once: true }));
    el.src = `app.html?dpr=${dpr}`;
    await loaded;
    this.win = el.contentWindow;
    this.doc = el.contentDocument;
  }

  close(el: HTMLIFrameElement) {
    if (this.win) __vt.uninstall(this.win);
    this.sources.clear();
    el.src = "about:blank";
    el.style.display = "none";
    this.win = null;
    this.doc = null;
  }
}
