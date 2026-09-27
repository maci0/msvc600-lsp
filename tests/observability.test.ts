import { describe, it, expect, afterEach } from 'vitest';
import { ValidationRecorder, log, setLogSink, type LogLevel } from '../src/observability';

interface Captured {
  level: LogLevel;
  line: string;
}

function capture(): Captured[] {
  const lines: Captured[] = [];
  setLogSink((level, line) => lines.push({ level, line }));
  return lines;
}

afterEach(() => {
  setLogSink((_level, line) => process.stderr.write(line + '\n'));
});

describe('log', () => {
  it('emits one line per event with the level and fields', () => {
    const lines = capture();
    log('error', 'compiler could not be started', { uri: 'file:///a.c', code: 'ENOENT' }, 1000);

    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('error');
    expect(lines[0].line).toContain('error compiler could not be started');
    expect(lines[0].line).toContain('uri=file:///a.c');
    expect(lines[0].line).toContain('code=ENOENT');
  });

  it('stamps an ISO timestamp so a raw stdio capture is orderable', () => {
    const lines = capture();
    log('info', 'server initialized', {}, Date.UTC(2026, 0, 2, 3, 4, 5));
    expect(lines[0].line.startsWith('2026-01-02T03:04:05.000Z info ')).toBe(true);
  });

  it('quotes values containing whitespace so fields stay parseable', () => {
    const lines = capture();
    log('info', 'server initialized', { clPath: '/home/u/My Docs/CL.EXE' }, 1000);
    expect(lines[0].line).toContain('clPath="/home/u/My Docs/CL.EXE"');
  });

  it('omits undefined fields rather than printing "undefined"', () => {
    const lines = capture();
    log('info', 'validation', { uri: 'file:///a.c', wineExecutable: undefined }, 1000);
    expect(lines[0].line).not.toContain('wineExecutable');
  });

  it('flattens multi-line values so an event never spans two lines', () => {
    const lines = capture();
    log('error', 'validation failed', { error: 'first\nsecond' }, 1000);
    expect(lines[0].line.split('\n')).toHaveLength(1);
    expect(lines[0].line).toContain('error="first second"');
  });

  it('collapses repeats inside the window into a single line', () => {
    const lines = capture();
    for (let i = 0; i < 5; i += 1) {
      log('error', 'compiler could not be started', { code: 'ENOENT' }, 1000 + i * 100);
    }
    expect(lines).toHaveLength(1);
  });

  it('reports the suppressed count on the next occurrence after the window', () => {
    const lines = capture();
    for (let i = 0; i < 3; i += 1) {
      log('error', 'validation failed', { uri: 'file:///c.c' }, 1000 + i * 100);
    }
    log('error', 'validation failed', { uri: 'file:///c.c' }, 1000 + 120_000);

    expect(lines).toHaveLength(2);
    expect(lines[0].line).not.toContain('repeat=');
    expect(lines[1].line).toContain('repeat=2');
  });

  it('collapses repeats that differ only in latency', () => {
    const lines = capture();
    log('error', 'validation failed', { uri: 'file:///d.c', durationMs: 180 }, 2000);
    log('error', 'validation failed', { uri: 'file:///d.c', durationMs: 41 }, 2400);
    expect(lines).toHaveLength(1);
  });

  it('does not collapse different failures into one line', () => {
    const lines = capture();
    log('error', 'validation failed', { uri: 'file:///a.c' }, 1000);
    log('error', 'validation failed', { uri: 'file:///b.c' }, 1100);
    expect(lines).toHaveLength(2);
  });
});

describe('ValidationRecorder', () => {
  it('counts completions and keeps the slowest run', () => {
    const recorder = new ValidationRecorder(0);
    recorder.recordStart();
    recorder.recordCompletion(120, false, 1000);
    recorder.recordStart();
    recorder.recordCompletion(900, false, 2000);

    const stats = recorder.snapshot(3000);
    expect(stats.started).toBe(2);
    expect(stats.completed).toBe(2);
    expect(stats.maxDurationMs).toBe(900);
    expect(stats.lastDurationMs).toBe(900);
    expect(stats.lastSuccessAt).toBe(new Date(2000).toISOString());
  });

  it('separates aborts from failures', () => {
    const recorder = new ValidationRecorder(0);
    recorder.recordAbort();
    recorder.recordAbort();
    recorder.recordFailure('spawn', 'ENOENT', 1000);

    const stats = recorder.snapshot(2000);
    expect(stats.aborted).toBe(2);
    expect(stats.failed).toBe(1);
    expect(stats.timedOut).toBe(0);
    expect(stats.lastFailure).toBe('spawn: ENOENT');
    expect(stats.lastFailureAt).toBe(new Date(1000).toISOString());
  });

  it('counts timeouts separately from other failures', () => {
    const recorder = new ValidationRecorder(0);
    recorder.recordFailure('timeout', 'killed after 30s', 1000);
    expect(recorder.snapshot(2000).timedOut).toBe(1);
  });

  it('counts truncated output separately from failures', () => {
    const recorder = new ValidationRecorder(0);
    recorder.recordCompletion(50, true, 1000);
    const stats = recorder.snapshot(2000);
    expect(stats.truncated).toBe(1);
    expect(stats.failed).toBe(0);
  });

  it('reports uptime from construction time', () => {
    const recorder = new ValidationRecorder(1000);
    expect(recorder.snapshot(4500).uptimeMs).toBe(3500);
  });
});
