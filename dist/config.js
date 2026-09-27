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
exports.ALL_EXTENSIONS = exports.CPP_EXTENSIONS = exports.C_EXTENSIONS = void 0;
exports.defaultConfig = defaultConfig;
exports.validateConfig = validateConfig;
exports.toWinePath = toWinePath;
exports.fromWinePath = fromWinePath;
const path = __importStar(require("path"));
/**
 * Supported C/C++ file extensions for syntax checking.
 * Translation units (.c, .cpp, .cxx, .cc) are compiled directly.
 * Headers (.h, .hpp, .hxx) are supported but may produce false positives
 * when compiled as standalone translation units.
 */
exports.C_EXTENSIONS = ['.c'];
exports.CPP_EXTENSIONS = ['.cpp', '.cxx', '.cc', '.hpp', '.hxx'];
exports.ALL_EXTENSIONS = [...exports.C_EXTENSIONS, ...exports.CPP_EXTENSIONS, '.h'];
const WINE_MSVC_BASE = 'C:\\msvc6';
/** Returns a config with sensible defaults relative to the package root. */
function defaultConfig() {
    const msvcBasePath = path.resolve(__dirname, '..', 'VC', 'VC98');
    const useWine = process.platform !== 'win32';
    return {
        msvcBasePath,
        clPath: path.join(msvcBasePath, 'BIN', 'CL.EXE'),
        includePaths: [useWine ? `${WINE_MSVC_BASE}\\include` : path.join(msvcBasePath, 'INCLUDE')],
        warnLevel: 4,
        additionalFlags: [],
        wineExecutable: 'wine',
        useWine,
    };
}
/**
 * Validates raw user-supplied config and returns only the fields that pass
 * type and range checks. Invalid fields are silently dropped so the
 * caller can merge the result with {@link defaultConfig}.
 */
function validateConfig(raw) {
    if (!raw || typeof raw !== 'object')
        return {};
    const obj = raw;
    const result = {};
    if (typeof obj.msvcBasePath === 'string' && obj.msvcBasePath.length > 0) {
        result.msvcBasePath = obj.msvcBasePath;
    }
    if (typeof obj.clPath === 'string' && obj.clPath.length > 0) {
        result.clPath = obj.clPath;
    }
    if (Array.isArray(obj.includePaths) &&
        obj.includePaths.every((p) => typeof p === 'string')) {
        result.includePaths = [...obj.includePaths];
    }
    if (typeof obj.warnLevel === 'number' &&
        Number.isInteger(obj.warnLevel) &&
        obj.warnLevel >= 0 &&
        obj.warnLevel <= 4) {
        result.warnLevel = obj.warnLevel;
    }
    if (Array.isArray(obj.additionalFlags) &&
        obj.additionalFlags.every((f) => typeof f === 'string')) {
        result.additionalFlags = [...obj.additionalFlags];
    }
    if (typeof obj.wineExecutable === 'string' && obj.wineExecutable.length > 0) {
        result.wineExecutable = obj.wineExecutable;
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
 * Converts a Linux/macOS filesystem path to a Wine-compatible Z:-drive path.
 *
 * Example: `/tmp/test.c` → `Z:\tmp\test.c`
 */
function toWinePath(linuxPath) {
    const absolute = path.resolve(linuxPath);
    if (/^[A-Za-z]:[\\/]/.test(absolute))
        return absolute;
    return 'Z:' + absolute.replace(/\//g, '\\');
}
/**
 * Converts a Wine/Windows path back to a POSIX path.
 *
 * - `Z:\tmp\test.c` → `/tmp/test.c`
 * - `C:\msvc6\include\stdio.h` → left unchanged (internal Wine path)
 * - Generic backslash paths → forward slashes
 */
function fromWinePath(winePath) {
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
//# sourceMappingURL=config.js.map