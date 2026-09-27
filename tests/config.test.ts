import * as path from 'path';
import { describe, it, expect } from 'vitest';
import {
  defaultConfig,
  validateConfig,
  mergeValidated,
  configFromEnv,
  formatIssues,
  C_EXTENSIONS,
  CPP_EXTENSIONS,
  ALL_EXTENSIONS,
  runtimeConfigEquals,
} from '../src/config';
import type { WarnLevel, Msvc6Config } from '../src/config';

/** The accepted fields of a validation result, for tests that only care about values. */
const validateValues = (raw: unknown): Partial<Msvc6Config> => validateConfig(raw).values;

describe('defaultConfig', () => {
  it('returns a valid config object', () => {
    const cfg = defaultConfig();
    expect(cfg.warnLevel).toBe(4);
    expect(cfg.clPath).toContain('CL.EXE');
    expect(cfg.includePaths.length).toBeGreaterThan(0);
    expect(cfg.wineExecutable).toBe('wine');
    expect(cfg.outputEncoding).toBe('utf8');
    expect(cfg.checkTimeoutMs).toBe(30_000);
    expect(cfg.maxOutputBytes).toBe(1024 * 1024);
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
    expect(validateValues(null)).toEqual({});
    expect(validateValues(undefined)).toEqual({});
    expect(validateValues('string')).toEqual({});
    expect(validateValues(42)).toEqual({});
  });

  it('reports a non-object source instead of dropping it silently', () => {
    expect(validateConfig('string').issues).toEqual([
      { key: '', message: 'expected an object, got "string"' },
    ]);
    expect(validateConfig([]).issues[0]?.message).toBe('expected an object, got an array of 0');
    expect(validateConfig(null).issues).toEqual([]);
  });

  it('accepts valid warnLevel values (0-4)', () => {
    for (const level of [0, 1, 2, 3, 4] as WarnLevel[]) {
      const result = validateValues({ warnLevel: level });
      expect(result.warnLevel).toBe(level);
    }
  });

  it('rejects invalid warnLevel values', () => {
    expect(validateValues({ warnLevel: -1 })).toEqual({});
    expect(validateValues({ warnLevel: 5 })).toEqual({});
    expect(validateValues({ warnLevel: 99 })).toEqual({});
    expect(validateValues({ warnLevel: 2.5 })).toEqual({});
    expect(validateValues({ warnLevel: 'high' })).toEqual({});
  });

  it('accepts valid string fields', () => {
    const result = validateValues({
      msvcBasePath: '/opt/msvc',
      clPath: '/opt/msvc/BIN/CL.EXE',
      wineExecutable: '/usr/bin/wine64',
    });
    expect(result.msvcBasePath).toBe('/opt/msvc');
    expect(result.clPath).toBe('/opt/msvc/BIN/CL.EXE');
    expect(result.wineExecutable).toBe('/usr/bin/wine64');
  });

  it('rejects non-string values for string fields', () => {
    const result = validateValues({
      msvcBasePath: 42,
      clPath: true,
      wineExecutable: null,
    });
    expect(result.msvcBasePath).toBeUndefined();
    expect(result.clPath).toBeUndefined();
    expect(result.wineExecutable).toBeUndefined();
  });

  it('accepts an output encoding TextDecoder knows', () => {
    expect(validateValues({ outputEncoding: 'cp1252' }).outputEncoding).toBe('cp1252');
  });

  it('rejects an output encoding TextDecoder does not know', () => {
    expect(validateValues({ outputEncoding: 'cp99999' }).outputEncoding).toBeUndefined();
  });

  it('rejects a non-string output encoding', () => {
    expect(validateValues({ outputEncoding: 1252 }).outputEncoding).toBeUndefined();
  });

  it('accepts valid array fields with all-string elements', () => {
    const result = validateValues({
      includePaths: ['/usr/include', 'C:\\msvc6\\include'],
      additionalFlags: ['/D_DEBUG', '/GX'],
    });
    expect(result.includePaths).toEqual(['/usr/include', 'C:\\msvc6\\include']);
    expect(result.additionalFlags).toEqual(['/D_DEBUG', '/GX']);
  });

  it('rejects arrays containing non-string elements', () => {
    const result = validateValues({
      includePaths: ['/valid', 42, null],
      additionalFlags: 'not-an-array',
    });
    expect(result.includePaths).toBeUndefined();
    expect(result.additionalFlags).toBeUndefined();
  });

  it('accepts boolean useWine', () => {
    expect(validateValues({ useWine: true }).useWine).toBe(true);
    expect(validateValues({ useWine: false }).useWine).toBe(false);
  });

  it('rejects non-boolean useWine', () => {
    expect(validateValues({ useWine: 'yes' }).useWine).toBeUndefined();
    expect(validateValues({ useWine: 1 }).useWine).toBeUndefined();
  });

  it('ignores unknown fields', () => {
    const result = validateValues({ unknownField: 'value', warnLevel: 3 });
    expect(result.warnLevel).toBe(3);
    expect(result).not.toHaveProperty('unknownField');
  });

  it('reports a misspelled key rather than ignoring it', () => {
    const { values, issues } = validateConfig({ warnLevle: 3, includePaths: ['/a'] });
    expect(values).toEqual({ includePaths: ['/a'] });
    expect(issues).toEqual([
      { key: 'warnLevle', message: 'unknown option, ignored (check the spelling)' },
    ]);
  });

  it('names the key and reason for every rejected value', () => {
    const { values, issues } = validateConfig({
      clPath: 42,
      warnLevel: 9,
      useWine: 'yes',
      outputEncoding: 'cp99999',
      includePaths: ['/ok', 7],
      checkTimeoutMs: 0,
    });
    expect(values).toEqual({});
    expect(issues.map((i) => i.key)).toEqual([
      'clPath',
      'includePaths',
      'checkTimeoutMs',
      'warnLevel',
      'outputEncoding',
      'useWine',
    ]);
    expect(issues[0]?.message).toBe('expected a non-empty string, got 42');
    expect(issues[1]?.message).toBe('expected an array of strings, got an array of 2');
    expect(issues[2]?.message).toBe('expected a positive integer, got 0');
    expect(issues[3]?.message).toBe('expected an integer 0-4, got 9');
    expect(issues[4]?.message).toContain('unknown encoding label "cp99999"');
    expect(issues[5]?.message).toBe('expected a boolean, got "yes"');
  });

  it('accepts positive integer limits and rejects zero or negative', () => {
    expect(validateValues({ checkTimeoutMs: 1000, maxOutputBytes: 2048 })).toEqual({
      checkTimeoutMs: 1000,
      maxOutputBytes: 2048,
    });
    expect(validateConfig({ checkTimeoutMs: -1 }).issues[0]?.key).toBe('checkTimeoutMs');
    expect(validateConfig({ maxOutputBytes: 1.5 }).issues[0]?.key).toBe('maxOutputBytes');
  });

  it('returns empty object for empty input object', () => {
    expect(validateValues({})).toEqual({});
  });

  it('rejects empty string for path fields', () => {
    const result = validateValues({
      msvcBasePath: '',
      clPath: '',
      wineExecutable: '',
    });
    expect(result.msvcBasePath).toBeUndefined();
    expect(result.clPath).toBeUndefined();
    expect(result.wineExecutable).toBeUndefined();
  });

  it('auto-derives clPath from msvcBasePath when clPath is not provided', () => {
    const result = validateValues({ msvcBasePath: '/opt/msvc' });
    expect(result.msvcBasePath).toBe('/opt/msvc');
    expect(result.clPath).toContain('/opt/msvc');
    expect(result.clPath).toContain('CL.EXE');
  });

  it('auto-derives includePaths from msvcBasePath without Wine', () => {
    const result = validateConfig({ msvcBasePath: '/opt/msvc', useWine: false }).values;
    expect(result.includePaths).toEqual(['/opt/msvc/INCLUDE']);
  });

  it('points includePaths at the Wine overlay, not the base, when Wine is in use', () => {
    const result = validateConfig({ msvcBasePath: '/opt/msvc', useWine: true }).values;
    expect(result.includePaths).toEqual(['C:\\msvc6\\include']);
  });

  it('leaves an explicit includePaths alone when msvcBasePath is also provided', () => {
    const result = validateConfig({
      msvcBasePath: '/opt/msvc',
      useWine: false,
      includePaths: ['/somewhere/else'],
    }).values;
    expect(result.includePaths).toEqual(['/somewhere/else']);
  });

  it('does not override explicit clPath when msvcBasePath is also provided', () => {
    const result = validateValues({ msvcBasePath: '/opt/msvc', clPath: '/custom/CL.EXE' });
    expect(result.clPath).toBe('/custom/CL.EXE');
  });

  it('copies arrays to prevent external mutation', () => {
    const paths = ['/usr/include'];
    const result = validateValues({ includePaths: paths });
    paths.push('/mutated');
    expect(result.includePaths).toEqual(['/usr/include']);
  });

  it('accepts valid fields and rejects invalid ones in same input', () => {
    const result = validateValues({
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
    expect(validateValues({ warnLevel: NaN })).toEqual({});
    expect(validateValues({ warnLevel: Infinity })).toEqual({});
    expect(validateValues({ warnLevel: -Infinity })).toEqual({});
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

describe('runtimeConfigEquals', () => {
  const base = defaultConfig();

  it('holds for the same config', () => {
    expect(runtimeConfigEquals(base, { ...base })).toBe(true);
  });

  it('still holds after the same change is applied twice', () => {
    const changed = { ...base, warnLevel: 1 as const, includePaths: ['C:\\other'] };
    expect(runtimeConfigEquals(changed, { ...changed })).toBe(true);
  });

  it('separates a different warning level', () => {
    expect(runtimeConfigEquals(base, { ...base, warnLevel: 1 })).toBe(false);
  });

  it('separates different include paths', () => {
    expect(
      runtimeConfigEquals(base, { ...base, includePaths: [...base.includePaths, 'C:\\extra'] }),
    ).toBe(false);
  });

  it('separates reordered include paths', () => {
    const two = ['C:\\a', 'C:\\b'];
    expect(
      runtimeConfigEquals({ ...base, includePaths: two }, { ...base, includePaths: ['C:\\b', 'C:\\a'] }),
    ).toBe(false);
  });
});

describe('configFromEnv', () => {
  it('returns no values for an empty environment', () => {
    const { values, issues } = configFromEnv({});
    expect(values).toEqual({});
    expect(issues).toEqual([]);
  });

  it('reads every documented variable under the MSVC600_ prefix', () => {
    const { values, issues } = configFromEnv({
      MSVC600_MSVC_BASE_PATH: '/opt/msvc',
      MSVC600_INCLUDE_PATHS: '/opt/a;/opt/b',
      MSVC600_WARN_LEVEL: '2',
      MSVC600_ADDITIONAL_FLAGS: '/D_DEBUG;/GX',
      MSVC600_WINE_EXECUTABLE: '/usr/bin/wine64',
      MSVC600_OUTPUT_ENCODING: 'cp1252',
      MSVC600_USE_WINE: 'false',
      MSVC600_CHECK_TIMEOUT_MS: '5000',
      MSVC600_MAX_OUTPUT_BYTES: '4096',
    });
    expect(issues).toEqual([]);
    expect(values).toEqual({
      msvcBasePath: '/opt/msvc',
      clPath: path.join('/opt/msvc', 'BIN', 'CL.EXE'),
      includePaths: ['/opt/a', '/opt/b'],
      warnLevel: 2,
      additionalFlags: ['/D_DEBUG', '/GX'],
      wineExecutable: '/usr/bin/wine64',
      outputEncoding: 'cp1252',
      useWine: false,
      checkTimeoutMs: 5000,
      maxOutputBytes: 4096,
    });
  });

  it('keeps colon-bearing Wine paths intact inside a list', () => {
    const { values } = configFromEnv({
      MSVC600_INCLUDE_PATHS: 'C:\\msvc6\\include;/opt/inc',
    });
    expect(values.includePaths).toEqual(['C:\\msvc6\\include', '/opt/inc']);
  });

  it('accepts the documented boolean spellings and rejects the rest', () => {
    expect(configFromEnv({ MSVC600_USE_WINE: '1' }).values.useWine).toBe(true);
    expect(configFromEnv({ MSVC600_USE_WINE: 'TRUE' }).values.useWine).toBe(true);
    expect(configFromEnv({ MSVC600_USE_WINE: '0' }).values.useWine).toBe(false);
    const bad = configFromEnv({ MSVC600_USE_WINE: 'yes' });
    expect(bad.values.useWine).toBeUndefined();
    expect(bad.issues).toEqual([
      { key: 'MSVC600_USE_WINE', message: 'expected a boolean, got "yes"' },
    ]);
  });

  it('rejects a non-integer numeric variable by name', () => {
    const { values, issues } = configFromEnv({ MSVC600_WARN_LEVEL: 'high' });
    expect(values.warnLevel).toBeUndefined();
    expect(issues[0]?.key).toBe('MSVC600_WARN_LEVEL');
    expect(issues[0]?.message).toBe('expected an integer 0-4, got "high"');
  });

  it('distinguishes a variable set to empty from one left unset', () => {
    const unset = configFromEnv({ MSVC600_INCLUDE_PATHS: undefined });
    expect(unset.values.includePaths).toBeUndefined();
    expect(unset.issues).toEqual([]);

    const empty = configFromEnv({ MSVC600_INCLUDE_PATHS: '' });
    expect(empty.values.includePaths).toBeUndefined();
    expect(empty.issues).toEqual([
      { key: 'MSVC600_INCLUDE_PATHS', message: 'is set but empty' },
    ]);
  });

  it('ignores unrelated environment variables', () => {
    const { values, issues } = configFromEnv({ PATH: '/usr/bin', WINEARCH: 'win64' });
    expect(values).toEqual({});
    expect(issues).toEqual([]);
  });
});

describe('formatIssues', () => {  it('prefixes each issue with its source and key', () => {
    const lines = formatIssues('MSVC600_*', [
      { key: 'warnLevel', message: 'expected an integer 0-4, got 9' },
    ]);
    expect(lines).toEqual([
      'msvc600-lsp: MSVC600_* rejected warnLevel: expected an integer 0-4, got 9',
    ]);
  });

  it('reports a whole rejected source with no key', () => {
    expect(formatIssues('initializationOptions', [{ key: '', message: 'expected an object, got 42' }]))
      .toEqual(['msvc600-lsp: initializationOptions ignored: expected an object, got 42']);
  });
});

describe('mergeValidated', () => {
  it('lets a later source override an earlier one, field by field', () => {
    const withEnv = mergeValidated(defaultConfig(), configFromEnv({ MSVC600_WARN_LEVEL: '1' }));
    expect(withEnv.warnLevel).toBe(1);

    const withOptions = mergeValidated(withEnv, validateConfig({ warnLevel: 3 }));
    expect(withOptions.warnLevel).toBe(3);
  });

  it('keeps the earlier value when a later source rejects its own', () => {
    const withEnv = mergeValidated(defaultConfig(), configFromEnv({ MSVC600_WINE_EXECUTABLE: '/opt/wine' }));
    expect(withEnv.wineExecutable).toBe('/opt/wine');

    const rejected = mergeValidated(withEnv, validateConfig({ wineExecutable: 42 }));
    expect(rejected.wineExecutable).toBe('/opt/wine');
  });

  it('leaves the base config untouched', () => {
    const base = defaultConfig();
    mergeValidated(base, validateConfig({ warnLevel: 0, includePaths: ['/only/here'] }));
    expect(base.warnLevel).toBe(4);
    expect(base.includePaths).not.toEqual(['/only/here']);
  });
});
