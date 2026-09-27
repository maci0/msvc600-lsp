import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { encodeSourceText } from './encoding';

/** Prefix shared by every temp file the server creates, so leaked files are identifiable. */
const TEMP_PREFIX = 'msvc6_lsp_';

/** Temp files hold unsaved editor buffers — 0o600 keeps other local users out. */
const TEMP_FILE_MODE = 0o600;

/** Digits in the simulated store's sequence-derived file names. */
const SIMULATED_NAME_DIGITS = 6;

/** Suffixes a scratch source may carry. */
const SOURCE_EXTENSIONS: readonly string[] = ['.c', '.cpp'];

/**
 * Age at which a scratch file is treated as orphaned by a crashed run. Well
 * above the 30s check timeout, so a file in flight inside another server
 * process is never removed.
 */
const STALE_TEMP_MIN_AGE_MS = 60 * 60 * 1000;

/** Upper bound on the source text handed to a syntax check. */
export const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

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
 * Encodes `content` to the bytes a scratch source is written as, refusing a
 * buffer the compiler would not accept. One check, so a file on disk and the
 * reported size can never disagree, whichever write path staged it.
 */
function encodeSource(content: string): Buffer {
  const body = encodeSourceText(content);
  if (body.byteLength > MAX_SOURCE_BYTES) {
    throw new DocumentTooLargeError(body.byteLength);
  }
  return body;
}

/**
 * The filesystem boundary for handing document text to `CL.EXE`.
 *
 * Validation logic depends on three nondeterministic things at this edge: the
 * directory chosen for the write, the file name, and whether the write or the
 * cleanup succeeds. None of them are part of a validation's *result*, so they
 * are kept behind this interface: production passes the real filesystem, a
 * simulated run passes {@link createSimulatedTempFileStore} and gets the same
 * call sequence with a reproducible name and an inspectable result.
 */
export interface TempFileStore {
  /** Writes `content` to a fresh file and returns its path. */
  write(content: string, extension: string): string;
  /** Removes a file returned by {@link TempFileStore.write}. Never throws. */
  remove(file: string): void;
}

export interface SystemTempFileStoreOptions {
  /** Directory to create files in. Defaults to the OS temp directory. */
  dir?: string;
  /**
   * Source of the unique component of a file name. Defaults to
   * `crypto.randomUUID`: the name is unguessable so another local user cannot
   * pre-create it as a symlink in a shared temp directory. A simulated run
   * substitutes a seeded generator.
   */
  generateName?: () => string;
}

/** A {@link TempFileStore} backed by the real filesystem. */
export function createSystemTempFileStore(
  opts: SystemTempFileStoreOptions = {},
): TempFileStore {
  const dir = opts.dir ?? os.tmpdir();
  const generateName = opts.generateName ?? randomUUID;

  return {
    write(content: string, extension: string): string {
      const file = path.join(dir, `${TEMP_PREFIX}${generateName()}${extension}`);
      // `wx` fails if the path is taken, so a file or symlink another local
      // user planted in the shared temp directory is never written through.
      fs.writeFileSync(file, encodeSource(content), { mode: TEMP_FILE_MODE, flag: 'wx' });
      return file;
    },
    remove(file: string): void {
      try {
        fs.unlinkSync(file);
      } catch {
        // Temp file may already be gone, or never created. Nothing to clean up.
      }
    },
  };
}

/** One entry of a simulated store's call log, in call order. */
export interface TempFileEvent {
  readonly op: 'write' | 'remove';
  readonly file: string;
  /** File contents for `write`, empty for `remove`. */
  readonly content: string;
}

/** A {@link TempFileStore} whose state lives in memory and replays identically. */
export interface SimulatedTempFileStore extends TempFileStore {
  /** Files still present, keyed by path. */
  readonly files: ReadonlyMap<string, string>;
  /** Every call in order, so a replay can be diffed against a recorded run. */
  readonly events: readonly TempFileEvent[];
  /** Contents of `file`, or undefined once it has been removed. */
  read(file: string): string | undefined;
  /** Makes the next {@link TempFileStore.write} throw `error`, modeling a full or read-only disk. */
  failNextWrite(error: Error): void;
}

export interface SimulatedTempFileStoreOptions {
  /** Directory prefix reported in generated paths. Defaults to `/tmp`. */
  dir?: string;
}

/**
 * A deterministic {@link TempFileStore} for tests and simulation.
 *
 * Names are derived from a call counter instead of entropy, so the same call
 * sequence always yields the same paths, the same `CL.EXE` argument vector, and
 * therefore the same diagnostics.
 */
export function createSimulatedTempFileStore(
  opts: SimulatedTempFileStoreOptions = {},
): SimulatedTempFileStore {
  const dir = opts.dir ?? os.tmpdir();
  const files = new Map<string, string>();
  const events: TempFileEvent[] = [];
  let sequence = 0;
  let pendingWriteError: Error | null = null;

  return {
    files,
    events,

    write(content: string, extension: string): string {
      if (pendingWriteError) {
        const error = pendingWriteError;
        pendingWriteError = null;
        throw error;
      }
      sequence += 1;
      const file = path.join(
        dir,
        `${TEMP_PREFIX}${String(sequence).padStart(SIMULATED_NAME_DIGITS, '0')}${extension}`,
      );
      files.set(file, content);
      events.push({ op: 'write', file, content });
      return file;
    },

    remove(file: string): void {
      files.delete(file);
      events.push({ op: 'remove', file, content: '' });
    },

    read(file: string): string | undefined {
      return files.get(file);
    },

    failNextWrite(error: Error): void {
      pendingWriteError = error;
    },
  };
}

/**
 * Writes `content` to a fresh scratch source in the OS temp directory and
 * returns its path. The bytes written are the prepared UTF-8 source, so the
 * size check and the file on disk agree. The caller owns the file and must
 * unlink it.
 *
 * The create is exclusive (`wx`): a path that already exists in the shared
 * temp directory is an error rather than something to truncate, so a file or
 * symlink planted by another local user is never written through. `mode`
 * applies only to a file this call creates, which is why the flag matters.
 */
export function createTempSource(content: string, ext: string): string {
  return createSystemTempFileStore().write(content, ext);
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
    if (!entry.startsWith(TEMP_PREFIX)) continue;
    if (!SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext))) continue;

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
