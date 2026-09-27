import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Prefix shared by every temp file the server creates, so leaked files are identifiable. */
export const TEMP_FILE_PREFIX = 'msvc6_lsp_';

/** Temp files hold unsaved editor buffers — 0o600 keeps other local users out. */
const TEMP_FILE_MODE = 0o600;

/** Digits in the simulated store's sequence-derived file names. */
const SIMULATED_NAME_DIGITS = 6;

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
      const file = path.join(dir, `${TEMP_FILE_PREFIX}${generateName()}${extension}`);
      // `wx`: a name already taken in the shared temp directory is an error
      // rather than something to truncate, so a file or symlink planted by
      // another local user is never written through. `mode` applies only to a
      // file this call creates, which is why the flag matters.
      fs.writeFileSync(file, content, { encoding: 'utf-8', mode: TEMP_FILE_MODE, flag: 'wx' });
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
        `${TEMP_FILE_PREFIX}${String(sequence).padStart(SIMULATED_NAME_DIGITS, '0')}${extension}`,
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
