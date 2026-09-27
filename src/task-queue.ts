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
export interface TaskRunner {
  (signal: AbortSignal): Promise<void>;
}

interface QueueEntry {
  readonly key: string;
  readonly controller: AbortController;
  readonly run: TaskRunner;
}

export class TaskQueue {
  readonly concurrency: number;

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

  /** True while an entry for `key` is queued or running. */
  has(key: string): boolean {
    return this.byKey.has(key);
  }

  /** True while an entry for `key` is inside `run`. */
  isRunning(key: string): boolean {
    const entry = this.byKey.get(key);
    return entry !== undefined && this.running.has(entry);
  }

  /** Number of entries waiting for a free slot. */
  get pending(): number {
    return this.queue.length;
  }

  /**
   * Submits `run` under `key`, aborting whatever the key was doing before.
   * A no-op once the queue is closed.
   */
  submit(key: string, run: TaskRunner): void {
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
    // The runner owns its own rejection; letting it through would make a
    // transient compile failure an unhandled rejection. Swallow it here so
    // `finish` runs exactly once either way.
    void entry
      .run(entry.controller.signal)
      .catch(() => undefined)
      .then(() => this.finish(entry));
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
