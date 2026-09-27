import { describe, it, expect } from 'vitest';
import { Semaphore } from '../src/concurrency';

/** Resolves after `ms`, keeping the event loop alive for pending timers. */
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('Semaphore', () => {
  it('runs no more than the limit concurrently', async () => {
    const sem = new Semaphore(3);
    let running = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 20 }, () =>
        sem.acquire().then(async (release) => {
          running++;
          peak = Math.max(peak, running);
          await delay(1);
          running--;
          release?.();
        }),
      ),
    );

    expect(peak).toBe(3);
    expect(sem.inUse).toBe(0);
  });

  it('hands a freed slot to a queued waiter', async () => {
    const sem = new Semaphore(1);
    const first = await sem.acquire();

    let secondAcquired = false;
    const second = sem.acquire().then((release) => {
      secondAcquired = true;
      return release;
    });

    await delay(1);
    expect(secondAcquired).toBe(false);

    first?.();
    const release = await second;
    expect(secondAcquired).toBe(true);
    expect(sem.inUse).toBe(1);
    release?.();
    expect(sem.inUse).toBe(0);
  });

  it('never lets a new caller barge past a queued waiter', async () => {
    const sem = new Semaphore(1);
    const first = await sem.acquire();
    let secondAcquired = false;
    const second = sem.acquire().then((release) => {
      secondAcquired = true;
      return release;
    });
    await delay(1);

    let thirdAcquired = false;
    const third = sem.acquire().then((release) => {
      thirdAcquired = true;
      return release;
    });
    await delay(1);
    expect(thirdAcquired).toBe(false);

    first?.();
    await delay(1);
    // The released slot goes to the waiter that queued first, not the newest one.
    expect(secondAcquired).toBe(true);
    expect(thirdAcquired).toBe(false);
    (await second)?.();
    await delay(1);
    expect(thirdAcquired).toBe(true);
    (await third)?.();
    expect(sem.inUse).toBe(0);
  });

  it('resolves null when the signal aborts before a slot is served', async () => {
    const sem = new Semaphore(1);
    const held = await sem.acquire();

    const controller = new AbortController();
    const queued = sem.acquire(controller.signal);
    controller.abort();

    expect(await queued).toBeNull();
    expect(sem.inUse).toBe(1);

    held?.();
    expect(sem.inUse).toBe(0);
  });

  it('resolves null for a signal already aborted', async () => {
    const sem = new Semaphore(2);
    expect(await sem.acquire(AbortSignal.abort())).toBeNull();
    expect(sem.inUse).toBe(0);
  });

  it('is a no-op when released twice', async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    release?.();
    release?.();
    expect(sem.inUse).toBe(0);
  });

  it('still serves a waiter after an earlier waiter aborts', async () => {
    const sem = new Semaphore(1);
    const held = await sem.acquire();

    const controller = new AbortController();
    const aborted = sem.acquire(controller.signal);
    const survivor = sem.acquire();
    controller.abort();

    expect(await aborted).toBeNull();
    held?.();
    (await survivor)?.();
    expect(sem.inUse).toBe(0);
  });

  it('clamps a non-positive limit to one', async () => {
    const sem = new Semaphore(0);
    const release = await sem.acquire();
    let secondAcquired = false;
    const second = sem.acquire().then((r) => {
      secondAcquired = true;
      return r;
    });

    await delay(1);
    expect(secondAcquired).toBe(false);
    release?.();
    (await second)?.();
  });
});
