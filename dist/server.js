#!/usr/bin/env bun
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.documents = exports.connection = void 0;
exports.getConfig = getConfig;
exports.scheduleValidation = scheduleValidation;
const node_1 = require("vscode-languageserver/node");
const vscode_languageserver_textdocument_1 = require("vscode-languageserver-textdocument");
const vscode_uri_1 = require("vscode-uri");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const config_1 = require("./config");
const compiler_1 = require("./compiler");
const diagnostics_1 = require("./diagnostics");
const logging_1 = require("./logging");
const validation_state_1 = require("./validation-state");
const task_queue_1 = require("./task-queue");
const connection = (0, node_1.createConnection)(node_1.ProposedFeatures.all);
exports.connection = connection;
const documents = new node_1.TextDocuments(vscode_languageserver_textdocument_1.TextDocument);
exports.documents = documents;
// Precedence: defaults < MSVC600_* environment < initializationOptions. The
// environment layer is read here so a launch that cannot pass options still
// configures the server; initializationOptions override it in onInitialize.
const envConfig = (0, config_1.configFromEnv)();
let config = (0, config_1.mergeValidated)((0, config_1.defaultConfig)(), envConfig);
/** Rejected environment values, logged once the connection can carry messages. */
const startupIssues = (0, config_1.formatIssues)('MSVC600_*', envConfig.issues);
let hasConfigurationCapability = false;
/** Decides which validation result per URI is allowed to reach the client. */
const validationSequencer = new validation_state_1.ValidationSequencer();
/** Per-URI debounce timers for `onDidChangeContent`. */
const pendingValidations = new Map();
const DEBOUNCE_MS = 300;
/**
 * At most this many CL.EXE children exist at once. Each check is a heavyweight
 * process (a full Wine services startup on non-Windows), so the number is kept
 * at the parallelism a developer machine can actually absorb; the queue
 * serialises the rest rather than dropping them.
 */
const MAX_CONCURRENT_CHECKS = 2;
/**
 * Validation tasks, one per document URI. A new task for a URI aborts the
 * previous one, so a superseded edit never reaches the compiler.
 */
const validationQueue = new task_queue_1.TaskQueue(MAX_CONCURRENT_CHECKS);
/** Diagnostic code used for failures of the check itself, not of the source file. */
const TOOL_ERROR_CODE = 'msvc600-check-failed';
/** Range covering a whole first line, where tool-failure diagnostics are anchored. */
const DOCUMENT_START = {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 0 },
};
/** Reports a caught error to the client log with control characters removed. */
function logValidationError(context, e) {
    connection.console.error((0, logging_1.sanitizeForLog)(`${context}: ${String(e)}`));
}
/**
 * Whether `e` came from the compiler run rather than from staging the scratch
 * source. A rejection raised by `syntaxCheck` carries no errno, while the
 * filesystem failures that abort the write do.
 */
function isCheckFailure(e) {
    return !(e instanceof Error && 'code' in e);
}
/**
 * Reports a failure of the syntax check as a diagnostic on the document.
 *
 * A check that never completed says nothing about the file, so publishing an
 * empty diagnostic list would read as "no problems found" and silently drop
 * whatever the user was already seeing.
 */
function publishCheckFailure(uri, message) {
    connection.console.error((0, logging_1.sanitizeForLog)(`MSVC6 syntax check failed for ${uri}: ${message}`));
    connection.sendDiagnostics({
        uri,
        diagnostics: [
            {
                range: DOCUMENT_START,
                severity: node_1.DiagnosticSeverity.Error,
                code: TOOL_ERROR_CODE,
                source: 'msvc6',
                message,
            },
        ],
    });
}
connection.onInitialize((params) => {
    const capabilities = params.capabilities;
    hasConfigurationCapability = !!(capabilities.workspace && capabilities.workspace.configuration);
    for (const line of startupIssues) {
        connection.console.warn(line);
    }
    if (params.initializationOptions) {
        const validated = (0, config_1.validateConfig)(params.initializationOptions);
        config = (0, config_1.mergeValidated)(config, validated);
        for (const line of (0, config_1.formatIssues)('initializationOptions', validated.issues)) {
            connection.console.warn(line);
        }
    }
    connection.console.info(`effective configuration: cl=${config.useWine ? `${config.wineExecutable} ${config.clPath}` : config.clPath}, ` +
        `includePaths=${JSON.stringify(config.includePaths)}, warnLevel=${config.warnLevel}, ` +
        `additionalFlags=${JSON.stringify(config.additionalFlags)}, useWine=${config.useWine}, ` +
        `outputEncoding=${config.outputEncoding}, checkTimeoutMs=${config.checkTimeoutMs}, ` +
        `maxOutputBytes=${config.maxOutputBytes}`);
    return {
        capabilities: {
            textDocumentSync: {
                openClose: true,
                change: node_1.TextDocumentSyncKind.Full,
                save: { includeText: false },
            },
        },
    };
});
connection.onInitialized(() => {
    if (hasConfigurationCapability) {
        void connection.client.register(node_1.DidChangeConfigurationNotification.type, undefined).then(undefined, (e) => logValidationError('Failed to register config change watcher', e));
    }
});
connection.onDidChangeConfiguration((change) => {
    if (!change.settings?.msvc6)
        return;
    const validated = (0, config_1.validateConfig)(change.settings.msvc6);
    for (const line of (0, config_1.formatIssues)('didChangeConfiguration', validated.issues)) {
        connection.console.warn(line);
    }
    // Runtime config changes are untrusted — only accept non-executable fields.
    // Notably, additionalFlags is excluded: arbitrary CL.EXE flags could write files
    // or alter behavior beyond syntax checking. Set additionalFlags via initializationOptions only.
    const previous = config;
    config = {
        ...config,
        ...(validated.values.includePaths ? { includePaths: validated.values.includePaths } : {}),
        ...(validated.values.warnLevel !== undefined ? { warnLevel: validated.values.warnLevel } : {}),
    };
    // A client may re-send the settings it already holds. Re-checking every open
    // document would spawn one CL.EXE per document for no change in the inputs.
    if ((0, config_1.runtimeConfigEquals)(previous, config))
        return;
    // A client that repoints includePaths controls which headers every open
    // file is preprocessed against, so the change is recorded.
    connection.console.info((0, logging_1.sanitizeForLog)(`msvc6 configuration changed: includePaths=${JSON.stringify(config.includePaths)}, warnLevel=${config.warnLevel}`));
    for (const t of pendingValidations.values())
        clearTimeout(t);
    pendingValidations.clear();
    // The queue bounds how many of these become CL.EXE children at once.
    for (const d of documents.all())
        scheduleValidation(d);
});
documents.onDidChangeContent((change) => {
    const uri = change.document.uri;
    const existing = pendingValidations.get(uri);
    if (existing)
        clearTimeout(existing);
    pendingValidations.set(uri, setTimeout(() => {
        pendingValidations.delete(uri);
        const doc = documents.get(uri);
        if (!doc)
            return;
        scheduleValidation(doc);
    }, DEBOUNCE_MS));
});
documents.onDidSave((change) => {
    const uri = change.document.uri;
    const pending = pendingValidations.get(uri);
    if (pending) {
        clearTimeout(pending);
        pendingValidations.delete(uri);
    }
    scheduleValidation(change.document);
});
documents.onDidClose((event) => {
    const uri = event.document.uri;
    const pending = pendingValidations.get(uri);
    if (pending) {
        clearTimeout(pending);
        pendingValidations.delete(uri);
    }
    validationQueue.cancel(uri);
    validationSequencer.close(uri);
    connection.sendDiagnostics({ uri, diagnostics: [] });
});
/** Longest shutdown waits for aborted checks to unlink their temp files. */
const SHUTDOWN_DRAIN_MS = 2000;
connection.onShutdown(async () => {
    // The client is going away. Pending debounce timers would fire into a dead
    // session, and any CL.EXE child still running would be orphaned onto the
    // machine when the process exits. Draining lets the aborted checks unlink
    // their temp files, which hold the document text.
    for (const t of pendingValidations.values())
        clearTimeout(t);
    pendingValidations.clear();
    validationQueue.close();
    await Promise.race([
        validationQueue.drained(),
        new Promise((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_MS).unref()),
    ]);
});
/**
 * Extracts the file extension from a document URI using proper URI parsing,
 * falling back to `path.extname` on the raw URI only for non-file schemes.
 */
function getDocumentExtension(textDocument) {
    try {
        const parsed = vscode_uri_1.URI.parse(textDocument.uri);
        if (parsed.scheme === 'file') {
            return path.extname(parsed.fsPath).toLowerCase();
        }
    }
    catch {
        // Malformed URI — fall through to raw parse.
    }
    return path.extname(textDocument.uri).toLowerCase();
}
/** Message text for a thrown value, without the stack. */
function errorMessage(e) {
    return e instanceof Error ? e.message : String(e);
}
/**
 * Queues a syntax check for `textDocument`, superseding any check already
 * queued or running for the same URI. The sequence number is taken here, at
 * submission, so a result can be matched back to the request that produced it
 * even while it waits for a free slot.
 */
function scheduleValidation(textDocument) {
    const ext = getDocumentExtension(textDocument);
    if (!config_1.ALL_EXTENSIONS.includes(ext)) {
        return;
    }
    const uri = textDocument.uri;
    const handle = validationSequencer.begin(uri);
    const langId = config_1.CPP_EXTENSIONS.includes(ext)
        ? 'cpp'
        : textDocument.languageId === 'cpp'
            ? 'cpp'
            : 'c';
    const tempFile = (0, compiler_1.createTempSourcePath)(langId);
    // Content and temp path are snapshotted at submission so a queued check
    // never re-reads a document that has since changed.
    const content = textDocument.getText();
    validationQueue.submit(uri, (signal) => runValidation(uri, handle, content, tempFile, signal));
}
async function runValidation(uri, handle, content, tempFile, signal) {
    try {
        // A newer edit aborted this one while it sat in the queue.
        if (signal.aborted)
            return;
        const body = (0, compiler_1.stripByteOrderMark)(content);
        const byteLength = Buffer.byteLength(body, 'utf-8');
        if (byteLength > compiler_1.MAX_SOURCE_BYTES) {
            throw new compiler_1.DocumentTooLargeError(byteLength);
        }
        // The create is exclusive (`wx`): a path already taken in the shared temp
        // directory is an error rather than something to truncate, so a file or
        // symlink planted by another local user is never written through.
        fs.writeFileSync(tempFile, body, {
            encoding: 'utf-8',
            mode: 0o600,
            flag: 'wx',
        });
        const result = await (0, compiler_1.syntaxCheck)(config, tempFile, { signal });
        if (!handle.isCurrent())
            return;
        if (result.timedOut) {
            publishCheckFailure(uri, `CL.EXE did not finish within ${compiler_1.COMPILE_TIMEOUT_MS} ms and was killed; ` +
                `diagnostics for this file are unavailable, not empty.`);
            return;
        }
        const parsed = (0, diagnostics_1.parseDiagnostics)(result.rawOutput);
        connection.sendDiagnostics({ uri, diagnostics: (0, diagnostics_1.toLspDiagnostics)(parsed, tempFile) });
        if (result.truncated) {
            connection.console.error((0, logging_1.sanitizeForLog)(`CL.EXE output for ${uri} exceeded ${compiler_1.MAX_OUTPUT_BYTES} bytes; ` +
                'reported diagnostics are incomplete'));
        }
    }
    catch (e) {
        if (signal.aborted)
            return;
        if (!handle.isCurrent())
            return;
        if (e instanceof compiler_1.DocumentTooLargeError) {
            connection.sendDiagnostics({ uri, diagnostics: [tooLargeDiagnostic(e)] });
            return;
        }
        if (isCheckFailure(e)) {
            publishCheckFailure(uri, `Could not run the MSVC6 syntax check: ${errorMessage(e)}`);
            return;
        }
        // The scratch source never reached the compiler, so the failure is local
        // to this run and not evidence that the file is clean.
        connection.sendDiagnostics({
            uri,
            diagnostics: [(0, diagnostics_1.toFailureDiagnostic)(`Syntax check failed: ${errorMessage(e)}`)],
        });
        connection.console.error(`Validation error (${uri}): ${String(e)}`);
    }
    finally {
        try {
            fs.unlinkSync(tempFile);
        }
        catch {
            // Temp file may already be gone or was never created.
        }
    }
}
/** Tells the user why a buffer was not checked, instead of leaving it silently unvalidated. */
function tooLargeDiagnostic(error) {
    return {
        range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: diagnostics_1.LSP_UINT_MAX },
        },
        severity: node_1.DiagnosticSeverity.Information,
        code: 'msvc6-too-large',
        source: 'msvc6',
        message: `Not syntax-checked: ${error.message}`,
    };
}
documents.listen(connection);
connection.listen();
// Reclaim scratch sources from a previous run that was killed before its
// cleanup; without this every crash leaves one orphan behind forever.
try {
    (0, compiler_1.sweepStaleTempFiles)();
}
catch (e) {
    connection.console.error(`Stale temp sweep failed: ${String(e)}`);
}
/** Returns the current live config — typed `Readonly` to prevent accidental mutation. */
function getConfig() {
    return config;
}
//# sourceMappingURL=server.js.map