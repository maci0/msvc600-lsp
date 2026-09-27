import { describe, it, expect } from 'vitest';
import { TaskQueue } from '../src/task-queue';

/** Yields to the event loop so queued promise callbacks run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A promise plus the handles to settle it from the test body. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('TaskQueue', () => {
  describe('constructor', () => {
    it('rejects a non-positive or fractional concurrency', () => {
      expect(() => new TaskQueue(0)).toThrow(RangeError);
      expect(() => new TaskQueue(-1)).toThrow(RangeError);
      expect(() => new TaskQueue(1.5)).toThrow(RangeError);
    });
  });

  describe('concurrency bound', () => {
    it('starts at most `concurrency` tasks and holds the rest', async () => {
      const queue = new TaskQueue(2);
      const gates = [deferred(), deferred(), deferred(), deferred(), deferred()];
      let started = 0;

      gates.forEach((gate, i) => {
        queue.submit(`key-${i}`, async (signal) => {
          started++;
          expect(signal.aborted).toBe(false);
          await gate.promise;
        });
      });

      await flush();
      expect(started).toBe(2);
      expect(queue.pending).toBe(3);

      gates[0].resolve();
      await flush();
      expect(started).toBe(3);

      for (const gate of gates) gate.resolve();
      await flush();
      expect(started).toBe(5);
      expect(queue.pending).toBe(0);
    });

    it('frees the slot when a task rejects', async () => {
      const queue = new TaskQueue(1);
      const failed = deferred();
      let started = 0;

      queue.submit('bad', () => failed.promise);
      queue.submit('good', async () => {
        started++;
      });

      await flush();
      expect(started).toBe(0);

      failed.reject(new Error('compile blew up'));
      await flush();
      expect(started).toBe(1);
    });
  });

  describe('superseding a key', () => {
    it('aborts the running entry, which then publishes nothing', async () => {
      const queue = new TaskQueue(2);
      const first = deferred();
      const published: string[] = [];

      // The runner pattern `runValidation` relies on: re-check the signal once
      // the awaited work returns, and the superseded result is dropped.
      queue.submit('doc', async (signal) => {
        await first.promise;
        if (signal.aborted) return;
        published.push('stale');
      });

      await flush();
      queue.submit('doc', async () => {
        published.push('fresh');
      });

      first.resolve();
      await flush();
      expect(published).toEqual(['fresh']);
    });

    it('drops a queued entry without ever running it', async () => {
      const queue = new TaskQueue(1);
      const blocker = deferred();
      const ran: string[] = [];

      queue.submit('blocker', () => blocker.promise);
      queue.submit('doc', async () => {
        ran.push('stale');
      });
      await flush();
      expect(queue.pending).toBe(1);

      // Superseding the queued entry swaps it in place; it still waits its turn.
      queue.submit('doc', async () => {
        ran.push('fresh');
      });
      await flush();
      expect(queue.pending).toBe(1);

      blocker.resolve();
      await flush();
      expect(ran).toEqual(['fresh']);
    });

    it('leaves a newer entry in charge when an older one settles', async () => {
      const queue = new TaskQueue(1);
      const blocker = deferred();
      const seen: boolean[] = [];

      queue.submit('blocker', () => blocker.promise);
      queue.submit('doc', async (signal) => {
        seen.push(signal.aborted);
      });

      await flush();
      blocker.resolve();
      await flush();
      expect(seen).toEqual([false]);
      expect(queue.pending).toBe(0);
      await queue.drained();
    });

    it('keeps the backlog in submission order when a middle entry is superseded', async () => {
      const queue = new TaskQueue(1);
      const blocker = deferred();
      const ran: string[] = [];

      queue.submit('blocker', () => blocker.promise);
      for (const key of ['a', 'b', 'c', 'd', 'e']) {
        queue.submit(key, async () => {
          ran.push(key);
        });
      }
      await flush();
      expect(queue.pending).toBe(5);

      // Superseding 'c' drops the stale entry and queues its replacement at the
      // back, leaving every other entry where it was.
      queue.submit('c', async () => {
        ran.push('c-fresh');
      });
      await flush();
      expect(queue.pending).toBe(5);

      blocker.resolve();
      await queue.drained();
      expect(ran).toEqual(['a', 'b', 'd', 'e', 'c-fresh']);
    });
  });

  describe('cancel', () => {
    it('aborts a running entry and removes a queued one', async () => {
      const queue = new TaskQueue(1);
      const running = deferred();
      let runningAborted = false;
      const ran: string[] = [];

      queue.submit('running', async (signal) => {
        signal.addEventListener('abort', () => {
          runningAborted = true;
        });
        await running.promise;
      });
      queue.submit('queued', async () => {
        ran.push('queued');
      });

      await flush();
      queue.cancel('running');
      queue.cancel('queued');
      expect(runningAborted).toBe(true);
      expect(queue.pending).toBe(0);

      running.resolve();
      await flush();
      expect(ran).toEqual([]);
    });

    it('is a no-op for a key the queue never saw', () => {
      const queue = new TaskQueue(1);
      expect(() => queue.cancel('absent')).not.toThrow();
    });
  });

  describe('close', () => {
    it('aborts everything, refuses new work, and drains', async () => {
      const queue = new TaskQueue(2);
      const running = [deferred(), deferred()];
      const ran: string[] = [];
      let drained = false;

      running.forEach((gate, i) => {
        queue.submit(`key-${i}`, async (signal) => {
          ran.push(`start-${i}:${signal.aborted}`);
          await gate.promise;
        });
      });
      queue.submit('queued', async (signal) => {
        ran.push(`start-q:${signal.aborted}`);
      });

      await flush();
      queue.close();
      void queue.drained().then(() => {
        drained = true;
      });

      queue.submit('after-close', async () => {
        ran.push('after-close');
      });
      await flush();
      expect(ran).toEqual(['start-0:false', 'start-1:false']);
      expect(drained).toBe(false);

      running[0].resolve();
      running[1].resolve();
      await flush();
      expect(drained).toBe(true);
    });

    it('resolves drained immediately when nothing was ever submitted', async () => {
      await expect(new TaskQueue(1).drained()).resolves.toBeUndefined();
    });
  });
});
