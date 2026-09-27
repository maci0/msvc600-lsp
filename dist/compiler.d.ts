import { Msvc6Config } from './config';
import { TempFileStore } from './tempfile';
/** Upper bound on the source text handed to a syntax check. */
export declare const MAX_SOURCE_BYTES: number;
/**
 * Concurrent CL.EXE children allowed at once; each one is a Wine process, a
 * full services startup on non-Windows. This is the process-wide ceiling: a
 * per-URI queue bounding its own workers must not be raised above it.
 */
export declare const MAX_CONCURRENT_CHECKS = 2;
/** Options for the entry points that stage document text on disk. */
export interface TempFileOptions {
    /** Filesystem boundary to write through. Defaults to the real temp directory. */
    store?: TempFileStore;
}
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
     * True when CL.EXE was killed after `Msvc6Config.checkTimeoutMs`. The exit
     * code and output are then meaningless: no diagnostic in `rawOutput` was
     * produced by a completed run, and a missing diagnostic means the check
     * timed out, not that the file is clean.
     */
    timedOut: boolean;
}
/**
 * Builds the CL.EXE argument list for a syntax-only check.
 * Selects /TC (C) or /TP (C++) based on file extension.
 */
export declare function buildArgs(config: Msvc6Config, filePath: string): string[];
/** Raised when a buffer exceeds {@link MAX_SOURCE_BYTES}. */
export declare class DocumentTooLargeError extends Error {
    readonly byteLength: number;
    constructor(byteLength: number);
}
/**
 * Writes `content` to a fresh temp file with the given extension and returns
 * its path. The caller owns the file and must pass it to
 * {@link removeTempSourceFile}.
 */
export declare function createTempSource(content: string, ext: string): string;
/** Deletes a temp source file. A file that is already gone is not an error. */
export declare function removeTempSourceFile(tempFile: string): void;
/**
 * Runs CL.EXE in syntax-check mode (`/Zs`) on the given file.
 *
 * At most {@link MAX_CONCURRENT_CHECKS} children run at once; the rest queue,
 * so a burst of open documents cannot spawn an unbounded number of Wine
 * processes. A queued check whose signal aborts is dropped before it starts.
 *
 * Always resolves — compiler errors are reported via `exitCode` and
 * `rawOutput`, not via promise rejection. Rejects only when no check could
 * be attempted at all: the executable could not be spawned (ENOENT, EACCES,
 * ENOTDIR), the call was aborted, or `outputEncoding` is not a known label.
 * A run that was killed by `timeoutMs` resolves with `timedOut: true` and an
 * exit code that carries no diagnostic meaning.
 */
export declare function syntaxCheck(config: Msvc6Config, filePath: string, opts?: {
    signal?: AbortSignal;
    timeoutMs?: number;
}): Promise<CompileResult>;
/**
 * Deletes scratch sources left behind by a run that was killed before its
 * cleanup, and returns the paths removed. A server that is restarted after a
 * crash otherwise accumulates one orphaned file per interrupted check, and no
 * later run ever reclaims them. Removing only files older than
 * {@link STALE_TEMP_MIN_AGE_MS} keeps this safe alongside a concurrently
 * running server; running it twice in a row removes nothing the second time.
 */
export declare function sweepStaleTempFiles(now?: number): string[];
/**
 * Drops a leading U+FEFF. Editors hand buffers over with a UTF-8 BOM intact,
 * and MSVC6 lexes those three bytes as source, reporting an error on the
 * first declaration of an otherwise valid file.
 */
export declare function stripByteOrderMark(content: string): string;
/**
 * Writes `content` to a temp file and runs a syntax check on it.
 * The temp file is cleaned up after the check completes.
 *
 * Exported for the test suite; the server drives {@link createTempSource}
 * itself so it can abort stale checks.
 */
export declare function syntaxCheckContent(config: Msvc6Config, content: string, languageId: string, opts?: TempFileOptions): Promise<CompileResult & {
    tempFile: string;
}>;
//# sourceMappingURL=compiler.d.ts.map