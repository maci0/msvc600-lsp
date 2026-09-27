import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Msvc6Config, CPP_EXTENSIONS, C_EXTENSIONS, toWinePath } from './config';

/** Result of a CL.EXE syntax-check invocation. */
export interface CompileResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Combined stdout + stderr for diagnostic parsing. */
  rawOutput: string;
  /** True when output was truncated (maxBuffer exceeded). Diagnostics may be incomplete. */
  truncated: boolean;
  /** True when the child was killed for exceeding {@link DEFAULT_TIMEOUT_MS}. */
  timedOut: boolean;
  /** Wall-clock duration of the child process, in milliseconds. */
  durationMs: number;
}

/** Kills a hung CL.EXE, including under Wine where SIGTERM is unreliable. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Output ceiling for the child process; the tail of the diagnostic list is lost past it. */
const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * A compiler that could not be started at all: CL.EXE or Wine is missing,
 * not executable, or the path is wrong. Distinct from a compile failure, since
 * no diagnostics exist and the server cannot check anything until it is fixed.
 */
export class CompilerSpawnError extends Error {
  readonly code: string;
  readonly executable: string;

  constructor(executable: string, code: string) {
    super(`Failed to execute ${executable}: ${code}`);
    this.name = 'CompilerSpawnError';
    this.code = code;
    this.executable = executable;
  }
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
 * Decodes CL.EXE output bytes. A `TextDecoder` never throws on malformed
 * input, so undecodable bytes become U+FFFD rather than aborting the check.
 */
function decodeOutput(bytes: Buffer, encoding: string): string {
  return new TextDecoder(encoding).decode(bytes);
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
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<CompileResult> {
  return new Promise((resolve, reject) => {
    const args = buildArgs(config, filePath);
    const executable = config.useWine ? config.wineExecutable : config.clPath;
    const execArgs = config.useWine ? [config.clPath, ...args] : args;

    const env = config.useWine
      ? { ...process.env, WINEDEBUG: '-all' }
      : { ...process.env };

    const startedAt = Date.now();

    execFile(
      executable,
      execArgs,
      // killSignal: SIGKILL because Wine ignores SIGTERM reliably.
      // encoding: 'buffer' keeps the raw code-page bytes; they are decoded
      // below with the configured output encoding, not assumed to be UTF-8.
      {
        env,
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        signal: opts.signal,
        killSignal: 'SIGKILL',
        encoding: 'buffer',
      },
      (error, stdoutBytes, stderrBytes) => {
        const durationMs = Date.now() - startedAt;
        const stdout = decodeOutput(stdoutBytes, config.outputEncoding);
        const stderr = decodeOutput(stderrBytes, config.outputEncoding);

        if (error && typeof error.code === 'string') {
          const isSpawnFailure =
            error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'ENOTDIR';
          if (isSpawnFailure && !stdout && !stderr) {
            reject(new CompilerSpawnError(executable, error.code));
            return;
          }
          if (error.code === 'ABORT_ERR') {
            reject(error);
            return;
          }
        }

        // execFile reports a timeout by killing the child: `killed` is set and
        // `code` stays null, so without this the run reads as a clean exit.
        // The maxBuffer kill sets `killed` too, hence the separate flag first.
        const truncated =
          error != null &&
          typeof error.code === 'string' &&
          error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        const timedOut = !truncated && (error as { killed?: boolean } | null)?.killed === true;
        const exitCode = getExitCode(error);
        const rawOutput = stdout + '\n' + stderr;
        resolve({ stdout, stderr, exitCode, rawOutput, truncated, timedOut, durationMs });
      },
    );
  });
}

/**
 * Drops a leading U+FEFF. Editors hand buffers over with a UTF-8 BOM intact,
 * and MSVC6 lexes those three bytes as source, reporting an error on the
 * first declaration of an otherwise valid file.
 */
export function stripByteOrderMark(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
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
  const ext = languageId === 'cpp' ? '.cpp' : '.c';
  const tempFile = path.join(os.tmpdir(), `msvc6_lsp_${randomUUID()}${ext}`);

  try {
    fs.writeFileSync(tempFile, stripByteOrderMark(content), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    const result = await syntaxCheck(config, tempFile);
    return { ...result, tempFile };
  } finally {
    try {
      fs.unlinkSync(tempFile);
    } catch {
      // Temp file may already be gone — not an error.
    }
  }
}
