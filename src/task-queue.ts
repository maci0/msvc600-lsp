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
interface QueueEntry {
  readonly key: string;
  readonly controller: AbortController;
  readonly run: (signal: AbortSignal) => Promise<void>;
}

export class TaskQueue {
  private readonly concurrency: number;

  /** Waiting entries, oldest first. */
  private queue: QueueEntry[] = [];

  /** Live entry per key, queued or running. The handle used to supersede. */
  private byKey = new Map<string, QueueEntry>();

  /** Entries currently inside `run`, keyed by an object only this queue holds. */
  private running = new Set<QueueEntry>();

  /** `drained` resolvers, parked until the queue goes idle. */
  private waiters: Array<() => void> = [];

  private closed = false;

  constructor(concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new RangeError(`concurrency must be a positive integer, got ${concurrency}`);
    }
    this.concurrency = concurrency;
  }

  /** Number of entries waiting for a free slot. */
  get pending(): number {
    return this.queue.length;
  }

  /**
   * Submits `run` under `key`, aborting whatever the key was doing before.
   * A no-op once the queue is closed.
   */
  submit(key: string, run: (signal: AbortSignal) => Promise<void>): void {
    if (this.closed) return;

    this.cancel(key);

    const entry: QueueEntry = { key, controller: new AbortController(), run };
    this.byKey.set(key, entry);
    this.queue.push(entry);
    this.pump();
  }

  /**
   * Aborts the entry for `key`, queued or running, and forgets it. Safe to
   * call for a key that is not in the queue.
   */
  cancel(key: string): void {
    const entry = this.byKey.get(key);
    if (!entry) return;

    this.byKey.delete(key);
    entry.controller.abort();

    const queuedAt = this.queue.indexOf(entry);
    if (queuedAt !== -1) this.queue.splice(queuedAt, 1);
  }

  /**
   * Aborts every entry and refuses further submissions. Running tasks are
   * cancelled, not awaited; callers that need the children reaped should await
   * {@link drained} first.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const key of [...this.byKey.keys()]) this.cancel(key);
  }

  /**
   * Resolves once nothing is queued or running. Callers must not hold the
   * event loop in a way that starves the runners' own I/O.
   */
  drained(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private isIdle(): boolean {
    return this.queue.length === 0 && this.running.size === 0;
  }

  private pump(): void {
    while (this.running.size < this.concurrency && this.queue.length > 0) {
      const entry = this.queue.shift()!;

      // Cancelled between submission and dispatch: drop it. The identity check
      // keeps a newer entry for the same key from being discarded with it.
      if (this.byKey.get(entry.key) !== entry) continue;

      this.running.add(entry);
      this.dispatch(entry);
    }
    this.settleWaiters();
  }

  private dispatch(entry: QueueEntry): void {
    void this.settle(entry);
  }

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
  private async settle(entry: QueueEntry): Promise<void> {
    try {
      await entry.run(entry.controller.signal);
    } catch {
      // The runner owns its own reporting; a rejection surfacing here would
      // make a transient compile failure an unhandled rejection.
    } finally {
      this.finish(entry);
    }
  }

  private finish(entry: QueueEntry): void {
    this.running.delete(entry);
    if (this.byKey.get(entry.key) === entry) this.byKey.delete(entry.key);
    this.pump();
  }

  private settleWaiters(): void {
    if (!this.isIdle()) return;
    const settled = this.waiters;
    this.waiters = [];
    for (const resolve of settled) resolve();
  }
}
