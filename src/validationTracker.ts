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
export class ValidationTracker {
  private nextToken = 1;

  /** Newest token per URI. Absent means "closed", which reads as stale. */
  private readonly current = new Map<string, number>();

  /** Abort controller of the newest run per URI, used to cancel stale work. */
  private readonly controllers = new Map<string, AbortController>();

  /**
   * Registers a run for `uri`, aborting and invalidating any run already in
   * flight for it. The caller must pass the returned signal to the work and
   * hand the returned controller back to {@link end} when it settles.
   */
  begin(uri: string): { token: number; controller: AbortController } {
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
  isCurrent(uri: string, token: number): boolean {
    return this.current.get(uri) === token;
  }

  /** Releases the abort controller, unless a newer run has taken it over. */
  end(uri: string, controller: AbortController): void {
    if (this.controllers.get(uri) === controller) {
      this.controllers.delete(uri);
    }
  }

  /** Aborts the in-flight run for `uri` and marks it closed. */
  close(uri: string): void {
    this.abort(uri);
    this.controllers.delete(uri);
    this.current.delete(uri);
  }

  private abort(uri: string): void {
    const controller = this.controllers.get(uri);
    if (controller) controller.abort();
  }
}
