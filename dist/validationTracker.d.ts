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
export declare class ValidationTracker {
    private nextToken;
    /** Newest token per URI. Absent means "closed", which reads as stale. */
    private readonly current;
    /** Abort controller of the newest run per URI, used to cancel stale work. */
    private readonly controllers;
    /**
     * Registers a run for `uri`, aborting and invalidating any run already in
     * flight for it. The caller must pass the returned signal to the work and
     * hand the returned controller back to {@link end} when it settles.
     */
    begin(uri: string): {
        token: number;
        controller: AbortController;
    };
    /** True when `token` is still the newest run registered for `uri`. */
    isCurrent(uri: string, token: number): boolean;
    /** Releases the abort controller, unless a newer run has taken it over. */
    end(uri: string, controller: AbortController): void;
    /** Aborts the in-flight run for `uri` and marks it closed. */
    close(uri: string): void;
    private abort;
}
//# sourceMappingURL=validationTracker.d.ts.map