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
import * as fs from 'fs';
import * as path from 'path';
import {
  Msvc6Config,
  defaultConfig,
  validateConfig,
  runtimeConfigEquals,
  ALL_EXTENSIONS,
  CPP_EXTENSIONS,
} from './config';
import {
  syntaxCheck,
  stripByteOrderMark,
  createTempSourcePath,
  sweepStaleTempFiles,
} from './compiler';
import { parseDiagnostics, toLspDiagnostics } from './diagnostics';
import { ValidationSequencer, ValidationHandle } from './validation-state';
import { TaskQueue } from './task-queue';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let config: Msvc6Config = defaultConfig();
let hasConfigurationCapability = false;

/** Decides which validation result per URI is allowed to reach the client. */
const validationSequencer = new ValidationSequencer();

/** Per-URI debounce timers for `onDidChangeContent`. */
const pendingValidations = new Map<string, ReturnType<typeof setTimeout>>();

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
const validationQueue = new TaskQueue(MAX_CONCURRENT_CHECKS);

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
      (e) => connection.console.error(`Failed to register config change watcher: ${String(e)}`),
    );
  }
});

connection.onDidChangeConfiguration((change) => {
  if (!change.settings?.msvc6) return;

  const validated = validateConfig(change.settings.msvc6);

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
  if (runtimeConfigEquals(previous, config)) return;

  for (const t of pendingValidations.values()) clearTimeout(t);
  pendingValidations.clear();

  // The queue bounds how many of these become CL.EXE children at once.
  for (const d of documents.all()) scheduleValidation(d);
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
      scheduleValidation(doc);
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

/**
 * Queues a syntax check for `textDocument`, superseding any check already
 * queued or running for the same URI. The sequence number is taken here, at
 * submission, so a result can be matched back to the request that produced it
 * even while it waits for a free slot.
 */
function scheduleValidation(textDocument: TextDocument): void {
  const ext = getDocumentExtension(textDocument);
  if (!ALL_EXTENSIONS.includes(ext)) {
    return;
  }

  const uri = textDocument.uri;
  const handle = validationSequencer.begin(uri);

  const langId = CPP_EXTENSIONS.includes(ext)
    ? 'cpp'
    : textDocument.languageId === 'cpp'
      ? 'cpp'
      : 'c';
  const tempFile = createTempSourcePath(langId);
  // Content and temp path are snapshotted at submission so a queued check
  // never re-reads a document that has since changed.
  const content = textDocument.getText();

  validationQueue.submit(uri, (signal) => runValidation(uri, handle, content, tempFile, signal));
}

async function runValidation(
  uri: string,
  handle: ValidationHandle,
  content: string,
  tempFile: string,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;

  try {
    fs.writeFileSync(tempFile, stripByteOrderMark(content), {
      encoding: 'utf-8',
      mode: 0o600,
    });

    const result = await syntaxCheck(config, tempFile, { signal });

    if (!handle.isCurrent()) return;

    const parsed = parseDiagnostics(result.rawOutput);
    const diagnostics = toLspDiagnostics(parsed, tempFile);

    connection.sendDiagnostics({ uri, diagnostics });
  } catch (e) {
    if (signal.aborted) return;
    if (handle.isCurrent()) {
      connection.sendDiagnostics({ uri, diagnostics: [] });
    }
    connection.console.error(`Validation error (${uri}): ${String(e)}`);
  } finally {
    try {
      fs.unlinkSync(tempFile);
    } catch {
      // Temp file may already be gone or was never created.
    }
  }
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

/** Returns the current live config — typed `Readonly` to prevent accidental mutation. */
function getConfig(): Readonly<Msvc6Config> {
  return config;
}

export { connection, documents, getConfig, scheduleValidation };
