/**
 * Deterministic input generation for the parser fuzz harnesses.
 *
 * The seeds are real captures, not synthesized shapes, because a byte-level
 * mutation of a string the compiler actually printed reaches parser states a
 * generator built from the grammar never visits (a filename with a colon, a
 * line number that runs into the next field, a continuation line with fewer
 * than eight spaces).
 *
 * The generator is seeded, so a failure reproduces from the printed input
 * alone: every case carries its own text, and a thrown `invariant` failure
 * prints that text, which is the regression test.
 */

/** Cases generated per seed before the harness is considered covered. */
export const FUZZ_ITERATIONS = 2000;

/** Fixed seed, so a run is reproducible and a red run is not machine-specific. */
const GENERATOR_SEED = 0x5f3c_9a11;

/**
 * Characters that break naive parsers: field separators, quotes, path roots,
 * a byte order mark, a lone high surrogate, a NUL, and the two Unicode
 * normalization forms of the same accented letter.
 */
const INTERESTING: readonly string[] = [
  '(', ')', ':', ' ', '\t', '\r', '\n', '\\', '/', "'", '"', '#', '\u0000', '\ufeff', '\ud800',
  '\udfff', 'e', 'é', 'é', 'Z:', 'C:\\msvc6\\include', 'Z:\\', '-', '.', '0',
];

/** xorshift32, so the same corpus yields the same cases on every run. */
function nextRandom(state: number): number {
  let x = state | 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return x >>> 0;
}

class Generator {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Integer in [0, bound). */
  int(bound: number): number {
    this.state = nextRandom(this.state);
    return this.state % bound;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }
}

/** One mutation applied to a seed; each keeps most of the seed recognizable. */
function mutate(g: Generator, text: string): string {
  const at = g.int(text.length + 1);
  switch (g.int(7)) {
    case 0:
      return text.slice(0, at) + g.pick(INTERESTING) + text.slice(at);
    case 1: {
      const end = at + g.int(32);
      return text.slice(0, at) + g.pick(INTERESTING).repeat(1 + g.int(64)) + text.slice(end);
    }
    case 2:
      return text.slice(0, at) + text.slice(at + 1);
    case 3:
      return text.slice(0, at) + text.slice(at) + text.slice(at);
    case 4: {
      const lines = text.split('\n');
      if (lines.length < 2) return text;
      const [first] = lines.splice(g.int(lines.length), 1);
      return [...lines.slice(0, g.int(lines.length + 1)), first, ...lines.slice(g.int(lines.length + 1))].join('\n');
    }
    case 5:
      return text.slice(0, at);
    default: {
      const lines = text.split('\n');
      if (lines.length < 2) return text;
      const from = g.int(lines.length);
      const to = g.int(lines.length);
      return [...lines.slice(0, from), ...lines.slice(from, to + 1), ...lines.slice(to + 1)].join('\n');
    }
  }
}

/**
 * Seeds plus `iterations` mutated descendants of each, in a fixed order. Every
 * seed is itself included, so a corpus entry that regresses is reported as its
 * own case.
 */
export function fuzzInputs(seeds: readonly string[], iterations: number = FUZZ_ITERATIONS): string[] {
  const g = new Generator(GENERATOR_SEED);
  const cases: string[] = [...seeds];
  for (const seed of seeds) {
    let current = seed;
    for (let i = 0; i < iterations; i++) {
      current = mutate(g, current);
      cases.push(current);
    }
  }
  return cases;
}

/**
 * An invariant the parser must hold for every input. The input is part of the
 * message because it is the artifact a regression test is written from.
 */
export function invariant(condition: boolean, input: string, description: string): void {
  if (!condition) {
    throw new Error(`${description}\n--- input (JSON) ---\n${JSON.stringify(input)}\n--- end ---`);
  }
}

/**
 * Keys a mutation may add. The unknown ones are what a client sends when a
 * field is renamed or the payload is hand-written; `__proto__` and friends are
 * what a hostile payload sends, and are written with a computed key so they
 * land as own properties rather than reassigning the prototype.
 */
const JSON_KEYS: readonly string[] = [
  'warnLevel', 'checkTimeoutMs', 'maxOutputBytes', 'outputEncoding', 'useWine',
  'includePaths', 'additionalFlags', 'msvcBasePath', 'clPath', 'wineExecutable',
  'msveBasePath', 'warn_level', 'constructor', 'toString', 'valueOf', 'length', 'then', '__proto__',
];

/** Values a mutation may substitute, one per branch a type check can take. */
const JSON_VALUES: readonly unknown[] = [
  0, 1, 4, 5, -1, 1.5, Number.MAX_SAFE_INTEGER, 1e308, 1e-320, 0.1 + 0.2,
  '', '4', 'true', 'cp1252', 'utf8', 'cp999', 'C:\\msvc6', 'x'.repeat(4096),
  true, false, null, [], {}, [[]], [null], [{ warnLevel: 2 }], { nested: { deep: { deeper: 1 } } },
];

/** A clone that keeps own properties, including a `__proto__` own property. */
function clone(value: unknown): unknown {
  return structuredClone(value);
}

function mutateJson(g: Generator, node: unknown, depth: number): unknown {
  if (depth > 3 || node === null || typeof node !== 'object') {
    return g.pick([node, { value: node }, [node], ...JSON_VALUES]);
  }
  if (Array.isArray(node)) {
    const items = node.map((item) => mutateJson(g, item, depth + 1));
    return g.int(4) === 0 ? [...items, g.pick(JSON_VALUES)] : items;
  }

  const object = clone(node) as Record<string, unknown>;
  const keys = Object.keys(object);
  const key = keys.length > 0 ? () => g.pick(keys) : () => g.pick(JSON_KEYS);
  switch (g.int(5)) {
    case 0:
      return keys.length > 0 ? { ...object, [key()]: mutateJson(g, object[key()], depth + 1) } : object;
    case 1:
      return { ...object, [g.pick(JSON_KEYS)]: g.pick(JSON_VALUES) };
    case 2: {
      if (keys.length === 0) return object;
      const next = { ...object };
      Reflect.deleteProperty(next, key());
      return next;
    }
    case 3:
      return { ...object, [g.pick(JSON_KEYS)]: { nested: mutateJson(g, object, depth + 1) } };
    default:
      return mutateJson(g, object, depth + 1);
  }
}

/**
 * Seeds plus `iterations` structure-aware descendants of each, re-serialized as
 * the wire text. Mutating the parsed value rather than the characters is the
 * only way to stay a JSON document: a byte-level edit of a JSON string stops
 * being parseable after the first insertion, which leaves a harness asserting
 * almost nothing.
 */
export function fuzzJson(seeds: readonly string[], iterations: number = FUZZ_ITERATIONS): string[] {
  const g = new Generator(GENERATOR_SEED ^ 0x9e37_79b9);
  const roots = seeds.map((seed) => {
    try {
      return JSON.parse(seed) as unknown;
    } catch {
      return null;
    }
  });
  const cases: string[] = [...seeds];
  for (const root of roots) {
    for (let i = 0; i < iterations; i++) {
      cases.push(JSON.stringify(mutateJson(g, root, 0)));
    }
  }
  return cases;
}
