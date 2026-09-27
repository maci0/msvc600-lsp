"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LSP_UINT_MAX = void 0;
exports.parseDiagnostics = parseDiagnostics;
exports.toLspDiagnostics = toLspDiagnostics;
exports.toFailureDiagnostic = toFailureDiagnostic;
const vscode_languageserver_protocol_1 = require("vscode-languageserver-protocol");
const wine_path_1 = require("./wine-path");
// MSVC output: filename(line) : (error|warning|fatal error) CODE: message
// Greedy (.+) ensures paths with parentheses (e.g. "Program Files (x86)")
// bind correctly — the last `(digits)` wins.
// Code prefix is [A-Za-z]+\d+ to match C####, D####, and future prefixes.
const DIAG_REGEX = /^(.+)\((\d+)\)\s*:\s*(error|warning|fatal error)\s+([A-Za-z]+\d+)\s*:\s*(.+)$/;
// CL.EXE typically indents continuation/context lines; accept 8+ spaces or tabs.
const CONTINUATION_INDENT = /^(?: {8,}|\t)/;
/** LSP `uinteger` max value (2^31 - 1), used for "end of line" positions. */
exports.LSP_UINT_MAX = 2147483647;
/**
 * Parses raw CL.EXE stdout+stderr into structured diagnostics.
 *
 * Handles multi-line diagnostics where continuation lines (indented 8 spaces)
 * are attached as `relatedInfo` to the preceding diagnostic.
 */
function parseDiagnostics(output) {
    const lines = output.split(/\r?\n/);
    const diagnostics = [];
    let current = null;
    for (const line of lines) {
        const match = DIAG_REGEX.exec(line);
        if (match) {
            if (current) {
                diagnostics.push(current);
            }
            const [, file, lineNum, severity, code, message] = match;
            current = {
                file: (0, wine_path_1.fromWinePath)(file),
                line: parseLineNumber(lineNum),
                severity: mapSeverity(severity),
                code,
                message,
                relatedInfo: [],
            };
        }
        else {
            const trimmed = line.trim();
            if (current && CONTINUATION_INDENT.test(line)) {
                current.relatedInfo.push(trimmed);
            }
            else if (trimmed === '') {
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
function parseLineNumber(text) {
    const value = Number.parseInt(text, 10);
    return Number.isFinite(value) ? value : exports.LSP_UINT_MAX;
}
function mapSeverity(severity) {
    switch (severity) {
        case 'error':
        case 'fatal error':
            return vscode_languageserver_protocol_1.DiagnosticSeverity.Error;
        case 'warning':
            return vscode_languageserver_protocol_1.DiagnosticSeverity.Warning;
    }
}
/**
 * Converts parsed diagnostics into LSP `Diagnostic` objects, filtering
 * to only those belonging to `targetFile` (case-insensitive, slash-normalized).
 */
function toLspDiagnostics(parsed, targetFile) {
    const target = normalizeForComparison(targetFile);
    // A single CL.EXE run reports the same file on every one of its diagnostic
    // lines, and NFC normalization is the expensive part of the comparison. One
    // normalization per distinct file instead of one per diagnostic keeps a
    // 5000-line report from paying for 5000 Unicode passes.
    const normalizedFiles = new Map();
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
        const line = Math.min(exports.LSP_UINT_MAX, Math.max(0, d.line - 1));
        const range = {
            start: vscode_languageserver_protocol_1.Position.create(line, 0),
            end: vscode_languageserver_protocol_1.Position.create(line, exports.LSP_UINT_MAX),
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
function toFailureDiagnostic(message) {
    return {
        range: { start: vscode_languageserver_protocol_1.Position.create(0, 0), end: vscode_languageserver_protocol_1.Position.create(0, 0) },
        severity: vscode_languageserver_protocol_1.DiagnosticSeverity.Error,
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
function normalizeForComparison(filePath) {
    return filePath.toLowerCase().normalize('NFC').replace(/\\/g, '/');
}
//# sourceMappingURL=diagnostics.js.map