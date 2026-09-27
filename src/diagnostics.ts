import {
  Diagnostic,
  DiagnosticSeverity,
  Range,
  Position,
} from 'vscode-languageserver-protocol';
import { fromWinePath } from './wine-path';

/** A diagnostic parsed from raw CL.EXE text output. */
export interface ParsedDiagnostic {
  file: string;
  line: number;
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  relatedInfo: string[];
}

/** The three severity keywords CL.EXE emits. */
type MsvcSeverity = 'error' | 'warning' | 'fatal error';

// MSVC output: filename(line) : (error|warning|fatal error) CODE: message
// Greedy (.+) ensures paths with parentheses (e.g. "Program Files (x86)")
// bind correctly — the last `(digits)` wins.
// Code prefix is [A-Za-z]+\d+ to match C####, D####, and future prefixes.
const DIAG_REGEX =
  /^(.+)\((\d+)\)\s*:\s*(error|warning|fatal error)\s+([A-Za-z]+\d+)\s*:\s*(.+)$/;

// CL.EXE typically indents continuation/context lines; accept 8+ spaces or tabs.
const CONTINUATION_INDENT = /^(?: {8,}|\t)/;

/** LSP `uinteger` max value (2^31 - 1), used for "end of line" positions. */
export const LSP_UINT_MAX = 2147483647;

/**
 * Parses raw CL.EXE stdout+stderr into structured diagnostics.
 *
 * Handles multi-line diagnostics where continuation lines (indented 8 spaces)
 * are attached as `relatedInfo` to the preceding diagnostic.
 */
export function parseDiagnostics(output: string): ParsedDiagnostic[] {
  const lines = output.split(/\r?\n/);
  const diagnostics: ParsedDiagnostic[] = [];
  let current: ParsedDiagnostic | null = null;

  for (const line of lines) {
    const match = DIAG_REGEX.exec(line);
    if (match) {
      if (current) {
        diagnostics.push(current);
      }
      const [, file, lineNum, severity, code, message] = match;
      current = {
        file: fromWinePath(file),
        line: parseLineNumber(lineNum),
        severity: mapSeverity(severity as MsvcSeverity),
        code,
        message,
        relatedInfo: [],
      };
    } else {
      const trimmed = line.trim();
      if (current && CONTINUATION_INDENT.test(line)) {
        current.relatedInfo.push(trimmed);
      } else if (trimmed === '') {
        if (current) {
          diagnostics.push(current);
          current = null;
        }
      }
    }
  }

  if (current) {
    diagnostics.push(current);
  }

  return diagnostics;
}

/**
 * The digits a diagnostic line carries are untrusted text: a filename or an
 * included header can print a number long enough to overflow `Number`, and
 * `parseInt` answers that with `Infinity`. A line that overflows is no
 * position at all, so it is pinned to the last addressable line rather than
 * passed on as a value the LSP range arithmetic cannot use.
 */
function parseLineNumber(text: string): number {
  const value = Number.parseInt(text, 10);
  return Number.isFinite(value) ? value : LSP_UINT_MAX;
}

function mapSeverity(severity: MsvcSeverity): DiagnosticSeverity {
  switch (severity) {
    case 'error':
    case 'fatal error':
      return DiagnosticSeverity.Error;
    case 'warning':
      return DiagnosticSeverity.Warning;
  }
}

/**
 * Converts parsed diagnostics into LSP `Diagnostic` objects, filtering
 * to only those belonging to `targetFile` (case-insensitive, slash-normalized).
 */
export function toLspDiagnostics(
  parsed: ParsedDiagnostic[],
  targetFile: string,
): Diagnostic[] {
  const target = normalizeForComparison(targetFile);
  // A single CL.EXE run reports the same file on every one of its diagnostic
  // lines, and NFC normalization is the expensive part of the comparison. One
  // normalization per distinct file instead of one per diagnostic keeps a
  // 5000-line report from paying for 5000 Unicode passes.
  const normalizedFiles = new Map<string, string>();
  return parsed
    .filter((d) => {
      let normalized = normalizedFiles.get(d.file);
      if (normalized === undefined) {
        normalized = normalizeForComparison(d.file);
        normalizedFiles.set(d.file, normalized);
      }
      return normalized === target;
    })
    .map((d) => {
      const line = Math.min(LSP_UINT_MAX, Math.max(0, d.line - 1));
      const range: Range = {
        start: Position.create(line, 0),
        end: Position.create(line, LSP_UINT_MAX),
      };

      let message = d.message;
      if (d.relatedInfo.length > 0) {
        message += '\n' + d.relatedInfo.join('\n');
      }

      return {
        range,
        severity: d.severity,
        code: d.code,
        source: 'msvc6',
        message,
      };
    });
}

/**
 * Diagnostic standing in for a check that never ran, whether CL.EXE could
 * not be spawned or the scratch source could not be written. Publishing an
 * empty list in that case would mark the document clean on the strength of
 * no result at all.
 */
export function toFailureDiagnostic(message: string): Diagnostic {
  return {
    range: { start: Position.create(0, 0), end: Position.create(0, 0) },
    severity: DiagnosticSeverity.Error,
    source: 'msvc6',
    message,
  };
}

/**
 * Case-folds, unifies separators, and normalizes to NFC so a path spelled
 * NFD by the filesystem (macOS) still matches the NFC spelling an editor or
 * database supplies.
 *
 * The NFC pass runs after the case fold, not before it: case folding is not
 * normalization-preserving. `'İ'` (U+0130) is NFC, but its lowercase form is
 * `i` + U+0307 COMBINING DOT ABOVE, which is NFD. Folding first and
 * normalizing last is what makes the two spellings compare equal.
 */
function normalizeForComparison(filePath: string): string {
  return filePath.toLowerCase().normalize('NFC').replace(/\\/g, '/');
}

