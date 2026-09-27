import { describe, it, expect } from 'vitest';
import { DiagnosticSeverity } from 'vscode-languageserver-protocol';
import { parseDiagnostics, toLspDiagnostics, LSP_UINT_MAX } from '../src/diagnostics';
import { fuzzInputs, invariant } from './helpers/fuzz';

/**
 * Fuzzes the CL.EXE output parser. Compiler output is the least controlled
 * input the server handles: it is produced by a program, from filenames the
 * user chose, printing into a buffer the editor's document content can steer.
 * A parser bug here does not throw on a bad request, it publishes a wrong
 * diagnostic on a real document, so the invariants below are about the shape
 * of what comes out rather than about not crashing.
 */

/** Real CL.EXE transcripts, kept verbatim so mutation starts from real shapes. */
const CORPUS: readonly string[] = [
  "Z:\\tmp\\test.c(3) : error C2146: syntax error : missing ';' before identifier 'printf'",
  [
    'Microsoft (R) C/C++ Optimizing Compiler Version 6.00',
    'Copyright (C) Microsoft Corporation.  All rights reserved.',
    'test.c',
    "cl : Command line warning D9025 : overriding '/W3' with '/W4'",
    "Z:\\tmp\\test.c(5) : warning C4047: 'initializing' : 'int ' differs in levels of indirection from 'char [6]'",
    "Z:\\tmp\\test.c(5) : error C2146: syntax error : missing ';' before identifier 'undeclared_func'",
    "        This conversion requires a reinterpret_cast, a C-style cast or function-style cast",
    "        note: see reference to function definition here",
  ].join('\r\n'),
  "Z:\\tmp\\missing.cpp(1) : fatal error C1083: Cannot open include file: 'nonexistent.h': No such file or directory",
  'Program Files (x86)\\Microsoft Visual Studio\\VC98\\include\\stdio.h(20) : error C2143: syntax error : missing \';\' before \'type\'',
  [
    'LINK : warning LNK4076: : incremental linking is not compatible with /LTCG; disabling incremental linking',
    'LNK2001 unresolved external symbol _main referenced in function _mainCRTStartup',
    'Creating library msvc6lsp.lib and object msvc6lsp.exp',
  ].join('\n'),
  'Compiling...',
  't\u00e9st.c',
  't\u0065\u0301st.c(2) : error C2065: \u0027x\u0027 : undeclared identifier',
  '\ufeffZ:\\tmp\\test.c(1) : error C1: \u0000 not a real diagnostic code',
  '',
];

describe('parseDiagnostics fuzz', () => {
  const cases = fuzzInputs(CORPUS);

  it('never reports a field the LSP wire format cannot carry', () => {
    for (const input of cases) {
      const parsed = parseDiagnostics(input);
      invariant(
        parsed.length <= input.split(/\r?\n/).length,
        input,
        'a diagnostic was produced for a line that does not exist',
      );

      for (const d of parsed) {
        invariant(
          d.severity === DiagnosticSeverity.Error || d.severity === DiagnosticSeverity.Warning,
          input,
          `severity is neither error nor warning: ${String(d.severity)}`,
        );
        invariant(/^[A-Za-z]+\d+$/.test(d.code), input, `code is not a compiler code: ${JSON.stringify(d.code)}`);
        invariant(
          Number.isInteger(d.line) && d.line >= 0 && d.line <= LSP_UINT_MAX,
          input,
          `line is outside the uinteger range: ${String(d.line)}`,
        );
        invariant(d.message.length > 0, input, 'diagnostic has an empty message');
      }
    }
  });

  it('keeps every parsed diagnostic selectable by the file it names', () => {
    for (const input of cases) {
      for (const d of parseDiagnostics(input)) {
        const lsp = toLspDiagnostics([d], d.file);
        invariant(lsp.length === 1, input, `diagnostic for ${d.file} is not reachable through its own file name`);
        const { start, end } = lsp[0].range;
        invariant(
          Number.isInteger(start.line) && start.line >= 0 && start.line <= LSP_UINT_MAX && start.line <= end.line,
          input,
          `range start is not a position: ${start.line}`,
        );
        invariant(
          Number.isInteger(end.character) && end.character >= 0 && end.character <= LSP_UINT_MAX,
          input,
          `range end character is outside the uinteger range: ${String(end.character)}`,
        );
        invariant(
          lsp[0].message.startsWith(d.message) && lsp[0].severity === d.severity && lsp[0].code === d.code,
          input,
          'the LSP diagnostic does not carry the parsed message, severity and code through',
        );
      }
    }
  });

  it('reads the corpus itself as documented', () => {
    // The mutations are only meaningful if the seeds parse; a seed that no
    // longer matches the documented shape makes every derived case vacuous.
    const parsedSeeds = CORPUS.map((seed) => parseDiagnostics(seed).length);
    expect(parsedSeeds.filter((count) => count > 0).length).toBeGreaterThanOrEqual(4);
  });
});
