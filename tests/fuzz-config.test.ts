import { describe, it, expect } from 'vitest';
import { validateConfig, mergeValidated, defaultConfig, Msvc6Config } from '../src/config';
import { fuzzJson, invariant } from './helpers/fuzz';

/**
 * Fuzzes the `initializationOptions` boundary. The object is whatever the
 * editor sent over the wire, parsed with no schema in front of it, so the
 * validator is the only thing standing between a hostile or merely confused
 * client and a configuration the server then hands to a shell and to Wine.
 *
 * Every case asserts what leaves the validator, not that it survives the call:
 * a field that is silently dropped leaves the user with a default they never
 * asked for, which no crash would report.
 */

/** Real `initializationOptions` objects and the malformed shapes clients send. */
const CORPUS: readonly string[] = [
  JSON.stringify({
    msvcBasePath: '/opt/msvc6/VC/VC98',
    warnLevel: 4,
    includePaths: ['/usr/include', '/opt/msvc6/extra'],
    additionalFlags: ['/D_DEBUG', '/Zm'],
    outputEncoding: 'cp1252',
    useWine: true,
    checkTimeoutMs: 15000,
    maxOutputBytes: 262144,
  }),
  JSON.stringify({ warnLevel: 0, useWine: false }),
  JSON.stringify({ includePaths: 'not-an-array' }),
  JSON.stringify({ includePaths: ['ok', 7, null] }),
  JSON.stringify({ warnLevel: '4' }),
  JSON.stringify({ warnLevel: 9 }),
  JSON.stringify({ warnLevel: 1.5 }),
  JSON.stringify({ outputEncoding: 'cp999' }),
  JSON.stringify({ checkTimeoutMs: -1 }),
  JSON.stringify({ checkTimeoutMs: 1e308 }),
  JSON.stringify({ maxOutputBytes: Number.MAX_SAFE_INTEGER }),
  JSON.stringify({ msvcBasePath: '' }),
  JSON.stringify({ msvcBasePath: 'C:\\msvc6', clPath: 'C:\\msvc6\\BIN\\CL.EXE' }),
  JSON.stringify({ unknownOption: true, msveBasePath: '/typo' }),
  JSON.stringify({ __proto__: { warnLevel: 9 }, warnLevel: 2 }),
  JSON.stringify({ constructor: 'x', toString: 'y' }),
  JSON.stringify([1, 2, 3]),
  JSON.stringify('a bare string'),
  JSON.stringify(42),
  JSON.stringify(null),
  '{"warnLevel": 2,',
  'not json at all',
  '',
];

/**
 * Cases per seed. Half the default because each case clones and re-serializes a
 * document and is checked three times, and this suite shares a machine with the
 * timing-sensitive spawn tests.
 */
const ITERATIONS = 600;

const KNOWN_KEYS: readonly string[] = Object.keys(defaultConfig());

/**
 * Fields the validator fills in from `msvcBasePath` after the supplied value
 * was rejected. They are the one way a rejected key can still reach the
 * configuration, and it is reported, so the invariant below exempts exactly
 * these two and no others.
 */
const DERIVED_KEYS: readonly string[] = ['clPath', 'includePaths'];

/** Field-level checks a value that passed validation must satisfy. */
function assertFieldIsUsable(key: string, value: unknown, input: string): void {
  invariant(KNOWN_KEYS.includes(key), input, `accepted an unknown option: ${key}`);
  switch (key) {
    case 'msvcBasePath':
    case 'clPath':
    case 'wineExecutable':
      invariant(typeof value === 'string' && value.length > 0, input, `${key} is not a non-empty string`);
      return;
    case 'includePaths':
    case 'additionalFlags':
      invariant(Array.isArray(value) && value.every((e) => typeof e === 'string'), input, `${key} is not a list of strings`);
      return;
    case 'warnLevel':
      invariant(
        typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 4,
        input,
        `warnLevel is outside 0-4: ${String(value)}`,
      );
      return;
    case 'checkTimeoutMs':
    case 'maxOutputBytes':
      invariant(
        typeof value === 'number' && Number.isInteger(value) && value > 0,
        input,
        `${key} is not a positive integer: ${String(value)}`,
      );
      return;
    case 'outputEncoding':
      invariant(
        typeof value === 'string' && (() => {
          try {
            new TextDecoder(value);
            return true;
          } catch {
            return false;
          }
        })(),
        input,
        `outputEncoding is a label TextDecoder does not know: ${String(value)}`,
      );
      return;
    case 'useWine':
      invariant(typeof value === 'boolean', input, `useWine is not a boolean: ${String(value)}`);
      return;
    default:
      invariant(false, input, `no field check written for ${key}`);
  }
}

describe('validateConfig fuzz', () => {
  const cases = fuzzJson(CORPUS, ITERATIONS);

  it('applies a field or reports it, never neither', () => {
    for (const input of cases) {
      let raw: unknown;
      try {
        raw = JSON.parse(input);
      } catch {
        // A body that is not JSON never reaches the validator, but a client
        // that forwards a scalar does: it must be rejected, not merged.
        continue;
      }

      const { values, issues } = validateConfig(raw);
      const object = Object.getPrototypeOf(values) === Object.prototype;
      invariant(object, input, 'the accepted values are not a plain object');
      invariant(
        !Object.prototype.hasOwnProperty.call(values, '__proto__') &&
          !Object.prototype.hasOwnProperty.call(values, 'constructor'),
        input,
        'a prototype key was accepted into the configuration',
      );

      for (const [key, value] of Object.entries(values)) {
        invariant(value !== undefined, input, `${key} was accepted as undefined`);
        assertFieldIsUsable(key, value, input);
        invariant(
          !issues.some((issue) => issue.key === key) || DERIVED_KEYS.includes(key),
          input,
          `${key} was both applied and reported as rejected`,
        );
      }

      for (const issue of issues) {
        invariant(issue.message.length > 0, input, 'an issue carries no message');
        invariant(!issue.message.includes('\n'), input, `an issue message spans lines: ${JSON.stringify(issue.message)}`);
        invariant(
          !Object.prototype.hasOwnProperty.call(values, issue.key) || KNOWN_KEYS.includes(issue.key),
          input,
          `a rejected key ${issue.key} still reached the configuration`,
        );
      }
    }
  });

  it('accepts a configuration the server would then accept again', () => {
    // The pair the server actually performs: the values it applies are read
    // back through the same validator on the next `workspace/didChangeConfiguration`.
    for (const input of cases) {
      let raw: unknown;
      try {
        raw = JSON.parse(input);
      } catch {
        continue;
      }

      const first = validateConfig(raw);
      const second = validateConfig(first.values);
      invariant(
        second.issues.length === 0,
        input,
        `applied values fail validation on the way back in: ${JSON.stringify(second.issues)}`,
      );
      expect(mergeValidated(defaultConfig(), first)).toMatchObject(first.values);
    }
  });

  it('never lets a rejected source change the running configuration', () => {
    const base: Msvc6Config = defaultConfig();
    for (const input of cases) {
      let raw: unknown;
      try {
        raw = JSON.parse(input);
      } catch {
        continue;
      }

      const validation = validateConfig(raw);
      const merged = mergeValidated(base, validation);
      for (const key of Object.keys(base) as (keyof Msvc6Config)[]) {
        if (Object.prototype.hasOwnProperty.call(validation.values, key)) continue;
        expect(merged[key]).toEqual(base[key]);
      }
    }
  });
});
