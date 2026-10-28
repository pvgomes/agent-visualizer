/*
 * Runs in the iframe before web/main.ts: the app's network goes to the
 * stage's Bridge (ui/bridge.ts) through parent.__bridge.
 */
interface Bridge {
  connect(src: { open(): void; emit(name: string, data: string): void }): () => void;
  request(method: string, path: string, headers: Record<string, string>, body: string | undefined, signal?: AbortSignal): Promise<{
    status: number;
    headers: Record<string, string>;
    body?: string;
    stream?: { subscribe(chunk: (s: string) => void, end: () => void): void };
  }>;
}

const bridge = (parent as unknown as { __bridge: Bridge }).__bridge;
const DPR = Number(new URLSearchParams(location.search).get("dpr") ?? 1.2);
Object.defineProperty(window, "devicePixelRatio", { get: () => DPR, configurable: true });

try {
  localStorage.setItem("agent-visualizer.control-token", "7".repeat(64));
  localStorage.setItem("agent-visualizer:ui", JSON.stringify({ feed: false, crt: false }));
} catch {
  /* nothing to keep */
}

class FakeEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = 0;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  private off: () => void;
  constructor(readonly url: string) {
    super();
    this.off = bridge.connect(this);
  }
  open() {
    this.readyState = 1;
    const e = new Event("open");
    this.dispatchEvent(e);
    this.onopen?.(e);
  }
  emit(name: string, data: string) {
    if (this.readyState === 2) return;
    const e = new MessageEvent(name, { data });
    this.dispatchEvent(e);
    if (name === "message") this.onmessage?.(e);
  }
  close() {
    this.readyState = 2;
    this.off();
  }
}
(window as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  if (!url.pathname.startsWith("/api/")) return realFetch(input, init);
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => (headers[k] = v));
  const r = await bridge.request(init.method ?? "GET", url.pathname + url.search, headers, typeof init.body === "string" ? init.body : undefined, init.signal ?? undefined);
  if (r.stream) {
    const enc = new TextEncoder();
    const s = r.stream;
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        s.subscribe(
          (chunk) => {
            try {
              ctrl.enqueue(enc.encode(chunk));
            } catch {
              /* closed */
            }
          },
          () => {
            try {
              ctrl.close();
            } catch {
              /* closed */
            }
          },
        );
      },
    });
    return new Response(body, { status: r.status, headers: r.headers });
  }
  return new Response(r.status === 204 || r.status === 304 ? null : r.body ?? "", { status: r.status, headers: r.headers });
};

// the office's pixels stay hard-edged when the stage zooms the iframe
const st = document.createElement("style");
st.textContent = "#office canvas{image-rendering:pixelated}";
document.head.append(st);
