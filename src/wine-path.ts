import * as path from 'path';

/** Root of the MSVC 6.0 tree as Wine exposes it. Paths under it are not host paths. */
export const WINE_MSVC_BASE = 'C:\\msvc6';

const WINE_MSVC_BASE_LOWER = WINE_MSVC_BASE.toLowerCase();

/** Drive Wine exposes the Unix root as. */
const Z_DRIVE = 'Z:';

/** A path already carrying a Windows drive letter, e.g. `C:\msvc6` or `C:/x`. */
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;

/**
 * Converts a host filesystem path to a Wine-compatible Z:-drive path.
 *
 * Example: `/tmp/test.c` → `Z:\tmp\test.c`
 *
 * The decision is made on the input, not on `path.resolve` of it: on a Windows
 * host `path.resolve('/tmp/test.c')` answers `C:\tmp\test.c`, which would be
 * handed back as a native path and never reach the Unix root Wine mounts on
 * `Z:`. A path that is absolute under POSIX rules keeps its leading slash and
 * maps to `Z:`; a relative path is resolved against the host's own rules, so on
 * Windows it stays a Windows path.
 */
export function toWinePath(hostPath: string): string {
  if (WINDOWS_ABSOLUTE.test(hostPath)) return hostPath;
  if (hostPath.startsWith('/')) {
    return Z_DRIVE + hostPath.replace(/\//g, '\\');
  }
  const absolute = path.resolve(hostPath);
  if (WINDOWS_ABSOLUTE.test(absolute)) return absolute;
  return Z_DRIVE + absolute.replace(/\//g, '\\');
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

  const normalized = winePath.replace(/\//g, '\\').toLowerCase();
  if (
    normalized === WINE_MSVC_BASE_LOWER ||
    normalized.startsWith(`${WINE_MSVC_BASE_LOWER}\\`)
  ) {
    return winePath;
  }

  // Other Wine drive letters (A:-Y:) are internal Wine mappings — leave unchanged.
  if (/^[A-Ya-y]:[\\/]/.test(winePath)) {
    return winePath;
  }

  return winePath.replace(/\\/g, '/');
}
