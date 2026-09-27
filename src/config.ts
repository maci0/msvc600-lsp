import * as fs from 'fs';
import * as os from 'os';
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
  /** Milliseconds an edit is held back before a syntax check starts. */
  readonly debounceMs: number;
  /** Milliseconds a single CL.EXE invocation may run before it is killed. */
  readonly checkTimeoutMs: number;
  /** Directory holding the temporary buffers handed to CL.EXE. */
  readonly tempDir: string;
}

/** Rejection reason for one configuration value. */
export type ConfigProblem = string;

/** Raised when a configuration source contains values the server cannot accept. */
export class ConfigError extends Error {
  readonly problems: readonly ConfigProblem[];

  constructor(problems: readonly ConfigProblem[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/** Prefix shared by every environment variable this server reads. */
export const ENV_PREFIX = 'MSVC6LSP_';

/**
 * Separator for list-valued environment variables. `;` is used on every
 * platform so Windows-style include paths (`C:\msvc6\include`) stay intact
 * and match the form CL.EXE itself expects in `INCLUDE`.
 */
const ENV_LIST_SEPARATOR = ';';

/** Inclusive bounds for {@link Msvc6Config.debounceMs}. */
export const DEBOUNCE_MS_RANGE = { min: 0, max: 60_000 } as const;

/** Inclusive bounds for {@link Msvc6Config.checkTimeoutMs}. */
export const CHECK_TIMEOUT_MS_RANGE = { min: 1_000, max: 600_000 } as const;

const WINE_MSVC_BASE = 'C:\\msvc6';
const WINE_INCLUDE_PATH = `${WINE_MSVC_BASE}\\include`;

/** Returns a config with sensible defaults relative to the package root. */
export function defaultConfig(): Msvc6Config {
  const msvcBasePath = path.resolve(__dirname, '..', 'VC', 'VC98');
  const useWine = process.platform !== 'win32';

  return {
    msvcBasePath,
    clPath: path.join(msvcBasePath, 'BIN', 'CL.EXE'),
    includePaths: [useWine ? WINE_INCLUDE_PATH : path.join(msvcBasePath, 'INCLUDE')],
    warnLevel: 4,
    additionalFlags: [],
    wineExecutable: 'wine',
    useWine,
    debounceMs: 300,
    checkTimeoutMs: 30_000,
    tempDir: os.tmpdir(),
  };
}

/** Strips `readonly` from all properties — used only for incremental object construction. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] extends ReadonlyArray<infer U> ? U[] : T[K] };

type ConfigFields = Partial<Mutable<Msvc6Config>>;

/** Thrown by a field parser; the message becomes the reported problem. */
class ValueError extends Error {}

interface IntRange {
  readonly min: number;
  readonly max: number;
}

interface FieldSpec {
  readonly key: keyof Msvc6Config;
  /** Environment variable name, including {@link ENV_PREFIX}. */
  readonly env: string;
  /** Whether `workspace/didChangeConfiguration` may change this field. */
  readonly runtime: boolean;
  /** Accepts the value in its native JSON form, throws {@link ValueError} otherwise. */
  readonly parse: (value: unknown) => unknown;
  /** Turns the raw environment string into the JSON form `parse` expects. */
  readonly fromEnv: (raw: string) => unknown;
}

function nonEmptyString(value: unknown): string {
  if (typeof value !== 'string') throw new ValueError('expected a string');
  if (value.length === 0) throw new ValueError('expected a non-empty string');
  return value;
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new ValueError('expected true or false');
  return value;
}

function warnLevelValue(value: unknown): WarnLevel {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ValueError('expected an integer 0-4');
  }
  if (value < 0 || value > 4) throw new ValueError('expected an integer 0-4');
  return value as WarnLevel;
}

function integerInRange(range: IntRange): (value: unknown) => number {
  return (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new ValueError(`expected an integer between ${range.min} and ${range.max}`);
    }
    if (value < range.min || value > range.max) {
      throw new ValueError(`expected an integer between ${range.min} and ${range.max}`);
    }
    return value;
  };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) throw new ValueError('expected an array of strings');
  if (!value.every((entry: unknown) => typeof entry === 'string')) {
    throw new ValueError('expected an array of strings');
  }
  return [...(value as string[])];
}

function envList(value: unknown): string[] {
  const entries = nonEmptyString(value)
    .split(ENV_LIST_SEPARATOR)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) throw new ValueError('expected a `;`-separated list with one entry');
  return entries;
}

/** Turns a decimal string into a number; anything else is left for the field parser to reject. */
function envInteger(value: unknown): unknown {
  const raw = nonEmptyString(value).trim();
  return /^[+-]?\d+$/.test(raw) ? Number(raw) : value;
}

function envBoolean(value: unknown): unknown {
  switch (nonEmptyString(value).toLowerCase()) {
    case 'true':
    case '1':
    case 'yes':
    case 'on':
      return true;
    case 'false':
    case '0':
    case 'no':
    case 'off':
      return false;
    default:
      // Left as a string so the field parser reports the accepted values.
      return value;
  }
}

const FIELDS: readonly FieldSpec[] = [
  {
    key: 'msvcBasePath',
    env: `${ENV_PREFIX}MSVC_BASE_PATH`,
    runtime: false,
    parse: nonEmptyString,
    fromEnv: (raw) => raw,
  },
  {
    key: 'clPath',
    env: `${ENV_PREFIX}CL_PATH`,
    runtime: false,
    parse: nonEmptyString,
    fromEnv: (raw) => raw,
  },
  {
    key: 'includePaths',
    env: `${ENV_PREFIX}INCLUDE_PATHS`,
    runtime: true,
    parse: stringArray,
    fromEnv: envList,
  },
  {
    key: 'warnLevel',
    env: `${ENV_PREFIX}WARN_LEVEL`,
    runtime: true,
    parse: warnLevelValue,
    fromEnv: envInteger,
  },
  {
    key: 'additionalFlags',
    env: `${ENV_PREFIX}ADDITIONAL_FLAGS`,
    runtime: false,
    parse: stringArray,
    fromEnv: envList,
  },
  {
    key: 'wineExecutable',
    env: `${ENV_PREFIX}WINE_EXECUTABLE`,
    runtime: false,
    parse: nonEmptyString,
    fromEnv: (raw) => raw,
  },
  {
    key: 'useWine',
    env: `${ENV_PREFIX}USE_WINE`,
    runtime: false,
    parse: booleanValue,
    fromEnv: envBoolean,
  },
  {
    key: 'debounceMs',
    env: `${ENV_PREFIX}DEBOUNCE_MS`,
    runtime: true,
    parse: integerInRange(DEBOUNCE_MS_RANGE),
    fromEnv: envInteger,
  },
  {
    key: 'checkTimeoutMs',
    env: `${ENV_PREFIX}CHECK_TIMEOUT_MS`,
    runtime: false,
    parse: integerInRange(CHECK_TIMEOUT_MS_RANGE),
    fromEnv: envInteger,
  },
  {
    key: 'tempDir',
    env: `${ENV_PREFIX}TEMP_DIR`,
    runtime: false,
    parse: nonEmptyString,
    fromEnv: (raw) => raw,
  },
];

/** Field names `workspace/didChangeConfiguration` is allowed to change. */
export const RUNTIME_CHANGEABLE_KEYS: readonly (keyof Msvc6Config)[] = FIELDS.filter(
  (field) => field.runtime,
).map((field) => field.key);

/** Every accepted `initializationOptions` field name. */
export const CONFIG_KEYS: readonly (keyof Msvc6Config)[] = FIELDS.map((field) => field.key);

/** Environment variable name for a field, e.g. `MSVC6LSP_WARN_LEVEL`. */
export function envNameFor(key: keyof Msvc6Config): string | undefined {
  return FIELDS.find((field) => field.key === key)?.env;
}

function assign(value: ConfigFields, key: keyof Msvc6Config, parsed: unknown): void {
  (value as Record<string, unknown>)[key] = parsed;
}

/**
 * Runs the parsers for `fields` over `raw`, collecting the accepted values and
 * the reasons for the rest. With `reportUnknown`, keys outside `fields` are
 * reported; with `strict`, they are reported as errors by the caller.
 */
function collect(
  raw: unknown,
  fields: readonly FieldSpec[],
  opts: { reportUnknown: boolean },
): { value: ConfigFields; problems: ConfigProblem[] } {
  if (raw === undefined || raw === null) return { value: {}, problems: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { value: {}, problems: ['expected an object of configuration fields'] };
  }

  const obj = raw as Record<string, unknown>;
  const value: ConfigFields = {};
  const problems: ConfigProblem[] = [];

  for (const field of fields) {
    if (!(field.key in obj)) continue;
    try {
      assign(value, field.key, field.parse(obj[field.key]));
    } catch (e) {
      problems.push(
        `${field.key}: ${e instanceof ValueError ? e.message : 'invalid value'} (got ${describe(obj[field.key])})`,
      );
    }
  }

  if (opts.reportUnknown) {
    const known = new Set<string>(fields.map((field) => field.key as string));
    for (const key of Object.keys(obj)) {
      if (!known.has(key)) problems.push(`unknown option "${key}"`);
    }
  }

  if (value.msvcBasePath && !value.clPath) {
    value.clPath = path.join(value.msvcBasePath, 'BIN', 'CL.EXE');
  }

  return { value, problems };
}

function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return JSON.stringify(value);
  if (value === null) return 'null';
  return String(value);
}

/**
 * Validates raw user-supplied config and returns only the fields that pass
 * type and range checks. Invalid fields are silently dropped so the
 * caller can merge the result with {@link defaultConfig}.
 */
export function validateConfig(raw: unknown): Partial<Msvc6Config> {
  return collect(raw, FIELDS, { reportUnknown: false }).value;
}

/**
 * Validates `initializationOptions`: every value is parsed and unknown fields
 * are rejected, so a misspelled key fails the handshake instead of quietly
 * leaving a default in place.
 */
export function parseInitializationOptions(raw: unknown): ConfigFields {
  const { value, problems } = collect(raw, FIELDS, { reportUnknown: true });
  if (problems.length > 0) throw new ConfigError(problems);
  return value;
}

/**
 * Reads the server settings from the environment. A variable that is set to an
 * empty string is reported rather than treated as unset, so a typo in a launch
 * command fails loudly instead of reverting to a default.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ConfigFields {
  const value: ConfigFields = {};
  const problems: ConfigProblem[] = [];

  for (const field of FIELDS) {
    const raw = env[field.env];
    if (raw === undefined) continue;
    if (raw.length === 0) {
      problems.push(`${field.env} is set but empty`);
      continue;
    }
    try {
      assign(value, field.key, field.parse(field.fromEnv(raw)));
    } catch (e) {
      problems.push(
        `${field.env}: ${e instanceof ValueError ? e.message : 'invalid value'} (got ${JSON.stringify(raw)})`,
      );
    }
  }

  const known = new Set<string>(FIELDS.map((field) => field.env));
  for (const name of Object.keys(env)) {
    if (name.startsWith(ENV_PREFIX) && !known.has(name)) {
      problems.push(`unknown environment variable "${name}"`);
    }
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return value;
}

/**
 * Builds the effective configuration.
 *
 * Precedence, lowest to highest: {@link defaultConfig}, environment variables,
 * `initializationOptions`. When `msvcBasePath` is overridden and no include
 * paths are given, the include paths follow that root instead of the default.
 */
export function resolveConfig(
  initializationOptions?: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Msvc6Config {
  const options = parseInitializationOptions(initializationOptions);
  const fromEnv = configFromEnv(env);

  const config: Msvc6Config = { ...defaultConfig(), ...fromEnv, ...options };

  const msvcBasePath = options.msvcBasePath ?? fromEnv.msvcBasePath;
  if (msvcBasePath === undefined) return config;

  const includesGiven = options.includePaths ?? fromEnv.includePaths;
  const clPathGiven = options.clPath ?? fromEnv.clPath;

  const derived: Msvc6Config = {
    ...config,
    clPath: clPathGiven ?? path.join(msvcBasePath, 'BIN', 'CL.EXE'),
  };

  return includesGiven === undefined
    ? {
        ...derived,
        includePaths: [
          config.useWine ? WINE_INCLUDE_PATH : path.join(msvcBasePath, 'INCLUDE'),
        ],
      }
    : derived;
}

/** Result of a `workspace/didChangeConfiguration` update. */
export interface RuntimeConfigUpdate {
  /** The accepted fields. */
  readonly value: ConfigFields;
  /** Why the remaining fields were not applied. */
  readonly problems: readonly ConfigProblem[];
}

/**
 * Validates a `didChangeConfiguration` payload, accepting only the fields that
 * are safe to change while the server runs. Problems are returned instead of
 * thrown: a bad client setting must not take the server down.
 */
export function applyRuntimeConfig(raw: unknown): RuntimeConfigUpdate {
  const runtimeFields = FIELDS.filter((field) => field.runtime);
  const { value, problems } = collect(raw, runtimeFields, { reportUnknown: true });
  return { value, problems };
}

/** True for paths CL.EXE can open but the host filesystem cannot stat, e.g. `C:\msvc6`. */
function isForeignPath(candidate: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(candidate);
}

function findOnPath(command: string, env: NodeJS.ProcessEnv): string | undefined {
  if (command.includes('/') || path.isAbsolute(command)) {
    return fs.existsSync(command) ? command : undefined;
  }
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (dir.length === 0) continue;
    const candidate = path.join(dir, command);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Fails at startup when the resolved executables or the temp directory are
 * missing, instead of failing on every keystroke with a spawn error.
 */
export function assertRuntimePaths(
  config: Readonly<Msvc6Config>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const problems: ConfigProblem[] = [];

  if (!isForeignPath(config.clPath) && !fs.existsSync(config.clPath)) {
    problems.push(`clPath does not exist: ${config.clPath} (set clPath or ${ENV_PREFIX}CL_PATH)`);
  }

  if (config.useWine && findOnPath(config.wineExecutable, env) === undefined) {
    problems.push(
      `wine executable not found: ${config.wineExecutable} (set wineExecutable or ${ENV_PREFIX}WINE_EXECUTABLE)`,
    );
  }

  if (!fs.existsSync(config.tempDir) || !fs.statSync(config.tempDir).isDirectory()) {
    problems.push(`tempDir is not a directory: ${config.tempDir} (set tempDir or ${ENV_PREFIX}TEMP_DIR)`);
  }

  if (problems.length > 0) throw new ConfigError(problems);
}

/**
 * Renders the active configuration for the startup log. Paths under the user's
 * home directory are shortened to `~` so the log does not carry the account name.
 */
export function formatConfigForLog(
  config: Readonly<Msvc6Config>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const home = env.HOME ?? env.USERPROFILE;
  const shorten = (candidate: string): string => {
    if (!home) return candidate;
    if (candidate === home) return '~';
    return candidate.startsWith(home + path.sep) ? '~' + candidate.slice(home.length) : candidate;
  };

  return [
    `msvcBasePath=${shorten(config.msvcBasePath)}`,
    `clPath=${shorten(config.clPath)}`,
    `includePaths=[${config.includePaths.map(shorten).join(', ')}]`,
    `warnLevel=${config.warnLevel}`,
    `additionalFlags=[${config.additionalFlags.join(' ')}]`,
    `wineExecutable=${config.wineExecutable}`,
    `useWine=${config.useWine}`,
    `debounceMs=${config.debounceMs}`,
    `checkTimeoutMs=${config.checkTimeoutMs}`,
    `tempDir=${shorten(config.tempDir)}`,
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
