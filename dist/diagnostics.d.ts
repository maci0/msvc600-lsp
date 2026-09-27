import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver-protocol';
/** A diagnostic parsed from raw CL.EXE text output. */
export interface ParsedDiagnostic {
    file: string;
    line: number;
    severity: DiagnosticSeverity;
    code: string;
    message: string;
    relatedInfo: string[];
}
/**
 * Parses raw CL.EXE stdout+stderr into structured diagnostics.
 *
 * Handles multi-line diagnostics where continuation lines (indented 8 spaces)
 * are attached as `relatedInfo` to the preceding diagnostic.
 */
export declare function parseDiagnostics(output: string): ParsedDiagnostic[];
/**
 * Converts parsed diagnostics into LSP `Diagnostic` objects, filtering
 * to only those belonging to `targetFile` (case-insensitive, slash-normalized).
 */
export declare function toLspDiagnostics(parsed: ParsedDiagnostic[], targetFile: string): Diagnostic[];
/**
 * Diagnostic standing in for a check that never ran, whether CL.EXE could
 * not be spawned or the scratch source could not be written. Publishing an
 * empty list in that case would mark the document clean on the strength of
 * no result at all.
 */
export declare function toFailureDiagnostic(message: string): Diagnostic;
/**
 * Case-folds, unifies separators, and normalizes to NFC so a path spelled
 * NFD by the filesystem (macOS) still matches the NFC spelling an editor or
 * database supplies.
 */
export declare function normalizeForComparison(filePath: string): string;
/**
 * Groups diagnostics by normalized file path for batch processing.
 *
 * Exported for the test suite; the server filters to a single file instead.
 */
export declare function groupByFile(diagnostics: ParsedDiagnostic[]): Map<string, ParsedDiagnostic[]>;
//# sourceMappingURL=diagnostics.d.ts.map