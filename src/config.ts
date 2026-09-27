import * as fs from 'fs';
import * as path from 'path';

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
 *
 * Every field can be set three ways. Precedence, lowest to highest:
 * built-in defaults → `MSVC6_*` environment variables → client
 * `initializationOptions`. The `MSVC6_*` names are listed in
 * {@link ENV_VARS} and in `.env.example`.
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
  /** Whether to invoke CL.EXE through Wine. */
  useWine: boolean;
  /** Wall-clock limit for a single CL.EXE invocation, in milliseconds. */
  compileTimeoutMs: number;
  /** Maximum stdout+stderr captured from CL.EXE before it is truncated. */
  maxOutputBytes: number;
  /** Delay between the last keystroke and a syntax check, in milliseconds. */
  debounceMs: number;
}

/** Where a configuration value came from, used in issue messages. */
export type ConfigSource = 'env' | 'initializationOptions' | 'settings';

export interface ConfigIssue {
  source: ConfigSource;
  key: string;
  message: string;
}

export type ConfigIssueReporter = (issue: ConfigIssue) => void;

const WINE_MSVC_BASE = 'C:\\msvc6';
const DEFAULT_WARN_LEVEL: WarnLevel = 4;
const DEFAULT_WINE_EXECUTABLE = 'wine';
const DEFAULT_COMPILE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_DEBOUNCE_MS = 300;
const MIN_WARN_LEVEL = 0;
const MAX_WARN_LEVEL = 4;
const MAX_COMPILE_TIMEOUT_MS = 10 * 60_000;

/** Environment variable name for each configurable field. */
export const ENV_VARS = {
  msvcBasePath: 'MSVC6_BASE_PATH',
  clPath: 'MSVC6_CL_PATH',
  includePaths: 'MSVC6_INCLUDE_PATHS',
  warnLevel: 'MSVC6_WARN_LEVEL',
  additionalFlags: 'MSVC6_ADDITIONAL_FLAGS',
  wineExecutable: 'MSVC6_WINE_EXECUTABLE',
  useWine: 'MSVC6_USE_WINE',
  compileTimeoutMs: 'MSVC6_COMPILE_TIMEOUT_MS',
  maxOutputBytes: 'MSVC6_MAX_OUTPUT_BYTES',
  debounceMs: 'MSVC6_DEBOUNCE_MS',
} as const satisfies Record<string, string>;

/** Every recognized `MSVC6_*` variable, used to flag misspelled names. */
const RECOGNIZED_ENV_VARS: ReadonlySet<string> = new Set(Object.values(ENV_VARS));
const ENV_PREFIX = 'MSVC6_';

/** Config field name → environment variable name. */
const ENV_VARS_BY_FIELD: Readonly<Record<string, string>> = {
  msvcBasePath: ENV_VARS.msvcBasePath,
  clPath: ENV_VARS.clPath,
  includePaths: ENV_VARS.includePaths,
  warnLevel: ENV_VARS.warnLevel,
  additionalFlags: ENV_VARS.additionalFlags,
  wineExecutable: ENV_VARS.wineExecutable,
  useWine: ENV_VARS.useWine,
  compileTimeoutMs: ENV_VARS.compileTimeoutMs,
  maxOutputBytes: ENV_VARS.maxOutputBytes,
  debounceMs: ENV_VARS.debounceMs,
};

/** Strips `readonly` from all properties — used only for incremental object construction. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] extends ReadonlyArray<infer U> ? U[] : T[K] };

/** Returns a config with sensible defaults relative to the package root. */
export function defaultConfig(): Msvc6Config {
  const msvcBasePath = path.resolve(__dirname, '..', 'VC', 'VC98');
  const useWine = process.platform !== 'win32';

  return {
    msvcBasePath,
    clPath: path.join(msvcBasePath, 'BIN', 'CL.EXE'),
    includePaths: [useWine ? `${WINE_MSVC_BASE}\\include` : path.join(msvcBasePath, 'INCLUDE')],
    warnLevel: DEFAULT_WARN_LEVEL,
    additionalFlags: [],
    wineExecutable: DEFAULT_WINE_EXECUTABLE,
    useWine,
    compileTimeoutMs: DEFAULT_COMPILE_TIMEOUT_MS,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    debounceMs: DEFAULT_DEBOUNCE_MS,
  };
}

function report(
  issues: ConfigIssueReporter | undefined,
  source: ConfigSource,
  key: string,
  message: string,
): void {
  issues?.({ source, key, message });
}

function validateStringArray(
  value: unknown,
  key: string,
  source: ConfigSource,
  issues: ConfigIssueReporter | undefined,
): string[] | undefined {
  if (!Array.isArray(value)) {
    report(issues, source, key, `expected an array of strings, got ${describeType(value)}`);
    return undefined;
  }
  const bad = value.findIndex((item) => typeof item !== 'string');
  if (bad !== -1) {
    report(issues, source, key, `element ${bad} is ${describeType(value[bad])}, expected a string`);
    return undefined;
  }
  const entries = value as string[];
  const empty = entries.findIndex((item) => item.length === 0);
  if (empty !== -1) {
    report(issues, source, key, `element ${empty} is empty; remove it or use an empty array`);
    return undefined;
  }
  return [...entries];
}

function validateInteger(
  value: unknown,
  key: string,
  source: ConfigSource,
  issues: ConfigIssueReporter | undefined,
  min: number,
  max: number,
): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    report(issues, source, key, `expected an integer between ${min} and ${max}, got ${describeType(value)}`);
    return undefined;
  }
  if (value < min || value > max) {
    report(issues, source, key, `${value} is outside the allowed range ${min}..${max}`);
    return undefined;
  }
  return value;
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `${typeof value} (${JSON.stringify(value) ?? 'undefined'})`;
}

/**
 * Validates raw user-supplied config and returns only the fields that pass
 * type and range checks. Invalid values are reported through `onIssue`
 * instead of being applied, so a typo surfaces in the client log rather
 * than silently falling back to a default.
 */
export function validateConfig(
  raw: unknown,
  options: { source?: ConfigSource; onIssue?: ConfigIssueReporter } = {},
): Partial<Msvc6Config> {
  const source = options.source ?? 'initializationOptions';
  const issues = options.onIssue;
  if (raw === undefined) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    report(issues, source, source, `expected a settings object, got ${describeType(raw)}`);
    return {};
  }
  const obj = raw as Record<string, unknown>;
  const result: Partial<Mutable<Msvc6Config>> = {};

  if ('msvcBasePath' in obj) {
    if (typeof obj.msvcBasePath === 'string' && obj.msvcBasePath.length > 0) {
      result.msvcBasePath = obj.msvcBasePath;
    } else {
      report(issues, source, 'msvcBasePath', `expected a non-empty string, got ${describeType(obj.msvcBasePath)}`);
    }
  }
  if ('clPath' in obj) {
    if (typeof obj.clPath === 'string' && obj.clPath.length > 0) {
      result.clPath = obj.clPath;
    } else {
      report(issues, source, 'clPath', `expected a non-empty string, got ${describeType(obj.clPath)}`);
    }
  }
  if ('includePaths' in obj) {
    const paths = validateStringArray(obj.includePaths, 'includePaths', source, issues);
    if (paths) result.includePaths = paths;
  }
  if ('warnLevel' in obj) {
    const level = validateInteger(obj.warnLevel, 'warnLevel', source, issues, MIN_WARN_LEVEL, MAX_WARN_LEVEL);
    if (level !== undefined) result.warnLevel = level as WarnLevel;
  }
  if ('additionalFlags' in obj) {
    const flags = validateStringArray(obj.additionalFlags, 'additionalFlags', source, issues);
    if (flags) result.additionalFlags = flags;
  }
  if ('wineExecutable' in obj) {
    if (typeof obj.wineExecutable === 'string' && obj.wineExecutable.length > 0) {
      result.wineExecutable = obj.wineExecutable;
    } else {
      report(issues, source, 'wineExecutable', `expected a non-empty string, got ${describeType(obj.wineExecutable)}`);
    }
  }
  if ('useWine' in obj) {
    if (typeof obj.useWine === 'boolean') {
      result.useWine = obj.useWine;
    } else {
      report(issues, source, 'useWine', `expected a boolean, got ${describeType(obj.useWine)}`);
    }
  }
  if ('compileTimeoutMs' in obj) {
    const value = validateInteger(obj.compileTimeoutMs, 'compileTimeoutMs', source, issues, 1, MAX_COMPILE_TIMEOUT_MS);
    if (value !== undefined) result.compileTimeoutMs = value;
  }
  if ('maxOutputBytes' in obj) {
    const value = validateInteger(obj.maxOutputBytes, 'maxOutputBytes', source, issues, 1, MAX_COMPILE_TIMEOUT_MS);
    if (value !== undefined) result.maxOutputBytes = value;
  }
  if ('debounceMs' in obj) {
    const value = validateInteger(obj.debounceMs, 'debounceMs', source, issues, 0, MAX_COMPILE_TIMEOUT_MS);
    if (value !== undefined) result.debounceMs = value;
  }

  for (const key of Object.keys(obj)) {
    if (!(key in ENV_VARS_BY_FIELD)) {
      report(issues, source, key, 'unknown setting, ignored');
    }
  }

  if (result.msvcBasePath && !result.clPath) {
    result.clPath = path.join(result.msvcBasePath, 'BIN', 'CL.EXE');
  }

  return result;
}

const TRUTHY_ENV_VALUES: ReadonlySet<string> = new Set(['1', 'true', 'yes', 'on']);
const FALSY_ENV_VALUES: ReadonlySet<string> = new Set(['0', 'false', 'no', 'off']);

/**
 * Reads `MSVC6_*` environment variables into a partial config.
 *
 * A variable set to an empty string clears list-valued settings
 * (`MSVC6_INCLUDE_PATHS=`, `MSVC6_ADDITIONAL_FLAGS=`) and is an error for
 * every other setting. Unrecognized `MSVC6_*` names are reported so a
 * misspelled variable does not look like it took effect.
 */
export function loadConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  onIssue?: ConfigIssueReporter,
): Partial<Msvc6Config> {
  const source: ConfigSource = 'env';
  const result: Partial<Mutable<Msvc6Config>> = {};

  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith(ENV_PREFIX) && !RECOGNIZED_ENV_VARS.has(name)) {
      report(onIssue, source, name, 'unknown environment variable, ignored');
    }
  }

  for (const [field, name] of Object.entries(ENV_VARS_BY_FIELD)) {
    const raw = env[name];
    if (raw === undefined) continue;
    if (raw === '' && field !== 'includePaths' && field !== 'additionalFlags') {
      report(onIssue, source, name, 'set to an empty string; unset it to use the default');
      continue;
    }
    const parsed = parseEnvValue(field, raw, onIssue);
    if (parsed !== undefined) {
      (result as Record<string, unknown>)[field] = parsed;
    }
  }

  if (result.msvcBasePath && !result.clPath) {
    result.clPath = path.join(result.msvcBasePath, 'BIN', 'CL.EXE');
  }

  return result;
}

function parseEnvValue(
  field: string,
  raw: string,
  onIssue?: ConfigIssueReporter,
): string | string[] | number | boolean | undefined {
  const name = ENV_VARS_BY_FIELD[field];
  const source: ConfigSource = 'env';

  switch (field) {
    case 'includePaths': {
      if (raw === '') return [];
      const entries = raw.split(path.delimiter).map((p) => p.trim());
      return validateStringArray(entries, name, source, onIssue);
    }
    case 'additionalFlags': {
      const entries = raw.split(/\s+/).filter((f) => f.length > 0);
      return entries.length > 0 ? entries : [];
    }
    case 'warnLevel':
      return parseEnvInteger(name, raw, onIssue, MIN_WARN_LEVEL, MAX_WARN_LEVEL);
    case 'compileTimeoutMs':
    case 'debounceMs':
      return parseEnvInteger(name, raw, onIssue, 0, MAX_COMPILE_TIMEOUT_MS);
    case 'maxOutputBytes':
      return parseEnvInteger(name, raw, onIssue, 1, MAX_COMPILE_TIMEOUT_MS);
    case 'useWine': {
      const lower = raw.toLowerCase();
      if (TRUTHY_ENV_VALUES.has(lower)) return true;
      if (FALSY_ENV_VALUES.has(lower)) return false;
      report(
        onIssue,
        source,
        name,
        `expected one of true/false/1/0/yes/no/on/off, got ${JSON.stringify(raw)}`,
      );
      return undefined;
    }
    default:
      return raw;
  }
}

function parseEnvInteger(
  name: string,
  raw: string,
  onIssue: ConfigIssueReporter | undefined,
  min: number,
  max: number,
): number | undefined {
  if (!/^-?\d+$/.test(raw.trim())) {
    report(onIssue, 'env', name, `expected an integer, got ${JSON.stringify(raw)}`);
    return undefined;
  }
  return validateInteger(Number(raw.trim()), name, 'env', onIssue, min, max);
}

export interface ResolveConfigOptions {
  env?: NodeJS.ProcessEnv;
  /** Client `initializationOptions`; highest precedence. */
  initializationOptions?: unknown;
  onIssue?: ConfigIssueReporter;
}

/**
 * Builds the effective config: defaults, then environment, then client
 * initialization options. Invalid values in any layer are reported and the
 * lower-precedence value is kept.
 */
export function resolveConfig(options: ResolveConfigOptions = {}): Msvc6Config {
  const onIssue = options.onIssue;
  const fromEnv = options.env === undefined ? {} : loadConfigFromEnv(options.env, onIssue);
  const fromOptions =
    options.initializationOptions === undefined
      ? {}
      : validateConfig(options.initializationOptions, {
          source: 'initializationOptions',
          onIssue,
        });

  const base = defaultConfig();
  const merged: Msvc6Config = { ...base, ...fromEnv, ...fromOptions };

  if (!fromOptions.clPath && merged.msvcBasePath !== base.msvcBasePath) {
    merged.clPath = path.join(merged.msvcBasePath, 'BIN', 'CL.EXE');
  }
  return merged;
}

/**
 * Checks the paths the resolved config points at. Wine-internal paths
 * (`C:\msvc6\...` on a POSIX host) are resolved by Wine, not the host
 * filesystem, so they are reported but not checked here.
 */
export function checkConfig(config: Readonly<Msvc6Config>): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const source: ConfigSource = 'initializationOptions';

  if (!isWinePath(config.clPath)) {
    if (!fs.existsSync(config.clPath)) {
      issues.push({
        source,
        key: 'clPath',
        message: `${config.clPath} does not exist; set ${ENV_VARS.clPath} or ${ENV_VARS.msvcBasePath}`,
      });
    }
  } else if (!isWinePath(config.msvcBasePath)) {
    issues.push({ source, key: 'msvcBasePath', message: `${config.msvcBasePath} does not exist` });
  }

  for (const inc of config.includePaths) {
    if (isWinePath(inc) || fs.existsSync(inc)) continue;
    issues.push({
      source,
      key: ENV_VARS.includePaths,
      message: `${inc} does not exist and is not a Wine drive path`,
    });
  }

  return issues;
}

function isWinePath(candidate: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(candidate) || /^[A-Za-z]:$/.test(candidate);
}

/** One-line summary of the active config for the client log. No secrets exist in this config. */
export function describeConfig(config: Readonly<Msvc6Config>): string {
  return [
    `msvcBasePath=${config.msvcBasePath}`,
    `clPath=${config.clPath}`,
    `includePaths=[${config.includePaths.join(', ')}]`,
    `warnLevel=${config.warnLevel}`,
    `additionalFlags=[${config.additionalFlags.join(' ')}]`,
    `wineExecutable=${config.wineExecutable}`,
    `useWine=${config.useWine}`,
    `compileTimeoutMs=${config.compileTimeoutMs}`,
    `maxOutputBytes=${config.maxOutputBytes}`,
    `debounceMs=${config.debounceMs}`,
  ].join(' ');
}

/**
 * Converts a Linux/macOS filesystem path to a Wine-compatible Z:-drive path.
 *
 * Example: `/tmp/test.c` → `Z:\tmp\test.c`
 */
export function toWinePath(linuxPath: string): string {
  const absolute = path.resolve(linuxPath);
  if (/^[A-Za-z]:[\\/]/.test(absolute)) return absolute;
  return 'Z:' + absolute.replace(/\//g, '\\');
}

/**
 * Converts a Wine/Windows path back to a POSIX path.
 *
 * - `Z:\tmp\test.c` → `/tmp/test.c`
 * - `C:\msvc6\include\stdio.h` → left unchanged (internal Wine path)
 * - Generic backslash paths → forward slashes
 */
export function fromWinePath(winePath: string): string {
  if (/^[Zz]:/.test(winePath)) {
    return winePath.slice(2).replace(/\\/g, '/');
  }

  const normalized = winePath.replace(/\//g, '\\');
  const lower = normalized.toLowerCase();
  if (lower === 'c:\\msvc6' || lower.startsWith('c:\\msvc6\\')) {
    return winePath;
  }

  // Other Wine drive letters (A:-Y:) are internal Wine mappings — leave unchanged.
  if (/^[A-Ya-y]:[\\/]/.test(winePath)) {
    return winePath;
  }

  return winePath.replace(/\\/g, '/');
}
