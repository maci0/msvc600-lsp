import { describe, it, expect } from 'vitest';
import { ValidationTracker } from '../src/validationTracker';

describe('ValidationTracker', () => {
  it('reports a run as current until a newer one starts', () => {
    const tracker = new ValidationTracker();
    const first = tracker.begin('file:///a.c');

    expect(tracker.isCurrent('file:///a.c', first.token)).toBe(true);

    const second = tracker.begin('file:///a.c');
    expect(tracker.isCurrent('file:///a.c', second.token)).toBe(true);
  });

  it('aborts the run it supersedes', () => {
    const tracker = new ValidationTracker();
    const first = tracker.begin('file:///a.c');
    expect(first.controller.signal.aborted).toBe(false);

    tracker.begin('file:///a.c');
    expect(first.controller.signal.aborted).toBe(true);
  });

  it('leaves runs for other URIs alone', () => {
    const tracker = new ValidationTracker();
    const a = tracker.begin('file:///a.c');
    const b = tracker.begin('file:///b.c');

    expect(tracker.isCurrent('file:///a.c', a.token)).toBe(true);
    expect(a.controller.signal.aborted).toBe(false);
    expect(tracker.isCurrent('file:///b.c', b.token)).toBe(true);
  });

  it('invalidates the run in flight when the document closes', () => {
    const tracker = new ValidationTracker();
    const run = tracker.begin('file:///a.c');

    tracker.close('file:///a.c');

    expect(run.controller.signal.aborted).toBe(true);
    expect(tracker.isCurrent('file:///a.c', run.token)).toBe(false);
  });

  it('does not let a closed run pass the staleness check after a reopen', () => {
    const tracker = new ValidationTracker();
    const beforeClose = tracker.begin('file:///a.c');
    tracker.close('file:///a.c');
    const afterReopen = tracker.begin('file:///a.c');

    // The leftover run from the previous session must not be able to publish
    // over the diagnostics of the one that replaced it.
    expect(beforeClose.token).not.toBe(afterReopen.token);
    expect(tracker.isCurrent('file:///a.c', beforeClose.token)).toBe(false);
  });

  it('never reissues a token, even after many close and reopen cycles', () => {
    const tracker = new ValidationTracker();
    const tokens = new Set<number>();
    for (let i = 0; i < 50; i++) {
      const run = tracker.begin('file:///a.c');
      expect(tokens.has(run.token)).toBe(false);
      tokens.add(run.token);
      tracker.close('file:///a.c');
    }
  });

  it('never reissues a token across URIs', () => {
    const tracker = new ValidationTracker();
    const tokens = new Set<number>();
    for (let i = 0; i < 50; i++) {
      const run = tracker.begin(`file:///file${i}.c`);
      expect(tokens.has(run.token)).toBe(false);
      tokens.add(run.token);
    }
  });

  it('keeps the controller of a newer run when an older one ends', () => {
    const tracker = new ValidationTracker();
    const first = tracker.begin('file:///a.c');
    const second = tracker.begin('file:///a.c');

    tracker.end('file:///a.c', first.controller);

    // The older run settling must not tear down the abort path of the newer one.
    expect(tracker.isCurrent('file:///a.c', second.token)).toBe(true);
    expect(second.controller.signal.aborted).toBe(false);
  });

  it('releases the controller of the run that ends last', () => {
    const tracker = new ValidationTracker();
    const run = tracker.begin('file:///a.c');

    tracker.end('file:///a.c', run.controller);
    tracker.end('file:///a.c', run.controller);

    const next = tracker.begin('file:///a.c');
    expect(next.controller.signal.aborted).toBe(false);
  });

  it('tolerates a close for a URI that has no run in flight', () => {
    const tracker = new ValidationTracker();

    expect(() => tracker.close('file:///never-opened.c')).not.toThrow();
  });
});
