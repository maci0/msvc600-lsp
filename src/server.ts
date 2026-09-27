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
import * as path from 'path';
import { Msvc6Config, defaultConfig, validateConfig, ALL_EXTENSIONS, CPP_EXTENSIONS } from './config';
import { syntaxCheck, createTempFile, removeTempFile } from './compiler';
import { parseDiagnostics, toLspDiagnostics } from './diagnostics';
import { ValidationTracker } from './validationTracker';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let config: Msvc6Config = defaultConfig();
let hasConfigurationCapability = false;

/** Issues the per-run staleness token and owns the abort controllers. */
const validations = new ValidationTracker();

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
  config = {
    ...config,
    ...(validated.includePaths ? { includePaths: validated.includePaths } : {}),
    ...(validated.warnLevel !== undefined ? { warnLevel: validated.warnLevel } : {}),
  };

  for (const t of pendingValidations.values()) clearTimeout(t);
  pendingValidations.clear();

  void (async () => {
    for (const d of documents.all()) {
      try {
        await validateDocument(d);
      } catch (e) {
        connection.console.error(`Validation error (config change): ${String(e)}`);
      }
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
      validateDocument(doc).catch((e) =>
        connection.console.error(`Validation error: ${String(e)}`),
      );
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
  validateDocument(change.document).catch((e) =>
    connection.console.error(`Validation error: ${String(e)}`),
  );
});

documents.onDidClose((event) => {
  const uri = event.document.uri;
  const pending = pendingValidations.get(uri);
  if (pending) {
    clearTimeout(pending);
    pendingValidations.delete(uri);
  }
  validations.close(uri);
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
  const { token, controller } = validations.begin(uri);
  const content = textDocument.getText();
  const langId = CPP_EXTENSIONS.includes(ext)
    ? 'cpp'
    : textDocument.languageId === 'cpp'
      ? 'cpp'
      : 'c';
  const tempFile = createTempFile(content, langId);

  try {
    const result = await syntaxCheck(config, tempFile, { signal: controller.signal });

    if (!validations.isCurrent(uri, token)) return;

    const parsed = parseDiagnostics(result.rawOutput);
    const diagnostics = toLspDiagnostics(parsed, tempFile);

    connection.sendDiagnostics({ uri, diagnostics });
  } catch (e) {
    if (controller.signal.aborted) return;
    if (validations.isCurrent(uri, token)) {
      connection.sendDiagnostics({ uri, diagnostics: [] });
    }
    throw e;
  } finally {
    validations.end(uri, controller);
    removeTempFile(tempFile);
  }
}

documents.listen(connection);
connection.listen();

/** Returns the current live config — typed `Readonly` to prevent accidental mutation. */
function getConfig(): Readonly<Msvc6Config> {
  return config;
}

export { connection, documents, getConfig, validateDocument };
