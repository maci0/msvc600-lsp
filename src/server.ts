#!/usr/bin/env bun
import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  DidChangeConfigurationNotification,
  Diagnostic,
  DiagnosticSeverity,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import * as path from 'path';
import {
  Msvc6Config,
  defaultConfig,
  configFromEnv,
  formatIssues,
  mergeValidated,
  validateConfig,
  runtimeConfigEquals,
  ALL_EXTENSIONS,
  CPP_EXTENSIONS,
} from './config';
import {
  syntaxCheck,
  createTempSource,
  removeTempSourceFile,
  sweepStaleTempFiles,
  DocumentTooLargeError,
  MAX_CONCURRENT_CHECKS,
} from './compiler';
import { parseDiagnostics, toLspDiagnostics, toFailureDiagnostic, LSP_UINT_MAX } from './diagnostics';
import { sanitizeForLog } from './logging';
import { ValidationSequencer, ValidationHandle } from './validation-state';
import { TaskQueue } from './task-queue';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

// Precedence: defaults < MSVC600_* environment < initializationOptions. The
// environment layer is read here so a launch that cannot pass options still
// configures the server; initializationOptions override it in onInitialize.
const envConfig = configFromEnv();
let config: Msvc6Config = mergeValidated(defaultConfig(), envConfig);

/** Rejected environment values, logged once the connection can carry messages. */
const startupIssues = formatIssues('MSVC600_*', envConfig.issues);

let hasConfigurationCapability = false;

/** Decides which validation result per URI is allowed to reach the client. */
const validationSequencer = new ValidationSequencer();

/** Per-URI debounce timers for `onDidChangeContent`. */
const pendingValidations = new Map<string, NodeJS.Timeout>();

const DEBOUNCE_MS = 300;

/** The only config fields a `didChangeConfiguration` notification may replace. */
const RUNTIME_SETTABLE_FIELDS: readonly string[] = ['includePaths', 'warnLevel'];

/** Drops a document's pending debounce timer, if one is still waiting. */
function clearPendingValidation(uri: string): void {
  const pending = pendingValidations.get(uri);
  if (!pending) return;
  clearTimeout(pending);
  pendingValidations.delete(uri);
}

/**
 * Validation tasks, one per document URI. A new task for a URI aborts the
 * previous one, so a superseded edit never reaches the compiler. The queue's
 * width is the process-wide {@link MAX_CONCURRENT_CHECKS}: it bounds how many
 * entries reach `syntaxCheck` at once, and the compiler holds the same ceiling
 * for callers that never enter the queue.
 */
const validationQueue = new TaskQueue(MAX_CONCURRENT_CHECKS);

/** Diagnostic code used for failures of the check itself, not of the source file. */
const TOOL_ERROR_CODE = 'msvc600-check-failed';

/** Range covering a whole first line, where tool-failure diagnostics are anchored. */
const DOCUMENT_START = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 0 },
};

/** Reports a caught error to the client log with control characters removed. */
function logValidationError(context: string, e: unknown): void {
  connection.console.error(sanitizeForLog(`${context}: ${String(e)}`));
}

/**
 * Whether `e` came from the compiler run rather than from staging the scratch
 * source. A rejection raised by `syntaxCheck` carries no errno, while the
 * filesystem failures that abort the write do.
 */
function isCheckFailure(e: unknown): boolean {
  return !(e instanceof Error && 'code' in e);
}

/**
 * Reports a failure of the syntax check as a diagnostic on the document.
 *
 * A check that never completed says nothing about the file, so publishing an
 * empty diagnostic list would read as "no problems found" and silently drop
 * whatever the user was already seeing.
 */
function publishCheckFailure(uri: string, message: string): void {
  connection.console.error(sanitizeForLog(`MSVC6 syntax check failed for ${uri}: ${message}`));
  connection.sendDiagnostics({
    uri,
    diagnostics: [
      {
        range: DOCUMENT_START,
        severity: DiagnosticSeverity.Error,
        code: TOOL_ERROR_CODE,
        source: 'msvc6',
        message,
      },
    ],
  });
}

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const capabilities = params.capabilities;
  hasConfigurationCapability = !!(
    capabilities.workspace && capabilities.workspace.configuration
  );

  for (const line of startupIssues) {
    connection.console.warn(line);
  }

  if (params.initializationOptions) {
    const validated = validateConfig(params.initializationOptions);
    config = mergeValidated(config, validated);
    for (const line of formatIssues('initializationOptions', validated.issues)) {
      connection.console.warn(line);
    }
  }

  connection.console.info(
    `effective configuration: cl=${config.useWine ? `${config.wineExecutable} ${config.clPath}` : config.clPath}, ` +
      `includePaths=${JSON.stringify(config.includePaths)}, warnLevel=${config.warnLevel}, ` +
      `additionalFlags=${JSON.stringify(config.additionalFlags)}, useWine=${config.useWine}, ` +
      `outputEncoding=${config.outputEncoding}, checkTimeoutMs=${config.checkTimeoutMs}, ` +
      `maxOutputBytes=${config.maxOutputBytes}`,
  );

  return {
    capabilities: {
      textDocumentSync: {
        openClose: true,
        change: TextDocumentSyncKind.Full,
        save: { includeText: false },
      },
    },
  };
});

connection.onInitialized(() => {
  if (hasConfigurationCapability) {
    void connection.client.register(DidChangeConfigurationNotification.type, undefined).then(
      undefined,
      (e) => logValidationError('Failed to register config change watcher', e),
    );
  }
});

connection.onDidChangeConfiguration((change) => {
  if (!change.settings?.msvc6) return;

  const validated = validateConfig(change.settings.msvc6);
  for (const line of formatIssues('didChangeConfiguration', validated.issues)) {
    connection.console.warn(line);
  }

  // Runtime config changes are untrusted — only accept non-executable fields.
  // Notably, additionalFlags is excluded: arbitrary CL.EXE flags could write files
  // or alter behavior beyond syntax checking. Set additionalFlags via initializationOptions only.
  // A field that validated but is not settable at runtime is named here, so the
  // user is not left believing the value they sent took effect.
  for (const key of Object.keys(validated.values)) {
    if (!RUNTIME_SETTABLE_FIELDS.includes(key)) {
      connection.console.warn(
        sanitizeForLog(
          `msvc600-lsp: didChangeConfiguration ignored ${key}: only ` +
            `${RUNTIME_SETTABLE_FIELDS.join(' and ')} can change while the server runs`,
        ),
      );
    }
  }

  const previous = config;
  config = {
    ...config,
    ...(validated.values.includePaths ? { includePaths: validated.values.includePaths } : {}),
    ...(validated.values.warnLevel !== undefined ? { warnLevel: validated.values.warnLevel } : {}),
  };

  // A client may re-send the settings it already holds. Re-checking every open
  // document would spawn one CL.EXE per document for no change in the inputs.
  if (runtimeConfigEquals(previous, config)) return;

  // A client that repoints includePaths controls which headers every open
  // file is preprocessed against, so the change is recorded.
  connection.console.info(
    sanitizeForLog(
      `msvc6 configuration changed: includePaths=${JSON.stringify(config.includePaths)}, warnLevel=${config.warnLevel}`,
    ),
  );

  for (const t of pendingValidations.values()) clearTimeout(t);
  pendingValidations.clear();

  // The queue bounds how many of these become CL.EXE children at once.
  for (const d of documents.all()) scheduleValidation(d);
});

documents.onDidChangeContent((change) => {
  const uri = change.document.uri;
  clearPendingValidation(uri);
  pendingValidations.set(
    uri,
    setTimeout(() => {
      pendingValidations.delete(uri);
      const doc = documents.get(uri);
      if (!doc) return;
      scheduleValidation(doc);
    }, DEBOUNCE_MS),
  );
});

documents.onDidSave((change) => {
  clearPendingValidation(change.document.uri);
  scheduleValidation(change.document);
});

documents.onDidClose((event) => {
  const uri = event.document.uri;
  clearPendingValidation(uri);
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
  for (const t of pendingValidations.values()) clearTimeout(t);
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
function getDocumentExtension(textDocument: TextDocument): string {
  try {
    const parsed = URI.parse(textDocument.uri);
    if (parsed.scheme === 'file') {
      return path.extname(parsed.fsPath).toLowerCase();
    }
  } catch {
    // Malformed URI — fall through to raw parse.
  }
  return path.extname(textDocument.uri).toLowerCase();
}

/** Message text for a thrown value, without the stack. */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Queues a syntax check for `textDocument`, superseding any check already
 * queued or running for the same URI. The sequence number is taken here, at
 * submission, so a result can be matched back to the request that produced it
 * even while it waits for a free slot.
 */
function scheduleValidation(textDocument: TextDocument): void {
  const documentExt = getDocumentExtension(textDocument);
  if (!ALL_EXTENSIONS.includes(documentExt)) {
    return;
  }

  const uri = textDocument.uri;
  const handle = validationSequencer.begin(uri);

  const ext =
    CPP_EXTENSIONS.includes(documentExt) || textDocument.languageId === 'cpp' ? '.cpp' : '.c';

  // Content is snapshotted at submission so a queued check never re-reads a
  // document that has since changed.
  const content = textDocument.getText();

  validationQueue.submit(uri, (signal) => runValidation(uri, handle, content, ext, signal));
}

async function runValidation(
  uri: string,
  handle: ValidationHandle,
  content: string,
  ext: string,
  signal: AbortSignal,
): Promise<void> {
  let tempFile: string | undefined;
  try {
    // A newer edit aborted this one while it sat in the queue.
    if (signal.aborted) return;

    tempFile = createTempSource(content, ext);

    const result = await syntaxCheck(config, tempFile, { signal });

    if (!handle.isCurrent()) return;

    if (result.timedOut) {
      publishCheckFailure(
        uri,
        `CL.EXE did not finish within ${config.checkTimeoutMs} ms and was killed; ` +
          `diagnostics for this file are unavailable, not empty.`,
      );
      return;
    }

    const parsed = parseDiagnostics(result.rawOutput);
    connection.sendDiagnostics({ uri, diagnostics: toLspDiagnostics(parsed, tempFile) });

    if (result.truncated) {
      connection.console.error(
        sanitizeForLog(
          `CL.EXE output for ${uri} exceeded ${config.maxOutputBytes} bytes; ` +
            'reported diagnostics are incomplete',
        ),
      );
    }
  } catch (e) {
    if (signal.aborted) return;
    if (!handle.isCurrent()) return;

    if (e instanceof DocumentTooLargeError) {
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
      diagnostics: [toFailureDiagnostic(`Syntax check failed: ${errorMessage(e)}`)],
    });
    connection.console.error(`Validation error (${uri}): ${String(e)}`);
  } finally {
    if (tempFile !== undefined) {
      removeTempSourceFile(tempFile);
    }
  }
}

/** Tells the user why a buffer was not checked, instead of leaving it silently unvalidated. */
function tooLargeDiagnostic(error: DocumentTooLargeError): Diagnostic {
  return {
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: LSP_UINT_MAX },
    },
    severity: DiagnosticSeverity.Information,
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
  sweepStaleTempFiles();
} catch (e) {
  connection.console.error(`Stale temp sweep failed: ${String(e)}`);
}

export { connection, documents, scheduleValidation };
