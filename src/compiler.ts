import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Msvc6Config, CPP_EXTENSIONS, C_EXTENSIONS, toWinePath } from './config';

/** Result of a CL.EXE syntax-check invocation. */
export interface CompileResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Combined stdout + stderr for diagnostic parsing. */
  rawOutput: string;
  /** True when output was truncated (maxBuffer exceeded). Diagnostics may be incomplete. */
  truncated: boolean;
}

/**
 * Builds the CL.EXE argument list for a syntax-only check.
 * Selects /TC (C) or /TP (C++) based on file extension.
 */
export function buildArgs(config: Msvc6Config, filePath: string): string[] {
  const args: string[] = ['/nologo', '/Zs'];

  args.push(`/W${config.warnLevel}`);

  for (const inc of config.includePaths) {
    // Wine cannot resolve POSIX paths — only absolute POSIX paths need conversion;
    // Windows-style and relative paths are already in a form CL.EXE understands.
    const resolvedInc = config.useWine && inc.startsWith('/') ? toWinePath(inc) : inc;
    args.push('/I', resolvedInc);
  }

  const ext = path.extname(filePath).toLowerCase();
  if (CPP_EXTENSIONS.includes(ext)) {
    args.push('/TP');
  } else if (C_EXTENSIONS.includes(ext)) {
    args.push('/TC');
  }

  args.push(...config.additionalFlags);
  args.push(config.useWine ? toWinePath(filePath) : filePath);

  return args;
}

/** Wall-clock budget for one syntax check before the process is killed. */
const CHECK_TIMEOUT_MS = 30000;

/** Cap on captured stdout and stderr, matching the previous `maxBuffer`. */
const MAX_OUTPUT_BYTES = 1024 * 1024;

/** Wine's loader and CL.EXE do not react to SIGTERM, so kills are SIGKILL. */
const KILL_SIGNAL = 'SIGKILL';

const SPAWN_FAILURE_CODES = new Set(['ENOENT', 'EACCES', 'ENOTDIR']);

/**
 * Sends the kill signal to the child and every process it started.
 *
 * Under Wine the child is the loader, and CL.EXE runs as its grandchild;
 * signalling the loader alone leaves CL.EXE running after an abort. The
 * child is spawned into its own process group, so a negative-pid kill
 * reaches the whole tree. Windows has no process groups: fall back to
 * the single process there.
 */
function killTree(pid: number | undefined, child: { kill: (signal: NodeJS.Signals) => boolean }): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    child.kill(KILL_SIGNAL);
    return;
  }
  try {
    process.kill(-pid, KILL_SIGNAL);
  } catch {
    child.kill(KILL_SIGNAL);
  }
}

/**
 * Runs CL.EXE in syntax-check mode (`/Zs`) on the given file.
 *
 * Always resolves — compiler errors are reported via `exitCode` and
 * `rawOutput`, not via promise rejection. Rejects when the executable
 * itself cannot be spawned (e.g. ENOENT, EACCES) or when the caller
 * aborts.
 */
export function syntaxCheck(
  config: Msvc6Config,
  filePath: string,
  opts: { signal?: AbortSignal } = {},
): Promise<CompileResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(abortError());
      return;
    }

    const args = buildArgs(config, filePath);
    const executable = config.useWine ? config.wineExecutable : config.clPath;
    const execArgs = config.useWine ? [config.clPath, ...args] : args;

    const env = config.useWine
      ? { ...process.env, WINEDEBUG: '-all' }
      : { ...process.env };

    const child = spawn(executable, execArgs, {
      env,
      // Own process group so a timeout or abort takes CL.EXE down with it.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let settled = false;

    const kill = () => killTree(child.pid, child);

    const timer = setTimeout(kill, CHECK_TIMEOUT_MS);

    const onAbort = () => {
      kill();
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(abortError());
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const collect = (chunk: Buffer, current: string, bytes: number): [string, number] => {
      const room = MAX_OUTPUT_BYTES - bytes;
      if (chunk.length > room) {
        truncated = true;
        // Keep the writer from blocking on a full pipe: the output is
        // unusable past the cap, so the check is abandoned.
        kill();
        return [current, bytes];
      }
      return [current + chunk.toString('utf-8'), bytes + chunk.length];
    };

    child.stdout.on('data', (chunk: Buffer) => {
      [stdout, stdoutBytes] = collect(chunk, stdout, stdoutBytes);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      [stderr, stderrBytes] = collect(chunk, stderr, stderrBytes);
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      const code = typeof error.code === 'string' ? error.code : '';
      if (SPAWN_FAILURE_CODES.has(code)) {
        reject(new Error(`Failed to execute ${executable}: ${code}`));
        return;
      }
      resolve({
        stdout,
        stderr: stderr + error.message,
        exitCode: 1,
        rawOutput: stdout + '\n' + stderr + error.message,
        truncated,
      });
    });

    child.on('close', (code: number | null) => {
      opts.signal?.removeEventListener('abort', onAbort);
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
        rawOutput: stdout + '\n' + stderr,
        truncated,
      });
    });
  });
}

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  (error as NodeJS.ErrnoException).code = 'ABORT_ERR';
  return error;
}

/**
 * Writes `content` to a temp file and runs a syntax check on it.
 * The temp file is cleaned up after the check completes.
 *
 * **Public API** — not used internally by the LSP server (which manages its
 * own temp files for abort/stale-result handling), but exported for
 * programmatic consumers who want a simpler one-shot interface.
 */
export async function syntaxCheckContent(
  config: Msvc6Config,
  content: string,
  languageId: string,
): Promise<CompileResult & { tempFile: string }> {
  const ext = languageId === 'cpp' ? '.cpp' : '.c';
  const tempFile = path.join(os.tmpdir(), `msvc6_lsp_${randomUUID()}${ext}`);

  try {
    fs.writeFileSync(tempFile, content, { encoding: 'utf-8', mode: 0o600 });
    const result = await syntaxCheck(config, tempFile);
    return { ...result, tempFile };
  } finally {
    try {
      fs.unlinkSync(tempFile);
    } catch {
      // Temp file may already be gone — not an error.
    }
  }
}
