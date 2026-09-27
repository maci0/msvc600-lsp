import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';

/** Typed LSP JSON-RPC message for test assertions. */
interface LspMessage {
  jsonrpc: string;
  id?: number;
  method?: string;
  error?: { code: number; message: string };
  result?: Record<string, unknown> | null;
  params?: {
    uri?: string;
    message?: string;
    diagnostics?: Array<{
      source?: string;
      severity?: number;
      code?: string;
      range?: unknown;
      message?: string;
    }>;
  };
}

function isLspMessage(m: unknown): m is LspMessage {
  return typeof m === 'object' && m !== null && 'jsonrpc' in m;
}

const MSVC_ROOT = path.resolve(__dirname, '..', 'VC', 'VC98');

let serverProcess: ChildProcess | null = null;
let messageId = 0;

function nextId(): number {
  return ++messageId;
}

function encodeMessage(obj: unknown): string {
  const body = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

function sendRequest(proc: ChildProcess, method: string, params: unknown = {}): number {
  const id = nextId();
  proc.stdin?.write(encodeMessage({ jsonrpc: '2.0', id, method, params }));
  return id;
}

function sendNotification(proc: ChildProcess, method: string, params: unknown = {}): void {
  proc.stdin?.write(encodeMessage({ jsonrpc: '2.0', method, params }));
}

function collectMessages(
  proc: ChildProcess,
  isDone: (messages: unknown[]) => boolean,
  timeoutMs: number,
): Promise<unknown[]> {
  return new Promise((resolve) => {
    const messages: unknown[] = [];
    let buffer = Buffer.alloc(0);
    const finish = () => {
      clearTimeout(timer);
      proc.stdout?.removeListener('data', onData);
      resolve(messages);
    };
    const timer = setTimeout(finish, timeoutMs);

    const tryParse = () => {
      while (true) {
        const str = buffer.toString();
        const headerEnd = str.indexOf('\r\n\r\n');
        if (headerEnd === -1) break;

        const header = str.slice(0, headerEnd);
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        if (!match) break;

        const contentLength = parseInt(match[1], 10);
        const headerBytes = Buffer.byteLength(str.slice(0, headerEnd + 4));
        const totalNeeded = headerBytes + contentLength;

        if (buffer.length < totalNeeded) break;

        const body = buffer.slice(headerBytes, headerBytes + contentLength).toString();
        buffer = buffer.slice(headerBytes + contentLength);

        try {
          messages.push(JSON.parse(body));
        } catch {
          continue;
        }

        if (isDone(messages)) {
          finish();
          return;
        }
      }
    };

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      tryParse();
    };

    proc.stdout?.on('data', onData);
  });
}

/**
 * Resolves with the first message matching `match`, or undefined on timeout.
 * The server logs its effective configuration as a `window/logMessage`
 * notification during `initialize`, so tests wait for the message they care
 * about instead of assuming it arrives first.
 */
async function waitForMessage(
  proc: ChildProcess,
  match: (m: LspMessage) => boolean,
  timeoutMs = 15000,
): Promise<LspMessage | undefined> {
  const messages = await collectMessages(
    proc,
    (seen) => seen.some((m) => isLspMessage(m) && match(m)),
    timeoutMs,
  );
  return messages.find((m) => isLspMessage(m) && match(m)) as LspMessage | undefined;
}

function startServer(): ChildProcess {
  const serverPath = path.resolve(__dirname, '..', 'dist', 'server.js');
  return spawn('node', [serverPath, '--stdio'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, WINEDEBUG: '-all' },
  });
}

function killServer(proc: ChildProcess | null): void {
  if (proc && !proc.killed) {
    proc.kill('SIGTERM');
  }
}

/** Outcome of an `initialize` handshake, including the log lines it produced. */
interface InitializeOutcome {
  response: LspMessage | undefined;
  logs: string[];
}

async function initServer(
  proc: ChildProcess,
  extraOptions: Record<string, unknown> = {},
): Promise<InitializeOutcome> {
  const msvcRoot = MSVC_ROOT;
  const id = sendRequest(proc, 'initialize', {
    processId: process.pid,
    rootUri: null,
    capabilities: {},
    initializationOptions: {
      msvcBasePath: msvcRoot,
      clPath: path.join(msvcRoot, 'BIN', 'CL.EXE'),
      includePaths: ['C:\\msvc6\\include'],
      warnLevel: 4,
      additionalFlags: [],
      wineExecutable: 'wine',
      useWine: true,
      ...extraOptions,
    },
  });

  const messages = await collectMessages(
    proc,
    (seen) => seen.some((m) => isLspMessage(m) && m.id === id),
    10000,
  );
  sendNotification(proc, 'initialized', {});
  await new Promise((r) => setTimeout(r, 300));

  const lsp = messages.filter(isLspMessage);
  return {
    response: lsp.find((m) => m.id === id),
    logs: lsp
      .filter((m) => m.method === 'window/logMessage')
      .map((m) => m.params?.message ?? ''),
  };
}

describe('LSP Server Protocol', () => {
  beforeAll(async () => {
    const { execSync } = await import('child_process');
    execSync('bunx tsc', { cwd: path.resolve(__dirname, '..') });
  }, 30000);

  afterEach(() => {
    killServer(serverProcess);
    serverProcess = null;
  });

  it('responds to initialize request', async () => {
    serverProcess = startServer();
    const { response } = await initServer(serverProcess);

    expect(response).toBeDefined();
    expect(response?.error).toBeUndefined();
    expect(response.result).toBeDefined();
    const capabilities = response?.result?.capabilities as Record<string, unknown> | undefined;
    expect(capabilities).toBeDefined();
    expect(capabilities?.textDocumentSync).toBeDefined();
  });

  it('accepts initialized notification without crashing', async () => {
    serverProcess = startServer();
    await initServer(serverProcess);
    await new Promise((r) => setTimeout(r, 500));
    expect(serverProcess.killed).toBe(false);
  });

  it('logs the effective configuration during initialize', async () => {
    serverProcess = startServer();
    await initServer(serverProcess, { warnLevel: 2 });

    const { logs } = await initServer(serverProcess, { warnLevel: 2 });
    const startup = logs.join('\n');

    expect(startup).toContain('msvc600-lsp:');
    expect(startup).toContain('warnLevel=2');
    expect(startup).toContain('clPath=');
  });

  it('fails initialize on an unknown initialization option', async () => {
    serverProcess = startServer();
    const { response } = await initServer(serverProcess, { warnLevle: 2 });

    expect(response?.error).toBeDefined();
    expect(response?.error?.message).toContain('unknown option "warnLevle"');
    expect(response?.result).toBeUndefined();
  });

  it('fails initialize when CL.EXE is missing', async () => {
    serverProcess = startServer();
    const { response } = await initServer(serverProcess, {
      clPath: path.join(MSVC_ROOT, 'BIN', 'NOT_THERE.EXE'),
    });

    expect(response?.error).toBeDefined();
    expect(response?.error?.message).toContain('clPath does not exist');
  });

  it('responds to shutdown request', async () => {
    serverProcess = startServer();
    await initServer(serverProcess);

    const id = sendRequest(serverProcess, 'shutdown');
    const response = await waitForMessage(serverProcess, (m) => m.id === id, 5000);

    expect(response).toBeDefined();
    expect(response?.result).toBeNull();
  });

  it('publishes diagnostics for file with errors', async () => {
    serverProcess = startServer();
    await initServer(serverProcess);

    const errorContent =
      '#include <stdio.h>\nint main(void) {\n    int x = "hello";\n    return 0;\n}\n';

    sendNotification(serverProcess, 'textDocument/didOpen', {
      textDocument: {
        uri: 'file:///tmp/test_lsp_err.c',
        languageId: 'c',
        version: 1,
        text: errorContent,
      },
    });

    const diagNotif = await waitForMessage(
      serverProcess,
      (m) => m.method === 'textDocument/publishDiagnostics',
      20000,
    );

    expect(diagNotif).toBeDefined();
    expect(diagNotif!.params!.diagnostics!.length).toBeGreaterThan(0);
    expect(diagNotif!.params!.diagnostics![0].source).toBe('msvc6');
  });

  it('publishes empty diagnostics for valid file', async () => {
    serverProcess = startServer();
    await initServer(serverProcess);

    sendNotification(serverProcess, 'textDocument/didOpen', {
      textDocument: {
        uri: 'file:///tmp/test_lsp_ok.c',
        languageId: 'c',
        version: 1,
        text: 'int main(void) { return 0; }\n',
      },
    });

    const diagNotif = await waitForMessage(
      serverProcess,
      (m) => m.method === 'textDocument/publishDiagnostics',
      15000,
    );

    expect(diagNotif).toBeDefined();
    expect(diagNotif!.params!.diagnostics).toHaveLength(0);
  });

  it('clears diagnostics on didClose', async () => {
    serverProcess = startServer();
    await initServer(serverProcess);

    const uri = 'file:///tmp/test_close.c';
    sendNotification(serverProcess, 'textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: 'c',
        version: 1,
        text: 'int main(void) { return 0; }\n',
      },
    });

    await waitForMessage(
      serverProcess,
      (m) => m.method === 'textDocument/publishDiagnostics',
      15000,
    );

    sendNotification(serverProcess, 'textDocument/didClose', {
      textDocument: { uri },
    });

    const clearNotif = await waitForMessage(
      serverProcess,
      (m) =>
        m.method === 'textDocument/publishDiagnostics' && m.params?.diagnostics?.length === 0,
      5000,
    );

    expect(clearNotif).toBeDefined();
  });
});
