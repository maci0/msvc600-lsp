import * as path from 'path';
import { WINE_MSVC_BASE } from './wine-path';

/** Valid MSVC 6.0 warning levels: 0 (none) through 4 (most verbose). */
export type WarnLevel = 0 | 1 | 2 | 3 | 4;

/**
 * Supported C/C++ file extensions for syntax checking.
 * Translation units (.c, .cpp, .cxx, .cc) are compiled directly.
 * Headers (.h, .hpp, .hxx) are supported but may produce false positives
 * when compiled as standalone translation units.
 */
export const C_EXTENSIONS: readonly string[] = ['.c'];
export const CPP_EXTENSIONS: readonly string[] = ['.cpp', '.cxx', '.cc', '.hpp', '.hxx'];
export const ALL_EXTENSIONS: readonly string[] = [...C_EXTENSIONS, ...CPP_EXTENSIONS, '.h'];

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
export const DEFAULT_OUTPUT_ENCODING = 'utf8';

/** Returns a config with sensible defaults relative to the package root. */
export function defaultConfig(): Msvc6Config {
  const msvcBasePath = path.resolve(__dirname, '..', 'VC', 'VC98');
  const useWine = process.platform !== 'win32';

  return {
    msvcBasePath,
    clPath: path.join(msvcBasePath, 'BIN', 'CL.EXE'),
    includePaths: [useWine ? `${WINE_MSVC_BASE}\\include` : path.join(msvcBasePath, 'INCLUDE')],
    warnLevel: 4,
    additionalFlags: [],
    wineExecutable: 'wine',
    outputEncoding: DEFAULT_OUTPUT_ENCODING,
    useWine,
  };
}

/** Strips `readonly` from all properties — used only for incremental object construction. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] extends ReadonlyArray<infer U> ? U[] : T[K] };

/**
 * Validates raw user-supplied config and returns only the fields that pass
 * type and range checks. Invalid fields are silently dropped so the
 * caller can merge the result with {@link defaultConfig}.
 */
export function validateConfig(raw: unknown): Partial<Msvc6Config> {
  if (!raw || typeof raw !== 'object') return {};
  const obj = raw as Record<string, unknown>;
  const result: Partial<Mutable<Msvc6Config>> = {};

  if (typeof obj.msvcBasePath === 'string' && obj.msvcBasePath.length > 0) {
    result.msvcBasePath = obj.msvcBasePath;
  }
  if (typeof obj.clPath === 'string' && obj.clPath.length > 0) {
    result.clPath = obj.clPath;
  }
  if (
    Array.isArray(obj.includePaths) &&
    obj.includePaths.every((p: unknown) => typeof p === 'string')
  ) {
    result.includePaths = [...(obj.includePaths as string[])];
  }
  if (
    typeof obj.warnLevel === 'number' &&
    Number.isInteger(obj.warnLevel) &&
    obj.warnLevel >= 0 &&
    obj.warnLevel <= 4
  ) {
    result.warnLevel = obj.warnLevel as WarnLevel;
  }
  if (
    Array.isArray(obj.additionalFlags) &&
    obj.additionalFlags.every((f: unknown) => typeof f === 'string')
  ) {
    result.additionalFlags = [...(obj.additionalFlags as string[])];
  }
  if (typeof obj.wineExecutable === 'string' && obj.wineExecutable.length > 0) {
    result.wineExecutable = obj.wineExecutable;
  }
  if (typeof obj.outputEncoding === 'string' && isSupportedEncoding(obj.outputEncoding)) {
    result.outputEncoding = obj.outputEncoding;
  }
  if (typeof obj.useWine === 'boolean') {
    result.useWine = obj.useWine;
  }

  if (result.msvcBasePath && !result.clPath) {
    result.clPath = path.join(result.msvcBasePath, 'BIN', 'CL.EXE');
  }

  return result;
}

/**
 * Compares the fields a runtime configuration change is allowed to replace
 * (`includePaths`, `warnLevel`). A repeated notification carrying the same
 * settings leaves the effective config unchanged, which is the signal to skip
 * re-checking every open document.
 */
export function runtimeConfigEquals(a: Msvc6Config, b: Msvc6Config): boolean {
  return (
    a.warnLevel === b.warnLevel &&
    a.includePaths.length === b.includePaths.length &&
    a.includePaths.every((p, i) => p === b.includePaths[i])
  );
}

/**
 * Whether `TextDecoder` knows this encoding label. An unknown label throws at
 * decode time, long after the user set it, so it is rejected at load instead.
 */
function isSupportedEncoding(label: string): boolean {
  try {
    new TextDecoder(label);
    return true;
  } catch {
    return false;
  }
}

