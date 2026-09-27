import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createConnection,
  DidChangeConfigurationNotification,
  type InitializeParams,
  type InitializeResult,
  ProposedFeatures,
  TextDocumentSyncKind,
  TextDocuments,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { syntaxCheck } from './compiler';
import {
  ALL_EXTENSIONS,
  CPP_EXTENSIONS,
  defaultConfig,
  type Msvc6Config,
  validateConfig,
} from './config';
import { parseDiagnostics, toLspDiagnostics } from './diagnostics';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

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
  hasConfigurationCapability = !!capabilities.workspace?.configuration;

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
    void connection.client
      .register(DidChangeConfigurationNotification.type, undefined)
      .then(undefined, (e) =>
        connection.console.error(`Failed to register config change watcher: ${String(e)}`),
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

  try {
    fs.writeFileSync(tempFile, content, { encoding: 'utf-8', mode: 0o600 });

    const result = await syntaxCheck(config, tempFile, { signal: abort.signal });

    if (validationSeq.get(uri) !== seq) return;

    const parsed = parseDiagnostics(result.rawOutput);
    const diagnostics = toLspDiagnostics(parsed, tempFile);

    connection.sendDiagnostics({ uri, diagnostics });
  } catch (e) {
    if (abort.signal.aborted) return;
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

documents.listen(connection);
connection.listen();

/** Returns the current live config — typed `Readonly` to prevent accidental mutation. */
function getConfig(): Readonly<Msvc6Config> {
  return config;
}

export { connection, documents, getConfig, validateDocument };
