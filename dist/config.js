"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ENV_NAMES = exports.ENV_PREFIX = exports.RUNTIME_KEYS = exports.DEFAULT_MAX_OUTPUT_BYTES = exports.DEFAULT_CHECK_TIMEOUT_MS = exports.DEFAULT_WINE_EXECUTABLE = exports.DEFAULT_WARN_LEVEL = exports.DEFAULT_OUTPUT_ENCODING = exports.SCRATCH_EXTENSIONS = exports.CPP_SCRATCH_EXTENSION = exports.C_SCRATCH_EXTENSION = exports.ALL_EXTENSIONS = exports.CPP_EXTENSIONS = exports.C_EXTENSIONS = void 0;
exports.defaultIncludePaths = defaultIncludePaths;
exports.defaultConfig = defaultConfig;
exports.validateConfig = validateConfig;
exports.mergeValidated = mergeValidated;
exports.runtimeConfigUpdate = runtimeConfigUpdate;
exports.runtimeConfigEquals = runtimeConfigEquals;
exports.configFromEnv = configFromEnv;
exports.formatIssues = formatIssues;
const path = __importStar(require("path"));
const wine_path_1 = require("./wine-path");
/**
 * Supported C/C++ file extensions for syntax checking.
 * Translation units (.c, .cpp, .cxx, .cc) are compiled directly.
 * Headers (.h, .hpp, .hxx) are supported but may produce false positives
 * when compiled as standalone translation units.
 */
exports.C_EXTENSIONS = ['.c'];
exports.CPP_EXTENSIONS = ['.cpp', '.cxx', '.cc', '.hpp', '.hxx'];
exports.ALL_EXTENSIONS = [...exports.C_EXTENSIONS, ...exports.CPP_EXTENSIONS, '.h'];
/**
 * Suffix a scratch source is staged under, one per CL.EXE language mode. The
 * staged suffix, not the document's, is what `buildArgs` reads, so it decides
 * whether the check runs under `/TC` or `/TP`.
 */
exports.C_SCRATCH_EXTENSION = '.c';
exports.CPP_SCRATCH_EXTENSION = '.cpp';
/**
 * Every suffix a scratch source can carry. The stale-file sweep filters on this
 * list, so a scratch file staged under a suffix missing here would never be
 * reclaimed after a crash.
 */
exports.SCRATCH_EXTENSIONS = [exports.C_SCRATCH_EXTENSION, exports.CPP_SCRATCH_EXTENSION];
/** CL.EXE diagnostics are ASCII-safe under Wine's UTF-8 console by default. */
exports.DEFAULT_OUTPUT_ENCODING = 'utf8';
/** Most verbose warning level; MSVC6 has no higher one to ask for. */
exports.DEFAULT_WARN_LEVEL = 4;
/** Wine is installed under this name unless the user points at another build. */
exports.DEFAULT_WINE_EXECUTABLE = 'wine';
/** A check that takes longer than this is killed; a hung Wine is worse than no check. */
exports.DEFAULT_CHECK_TIMEOUT_MS = 30_000;
/** Cap on captured CL.EXE output. Past it the tail of the diagnostic list is lost. */
exports.DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
/**
 * The `/I` entry for a given base and Wine mode. Under Wine the headers are
 * read from the case-insensitive overlay in the prefix rather than from
 * `msvcBasePath`, so the base does not enter the path.
 */
function defaultIncludePaths(msvcBasePath, useWine) {
    return [useWine ? `${wine_path_1.WINE_MSVC_BASE}\\include` : path.join(msvcBasePath, 'INCLUDE')];
}
/** Returns a config with sensible defaults relative to the package root. */
function defaultConfig() {
    const msvcBasePath = path.resolve(__dirname, '..', 'VC', 'VC98');
    const useWine = process.platform !== 'win32';
    return {
        msvcBasePath,
        clPath: path.join(msvcBasePath, 'BIN', 'CL.EXE'),
        includePaths: defaultIncludePaths(msvcBasePath, useWine),
        warnLevel: exports.DEFAULT_WARN_LEVEL,
        additionalFlags: [],
        wineExecutable: exports.DEFAULT_WINE_EXECUTABLE,
        outputEncoding: exports.DEFAULT_OUTPUT_ENCODING,
        useWine,
        checkTimeoutMs: exports.DEFAULT_CHECK_TIMEOUT_MS,
        maxOutputBytes: exports.DEFAULT_MAX_OUTPUT_BYTES,
    };
}
/**
 * Every accepted key, taken from the config shape itself so a new option
 * cannot be accepted by the field checks below and then reported as unknown.
 */
const KNOWN_KEYS = Object.keys(defaultConfig());
/**
 * Validates raw user-supplied config (an `initializationOptions` object or a
 * `settings.msvc6` object) and returns the fields that pass type and range
 * checks together with the fields that were dropped. The caller merges
 * `values` into the running config and reports `issues`, so a misspelled key
 * or a bad type surfaces instead of leaving the previous value in place
 * unexplained.
 */
function validateConfig(raw) {
    if (raw === undefined || raw === null)
        return { values: {}, issues: [] };
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        return { values: {}, issues: [{ key: '', message: `expected an object, got ${describe(raw)}` }] };
    }
    const obj = raw;
    const result = {};
    const issues = [];
    const takeString = (key) => {
        const value = obj[key];
        if (value === undefined)
            return;
        if (typeof value === 'string' && value.length > 0)
            result[key] = value;
        else
            issues.push({ key, message: `expected a non-empty string, got ${describe(value)}` });
    };
    const takeStringArray = (key) => {
        const value = obj[key];
        if (value === undefined)
            return;
        if (Array.isArray(value) && value.every((e) => typeof e === 'string')) {
            result[key] = [...value];
        }
        else {
            issues.push({ key, message: `expected an array of strings, got ${describe(value)}` });
        }
    };
    const takePositiveInt = (key) => {
        const value = obj[key];
        if (value === undefined)
            return;
        if (typeof value === 'number' && Number.isInteger(value) && value > 0)
            result[key] = value;
        else
            issues.push({ key, message: `expected a positive integer, got ${describe(value)}` });
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
            result.warnLevel = level;
        }
        else {
            issues.push({ key: 'warnLevel', message: `expected an integer 0-4, got ${describe(level)}` });
        }
    }
    if (obj.outputEncoding !== undefined) {
        const encoding = obj.outputEncoding;
        if (typeof encoding === 'string' && isSupportedEncoding(encoding)) {
            result.outputEncoding = encoding;
        }
        else {
            issues.push({
                key: 'outputEncoding',
                message: `unknown encoding label ${describe(encoding)}; TextDecoder does not know it`,
            });
        }
    }
    if (obj.useWine !== undefined) {
        if (typeof obj.useWine === 'boolean') {
            result.useWine = obj.useWine;
        }
        else {
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
function describe(value) {
    if (typeof value === 'string')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `an array of ${value.length}`;
    if (value === null)
        return 'null';
    if (typeof value === 'number' || typeof value === 'boolean')
        return String(value);
    return typeof value;
}
/**
 * Overlays a source's accepted fields on the running config. Fields the source
 * did not set, or set to a value that failed validation, keep the value the
 * earlier source gave them, which is what makes the order of the sources the
 * precedence order.
 */
function mergeValidated(base, source) {
    return { ...base, ...source.values };
}
/**
 * Fields a `workspace/didChangeConfiguration` notification is allowed to
 * replace. The rest are fixed at initialization, so a notification carrying
 * them has to say so rather than leave the previous value in place silently.
 */
exports.RUNTIME_KEYS = ['includePaths', 'warnLevel'];
/**
 * Selects the runtime-settable fields out of a validated notification. A field
 * outside {@link RUNTIME_KEYS} is returned in `ignored` when it validated, so
 * the caller can report a value the client believes it applied.
 */
function runtimeConfigUpdate(validated) {
    const values = {};
    const ignored = [];
    for (const [key, value] of Object.entries(validated.values)) {
        if (exports.RUNTIME_KEYS.includes(key)) {
            values[key] = value;
        }
        else {
            ignored.push(key);
        }
    }
    return { values, ignored };
}
/**
 * Compares the fields a runtime configuration change is allowed to replace
 * (`includePaths`, `warnLevel`). A repeated notification carrying the same
 * settings leaves the effective config unchanged, which is the signal to skip
 * re-checking every open document.
 */
function runtimeConfigEquals(a, b) {
    return (a.warnLevel === b.warnLevel &&
        a.includePaths.length === b.includePaths.length &&
        a.includePaths.every((p, i) => p === b.includePaths[i]));
}
/**
 * Whether `TextDecoder` knows this encoding label. An unknown label throws at
 * decode time, long after the user set it, so it is rejected at load instead.
 */
function isSupportedEncoding(label) {
    try {
        new TextDecoder(label);
        return true;
    }
    catch {
        return false;
    }
}
/** Prefix every environment variable carrying server configuration. */
exports.ENV_PREFIX = 'MSVC600_';
/**
 * Separator for list-valued environment variables. A semicolon, not the
 * platform delimiter, because the entries are Wine paths whose drive letters
 * already contain a colon.
 */
const ENV_LIST_SEPARATOR = ';';
/** Environment variable (without {@link ENV_PREFIX}) to config field. */
const ENV_KEYS = {
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
const ENV_INT_KEYS = new Set(['WARN_LEVEL', 'CHECK_TIMEOUT_MS', 'MAX_OUTPUT_BYTES']);
/** Environment variables parsed as lists. */
const ENV_LIST_KEYS = new Set(['INCLUDE_PATHS', 'ADDITIONAL_FLAGS']);
/** Every accepted environment variable name, prefix included. */
exports.ENV_NAMES = Object.keys(ENV_KEYS).map((k) => `${exports.ENV_PREFIX}${k}`);
/** Field name back to the environment variable that sets it, for issue messages. */
const ENV_NAME_BY_FIELD = Object.fromEntries(Object.entries(ENV_KEYS).map(([name, field]) => [field, `${exports.ENV_PREFIX}${name}`]));
/**
 * Reads the `MSVC600_*` environment variables into the same validated shape as
 * `initializationOptions`, so a launch that cannot pass options (a remote
 * session, a container, an editor that only sets an environment) configures the
 * server the same way. A variable that is unset is left out; a variable that is
 * set to an empty string is rejected, because "no include paths" and "no
 * include paths configured" are different setups and only one of them is what
 * the user meant.
 */
function configFromEnv(env = process.env) {
    const raw = {};
    const issues = [];
    for (const [name, field] of Object.entries(ENV_KEYS)) {
        const value = env[`${exports.ENV_PREFIX}${name}`];
        if (value === undefined)
            continue;
        if (value === '') {
            issues.push({ key: ENV_NAME_BY_FIELD[field], message: 'is set but empty' });
            continue;
        }
        if (ENV_LIST_KEYS.has(name)) {
            raw[field] = value
                .split(ENV_LIST_SEPARATOR)
                .map((entry) => entry.trim())
                .filter((entry) => entry.length > 0);
        }
        else if (ENV_INT_KEYS.has(name)) {
            const parsed = Number(value.trim());
            raw[field] = Number.isInteger(parsed) ? parsed : value;
        }
        else if (name === 'USE_WINE') {
            const normalized = value.trim().toLowerCase();
            raw[field] =
                normalized === 'true' || normalized === '1'
                    ? true
                    : normalized === 'false' || normalized === '0'
                        ? false
                        : value;
        }
        else {
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
function formatIssues(source, issues) {
    return issues.map((issue) => issue.key === ''
        ? `msvc600-lsp: ${source} ignored: ${issue.message}`
        : `msvc600-lsp: ${source} rejected ${issue.key}: ${issue.message}`);
}
//# sourceMappingURL=config.js.map