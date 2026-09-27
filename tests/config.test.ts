import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import {
  toWinePath,
  fromWinePath,
  defaultConfig,
  validateConfig,
  applyRuntimeConfig,
  assertRuntimePaths,
  configFromEnv,
  formatConfigForLog,
  parseInitializationOptions,
  resolveConfig,
  ConfigError,
  CONFIG_KEYS,
  C_EXTENSIONS,
  CPP_EXTENSIONS,
  ALL_EXTENSIONS,
} from '../src/config';
import type { Msvc6Config, WarnLevel } from '../src/config';

const MSVC_ROOT = path.resolve(__dirname, '..', 'VC', 'VC98');

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

describe('configFromEnv', () => {
  it('reads every documented variable', () => {
    const value = configFromEnv({
      MSVC6LSP_MSVC_BASE_PATH: '/opt/msvc6',
      MSVC6LSP_CL_PATH: '/opt/msvc6/BIN/CL.EXE',
      MSVC6LSP_INCLUDE_PATHS: '/a;C:\\msvc6\\include',
      MSVC6LSP_WARN_LEVEL: '2',
      MSVC6LSP_ADDITIONAL_FLAGS: '/D_DEBUG;/GX',
      MSVC6LSP_WINE_EXECUTABLE: '/usr/bin/wine',
      MSVC6LSP_USE_WINE: 'false',
      MSVC6LSP_DEBOUNCE_MS: '750',
      MSVC6LSP_CHECK_TIMEOUT_MS: '90000',
      MSVC6LSP_TEMP_DIR: '/var/tmp',
    });

    expect(value).toEqual({
      msvcBasePath: '/opt/msvc6',
      clPath: '/opt/msvc6/BIN/CL.EXE',
      includePaths: ['/a', 'C:\\msvc6\\include'],
      warnLevel: 2,
      additionalFlags: ['/D_DEBUG', '/GX'],
      wineExecutable: '/usr/bin/wine',
      useWine: false,
      debounceMs: 750,
      checkTimeoutMs: 90_000,
      tempDir: '/var/tmp',
    });
  });

  it('returns an empty layer when no variable is set', () => {
    expect(configFromEnv({})).toEqual({});
  });

  it('ignores unrelated variables', () => {
    expect(configFromEnv({ PATH: '/usr/bin', WINEDEBUG: '-all' })).toEqual({});
  });

  it('accepts the documented spellings of a boolean', () => {
    for (const raw of ['true', '1', 'yes', 'on', 'TRUE']) {
      expect(configFromEnv({ MSVC6LSP_USE_WINE: raw }).useWine).toBe(true);
    }
    for (const raw of ['false', '0', 'no', 'off', 'False']) {
      expect(configFromEnv({ MSVC6LSP_USE_WINE: raw }).useWine).toBe(false);
    }
  });

  it('rejects an out-of-range warnLevel', () => {
    expect(() => configFromEnv({ MSVC6LSP_WARN_LEVEL: '9' })).toThrow(ConfigError);
  });

  it('rejects a non-numeric warnLevel', () => {
    expect(() => configFromEnv({ MSVC6LSP_WARN_LEVEL: 'high' })).toThrow(/WARN_LEVEL/);
  });

  it('rejects a non-boolean useWine', () => {
    expect(() => configFromEnv({ MSVC6LSP_USE_WINE: 'maybe' })).toThrow(/USE_WINE/);
  });

  it('rejects a debounce outside the documented range', () => {
    expect(() => configFromEnv({ MSVC6LSP_DEBOUNCE_MS: '-1' })).toThrow(/DEBOUNCE_MS/);
    expect(() => configFromEnv({ MSVC6LSP_DEBOUNCE_MS: '1.5' })).toThrow(/DEBOUNCE_MS/);
  });

  it('rejects a check timeout outside the documented range', () => {
    expect(() => configFromEnv({ MSVC6LSP_CHECK_TIMEOUT_MS: '10' })).toThrow(/CHECK_TIMEOUT_MS/);
  });

  it('distinguishes a variable set to empty from one that is unset', () => {
    expect(() => configFromEnv({ MSVC6LSP_CL_PATH: '' })).toThrow(/set but empty/);
  });

  it('rejects a misspelled variable', () => {
    expect(() => configFromEnv({ MSVC6LSP_WARN_LEVL: '2' })).toThrow(/unknown environment variable/);
  });

  it('reports every problem in one error', () => {
    try {
      configFromEnv({ MSVC6LSP_WARN_LEVEL: '9', MSVC6LSP_USE_WINE: 'maybe' });
      expect.unreachable('expected a ConfigError');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).problems).toHaveLength(2);
    }
  });
});

describe('parseInitializationOptions', () => {
  it('accepts a valid option object', () => {
    expect(parseInitializationOptions({ warnLevel: 0, useWine: false })).toEqual({
      warnLevel: 0,
      useWine: false,
    });
  });

  it('returns an empty layer for no options', () => {
    expect(parseInitializationOptions(undefined)).toEqual({});
  });

  it('rejects a misspelled key instead of dropping it', () => {
    expect(() => parseInitializationOptions({ warnLevle: 2 })).toThrow(/unknown option "warnLevle"/);
  });

  it('rejects an invalid value', () => {
    expect(() => parseInitializationOptions({ warnLevel: 7 })).toThrow(/warnLevel/);
  });

  it('rejects a non-object', () => {
    expect(() => parseInitializationOptions('nope')).toThrow(ConfigError);
  });
});

describe('resolveConfig', () => {
  it('falls back to defaults when nothing is configured', () => {
    const config = resolveConfig(undefined, {});
    expect(config).toEqual(defaultConfig());
  });

  it('layers environment below initializationOptions', () => {
    const config = resolveConfig({ warnLevel: 1 }, { MSVC6LSP_WARN_LEVEL: '3' });
    expect(config.warnLevel).toBe(1);
  });

  it('applies environment values when no options are given', () => {
    const config = resolveConfig(undefined, { MSVC6LSP_DEBOUNCE_MS: '50' });
    expect(config.debounceMs).toBe(50);
  });

  it('derives include paths from an overridden base when none are given', () => {
    const config = resolveConfig({ msvcBasePath: '/opt/msvc6', useWine: false }, {});
    expect(config.includePaths).toEqual([path.join('/opt/msvc6', 'INCLUDE')]);
  });

  it('keeps the Wine include path when Wine is in use', () => {
    const config = resolveConfig({ msvcBasePath: '/opt/msvc6', useWine: true }, {});
    expect(config.includePaths).toEqual(['C:\\msvc6\\include']);
  });

  it('keeps explicitly given include paths, including an empty list', () => {
    const config = resolveConfig({ msvcBasePath: '/opt/msvc6', includePaths: [] }, {});
    expect(config.includePaths).toEqual([]);
  });

  it('derives clPath from an environment base path', () => {
    const config = resolveConfig(undefined, { MSVC6LSP_MSVC_BASE_PATH: '/opt/msvc6' });
    expect(config.clPath).toBe(path.join('/opt/msvc6', 'BIN', 'CL.EXE'));
  });

  it('fails on a bad environment value rather than using the default', () => {
    expect(() => resolveConfig(undefined, { MSVC6LSP_WARN_LEVEL: '9' })).toThrow(ConfigError);
  });
});

describe('applyRuntimeConfig', () => {
  it('accepts the runtime-changeable fields', () => {
    const update = applyRuntimeConfig({
      includePaths: ['/a'],
      warnLevel: 2,
      debounceMs: 100,
    });
    expect(update.problems).toEqual([]);
    expect(update.value).toEqual({ includePaths: ['/a'], warnLevel: 2, debounceMs: 100 });
  });

  it('refuses executable fields and says why', () => {
    const update = applyRuntimeConfig({ additionalFlags: ['/Fe'], clPath: '/tmp/CL.EXE' });
    expect(update.value).toEqual({});
    expect(update.problems).toEqual([
      'unknown option "additionalFlags"',
      'unknown option "clPath"',
    ]);
  });

  it('reports an invalid value without throwing', () => {
    const update = applyRuntimeConfig({ warnLevel: 9, warnLevels: 3 });
    expect(update.value).toEqual({});
    expect(update.problems).toHaveLength(2);
  });

  it('accepts the accepted fields and rejects the rest in one payload', () => {
    const update = applyRuntimeConfig({ includePaths: ['/a'], useWine: false });
    expect(update.value).toEqual({ includePaths: ['/a'] });
    expect(update.problems).toEqual(['unknown option "useWine"']);
  });
});

describe('assertRuntimePaths', () => {
  const goodConfig = (): Msvc6Config => ({
    ...defaultConfig(),
    msvcBasePath: MSVC_ROOT,
    clPath: path.join(MSVC_ROOT, 'BIN', 'CL.EXE'),
    useWine: false,
    tempDir: os.tmpdir(),
  });

  it('accepts a config whose executables and temp dir exist', () => {
    expect(() => assertRuntimePaths(goodConfig())).not.toThrow();
  });

  it('fails when CL.EXE is missing', () => {
    const config = { ...goodConfig(), clPath: path.join(MSVC_ROOT, 'BIN', 'NOPE.EXE') };
    expect(() => assertRuntimePaths(config)).toThrow(/clPath does not exist/);
  });

  it('fails when the Wine executable is not on PATH', () => {
    const config = { ...goodConfig(), useWine: true, wineExecutable: 'wine-not-installed' };
    expect(() => assertRuntimePaths(config, { PATH: '/usr/bin' })).toThrow(
      /wine executable not found/,
    );
  });

  it('accepts a Wine-style clPath it cannot stat on this filesystem', () => {
    const config = { ...goodConfig(), useWine: true, clPath: 'C:\\msvc6\\BIN\\CL.EXE' };
    expect(() => assertRuntimePaths(config, { PATH: process.env.PATH ?? '' })).not.toThrow();
  });

  it('fails when the temp directory is missing', () => {
    const config = { ...goodConfig(), tempDir: path.join(os.tmpdir(), 'msvc6-lsp-missing-dir') };
    expect(() => assertRuntimePaths(config)).toThrow(/tempDir is not a directory/);
  });
});

describe('formatConfigForLog', () => {
  it('shortens paths under the home directory', () => {
    const config: Msvc6Config = {
      ...defaultConfig(),
      msvcBasePath: path.join(os.homedir(), 'tools', 'msvc6'),
      includePaths: [path.join(os.homedir(), 'tools', 'msvc6', 'include')],
      tempDir: os.homedir(),
    };
    const line = formatConfigForLog(config, { HOME: os.homedir() });
    expect(line).toContain('msvcBasePath=~/tools/msvc6');
    expect(line).toContain('includePaths=[~/tools/msvc6/include]');
    expect(line).toContain('tempDir=~');
    expect(line).not.toContain(os.homedir());
  });

  it('leaves paths outside the home directory untouched', () => {
    const line = formatConfigForLog(defaultConfig(), { HOME: '/home/someone' });
    expect(line).toContain(defaultConfig().clPath);
  });

  it('reports every field', () => {
    const line = formatConfigForLog(defaultConfig(), {});
    for (const key of CONFIG_KEYS) {
      expect(line).toContain(`${key}=`);
    }
  });
});
