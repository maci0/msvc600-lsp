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
 * Writes `content` to a uniquely named, owner-only temp file and returns its path.
 *
 * The caller owns the file and must pass it to {@link removeTempFile}.
 */
export declare function createTempFile(content: string, langId: 'c' | 'cpp'): string;
/**
 * Deletes a temp file, retrying briefly while a killed Wine process releases it.
 *
 * A plain `unlinkSync` fails with EBUSY/EPERM while the compiler it belongs to
 * is still shutting down, and an aborted run hits that path on every edit —
 * each failure would strand one file in the temp directory for the session.
 * `force` makes an already-removed file a no-op.
 */
export declare function removeTempFile(filePath: string): void;
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