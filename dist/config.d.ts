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
}
/** CL.EXE diagnostics are ASCII-safe under Wine's UTF-8 console by default. */
export declare const DEFAULT_OUTPUT_ENCODING = "utf8";
/** Returns a config with sensible defaults relative to the package root. */
export declare function defaultConfig(): Msvc6Config;
/**
 * Validates raw user-supplied config and returns only the fields that pass
 * type and range checks. Invalid fields are silently dropped so the
 * caller can merge the result with {@link defaultConfig}.
 */
export declare function validateConfig(raw: unknown): Partial<Msvc6Config>;
/**
 * Compares the fields a runtime configuration change is allowed to replace
 * (`includePaths`, `warnLevel`). A repeated notification carrying the same
 * settings leaves the effective config unchanged, which is the signal to skip
 * re-checking every open document.
 */
export declare function runtimeConfigEquals(a: Msvc6Config, b: Msvc6Config): boolean;
//# sourceMappingURL=config.d.ts.map