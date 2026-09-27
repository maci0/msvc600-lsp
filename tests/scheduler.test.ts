import { describe, it, expect } from 'vitest';
import { createDebouncer, realScheduler, Scheduler } from '../src/scheduler';

const DEBOUNCE_MS = 300;

/** Scheduler whose clock only moves when a test says so. */
function manualScheduler(): Scheduler & { advance(elapsedMs: number): void } {
  const queue = new Map<() => void, number>();
  return {
    schedule(delayMs: number, task: () => void): () => void {
      queue.set(task, delayMs);
      return () => queue.delete(task);
    },
    advance(elapsedMs: number): void {
      for (const [task, delayMs] of [...queue]) {
        if (delayMs > elapsedMs) continue;
        queue.delete(task);
        task();
      }
    },
  };
}

describe('createDebouncer', () => {
  it('collapses a burst for one key into a single run', () => {
    const scheduler = manualScheduler();
    const debouncer = createDebouncer(scheduler, DEBOUNCE_MS);
    const ran: string[] = [];
    for (const text of ['a', 'ab', 'abc']) {
      debouncer.schedule('file:///a.c', () => ran.push(text));
    }
    scheduler.advance(DEBOUNCE_MS);
    expect(ran).toEqual(['abc']);
  });

  it('keeps one run per key and fires them in scheduling order', () => {
    const scheduler = manualScheduler();
    const debouncer = createDebouncer(scheduler, DEBOUNCE_MS);
    const ran: string[] = [];
    debouncer.schedule('file:///a.c', () => ran.push('a'));
    debouncer.schedule('file:///b.c', () => ran.push('b'));
    debouncer.schedule('file:///a.c', () => ran.push('a2'));
    expect([...debouncer.pendingKeys].sort()).toEqual(['file:///a.c', 'file:///b.c']);

    scheduler.advance(DEBOUNCE_MS);
    expect(ran).toEqual(['b', 'a2']);
    expect(debouncer.pendingKeys.size).toBe(0);
  });

  it('drops the pending run when the key is cancelled', () => {
    const scheduler = manualScheduler();
    const debouncer = createDebouncer(scheduler, DEBOUNCE_MS);
    const ran: string[] = [];
    debouncer.schedule('file:///a.c', () => ran.push('a'));
    debouncer.cancel('file:///a.c');
    scheduler.advance(DEBOUNCE_MS);
    expect(ran).toEqual([]);
    expect(debouncer.pendingKeys.size).toBe(0);
  });

  it('drops every pending run on cancelAll', () => {
    const scheduler = manualScheduler();
    const debouncer = createDebouncer(scheduler, DEBOUNCE_MS);
    const ran: string[] = [];
    debouncer.schedule('file:///a.c', () => ran.push('a'));
    debouncer.schedule('file:///b.c', () => ran.push('b'));
    debouncer.cancelAll();
    scheduler.advance(DEBOUNCE_MS);
    expect(ran).toEqual([]);
  });

  it('coalesces a real-time burst into one run', async () => {
    const debouncer = createDebouncer(realScheduler, 10);
    const ran: string[] = [];
    debouncer.schedule('file:///a.c', () => ran.push('a'));
    debouncer.schedule('file:///a.c', () => ran.push('b'));
    await new Promise((r) => setTimeout(r, 40));
    expect(ran).toEqual(['b']);
  });
});
