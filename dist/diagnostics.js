"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseDiagnostics = parseDiagnostics;
exports.toLspDiagnostics = toLspDiagnostics;
exports.toFailureDiagnostic = toFailureDiagnostic;
exports.normalizeForComparison = normalizeForComparison;
exports.groupByFile = groupByFile;
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
const LSP_UINT_MAX = 2147483647;
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
                line: parseInt(lineNum, 10),
                severity: mapSeverity(severity),
                code,
                message,
                relatedInfo: [],
            };
        }
        else if (current && CONTINUATION_INDENT.test(line)) {
            current.relatedInfo.push(line.trim());
        }
        else if (line.trim() === '') {
            if (current) {
                diagnostics.push(current);
                current = null;
            }
        }
    }
    if (current) {
        diagnostics.push(current);
    }
    return diagnostics;
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
    return parsed
        .filter((d) => normalizeForComparison(d.file) === normalizeForComparison(targetFile))
        .map((d) => {
        const line = Math.min(LSP_UINT_MAX, Math.max(0, d.line - 1));
        const range = {
            start: vscode_languageserver_protocol_1.Position.create(line, 0),
            end: vscode_languageserver_protocol_1.Position.create(line, LSP_UINT_MAX),
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
 */
function normalizeForComparison(filePath) {
    return filePath.normalize('NFC').toLowerCase().replace(/\\/g, '/');
}
/**
 * Groups diagnostics by normalized file path for batch processing.
 *
 * Exported for the test suite; the server filters to a single file instead.
 */
function groupByFile(diagnostics) {
    const groups = new Map();
    for (const d of diagnostics) {
        const key = normalizeForComparison(d.file);
        const existing = groups.get(key);
        if (existing) {
            existing.push(d);
        }
        else {
            groups.set(key, [d]);
        }
    }
    return groups;
}
//# sourceMappingURL=diagnostics.js.map