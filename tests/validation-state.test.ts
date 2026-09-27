import { describe, it, expect } from 'vitest';
import { ValidationSequencer } from '../src/validation-state';

const URI_A = 'file:///tmp/a.c';
const URI_B = 'file:///tmp/b.c';

describe('ValidationSequencer', () => {
  it('marks the first handle current', () => {
    const seq = new ValidationSequencer();
    expect(seq.begin(URI_A).isCurrent()).toBe(true);
  });

  it('supersedes an earlier handle for the same URI', () => {
    const seq = new ValidationSequencer();
    const first = seq.begin(URI_A);
    const second = seq.begin(URI_A);

    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);
  });

  it('keeps each URI independent', () => {
    const seq = new ValidationSequencer();
    const a = seq.begin(URI_A);
    seq.begin(URI_B);

    expect(a.isCurrent()).toBe(true);
  });

  it('retires a handle when its document closes', () => {
    const seq = new ValidationSequencer();
    const handle = seq.begin(URI_A);
    seq.close(URI_A);

    expect(handle.isCurrent()).toBe(false);
  });

  it('does not let a pre-close result publish after a reopen', () => {
    const seq = new ValidationSequencer();
    const beforeClose = seq.begin(URI_A);
    seq.close(URI_A);
    const afterReopen = seq.begin(URI_A);

    expect(afterReopen.isCurrent()).toBe(true);
    expect(beforeClose.isCurrent()).toBe(false);
  });

  it('survives repeated close/open cycles on the same URI', () => {
    const seq = new ValidationSequencer();
    const handles = [];
    for (let i = 0; i < 5; i++) {
      handles.push(seq.begin(URI_A));
      seq.close(URI_A);
    }
    const reopened = seq.begin(URI_A);

    expect(handles.every((h) => !h.isCurrent())).toBe(true);
    expect(reopened.isCurrent()).toBe(true);
  });

  it('issues a strictly higher generation for a repeated validation', () => {
    const seq = new ValidationSequencer();
    const first = seq.begin(URI_A);
    const second = seq.begin(URI_A);

    expect(second.generation).toBeGreaterThan(first.generation);
  });

  it('keeps generations unique across URIs and restarts', () => {
    const seq = new ValidationSequencer();
    const seen = new Set<number>();
    for (const uri of [URI_A, URI_B, URI_A, URI_B]) {
      seen.add(seq.begin(uri).generation);
    }
    seq.close(URI_A);
    seen.add(seq.begin(URI_A).generation);

    expect(seen.size).toBe(5);
  });

  it('publishes nothing for a handle from the previous open once revalidated twice', () => {
    const seq = new ValidationSequencer();
    const stale = seq.begin(URI_A);
    seq.close(URI_A);
    seq.begin(URI_A);
    const latest = seq.begin(URI_A);

    expect(stale.isCurrent()).toBe(false);
    expect(latest.isCurrent()).toBe(true);
  });
});
