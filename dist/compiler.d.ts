import { Msvc6Config } from './config';
import { TempFileStore } from './tempfile';
/** Options for the entry points that stage document text on disk. */ export interface TempFileOptions {
    /** Filesystem boundary to write through. Defaults to the real temp directory. */
    store?: TempFileStore;
}
/**
 * Concurrent CL.EXE children allowed at once. Each one is a heavyweight process
 * (a full Wine services startup on non-Windows), so the number is kept at the
 * parallelism a developer machine absorbs; the rest queue rather than dropping.
 * The server's task queue happens to admit the same number, but the cap is
 * this function's own contract: a caller outside that queue still gets a
 * bounded number of children.
 */
export declare const MAX_CONCURRENT_CHECKS = 2;
/** Wall-clock limit for one CL.EXE run before the process is killed. */
export declare const COMPILE_TIMEOUT_MS = 30000;
/** Cap on captured stdout and stderr, per stream. */
export declare const MAX_OUTPUT_BYTES: number;
/** Result of a CL.EXE syntax-check invocation. */
export interface CompileResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    /** Combined stdout + stderr for diagnostic parsing. */
    rawOutput: string;
    /** True when output was truncated (maxBuffer exceeded). Diagnostics may be incomplete. */
    truncated: boolean;
    /**
     * True when CL.EXE was killed after `checkTimeoutMs`. The exit code and
     * output are then meaningless: no diagnostic in `rawOutput` was produced
     * by a completed run, and a missing diagnostic means the check timed out,
     * not that the file is clean.
     */
    timedOut: boolean;
    /**
     * The signal that terminated CL.EXE, when a signal other than this server's
     * own timeout kill ended the run (an out-of-memory kill, a `SIGKILL` from
     * an operator, a crash under Wine). The child never reached a completed run,
     * so its output is a prefix of the diagnostics at best and the exit code
     * carries no meaning. `null` for every run that was killed by the configured
     * timeout, which is reported as {@link CompileResult.timedOut} instead.
     */
    killedBySignal: string | null;
}
/**
 * Builds the CL.EXE argument list for a syntax-only check.
 * Selects /TC (C) or /TP (C++) based on file extension.
 */
export declare function buildArgs(config: Msvc6Config, filePath: string): string[];
/**
 * Runs CL.EXE in syntax-check mode (`/Zs`) on the given file.
 *
 * At most {@link MAX_CONCURRENT_CHECKS} children run at once; the rest queue,
 * so a burst of open documents cannot spawn an unbounded number of Wine
 * processes. A queued check whose signal aborts leaves the queue without ever
 * taking a slot.
 *
 * Always resolves — compiler errors are reported via `exitCode` and
 * `rawOutput`, not via promise rejection. Rejects only when no check could
 * be attempted at all: the executable could not be spawned (ENOENT, EACCES,
 * ENOTDIR), the call was aborted, or `outputEncoding` is not a known label.
 * A run that was killed by `timeoutMs` resolves with `timedOut: true` and an
 * exit code that carries no diagnostic meaning. A run ended by any other
 * signal resolves with `killedBySignal` naming it.
 */
export declare function syntaxCheck(config: Msvc6Config, filePath: string, opts?: {
    signal?: AbortSignal;
    timeoutMs?: number;
}): Promise<CompileResult>;
/**
 * Writes `content` to a temp file and runs a syntax check on it.
 * The temp file is cleaned up after the check completes.
 *
 * Exported for the test suite; the server stages its own scratch source through
 * `createTempSource` so it can abort stale checks.
 */
export declare function syntaxCheckContent(config: Msvc6Config, content: string, languageId: string, opts?: TempFileOptions): Promise<CompileResult & {
    tempFile: string;
}>;
//# sourceMappingURL=compiler.d.ts.map