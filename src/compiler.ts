import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Msvc6Config, CPP_EXTENSIONS, C_EXTENSIONS, toWinePath } from './config';

/** Retries the unlink: a just-killed Wine process can still hold the file open. */
const TEMP_UNLINK_MAX_RETRIES = 3;
const TEMP_UNLINK_RETRY_DELAY_MS = 25;

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
export function buildArgs(config: Msvc6Config, filePath: string): string[] {
  const args: string[] = ['/nologo', '/Zs'];

  args.push(`/W${config.warnLevel}`);

  for (const inc of config.includePaths) {
    // Wine cannot resolve POSIX paths — only absolute POSIX paths need conversion;
    // Windows-style and relative paths are already in a form CL.EXE understands.
    const resolvedInc = config.useWine && inc.startsWith('/') ? toWinePath(inc) : inc;
    args.push('/I', resolvedInc);
  }

  const ext = path.extname(filePath).toLowerCase();
  if (CPP_EXTENSIONS.includes(ext)) {
    args.push('/TP');
  } else if (C_EXTENSIONS.includes(ext)) {
    args.push('/TC');
  }

  args.push(...config.additionalFlags);
  args.push(config.useWine ? toWinePath(filePath) : filePath);

  return args;
}

/**
 * Extracts the child process exit code from an `execFile` callback error.
 *
 * Node.js `ExecException` always sets `error.code` to a *string* (e.g.
 * `'ENOENT'`, `'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'`). The numeric exit
 * code — when the child ran but returned non-zero — is exposed on the
 * non-standard `status` property set by `child_process` internals.
 * We check `status` first to avoid silently flattening every CL.EXE
 * failure to exit code 1.
 */
function getExitCode(error: Error | null): number {
  if (!error) return 0;
  const asExec = error as NodeJS.ErrnoException & { status?: number };
  if (typeof asExec.status === 'number') return asExec.status;
  return 1;
}

/**
 * Runs CL.EXE in syntax-check mode (`/Zs`) on the given file.
 *
 * Always resolves — compiler errors are reported via `exitCode` and
 * `rawOutput`, not via promise rejection. Only rejects when the
 * executable itself cannot be spawned (e.g. ENOENT, EACCES).
 */
export function syntaxCheck(
  config: Msvc6Config,
  filePath: string,
  opts: { signal?: AbortSignal } = {},
): Promise<CompileResult> {
  return new Promise((resolve, reject) => {
    const args = buildArgs(config, filePath);
    const executable = config.useWine ? config.wineExecutable : config.clPath;
    const execArgs = config.useWine ? [config.clPath, ...args] : args;

    const env = config.useWine
      ? { ...process.env, WINEDEBUG: '-all' }
      : { ...process.env };

    execFile(
      executable,
      execArgs,
      // killSignal: SIGKILL because Wine ignores SIGTERM reliably.
      { env, timeout: 30000, maxBuffer: 1024 * 1024, signal: opts.signal, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        if (error && typeof error.code === 'string') {
          const isSpawnFailure =
            error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'ENOTDIR';
          if (isSpawnFailure && !stdout && !stderr) {
            reject(new Error(`Failed to execute ${executable}: ${error.code}`));
            return;
          }
          if (error.code === 'ABORT_ERR') {
            reject(error);
            return;
          }
        }

        const truncated =
          error != null &&
          typeof error.code === 'string' &&
          error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        const exitCode = getExitCode(error);
        const rawOutput = stdout + '\n' + stderr;
        resolve({ stdout, stderr, exitCode, rawOutput, truncated });
      },
    );
  });
}

/**
 * Writes `content` to a uniquely named, owner-only temp file and returns its path.
 *
 * The caller owns the file and must pass it to {@link removeTempFile}.
 */
export function createTempFile(content: string, langId: 'c' | 'cpp'): string {
  const ext = langId === 'cpp' ? '.cpp' : '.c';
  const tempFile = path.join(os.tmpdir(), `msvc6_lsp_${randomUUID()}${ext}`);
  fs.writeFileSync(tempFile, content, { encoding: 'utf-8', mode: 0o600 });
  return tempFile;
}

/**
 * Deletes a temp file, retrying briefly while a killed Wine process releases it.
 *
 * A plain `unlinkSync` fails with EBUSY/EPERM while the compiler it belongs to
 * is still shutting down, and an aborted run hits that path on every edit —
 * each failure would strand one file in the temp directory for the session.
 * `force` makes an already-removed file a no-op.
 */
export function removeTempFile(filePath: string): void {
  try {
    fs.rmSync(filePath, {
      force: true,
      maxRetries: TEMP_UNLINK_MAX_RETRIES,
      retryDelay: TEMP_UNLINK_RETRY_DELAY_MS,
    });
  } catch {
    // Nothing else can reach this path once the run has settled, and a
    // leftover temp file is not worth failing a check over.
  }
}

/**
 * Writes `content` to a temp file and runs a syntax check on it.
 * The temp file is cleaned up after the check completes.
 *
 * **Public API** — not used internally by the LSP server (which manages its
 * own temp files for abort/stale-result handling), but exported for
 * programmatic consumers who want a simpler one-shot interface.
 */
export async function syntaxCheckContent(
  config: Msvc6Config,
  content: string,
  languageId: string,
): Promise<CompileResult & { tempFile: string }> {
  const tempFile = createTempFile(content, languageId === 'cpp' ? 'cpp' : 'c');

  try {
    const result = await syntaxCheck(config, tempFile);
    return { ...result, tempFile };
  } finally {
    removeTempFile(tempFile);
  }
}
