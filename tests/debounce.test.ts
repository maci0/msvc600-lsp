import { describe, it, expect, vi, afterEach } from 'vitest';
import { createDebouncer } from '../src/debounce';

const DEBOUNCE_MS = 300;

afterEach(() => {
  vi.useRealTimers();
});

describe('createDebouncer', () => {
  it('collapses a burst for one key into a single run', () => {
    vi.useFakeTimers();
    const debouncer = createDebouncer(DEBOUNCE_MS);
    const ran: string[] = [];
    for (const text of ['a', 'ab', 'abc']) {
      debouncer.schedule('file:///a.c', () => ran.push(text));
    }
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(ran).toEqual(['abc']);
  });

  it('keeps one run per key and fires them in scheduling order', () => {
    vi.useFakeTimers();
    const debouncer = createDebouncer(DEBOUNCE_MS);
    const ran: string[] = [];
    debouncer.schedule('file:///a.c', () => ran.push('a'));
    debouncer.schedule('file:///b.c', () => ran.push('b'));
    debouncer.schedule('file:///a.c', () => ran.push('a2'));
    expect([...debouncer.pendingKeys].sort()).toEqual(['file:///a.c', 'file:///b.c']);

    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(ran).toEqual(['b', 'a2']);
    expect(debouncer.pendingKeys.size).toBe(0);
  });

  it('does not fire before the delay elapses', () => {
    vi.useFakeTimers();
    const debouncer = createDebouncer(DEBOUNCE_MS);
    const ran: string[] = [];
    debouncer.schedule('file:///a.c', () => ran.push('a'));
    vi.advanceTimersByTime(DEBOUNCE_MS - 1);
    expect(ran).toEqual([]);
  });

  it('drops the pending run when the key is cancelled', () => {
    vi.useFakeTimers();
    const debouncer = createDebouncer(DEBOUNCE_MS);
    const ran: string[] = [];
    debouncer.schedule('file:///a.c', () => ran.push('a'));
    debouncer.cancel('file:///a.c');
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(ran).toEqual([]);
    expect(debouncer.pendingKeys.size).toBe(0);
  });

  it('cancelling an unscheduled key is a no-op', () => {
    vi.useFakeTimers();
    const debouncer = createDebouncer(DEBOUNCE_MS);
    const ran: string[] = [];
    debouncer.schedule('file:///a.c', () => ran.push('a'));
    debouncer.cancel('file:///b.c');
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(ran).toEqual(['a']);
  });

  it('drops every pending run on cancelAll', () => {
    vi.useFakeTimers();
    const debouncer = createDebouncer(DEBOUNCE_MS);
    const ran: string[] = [];
    debouncer.schedule('file:///a.c', () => ran.push('a'));
    debouncer.schedule('file:///b.c', () => ran.push('b'));
    debouncer.cancelAll();
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(ran).toEqual([]);
    expect(debouncer.pendingKeys.size).toBe(0);
  });
});
