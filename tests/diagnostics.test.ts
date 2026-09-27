import { describe, it, expect } from 'vitest';
import { DiagnosticSeverity } from 'vscode-languageserver-protocol';
import {
  parseDiagnostics,
  toLspDiagnostics,
  groupByFile,
  ParsedDiagnostic,
} from '../src/diagnostics';

describe('parseDiagnostics', () => {
  it('parses a single error line', () => {
    const output = 'Z:/tmp/test.c(3) : error C2146: syntax error : missing \';\' before identifier \'printf\'';
    const result = parseDiagnostics(output);
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe('/tmp/test.c');
    expect(result[0].line).toBe(3);
    expect(result[0].severity).toBe(DiagnosticSeverity.Error);
    expect(result[0].code).toBe('C2146');
    expect(result[0].message).toContain('syntax error');
  });

  it('parses a single warning line', () => {
    const output = 'Z:/tmp/test.c(5) : warning C4047: \'initializing\' : \'int \' differs in levels of indirection from \'char [6]\'';
    const result = parseDiagnostics(output);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe(DiagnosticSeverity.Warning);
    expect(result[0].code).toBe('C4047');
    expect(result[0].line).toBe(5);
  });

  it('parses fatal errors', () => {
    const output = 'Z:/tmp/test.c(1) : fatal error C1083: Cannot open include file: \'nonexistent.h\': No such file or directory';
    const result = parseDiagnostics(output);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe(DiagnosticSeverity.Error);
    expect(result[0].code).toBe('C1083');
    expect(result[0].message).toContain('Cannot open include file');
  });

  it('parses multiple diagnostics from mixed output', () => {
    const output = [
      'test.c',
      'Z:/tmp/test.c(3) : warning C4047: \'initializing\' : \'int \' differs in levels of indirection from \'char [6]\'',
      'Z:/tmp/test.c(5) : error C2146: syntax error : missing \';\' before identifier \'undeclared_func\'',
      'Z:/tmp/test.c(5) : warning C4013: \'undeclared_func\' undefined; assuming extern returning int',
    ].join('\n');

    const result = parseDiagnostics(output);
    expect(result).toHaveLength(3);
    expect(result[0].severity).toBe(DiagnosticSeverity.Warning);
    expect(result[1].severity).toBe(DiagnosticSeverity.Error);
    expect(result[2].severity).toBe(DiagnosticSeverity.Warning);
  });

  it('captures continuation lines as related info', () => {
    const output = [
      'Z:/tmp/test.cpp(12) : error C2664: \'bar\' : cannot convert parameter 1 from \'char [6]\' to \'int\'',
      '        This conversion requires a reinterpret_cast, a C-style cast or function-style cast',
    ].join('\n');

    const result = parseDiagnostics(output);
    expect(result).toHaveLength(1);
    expect(result[0].relatedInfo).toHaveLength(1);
    expect(result[0].relatedInfo[0]).toContain('reinterpret_cast');
  });

  it('handles Windows-style paths from Wine (C:\\msvc6\\...)', () => {
    const output = 'C:\\msvc6\\include\\xlocale(242) : warning C4511: \'codecvt_base\' : copy constructor could not be generated';
    const result = parseDiagnostics(output);
    expect(result).toHaveLength(1);
    expect(result[0].line).toBe(242);
    expect(result[0].code).toBe('C4511');
  });

  it('returns empty array for clean output', () => {
    const output = 'test.c\n';
    const result = parseDiagnostics(output);
    expect(result).toHaveLength(0);
  });

  it('handles empty string', () => {
    expect(parseDiagnostics('')).toHaveLength(0);
  });

  it('handles output with only filename echo', () => {
    const output = 'myfile.c\n\n';
    const result = parseDiagnostics(output);
    expect(result).toHaveLength(0);
  });

  it('parses diagnostics with deeply nested Windows paths', () => {
    const output = 'C:\\msvc6\\include\\xlocale(387) : warning C4018: \'<\' : signed/unsigned mismatch';
    const result = parseDiagnostics(output);
    expect(result).toHaveLength(1);
    expect(result[0].code).toBe('C4018');
  });

  it('parses paths containing parentheses (e.g. Program Files (x86))', () => {
    const output = 'C:\\Program Files (x86)\\MSVC\\test.c(10) : error C2146: syntax error';
    const result = parseDiagnostics(output);
    expect(result).toHaveLength(1);
    expect(result[0].file).toContain('Program Files (x86)');
    expect(result[0].line).toBe(10);
    expect(result[0].code).toBe('C2146');
  });

  it('handles multiple continuation lines', () => {
    const output = [
      'Z:/tmp/test.cpp(50) : warning C4512: \'sentry\' : assignment operator could not be generated',
      '        Z:/tmp/test.cpp(38) : see declaration of \'sentry\'',
      '        Z:/tmp/test.cpp(373) : see reference to class template instantiation',
    ].join('\n');

    const result = parseDiagnostics(output);
    expect(result).toHaveLength(1);
    expect(result[0].relatedInfo).toHaveLength(2);
  });

  it('parses D-prefixed command-line warnings (e.g. D9025)', () => {
    const output = 'Z:/tmp/test.c(1) : warning D9025: overriding /W4 with /W3';
    const result = parseDiagnostics(output);
    expect(result).toHaveLength(1);
    expect(result[0].code).toBe('D9025');
    expect(result[0].severity).toBe(DiagnosticSeverity.Warning);
  });

  it('captures tab-indented continuation lines', () => {
    const output = [
      'Z:/tmp/test.cpp(12) : error C2664: cannot convert parameter',
      '\tThis conversion requires a cast',
    ].join('\n');
    const result = parseDiagnostics(output);
    expect(result).toHaveLength(1);
    expect(result[0].relatedInfo).toHaveLength(1);
    expect(result[0].relatedInfo[0]).toContain('cast');
  });

  it('parses CRLF line endings', () => {
    const output = 'Z:/tmp/test.c(3) : error C2146: missing semicolon\r\nZ:/tmp/test.c(5) : warning C4013: undefined function\r\n';
    const result = parseDiagnostics(output);
    expect(result).toHaveLength(2);
  });

  it('pushes current diagnostic when encountering non-matching non-blank line', () => {
    const output = [
      'Z:/tmp/test.c(3) : error C2146: syntax error',
      'some random text that is not indented 8 spaces',
      '',
    ].join('\n');
    const result = parseDiagnostics(output);
    expect(result).toHaveLength(1);
    expect(result[0].code).toBe('C2146');
    expect(result[0].relatedInfo).toHaveLength(0);
  });
});

describe('toLspDiagnostics', () => {
  const makeParsed = (overrides: Partial<ParsedDiagnostic> = {}): ParsedDiagnostic => ({
    file: '/tmp/test.c',
    line: 5,
    severity: DiagnosticSeverity.Error,
    code: 'C2146',
    message: 'syntax error',
    relatedInfo: [],
    ...overrides,
  });

  it('converts parsed diagnostics to LSP diagnostics', () => {
    const parsed = [makeParsed()];
    const lsp = toLspDiagnostics(parsed, '/tmp/test.c');
    expect(lsp).toHaveLength(1);
    expect(lsp[0].range.start.line).toBe(4);
    expect(lsp[0].range.start.character).toBe(0);
    expect(lsp[0].source).toBe('msvc6');
    expect(lsp[0].code).toBe('C2146');
  });

  it('converts line numbers to 0-indexed', () => {
    const parsed = [makeParsed({ line: 1 })];
    const lsp = toLspDiagnostics(parsed, '/tmp/test.c');
    expect(lsp[0].range.start.line).toBe(0);
  });

  it('clamps line 0 to 0', () => {
    const parsed = [makeParsed({ line: 0 })];
    const lsp = toLspDiagnostics(parsed, '/tmp/test.c');
    expect(lsp[0].range.start.line).toBe(0);
  });

  it('filters to only matching file', () => {
    const parsed = [
      makeParsed({ file: '/tmp/test.c' }),
      makeParsed({ file: '/tmp/other.c' }),
    ];
    const lsp = toLspDiagnostics(parsed, '/tmp/test.c');
    expect(lsp).toHaveLength(1);
  });

  it('matches files case-insensitively', () => {
    const parsed = [makeParsed({ file: '/TMP/Test.c' })];
    const lsp = toLspDiagnostics(parsed, '/tmp/test.c');
    expect(lsp).toHaveLength(1);
  });

  it('appends related info to message', () => {
    const parsed = [makeParsed({ relatedInfo: ['see declaration of \'foo\'', 'see reference here'] })];
    const lsp = toLspDiagnostics(parsed, '/tmp/test.c');
    expect(lsp[0].message).toContain('see declaration');
    expect(lsp[0].message).toContain('see reference');
  });

  it('returns empty for no matching file', () => {
    const parsed = [makeParsed({ file: '/tmp/other.c' })];
    const lsp = toLspDiagnostics(parsed, '/tmp/test.c');
    expect(lsp).toHaveLength(0);
  });

  it('maps severity correctly', () => {
    const errors = toLspDiagnostics([makeParsed({ severity: DiagnosticSeverity.Error })], '/tmp/test.c');
    const warnings = toLspDiagnostics([makeParsed({ severity: DiagnosticSeverity.Warning })], '/tmp/test.c');
    expect(errors[0].severity).toBe(DiagnosticSeverity.Error);
    expect(warnings[0].severity).toBe(DiagnosticSeverity.Warning);
  });

  it('uses LSP uinteger max for end character (not Number.MAX_SAFE_INTEGER)', () => {
    const parsed = [makeParsed()];
    const lsp = toLspDiagnostics(parsed, '/tmp/test.c');
    const LSP_UINT_MAX = 2147483647;
    expect(lsp[0].range.end.character).toBe(LSP_UINT_MAX);
  });

  it('matches files with mixed separators', () => {
    const parsed = [makeParsed({ file: '\\tmp\\test.c' })];
    const lsp = toLspDiagnostics(parsed, '/tmp/test.c');
    expect(lsp).toHaveLength(1);
  });
});

describe('groupByFile', () => {
  it('groups diagnostics by normalized file path', () => {
    const diags: ParsedDiagnostic[] = [
      { file: '/tmp/a.c', line: 1, severity: DiagnosticSeverity.Error, code: 'C0001', message: 'err1', relatedInfo: [] },
      { file: '/tmp/b.c', line: 2, severity: DiagnosticSeverity.Warning, code: 'C0002', message: 'warn1', relatedInfo: [] },
      { file: '/tmp/a.c', line: 3, severity: DiagnosticSeverity.Error, code: 'C0003', message: 'err2', relatedInfo: [] },
    ];
    const groups = groupByFile(diags);
    expect(groups.size).toBe(2);
    expect(groups.get('/tmp/a.c')).toHaveLength(2);
    expect(groups.get('/tmp/b.c')).toHaveLength(1);
  });

  it('normalizes case and path separators', () => {
    const diags: ParsedDiagnostic[] = [
      { file: 'C:\\MSVC6\\Test.c', line: 1, severity: DiagnosticSeverity.Error, code: 'C0001', message: 'a', relatedInfo: [] },
      { file: 'c:\\msvc6\\test.c', line: 2, severity: DiagnosticSeverity.Error, code: 'C0002', message: 'b', relatedInfo: [] },
    ];
    const groups = groupByFile(diags);
    expect(groups.size).toBe(1);
  });

  it('returns empty map for empty input', () => {
    expect(groupByFile([]).size).toBe(0);
  });
});
