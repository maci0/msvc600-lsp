import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { validateConfig, defaultConfig, WarnLevel, Msvc6Config } from '../src/config';
import { fuzz, makeRandom, FuzzOptions } from './helpers/fuzz';

const KEYS = [
  'msvcBasePath',
  'clPath',
  'includePaths',
  'warnLevel',
  'additionalFlags',
  'wineExecutable',
  'outputEncoding',
  'useWine',
] as const;

/** Raw `initializationOptions` / `workspace/didChangeConfiguration` payloads. */
const SEED_PAYLOADS: readonly unknown[] = [
  undefined,
  null,
  0,
  '',
  'text',
  true,
  [],
  {},
  { msvcBasePath: '/opt/msvc6', clPath: '/opt/msvc6/BIN/CL.EXE' },
  { msvcBasePath: '/opt/msvc6' },
  { msvcBasePath: '' },
  { msvcBasePath: 42 },
  { warnLevel: 0 },
  { warnLevel: 4 },
  { warnLevel: 5 },
  { warnLevel: -1 },
  { warnLevel: 1.5 },
  { warnLevel: Number.NaN },
  { warnLevel: '4' },
  { warnLevel: null },
  { includePaths: ['/a', '/b'] },
  { includePaths: [] },
  { includePaths: ['/a', 7] },
  { includePaths: '/a' },
  { additionalFlags: ['/DDEBUG'] },
  { additionalFlags: ['/D_X', '/I/tmp'] },
  { additionalFlags: [/re/] },
  { outputEncoding: 'utf8' },
  { outputEncoding: 'cp1252' },
  { outputEncoding: 'utf-16le' },
  { outputEncoding: 'not-a-charset' },
  { outputEncoding: '' },
  { useWine: true },
  { useWine: 'true' },
  { wineExecutable: 'wine' },
  { wineExecutable: '' },
  { unknownKey: 'ignored' },
  { msvcBasePath: 'C:\\msvc6', clPath: 0, warnLevel: 4, useWine: false },
  { includePaths: ['/a'], additionalFlags: [], warnLevel: 3, outputEncoding: 'cp1252' },
];

/** Values a fuzzer reaches for when it has to invent a field value. */
const FUZZ_VALUES: readonly unknown[] = [
  undefined,
  null,
  true,
  false,
  0,
  -0,
  1,
  4,
  5,
  1e308,
  Number.NaN,
  '',
  'utf8',
  'cp1252',
  'bogus-charset',
  '/opt/msvc6',
  'Z:\\',
  '\\',
  '/',
  [],
  [''],
  ['/a'],
  ['/a', 1],
  [null],
  [{}],
  {},
  { toString: null },
];

/**
 * Invariants over one raw config payload. `validateConfig` feeds directly
 * from an untrusted LSP client, so it must never throw and must never let a
 * field through without a type and range check.
 */
function checkConfigInvariants(raw: unknown): string | null {
  const result = validateConfig(raw);

  if (typeof result !== 'object' || result === null) return 'did not return an object';
  for (const key of Object.keys(result)) {
    if (!KEYS.includes(key as (typeof KEYS)[number])) return `invented key ${key}`;
  }

  for (const key of ['msvcBasePath', 'clPath', 'wineExecutable', 'outputEncoding'] as const) {
    const value = result[key];
    if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
      return `${key} = ${JSON.stringify(value)} is not a non-empty string`;
    }
  }

  if (result.outputEncoding !== undefined) {
    try {
      new TextDecoder(result.outputEncoding);
    } catch {
      return `outputEncoding ${result.outputEncoding} is not decodable at load time`;
    }
  }

  for (const key of ['includePaths', 'additionalFlags'] as const) {
    const value = result[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
      return `${key} is not an array of strings`;
    }
  }

  if (result.warnLevel !== undefined) {
    const level: WarnLevel = result.warnLevel;
    if (!Number.isInteger(level) || level < 0 || level > 4) {
      return `warnLevel = ${level} is outside 0..4`;
    }
  }

  if (result.useWine !== undefined && typeof result.useWine !== 'boolean') {
    return `useWine = ${JSON.stringify(result.useWine)} is not a boolean`;
  }

  // The one derived field: a base path without an explicit clPath must yield
  // CL.EXE under that base, or the spawned compiler is the wrong one.
  if (result.msvcBasePath && !(raw !== null && typeof raw === 'object' && 'clPath' in raw)) {
    const expected = path.join(result.msvcBasePath, 'BIN', 'CL.EXE');
    if (result.clPath !== expected) {
      return `clPath ${result.clPath} was not derived as ${expected}`;
    }
  }

  // Every accepted config must survive a merge with the defaults, which is
  // how the server consumes it.
  const merged: Msvc6Config = { ...defaultConfig(), ...result };
  if (typeof merged.outputEncoding !== 'string' || merged.outputEncoding.length === 0) {
    return 'merged config lost outputEncoding';
  }

  return null;
}

describe('validateConfig fuzzing', () => {
  const options: FuzzOptions = { seed: 0xc0ffee, iterations: 2000, depth: 4, budgetMs: 250 };

  it('holds every config invariant over the seed payloads', () => {
    for (const payload of SEED_PAYLOADS) {
      expect(checkConfigInvariants(payload), `payload: ${JSON.stringify(payload)}`).toBeNull();
    }
  });

  it('holds every config invariant under mutation', () => {
    const check = (encoded: string): string | null => {
      let raw: unknown;
      try {
        raw = JSON.parse(encoded);
      } catch {
        // Not a JSON payload: hand the raw text over, since a client can put
        // anything at all in initializationOptions.
        raw = encoded;
      }
      return checkConfigInvariants(raw);
    };

    const corpus = SEED_PAYLOADS.map((p) => (p === undefined ? 'undefined' : JSON.stringify(p)));
    const failure = fuzz(corpus, check, options);
    if (failure) {
      throw new Error(
        `validateConfig broke an invariant: ${failure.message}\n` +
          `seed: ${options.seed}\ninput: ${JSON.stringify(failure.input)}`,
      );
    }
  });

  it('holds every config invariant for invented key/value pairs', () => {
    for (const key of KEYS) {
      for (const value of FUZZ_VALUES) {
        const payload = { [key]: value };
        const reason = checkConfigInvariants(payload);
        if (reason) throw new Error(`${key} = ${JSON.stringify(value)}: ${reason}`);
      }
    }
  });

  /**
   * Structure-aware generation: the config has a known shape, so whole
   * payloads are assembled from the key set and the type-confusion value set
   * rather than mutated as text. Byte mutation of a JSON document mostly
   * yields invalid JSON, which `validateConfig` rejects wholesale and which
   * therefore never reaches the field checks.
   */
  it('holds every config invariant for generated multi-field payloads', () => {
    const random = makeRandom(0xbadc0de);
    const choose = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];

    for (let i = 0; i < options.iterations; i++) {
      const payload: Record<string, unknown> = {};
      const fieldCount = 1 + Math.floor(random() * KEYS.length);
      for (let f = 0; f < fieldCount; f++) {
        payload[choose(KEYS)] = choose(FUZZ_VALUES);
      }
      if (random() < 0.1) payload.extraField = choose(FUZZ_VALUES);

      const reason = checkConfigInvariants(payload);
      if (reason) {
        throw new Error(`iteration ${i}, ${JSON.stringify(payload)}: ${reason}`);
      }
    }
  });
});
