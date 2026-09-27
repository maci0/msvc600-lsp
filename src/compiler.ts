import { execFile } from 'child_process';
import * as path from 'path';
import { TextDecoder } from 'util';
import { Msvc6Config, CPP_EXTENSIONS, C_EXTENSIONS } from './config';
import { prepareSourceText } from './encoding';
import { toWinePath } from './wine-path';
import { Semaphore } from './concurrency';
import { createSystemTempFileStore, TempFileStore } from './tempfile';

/** Options for the entry points that stage document text on disk. */export interface TempFileOptions {
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
export const MAX_CONCURRENT_CHECKS = 2;

/** Wall-clock limit for one CL.EXE run before the process is killed. */
export const COMPILE_TIMEOUT_MS = 30000;

/** Cap on captured stdout and stderr, per stream. */
export const MAX_OUTPUT_BYTES = 1024 * 1024;

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
 * `error.code` is overloaded: a string for a failure of the spawn itself
 * (`'ENOENT'`, `'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'`), and the child's own
 * numeric exit code when the child ran and returned non-zero. `status` is not
 * set by `execFile`, so a numeric `code` is the only place the real code
 * survives; reading `status` alone flattens every CL.EXE failure to 1. An
 * error carrying neither means the run never reached an exit, which is
 * reported as 1 so it cannot be read as success.
 */
function getExitCode(error: Error | null): number {
  if (!error) return 0;
  const asExec = error as NodeJS.ErrnoException & { status?: unknown };
  if (typeof asExec.status === 'number') return asExec.status;
  if (typeof asExec.code === 'number') return asExec.code;
  return 1;
}

/**
 * Decodes CL.EXE output bytes. A `TextDecoder` never throws on malformed
 * input, so undecodable bytes become U+FFFD rather than aborting the check.
 */
function decodeOutput(bytes: Buffer, decoder: TextDecoder): string {
  return decoder.decode(bytes);
}

/**
 * Whether the child was killed by the exec timeout rather than by the caller.
 * A timeout kill carries no string `code` (it is `null`) and no `status`, so
 * only `killed` distinguishes it from an ordinary non-zero exit.
 */
function isTimeoutKill(error: Error | null): boolean {
  return error != null && (error as { killed?: boolean }).killed === true;
}

/**
 * The signal that ended the child, when the run did not finish on its own.
 *
 * A timed-out run is killed by this process on purpose and is reported as
 * `timedOut`, so it is not also a signal kill. Any other signal came from
 * outside: the OOM killer, an operator, or a crash under Wine. The child wrote
 * whatever it had reached and stopped, so a non-zero exit code over that
 * partial output is indistinguishable from a real compile failure, and
 * publishing the partial output alone would read as a complete check.
 */
function signalKill(error: Error | null, timedOut: boolean): string | null {
  if (timedOut || error == null) return null;
  const signal = (error as { signal?: unknown }).signal;
  return typeof signal === 'string' && signal.length > 0 ? signal : null;
}

const checkSlots = new Semaphore(MAX_CONCURRENT_CHECKS);

function abortError(): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error('CL.EXE check aborted');
  error.code = 'ABORT_ERR';
  return error;
}

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
export async function syntaxCheck(
  config: Msvc6Config,
  filePath: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<CompileResult> {
  const release = await checkSlots.acquire(opts.signal);
  if (release === null) throw abortError();
  try {
    if (opts.signal?.aborted) throw abortError();
    return await runCheck(config, filePath, opts);
  } finally {
    release();
  }
}

function runCheck(
  config: Msvc6Config,
  filePath: string,
  opts: { signal?: AbortSignal; timeoutMs?: number },
): Promise<CompileResult> {
  return new Promise((resolve, reject) => {
    const args = buildArgs(config, filePath);
    const executable = config.useWine ? config.wineExecutable : config.clPath;
    const execArgs = config.useWine ? [config.clPath, ...args] : args;

    // Rebuilt per run: a test or a caller may change `process.env` between
    // checks, and the child has to see that.
    const env = config.useWine
      ? { ...process.env, WINEDEBUG: '-all' }
      : { ...process.env };

    // Built before the spawn: an unknown encoding label throws here, and a
    // throw inside the executor rejects instead of escaping from the
    // execFile callback as an uncaught exception.
    let decoder: TextDecoder;
    try {
      decoder = new TextDecoder(config.outputEncoding);
    } catch (e) {
      reject(
        new Error(
          `Cannot run ${executable} on ${filePath}: unsupported outputEncoding ` +
            `${JSON.stringify(config.outputEncoding)} (${(e as Error).message})`,
        ),
      );
      return;
    }

    execFile(
      executable,
      execArgs,
      // killSignal: SIGKILL because Wine ignores SIGTERM reliably.
      // encoding: 'buffer' keeps the raw code-page bytes; they are decoded
      // below with the configured output encoding, not assumed to be UTF-8.
      // timeout and maxBuffer come from the config, so a client that raises or
      // lowers checkTimeoutMs and maxOutputBytes gets what it asked for.
      {
        env,
        timeout: opts.timeoutMs ?? config.checkTimeoutMs,
        maxBuffer: config.maxOutputBytes,
        signal: opts.signal,
        killSignal: 'SIGKILL',
        encoding: 'buffer',
      },
      (error, stdoutBytes, stderrBytes) => {
        const stdout = decodeOutput(stdoutBytes, decoder);
        const stderr = decodeOutput(stderrBytes, decoder);

        if (error) {
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
        const timedOut = !truncated && isTimeoutKill(error);
        const exitCode = getExitCode(error);
        const rawOutput = stdout + '\n' + stderr;
        resolve({
          stdout,
          stderr,
          exitCode,
          rawOutput,
          truncated,
          timedOut,
          killedBySignal: signalKill(error, timedOut),
        });
      },
    );
  });
}

/**
 * Writes `content` to a temp file and runs a syntax check on it.
 * The temp file is cleaned up after the check completes.
 *
 * Exported for the test suite; the server stages its own scratch source through
 * `createTempSource` so it can abort stale checks.
 */
export async function syntaxCheckContent(
  config: Msvc6Config,
  content: string,
  languageId: string,
  opts: TempFileOptions = {},
): Promise<CompileResult & { tempFile: string }> {
  const ext = languageId === 'cpp' ? '.cpp' : '.c';
  const store = opts.store ?? createSystemTempFileStore();
  const tempFile = store.write(prepareSourceText(content), ext);

  try {
    const result = await syntaxCheck(config, tempFile);
    return { ...result, tempFile };
  } finally {
    store.remove(tempFile);
  }
}
