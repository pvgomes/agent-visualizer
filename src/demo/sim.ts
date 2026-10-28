/*
 * A tiny cooperative scheduler on a virtual clock. Each worker is a
 * generator that yields { sleep } or { join } and calls emit() in between;
 * the scheduler always runs the earliest due step (ties in spawn order), so
 * the event sequence depends only on the seed, never on timer jitter. The
 * real-time driver in index.ts just advances the clock.
 */
export type Step = { sleep: number } | { join: Handle[] };
export type Script = Generator<Step, void, void>;

export interface Handle {
  readonly done: boolean;
}

interface Proc extends Handle {
  gen: Script;
  done: boolean;
  joiners: Proc[];
  waitingOn: number;
}

interface Entry {
  due: number;
  order: number;
  proc: Proc;
}

export const sleep = (ms: number): Step => ({ sleep: ms });

export class Sim {
  /** Virtual ms since the demo started. */
  now = 0;
  private queue: Entry[] = [];
  private order = 0;

  spawn(gen: Script, delay = 0): Handle {
    const proc: Proc = { gen, done: false, joiners: [], waitingOn: 0 };
    this.schedule(proc, delay);
    return proc;
  }

  nextDue(): number | undefined {
    return this.queue[0]?.due;
  }

  /** Run every step due at or before t. */
  runUntil(t: number): void {
    for (let guard = 0; this.queue.length && this.queue[0]!.due <= t && guard < 100_000; guard++) {
      const { due, proc } = this.queue.shift()!;
      this.now = Math.max(this.now, due);
      this.step(proc);
    }
  }

  private step(proc: Proc): void {
    let r: IteratorResult<Step, void>;
    try {
      r = proc.gen.next();
    } catch {
      r = { done: true, value: undefined };
    }
    if (r.done) {
      proc.done = true;
      for (const j of proc.joiners) if (--j.waitingOn === 0) this.schedule(j, 0);
      proc.joiners = [];
      return;
    }
    const y = r.value;
    if ("sleep" in y) {
      this.schedule(proc, Math.max(1, y.sleep));
      return;
    }
    const pending = y.join.filter((h) => !h.done) as Proc[];
    if (!pending.length) return this.schedule(proc, 0);
    proc.waitingOn = pending.length;
    for (const p of pending) p.joiners.push(proc);
  }

  private schedule(proc: Proc, delay: number): void {
    const e: Entry = { due: this.now + delay, order: this.order++, proc };
    let lo = 0;
    let hi = this.queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const q = this.queue[mid]!;
      if (q.due < e.due || (q.due === e.due && q.order < e.order)) lo = mid + 1;
      else hi = mid;
    }
    this.queue.splice(lo, 0, e);
  }
}
