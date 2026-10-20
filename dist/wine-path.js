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
exports.WINE_MSVC_BASE = void 0;
exports.toWinePath = toWinePath;
exports.fromWinePath = fromWinePath;
const path = __importStar(require("path"));
/** Root of the MSVC 6.0 tree as Wine exposes it. Paths under it are not host paths. */
exports.WINE_MSVC_BASE = 'C:\\msvc6';
const WINE_MSVC_BASE_LOWER = exports.WINE_MSVC_BASE.toLowerCase();
/** Drive Wine exposes the Unix root as. */
const Z_DRIVE = 'Z:';
/** A drive-letter prefix, which is already a Wine path in whatever letter it names. */
const DRIVE_PREFIX = /^[A-Za-z]:[\\/]/;
/**
 * Converts a host filesystem path to a Wine-compatible Z:-drive path.
 *
 * Example: `/tmp/test.c` → `Z:\tmp\test.c`
 *
 * The decision is made on the input, not on `path.resolve` of it. A path that
 * already names a drive is returned as it stands: `path.resolve` reads a bare
 * `C:\msvc6\include` as a relative POSIX segment, so resolving first would glue
 * the working directory in front of it and hand CL.EXE a `Z:` path with a drive
 * letter in the middle. On a Windows host `path.resolve('/tmp/test.c')` answers
 * `C:\tmp\test.c`, which would be handed back as a native path and never reach
 * the Unix root Wine mounts on `Z:`. A path that is absolute under POSIX rules
 * keeps its leading slash and maps to `Z:`; a relative path is resolved against
 * the host's own rules, then mapped to `Z:` unless the resolution named a drive
 * (on a Windows host a relative path resolves to `C:\...` and stays native).
 */
function toWinePath(hostPath) {
    if (DRIVE_PREFIX.test(hostPath))
        return hostPath;
    if (hostPath.startsWith('/')) {
        return Z_DRIVE + hostPath.replace(/\//g, '\\');
    }
    const absolute = path.resolve(hostPath);
    if (DRIVE_PREFIX.test(absolute))
        return absolute;
    // A host path that resolves without a drive, which is what a POSIX input
    // does on a Windows host, still belongs under the Unix root Wine mounts on
    // Z:. The leading separator is dropped so the result keeps one `Z:\` prefix
    // rather than gaining a doubled one.
    return `${Z_DRIVE}\\${absolute.replace(/^[\\/]+/, '').replace(/\//g, '\\')}`;
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
    const normalized = winePath.replace(/\//g, '\\').toLowerCase();
    if (normalized === WINE_MSVC_BASE_LOWER ||
        normalized.startsWith(`${WINE_MSVC_BASE_LOWER}\\`)) {
        return winePath;
    }
    // Other Wine drive letters (A:-Y:) are internal Wine mappings — leave unchanged.
    if (/^[A-Ya-y]:[\\/]/.test(winePath)) {
        return winePath;
    }
    return winePath.replace(/\\/g, '/');
}
//# sourceMappingURL=wine-path.js.map