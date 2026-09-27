/**
 * Keyed one-shot debounce over the platform timer.
 *
 * A burst of keystrokes for one document must cost one validation, not one per
 * edit: without it, a two-second paste arms a timer per character and every
 * armed timer eventually spawns a CL.EXE child.
 *
 * The debounce is the only place the server's behavior depends on elapsed
 * wall-clock time: how many validations a burst of edits produces, and which
 * one wins, are decided by the timer.
 */
export interface Debouncer {
  /** Arms the timer for `key`; only the most recent call within the delay runs `task`. */
  schedule(key: string, task: () => void): void;
  /** Drops the pending task for `key`, if any. */
  cancel(key: string): void;
  /** Drops every pending task, for a session that is ending or reconfiguring. */
  cancelAll(): void;
  /** Keys with a pending task. */
  readonly pendingKeys: ReadonlySet<string>;
}

/**
 * Coalesces repeated calls for the same key so only the last one runs. An
 * edit that is immediately superseded, saved, or closed costs nothing.
 */
export function createDebouncer(delayMs: number): Debouncer {
  const timers = new Map<string, NodeJS.Timeout>();

  const cancel = (key: string): void => {
    const pending = timers.get(key);
    if (pending !== undefined) clearTimeout(pending);
    timers.delete(key);
  };

  return {
    schedule(key: string, task: () => void): void {
      cancel(key);
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          task();
        }, delayMs),
      );
    },
    cancel,
    cancelAll(): void {
      for (const pending of timers.values()) clearTimeout(pending);
      timers.clear();
    },
    get pendingKeys(): ReadonlySet<string> {
      return new Set(timers.keys());
    },
  };
}
