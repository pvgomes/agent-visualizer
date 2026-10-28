/*
 * The only way ingest touches a filesystem. A Source lists files under some
 * roots (with size and mtime), reads byte ranges, and runs read-only SQLite
 * queries for the agents that keep their history in a database (opencode).
 * Every call takes a batch, so a remote source (src/remote/source.ts, built on
 * RemoteTarget.exec) can answer a whole poll in a few round trips. LocalSource
 * is the same contract over node:fs and node:sqlite.
 */
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import type { Host } from "../shared/events.ts";

export interface FileStat {
  path: string;
  size: number;
  mtimeMs: number;
  ino: number;
}

export interface ListRequest {
  /** Absolute directory to walk. Missing roots list as empty. */
  root: string;
  /** Directory levels below root to descend (0: root's own files only). */
  depth: number;
  /** Keep regular files whose name ends with one of these. */
  suffixes: string[];
  /** Directory names never descended into. */
  skip?: string[];
  /** Only files modified within this many ms. A remote pushes it into `find -mmin`; local filters after stat. */
  newerThanMs?: number;
  /**
   * A hint for quick polls: files this source already reported may be left out (the
   * loop stats the ones it follows itself). Local honours it to skip thousands of
   * stats per poll; a remote may ignore it.
   */
  onlyNew?: boolean;
}

export interface ReadRequest {
  path: string;
  /** Byte range [start, end). A source may return fewer bytes (file shrank, or a per-call cap); never more. */
  start: number;
  end: number;
}

export interface SourceEnv {
  home: string;
  vars: Record<string, string | undefined>;
}

export type SqlValue = string | number | null;
export type Row = Record<string, unknown>;

export interface Source {
  /** "local", or the host id. */
  readonly id: string;
  /** Unset for this machine. */
  readonly host?: Host;
  /** Home directory and the env vars that move agent folders (CLAUDE_CONFIG_DIR, CODEX_HOME, ...). */
  env(): Promise<SourceEnv>;
  /** One result array per request, in order. */
  list(reqs: ListRequest[]): Promise<FileStat[][]>;
  /** null for paths that are missing or not regular files. */
  stat(paths: string[]): Promise<(FileStat | null)[]>;
  /** null for files that could not be opened. */
  read(reqs: ReadRequest[]): Promise<(Buffer | null)[]>;
  /** Read-only query. Resolves null when SQLite is not available on that machine. */
  query(db: string, sql: string, params?: SqlValue[]): Promise<Row[] | null>;
  /**
   * Optional, for sources where a round trip is expensive: a listing plus reads in
   * one go. Reads may run past the end of a file (the bytes that exist come back,
   * an empty buffer means nothing new); null means not read (missing, or over the
   * call's byte budget). The loop uses it to fetch the growth of every followed
   * file along with the listing, so a quiet remote poll is a single exec.
   */
  listAndRead?(lists: ListRequest[], reads: ReadRequest[]): Promise<{ lists: FileStat[][]; reads: (Buffer | null)[] }>;
  /** How much growth per followed file listAndRead should fetch (default: the loop's own). */
  prefetchBytes?: number;
  /** The most bytes one read returns for one file (remote sources cap it); unset means no cap. */
  maxReadBytes?: number;
  close(): void;
}

/** Env vars a source reports; anything else agents read is not needed. */
export const ENV_VARS = [
  "HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_DATA_HOME", "GEMINI_CLI_HOME", "AGENT_VISUALIZER_HOME", "QWEN_HOME", "FACTORY_HOME",
] as const;

/* ------------------------------------------------------------------ local */

const LOCAL_READ_CHUNK = 1 << 20;

export interface LocalSourceOptions {
  env?: NodeJS.ProcessEnv;
}

export function createLocalSource(opts: LocalSourceOptions = {}): Source {
  return new LocalSource(opts.env ?? process.env);
}

class LocalSource implements Source {
  readonly id = "local";
  private sqlite?: Promise<SqliteModule | null>;
  /** Every file a listing has returned, for onlyNew. */
  private readonly reported = new Set<string>();
  private readonly dbs = new Map<string, { db: SqliteDb; stmts: Map<string, SqliteStmt> }>();

  constructor(private readonly vars: NodeJS.ProcessEnv) {}

  async env(): Promise<SourceEnv> {
    return { home: homedir(), vars: { ...this.vars } };
  }

  async list(reqs: ListRequest[]): Promise<FileStat[][]> {
    const now = Date.now();
    return Promise.all(reqs.map(async (r) => {
      const out: FileStat[] = [];
      await walk(r, r.root, 0, out, r.onlyNew ? this.reported : undefined);
      for (const f of out) this.reported.add(f.path);
      return r.newerThanMs === undefined ? out : out.filter((f) => now - f.mtimeMs <= r.newerThanMs!);
    }));
  }

  async stat(paths: string[]): Promise<(FileStat | null)[]> {
    return Promise.all(paths.map(statFile));
  }

  async read(reqs: ReadRequest[]): Promise<(Buffer | null)[]> {
    return Promise.all(reqs.map(readRange));
  }

  async query(db: string, sql: string, params: SqlValue[] = []): Promise<Row[] | null> {
    const mod = await (this.sqlite ??= loadSqlite());
    if (!mod) return null;
    let h = this.dbs.get(db);
    try {
      if (!h) {
        h = { db: new mod.DatabaseSync(db, { readOnly: true }), stmts: new Map() };
        this.dbs.set(db, h);
      }
      let st = h.stmts.get(sql);
      if (!st) {
        st = h.db.prepare(sql);
        h.stmts.set(sql, st);
        if (h.stmts.size > 64) h.stmts.delete(h.stmts.keys().next().value!);
      }
      // node:sqlite rows have a null prototype; hand out plain objects like a remote's JSON does.
      return st.all(...params).map((r) => ({ ...(r as Row) }));
    } catch (err) {
      // A replaced or locked database: reopen next time.
      this.drop(db);
      throw err;
    }
  }

  close(): void {
    for (const db of [...this.dbs.keys()]) this.drop(db);
  }

  private drop(db: string): void {
    const h = this.dbs.get(db);
    this.dbs.delete(db);
    try {
      h?.db.close();
    } catch {
      // Already closed.
    }
  }
}

async function walk(r: ListRequest, dir: string, depth: number, out: FileStat[], known?: Set<string>): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const files: string[] = [];
  const dirs: string[] = [];
  for (const e of entries) {
    if (e.isFile()) {
      if (!r.suffixes.some((s) => e.name.endsWith(s))) continue;
      const p = `${dir}/${e.name}`;
      if (!known?.has(p)) files.push(p);
    } else if (e.isDirectory() && depth < r.depth && !r.skip?.includes(e.name)) {
      dirs.push(`${dir}/${e.name}`);
    }
  }
  for (const st of await Promise.all(files.map(statFile))) if (st) out.push(st);
  await Promise.all(dirs.map((d) => walk(r, d, depth + 1, out, known)));
}

async function statFile(path: string): Promise<FileStat | null> {
  try {
    const st = await stat(path);
    return st.isFile() ? { path, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino } : null;
  } catch {
    return null;
  }
}

async function readRange(r: ReadRequest): Promise<Buffer | null> {
  let fh;
  try {
    fh = await open(r.path, "r");
  } catch {
    return null;
  }
  try {
    const want = Math.max(0, r.end - r.start);
    const buf = Buffer.allocUnsafe(want);
    let got = 0;
    while (got < want) {
      const { bytesRead } = await fh.read(buf, got, Math.min(LOCAL_READ_CHUNK, want - got), r.start + got);
      if (bytesRead <= 0) break;
      got += bytesRead;
    }
    return got === want ? buf : buf.subarray(0, got);
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}

/* node:sqlite is built into Node >= 22.5. Older Nodes just lose the SQLite agents. */
interface SqliteStmt {
  all(...params: SqlValue[]): unknown[];
}
interface SqliteDb {
  prepare(sql: string): SqliteStmt;
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (path: string, opts: { readOnly: boolean }) => SqliteDb;
}

async function loadSqlite(): Promise<SqliteModule | null> {
  const spec = "node:sqlite";
  // It prints an ExperimentalWarning on some Node versions; that would land in the banner.
  const emit = process.emitWarning;
  process.emitWarning = ((w: unknown, ...rest: unknown[]) => {
    const msg = typeof w === "string" ? w : (w as Error)?.message ?? "";
    if (/sqlite/i.test(msg)) return;
    return (emit as (...a: unknown[]) => void).call(process, w, ...rest);
  }) as typeof process.emitWarning;
  try {
    const mod = (await import(spec)) as Partial<SqliteModule>;
    return typeof mod.DatabaseSync === "function" ? (mod as SqliteModule) : null;
  } catch {
    return null;
  } finally {
    process.emitWarning = emit;
  }
}

/* ---------------------------------------------------------------- helpers */

/** The first line of a file (session headers), read through a source. Grows the read until a newline, up to `max`. */
export async function readHeadLine(src: Source, path: string, max = 4 << 20): Promise<string> {
  let want = 64 << 10;
  for (;;) {
    const [buf] = await src.read([{ path, start: 0, end: want }]);
    if (!buf) return "";
    const nl = buf.indexOf(10);
    if (nl >= 0) return buf.subarray(0, nl).toString("utf8");
    if (buf.length < want || want >= max) return "";
    want = Math.min(max, want * 4);
  }
}

/** First lines of many files in one batch; files whose header is longer than `first` get a second, larger read. */
export async function readHeadLines(src: Source, paths: string[], first = 64 << 10): Promise<string[]> {
  if (!paths.length) return [];
  const bufs = await src.read(paths.map((path) => ({ path, start: 0, end: first })));
  const out = bufs.map((b) => {
    if (!b) return "";
    const nl = b.indexOf(10);
    return nl >= 0 ? b.subarray(0, nl).toString("utf8") : b.length < first ? b.toString("utf8") : null;
  });
  const again = out.map((v, i) => (v === null ? i : -1)).filter((i) => i >= 0);
  for (const i of again) out[i] = await readHeadLine(src, paths[i]!);
  return out as string[];
}

/** Small JSON files (.meta.json, .settings.json) in one batch; anything unreadable or over 1 MB is null. */
export async function readJsonFiles(src: Source, paths: string[]): Promise<(Record<string, any> | null)[]> {
  if (!paths.length) return [];
  const bufs = await src.read(paths.map((path) => ({ path, start: 0, end: 1 << 20 })));
  return bufs.map((b) => {
    if (!b || b.length >= 1 << 20) return null;
    try {
      const o = JSON.parse(b.toString("utf8"));
      return o && typeof o === "object" && !Array.isArray(o) ? o : null;
    } catch {
      return null;
    }
  });
}
