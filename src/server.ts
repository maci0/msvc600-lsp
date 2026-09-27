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
import * as fs from 'fs';
import * as path from 'path';
import {
  Msvc6Config,
  defaultConfig,
  configFromEnv,
  formatIssues,
  mergeValidated,
  validateConfig,
  runtimeConfigEquals,
  runtimeConfigUpdate,
  ALL_EXTENSIONS,
  CPP_EXTENSIONS,
  C_SCRATCH_EXTENSION,
  CPP_SCRATCH_EXTENSION,
} from './config';
import {
  syntaxCheck,
  MAX_CONCURRENT_CHECKS,
} from './compiler';
import {
  createSystemTempFileStore,
  staleTempMinAgeMs,
  sweepStaleTempFiles,
  DocumentTooLargeError,
} from './tempfile';
import { parseDiagnostics, toLspDiagnostics, toFailureDiagnostic, LSP_UINT_MAX } from './diagnostics';
import { sanitizeForLog } from './logging';
import { ValidationSequencer, ValidationHandle } from './validation-state';
import { createDebouncer } from './debounce';
import { TaskQueue } from './task-queue';
import { runCli } from './cli';

// Before anything else: --help, --version, and a bad flag must not reach the
// connection, which would abort with a stack trace on stdout-adjacent paths and
// exit 1 whatever the caller asked for.
runCli();

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

/** Coalesces edit bursts into one check per document. */
const DEBOUNCE_MS = 300;

const validationDebouncer = createDebouncer(DEBOUNCE_MS);

/**
 * Validation tasks, one per document URI. A new task for a URI aborts the
 * previous one, so a superseded edit never reaches the compiler.
 */
const validationQueue = new TaskQueue(MAX_CONCURRENT_CHECKS, (e) =>
  logValidationError('Validation task rejected', e),
);

/**
 * Filesystem boundary for scratch sources. One store for the process, so a
 * check stages through the same object that later removes the file and the
 * write and the cleanup cannot drift apart.
 */
const scratchSources = createSystemTempFileStore();

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
 * Reports an executable the effective configuration points at that is not on
 * this machine. A wrong `msvcBasePath` or `clPath` is otherwise invisible
 * until every open file fails its check with the same spawn error.
 *
 * A Wine executable given as a bare command name is left to `PATH`, so it is
 * not checked here.
 */
function warnAboutMissingExecutables(config: Msvc6Config): string[] {
  const warnings: string[] = [];

  if (!fs.existsSync(config.clPath)) {
    warnings.push(
      `msvc600-lsp: clPath ${config.clPath} does not exist; every check will fail to spawn CL.EXE ` +
        '(set msvcBasePath or clPath in initializationOptions or MSVC600_*)',
    );
  }

  if (config.useWine && path.basename(config.wineExecutable) !== config.wineExecutable) {
    if (!fs.existsSync(config.wineExecutable)) {
      warnings.push(
        `msvc600-lsp: wineExecutable ${config.wineExecutable} does not exist; every check will fail to spawn it`,
      );
    }
  }

  return warnings;
}

/**
 * Whether `e` came from the compiler run rather than from staging the scratch
 * source. A rejection raised by `syntaxCheck` carries no errno, while the
 * filesystem failures that abort the write do.
 */
function isStagingFailure(e: unknown): boolean {
  return e instanceof Error && 'code' in e;
}

/** Whether a filesystem error means the path was already gone. */
function isMissingFile(e: unknown): boolean {
  return e instanceof Error && (e as NodeJS.ErrnoException).code === 'ENOENT';
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

  for (const line of warnAboutMissingExecutables(config)) {
    connection.console.warn(sanitizeForLog(line));
  }

  return {
    capabilities: {
      textDocumentSync: {
        openClose: true,
        // Incremental: a keystroke costs the client one range plus the inserted
        // text instead of the whole buffer. With Full sync every character typed
        // resends and re-parses the entire document, which is the largest single
        // source of traffic this server sees.
        change: TextDocumentSyncKind.Incremental,
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
  const update = runtimeConfigUpdate(validated);
  if (update.ignored.length > 0) {
    connection.console.warn(
      sanitizeForLog(
        `msvc600-lsp: didChangeConfiguration ignored ${update.ignored.join(', ')}: ` +
          'only includePaths and warnLevel can change while the server runs (set the rest via initializationOptions)',
      ),
    );
  }

  const previous = config;
  config = { ...config, ...update.values };

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

  validationDebouncer.cancelAll();

  // The queue bounds how many of these become CL.EXE children at once.
  for (const d of documents.all()) scheduleValidation(d);
});

documents.onDidChangeContent((change) => {
  const uri = change.document.uri;
  validationDebouncer.schedule(uri, () => {
    const doc = documents.get(uri);
    if (!doc) return;
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

/** Longest excerpt of CL.EXE output carried in a diagnostic message. */
const OUTPUT_EXCERPT_CHARS = 200;

/**
 * The first non-empty line of CL.EXE output, shortened to fit a diagnostic, so
 * a failure the parser could not turn into a diagnostic still says what the
 * tool complained about.
 */
function outputExcerpt(rawOutput: string): string {
  const first = rawOutput.split(/\r?\n/).find((line) => line.trim() !== '')?.trim();
  if (first === undefined) return '(no output)';
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
function scheduleValidation(textDocument: TextDocument): void {
  const documentExt = getDocumentExtension(textDocument);
  if (!ALL_EXTENSIONS.includes(documentExt)) {
    return;
  }

  const uri = textDocument.uri;
  const handle = validationSequencer.begin(uri);

  const ext =
    CPP_EXTENSIONS.includes(documentExt) || textDocument.languageId === 'cpp'
      ? CPP_SCRATCH_EXTENSION
      : C_SCRATCH_EXTENSION;

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

    tempFile = scratchSources.write(content, ext);

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
    const diagnostics = toLspDiagnostics(parsed, tempFile);

    // A run cut short leaves a prefix of the real diagnostics. Publishing that
    // prefix alone would tell the client the rest of the file is clean, so the
    // incompleteness travels with it.
    if (result.killedBySignal !== null) {
      connection.console.error(
        sanitizeForLog(`CL.EXE for ${uri} was terminated by ${result.killedBySignal}`),
      );
      diagnostics.push(
        toFailureDiagnostic(
          `CL.EXE was terminated by ${result.killedBySignal} before it finished; ` +
            'the diagnostics above are incomplete.',
        ),
      );
    }

    if (result.truncated) {
      connection.console.error(
        sanitizeForLog(
          `CL.EXE output for ${uri} exceeded the ${config.maxOutputBytes} byte cap; ` +
            'reported diagnostics are incomplete',
        ),
      );
      diagnostics.push(
        toFailureDiagnostic(
          `CL.EXE output for this file exceeded the ${config.maxOutputBytes} byte cap ` +
            'and was truncated; the diagnostics above are incomplete.',
        ),
      );
    }

    // A non-zero exit with nothing to report for this file means the run
    // failed in a way the parser does not recognise (a bad command line, a
    // Wine error, a failure in an included header). Publishing the empty list
    // would tell the client the file is clean on the strength of a failed run.
    if (diagnostics.length === 0 && result.exitCode !== 0) {
      diagnostics.push(
        toFailureDiagnostic(
          `CL.EXE exited with code ${result.exitCode} without reporting a diagnostic ` +
            `for this file. Its first line of output was: ${outputExcerpt(result.rawOutput)}`,
        ),
      );
    }

    connection.sendDiagnostics({ uri, diagnostics });
  } catch (e) {
    if (signal.aborted) return;
    if (!handle.isCurrent()) return;

    if (e instanceof DocumentTooLargeError) {
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
      diagnostics: [toFailureDiagnostic(`Syntax check failed: ${errorMessage(e)}`)],
    });
    logValidationError(`Validation error (${uri})`, e);
  } finally {
    if (tempFile !== undefined) {
      try {
        fs.unlinkSync(tempFile);
      } catch (e) {
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
// cleanup; without this every crash leaves one orphan behind forever. The age
// covers the configured check timeout, so a sweep in a second server process
// never unlinks a source a check in the first one is still reading.
try {
  sweepStaleTempFiles({ minAgeMs: staleTempMinAgeMs(config.checkTimeoutMs) });
} catch (e) {
  logValidationError('Stale temp sweep failed', e);
}

export { connection, documents, scheduleValidation };
