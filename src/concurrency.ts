/** Releases a slot previously taken from a {@link Semaphore}. Idempotent. */
export type Release = () => void;

/**
 * Counting semaphore that caps how many tasks run at once.
 *
 * A slot is handed directly from a releasing task to the next waiter, so the
 * number of slots in use never exceeds the limit no matter how many tasks
 * queue up. A queued task that aborts before it is served leaves the queue
 * without taking a slot.
 */
export class Semaphore {
  #limit: number;
  #inUse = 0;
  #waiters: Array<() => void> = [];

  constructor(limit: number) {
    this.#limit = Math.max(1, limit);
  }

  /** Slots currently held (held plus served-but-not-released counts as one). */
  get inUse(): number {
    return this.#inUse;
  }

  /**
   * Takes a slot, waiting for one if the limit is reached.
   *
   * Resolves to a release function, or to `null` when `signal` aborts while
   * the task is still queued. A `null` result means no slot was taken and the
   * caller must not release.
   */
  acquire(signal?: AbortSignal): Promise<Release | null> {
    if (signal?.aborted) return Promise.resolve(null);

    if (this.#inUse < this.#limit && this.#waiters.length === 0) {
      this.#inUse++;
      return Promise.resolve(this.#makeRelease());
    }

    return new Promise<Release | null>((resolve) => {
      const onAbort = (): void => {
        const index = this.#waiters.indexOf(serve);
        if (index >= 0) this.#waiters.splice(index, 1);
        detach();
        resolve(null);
      };
      const detach = (): void => signal?.removeEventListener('abort', onAbort);
      const serve = (): void => {
        detach();
        resolve(this.#makeRelease());
      };

      this.#waiters.push(serve);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  #makeRelease(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#waiters.shift();
      if (next) {
        // Hand the slot over: `inUse` still counts it, now for the waiter.
        next();
      } else {
        this.#inUse--;
      }
    };
  }
}
