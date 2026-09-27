import { type ChildProcess, spawn } from 'node:child_process';
import * as path from 'node:path';
import { afterEach, beforeAll, expect, it } from 'vitest';
import { describeWithServer } from './helpers/toolchain';

/** Typed LSP JSON-RPC message for test assertions. */
interface LspMessage {
  jsonrpc: string;
  id?: number;
  method?: string;
  result?: Record<string, unknown> | null;
  params?: {
    uri?: string;
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

function waitForMessages(proc: ChildProcess, count: number, timeoutMs = 15000): Promise<unknown[]> {
  return new Promise((resolve) => {
    const messages: unknown[] = [];
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      proc.stdout?.removeListener('data', onData);
      resolve(messages);
    }, timeoutMs);

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

        if (messages.length >= count) {
          clearTimeout(timer);
          proc.stdout?.removeListener('data', onData);
          resolve(messages);
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

async function initServer(
  proc: ChildProcess,
  extraOptions: Record<string, unknown> = {},
): Promise<unknown> {
  const msvcRoot = path.resolve(__dirname, '..', 'VC', 'VC98');
  sendRequest(proc, 'initialize', {
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

  const msgs = await waitForMessages(proc, 1, 10000);
  sendNotification(proc, 'initialized', {});
  await new Promise((r) => setTimeout(r, 300));
  return msgs[0];
}

describeWithServer('LSP Server Protocol', () => {
  beforeAll(async () => {
    const { execSync } = await import('node:child_process');
    execSync('bunx tsc', { cwd: path.resolve(__dirname, '..') });
  }, 30000);

  afterEach(() => {
    killServer(serverProcess);
    serverProcess = null;
  });

  it('responds to initialize request', async () => {
    serverProcess = startServer();
    const raw = await initServer(serverProcess);
    expect(isLspMessage(raw)).toBe(true);
    const response = raw as LspMessage;

    expect(response).toBeDefined();
    expect(response.result).toBeDefined();
    const capabilities = response.result?.capabilities as Record<string, unknown> | undefined;
    expect(capabilities).toBeDefined();
    expect(capabilities?.textDocumentSync).toBeDefined();
  });

  it('accepts initialized notification without crashing', async () => {
    serverProcess = startServer();
    await initServer(serverProcess);
    await new Promise((r) => setTimeout(r, 500));
    expect(serverProcess.killed).toBe(false);
  });

  it('responds to shutdown request', async () => {
    serverProcess = startServer();
    await initServer(serverProcess);

    sendRequest(serverProcess, 'shutdown');
    const messages = await waitForMessages(serverProcess, 1, 5000);

    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(isLspMessage(messages[0])).toBe(true);
    const response = messages[0] as LspMessage;
    expect(response.id).toBeDefined();
    expect(response.result).toBeNull();
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

    const messages = await waitForMessages(serverProcess, 1, 20000);
    const diagNotif = messages.find(
      (m) => isLspMessage(m) && m.method === 'textDocument/publishDiagnostics',
    ) as LspMessage | undefined;

    expect(diagNotif).toBeDefined();
    const diagnostics = diagNotif?.params?.diagnostics;
    expect(diagnostics?.length).toBeGreaterThan(0);
    expect(diagnostics?.[0]?.source).toBe('msvc6');
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

    const messages = await waitForMessages(serverProcess, 1, 15000);
    const diagNotif = messages.find(
      (m) => isLspMessage(m) && m.method === 'textDocument/publishDiagnostics',
    ) as LspMessage | undefined;

    expect(diagNotif).toBeDefined();
    expect(diagNotif?.params?.diagnostics).toHaveLength(0);
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

    await waitForMessages(serverProcess, 1, 15000);

    sendNotification(serverProcess, 'textDocument/didClose', {
      textDocument: { uri },
    });

    const messages = await waitForMessages(serverProcess, 1, 5000);
    const clearNotif = messages.find(
      (m) =>
        isLspMessage(m) &&
        m.method === 'textDocument/publishDiagnostics' &&
        m.params?.diagnostics?.length === 0,
    );

    expect(clearNotif).toBeDefined();
  });
});
