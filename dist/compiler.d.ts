import { Msvc6Config } from './config';
/** Result of a CL.EXE syntax-check invocation. */
export interface CompileResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    /** Combined stdout + stderr for diagnostic parsing. */
    rawOutput: string;
    /** True when output was truncated (maxBuffer exceeded). Diagnostics may be incomplete. */
    truncated: boolean;
}
/**
 * Builds the CL.EXE argument list for a syntax-only check.
 * Selects /TC (C) or /TP (C++) based on file extension.
 */
export declare function buildArgs(config: Msvc6Config, filePath: string): string[];
/**
 * Runs CL.EXE in syntax-check mode (`/Zs`) on the given file.
 *
 * Always resolves — compiler errors are reported via `exitCode` and
 * `rawOutput`, not via promise rejection. Only rejects when the
 * executable itself cannot be spawned (e.g. ENOENT, EACCES).
 */
export declare function syntaxCheck(config: Msvc6Config, filePath: string, opts?: {
    signal?: AbortSignal;
}): Promise<CompileResult>;
/**
 * Returns a fresh, unused path for a scratch source file. The random name
 * makes two concurrent checks of the same document independent rather than
 * overwriting each other's input.
 */
export declare function createTempSourcePath(languageId: string): string;
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
 * **Public API** — not used internally by the LSP server (which manages its
 * own temp files for abort/stale-result handling), but exported for
 * programmatic consumers who want a simpler one-shot interface.
 */
export declare function syntaxCheckContent(config: Msvc6Config, content: string, languageId: string): Promise<CompileResult & {
    tempFile: string;
}>;
//# sourceMappingURL=compiler.d.ts.map