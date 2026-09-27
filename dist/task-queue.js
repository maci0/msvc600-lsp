"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskQueue = void 0;
class TaskQueue {
    concurrency;
    /** Waiting entries, oldest first. */
    queue = [];
    /** Live entry per key, queued or running. The handle used to supersede. */
    byKey = new Map();
    /** Entries currently inside `run`, keyed by an object only this queue holds. */
    running = new Set();
    /** `drained` resolvers, parked until the queue goes idle. */
    waiters = [];
    closed = false;
    constructor(concurrency) {
        if (!Number.isInteger(concurrency) || concurrency < 1) {
            throw new RangeError(`concurrency must be a positive integer, got ${concurrency}`);
        }
        this.concurrency = concurrency;
    }
    /** True while an entry for `key` is queued or running. */
    has(key) {
        return this.byKey.has(key);
    }
    /** True while an entry for `key` is inside `run`. */
    isRunning(key) {
        const entry = this.byKey.get(key);
        return entry !== undefined && this.running.has(entry);
    }
    /** Number of entries waiting for a free slot. */
    get pending() {
        return this.queue.length;
    }
    /**
     * Submits `run` under `key`, aborting whatever the key was doing before.
     * A no-op once the queue is closed.
     */
    submit(key, run) {
        if (this.closed)
            return;
        this.cancel(key);
        const entry = { key, controller: new AbortController(), run };
        this.byKey.set(key, entry);
        this.queue.push(entry);
        this.pump();
    }
    /**
     * Aborts the entry for `key`, queued or running, and forgets it. Safe to
     * call for a key that is not in the queue.
     */
    cancel(key) {
        const entry = this.byKey.get(key);
        if (!entry)
            return;
        this.byKey.delete(key);
        entry.controller.abort();
        const queuedAt = this.queue.indexOf(entry);
        if (queuedAt !== -1)
            this.queue.splice(queuedAt, 1);
    }
    /**
     * Aborts every entry and refuses further submissions. Running tasks are
     * cancelled, not awaited; callers that need the children reaped should await
     * {@link drained} first.
     */
    close() {
        if (this.closed)
            return;
        this.closed = true;
        for (const key of [...this.byKey.keys()])
            this.cancel(key);
    }
    /**
     * Resolves once nothing is queued or running. Callers must not hold the
     * event loop in a way that starves the runners' own I/O.
     */
    drained() {
        if (this.isIdle())
            return Promise.resolve();
        return new Promise((resolve) => {
            this.waiters.push(resolve);
        });
    }
    isIdle() {
        return this.queue.length === 0 && this.running.size === 0;
    }
    pump() {
        while (this.running.size < this.concurrency && this.queue.length > 0) {
            const entry = this.queue.shift();
            // Cancelled between submission and dispatch: drop it. The identity check
            // keeps a newer entry for the same key from being discarded with it.
            if (this.byKey.get(entry.key) !== entry)
                continue;
            this.running.add(entry);
            this.dispatch(entry);
        }
        this.settleWaiters();
    }
    dispatch(entry) {
        // The runner owns its own rejection; letting it through would make a
        // transient compile failure an unhandled rejection. Swallow it here so
        // `finish` runs exactly once either way.
        void entry
            .run(entry.controller.signal)
            .catch(() => undefined)
            .then(() => this.finish(entry));
    }
    finish(entry) {
        this.running.delete(entry);
        if (this.byKey.get(entry.key) === entry)
            this.byKey.delete(entry.key);
        this.pump();
    }
    settleWaiters() {
        if (!this.isIdle())
            return;
        const settled = this.waiters;
        this.waiters = [];
        for (const resolve of settled)
            resolve();
    }
}
exports.TaskQueue = TaskQueue;
//# sourceMappingURL=task-queue.js.map