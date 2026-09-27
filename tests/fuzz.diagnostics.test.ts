import { describe, it, expect } from 'vitest';
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver-protocol';
import {
  parseDiagnostics,
  toLspDiagnostics,
  groupByFile,
  normalizeForComparison,
  ParsedDiagnostic,
} from '../src/diagnostics';
import { fromWinePath } from '../src/config';
import { fuzz, FuzzOptions } from './helpers/fuzz';

/** LSP `uinteger` ceiling, mirrored from the converter that must respect it. */
const LSP_UINT_MAX = 2147483647;

const CODE_PATTERN = /^[A-Za-z]+\d+$/;

const isUinteger = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= LSP_UINT_MAX;

/**
 * Real CL.EXE output shapes, not synthetic fillers: the greedy path group, the
 * `(x86)` parenthesised path, a fatal error, a diagnostic with a continuation
 * line, a batch of mixed severities, and the non-diagnostic noise CL.EXE
 * interleaves (banner echo, blank lines, undecodable code-page bytes).
 */
const SEED_CORPUS: readonly string[] = [
  '',
  '\n',
  'test.c\n',
  'Microsoft (R) C/C++ Optimizing Compiler Version 6.0',
  "Z:/tmp/test.c(3) : error C2146: syntax error : missing ';' before identifier 'printf'",
  "Z:/tmp/test.c(5) : warning C4047: 'initializing' : 'int ' differs in levels of indirection",
  "Z:/tmp/test.c(1) : fatal error C1083: Cannot open include file: 'nonexistent.h'",
  "C:\\msvc6\\include\\xlocale(242) : warning C4511: 'codecvt_base' : copy constructor could not be generated",
  'C:\\Program Files (x86)\\MSVC\\test.c(10) : error C2146: syntax error',
  [
    "Z:/tmp/test.cpp(12) : error C2664: 'bar' : cannot convert parameter 1 from 'char [6]' to 'int'",
    '        This conversion requires a reinterpret_cast, a C-style cast or function-style cast',
  ].join('\n'),
  [
    "Z:/tmp/a.c(1) : error C2065: 'foo' : undeclared identifier",
    "Z:/tmp/b.c(2) : warning C4018: '<' : signed/unsigned mismatch",
    'Z:/tmp/a.c(3) : error C2146: syntax error',
  ].join('\n'),
  'Z:/tmp/a.c(1) : error C2065: unterminated',
  'Z:/tmp/a.c(1) : error C2065:',
  '(1) : error C1: no file',
  'Z:/tmp/a.c(999999999999999999999999) : error C1: absurd line number',
  'Z:/tmp/a.c(0) : error C1: zero line',
  "Z:/tmp/��.c(1) : error C2065: '�' : unterminated string literal",
];

/** One emitted LSP diagnostic must satisfy the protocol, whatever went in. */
function checkEmitted(diagnostic: Diagnostic): string | null {
  const { start, end } = diagnostic.range;
  if (!isUinteger(start.line) || !isUinteger(start.character)) {
    return `start position is not a uinteger: ${JSON.stringify(start)}`;
  }
  if (!isUinteger(end.line) || !isUinteger(end.character)) {
    return `end position is not a uinteger: ${JSON.stringify(end)}`;
  }
  if (diagnostic.source !== 'msvc6') return `source tag lost: ${diagnostic.source}`;
  if (diagnostic.severity !== DiagnosticSeverity.Error && diagnostic.severity !== DiagnosticSeverity.Warning) {
    return `severity outside {Error, Warning}: ${diagnostic.severity}`;
  }
  if (typeof diagnostic.message !== 'string' || diagnostic.message.length === 0) {
    return 'empty or non-string message crossed the boundary';
  }
  return null;
}

/** Invariants over one fuzzed CL.EXE output; null when the parse held. */
function checkParseInvariants(output: string): string | null {
  const parsed = parseDiagnostics(output);
  if (!Array.isArray(parsed)) return 'parseDiagnostics did not return an array';

  for (const d of parsed) {
    if (!CODE_PATTERN.test(d.code)) return `malformed code ${JSON.stringify(d.code)}`;
    if (d.severity !== DiagnosticSeverity.Error && d.severity !== DiagnosticSeverity.Warning) {
      return `severity outside {Error, Warning}: ${d.severity}`;
    }
    if (!(d.line >= 0)) return `negative or NaN line ${d.line}`;
    if (typeof d.message !== 'string' || d.message.length === 0) {
      return `empty or non-string message for ${d.code}`;
    }
    if (d.file !== fromWinePath(d.file)) return 'file was not passed through fromWinePath';
    for (const info of d.relatedInfo) {
      if (info !== info.trim()) return `relatedInfo kept surrounding whitespace: ${JSON.stringify(info)}`;
    }
  }

  // The converter crosses into LSP's typed world: every position it emits
  // must satisfy the protocol's `uinteger`, or the editor rejects the message.
  const target = 'Z:/tmp/a.c';
  const lsp = toLspDiagnostics(parsed, target);
  const expected = parsed.filter(
    (d) => normalizeForComparison(d.file) === normalizeForComparison(target),
  ).length;
  if (lsp.length !== expected) return `toLspDiagnostics emitted ${lsp.length} of ${expected} diagnostics`;
  for (const diagnostic of lsp) {
    const reason = checkEmitted(diagnostic);
    if (reason) return reason;
  }

  // Pair assertion: grouping must preserve the input multiset, not a subset.
  const groups = groupByFile(parsed);
  const regrouped = [...groups.values()].flat();
  if (regrouped.length !== parsed.length) {
    return `groupByFile lost diagnostics: ${regrouped.length} of ${parsed.length}`;
  }
  for (const d of regrouped) {
    if (!groups.get(normalizeForComparison(d.file))?.includes(d)) {
      return 'groupByFile stored a diagnostic under a key that does not match its file';
    }
  }

  return null;
}

describe('parseDiagnostics fuzzing', () => {
  const options: FuzzOptions = { seed: 0x5eed, iterations: 3000, depth: 5, budgetMs: 250 };

  it('holds every parse invariant over the seed corpus', () => {
    for (const seedInput of SEED_CORPUS) {
      expect(checkParseInvariants(seedInput), `seed input: ${JSON.stringify(seedInput)}`).toBeNull();
    }
  });

  it('holds every parse invariant under mutation', () => {
    const failure = fuzz(SEED_CORPUS, checkParseInvariants, options);
    if (failure) {
      throw new Error(
        `parseDiagnostics broke an invariant: ${failure.message}\n` +
          `seed: ${options.seed}\ninput: ${JSON.stringify(failure.input)}`,
      );
    }
  });
});

describe('toLspDiagnostics fuzzing', () => {
  const LINE_NUMBERS = [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    0,
    1,
    -1,
    0.5,
    -0.5,
    LSP_UINT_MAX,
    LSP_UINT_MAX + 1,
    Number.MAX_SAFE_INTEGER,
    2 ** 31,
    2 ** 53,
    1e300,
  ];

  const SEVERITIES = [DiagnosticSeverity.Error, DiagnosticSeverity.Warning];

  /**
   * `toLspDiagnostics` is exported for programmatic consumers who build
   * `ParsedDiagnostic` values themselves, so the emitter is fuzzed over
   * hand-built inputs, not only over the parser's output.
   */
  it('emits uinteger positions for any line number a consumer can supply', () => {
    for (const line of LINE_NUMBERS) {
      for (const severity of SEVERITIES) {
        const [diagnostic] = toLspDiagnostics(
          [{ file: '/tmp/a.c', line, severity, code: 'C2146', message: 'm', relatedInfo: [] }],
          '/tmp/a.c',
        );
        const reason = checkEmitted(diagnostic);
        if (reason) throw new Error(`line ${line} (${severity}): ${reason}`);
      }
    }
  });

  it('emits protocol-valid diagnostics for fuzzed messages and related info', () => {
    const check = (input: string): string | null => {
      const related = input.split('\n');
      const parsed: ParsedDiagnostic[] = [
        {
          file: '/tmp/a.c',
          line: 3,
          severity: DiagnosticSeverity.Error,
          code: 'C2664',
          message: input,
          relatedInfo: related,
        },
      ];
      const [diagnostic] = toLspDiagnostics(parsed, '/tmp/a.c');
      const reason = checkEmitted(diagnostic);
      if (reason) return reason;
      if (!diagnostic.message.includes(related[0])) return 'relatedInfo was dropped from the message';
      return null;
    };

    const failure = fuzz(SEED_CORPUS, check, {
      seed: 0xc0ffee,
      iterations: 1500,
      depth: 4,
      budgetMs: 250,
    });
    if (failure) {
      throw new Error(
        `toLspDiagnostics broke an invariant: ${failure.message}\n` +
          `seed: 0xc0ffee\ninput: ${JSON.stringify(failure.input)}`,
      );
    }
  });
});
