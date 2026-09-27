/**
 * Observability primitives for the LSP server: single-line structured log
 * lines, repeat suppression, and in-process validation counters.
 *
 * The server has no collector to push to — an operator sees it through the
 * editor's LSP log and through the `msvc6/status` request — so the format is
 * one line per event, key=value pairs only, safe to grep and to parse.
 */

export type LogLevel = 'error' | 'warn' | 'info';

/** Flat field bag rendered as `key=value` pairs after the message. */
export type LogFields = Record<string, string | number | boolean | undefined>;

/** Destination for a rendered log line. Set once by the server at startup. */
export type LogSink = (level: LogLevel, line: string) => void;

/** Identical lines inside this window are collapsed into one with `repeat=N`. */
const REPEAT_WINDOW_MS = 60_000;

/** Upper bound on tracked fingerprints, so distinct errors cannot grow it forever. */
const MAX_TRACKED_FINGERPRINTS = 64;

/** A check slower than this is logged even when it succeeds. */
export const SLOW_VALIDATION_MS = 5_000;

let sink: LogSink = (level, line) => {
  process.stderr.write(line + '\n');
};

/** Replaces the log destination. The server points this at the LSP connection. */
export function setLogSink(next: LogSink): void {
  sink = next;
}

interface RepeatState {
  suppressed: number;
  lastAt: number;
}

const fingerprints = new Map<string, RepeatState>();

/** Collapses newlines so one event never spans two lines in the log. */
function flatten(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/** Values containing whitespace or `=` are quoted so the field stays parseable. */
function renderValue(value: string | number | boolean): string {
  const text = flatten(String(value));
  return /[\s"=]/.test(text) ? JSON.stringify(text) : text;
}

function renderFields(fields: LogFields): string {
  let out = '';
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    out += ` ${key}=${renderValue(value)}`;
  }
  return out;
}

/**
 * Fields that differ between two occurrences of the same underlying problem.
 * They stay in the printed line but not in the fingerprint, so a failure that
 * recurs on every keystroke collapses on what identifies it, not on its latency.
 */
const VOLATILE_FIELDS: ReadonlySet<string> = new Set(['durationMs']);

function fingerprint(level: LogLevel, message: string, fields: LogFields): string {
  const stable: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!VOLATILE_FIELDS.has(key)) stable[key] = value;
  }
  return level + ' ' + message + renderFields(stable);
}

function pruneFingerprints(now: number): void {
  for (const [key, state] of fingerprints) {
    if (now - state.lastAt >= REPEAT_WINDOW_MS) fingerprints.delete(key);
  }
}

/**
 * Emits one log line. Repeats of the same line within {@link REPEAT_WINDOW_MS}
 * are counted, not printed; the next occurrence carries `repeat=<n>`. A
 * misconfigured CL.EXE fails on every keystroke, and uncollapsed that floods
 * the editor's log channel.
 */
export function log(
  level: LogLevel,
  message: string,
  fields: LogFields = {},
  now: number = Date.now(),
): void {
  const key = fingerprint(level, message, fields);
  const previous = fingerprints.get(key);
  pruneFingerprints(now);

  if (previous && now - previous.lastAt < REPEAT_WINDOW_MS) {
    previous.suppressed += 1;
    previous.lastAt = now;
    return;
  }

  const repeat = previous ? previous.suppressed : 0;
  fingerprints.set(key, { suppressed: 0, lastAt: now });
  const stamp = new Date(now).toISOString();
  sink(level, `${stamp} ${level} ${flatten(message)}${repeat > 0 ? renderFields({ repeat }) : ''}${renderFields(fields)}`);
}

export function logError(message: string, fields?: LogFields): void {
  log('error', message, fields);
}

export function logWarn(message: string, fields?: LogFields): void {
  log('warn', message, fields);
}

export function logInfo(message: string, fields?: LogFields): void {
  log('info', message, fields);
}

/** Why a validation did not produce diagnostics from CL.EXE. */
export type FailureKind = 'spawn' | 'timeout' | 'error';

export interface ValidationStats {
  started: number;
  completed: number;
  failed: number;
  aborted: number;
  timedOut: number;
  truncated: number;
  totalDurationMs: number;
  maxDurationMs: number;
  lastDurationMs: number | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailure: string | null;
}

/**
 * Counters for the CL.EXE check path: how many runs, how many failed, and
 * which failure mode dominated. Held in memory only, one process per editor
 * window, so the numbers are cumulative for the server's lifetime.
 */
export class ValidationRecorder {
  private started = 0;
  private completed = 0;
  private failed = 0;
  private aborted = 0;
  private timedOut = 0;
  private truncated = 0;
  private totalDurationMs = 0;
  private maxDurationMs = 0;
  private lastDurationMs: number | null = null;
  private lastSuccessAt: string | null = null;
  private lastFailureAt: string | null = null;
  private lastFailure: string | null = null;

  private readonly since: number;

  constructor(now: number = Date.now()) {
    this.since = now;
  }

  recordStart(): void {
    this.started += 1;
  }

  /** A run that reached CL.EXE and returned, even with a non-zero exit code. */
  recordCompletion(durationMs: number, truncated: boolean, now: number = Date.now()): void {
    this.completed += 1;
    this.totalDurationMs += durationMs;
    this.maxDurationMs = Math.max(this.maxDurationMs, durationMs);
    this.lastDurationMs = durationMs;
    this.lastSuccessAt = new Date(now).toISOString();
    if (truncated) this.truncated += 1;
  }

  recordFailure(kind: FailureKind, detail: string, now: number = Date.now()): void {
    this.failed += 1;
    this.lastFailureAt = new Date(now).toISOString();
    this.lastFailure = `${kind}: ${detail}`;
    if (kind === 'timeout') this.timedOut += 1;
  }

  /** A run cancelled because a newer edit arrived. Expected, not a failure. */
  recordAbort(): void {
    this.aborted += 1;
  }

  snapshot(now: number = Date.now()): ValidationStats & { uptimeMs: number } {
    return {
      started: this.started,
      completed: this.completed,
      failed: this.failed,
      aborted: this.aborted,
      timedOut: this.timedOut,
      truncated: this.truncated,
      totalDurationMs: this.totalDurationMs,
      maxDurationMs: this.maxDurationMs,
      lastDurationMs: this.lastDurationMs,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
      lastFailure: this.lastFailure,
      uptimeMs: now - this.since,
    };
  }
}

/** Process-wide recorder, reset by nothing short of a server restart. */
export const validationStats = new ValidationRecorder();

/** JSON-RPC method an operator or editor script can query for server health. */
export const STATUS_METHOD = 'msvc6/status';

/** Result of {@link STATUS_METHOD}. */
export interface ServerStatus {
  uptimeMs: number;
  validations: ValidationStats;
  compiler: {
    clPath: string;
    wineExecutable: string;
    useWine: boolean;
  };
}
