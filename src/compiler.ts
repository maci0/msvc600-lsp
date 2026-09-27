import { spawn, ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { Msvc6Config, CPP_EXTENSIONS, C_EXTENSIONS } from './config';
import { Semaphore } from './concurrency';
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

/** Concurrent CL.EXE children allowed at once; each one is a Wine process. */
export const MAX_CONCURRENT_CHECKS = 4;

/** Wall-clock ceiling for a single CL.EXE invocation before it is killed. */
const SYNTAX_CHECK_TIMEOUT_MS = 30000;

/** Ceiling on captured CL.EXE output; past it, stdout is truncated and diagnostics may be incomplete. */
const SYNTAX_CHECK_MAX_BUFFER_BYTES = 1024 * 1024;

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
 * The create is exclusive (`wx`): a path that already exists in the shared
 * temp directory is an error rather than something to truncate, so a file or
 * symlink planted by another local user is never written through. `mode`
 * applies only to a file this call creates, which is why the flag matters.
 */
export function createTempSource(content: string, ext: string): string {
  const body = stripByteOrderMark(content);
  const byteLength = Buffer.byteLength(body, 'utf-8');
  if (byteLength > MAX_SOURCE_BYTES) {
    throw new DocumentTooLargeError(byteLength);
  }

  const tempFile = path.join(os.tmpdir(), `msvc6_lsp_${randomUUID()}${ext}`);
  fs.writeFileSync(tempFile, body, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
  return tempFile;
}

/** Caps how many CL.EXE children are in flight; a queued check leaves on abort. */
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
  const release = await checkSlots.acquire(opts.signal);
  if (release === null) throw abortError();
  try {
    if (opts.signal?.aborted) throw abortError();
    return await runCheck(config, filePath, opts.signal);
  } finally {
    release();
  }
}

/** Exit code reported for a child that was killed before it could report one. */
const KILLED_EXIT_CODE = 1;

/**
 * SIGKILLs a check's child, and everything that child spawned.
 *
 * Wine is a launcher: it starts CL.EXE as a grandchild, so killing the child
 * alone stops the launcher and leaves the compiler running to completion, once
 * per superseded check. A child spawned `detached` leads its own process
 * group, and the whole group dies together. A direct CL.EXE has no grandchild
 * and shares the server's group, which must not be signalled by accident.
 */
function killCheckProcess(child: ChildProcess, useGroup: boolean): void {
  if (useGroup && child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // The group is already empty; fall through to the leader-only kill.
    }
  }
  child.kill('SIGKILL');
}

/** One child's output stream, capped at the buffer ceiling. */
interface CapturedStream {
  readonly chunks: Buffer[];
  bytes: number;
  /** True once the stream passed the ceiling and the check was cut short. */
  overflowed: boolean;
}

function captureStream(stream: Readable, onOverflow: () => void): CapturedStream {
  const captured: CapturedStream = { chunks: [], bytes: 0, overflowed: false };

  stream.on('data', (chunk: Buffer) => {
    captured.bytes += chunk.length;
    if (captured.bytes > SYNTAX_CHECK_MAX_BUFFER_BYTES) {
      // Output past the ceiling is dropped, and the check that produced it is
      // killed rather than left to run on writing into a pipe nobody reads.
      if (!captured.overflowed) {
        captured.overflowed = true;
        onOverflow();
      }
      return;
    }
    captured.chunks.push(chunk);
  });

  return captured;
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

    const child = spawn(executable, execArgs, {
      env,
      // The group the kill below targets. A direct CL.EXE stays in ours.
      detached: config.useWine,
      // stdin is closed rather than left open: CL.EXE reads nothing from it.
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const kill = (): void => killCheckProcess(child, config.useWine);
    let spawnError: NodeJS.ErrnoException | null = null;
    let truncated = false;

    // The raw code-page bytes are captured as-is and decoded below with the
    // configured output encoding, not assumed to be UTF-8.
    const stdout = captureStream(child.stdout, () => {
      truncated = true;
      kill();
    });
    const stderr = captureStream(child.stderr, () => {
      truncated = true;
      kill();
    });

    const killOnAbort = (): void => kill();
    const timeoutTimer = setTimeout(killOnAbort, SYNTAX_CHECK_TIMEOUT_MS);
    signal?.addEventListener('abort', killOnAbort, { once: true });
    if (signal?.aborted) killOnAbort();

    // A process that could not be started reports the reason here and still
    // reaches 'close', which is where the result is settled.
    child.once('error', (error: NodeJS.ErrnoException) => {
      spawnError = error;
    });

    child.once('close', (code) => {
      clearTimeout(timeoutTimer);
      signal?.removeEventListener('abort', killOnAbort);

      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      if (spawnError !== null) {
        reject(new Error(`Failed to execute ${executable}: ${spawnError.code ?? spawnError.message}`));
        return;
      }

      const out = decodeOutput(Buffer.concat(stdout.chunks), config.outputEncoding);
      const err = decodeOutput(Buffer.concat(stderr.chunks), config.outputEncoding);
      resolve({
        stdout: out,
        stderr: err,
        // A killed child reports no status of its own.
        exitCode: code ?? KILLED_EXIT_CODE,
        rawOutput: out + '\n' + err,
        truncated,
      });
    });
  });
}

/**
 * Returns a fresh, unused path for a scratch source file. The random name
 * makes two concurrent checks of the same document independent rather than
 * overwriting each other's input.
 */
export function createTempSourcePath(languageId: string): string {
  const ext = languageId === 'cpp' ? '.cpp' : '.c';
  return path.join(os.tmpdir(), `${TEMP_SOURCE_PREFIX}${randomUUID()}${ext}`);
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
 * Exported for the test suite; the server manages its own temp files so it
 * can abort stale checks.
 */
export async function syntaxCheckContent(
  config: Msvc6Config,
  content: string,
  languageId: string,
  opts: TempFileOptions = {},
): Promise<CompileResult & { tempFile: string }> {
  const ext = languageId === 'cpp' ? '.cpp' : '.c';
  const store = opts.store ?? createSystemTempFileStore();
  const tempFile = store.write(stripByteOrderMark(content), ext);

  try {
    const result = await syntaxCheck(config, tempFile);
    return { ...result, tempFile };
  } finally {
    store.remove(tempFile);
  }
}
