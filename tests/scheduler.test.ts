import { describe, it, expect } from 'vitest';
import { createDebouncer, createManualScheduler, realScheduler } from '../src/scheduler';

const DEBOUNCE_MS = 300;

describe('createManualScheduler', () => {
  it('runs nothing until time is advanced', () => {
    const scheduler = createManualScheduler();
    const ran: string[] = [];
    scheduler.schedule(DEBOUNCE_MS, () => ran.push('a'));
    expect(ran).toEqual([]);
    expect(scheduler.pending.size).toBe(1);
  });

  it('runs only the tasks whose delay has elapsed', () => {
    const scheduler = createManualScheduler();
    const ran: string[] = [];
    scheduler.schedule(100, () => ran.push('fast'));
    scheduler.schedule(500, () => ran.push('slow'));
    scheduler.advance(100);
    expect(ran).toEqual(['fast']);
    scheduler.advance(500);
    expect(ran).toEqual(['fast', 'slow']);
    expect(scheduler.pending.size).toBe(0);
  });

  it('honours the cancel function returned by schedule', () => {
    const scheduler = createManualScheduler();
    const ran: string[] = [];
    const cancel = scheduler.schedule(DEBOUNCE_MS, () => ran.push('a'));
    cancel();
    scheduler.advance(DEBOUNCE_MS);
    expect(ran).toEqual([]);
  });
});

describe('createDebouncer', () => {
  it('collapses a burst for one key into a single run', () => {
    const scheduler = createManualScheduler();
    const debouncer = createDebouncer(scheduler, DEBOUNCE_MS);
    const ran: string[] = [];
    for (const text of ['a', 'ab', 'abc']) {
      debouncer.schedule('file:///a.c', () => ran.push(text));
    }
    scheduler.advance(DEBOUNCE_MS);
    expect(ran).toEqual(['abc']);
  });

  it('keeps one run per key and fires them in scheduling order', () => {
    const scheduler = createManualScheduler();
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
    const scheduler = createManualScheduler();
    const debouncer = createDebouncer(scheduler, DEBOUNCE_MS);
    const ran: string[] = [];
    debouncer.schedule('file:///a.c', () => ran.push('a'));
    debouncer.cancel('file:///a.c');
    scheduler.advance(DEBOUNCE_MS);
    expect(ran).toEqual([]);
    expect(debouncer.pendingKeys.size).toBe(0);
  });

  it('drops every pending run on cancelAll', () => {
    const scheduler = createManualScheduler();
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
