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
exports.validateDocument = validateDocument;
const node_1 = require("vscode-languageserver/node");
const vscode_languageserver_textdocument_1 = require("vscode-languageserver-textdocument");
const vscode_uri_1 = require("vscode-uri");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const config_1 = require("./config");
const compiler_1 = require("./compiler");
const diagnostics_1 = require("./diagnostics");
const validation_state_1 = require("./validation-state");
const connection = (0, node_1.createConnection)(node_1.ProposedFeatures.all);
exports.connection = connection;
const documents = new node_1.TextDocuments(vscode_languageserver_textdocument_1.TextDocument);
exports.documents = documents;
let config = (0, config_1.defaultConfig)();
let hasConfigurationCapability = false;
/** Decides which validation result per URI is allowed to reach the client. */
const validationSequencer = new validation_state_1.ValidationSequencer();
/** Per-URI abort controllers — cancels stale in-flight CL.EXE processes. */
const validationAbort = new Map();
/** Per-URI debounce timers for `onDidChangeContent`. */
const pendingValidations = new Map();
const DEBOUNCE_MS = 300;
connection.onInitialize((params) => {
    const capabilities = params.capabilities;
    hasConfigurationCapability = !!(capabilities.workspace && capabilities.workspace.configuration);
    if (params.initializationOptions) {
        config = { ...config, ...(0, config_1.validateConfig)(params.initializationOptions) };
    }
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
        void connection.client.register(node_1.DidChangeConfigurationNotification.type, undefined).then(undefined, (e) => connection.console.error(`Failed to register config change watcher: ${String(e)}`));
    }
});
connection.onDidChangeConfiguration((change) => {
    if (!change.settings?.msvc6)
        return;
    const validated = (0, config_1.validateConfig)(change.settings.msvc6);
    // Runtime config changes are untrusted — only accept non-executable fields.
    // Notably, additionalFlags is excluded: arbitrary CL.EXE flags could write files
    // or alter behavior beyond syntax checking. Set additionalFlags via initializationOptions only.
    const previous = config;
    config = {
        ...config,
        ...(validated.includePaths ? { includePaths: validated.includePaths } : {}),
        ...(validated.warnLevel !== undefined ? { warnLevel: validated.warnLevel } : {}),
    };
    // A client may re-send the settings it already holds. Re-checking every open
    // document would spawn one CL.EXE per document for no change in the inputs.
    if ((0, config_1.runtimeConfigEquals)(previous, config))
        return;
    for (const t of pendingValidations.values())
        clearTimeout(t);
    pendingValidations.clear();
    void (async () => {
        for (const d of documents.all()) {
            try {
                await validateDocument(d);
            }
            catch (e) {
                connection.console.error(`Validation error (config change): ${String(e)}`);
            }
        }
    })();
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
        validateDocument(doc).catch((e) => connection.console.error(`Validation error: ${String(e)}`));
    }, DEBOUNCE_MS));
});
documents.onDidSave((change) => {
    const uri = change.document.uri;
    const pending = pendingValidations.get(uri);
    if (pending) {
        clearTimeout(pending);
        pendingValidations.delete(uri);
    }
    validateDocument(change.document).catch((e) => connection.console.error(`Validation error: ${String(e)}`));
});
documents.onDidClose((event) => {
    const uri = event.document.uri;
    const pending = pendingValidations.get(uri);
    if (pending) {
        clearTimeout(pending);
        pendingValidations.delete(uri);
    }
    const abort = validationAbort.get(uri);
    if (abort) {
        abort.abort();
        validationAbort.delete(uri);
    }
    validationSequencer.close(uri);
    connection.sendDiagnostics({ uri, diagnostics: [] });
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
async function validateDocument(textDocument) {
    const ext = getDocumentExtension(textDocument);
    if (!config_1.ALL_EXTENSIONS.includes(ext)) {
        return;
    }
    const uri = textDocument.uri;
    const handle = validationSequencer.begin(uri);
    const previousAbort = validationAbort.get(uri);
    if (previousAbort)
        previousAbort.abort();
    const abort = new AbortController();
    validationAbort.set(uri, abort);
    const content = textDocument.getText();
    const langId = config_1.CPP_EXTENSIONS.includes(ext)
        ? 'cpp'
        : textDocument.languageId === 'cpp'
            ? 'cpp'
            : 'c';
    const tempFile = (0, compiler_1.createTempSourcePath)(langId);
    try {
        fs.writeFileSync(tempFile, (0, compiler_1.stripByteOrderMark)(content), {
            encoding: 'utf-8',
            mode: 0o600,
        });
        const result = await (0, compiler_1.syntaxCheck)(config, tempFile, { signal: abort.signal });
        if (!handle.isCurrent())
            return;
        const parsed = (0, diagnostics_1.parseDiagnostics)(result.rawOutput);
        const diagnostics = (0, diagnostics_1.toLspDiagnostics)(parsed, tempFile);
        connection.sendDiagnostics({ uri, diagnostics });
    }
    catch (e) {
        if (abort.signal.aborted)
            return;
        if (handle.isCurrent()) {
            connection.sendDiagnostics({ uri, diagnostics: [] });
        }
        throw e;
    }
    finally {
        if (validationAbort.get(uri) === abort) {
            validationAbort.delete(uri);
        }
        try {
            fs.unlinkSync(tempFile);
        }
        catch {
            // Temp file may already be gone or was never created.
        }
    }
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