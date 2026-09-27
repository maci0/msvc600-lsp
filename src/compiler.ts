import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Msvc6Config, CPP_EXTENSIONS, C_EXTENSIONS } from './config';
import { toWinePath } from './wine-path';
import { TempFileStore, createSystemTempFileStore } from './tempfile';

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
 * Concurrent CL.EXE children this module allows on its own; each one is a Wine
 * process. The server serialises validations through its `TaskQueue` before
 * they get here, so the cap that binds in production is the smaller of the two.
 */
export const MAX_CONCURRENT_CHECKS = 4;

/** Options for {@link syntaxCheckContent}, which stages the buffer it checks. */
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
 * its path. The caller owns the file and must unlink it.
 *
 * Rejects content over {@link MAX_SOURCE_BYTES} before touching the disk, so an
 * oversized buffer leaves no scratch file behind.
 */
export function createTempSource(content: string, ext: string): string {
  const body = stripByteOrderMark(content);
  assertWithinSourceLimit(body);
  return createSystemTempFileStore().write(body, ext);
}

/** Throws {@link DocumentTooLargeError} when `body` is too large to check. */
function assertWithinSourceLimit(body: string): void {
  const byteLength = Buffer.byteLength(body, 'utf-8');
  if (byteLength > MAX_SOURCE_BYTES) {
    throw new DocumentTooLargeError(byteLength);
  }
}

let activeChecks = 0;
const checkQueue: Array<() => void> = [];

function acquireCheckSlot(): Promise<void> {
  if (activeChecks < MAX_CONCURRENT_CHECKS) {
    activeChecks += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => checkQueue.push(resolve));
}

function releaseCheckSlot(): void {
  const next = checkQueue.shift();
  if (next) {
    next();
    return;
  }
  activeChecks -= 1;
}

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
 * processes. A queued check whose signal aborts is dropped before it starts.
 *
 * Always resolves — compiler errors are reported via `exitCode` and
 * `rawOutput`, not via promise rejection. Rejects only when the executable
 * itself cannot be spawned (e.g. ENOENT, EACCES) or the signal aborts.
 */
export async function syntaxCheck(
  config: Msvc6Config,
  filePath: string,
  opts: { signal?: AbortSignal } = {},
): Promise<CompileResult> {
  if (opts.signal?.aborted) throw abortError();
  await acquireCheckSlot();
  try {
    if (opts.signal?.aborted) throw abortError();
    return await runCheck(config, filePath, opts.signal);
  } finally {
    releaseCheckSlot();
  }
}

function runCheck(
  config: Msvc6Config,
  filePath: string,
  signal: AbortSignal | undefined,
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
      // encoding: 'buffer' keeps the raw code-page bytes; they are decoded
      // below with the configured output encoding, not assumed to be UTF-8.
      {
        env,
        timeout: config.checkTimeoutMs,
        maxBuffer: config.maxOutputBytes,
        signal,
        killSignal: 'SIGKILL',
        encoding: 'buffer',
      },
      (error, stdoutBytes, stderrBytes) => {
        const stdout = decodeOutput(stdoutBytes, config.outputEncoding);
        const stderr = decodeOutput(stderrBytes, config.outputEncoding);

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

        const truncated = error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        const exitCode = getExitCode(error);
        const rawOutput = stdout + '\n' + stderr;
        resolve({ stdout, stderr, exitCode, rawOutput, truncated });
      },
    );
  });
}

/** Scratch-source extension for a language id; anything but `cpp` is treated as C. */
export function extForLanguageId(languageId: string): string {
  return languageId === 'cpp' ? '.cpp' : '.c';
}

/**
 * Returns a fresh, unused path for a scratch source file. The random name
 * makes two concurrent checks of the same document independent rather than
 * overwriting each other's input.
 *
 * The server does not use this: it stages through {@link TempFileStore}, which
 * names and creates the file in one step. This is for a caller that needs the
 * path before the text exists.
 */
export function createTempSourcePath(languageId: string): string {
  return path.join(os.tmpdir(), `${TEMP_SOURCE_PREFIX}${randomUUID()}${extForLanguageId(languageId)}`);
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
 * Writes `content` to a temp file and runs a syntax check on it.
 * The temp file is cleaned up after the check completes.
 *
 * Exported for the test suite; the server stages through its own
 * {@link TempFileStore} so it can abort a stale check before the write.
 */
export async function syntaxCheckContent(
  config: Msvc6Config,
  content: string,
  languageId: string,
  opts: TempFileOptions = {},
): Promise<CompileResult & { tempFile: string }> {
  const store = opts.store ?? createSystemTempFileStore();
  const tempFile = store.write(stripByteOrderMark(content), extForLanguageId(languageId));

  try {
    const result = await syntaxCheck(config, tempFile);
    return { ...result, tempFile };
  } finally {
    store.remove(tempFile);
  }
}
