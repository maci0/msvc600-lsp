/**
 * A bounded, per-key cancellation queue for asynchronous work.
 *
 * Two properties matter for the validation pipeline:
 *
 * - **Bounded concurrency.** At most `concurrency` tasks run at once; the rest
 *   wait. Without this, one `CL.EXE` child is spawned per open document as soon
 *   as their debounce timers expire in the same tick.
 * - **Last writer wins per key.** Submitting a new task under a key aborts the
 *   one already queued or running under it, so a superseded keystroke never
 *   reaches the compiler and never publishes diagnostics.
 *
 * Tasks are aborted, never dropped silently: the runner sees an aborted signal
 * and the caller's `finally` still runs.
 */
export interface TaskRunner {
    (signal: AbortSignal): Promise<void>;
}
export declare class TaskQueue {
    readonly concurrency: number;
    /** Waiting entries, oldest first. */
    private queue;
    /** Live entry per key, queued or running. The handle used to supersede. */
    private byKey;
    /** Entries currently inside `run`, keyed by an object only this queue holds. */
    private running;
    /** `drained` resolvers, parked until the queue goes idle. */
    private waiters;
    private closed;
    constructor(concurrency: number);
    /** True while an entry for `key` is queued or running. */
    has(key: string): boolean;
    /** True while an entry for `key` is inside `run`. */
    isRunning(key: string): boolean;
    /** Number of entries waiting for a free slot. */
    get pending(): number;
    /**
     * Submits `run` under `key`, aborting whatever the key was doing before.
     * A no-op once the queue is closed.
     */
    submit(key: string, run: TaskRunner): void;
    /**
     * Aborts the entry for `key`, queued or running, and forgets it. Safe to
     * call for a key that is not in the queue.
     */
    cancel(key: string): void;
    /**
     * Aborts every entry and refuses further submissions. Running tasks are
     * cancelled, not awaited; callers that need the children reaped should await
     * {@link drained} first.
     */
    close(): void;
    /**
     * Resolves once nothing is queued or running. Callers must not hold the
     * event loop in a way that starves the runners' own I/O.
     */
    drained(): Promise<void>;
    private isIdle;
    private pump;
    private dispatch;
    private finish;
    private settleWaiters;
}
//# sourceMappingURL=task-queue.d.ts.map