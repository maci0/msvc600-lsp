/**
 * Prefix shared by every temp file the server creates, so leaked files are
 * identifiable. Both the store below and the compiler's own scratch-source
 * writer name files with it, and the sweep that reclaims them matches on it: a
 * second copy of this string would leave one writer's orphans unswept forever.
 */
export declare const TEMP_PREFIX = "msvc6_lsp_";
/** Upper bound on the source text handed to a syntax check. */
export declare const MAX_SOURCE_BYTES: number;
/** Raised when a buffer exceeds {@link MAX_SOURCE_BYTES}. */
export declare class DocumentTooLargeError extends Error {
    readonly byteLength: number;
    constructor(byteLength: number);
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
export declare function createSystemTempFileStore(opts?: SystemTempFileStoreOptions): TempFileStore;
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
export declare function createSimulatedTempFileStore(opts?: SimulatedTempFileStoreOptions): SimulatedTempFileStore;
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
export declare function createTempSource(content: string, ext: string): string;
/** Bounds for one {@link sweepStaleTempFiles} pass. */
export interface SweepOptions {
    /** Clock the ages are measured against. Defaults to `Date.now`. */
    now?: number;
    /**
     * Age past which a scratch file is orphaned. Defaults to
     * {@link STALE_TEMP_MIN_AGE_MS}; pass {@link staleTempMinAgeMs} of the
     * configured `checkTimeoutMs` so a file in flight is never removed.
     */
    minAgeMs?: number;
}
/**
 * The age a scratch source must reach before it is certainly not being read by
 * a live check: the configured check timeout, plus slack for staging and
 * cleanup. The sweep is a global delete over a shared directory, so its age
 * has to cover the slowest check in *any* running server, not just this one's
 * default.
 */
export declare function staleTempMinAgeMs(checkTimeoutMs: number): number;
/**
 * Deletes scratch sources left behind by a run that was killed before its
 * cleanup, and returns the paths removed. A server that is restarted after a
 * crash otherwise accumulates one orphaned file per interrupted check, and no
 * later run ever reclaims them. Removing only files older than `minAgeMs`
 * keeps this safe alongside a concurrently running server: the age bounds how
 * long a file a live check is still reading can survive, and a sweep never
 * removes a file it cannot prove is abandoned. Running it twice in a row
 * removes nothing the second time, because the first pass already unlinked
 * what it found.
 */
export declare function sweepStaleTempFiles(opts?: SweepOptions): string[];
//# sourceMappingURL=tempfile.d.ts.map