"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ValidationTracker = void 0;
/**
 * Per-URI registry of in-flight validations.
 *
 * The server is single-threaded, so every mutation below happens between
 * awaits and needs no lock. What the registry does guarantee is that a run
 * which finishes late can always tell whether it is still the newest one for
 * its URI: tokens are drawn from one monotonically increasing sequence and
 * are never reused, including across a close and reopen of the same URI.
 * A per-URI counter that restarts at 1 cannot make that promise — a run left
 * over from a previous session would carry the same number as the run that
 * replaced it and would pass the staleness check.
 */
class ValidationTracker {
    nextToken = 1;
    /** Newest token per URI. Absent means "closed", which reads as stale. */
    current = new Map();
    /** Abort controller of the newest run per URI, used to cancel stale work. */
    controllers = new Map();
    /**
     * Registers a run for `uri`, aborting and invalidating any run already in
     * flight for it. The caller must pass the returned signal to the work and
     * hand the returned controller back to {@link end} when it settles.
     */
    begin(uri) {
        this.abort(uri);
        if (this.nextToken > Number.MAX_SAFE_INTEGER) {
            // Refusing to hand out a token a live run already holds. Dropping the
            // table strands those runs, so they can never publish again.
            this.current.clear();
            this.nextToken = 1;
        }
        const token = this.nextToken++;
        const controller = new AbortController();
        this.current.set(uri, token);
        this.controllers.set(uri, controller);
        return { token, controller };
    }
    /** True when `token` is still the newest run registered for `uri`. */
    isCurrent(uri, token) {
        return this.current.get(uri) === token;
    }
    /** Releases the abort controller, unless a newer run has taken it over. */
    end(uri, controller) {
        if (this.controllers.get(uri) === controller) {
            this.controllers.delete(uri);
        }
    }
    /** Aborts the in-flight run for `uri` and marks it closed. */
    close(uri) {
        this.abort(uri);
        this.controllers.delete(uri);
        this.current.delete(uri);
    }
    abort(uri) {
        const controller = this.controllers.get(uri);
        if (controller)
            controller.abort();
    }
}
exports.ValidationTracker = ValidationTracker;
//# sourceMappingURL=validationTracker.js.map