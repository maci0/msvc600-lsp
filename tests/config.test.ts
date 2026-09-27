import { describe, it, expect } from 'vitest';
import {
  toWinePath,
  fromWinePath,
  defaultConfig,
  validateConfig,
  C_EXTENSIONS,
  CPP_EXTENSIONS,
  ALL_EXTENSIONS,
} from '../src/config';
import type { WarnLevel } from '../src/config';

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

describe('defaultConfig', () => {
  it('returns a valid config object', () => {
    const cfg = defaultConfig();
    expect(cfg.warnLevel).toBe(4);
    expect(cfg.clPath).toContain('CL.EXE');
    expect(cfg.includePaths.length).toBeGreaterThan(0);
    expect(cfg.wineExecutable).toBe('wine');
  });

  it('sets useWine based on platform', () => {
    const cfg = defaultConfig();
    if (process.platform === 'win32') {
      expect(cfg.useWine).toBe(false);
    } else {
      expect(cfg.useWine).toBe(true);
    }
  });
});

describe('validateConfig', () => {
  it('returns empty object for null/undefined/non-object', () => {
    expect(validateConfig(null)).toEqual({});
    expect(validateConfig(undefined)).toEqual({});
    expect(validateConfig('string')).toEqual({});
    expect(validateConfig(42)).toEqual({});
  });

  it('accepts valid warnLevel values (0-4)', () => {
    for (const level of [0, 1, 2, 3, 4] as WarnLevel[]) {
      const result = validateConfig({ warnLevel: level });
      expect(result.warnLevel).toBe(level);
    }
  });

  it('rejects invalid warnLevel values', () => {
    expect(validateConfig({ warnLevel: -1 })).toEqual({});
    expect(validateConfig({ warnLevel: 5 })).toEqual({});
    expect(validateConfig({ warnLevel: 99 })).toEqual({});
    expect(validateConfig({ warnLevel: 2.5 })).toEqual({});
    expect(validateConfig({ warnLevel: 'high' })).toEqual({});
  });

  it('accepts valid string fields', () => {
    const result = validateConfig({
      msvcBasePath: '/opt/msvc',
      clPath: '/opt/msvc/BIN/CL.EXE',
      wineExecutable: '/usr/bin/wine64',
    });
    expect(result.msvcBasePath).toBe('/opt/msvc');
    expect(result.clPath).toBe('/opt/msvc/BIN/CL.EXE');
    expect(result.wineExecutable).toBe('/usr/bin/wine64');
  });

  it('rejects non-string values for string fields', () => {
    const result = validateConfig({
      msvcBasePath: 42,
      clPath: true,
      wineExecutable: null,
    });
    expect(result.msvcBasePath).toBeUndefined();
    expect(result.clPath).toBeUndefined();
    expect(result.wineExecutable).toBeUndefined();
  });

  it('accepts valid array fields with all-string elements', () => {
    const result = validateConfig({
      includePaths: ['/usr/include', 'C:\\msvc6\\include'],
      additionalFlags: ['/D_DEBUG', '/GX'],
    });
    expect(result.includePaths).toEqual(['/usr/include', 'C:\\msvc6\\include']);
    expect(result.additionalFlags).toEqual(['/D_DEBUG', '/GX']);
  });

  it('rejects arrays containing non-string elements', () => {
    const result = validateConfig({
      includePaths: ['/valid', 42, null],
      additionalFlags: 'not-an-array',
    });
    expect(result.includePaths).toBeUndefined();
    expect(result.additionalFlags).toBeUndefined();
  });

  it('accepts boolean useWine', () => {
    expect(validateConfig({ useWine: true }).useWine).toBe(true);
    expect(validateConfig({ useWine: false }).useWine).toBe(false);
  });

  it('rejects non-boolean useWine', () => {
    expect(validateConfig({ useWine: 'yes' }).useWine).toBeUndefined();
    expect(validateConfig({ useWine: 1 }).useWine).toBeUndefined();
  });

  it('ignores unknown fields', () => {
    const result = validateConfig({ unknownField: 'value', warnLevel: 3 });
    expect(result.warnLevel).toBe(3);
    expect(result).not.toHaveProperty('unknownField');
  });

  it('returns empty object for empty input object', () => {
    expect(validateConfig({})).toEqual({});
  });

  it('rejects empty string for path fields', () => {
    const result = validateConfig({
      msvcBasePath: '',
      clPath: '',
      wineExecutable: '',
    });
    expect(result.msvcBasePath).toBeUndefined();
    expect(result.clPath).toBeUndefined();
    expect(result.wineExecutable).toBeUndefined();
  });

  it('auto-derives clPath from msvcBasePath when clPath is not provided', () => {
    const result = validateConfig({ msvcBasePath: '/opt/msvc' });
    expect(result.msvcBasePath).toBe('/opt/msvc');
    expect(result.clPath).toContain('/opt/msvc');
    expect(result.clPath).toContain('CL.EXE');
  });

  it('does not override explicit clPath when msvcBasePath is also provided', () => {
    const result = validateConfig({ msvcBasePath: '/opt/msvc', clPath: '/custom/CL.EXE' });
    expect(result.clPath).toBe('/custom/CL.EXE');
  });

  it('copies arrays to prevent external mutation', () => {
    const paths = ['/usr/include'];
    const result = validateConfig({ includePaths: paths });
    paths.push('/mutated');
    expect(result.includePaths).toEqual(['/usr/include']);
  });

  it('accepts valid fields and rejects invalid ones in same input', () => {
    const result = validateConfig({
      warnLevel: 3,
      clPath: 42,
      useWine: true,
      includePaths: 'not-array',
    });
    expect(result.warnLevel).toBe(3);
    expect(result.useWine).toBe(true);
    expect(result.clPath).toBeUndefined();
    expect(result.includePaths).toBeUndefined();
  });

  it('rejects NaN, Infinity, and -Infinity for warnLevel', () => {
    expect(validateConfig({ warnLevel: NaN })).toEqual({});
    expect(validateConfig({ warnLevel: Infinity })).toEqual({});
    expect(validateConfig({ warnLevel: -Infinity })).toEqual({});
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

describe('extension constants', () => {
  it('C_EXTENSIONS contains .c', () => {
    expect(C_EXTENSIONS).toContain('.c');
  });

  it('CPP_EXTENSIONS contains all C++ extensions', () => {
    expect(CPP_EXTENSIONS).toContain('.cpp');
    expect(CPP_EXTENSIONS).toContain('.cxx');
    expect(CPP_EXTENSIONS).toContain('.cc');
    expect(CPP_EXTENSIONS).toContain('.hpp');
    expect(CPP_EXTENSIONS).toContain('.hxx');
  });

  it('ALL_EXTENSIONS is superset of C and CPP plus .h', () => {
    for (const ext of C_EXTENSIONS) {
      expect(ALL_EXTENSIONS).toContain(ext);
    }
    for (const ext of CPP_EXTENSIONS) {
      expect(ALL_EXTENSIONS).toContain(ext);
    }
    expect(ALL_EXTENSIONS).toContain('.h');
  });
});
