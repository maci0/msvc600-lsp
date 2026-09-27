import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDebouncer } from '../src/debounce';

const DEBOUNCE_MS = 300;
const DELAY_MS = 300;
const KEY_A = 'file:///tmp/a.c';
const KEY_B = 'file:///tmp/b.c';

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

/**
 * Timer-driven: each case advances the fake clock explicitly, so a bug in the
 * coalescing shows up as a wrong count rather than as a test that passes
 * because the machine was slow.
 */
describe('createDebouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs the task once the delay elapses', () => {
    const debouncer = createDebouncer(DELAY_MS);
    const task = vi.fn();

    debouncer.schedule(KEY_A, task);
    expect(task).not.toHaveBeenCalled();

    vi.advanceTimersByTime(DELAY_MS - 1);
    expect(task).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst into the most recent task', () => {
    const debouncer = createDebouncer(DELAY_MS);
    const first = vi.fn();
    const second = vi.fn();
    const third = vi.fn();

    debouncer.schedule(KEY_A, first);
    vi.advanceTimersByTime(200);
    debouncer.schedule(KEY_A, second);
    vi.advanceTimersByTime(200);
    debouncer.schedule(KEY_A, third);

    vi.advanceTimersByTime(DELAY_MS);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(third).toHaveBeenCalledTimes(1);
  });

  it('keeps each key on its own timer', () => {
    const debouncer = createDebouncer(DELAY_MS);
    const a = vi.fn();
    const b = vi.fn();

    debouncer.schedule(KEY_A, a);
    vi.advanceTimersByTime(100);
    debouncer.schedule(KEY_B, b);

    // A's timer expires first, at 300 ms after its own schedule call.
    vi.advanceTimersByTime(200);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('cancel drops the pending task so it never runs', () => {
    const debouncer = createDebouncer(DELAY_MS);
    const task = vi.fn();

    debouncer.schedule(KEY_A, task);
    debouncer.cancel(KEY_A);
    vi.advanceTimersByTime(DELAY_MS * 10);

    expect(task).not.toHaveBeenCalled();
  });

  it('cancel leaves other keys armed', () => {
    const debouncer = createDebouncer(DELAY_MS);
    const a = vi.fn();
    const b = vi.fn();

    debouncer.schedule(KEY_A, a);
    debouncer.schedule(KEY_B, b);
    debouncer.cancel(KEY_A);
    vi.advanceTimersByTime(DELAY_MS);

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('cancel is a no-op for a key that was never scheduled', () => {
    const debouncer = createDebouncer(DELAY_MS);
    expect(() => debouncer.cancel('file:///tmp/absent.c')).not.toThrow();
  });

  it('cancelAll drops every pending task', () => {
    const debouncer = createDebouncer(DELAY_MS);
    const a = vi.fn();
    const b = vi.fn();

    debouncer.schedule(KEY_A, a);
    debouncer.schedule(KEY_B, b);
    debouncer.cancelAll();
    vi.advanceTimersByTime(DELAY_MS * 10);

    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it('cancelAll on an empty debouncer does not throw', () => {
    expect(() => createDebouncer(DELAY_MS).cancelAll()).not.toThrow();
  });

  it('a key can be rescheduled after its task has run', () => {
    const debouncer = createDebouncer(DELAY_MS);
    const first = vi.fn();
    const second = vi.fn();

    debouncer.schedule(KEY_A, first);
    vi.advanceTimersByTime(DELAY_MS);
    debouncer.schedule(KEY_A, second);
    vi.advanceTimersByTime(DELAY_MS);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('a cancelled key can be rescheduled without firing the cancelled task', () => {
    const debouncer = createDebouncer(DELAY_MS);
    const cancelled = vi.fn();
    const armed = vi.fn();

    debouncer.schedule(KEY_A, cancelled);
    debouncer.cancel(KEY_A);
    debouncer.schedule(KEY_A, armed);
    vi.advanceTimersByTime(DELAY_MS);

    expect(cancelled).not.toHaveBeenCalled();
    expect(armed).toHaveBeenCalledTimes(1);
  });
});
