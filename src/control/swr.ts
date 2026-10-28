/*
 * Stale-while-revalidate caches for what the page asks for often and is slow
 * to look up: "Your setup" (a project's git listing, the agent's instructions
 * and skills, its MCP config), the login shell's key names.
 *
 * A value is fresh for `ttlMs` after it was computed, and only while its
 * stamp (a cheap fingerprint of what it was computed from: mtimes and sizes)
 * is unchanged. A stale value is still answered at once, and a refresh starts
 * behind it (one at a time); `fresh()` waits for that refresh, or computes
 * one. The first look for a key waits for its value. A refresh that fails
 * keeps the last good value (and the next ask tries again).
 */

export interface SwrOptions {
  /** How long a value stays fresh. */
  ttlMs: number;
  /** Fingerprint of the inputs; a different one makes the value stale at once. Must be cheap. */
  stamp?: () => string;
  now?: () => number;
}

export interface SwrHit<V> {
  value: V;
  /** False: this is the last known value, and a refresh is under way. */
  fresh: boolean;
}

interface Entry<V> {
  value: V;
  at: number;
  stamp: string;
}

export class Swr<V> {
  private entry: Entry<V> | undefined;
  private inflight: Promise<V> | undefined;
  private readonly now: () => number;

  constructor(
    private readonly compute: () => Promise<V>,
    private readonly o: SwrOptions,
  ) {
    this.now = o.now ?? Date.now;
  }

  private stampNow(): string {
    try {
      return this.o.stamp?.() ?? "";
    } catch {
      return "";
    }
  }

  /** Is the value we hold still good? */
  isFresh(): boolean {
    const e = this.entry;
    return !!e && this.now() - e.at < this.o.ttlMs && e.stamp === this.stampNow();
  }

  /** A refresh, unless one is already under way. */
  refresh(): Promise<V> {
    if (this.inflight) return this.inflight;
    const stamp = this.stampNow();
    const p = (async () => {
      try {
        const value = await this.compute();
        this.entry = { value, at: this.now(), stamp };
        return value;
      } finally {
        this.inflight = undefined;
      }
    })();
    this.inflight = p;
    return p;
  }

  /** The value now: fresh, or the last known one with a refresh started behind it. Waits only when there is none yet. */
  async get(): Promise<SwrHit<V>> {
    if (this.entry && this.isFresh()) return { value: this.entry.value, fresh: true };
    if (this.entry) {
      const value = this.entry.value;
      this.refresh().catch(() => {});
      return { value, fresh: false };
    }
    return { value: await this.refresh(), fresh: true };
  }

  /** A fresh value: the refresh under way, a new one if the value is stale, or the value if it's good. */
  async fresh(): Promise<V> {
    if (this.inflight) return this.inflight;
    if (this.entry && this.isFresh()) return this.entry.value;
    return this.refresh();
  }

  /** What we hold, fresh or not, without asking for anything. */
  peek(): V | undefined {
    return this.entry?.value;
  }

  /** Forget the value: the next get() waits for a new one. */
  clear(): void {
    this.entry = undefined;
  }
}

/** Swr per key (an agent and a folder), the least recently used dropped past `max`. */
export class SwrMap<K, V> {
  private readonly map = new Map<K, Swr<V>>();

  constructor(
    private readonly make: (key: K) => Swr<V>,
    private readonly max = 32,
  ) {}

  of(key: K): Swr<V> {
    let s = this.map.get(key);
    if (s) {
      this.map.delete(key);
      this.map.set(key, s);
      return s;
    }
    s = this.make(key);
    this.map.set(key, s);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
    return s;
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}
