import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TextDecoder } from 'util';
import { Msvc6Config, CPP_EXTENSIONS, C_EXTENSIONS } from './config';
import { encodeSourceText, prepareSourceText } from './encoding';
import { toWinePath } from './wine-path';
import { TempFileStore, createSystemTempFileStore } from './tempfile';
import { Semaphore } from './concurrency';

/** Scratch sources are named with this prefix so a crashed run leaves identifiable leftovers. */
const TEMP_SOURCE_PREFIX = 'msvc6_lsp_';

/** Suffixes a scratch source may carry. */
const TEMP_SOURCE_EXTENSIONS: readonly string[] = ['.c', '.cpp'];

/**
 * Age at which a scratch file is treated as orphaned by a crashed run. Well
 * above the 30s check timeout, so a file in flight inside another server
 * process is never removed.
 */
const STALE_TEMP_MIN_AGE_MS = 60 * 60 * 1000;

/** Upper bound on the source text handed to a syntax check. */
export const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

/**
 * Concurrent CL.EXE children allowed at once. Each one is a heavyweight process
 * (a full Wine services startup on non-Windows), so the number is kept at the
 * parallelism a developer machine absorbs; the rest queue rather than dropping.
 * The server schedules through the same number, so the two layers of the
 * pipeline agree on one limit.
 */
export const MAX_CONCURRENT_CHECKS = 2;

/** Options for the entry points that stage document text on disk. */
export interface TempFileOptions {
  /** Filesystem boundary to write through. Defaults to the real temp directory. */
  store?: TempFileStore;
}

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
   * True when CL.EXE was killed after {@link COMPILE_TIMEOUT_MS}. The exit code
   * and output are then meaningless: no diagnostic in `rawOutput` was produced
   * by a completed run, and a missing diagnostic means the check timed out,
   * not that the file is clean.
   */
  timedOut: boolean;
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

/** Raised when a buffer exceeds {@link MAX_SOURCE_BYTES}. */
export class DocumentTooLargeError extends Error {
  readonly byteLength: number;

  constructor(byteLength: number) {
    super(`document is ${byteLength} bytes, over the ${MAX_SOURCE_BYTES} byte syntax-check limit`);
    this.name = 'DocumentTooLargeError';
    this.byteLength = byteLength;
  }
}

/**
 * Writes `content` to a fresh temp file with the given extension and returns
 * its path. The bytes written are the prepared UTF-8 source, so the size check
 * and the file on disk agree. The caller owns the file and must unlink it.
 *
 * The create is exclusive (`wx`): a path that already exists in the shared
 * temp directory is an error rather than something to truncate, so a file or
 * symlink planted by another local user is never written through. `mode`
 * applies only to a file this call creates, which is why the flag matters.
 */
export function createTempSource(content: string, ext: string): string {
  const body = encodeSourceText(content);
  if (body.byteLength > MAX_SOURCE_BYTES) {
    throw new DocumentTooLargeError(body.byteLength);
  }

  const tempFile = path.join(os.tmpdir(), `${TEMP_SOURCE_PREFIX}${randomUUID()}${ext}`);
  fs.writeFileSync(tempFile, body, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
  return tempFile;
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
 * exit code that carries no diagnostic meaning.
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
      // timeout and maxBuffer come from the config so a user can bound a
      // runaway Wine or a chatty CL.EXE per machine.
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
        resolve({ stdout, stderr, exitCode, rawOutput, truncated, timedOut });
      },
    );
  });
}

/**
 * Deletes scratch sources left behind by a run that was killed before its
 * cleanup, and returns the paths removed. A server that is restarted after a
 * crash otherwise accumulates one orphaned file per interrupted check, and no
 * later run ever reclaims them. Removing only files older than
 * {@link STALE_TEMP_MIN_AGE_MS} keeps this safe alongside a concurrently
 * running server; running it twice in a row removes nothing the second time.
 */
export function sweepStaleTempFiles(now: number = Date.now()): string[] {
  const removed: string[] = [];

  for (const entry of fs.readdirSync(os.tmpdir())) {
    if (!entry.startsWith(TEMP_SOURCE_PREFIX)) continue;
    if (!TEMP_SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext))) continue;

    const file = path.join(os.tmpdir(), entry);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(file);
    } catch {
      continue; // Vanished between listing and stat.
    }
    if (!stats.isFile()) continue;
    if (now - stats.mtimeMs < STALE_TEMP_MIN_AGE_MS) continue;

    try {
      fs.unlinkSync(file);
      removed.push(file);
    } catch {
      // Another process removed it first, or it is not ours to delete.
    }
  }

  return removed;
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
 * Writes `content` to a fresh temp file with `ext` and returns its path.
 * The caller owns the file and must pass the path to {@link removeTempSourceFile}.
 */
export function createTempSourceFile(content: string, ext: string): string {
  const tempFile = path.join(os.tmpdir(), `msvc6_lsp_${randomUUID()}${ext}`);
  fs.writeFileSync(tempFile, stripByteOrderMark(content), { encoding: 'utf-8', mode: 0o600 });
  return tempFile;
}

/** Deletes a temp source file. A file that is already gone is not an error. */
export function removeTempSourceFile(tempFile: string): void {
  try {
    fs.unlinkSync(tempFile);
  } catch {
    // Already removed, or never created.
  }
}

/**
 * Writes `content` to a temp file and runs a syntax check on it.
 * The temp file is cleaned up after the check completes.
 *
 * Exported for the test suite; the server drives {@link createTempSourceFile}
 * itself so it can abort stale checks.
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
