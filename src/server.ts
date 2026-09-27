import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  DidChangeConfigurationNotification,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Msvc6Config, defaultConfig, validateConfig, ALL_EXTENSIONS, CPP_EXTENSIONS } from './config';
import { CompilerSpawnError, syntaxCheck, stripByteOrderMark } from './compiler';
import { parseDiagnostics, toLspDiagnostics } from './diagnostics';
import {
  SLOW_VALIDATION_MS,
  STATUS_METHOD,
  ServerStatus,
  logError,
  logInfo,
  logWarn,
  setLogSink,
  validationStats,
} from './observability';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

// Editors render window/logMessage in their own output channel; routing every
// line through one sink keeps the format identical to what a raw stdio capture
// sees.
setLogSink((level, line) => {
  if (level === 'error') connection.console.error(line);
  else if (level === 'warn') connection.console.warn(line);
  else connection.console.info(line);
});

let config: Msvc6Config = defaultConfig();
let hasConfigurationCapability = false;

/** Per-URI sequence counter — used to discard stale validation results. */
const validationSeq = new Map<string, number>();

/** Per-URI abort controllers — cancels stale in-flight CL.EXE processes. */
const validationAbort = new Map<string, AbortController>();

/** Per-URI debounce timers for `onDidChangeContent`. */
const pendingValidations = new Map<string, ReturnType<typeof setTimeout>>();

const DEBOUNCE_MS = 300;

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const capabilities = params.capabilities;
  hasConfigurationCapability = !!(
    capabilities.workspace && capabilities.workspace.configuration
  );

  if (params.initializationOptions) {
    config = { ...config, ...validateConfig(params.initializationOptions) };
  }

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
      (e) => logError('config watcher registration failed', { error: String(e) }),
    );
  }
  logInfo('server initialized', {
    useWine: config.useWine,
    clPath: config.clPath,
    warnLevel: config.warnLevel,
  });
});

connection.onDidChangeConfiguration((change) => {
  if (!change.settings?.msvc6) return;

  const validated = validateConfig(change.settings.msvc6);

  // Runtime config changes are untrusted — only accept non-executable fields.
  // Notably, additionalFlags is excluded: arbitrary CL.EXE flags could write files
  // or alter behavior beyond syntax checking. Set additionalFlags via initializationOptions only.
  config = {
    ...config,
    ...(validated.includePaths ? { includePaths: validated.includePaths } : {}),
    ...(validated.warnLevel !== undefined ? { warnLevel: validated.warnLevel } : {}),
  };

  for (const t of pendingValidations.values()) clearTimeout(t);
  pendingValidations.clear();

  void (async () => {
    for (const d of documents.all()) {
      await validateDocument(d).catch(ignoreRejection);
    }
  })();
});

documents.onDidChangeContent((change) => {
  const uri = change.document.uri;
  const existing = pendingValidations.get(uri);
  if (existing) clearTimeout(existing);
  pendingValidations.set(
    uri,
    setTimeout(() => {
      pendingValidations.delete(uri);
      const doc = documents.get(uri);
      if (!doc) return;
      validateDocument(doc).catch(ignoreRejection);
    }, DEBOUNCE_MS),
  );
});

documents.onDidSave((change) => {
  const uri = change.document.uri;
  const pending = pendingValidations.get(uri);
  if (pending) {
    clearTimeout(pending);
    pendingValidations.delete(uri);
  }
  validateDocument(change.document).catch(ignoreRejection);
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
  validationSeq.delete(uri);
  connection.sendDiagnostics({ uri, diagnostics: [] });
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

async function validateDocument(textDocument: TextDocument): Promise<void> {
  const ext = getDocumentExtension(textDocument);
  if (!ALL_EXTENSIONS.includes(ext)) {
    return;
  }

  const uri = textDocument.uri;
  const prev = validationSeq.get(uri) ?? 0;
  const seq = prev >= Number.MAX_SAFE_INTEGER ? 1 : prev + 1;
  validationSeq.set(uri, seq);

  const previousAbort = validationAbort.get(uri);
  if (previousAbort) previousAbort.abort();
  const abort = new AbortController();
  validationAbort.set(uri, abort);

  const content = textDocument.getText();
  const langId = CPP_EXTENSIONS.includes(ext)
    ? 'cpp'
    : textDocument.languageId === 'cpp'
      ? 'cpp'
      : 'c';
  const tempExt = langId === 'cpp' ? '.cpp' : '.c';
  const tempFile = path.join(os.tmpdir(), `msvc6_lsp_${randomUUID()}${tempExt}`);

  const startedAt = Date.now();
  validationStats.recordStart();

  try {
    fs.writeFileSync(tempFile, stripByteOrderMark(content), {
      encoding: 'utf-8',
      mode: 0o600,
    });

    const result = await syntaxCheck(config, tempFile, { signal: abort.signal });
    const durationMs = Date.now() - startedAt;

    if (validationSeq.get(uri) !== seq) return;

    if (result.timedOut) {
      validationStats.recordFailure('timeout', 'CL.EXE exceeded the timeout and was killed');
      logError('validation timed out', {
        uri,
        durationMs,
        clPath: config.clPath,
        wineExecutable: config.useWine ? config.wineExecutable : undefined,
      });
      connection.sendDiagnostics({ uri, diagnostics: [] });
      return;
    }

    const parsed = parseDiagnostics(result.rawOutput);
    const diagnostics = toLspDiagnostics(parsed, tempFile);

    validationStats.recordCompletion(durationMs, result.truncated);

    if (result.truncated) {
      logWarn('validation output truncated, diagnostics are incomplete', {
        uri,
        durationMs,
        diagnostics: diagnostics.length,
      });
    } else if (durationMs >= SLOW_VALIDATION_MS) {
      logInfo('slow validation', { uri, durationMs, diagnostics: diagnostics.length });
    }

    connection.sendDiagnostics({ uri, diagnostics });
  } catch (e) {
    if (abort.signal.aborted) {
      validationStats.recordAbort();
      return;
    }
    const durationMs = Date.now() - startedAt;
    recordFailure(uri, e, durationMs);
    if (validationSeq.get(uri) === seq) {
      connection.sendDiagnostics({ uri, diagnostics: [] });
    }
    throw e;
  } finally {
    if (validationAbort.get(uri) === abort) {
      validationAbort.delete(uri);
    }
    try {
      fs.unlinkSync(tempFile);
    } catch {
      // Temp file may already be gone or was never created.
    }
  }
}

/**
 * Records and logs why a check produced no diagnostics, naming the dependency
 * that failed so a Wine or CL.EXE problem is distinguishable from a compiler
 * error in the buffer.
 */
function recordFailure(uri: string, error: unknown, durationMs: number): void {
  const fields = {
    uri,
    durationMs,
    error: error instanceof Error ? error.message : String(error),
  };

  if (error instanceof CompilerSpawnError) {
    validationStats.recordFailure('spawn', error.message);
    logError('compiler could not be started', {
      ...fields,
      code: error.code,
      executable: error.executable,
    });
    return;
  }

  validationStats.recordFailure('error', fields.error);
  logError('validation failed', fields);
}

/**
 * Attaches to a rejected `validateDocument` so the failure is not reported as
 * an unhandled rejection. {@link recordFailure} already logged and counted it.
 */
function ignoreRejection(): void {}

documents.listen(connection);
connection.listen();

connection.onRequest(STATUS_METHOD, (): ServerStatus => {
  const stats = validationStats.snapshot();
  return {
    uptimeMs: stats.uptimeMs,
    validations: {
      started: stats.started,
      completed: stats.completed,
      failed: stats.failed,
      aborted: stats.aborted,
      timedOut: stats.timedOut,
      truncated: stats.truncated,
      totalDurationMs: stats.totalDurationMs,
      maxDurationMs: stats.maxDurationMs,
      lastDurationMs: stats.lastDurationMs,
      lastSuccessAt: stats.lastSuccessAt,
      lastFailureAt: stats.lastFailureAt,
      lastFailure: stats.lastFailure,
    },
    compiler: {
      clPath: config.clPath,
      wineExecutable: config.wineExecutable,
      useWine: config.useWine,
    },
  };
});

/**
 * A rejection or throw outside any request handler would otherwise be silent
 * apart from the runtime's own stderr output, which the editor does not show.
 */
process.on('unhandledRejection', (reason) => {
  logError('unhandled rejection', { error: String(reason) });
});

/** Returns the current live config — typed `Readonly` to prevent accidental mutation. */
function getConfig(): Readonly<Msvc6Config> {
  return config;
}

export { connection, documents, getConfig, validateDocument };
