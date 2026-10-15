import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MSVC_ROOT, PROJECT_ROOT, describeWithToolchain } from './helpers/toolchain';

const FIXTURES = path.resolve(__dirname, 'fixtures');

/** Typed LSP JSON-RPC message for test assertions. */
interface LspMessage {
  jsonrpc: string;
  id?: number;
  method?: string;
  result?: Record<string, unknown> | null;
  error?: { code?: number; message?: string };
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

/**
 * Collects messages until `count` of them have arrived, or until one matches
 * `until` when a predicate is given, or until `timeoutMs` elapses.
 */
function waitForMessages(
  proc: ChildProcess,
  count: number,
  timeoutMs = 15000,
  until?: (message: unknown) => boolean,
): Promise<unknown[]> {
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

        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          continue;
        }
        messages.push(parsed);

        if (until ? until(parsed) : messages.length >= count) {
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

function startServer(extraEnv: NodeJS.ProcessEnv = {}): ChildProcess {
  const serverPath = path.resolve(__dirname, '..', 'dist', 'server.js');
  // process.execPath is the runtime already running the tests (node or bun),
  // so the suite does not depend on `node` being on PATH.
  return spawn(process.execPath, [serverPath, '--stdio'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, WINEDEBUG: '-all', ...extraEnv },
  });
}

function killServer(proc: ChildProcess | null): void {
  if (!proc || proc.killed || proc.exitCode !== null) return;
  try {
    proc.kill('SIGTERM');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
  }
}

function waitForExit(proc: ChildProcess, timeoutMs = 5000): Promise<number | null> {
  if (proc.exitCode !== null) return Promise.resolve(proc.exitCode);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    proc.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function initServer(
  proc: ChildProcess,
  extraOptions: Record<string, unknown> = {},
): Promise<unknown> {
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

  // Match on the response id, not on the first message of any kind: onInitialize
  // emits console warnings and the effective-configuration info line before it
  // returns, so `window/logMessage` notifications can arrive ahead of the reply.
  // Waiting for "any message" would hand a log notification back as the result.
  const msgs = await waitForMessages(
    proc,
    1,
    10000,
    (m): boolean => isLspMessage(m) && m.id === id && m.method === undefined,
  );
  const response = msgs.find((m): m is LspMessage => isLspMessage(m) && m.id === id);
  if (response === undefined) {
    throw new Error(
      `initialize timed out: no response with id ${id} in ${msgs.length} message(s): ` +
        JSON.stringify(msgs),
    );
  }
  sendNotification(proc, 'initialized', {});
  await new Promise((r) => setTimeout(r, 300));
  return response;
}

/** Builds dist/ with the locally installed TypeScript. */
async function buildServer(): Promise<void> {
  const { execFileSync } = await import('child_process');
  // Compile with the locally installed TypeScript: `bunx tsc` depends on a
  // package runner being on PATH and fails with an opaque error without one.
  const tsc = path.join(PROJECT_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tsc)) {
    throw new Error(`TypeScript not installed at ${tsc}; run "bun install" first`);
  }
  execFileSync(process.execPath, [tsc], { cwd: PROJECT_ROOT, stdio: 'inherit' });
}

describeWithToolchain('LSP Server Protocol', () => {
  beforeAll(buildServer, 120000);

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
    // Incremental sync keeps a keystroke from resending the whole buffer.
    expect((capabilities?.textDocumentSync as { change?: number }).change).toBe(2);
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

    const id = sendRequest(serverProcess, 'shutdown');
    // Match the reply by id: log notifications share the stream with it, so
    // taking the first message would assert on whichever arrived first.
    const messages = await waitForMessages(
      serverProcess,
      1,
      5000,
      (m): boolean => isLspMessage(m) && m.id === id && m.method === undefined,
    );

    const response = messages.find((m): m is LspMessage => isLspMessage(m) && m.id === id);
    expect(response, `no shutdown reply with id ${id}: ${JSON.stringify(messages)}`).toBeDefined();
    expect(response!.result).toBeNull();
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

    const messages = await waitForMessages(serverProcess, 1, 15000);
    const diagNotif = messages.find(
      (m) => isLspMessage(m) && m.method === 'textDocument/publishDiagnostics',
    ) as LspMessage | undefined;

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

describe('LSP Server tool failure signalling', () => {
  beforeAll(buildServer, 120000);

  afterEach(() => {
    killServer(serverProcess);
    serverProcess = null;
  });

  it('reports a missing CL.EXE as a diagnostic instead of a clean file', async () => {
    serverProcess = startServer();
    await initServer(serverProcess, {
      useWine: false,
      clPath: path.join(os.tmpdir(), 'definitely_not_cl_exe.exe'),
    });

    const uri = 'file:///tmp/test_missing_tool.c';
    sendNotification(serverProcess, 'textDocument/didOpen', {
      textDocument: { uri, languageId: 'c', version: 1, text: 'int main(void) { return 0; }\n' },
    });

    const messages = await waitForMessages(
      serverProcess,
      1,
      10000,
      (m): boolean =>
        isLspMessage(m) &&
        m.method === 'textDocument/publishDiagnostics' &&
        m.params?.uri === uri,
    );
    const diagNotif = messages.find(
      (m): m is LspMessage =>
        isLspMessage(m) && m.method === 'textDocument/publishDiagnostics' && m.params?.uri === uri,
    );

    expect(diagNotif).toBeDefined();
    const diagnostics = diagNotif!.params!.diagnostics!;
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe('msvc600-check-failed');
    expect(diagnostics[0].message).toMatch(/ENOENT/);
  });

  /** Diagnostics published for `uri`, waiting for the first non-empty set. */
  async function diagnosticsFor(
    uri: string,
    options: Record<string, unknown>,
    text: string,
  ): Promise<Array<{ message?: string; source?: string; code?: string }>> {
    serverProcess = startServer();
    await initServer(serverProcess, options);
    sendNotification(serverProcess, 'textDocument/didOpen', {
      textDocument: { uri, languageId: 'c', version: 1, text },
    });

    const messages = await waitForMessages(serverProcess, 1, 15000, (m): boolean =>
      isLspMessage(m) &&
      m.method === 'textDocument/publishDiagnostics' &&
      m.params?.uri === uri &&
      (m.params.diagnostics?.length ?? 0) > 0,
    );
    const notif = messages.find(
      (m): m is LspMessage =>
        isLspMessage(m) && m.method === 'textDocument/publishDiagnostics' && m.params?.uri === uri,
    );
    return notif!.params!.diagnostics!;
  }

  const fixture = (name: string): string => path.join(FIXTURES, name);

  it.runIf(process.platform !== 'win32')(
    'reports a run cut short by a signal instead of a clean file',
    async () => {
      const diagnostics = await diagnosticsFor(
        'file:///tmp/test_signal_kill.c',
        { useWine: false, clPath: fixture('self_kill.mjs') },
        'int main(void) { return 0; }\n',
      );

      expect(diagnostics.some((d) => /terminated by SIGKILL/.test(d.message ?? ''))).toBe(true);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'marks truncated output as an incomplete check',
    async () => {
      const diagnostics = await diagnosticsFor(
        'file:///tmp/test_truncated.c',
        { useWine: false, clPath: fixture('emit_flood.mjs'), maxOutputBytes: 4096 },
        'int main(void) { return 0; }\n',
      );

      // Without the marker the client would read the capped output as a
      // complete list and mark the rest of the file clean.
      expect(diagnostics.some((d) => /4096 byte cap/.test(d.message ?? ''))).toBe(true);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'reports a failed run that produced no parseable diagnostic',
    async () => {
      const diagnostics = await diagnosticsFor(
        'file:///tmp/test_no_diagnostic.c',
        { useWine: false, clPath: fixture('exit_without_diagnostic.mjs') },
        'int main(void) { return 0; }\n',
      );

      // A non-zero exit with no file(line) diagnostic: publishing the parsed
      // list alone would have marked the file clean.
      expect(diagnostics.some((d) => /exited with code 2/.test(d.message ?? ''))).toBe(true);
      expect(diagnostics.some((d) => /D8021/.test(d.message ?? ''))).toBe(true);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'names the configured timeout rather than the default',
    async () => {
      const diagnostics = await diagnosticsFor(
        'file:///tmp/test_timed_out.c',
        { useWine: false, clPath: fixture('hang.mjs'), checkTimeoutMs: 1000 },
        'int main(void) { return 0; }\n',
      );

      expect(diagnostics.some((d) => /within 1000 ms/.test(d.message ?? ''))).toBe(true);
    },
  );
});

/** Runs the built entry point with `args` and collects its output and exit code. */
function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const serverPath = path.resolve(__dirname, '..', 'dist', 'server.js');
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [serverPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += String(d)));
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

describe('command line', () => {
  beforeAll(buildServer, 120000);

  it('prints help on stdout, exits 0, and writes nothing to stderr', async () => {
    const result = await runCli(['-o', 'text', '--help']);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Usage: msvc600-lsp [options]');
    expect(result.stdout).toContain('schema');
    expect(result.stdout.startsWith('{')).toBe(false);
  });

  it('prints the package version on stdout, exits 0', async () => {
    const result = await runCli(['-o', 'text', '--version']);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf-8'),
    ) as { version: string };
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(manifest.version);
  });

  it('prints schema as JSON and exits 0 with no transport', async () => {
    const result = await runCli(['schema']);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const doc = JSON.parse(result.stdout) as {
      clispec: string;
      name: string;
      version: string;
      commands: Array<{ name: string; effects: string; output_kind?: string; media_type?: string }>;
      errors: Array<{ kind: string; exit_code: number }>;
      output: { piped: string };
      global_args: unknown[];
    };
    expect(doc.clispec).toBe('0.3');
    expect(doc.name).toBe('msvc600-lsp');
    expect(doc.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(doc.output.piped).toBe('json');
    expect(doc.global_args.length).toBeGreaterThan(0);
    expect(doc.errors.some((error) => error.kind === 'usage' && error.exit_code === 2)).toBe(true);
    const serve = doc.commands.find((command) => command.name === 'serve');
    expect(serve).toMatchObject({
      effects: 'non_idempotent',
      output_kind: 'opaque',
      media_type: 'application/vscode-jsonrpc',
    });
  });

  it('prints version as one JSON document when -o json is set', async () => {
    const result = await runCli(['-o', 'json', '--version']);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf-8'),
    ) as { version: string };
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ version: manifest.version });
  });

  it('exits 2 on an unknown flag and keeps stdout clear of the error', async () => {
    const result = await runCli(['-o', 'text', '--stdios']);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain("unknown option '--stdios'");
  });

  it('exits 2 with a usage envelope as the last stderr line when -o json is set', async () => {
    const result = await runCli(['-o', 'json', '--stdios']);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    const lines = result.stderr.split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      error: {
        kind: 'usage',
        message: "msvc600-lsp: unknown option '--stdios'",
        hint: "Try 'msvc600-lsp --help' for the full list of options.",
      },
    });
  });

  it('exits 2 with a usage error when no transport is given', async () => {
    const result = await runCli(['-o', 'text']);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('no transport selected');
  });

  it('writes no clispec envelope on stdout while serving, even with -o json', async () => {
    const serverPath = path.resolve(__dirname, '..', 'dist', 'server.js');
    const proc = spawn(process.execPath, [serverPath, '-o', 'json', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    proc.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    killServer(proc);
    await waitForExit(proc);
    expect(stdout).toBe('');
  });
});

describe('LSP lifecycle without the toolchain', () => {
  beforeAll(buildServer, 120000);

  afterEach(() => {
    killServer(serverProcess);
    serverProcess = null;
  });

  it('advertises only the text document sync it implements', async () => {
    serverProcess = startServer();
    const raw = await initServer(serverProcess, { useWine: false });
    const response = raw as LspMessage;
    expect(response.result?.capabilities).toEqual({
      textDocumentSync: {
        openClose: true,
        change: 2,
        save: { includeText: false },
      },
    });
  });

  it('exits 0 after shutdown then exit', async () => {
    serverProcess = startServer();
    await initServer(serverProcess, { useWine: false });
    const id = sendRequest(serverProcess, 'shutdown');
    const messages = await waitForMessages(
      serverProcess,
      1,
      5000,
      (m): boolean => isLspMessage(m) && m.id === id && m.method === undefined,
    );
    expect(messages.some((m) => isLspMessage(m) && m.id === id && m.error === undefined)).toBe(true);
    const closed = waitForExit(serverProcess);
    sendNotification(serverProcess, 'exit');
    expect(await closed).toBe(0);
  });

  it('rejects a request after shutdown with InvalidRequest', async () => {
    serverProcess = startServer();
    await initServer(serverProcess, { useWine: false });

    const before = sendRequest(serverProcess, 'textDocument/hover', {
      textDocument: { uri: 'file:///tmp/none.c' },
      position: { line: 0, character: 0 },
    });
    const beforeMsgs = await waitForMessages(
      serverProcess,
      1,
      5000,
      (m): boolean => isLspMessage(m) && m.id === before,
    );
    const beforeReply = beforeMsgs.find((m): m is LspMessage => isLspMessage(m) && m.id === before);
    expect(beforeReply?.error?.code).toBe(-32601);

    const shutdownId = sendRequest(serverProcess, 'shutdown');
    await waitForMessages(
      serverProcess,
      1,
      5000,
      (m): boolean => isLspMessage(m) && m.id === shutdownId && m.method === undefined,
    );

    const after = sendRequest(serverProcess, 'textDocument/hover', {
      textDocument: { uri: 'file:///tmp/none.c' },
      position: { line: 0, character: 0 },
    });
    const afterMsgs = await waitForMessages(
      serverProcess,
      1,
      5000,
      (m): boolean => isLspMessage(m) && m.id === after,
    );
    const afterReply = afterMsgs.find((m): m is LspMessage => isLspMessage(m) && m.id === after);
    expect(afterReply?.error?.code).toBe(-32600);
    expect(afterReply?.error?.message).toContain('after shutdown');
  });

  it('clears diagnostics when a document is closed', async () => {
    serverProcess = startServer();
    await initServer(serverProcess, { useWine: false });
    const uri = 'file:///tmp/notes.txt';
    sendNotification(serverProcess, 'textDocument/didOpen', {
      textDocument: { uri, languageId: 'plaintext', version: 1, text: 'not compiled\n' },
    });
    sendNotification(serverProcess, 'textDocument/didClose', { textDocument: { uri } });
    const messages = await waitForMessages(
      serverProcess,
      1,
      5000,
      (m): boolean =>
        isLspMessage(m) && m.method === 'textDocument/publishDiagnostics' && m.params?.uri === uri,
    );
    const cleared = messages.find(
      (m): m is LspMessage =>
        isLspMessage(m) && m.method === 'textDocument/publishDiagnostics' && m.params?.uri === uri,
    );
    expect(cleared?.params?.diagnostics).toEqual([]);
  });

  it.runIf(process.platform !== 'win32')(
    'cancels an in-flight diagnostics run on $/cancelRequest',
    async () => {
      const pidfile = path.join(os.tmpdir(), `msvc600-cancel-${process.pid}-${Date.now()}`);
      let pid = 0;
      try {
        serverProcess = startServer({ MSVC6_CANCEL_PIDFILE: pidfile });
        await initServer(serverProcess, {
          useWine: false,
          clPath: path.join(FIXTURES, 'cancel_target.mjs'),
        });
        sendNotification(serverProcess, 'textDocument/didOpen', {
          textDocument: {
            uri: 'file:///tmp/test_cancel.c',
            languageId: 'c',
            version: 1,
            text: 'int main(void) { return 0; }\n',
          },
        });
        const started = Date.now();
        while (Date.now() - started < 8000) {
          if (fs.existsSync(pidfile)) {
            const parsed = Number(fs.readFileSync(pidfile, 'utf8').trim());
            if (Number.isInteger(parsed) && parsed > 0) {
              pid = parsed;
              break;
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(pid).toBeGreaterThan(0);
        sendNotification(serverProcess, '$/cancelRequest', { id: 99999 });
        const killedAt = Date.now();
        let dead = false;
        while (Date.now() - killedAt < 3000) {
          try {
            process.kill(pid, 0);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ESRCH') {
              dead = true;
              break;
            }
            throw e;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(dead).toBe(true);
      } finally {
        if (pid > 0) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // Already gone, which is the pass.
          }
        }
        fs.rmSync(pidfile, { force: true });
      }
    },
  );
});
