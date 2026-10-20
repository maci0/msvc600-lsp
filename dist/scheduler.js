"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.realScheduler = void 0;
exports.createManualScheduler = createManualScheduler;
exports.createDebouncer = createDebouncer;
/** {@link Scheduler} backed by the platform timer. */
exports.realScheduler = {
    schedule(delayMs, task) {
        const handle = setTimeout(task, delayMs);
        return () => clearTimeout(handle);
    },
};
/** {@link ManualScheduler} for a run that decides when time passes. */
function createManualScheduler() {
    const queue = new Map();
    return {
        pending: queue,
        schedule(delayMs, task) {
            queue.set(task, delayMs);
            return () => queue.delete(task);
        },
        advance(elapsedMs) {
            for (const [task, delayMs] of [...queue]) {
                if (delayMs > elapsedMs)
                    continue;
                queue.delete(task);
                task();
            }
        },
    };
}
/**
 * Coalesces repeated calls for the same key so only the last one runs.
 *
 * A burst of keystrokes for one document is one validation; an edit that is
 * immediately superseded, saved, or closed costs nothing.
 */
function createDebouncer(scheduler, delayMs) {
    const cancels = new Map();
    const cancel = (key) => {
        const disarm = cancels.get(key);
        if (disarm)
            disarm();
        cancels.delete(key);
    };
    return {
        schedule(key, task) {
            cancel(key);
            const disarm = scheduler.schedule(delayMs, () => {
                cancels.delete(key);
                task();
            });
            cancels.set(key, disarm);
        },
        cancel,
        cancelAll() {
            for (const disarm of cancels.values())
                disarm();
            cancels.clear();
        },
        get pendingKeys() {
            return new Set(cancels.keys());
        },
    };
}
//# sourceMappingURL=scheduler.js.map