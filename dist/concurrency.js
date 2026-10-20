"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Semaphore = void 0;
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
class Semaphore {
    limit;
    waiters = [];
    held = 0;
    /** A limit below one, or one that is not a whole number, is clamped to one. */
    constructor(limit) {
        this.limit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
    }
    /** Slots currently held, including the one a caller is about to release. */
    get inUse() {
        return this.held;
    }
    /** Waiters queued for a slot. */
    get queued() {
        return this.waiters.length;
    }
    /**
     * Takes a slot, or resolves null when `signal` aborts before one is served.
     */
    acquire(signal) {
        if (signal?.aborted)
            return Promise.resolve(null);
        if (this.held < this.limit && this.waiters.length === 0) {
            this.held += 1;
            return Promise.resolve(this.makeRelease());
        }
        return new Promise((resolve) => {
            const waiter = {
                signal,
                onAbort: () => {
                    const index = this.waiters.indexOf(waiter);
                    if (index !== -1)
                        this.waiters.splice(index, 1);
                    resolve(null);
                },
                resolve,
            };
            this.waiters.push(waiter);
            signal?.addEventListener('abort', waiter.onAbort, { once: true });
        });
    }
    makeRelease() {
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            this.held -= 1;
            this.serveNext();
        };
    }
    serveNext() {
        while (this.held < this.limit && this.waiters.length > 0) {
            const waiter = this.waiters.shift();
            waiter.signal?.removeEventListener('abort', waiter.onAbort);
            if (waiter.signal?.aborted) {
                waiter.resolve(null);
                continue;
            }
            this.held += 1;
            waiter.resolve(this.makeRelease());
        }
    }
}
exports.Semaphore = Semaphore;
//# sourceMappingURL=concurrency.js.map