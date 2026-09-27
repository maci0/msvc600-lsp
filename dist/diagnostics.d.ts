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
/** LSP `uinteger` max value (2^31 - 1), used for "end of line" positions. */
export declare const LSP_UINT_MAX = 2147483647;
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
//# sourceMappingURL=diagnostics.d.ts.map