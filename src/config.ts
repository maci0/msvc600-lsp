import * as path from 'path';
import { WINE_MSVC_BASE } from './wine-path';

/** Valid MSVC 6.0 warning levels: 0 (none) through 4 (most verbose). */
export type WarnLevel = 0 | 1 | 2 | 3 | 4;

/** Translation units CL.EXE is told to treat as C (`/TC`). */
export const C_EXTENSIONS: readonly string[] = ['.c'];

/**
 * Extensions treated as C++ (`/TP`): the translation units plus the headers
 * that name their own language. A header compiled as a standalone translation
 * unit may report errors a real build would not, since the `.c` file that
 * supplies its include guards is not part of the check.
 */
export const CPP_EXTENSIONS: readonly string[] = ['.cpp', '.cxx', '.cc', '.hpp', '.hxx'];

/** Every extension the server checks; `.h` is included but gets no language flag. */
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
export const DEFAULT_OUTPUT_ENCODING = 'utf8';

/** A check that takes longer than this is killed; a hung Wine is worse than no check. */
export const DEFAULT_CHECK_TIMEOUT_MS = 30_000;

/** Cap on captured CL.EXE output. Past it the tail of the diagnostic list is lost. */
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * The `/I` entry for a given base and Wine mode. Under Wine the headers are
 * read from the case-insensitive overlay in the prefix rather than from
 * `msvcBasePath`, so the base does not enter the path.
 */
export function defaultIncludePaths(msvcBasePath: string, useWine: boolean): string[] {
  return [useWine ? `${WINE_MSVC_BASE}\\include` : path.join(msvcBasePath, 'INCLUDE')];
}

/** Returns a config with sensible defaults relative to the package root. */
export function defaultConfig(): Msvc6Config {
  const msvcBasePath = path.resolve(__dirname, '..', 'VC', 'VC98');
  const useWine = process.platform !== 'win32';

  return {
    msvcBasePath,
    clPath: path.join(msvcBasePath, 'BIN', 'CL.EXE'),
    includePaths: defaultIncludePaths(msvcBasePath, useWine),
    warnLevel: 4,
    additionalFlags: [],
    wineExecutable: 'wine',
    outputEncoding: DEFAULT_OUTPUT_ENCODING,
    useWine,
    checkTimeoutMs: DEFAULT_CHECK_TIMEOUT_MS,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
  };
}

/** Strips `readonly` from all properties — used only for incremental object construction. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] extends ReadonlyArray<infer U> ? U[] : T[K] };

/**
 * Every accepted key, taken from the config shape itself so a new option
 * cannot be accepted by the field checks below and then reported as unknown.
 */
const KNOWN_KEYS: readonly string[] = Object.keys(defaultConfig());

/**
 * Validates raw user-supplied config (an `initializationOptions` object or a
 * `settings.msvc6` object) and returns the fields that pass type and range
 * checks together with the fields that were dropped. The caller merges
 * `values` into the running config and reports `issues`, so a misspelled key
 * or a bad type surfaces instead of leaving the previous value in place
 * unexplained.
 */
export function validateConfig(raw: unknown): ConfigValidation {
  if (raw === undefined || raw === null) return { values: {}, issues: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { values: {}, issues: [{ key: '', message: `expected an object, got ${describe(raw)}` }] };
  }

  const obj = raw as Record<string, unknown>;
  const result: Partial<Mutable<Msvc6Config>> = {};
  const issues: ConfigIssue[] = [];

  const takeString = (key: 'msvcBasePath' | 'clPath' | 'wineExecutable'): void => {
    const value = obj[key];
    if (value === undefined) return;
    if (typeof value === 'string' && value.length > 0) result[key] = value;
    else issues.push({ key, message: `expected a non-empty string, got ${describe(value)}` });
  };

  const takeStringArray = (key: 'includePaths' | 'additionalFlags'): void => {
    const value = obj[key];
    if (value === undefined) return;
    if (Array.isArray(value) && value.every((e: unknown) => typeof e === 'string')) {
      result[key] = [...(value as string[])];
    } else {
      issues.push({ key, message: `expected an array of strings, got ${describe(value)}` });
    }
  };

  const takePositiveInt = (key: 'checkTimeoutMs' | 'maxOutputBytes'): void => {
    const value = obj[key];
    if (value === undefined) return;
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) result[key] = value;
    else issues.push({ key, message: `expected a positive integer, got ${describe(value)}` });
  };

  takeString('msvcBasePath');
  takeString('clPath');
  takeString('wineExecutable');
  takeStringArray('includePaths');
  takeStringArray('additionalFlags');
  takePositiveInt('checkTimeoutMs');
  takePositiveInt('maxOutputBytes');

  if (obj.warnLevel !== undefined) {
    const level = obj.warnLevel;
    if (typeof level === 'number' && Number.isInteger(level) && level >= 0 && level <= 4) {
      result.warnLevel = level as WarnLevel;
    } else {
      issues.push({ key: 'warnLevel', message: `expected an integer 0-4, got ${describe(level)}` });
    }
  }

  if (obj.outputEncoding !== undefined) {
    const encoding = obj.outputEncoding;
    if (typeof encoding === 'string' && isSupportedEncoding(encoding)) {
      result.outputEncoding = encoding;
    } else {
      issues.push({
        key: 'outputEncoding',
        message: `unknown encoding label ${describe(encoding)}; TextDecoder does not know it`,
      });
    }
  }

  if (obj.useWine !== undefined) {
    if (typeof obj.useWine === 'boolean') {
      result.useWine = obj.useWine;
    } else {
      issues.push({ key: 'useWine', message: `expected a boolean, got ${describe(obj.useWine)}` });
    }
  }

  for (const key of Object.keys(obj)) {
    if (!KNOWN_KEYS.includes(key)) {
      issues.push({ key, message: 'unknown option, ignored (check the spelling)' });
    }
  }

  if (result.msvcBasePath && !result.clPath) {
    result.clPath = path.join(result.msvcBasePath, 'BIN', 'CL.EXE');
  }
  if (result.msvcBasePath && !result.includePaths) {
    const useWine = result.useWine ?? process.platform !== 'win32';
    result.includePaths = defaultIncludePaths(result.msvcBasePath, useWine);
  }

  return { values: result, issues };
}

/** Renders a rejected value for an issue message, quoting strings. */
function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return typeof value;
}

/**
 * Overlays a source's accepted fields on the running config. Fields the source
 * did not set, or set to a value that failed validation, keep the value the
 * earlier source gave them, which is what makes the order of the sources the
 * precedence order.
 */
export function mergeValidated(base: Msvc6Config, source: ConfigValidation): Msvc6Config {
  return { ...base, ...source.values };
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

/** Prefix every environment variable carrying server configuration. */
export const ENV_PREFIX = 'MSVC600_';

/**
 * Separator for list-valued environment variables. A semicolon, not the
 * platform delimiter, because the entries are Wine paths whose drive letters
 * already contain a colon.
 */
const ENV_LIST_SEPARATOR = ';';

/** Environment variable (without {@link ENV_PREFIX}) to config field. */
const ENV_KEYS: Readonly<Record<string, keyof Msvc6Config>> = {
  MSVC_BASE_PATH: 'msvcBasePath',
  CL_PATH: 'clPath',
  INCLUDE_PATHS: 'includePaths',
  WARN_LEVEL: 'warnLevel',
  ADDITIONAL_FLAGS: 'additionalFlags',
  WINE_EXECUTABLE: 'wineExecutable',
  OUTPUT_ENCODING: 'outputEncoding',
  USE_WINE: 'useWine',
  CHECK_TIMEOUT_MS: 'checkTimeoutMs',
  MAX_OUTPUT_BYTES: 'maxOutputBytes',
};

/** Environment variables parsed as integers, which is every scalar but the strings. */
const ENV_INT_KEYS: ReadonlySet<string> = new Set(['WARN_LEVEL', 'CHECK_TIMEOUT_MS', 'MAX_OUTPUT_BYTES']);

/** Environment variables parsed as lists. */
const ENV_LIST_KEYS: ReadonlySet<string> = new Set(['INCLUDE_PATHS', 'ADDITIONAL_FLAGS']);

/** Every accepted environment variable name, prefix included. */
export const ENV_NAMES: readonly string[] = Object.keys(ENV_KEYS).map((k) => `${ENV_PREFIX}${k}`);

/** Field name back to the environment variable that sets it, for issue messages. */
const ENV_NAME_BY_FIELD: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(ENV_KEYS).map(([name, field]) => [field, `${ENV_PREFIX}${name}`]),
);

/**
 * Reads the `MSVC600_*` environment variables into the same validated shape as
 * `initializationOptions`, so a launch that cannot pass options (a remote
 * session, a container, an editor that only sets an environment) configures the
 * server the same way. A variable that is unset is left out; a variable that is
 * set to an empty string is rejected, because "no include paths" and "no
 * include paths configured" are different setups and only one of them is what
 * the user meant.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ConfigValidation {
  const raw: Record<string, unknown> = {};
  const issues: ConfigIssue[] = [];

  for (const [name, field] of Object.entries(ENV_KEYS)) {
    const value = env[`${ENV_PREFIX}${name}`];
    if (value === undefined) continue;
    if (value === '') {
      issues.push({ key: ENV_NAME_BY_FIELD[field], message: 'is set but empty' });
      continue;
    }
    if (ENV_LIST_KEYS.has(name)) {
      raw[field] = value
        .split(ENV_LIST_SEPARATOR)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    } else if (ENV_INT_KEYS.has(name)) {
      const parsed = Number(value.trim());
      raw[field] = Number.isInteger(parsed) ? parsed : value;
    } else if (name === 'USE_WINE') {
      const normalized = value.trim().toLowerCase();
      raw[field] =
        normalized === 'true' || normalized === '1'
          ? true
          : normalized === 'false' || normalized === '0'
            ? false
            : value;
    } else {
      raw[field] = value;
    }
  }

  const validation = validateConfig(raw);
  return {
    values: validation.values,
    issues: [
      ...issues,
      ...validation.issues.map((i) => ({ ...i, key: ENV_NAME_BY_FIELD[i.key] ?? i.key })),
    ],
  };
}

/** Formats validation issues as one log line each, prefixed with the source name. */
export function formatIssues(source: string, issues: readonly ConfigIssue[]): string[] {
  return issues.map((issue) =>
    issue.key === ''
      ? `msvc600-lsp: ${source} ignored: ${issue.message}`
      : `msvc600-lsp: ${source} rejected ${issue.key}: ${issue.message}`,
  );
}
