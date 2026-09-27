/**
 * Delayed-work boundary.
 *
 * The debounce that coalesces editor keystrokes is the only place the server's
 * behavior depends on elapsed wall-clock time: how many validations a burst of
 * edits produces, and which one wins, are decided by the timer. Keeping it
 * behind this interface lets a test step that timer explicitly instead of
 * sleeping in real time.
 */
export interface Scheduler {
  /** Runs `task` after `delayMs`. Returns a function that cancels it. */
  schedule(delayMs: number, task: () => void): () => void;
}

/** {@link Scheduler} backed by the platform timer. */
export const realScheduler: Scheduler = {
  schedule(delayMs: number, task: () => void): () => void {
    const handle = setTimeout(task, delayMs);
    return () => clearTimeout(handle);
  },
};

/** Keyed one-shot debounce over a {@link Scheduler}. */
export interface Debouncer {
  /** Arms the timer for `key`; only the most recent call within the delay runs `task`. */
  schedule(key: string, task: () => void): void;
  /** Drops the pending task for `key`, if any. */
  cancel(key: string): void;
  /** Drops every pending task. */
  cancelAll(): void;
  /** Keys with a pending task. */
  readonly pendingKeys: ReadonlySet<string>;
}

/**
 * Coalesces repeated calls for the same key so only the last one runs.
 *
 * A burst of keystrokes for one document is one validation; an edit that is
 * immediately superseded, saved, or closed costs nothing.
 */
export function createDebouncer(scheduler: Scheduler, delayMs: number): Debouncer {
  const cancels = new Map<string, () => void>();

  const cancel = (key: string): void => {
    const pending = cancels.get(key);
    if (pending) pending();
    cancels.delete(key);
  };

  return {
    schedule(key: string, task: () => void): void {
      cancel(key);
      const disarm = scheduler.schedule(delayMs, () => {
        cancels.delete(key);
        task();
      });
      cancels.set(key, disarm);
    },
    cancel,
    cancelAll(): void {
      for (const disarm of cancels.values()) disarm();
      cancels.clear();
    },
    get pendingKeys(): ReadonlySet<string> {
      return new Set(cancels.keys());
    },
  };
}
