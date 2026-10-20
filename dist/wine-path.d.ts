/** Root of the MSVC 6.0 tree as Wine exposes it. Paths under it are not host paths. */
export declare const WINE_MSVC_BASE = "C:\\msvc6";
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
export declare function toWinePath(hostPath: string): string;
/**
 * Converts a Wine/Windows path back to a POSIX path.
 *
 * - `Z:\tmp\test.c` → `/tmp/test.c`
 * - `C:\msvc6\include\stdio.h` → left unchanged (internal Wine path)
 * - Generic backslash paths → forward slashes
 */
export declare function fromWinePath(winePath: string): string;
//# sourceMappingURL=wine-path.d.ts.map