import * as path from 'path';

/** Root of the MSVC 6.0 tree as Wine exposes it. Paths under it are not host paths. */
export const WINE_MSVC_BASE = 'C:\\msvc6';

const WINE_MSVC_BASE_LOWER = WINE_MSVC_BASE.toLowerCase();

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
