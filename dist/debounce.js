"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createDebouncer = createDebouncer;
/**
 * Coalesces repeated calls for the same key so only the last one runs. An
 * edit that is immediately superseded, saved, or closed costs nothing.
 */
function createDebouncer(delayMs) {
    const timers = new Map();
    const cancel = (key) => {
        const pending = timers.get(key);
        if (pending !== undefined)
            clearTimeout(pending);
        timers.delete(key);
    };
    return {
        schedule(key, task) {
            cancel(key);
            timers.set(key, setTimeout(() => {
                timers.delete(key);
                task();
            }, delayMs));
        },
        cancel,
        cancelAll() {
            for (const pending of timers.values())
                clearTimeout(pending);
            timers.clear();
        },
        get pendingKeys() {
            return new Set(timers.keys());
        },
    };
}
//# sourceMappingURL=debounce.js.map