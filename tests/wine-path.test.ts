import { describe, it, expect } from 'vitest';
import { toWinePath, fromWinePath } from '../src/wine-path';

describe('toWinePath', () => {
  it('converts absolute Linux path to Wine Z: path', () => {
    expect(toWinePath('/tmp/test.c')).toBe('Z:\\tmp\\test.c');
  });

  it('converts path with deep nesting', () => {
    expect(toWinePath('/home/user/project/src/main.c')).toBe(
      'Z:\\home\\user\\project\\src\\main.c',
    );
  });

  it('handles paths with spaces', () => {
    expect(toWinePath('/tmp/my project/file.c')).toBe(
      'Z:\\tmp\\my project\\file.c',
    );
  });

  it('resolves relative path before converting', () => {
    const result = toWinePath('relative/path.c');
    expect(result).toMatch(/^Z:\\/);
    expect(result).toContain('relative\\path.c');
  });

  it('leaves a path that already names a drive alone', () => {
    // Resolving first would read this as a relative POSIX segment and produce
    // Z:\<cwd>\C:\msvc6\include, a drive letter in the middle of a Z: path.
    expect(toWinePath('C:\\msvc6\\include')).toBe('C:\\msvc6\\include');
    expect(toWinePath('C:/msvc6/include')).toBe('C:/msvc6/include');
    expect(toWinePath('z:\\share\\headers')).toBe('z:\\share\\headers');
  });

  it('maps a POSIX absolute path to Z: without asking path.resolve', () => {
    // `path.resolve` on a Windows host would answer `C:\tmp\test.c` for this
    // input, which never reaches the Unix root Wine mounts on Z:.
    expect(toWinePath('/tmp/test.c')).toBe('Z:\\tmp\\test.c');
  });
});

describe('fromWinePath', () => {
  it('converts Z: Wine path back to Linux path', () => {
    expect(fromWinePath('Z:/tmp/test.c')).toBe('/tmp/test.c');
  });

  it('handles lowercase z: prefix', () => {
    expect(fromWinePath('z:/tmp/test.c')).toBe('/tmp/test.c');
  });

  it('handles backslash separators', () => {
    expect(fromWinePath('Z:\\tmp\\test.c')).toBe('/tmp/test.c');
  });

  it('leaves C:\\msvc6 paths unchanged', () => {
    const p = 'C:\\msvc6\\include\\stdio.h';
    expect(fromWinePath(p)).toBe(p);
  });

  it('leaves C:/msvc6 forward-slash paths unchanged', () => {
    const p = 'C:/msvc6/include/stdio.h';
    expect(fromWinePath(p)).toBe(p);
  });

  it('leaves lowercase c:\\msvc6 paths unchanged', () => {
    const p = 'c:\\msvc6\\include\\stdio.h';
    expect(fromWinePath(p)).toBe(p);
  });

  it('converts generic backslash paths to forward slashes', () => {
    expect(fromWinePath('some\\path\\file.c')).toBe('some/path/file.c');
  });

  it('handles empty string', () => {
    expect(fromWinePath('')).toBe('');
  });

  it('leaves non-Z/non-C drive letter paths unchanged', () => {
    expect(fromWinePath('D:\\data\\file.c')).toBe('D:\\data\\file.c');
    expect(fromWinePath('E:/share/test.h')).toBe('E:/share/test.h');
  });

  it('leaves lowercase non-Z/non-C drive letter paths unchanged', () => {
    expect(fromWinePath('d:\\data\\file.c')).toBe('d:\\data\\file.c');
  });

  it('does not false-match paths starting with C:\\msvc6 but not followed by backslash', () => {
    // C:\msvc6_backup is NOT the Wine MSVC overlay — should fall through to drive-letter handler
    expect(fromWinePath('C:\\msvc6_backup\\file.c')).toBe('C:\\msvc6_backup\\file.c');
    expect(fromWinePath('c:\\msvc6data\\file.c')).toBe('c:\\msvc6data\\file.c');
  });

  it('handles exact C:\\msvc6 without trailing path', () => {
    expect(fromWinePath('C:\\msvc6')).toBe('C:\\msvc6');
  });
});

describe('toWinePath / fromWinePath roundtrip', () => {
  // Deterministic property-like tests: absolute POSIX paths should survive
  // toWinePath → fromWinePath roundtrip.
  const posixPaths = [
    '/tmp/test.c',
    '/home/user/project/src/main.cpp',
    '/usr/local/include/header.h',
    '/a',
    '/tmp/with spaces/file.c',
    '/tmp/with-special_chars/123.cxx',
  ];

  for (const p of posixPaths) {
    it(`roundtrips: ${p}`, () => {
      const wine = toWinePath(p);
      const back = fromWinePath(wine);
      expect(back).toBe(p);
    });
  }
});
