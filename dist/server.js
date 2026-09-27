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
exports.scheduleValidation = scheduleValidation;
const node_1 = require("vscode-languageserver/node");
const vscode_languageserver_textdocument_1 = require("vscode-languageserver-textdocument");
const vscode_uri_1 = require("vscode-uri");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const config_1 = require("./config");
const compiler_1 = require("./compiler");
const tempfile_1 = require("./tempfile");
const diagnostics_1 = require("./diagnostics");
const logging_1 = require("./logging");
const validation_state_1 = require("./validation-state");
const debounce_1 = require("./debounce");
const task_queue_1 = require("./task-queue");
const cli_1 = require("./cli");
// Before anything else: --help, --version, and a bad flag must not reach the
// connection, which would abort with a stack trace on stdout-adjacent paths and
// exit 1 whatever the caller asked for.
(0, cli_1.runCli)();
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
/** Coalesces edit bursts into one check per document. */
const DEBOUNCE_MS = 300;
const validationDebouncer = (0, debounce_1.createDebouncer)(DEBOUNCE_MS);
/**
 * Validation tasks, one per document URI. A new task for a URI aborts the
 * previous one, so a superseded edit never reaches the compiler.
 */
const validationQueue = new task_queue_1.TaskQueue(compiler_1.MAX_CONCURRENT_CHECKS, (e) => logValidationError('Validation task rejected', e));
/**
 * Filesystem boundary for scratch sources. One store for the process, so a
 * check stages through the same object that later removes the file and the
 * write and the cleanup cannot drift apart.
 */
const scratchSources = (0, tempfile_1.createSystemTempFileStore)();
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
 * Reports an executable the effective configuration points at that is not on
 * this machine. A wrong `msvcBasePath` or `clPath` is otherwise invisible
 * until every open file fails its check with the same spawn error.
 *
 * A Wine executable given as a bare command name is left to `PATH`, so it is
 * not checked here.
 */
function warnAboutMissingExecutables(config) {
    const warnings = [];
    if (!fs.existsSync(config.clPath)) {
        warnings.push(`msvc600-lsp: clPath ${config.clPath} does not exist; every check will fail to spawn CL.EXE ` +
            '(set msvcBasePath or clPath in initializationOptions or MSVC600_*)');
    }
    if (config.useWine && path.basename(config.wineExecutable) !== config.wineExecutable) {
        if (!fs.existsSync(config.wineExecutable)) {
            warnings.push(`msvc600-lsp: wineExecutable ${config.wineExecutable} does not exist; every check will fail to spawn it`);
        }
    }
    return warnings;
}
/**
 * Whether `e` came from the compiler run rather than from staging the scratch
 * source. A rejection raised by `syntaxCheck` carries no errno, while the
 * filesystem failures that abort the write do.
 */
function isStagingFailure(e) {
    return e instanceof Error && 'code' in e;
}
/** Whether a filesystem error means the path was already gone. */
function isMissingFile(e) {
    return e instanceof Error && e.code === 'ENOENT';
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
    // Every value below except the numbers and the booleans comes from the
    // client, so the line is sanitized: an include path carrying a newline would
    // otherwise forge a second log line, and one carrying a bidi control would
    // reorder this one around it.
    connection.console.info((0, logging_1.sanitizeForLog)(`effective configuration: cl=${config.useWine ? `${config.wineExecutable} ${config.clPath}` : config.clPath}, ` +
        `includePaths=${JSON.stringify(config.includePaths)}, warnLevel=${config.warnLevel}, ` +
        `additionalFlags=${JSON.stringify(config.additionalFlags)}, useWine=${config.useWine}, ` +
        `outputEncoding=${config.outputEncoding}, checkTimeoutMs=${config.checkTimeoutMs}, ` +
        `maxOutputBytes=${config.maxOutputBytes}`));
    for (const line of warnAboutMissingExecutables(config)) {
        connection.console.warn((0, logging_1.sanitizeForLog)(line));
    }
    return {
        capabilities: {
            textDocumentSync: {
                openClose: true,
                // Incremental: a keystroke costs the client one range plus the inserted
                // text instead of the whole buffer. With Full sync every character typed
                // resends and re-parses the entire document, which is the largest single
                // source of traffic this server sees.
                change: node_1.TextDocumentSyncKind.Incremental,
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
    const update = (0, config_1.runtimeConfigUpdate)(validated);
    if (update.ignored.length > 0) {
        connection.console.warn((0, logging_1.sanitizeForLog)(`msvc600-lsp: didChangeConfiguration ignored ${update.ignored.join(', ')}: ` +
            'only includePaths and warnLevel can change while the server runs (set the rest via initializationOptions)'));
    }
    const previous = config;
    config = { ...config, ...update.values };
    // A client may re-send the settings it already holds. Re-checking every open
    // document would spawn one CL.EXE per document for no change in the inputs.
    if ((0, config_1.runtimeConfigEquals)(previous, config))
        return;
    // A client that repoints includePaths controls which headers every open
    // file is preprocessed against, so the change is recorded.
    connection.console.info((0, logging_1.sanitizeForLog)(`msvc6 configuration changed: includePaths=${JSON.stringify(config.includePaths)}, warnLevel=${config.warnLevel}`));
    validationDebouncer.cancelAll();
    // The queue bounds how many of these become CL.EXE children at once.
    for (const d of documents.all())
        scheduleValidation(d);
});
documents.onDidChangeContent((change) => {
    const uri = change.document.uri;
    validationDebouncer.schedule(uri, () => {
        const doc = documents.get(uri);
        if (!doc)
            return;
        scheduleValidation(doc);
    });
});
documents.onDidSave((change) => {
    validationDebouncer.cancel(change.document.uri);
    scheduleValidation(change.document);
});
documents.onDidClose((event) => {
    const uri = event.document.uri;
    validationDebouncer.cancel(uri);
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
    validationDebouncer.cancelAll();
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
/** Longest excerpt of CL.EXE output carried in a diagnostic message. */
const OUTPUT_EXCERPT_CHARS = 200;
/**
 * The first non-empty line of CL.EXE output, shortened to fit a diagnostic, so
 * a failure the parser could not turn into a diagnostic still says what the
 * tool complained about.
 */
function outputExcerpt(rawOutput) {
    const first = rawOutput.split(/\r?\n/).find((line) => line.trim() !== '')?.trim();
    if (first === undefined)
        return '(no output)';
    return first.length > OUTPUT_EXCERPT_CHARS
        ? `${first.slice(0, OUTPUT_EXCERPT_CHARS)}...`
        : first;
}
/**
 * Queues a syntax check for `textDocument`, superseding any check already
 * queued or running for the same URI. The sequence number is taken here, at
 * submission, so a result can be matched back to the request that produced it
 * even while it waits for a free slot.
 */
function scheduleValidation(textDocument) {
    const documentExt = getDocumentExtension(textDocument);
    if (!config_1.ALL_EXTENSIONS.includes(documentExt)) {
        return;
    }
    const uri = textDocument.uri;
    const handle = validationSequencer.begin(uri);
    const ext = config_1.CPP_EXTENSIONS.includes(documentExt) || textDocument.languageId === 'cpp'
        ? config_1.CPP_SCRATCH_EXTENSION
        : config_1.C_SCRATCH_EXTENSION;
    // Content is snapshotted at submission so a queued check never re-reads a
    // document that has since changed.
    const content = textDocument.getText();
    validationQueue.submit(uri, (signal) => runValidation(uri, handle, content, ext, signal));
}
async function runValidation(uri, handle, content, ext, signal) {
    let tempFile;
    try {
        // A newer edit aborted this one while it sat in the queue.
        if (signal.aborted)
            return;
        tempFile = scratchSources.write(content, ext);
        const result = await (0, compiler_1.syntaxCheck)(config, tempFile, { signal });
        if (!handle.isCurrent())
            return;
        if (result.timedOut) {
            publishCheckFailure(uri, `CL.EXE did not finish within ${config.checkTimeoutMs} ms and was killed; ` +
                `diagnostics for this file are unavailable, not empty.`);
            return;
        }
        const parsed = (0, diagnostics_1.parseDiagnostics)(result.rawOutput);
        const diagnostics = (0, diagnostics_1.toLspDiagnostics)(parsed, tempFile);
        // A run cut short leaves a prefix of the real diagnostics. Publishing that
        // prefix alone would tell the client the rest of the file is clean, so the
        // incompleteness travels with it.
        if (result.killedBySignal !== null) {
            connection.console.error((0, logging_1.sanitizeForLog)(`CL.EXE for ${uri} was terminated by ${result.killedBySignal}`));
            diagnostics.push((0, diagnostics_1.toFailureDiagnostic)(`CL.EXE was terminated by ${result.killedBySignal} before it finished; ` +
                'the diagnostics above are incomplete.'));
        }
        if (result.truncated) {
            connection.console.error((0, logging_1.sanitizeForLog)(`CL.EXE output for ${uri} exceeded the ${config.maxOutputBytes} byte cap; ` +
                'reported diagnostics are incomplete'));
            diagnostics.push((0, diagnostics_1.toFailureDiagnostic)(`CL.EXE output for this file exceeded the ${config.maxOutputBytes} byte cap ` +
                'and was truncated; the diagnostics above are incomplete.'));
        }
        // A non-zero exit with nothing to report for this file means the run
        // failed in a way the parser does not recognise (a bad command line, a
        // Wine error, a failure in an included header). Publishing the empty list
        // would tell the client the file is clean on the strength of a failed run.
        if (diagnostics.length === 0 && result.exitCode !== 0) {
            diagnostics.push((0, diagnostics_1.toFailureDiagnostic)(`CL.EXE exited with code ${result.exitCode} without reporting a diagnostic ` +
                `for this file. Its first line of output was: ${outputExcerpt(result.rawOutput)}`));
        }
        connection.sendDiagnostics({ uri, diagnostics });
    }
    catch (e) {
        if (signal.aborted)
            return;
        if (!handle.isCurrent())
            return;
        if (e instanceof tempfile_1.DocumentTooLargeError) {
            connection.sendDiagnostics({ uri, diagnostics: [tooLargeDiagnostic(e)] });
            return;
        }
        if (!isStagingFailure(e)) {
            publishCheckFailure(uri, `Could not run the MSVC6 syntax check: ${errorMessage(e)}`);
            return;
        }
        // The scratch source never reached the compiler, so the failure is local
        // to this run and not evidence that the file is clean.
        connection.sendDiagnostics({
            uri,
            diagnostics: [(0, diagnostics_1.toFailureDiagnostic)(`Syntax check failed: ${errorMessage(e)}`)],
        });
        logValidationError(`Validation error (${uri})`, e);
    }
    finally {
        if (tempFile !== undefined) {
            try {
                fs.unlinkSync(tempFile);
            }
            catch (e) {
                // ENOENT is the same end state as a successful unlink. Any other
                // failure leaves the unsaved buffer on disk, so the path is recorded
                // rather than dropped; the stale-file sweep reclaims it.
                if (!isMissingFile(e)) {
                    logValidationError(`Could not remove scratch source ${tempFile}`, e);
                }
            }
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
// cleanup; without this every crash leaves one orphan behind forever. The age
// covers the configured check timeout, so a sweep in a second server process
// never unlinks a source a check in the first one is still reading.
try {
    (0, tempfile_1.sweepStaleTempFiles)({ minAgeMs: (0, tempfile_1.staleTempMinAgeMs)(config.checkTimeoutMs) });
}
catch (e) {
    logValidationError('Stale temp sweep failed', e);
}
//# sourceMappingURL=server.js.map