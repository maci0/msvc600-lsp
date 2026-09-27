/** Returns the slot to the semaphore. Calling it twice is a no-op. */
export type Release = () => void;

interface Waiter {
  resolve: (release: Release | null) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * A counting semaphore that hands a freed slot to the waiter that queued first,
 * so a caller arriving late never overtakes one that has been waiting.
 *
 * A waiter whose signal aborts before it is served resolves to null and leaves
 * the queue, which is what lets a stale check drop out instead of holding the
 * slot it will never use.
 */
export class Semaphore {
  /** Slots handed out and not yet released. */
  private used = 0;

  private readonly waiters: Waiter[] = [];

  private readonly limit: number;

  /** A limit below one, or one that is not a whole number, is clamped to one. */
  constructor(limit: number) {
    this.limit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
  }

  /** Slots currently held, including the one a caller is about to release. */
  get inUse(): number {
    return this.used;
  }

  acquire(signal?: AbortSignal): Promise<Release | null> {
    if (signal?.aborted) return Promise.resolve(null);
    if (this.used < this.limit && this.waiters.length === 0) {
      this.used++;
      return Promise.resolve(this.makeRelease());
    }

    return new Promise<Release | null>((resolve) => {
      const waiter: Waiter = { resolve };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          resolve(null);
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private makeRelease(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used--;
      this.serve();
    };
  }

  private serve(): void {
    for (let waiter = this.waiters.shift(); waiter !== undefined; waiter = this.waiters.shift()) {
      if (waiter.signal?.aborted) {
        waiter.resolve(null);
        continue;
      }
      if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort);
      this.used++;
      waiter.resolve(this.makeRelease());
      return;
    }
  }
}
