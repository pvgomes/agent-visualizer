/*
 * A Source (src/ingest/source.ts) for any machine we can run `sh -c` on: an
 * ssh box, a Daytona / boat / Railway / Vercel sandbox. Everything is plain
 * POSIX sh plus find, stat, tail -c, head -c and base64 (od as a fallback),
 * which every Linux image and macOS has, so the remote needs nothing
 * installed. Each Source call is one exec (or a few, when a batch would make
 * the script or the output too large). Every path we put in a script is
 * single-quoted; remote filenames are data, never code, and names with a
 * newline are skipped by find so they can't forge an output line.
 */
import { gunzipSync } from "node:zlib";
import type { RemoteTarget } from "../shared/events.ts";
import {
  ENV_VARS,
  type FileStat, type ListRequest, type ReadRequest, type Row, type Source, type SourceEnv, type SqlValue,
} from "../ingest/source.ts";

/** What a transport can say about how much one poll should fetch (Railway pages every 15 KB). */
export interface ReadLimits {
  maxReadBytes?: number;
  maxBatchBytes?: number;
  /** Growth fetched per followed file along with each listing. */
  prefetchBytes?: number;
}

/** A RemoteTarget that may carry ReadLimits (the contract's RemoteTarget doesn't need to know). */
export type TunedTarget = RemoteTarget & { readLimits?: ReadLimits };

export interface RemoteSourceOptions {
  /** Per exec. */
  timeoutMs?: number;
  /** Most bytes returned for one file in one read call (the caller reads the rest next poll). */
  maxReadBytes?: number;
  /** Most file bytes one exec returns (before base64). */
  maxBatchBytes?: number;
  /** Scripts are split before they get longer than this (Linux caps one argv string at 128 KB). */
  maxScriptBytes?: number;
}

const DEFAULTS = {
  timeoutMs: 20_000,
  maxReadBytes: 1 << 20,
  maxBatchBytes: 4 << 20,
  maxScriptBytes: 48 << 10,
};

/** POSIX single-quoting: safe for any string without a NUL byte. */
export function shQuote(s: string): string {
  return "'" + s.replace(/\0/g, "").replace(/'/g, "'\\''") + "'";
}

/** Only absolute paths without control line breaks ever reach a script. */
function okPath(p: string): boolean {
  return typeof p === "string" && p.startsWith("/") && !/[\0\n\r]/.test(p) && p.length < 4096;
}

const PRELUDE = `NL='
'
if stat -c %s / >/dev/null 2>&1; then SF=-c; FMT='%s %Y %i %n'; FMT0='%s %Y %i'; else SF=-f; FMT='%z %m %i %N'; FMT0='%z %m %i'; fi
`;

const SUFFIX = /^\.[A-Za-z0-9._-]{1,32}$/;
const NAME = /^[A-Za-z0-9._@+-]{1,128}$/;

export function createRemoteSource(target: RemoteTarget, opts: RemoteSourceOptions = {}): Source {
  const lim = (target as TunedTarget).readLimits ?? {};
  const tuned: RemoteSourceOptions = {};
  if (lim.maxReadBytes) tuned.maxReadBytes = lim.maxReadBytes;
  if (lim.maxBatchBytes) tuned.maxBatchBytes = lim.maxBatchBytes;
  const src = new RemoteSource(target, { ...DEFAULTS, ...tuned, ...opts });
  if (lim.prefetchBytes) src.prefetchBytes = lim.prefetchBytes;
  return src;
}

class RemoteSource implements Source {
  readonly id: string;
  readonly host;
  prefetchBytes?: number;
  readonly maxReadBytes: number;
  private envCache?: Promise<SourceEnv>;
  /** When the last full listing (no onlyNew request) finished, for quick polls' `-mmin`. */
  private lastFullAt?: number;

  constructor(
    private readonly target: RemoteTarget,
    private readonly o: Required<RemoteSourceOptions>,
  ) {
    this.host = target.host;
    this.id = target.host.id;
    this.maxReadBytes = o.maxReadBytes;
  }

  private exec(script: string): Promise<string> {
    return this.target.exec(script, { timeoutMs: this.o.timeoutMs });
  }

  env(): Promise<SourceEnv> {
    this.envCache ??= (async () => {
      const lines = ENV_VARS.map((v) => `printf '%s=%s\\n' ${v} "\${${v}-}"`).join("\n");
      const out = await this.exec(lines + "\nexit 0\n");
      const vars: Record<string, string | undefined> = {};
      for (const l of out.split("\n")) {
        const i = l.indexOf("=");
        if (i <= 0) continue;
        const k = l.slice(0, i);
        const v = l.slice(i + 1);
        if ((ENV_VARS as readonly string[]).includes(k) && v) vars[k] = v;
      }
      const home = vars.HOME && okPath(vars.HOME) ? vars.HOME.replace(/\/+$/, "") || "/" : "/root";
      return { home, vars };
    })();
    this.envCache.catch(() => (this.envCache = undefined));
    return this.envCache;
  }

  async list(reqs: ListRequest[]): Promise<FileStat[][]> {
    const out: FileStat[][] = reqs.map(() => []);
    const started = Date.now();
    for (const script of this.chunk(this.listParts(reqs, started))) {
      this.parseList(await this.exec(PRELUDE + script + "printf '@end\\n'\nexit 0\n"), reqs, out);
    }
    this.noteFull(reqs, started);
    return out;
  }

  /** A listing with any full request is the new baseline for quick polls. */
  private noteFull(reqs: ListRequest[], started: number): void {
    if (reqs.some((r) => !r.onlyNew)) this.lastFullAt = started;
  }

  /** One exec: the listing first, then reads (each capped, the batch within maxBatchBytes). */
  async listAndRead(lists: ListRequest[], reads: ReadRequest[]): Promise<{ lists: FileStat[][]; reads: (Buffer | null)[] }> {
    const started = Date.now();
    const parts = this.listParts(lists, started);
    const listLen = parts.reduce((n, p) => n + p.length, 0);
    const outLists: FileStat[][] = lists.map(() => []);
    const outReads: (Buffer | null)[] = reads.map(() => null);
    if (listLen > this.o.maxScriptBytes) {
      // Too big for one script: fall back to separate calls.
      return { lists: await this.list(lists), reads: await this.read(reads) };
    }
    let budget = this.o.maxBatchBytes;
    let scriptLen = listLen;
    const lines: string[] = [];
    const lens = new Map<number, number>();
    reads.forEach((r, i) => {
      if (!okPath(r.path)) return;
      const start = Math.max(0, Math.floor(r.start));
      const len = Math.max(0, Math.min(Math.floor(r.end) - start, this.o.maxReadBytes, budget));
      const line = `r ${i} ${shQuote(r.path)} ${start} ${len}\n`;
      if (len <= 0 || scriptLen + line.length > this.o.maxScriptBytes) return;
      budget -= len;
      scriptLen += line.length;
      lens.set(i, len);
      lines.push(line);
    });
    const text = await this.exec(PRELUDE + READ_PRELUDE + parts.join("") + lines.join("") + "printf '@end\\n'\nexit 0\n");
    this.parseList(text, lists, outLists);
    this.noteFull(lists, started);
    for (const [i, buf] of decodeReads(text)) {
      const len = lens.get(i);
      if (len !== undefined) outReads[i] = buf.length > len ? buf.subarray(0, len) : buf;
    }
    return { lists: outLists, reads: outReads };
  }

  private listParts(reqs: ListRequest[], now = Date.now()): string[] {
    const parts: string[] = [];
    // Quick polls only need files touched since the last full listing (it's the truth for the rest):
    // without this, every quick poll would stat every old transcript on the box.
    const sinceFull = this.lastFullAt !== undefined ? now - this.lastFullAt + 60_000 : undefined;
    reqs.forEach((r, i) => {
      if (!okPath(r.root)) return;
      const root = r.root.replace(/\/+$/, "") || "/";
      const names = r.suffixes.filter((s) => SUFFIX.test(s)).map((s) => `-name ${shQuote("*" + s)}`);
      if (!names.length) return;
      const skip = (r.skip ?? []).filter((s) => NAME.test(s)).map((s) => `-name ${shQuote(s)}`);
      const prune = skip.length ? `-type d \\( ${skip.join(" -o ")} \\) -prune -o ` : "";
      const depth = Math.max(0, Math.min(16, Math.floor(r.depth))) + 1;
      const within = Math.min(r.newerThanMs ?? Infinity, r.onlyNew && sinceFull !== undefined ? sinceFull : Infinity);
      const mmin = Number.isFinite(within) ? ` -mmin -${Math.max(1, Math.ceil(within / 60_000))}` : "";
      parts.push(
        `printf '@%d\\n' ${i}\n` +
          `[ -d ${shQuote(root)} ] && find ${shQuote(root)} -maxdepth ${depth} ${prune}-type f \\( ${names.join(" -o ")} \\) ! -name "*$NL*"${mmin} -exec stat -L $SF "$FMT" {} + 2>/dev/null\n`,
      );
    });
    return parts;
  }

  /** "@i" opens request i's section; read sections ("@i b") and their base64 never parse as stat lines. */
  private parseList(text: string, reqs: ListRequest[], out: FileStat[][]): void {
    let cur = -1;
    for (const line of text.split("\n")) {
      if (line.startsWith("@")) {
        cur = /^@\d+$/.test(line) ? Number(line.slice(1)) : -1;
        continue;
      }
      const r = reqs[cur];
      if (!r) continue;
      const st = parseStatLine(line);
      if (st && st.path.startsWith(r.root.replace(/\/+$/, "") + "/")) out[cur]!.push(st);
    }
  }

  async stat(paths: string[]): Promise<(FileStat | null)[]> {
    const out: (FileStat | null)[] = paths.map(() => null);
    const parts: string[] = [];
    paths.forEach((p, i) => {
      if (okPath(p)) parts.push(`[ -f ${shQuote(p)} ] && s=$(stat -L $SF "$FMT0" ${shQuote(p)} 2>/dev/null) && printf '%s %s\\n' ${i} "$s"\n`);
    });
    for (const script of this.chunk(parts)) {
      const text = await this.exec(PRELUDE + script + "exit 0\n");
      for (const line of text.split("\n")) {
        const m = line.match(/^(\d+) (\d+) (\d+) (\d+)$/);
        if (!m) continue;
        const i = Number(m[1]);
        if (paths[i] === undefined) continue;
        out[i] = { path: paths[i]!, size: Number(m[2]), mtimeMs: Number(m[3]) * 1000, ino: Number(m[4]) };
      }
    }
    return out;
  }

  async read(reqs: ReadRequest[]): Promise<(Buffer | null)[]> {
    const out: (Buffer | null)[] = reqs.map(() => null);
    // Pack requests into execs by output size and script size.
    let batch: { i: number; start: number; len: number; line: string }[] = [];
    let bytes = 0;
    let scriptLen = 0;
    const flush = async () => {
      if (!batch.length) return;
      const items = batch;
      batch = [];
      bytes = scriptLen = 0;
      const script =
        READ_PRELUDE + items.map((b) => b.line).join("") + "printf '@end\\n'\nexit 0\n";
      const text = await this.exec(script);
      for (const [i, buf] of decodeReads(text)) {
        const it = items.find((b) => b.i === i);
        if (it) out[i] = buf.length > it.len ? buf.subarray(0, it.len) : buf;
      }
    };
    for (let i = 0; i < reqs.length; i++) {
      const r = reqs[i]!;
      if (!okPath(r.path)) continue;
      const start = Math.max(0, Math.floor(r.start));
      const len = Math.max(0, Math.min(Math.floor(r.end) - start, this.o.maxReadBytes));
      if (len === 0) {
        out[i] = Buffer.alloc(0);
        continue;
      }
      const line = `r ${i} ${shQuote(r.path)} ${start} ${len}\n`;
      if (batch.length && (bytes + len > this.o.maxBatchBytes || scriptLen + line.length > this.o.maxScriptBytes)) await flush();
      batch.push({ i, start, len, line });
      bytes += len;
      scriptLen += line.length;
    }
    await flush();
    return out;
  }

  async query(db: string, sql: string, params: SqlValue[] = []): Promise<Row[] | null> {
    if (!okPath(db)) return null;
    const text = inlineParams(sql, params);
    const script =
      `db=${shQuote(db)}\nsql=${shQuote(text)}\n` +
      `[ -f "$db" ] || { printf '@missing\\n'; exit 0; }\n` +
      `if command -v sqlite3 >/dev/null 2>&1 && out=$(sqlite3 -readonly -json "$db" "$sql" 2>/dev/null); then printf '@ok\\n%s\\n' "$out"\n` +
      `elif command -v node >/dev/null 2>&1; then printf '@ok\\n'; node -e ${shQuote(NODE_QUERY)} "$db" "$sql" 2>/dev/null || printf '@none\\n'\n` +
      `else printf '@none\\n'; fi\nexit 0\n`;
    const out = await this.exec(script);
    const at = out.indexOf("@ok\n");
    if (at < 0) return out.includes("@missing") ? [] : null;
    const body = out.slice(at + 4).trim();
    if (body.endsWith("@none")) return null;
    if (!body) return [];
    const rows = JSON.parse(body);
    return Array.isArray(rows) ? rows : [];
  }

  close(): void {
    this.target.close?.();
  }

  private chunk(parts: string[]): string[] {
    const out: string[] = [];
    let cur = "";
    for (const p of parts) {
      if (cur && cur.length + p.length > this.o.maxScriptBytes) {
        out.push(cur);
        cur = "";
      }
      cur += p;
    }
    if (cur || !out.length) out.push(cur);
    return out;
  }
}

/** "size mtime ino path" as printed by stat -c '%s %Y %i %n' or stat -f '%z %m %i %N'. */
function parseStatLine(line: string): FileStat | null {
  const m = line.match(/^(\d+) (\d+) (\d+) (\/.*)$/);
  if (!m) return null;
  return { path: m[4]!, size: Number(m[1]), mtimeMs: Number(m[2]) * 1000, ino: Number(m[3]) };
}

/* Reads come back gzipped when the box has gzip (transcripts are JSON: ~6x smaller on the wire,
 * which is what an API-metered exec costs), else base64, else hex. */
const READ_PRELUDE = `if command -v base64 >/dev/null 2>&1; then if command -v gzip >/dev/null 2>&1; then E=z; enc() { gzip -c | base64; }; else E=b; enc() { base64; }; fi; else E=x; enc() { od -An -v -tx1 | tr -d ' \\n'; echo; }; fi
r() {
  if [ -f "$2" ]; then
    printf '@%s %s\\n' "$1" "$E"
    if [ "$3" -gt 0 ]; then tail -c +"$(($3 + 1))" "$2" 2>/dev/null | head -c "$4" | enc; else head -c "$4" "$2" 2>/dev/null | enc; fi
  else printf '@%s -\\n' "$1"; fi
}
`;

/** No single read is ever bigger than this once inflated. */
const MAX_INFLATE = 16 << 20;

/** Split "@i b\n<base64>\n@j z\n<base64 of gzip>\n@k x\n<hex>\n@end" into buffers. An entry cut off before @end is dropped. */
export function decodeReads(text: string): Map<number, Buffer> {
  const out = new Map<number, Buffer>();
  const lines = text.split("\n");
  let cur: { i: number; enc: string; body: string[] } | undefined;
  const done = () => {
    if (!cur || cur.enc === "-") return;
    const s = cur.body.join("");
    if (cur.enc === "x") out.set(cur.i, Buffer.from(s.replace(/[^0-9a-f]/gi, ""), "hex"));
    else {
      const raw = Buffer.from(s.replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
      if (cur.enc === "b") out.set(cur.i, raw);
      else {
        try {
          // Capped: a compromised box doesn't get to inflate a few KB into gigabytes here.
          out.set(cur.i, gunzipSync(raw, { maxOutputLength: MAX_INFLATE }));
        } catch {
          // Damaged or oversized: not read; the loop asks again next poll.
        }
      }
    }
  };
  for (const line of lines) {
    const m = line.match(/^@(\d+) ([bxz-])$/);
    if (m) {
      done();
      cur = { i: Number(m[1]), enc: m[2]!, body: [] };
    } else if (line === "@end") {
      done();
      cur = undefined;
      return out;
    } else if (cur) {
      cur.body.push(line);
    }
  }
  // No @end: the output was cut short; everything but the last entry is complete.
  return out;
}

/** Bind `?` params as SQL literals (the sqlite3 CLI has no parameter binding). */
export function inlineParams(sql: string, params: SqlValue[]): string {
  let i = 0;
  return sql.replace(/\?/g, () => {
    const v = params[i++];
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
    return "'" + String(v).replace(/\0/g, "").replace(/'/g, "''") + "'";
  });
}

/** Fallback when the remote has node (>= 22.5) but no sqlite3 binary. */
const NODE_QUERY = `process.emitWarning=()=>{};let S;try{S=require("node:sqlite")}catch(e){process.stdout.write("@none");process.exit(0)}
const d=new S.DatabaseSync(process.argv[1],{readOnly:true});const r=d.prepare(process.argv[2]).all();
process.stdout.write(JSON.stringify(r,(k,v)=>typeof v==="bigint"?Number(v):v));`;
