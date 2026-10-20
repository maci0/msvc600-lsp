/** Releases one held slot. Calling it more than once does nothing. */
export type Release = () => void;
/**
 * A counting semaphore with FIFO hand-off: at most `limit` holders at a time,
 * and a freed slot goes to the waiter that queued first rather than to whoever
 * calls next.
 *
 * Used to bound concurrent CL.EXE children, so every queue discipline that lets
 * a newcomer pass an older waiter would be a fairness bug.
 *
 * A waiter whose signal aborts before it is served resolves to null and leaves
 * the queue, which is what lets a stale check drop out instead of holding the
 * slot it will never use.
 */
export declare class Semaphore {
    private readonly limit;
    private readonly waiters;
    private held;
    /** A limit below one, or one that is not a whole number, is clamped to one. */
    constructor(limit: number);
    /** Slots currently held, including the one a caller is about to release. */
    get inUse(): number;
    /** Waiters queued for a slot. */
    get queued(): number;
    /**
     * Takes a slot, or resolves null when `signal` aborts before one is served.
     */
    acquire(signal?: AbortSignal): Promise<Release | null>;
    private makeRelease;
    private serveNext;
}
//# sourceMappingURL=concurrency.d.ts.map