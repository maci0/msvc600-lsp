export declare class TaskQueue {
    private readonly concurrency;
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
    /** Number of entries waiting for a free slot. */
    get pending(): number;
    /**
     * Submits `run` under `key`, aborting whatever the key was doing before.
     * A no-op once the queue is closed.
     */
    submit(key: string, run: (signal: AbortSignal) => Promise<void>): void;
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
    /**
     * Runs `entry` and releases its slot however it ends.
     *
     * The call sits inside the `try` so a runner that throws before returning a
     * promise is treated the same as one that returns a rejected promise. Both
     * shapes are the same failure to this queue: a slot held by an entry that
     * will never settle wedges every later submission and leaves `drained()`
     * pending forever. Letting the throw escape would also surface it in the
     * caller's `submit`, which is an LSP message handler.
     */
    private settle;
    private finish;
    private settleWaiters;
}
//# sourceMappingURL=task-queue.d.ts.map