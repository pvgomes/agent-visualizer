/*
 * Who may drive the office. Watching stays open to any page on this
 * machine's loopback, as before; controlling needs an unlocked browser.
 *
 *   control.json  {v:1, secret, notBefore} in $AGENT_VISUALIZER_HOME, 0600 in a
 *                 0700 folder, created on the first control-enabled start.
 *                 Separate from office.json's per-start secret.
 *   unlock code   "<exp base36>.<nonce>.<HMAC(secret, "unlock:<exp>.<nonce>"), 32 hex>",
 *                 valid 2 minutes, single use. `agent-visualizer` opens
 *                 /unlock?t=<code> in the browser (never prints it unless
 *                 asked with `agent-visualizer open --print`).
 *   cookie        ao_key=v1.<iat>.<HMAC(secret, "cookie:" + iat)>, HttpOnly,
 *                 SameSite=Strict, 30 days, invalid once iat < notBefore
 *                 (`agent-visualizer open --rotate` logs every browser out).
 *   page token    HMAC(secret, "page-token"), 64 hex. Cookies for 127.0.0.1
 *                 go to every port on it, so the cookie alone never unlocks:
 *                 the page also sends this token (X-Agent-Visualizer-Token, or
 *                 ?k= on /events, which EventSource can't give a header),
 *                 and it lives in the office origin's localStorage, which no
 *                 other port can read. /unlock hands it over without putting
 *                 it in a URL: it redirects to /#unlock=<handoff>, a single
 *                 use, 2-minute nonce the page trades for the token at
 *                 POST /api/control/token (cookie required).
 *
 * Every /api/control request must also name an allowed Host, come from this
 * origin (Origin, Sec-Fetch-Site) and carry `X-Agent-Visualizer: 1`, which a
 * cross-site page can only send after a CORS preflight this server never
 * answers. Codes, cookies, tokens and the secret are never logged.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { CONTROL_HEADER, CONTROL_TOKEN_HEADER } from "../shared/control.ts";
import { hostAllowed } from "../server/http.ts";
import { COOKIE, FILES } from "./types.ts";

export const UNLOCK_TTL_MS = 2 * 60_000;
export const COOKIE_MAX_AGE_S = 30 * 24 * 3600;
/** GET /api/control re-issues a cookie older than this, so a browser in daily use never gets logged out. */
export const COOKIE_REFRESH_S = 24 * 3600;

interface Secret {
  key: Buffer;
  /** Epoch seconds: cookies issued before this are void. */
  notBefore: number;
}

/** mkdir -p with 0700, tightening an existing folder. */
export function privateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    if ((statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700);
  } catch {
    // Not ours to fix.
  }
}

/** Write a 0600 file atomically: a fresh temp file beside it, then rename. */
export function writePrivate(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
  renameSync(tmp, file);
}

const hmac = (key: Buffer, msg: string) => createHmac("sha256", key).update(msg).digest("hex");

function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length || !/^[0-9a-f]+$/.test(a)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

export class ControlAuth {
  readonly file: string;
  private readonly now: () => number;
  private cached?: { secret: Secret; mtimeMs: number; checkedAt: number };
  /** Redeemed codes until they expire. */
  private readonly used = new Map<string, number>();
  /** Unredeemed /unlock handoffs -> when they expire. */
  private readonly handoffs = new Map<string, number>();

  constructor(readonly home: string, o: { now?: () => number } = {}) {
    this.file = join(home, FILES.control);
    this.now = o.now ?? Date.now;
  }

  /** The secret, created on first use; re-read at most once a second when the file changes (a rotate from another process). */
  private secret(): Secret {
    const t = this.now();
    if (this.cached && t - this.cached.checkedAt < 1_000) return this.cached.secret;
    let mtimeMs = -1;
    try {
      mtimeMs = statSync(this.file).mtimeMs;
    } catch {
      // Not there yet.
    }
    if (this.cached && mtimeMs === this.cached.mtimeMs) {
      this.cached.checkedAt = t;
      return this.cached.secret;
    }
    const secret = mtimeMs < 0 ? this.create() : this.read() ?? this.create(true);
    let m = mtimeMs;
    try {
      m = statSync(this.file).mtimeMs;
    } catch {
      // Keep the old stamp.
    }
    this.cached = { secret, mtimeMs: m, checkedAt: t };
    return secret;
  }

  private read(): Secret | null {
    try {
      const st = statSync(this.file);
      if ((st.mode & 0o077) !== 0) chmodSync(this.file, 0o600);
      const j = JSON.parse(readFileSync(this.file, "utf8"));
      if (j?.v !== 1 || typeof j.secret !== "string" || !/^[0-9a-f]{64}$/.test(j.secret)) return null;
      const nb = Date.parse(String(j.notBefore));
      return { key: Buffer.from(j.secret, "hex"), notBefore: Number.isFinite(nb) ? Math.floor(nb / 1000) : 0 };
    } catch {
      return null;
    }
  }

  /** A new secret. Without `replace`, never overwrites one another process just created. */
  private create(replace = false): Secret {
    privateDir(this.home);
    const key = randomBytes(32);
    const nowS = Math.floor(this.now() / 1000);
    const text = JSON.stringify({ v: 1, secret: key.toString("hex"), notBefore: new Date(nowS * 1000).toISOString() }, null, 2) + "\n";
    if (replace) {
      writePrivate(this.file, text);
      return { key, notBefore: nowS };
    }
    try {
      writeFileSync(this.file, text, { mode: 0o600, flag: "wx" });
      return { key, notBefore: nowS };
    } catch {
      return this.read() ?? this.create(true);
    }
  }

  /** Make sure control.json exists (first control-enabled start). */
  ensure(): void {
    this.secret();
  }

  /** New secret and notBefore: every browser is logged out, every outstanding code dies. */
  rotate(): void {
    this.create(true);
    this.cached = undefined;
    this.used.clear();
    this.handoffs.clear();
  }

  /** What the office's own page sends next to the cookie (see the header). Changes with rotate(). */
  pageToken(): string {
    return hmac(this.secret().key, "page-token");
  }

  tokenOk(given: unknown): boolean {
    return typeof given === "string" && given.length === 64 && sameHex(given, this.pageToken());
  }

  /** A single-use nonce for the /unlock redirect's #fragment, traded for pageToken() within UNLOCK_TTL_MS. */
  mintHandoff(): string {
    const t = this.now();
    for (const [h, until] of this.handoffs) if (until < t) this.handoffs.delete(h);
    const h = randomBytes(16).toString("hex");
    this.handoffs.set(h, t + UNLOCK_TTL_MS);
    if (this.handoffs.size > 64) this.handoffs.delete(this.handoffs.keys().next().value!);
    return h;
  }

  takeHandoff(given: unknown): boolean {
    if (typeof given !== "string" || !/^[0-9a-f]{32}$/.test(given)) return false;
    const until = this.handoffs.get(given);
    this.handoffs.delete(given);
    return until !== undefined && until >= this.now();
  }

  /** A single-use unlock code, valid UNLOCK_TTL_MS. The nonce keeps two codes minted in the same second apart. */
  mintCode(): string {
    const exp = Math.floor((this.now() + UNLOCK_TTL_MS) / 1000).toString(36);
    const nonce = randomBytes(6).toString("hex");
    return `${exp}.${nonce}.${hmac(this.secret().key, `unlock:${exp}.${nonce}`).slice(0, 32)}`;
  }

  /** True once for a valid, unexpired code. */
  redeem(code: unknown): boolean {
    if (typeof code !== "string" || code.length > 80) return false;
    const m = /^([0-9a-z]{1,12})\.([0-9a-f]{12})\.([0-9a-f]{32})$/.exec(code);
    if (!m) return false;
    const expMs = parseInt(m[1]!, 36) * 1000;
    const t = this.now();
    for (const [c, until] of this.used) if (until < t) this.used.delete(c);
    if (!Number.isFinite(expMs) || expMs < t || expMs > t + UNLOCK_TTL_MS + 5_000) return false;
    if (!sameHex(m[3]!, hmac(this.secret().key, `unlock:${m[1]}.${m[2]}`).slice(0, 32))) return false;
    if (this.used.has(code)) return false;
    this.used.set(code, expMs);
    return true;
  }

  /** The Set-Cookie value for a freshly unlocked browser. */
  cookie(): string {
    const iat = Math.floor(this.now() / 1000);
    const v = `v1.${iat}.${hmac(this.secret().key, `cookie:${iat}`)}`;
    return `${COOKIE}=${v}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}`;
  }

  /** Issue time (epoch s) of the valid ao_key cookie in this Cookie header, or null. */
  cookieIat(header: string | string[] | undefined): number | null {
    const raw = Array.isArray(header) ? header.join("; ") : header;
    if (!raw || raw.length > 8192) return null;
    const s = this.secret();
    const nowS = Math.floor(this.now() / 1000);
    let best: number | null = null;
    for (const part of raw.split(";")) {
      const i = part.indexOf("=");
      if (i < 0 || part.slice(0, i).trim() !== COOKIE) continue;
      const m = /^v1\.(\d{1,12})\.([0-9a-f]{64})$/.exec(part.slice(i + 1).trim());
      if (!m) continue;
      const iat = Number(m[1]);
      if (iat < s.notBefore || iat > nowS + 60 || nowS - iat > COOKIE_MAX_AGE_S) continue;
      if (!sameHex(m[2]!, hmac(s.key, `cookie:${m[1]}`))) continue;
      if (best === null || iat > best) best = iat;
    }
    return best;
  }

  /** The cookie alone: enough only to trade an /unlock handoff for the page token. */
  hasCookie(req: IncomingMessage): boolean {
    return this.cookieIat(req.headers.cookie) !== null;
  }

  /** The cookie and the page token (header, or ?k= for /events). */
  unlocked(req: IncomingMessage): boolean {
    return this.hasCookie(req) && this.tokenOk(pageTokenOf(req));
  }
}

/** The page token a request carries: the X-Agent-Visualizer-Token header, else ?k= (EventSource). */
export function pageTokenOf(req: IncomingMessage): string | undefined {
  const h = req.headers[CONTROL_TOKEN_HEADER.toLowerCase()];
  if (typeof h === "string") return h;
  const q = (req.url ?? "").indexOf("?");
  if (q < 0) return undefined;
  return new URLSearchParams((req.url ?? "").slice(q + 1)).get("k") ?? undefined;
}

/** A browser marking this request as coming from another site or another origin. */
export function foreignOrigin(req: IncomingMessage, allowNone = true): boolean {
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && !(allowNone && site === "none")) return true;
  const origin = req.headers.origin;
  if (origin === undefined) return false;
  const host = req.headers.host;
  return !host || origin !== `http://${host.trim().toLowerCase()}`;
}

export interface Rejection {
  status: number;
  error: string;
}

/**
 * Checks for every /api/control request, in order: Host, origin, the
 * X-Agent-Visualizer header, the cookie. null when it may proceed.
 */
export function checkControl(req: IncomingMessage, allowed: Set<string>, auth: ControlAuth, o: { cookieOnly?: boolean } = {}): Rejection | null {
  if (!hostAllowed(req.headers.host, allowed)) return { status: 403, error: "agent-visualizer only answers to localhost." };
  if (foreignOrigin(req)) return { status: 403, error: "Cross-site request." };
  if (req.headers[CONTROL_HEADER.toLowerCase()] !== "1") return { status: 403, error: "Missing the X-Agent-Visualizer header." };
  if (!(o.cookieOnly ? auth.hasCookie(req) : auth.unlocked(req))) return { status: 401, error: "Controls are locked in this browser." };
  return null;
}

/** An agent's own HTTP hook call: never a browser (no Origin, no Sec-Fetch-*). */
export function fromBrowser(req: IncomingMessage): boolean {
  if (req.headers.origin !== undefined) return true;
  return Object.keys(req.headers).some((h) => h.startsWith("sec-fetch-"));
}
