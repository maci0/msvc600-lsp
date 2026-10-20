/**
 * Delayed-work boundary.
 *
 * The debounce that coalesces editor keystrokes is the only place the server's
 * behavior depends on elapsed wall-clock time: how many validations a burst of
 * edits produces, and which one wins, are decided by the timer. Keeping it
 * behind this interface lets a simulated run step that timer explicitly
 * instead of sleeping in real time.
 */
export interface Scheduler {
    /** Runs `task` after `delayMs`. Returns a function that cancels it. */
    schedule(delayMs: number, task: () => void): () => void;
}
/** {@link Scheduler} backed by the platform timer. */
export declare const realScheduler: Scheduler;
/** {@link Scheduler} that never fires on its own; a driver runs the tasks. */
export interface ManualScheduler extends Scheduler {
    /** Delays, in ms, before each pending task would fire. */
    readonly pending: ReadonlyMap<() => void, number>;
    /** Runs every task whose delay is at most `elapsedMs`, in scheduling order. */
    advance(elapsedMs: number): void;
}
/** {@link ManualScheduler} for a run that decides when time passes. */
export declare function createManualScheduler(): ManualScheduler;
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
export declare function createDebouncer(scheduler: Scheduler, delayMs: number): Debouncer;
//# sourceMappingURL=scheduler.d.ts.map