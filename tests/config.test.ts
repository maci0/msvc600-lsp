import { describe, it, expect } from 'vitest';
import {
  defaultConfig,
  validateConfig,
  C_EXTENSIONS,
  CPP_EXTENSIONS,
  ALL_EXTENSIONS,
} from '../src/config';
import type { WarnLevel } from '../src/config';

describe('defaultConfig', () => {
  it('returns a valid config object', () => {
    const cfg = defaultConfig();
    expect(cfg.warnLevel).toBe(4);
    expect(cfg.clPath).toContain('CL.EXE');
    expect(cfg.includePaths.length).toBeGreaterThan(0);
    expect(cfg.wineExecutable).toBe('wine');
    expect(cfg.outputEncoding).toBe('utf8');
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

  it('accepts an output encoding TextDecoder knows', () => {
    expect(validateConfig({ outputEncoding: 'cp1252' }).outputEncoding).toBe('cp1252');
  });

  it('rejects an output encoding TextDecoder does not know', () => {
    expect(validateConfig({ outputEncoding: 'cp99999' }).outputEncoding).toBeUndefined();
  });

  it('rejects a non-string output encoding', () => {
    expect(validateConfig({ outputEncoding: 1252 }).outputEncoding).toBeUndefined();
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
