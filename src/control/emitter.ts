/*
 * The listener plumbing the session side shares: a set of callbacks behind
 * Disposable subscriptions, and a latch for one-shot events (exit) that also
 * reaches listeners added after it fired.
 */
import type { Disposable } from "./types.ts";

export class Emitter<T> {
  private fns = new Set<(v: T) => void>();

  on(fn: (v: T) => void): Disposable {
    this.fns.add(fn);
    return { dispose: () => void this.fns.delete(fn) };
  }

  emit(v: T): void {
    for (const fn of [...this.fns]) {
      try {
        fn(v);
      } catch {
        // A broken listener never takes the emitter down with it.
      }
    }
  }

  get size(): number {
    return this.fns.size;
  }

  clear(): void {
    this.fns.clear();
  }
}

/** Fires once; a listener added later is called on the next tick with the same value. */
export class Latch<T> {
  private value: { v: T } | undefined;
  private readonly em = new Emitter<T>();

  on(fn: (v: T) => void): Disposable {
    if (this.value) {
      const { v } = this.value;
      let live = true;
      queueMicrotask(() => live && fn(v));
      return { dispose: () => void (live = false) };
    }
    return this.em.on(fn);
  }

  fire(v: T): void {
    if (this.value) return;
    this.value = { v };
    this.em.emit(v);
    this.em.clear();
  }

  get fired(): boolean {
    return this.value !== undefined;
  }

  get result(): T | undefined {
    return this.value?.v;
  }
}

export const NOOP: Disposable = { dispose() {} };
