/** Valid MSVC 6.0 warning levels: 0 (none) through 4 (most verbose). */
export type WarnLevel = 0 | 1 | 2 | 3 | 4;
/**
 * Supported C/C++ file extensions for syntax checking.
 * Translation units (.c, .cpp, .cxx, .cc) are compiled directly.
 * Headers (.h, .hpp, .hxx) are supported but may produce false positives
 * when compiled as standalone translation units.
 */
export declare const C_EXTENSIONS: readonly string[];
export declare const CPP_EXTENSIONS: readonly string[];
export declare const ALL_EXTENSIONS: readonly string[];
/**
 * Configuration for the MSVC 6.0 LSP server.
 *
 * On Linux/macOS the server invokes CL.EXE through Wine.
 * On Windows it calls CL.EXE directly.
 */
export interface Msvc6Config {
    /** Root of the MSVC 6.0 installation (contains BIN/, INCLUDE/, LIB/). */
    msvcBasePath: string;
    /** Absolute path to CL.EXE. */
    clPath: string;
    /** Directories passed as /I include paths to CL.EXE. */
    readonly includePaths: readonly string[];
    /** Warning level passed as /W0../W4. */
    warnLevel: WarnLevel;
    /** Extra flags forwarded verbatim to CL.EXE. */
    readonly additionalFlags: readonly string[];
    /** Path to the Wine executable (ignored on Windows). */
    wineExecutable: string;
    /**
     * Character encoding CL.EXE writes its diagnostics in (the console code page
     * of the toolchain, e.g. `cp1252`). Any label `TextDecoder` accepts; `utf8`
     * is correct when Wine is already passing UTF-8 through.
     */
    outputEncoding: string;
    /** Whether to invoke CL.EXE through Wine. */
    useWine: boolean;
    /** Milliseconds a single CL.EXE check may run before it is killed. */
    checkTimeoutMs: number;
    /** Cap on captured CL.EXE output; past it the tail of the diagnostics is dropped. */
    maxOutputBytes: number;
}
/** A configuration value that was rejected, with the reason it was dropped. */
export interface ConfigIssue {
    key: string;
    message: string;
}
/**
 * Result of validating one configuration source: the fields that passed, and
 * the fields that were dropped. Rejected fields are never applied, so the
 * caller must surface `issues` or the user is left with a default they did not
 * ask for.
 */
export interface ConfigValidation {
    values: Partial<Msvc6Config>;
    issues: ConfigIssue[];
}
/** CL.EXE diagnostics are ASCII-safe under Wine's UTF-8 console by default. */
export declare const DEFAULT_OUTPUT_ENCODING = "utf8";
/** Most verbose warning level; MSVC6 has no higher one to ask for. */
export declare const DEFAULT_WARN_LEVEL: WarnLevel;
/** Wine is installed under this name unless the user points at another build. */
export declare const DEFAULT_WINE_EXECUTABLE = "wine";
/** A check that takes longer than this is killed; a hung Wine is worse than no check. */
export declare const DEFAULT_CHECK_TIMEOUT_MS = 30000;
/** Cap on captured CL.EXE output. Past it the tail of the diagnostic list is lost. */
export declare const DEFAULT_MAX_OUTPUT_BYTES: number;
/**
 * The `/I` entry for a given base and Wine mode. Under Wine the headers are
 * read from the case-insensitive overlay in the prefix rather than from
 * `msvcBasePath`, so the base does not enter the path.
 */
export declare function defaultIncludePaths(msvcBasePath: string, useWine: boolean): string[];
/** Returns a config with sensible defaults relative to the package root. */
export declare function defaultConfig(): Msvc6Config;
/**
 * Validates raw user-supplied config (an `initializationOptions` object or a
 * `settings.msvc6` object) and returns the fields that pass type and range
 * checks together with the fields that were dropped. The caller merges
 * `values` into the running config and reports `issues`, so a misspelled key
 * or a bad type surfaces instead of leaving the previous value in place
 * unexplained.
 */
export declare function validateConfig(raw: unknown): ConfigValidation;
/**
 * Overlays a source's accepted fields on the running config. Fields the source
 * did not set, or set to a value that failed validation, keep the value the
 * earlier source gave them, which is what makes the order of the sources the
 * precedence order.
 */
export declare function mergeValidated(base: Msvc6Config, source: ConfigValidation): Msvc6Config;
/**
 * Fields a `workspace/didChangeConfiguration` notification is allowed to
 * replace. The rest are fixed at initialization, so a notification carrying
 * them has to say so rather than leave the previous value in place silently.
 */
export declare const RUNTIME_KEYS: readonly (keyof Msvc6Config)[];
/** What a runtime configuration notification changes, and what it only appeared to change. */
export interface RuntimeConfigUpdate {
    values: Partial<Msvc6Config>;
    /** Fields the notification set that pass at startup but not at runtime. */
    ignored: string[];
}
/**
 * Selects the runtime-settable fields out of a validated notification. A field
 * outside {@link RUNTIME_KEYS} is returned in `ignored` when it validated, so
 * the caller can report a value the client believes it applied.
 */
export declare function runtimeConfigUpdate(validated: ConfigValidation): RuntimeConfigUpdate;
/**
 * Compares the fields a runtime configuration change is allowed to replace
 * (`includePaths`, `warnLevel`). A repeated notification carrying the same
 * settings leaves the effective config unchanged, which is the signal to skip
 * re-checking every open document.
 */
export declare function runtimeConfigEquals(a: Msvc6Config, b: Msvc6Config): boolean;
/** Prefix every environment variable carrying server configuration. */
export declare const ENV_PREFIX = "MSVC600_";
/** Every accepted environment variable name, prefix included. */
export declare const ENV_NAMES: readonly string[];
/**
 * Reads the `MSVC600_*` environment variables into the same validated shape as
 * `initializationOptions`, so a launch that cannot pass options (a remote
 * session, a container, an editor that only sets an environment) configures the
 * server the same way. A variable that is unset is left out; a variable that is
 * set to an empty string is rejected, because "no include paths" and "no
 * include paths configured" are different setups and only one of them is what
 * the user meant.
 */
export declare function configFromEnv(env?: NodeJS.ProcessEnv): ConfigValidation;
/** Formats validation issues as one log line each, prefixed with the source name. */
export declare function formatIssues(source: string, issues: readonly ConfigIssue[]): string[];
//# sourceMappingURL=config.d.ts.map