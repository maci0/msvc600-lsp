import { describe, it, expect } from 'vitest';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { syntaxCheck, syntaxCheckContent, buildArgs } from '../src/compiler';
import { Msvc6Config } from '../src/config';

const FIXTURES = path.resolve(__dirname, 'fixtures');
const MSVC_ROOT = path.resolve(__dirname, '..', 'VC', 'VC98');

function testConfig(): Msvc6Config {
  return {
    msvcBasePath: MSVC_ROOT,
    clPath: path.join(MSVC_ROOT, 'BIN', 'CL.EXE'),
    includePaths: ['C:\\msvc6\\include'],
    warnLevel: 4,
    additionalFlags: [],
    wineExecutable: 'wine',
    useWine: true,
  };
}

describe('syntaxCheck', () => {
  it('returns exit code 0 for valid C file', async () => {
    const result = await syntaxCheck(testConfig(), path.join(FIXTURES, 'valid.c'));
    expect(result.exitCode).toBe(0);
  });

  it('returns non-zero exit code for C file with errors', async () => {
    const result = await syntaxCheck(testConfig(), path.join(FIXTURES, 'error_syntax.c'));
    expect(result.exitCode).not.toBe(0);
  });

  it('captures error output for type mismatch', async () => {
    const result = await syntaxCheck(testConfig(), path.join(FIXTURES, 'error_type.c'));
    expect(result.rawOutput).toContain('warning');
    expect(result.rawOutput).toContain('C4047');
  });

  it('captures error output for syntax error', async () => {
    const result = await syntaxCheck(testConfig(), path.join(FIXTURES, 'error_syntax.c'));
    expect(result.rawOutput).toContain('error');
    expect(result.rawOutput).toContain('C2146');
  });

  it('captures undeclared function warnings', async () => {
    const result = await syntaxCheck(testConfig(), path.join(FIXTURES, 'error_undeclared.c'));
    expect(result.rawOutput).toContain('C4013');
  });

  it('captures unused variable warnings', async () => {
    const result = await syntaxCheck(testConfig(), path.join(FIXTURES, 'warnings.c'));
    expect(result.rawOutput).toContain('warning');
  });

  it('handles multiple errors in a single file', async () => {
    const result = await syntaxCheck(testConfig(), path.join(FIXTURES, 'multiple_errors.c'));
    const errorCount = (result.rawOutput.match(/error C/g) || []).length;
    expect(errorCount).toBeGreaterThanOrEqual(1);
  });

  it('returns exit code 0 for valid C++ file', async () => {
    const result = await syntaxCheck(testConfig(), path.join(FIXTURES, 'valid.cpp'));
    expect(result.exitCode).toBe(0);
  });

  it('captures C++ type errors', async () => {
    const result = await syntaxCheck(testConfig(), path.join(FIXTURES, 'error_cpp.cpp'));
    expect(result.rawOutput).toContain('error');
    expect(result.rawOutput).toContain('C2664');
  });

  it('populates both stdout and rawOutput', async () => {
    const result = await syntaxCheck(testConfig(), path.join(FIXTURES, 'valid.c'));
    expect(result.rawOutput).toBeDefined();
    expect(typeof result.rawOutput).toBe('string');
  });

  it('sets truncated to false for normal output', async () => {
    const result = await syntaxCheck(testConfig(), path.join(FIXTURES, 'valid.c'));
    expect(result.truncated).toBe(false);
  });
});

describe('syntaxCheckContent', () => {
  it('checks C content passed as string', async () => {
    const content = 'int main(void) { return 0; }\n';
    const result = await syntaxCheckContent(testConfig(), content, 'c');
    expect(result.exitCode).toBe(0);
  });

  it('detects errors in C content string', async () => {
    const content = 'int main(void) { int x = "bad"; return 0; }\n';
    const result = await syntaxCheckContent(testConfig(), content, 'c');
    expect(result.rawOutput).toContain('C4047');
  });

  it('uses .cpp extension for cpp language id', async () => {
    const content = 'class X {};\nint main() { return 0; }\n';
    const result = await syntaxCheckContent(testConfig(), content, 'cpp');
    expect(result.exitCode).toBe(0);
    expect(result.tempFile).toContain('.cpp');
  });

  it('cleans up temp file after completion', async () => {
    const fs = await import('fs');
    const content = 'int main(void) { return 0; }\n';
    const result = await syntaxCheckContent(testConfig(), content, 'c');
    expect(fs.existsSync(result.tempFile)).toBe(false);
  });

  it('uses .c extension for c language id', async () => {
    const content = 'int main(void) { return 0; }\n';
    const result = await syntaxCheckContent(testConfig(), content, 'c');
    expect(result.tempFile).toContain('.c');
    expect(result.tempFile).not.toContain('.cpp');
  });
});

describe('syntaxCheck with useWine: false', () => {
  it('rejects with ENOENT when executable does not exist and useWine is false', async () => {
    const cfg = { ...testConfig(), useWine: false, clPath: '/nonexistent/CL.EXE' };
    await expect(syntaxCheck(cfg, path.join(FIXTURES, 'valid.c'))).rejects.toThrow('ENOENT');
  });
});

describe('buildArgs', () => {
  it('includes /nologo and /Zs as the first two flags', () => {
    const args = buildArgs(testConfig(), '/tmp/test.c');
    expect(args[0]).toBe('/nologo');
    expect(args[1]).toBe('/Zs');
  });

  it('adds /TC for .c files', () => {
    const args = buildArgs(testConfig(), '/tmp/test.c');
    expect(args).toContain('/TC');
    expect(args).not.toContain('/TP');
  });

  it('adds /TP for .cpp files', () => {
    const args = buildArgs(testConfig(), '/tmp/test.cpp');
    expect(args).toContain('/TP');
    expect(args).not.toContain('/TC');
  });

  it('adds /TP for .cxx, .cc, .hpp, .hxx files', () => {
    for (const ext of ['.cxx', '.cc', '.hpp', '.hxx']) {
      const args = buildArgs(testConfig(), `/tmp/test${ext}`);
      expect(args).toContain('/TP');
    }
  });

  it('adds neither /TC nor /TP for .h files', () => {
    const args = buildArgs(testConfig(), '/tmp/test.h');
    expect(args).not.toContain('/TC');
    expect(args).not.toContain('/TP');
  });

  it('adds neither /TC nor /TP for unknown extensions', () => {
    const args = buildArgs(testConfig(), '/tmp/test.txt');
    expect(args).not.toContain('/TC');
    expect(args).not.toContain('/TP');
  });

  it('includes warning level flag', () => {
    const args = buildArgs(testConfig(), '/tmp/test.c');
    expect(args).toContain('/W4');
  });

  it('converts POSIX include paths to Wine paths when useWine is true', () => {
    const cfg = { ...testConfig(), includePaths: ['/usr/include'] as string[] };
    const args = buildArgs(cfg, '/tmp/test.c');
    const iIndex = args.indexOf('/I');
    expect(iIndex).toBeGreaterThan(-1);
    expect(args[iIndex + 1]).toMatch(/^Z:\\/);
  });

  it('passes Windows-style include paths unchanged', () => {
    const cfg = { ...testConfig(), includePaths: ['C:\\\\msvc6\\\\include'] as string[] };
    const args = buildArgs(cfg, '/tmp/test.c');
    const iIndex = args.indexOf('/I');
    expect(args[iIndex + 1]).toBe('C:\\\\msvc6\\\\include');
  });

  it('appends additionalFlags', () => {
    const cfg = { ...testConfig(), additionalFlags: ['/DFOO', '/GX'] as string[] };
    const args = buildArgs(cfg, '/tmp/test.c');
    expect(args).toContain('/DFOO');
    expect(args).toContain('/GX');
  });

  it('places the file path as the last argument', () => {
    const args = buildArgs(testConfig(), '/tmp/test.c');
    const lastArg = args[args.length - 1];
    // With Wine enabled, the path is converted to Z: format
    expect(lastArg).toMatch(/test\.c$/);
  });

  it('does not convert include paths when useWine is false', () => {
    const cfg = { ...testConfig(), useWine: false, includePaths: ['/usr/include'] as string[] };
    const args = buildArgs(cfg, '/tmp/test.c');
    const iIndex = args.indexOf('/I');
    // Without Wine, POSIX paths are passed through unchanged
    expect(args[iIndex + 1]).toBe('/usr/include');
  });

  it('uses filePath directly when useWine is false', () => {
    const cfg = { ...testConfig(), useWine: false };
    const args = buildArgs(cfg, '/tmp/test.c');
    expect(args[args.length - 1]).toBe('/tmp/test.c');
  });
});

describe('syntaxCheck — abort signal', () => {
  it('rejects when an already-aborted signal is passed', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(
      syntaxCheck(testConfig(), path.join(FIXTURES, 'valid.c'), { signal: abort.signal }),
    ).rejects.toThrow();
  });

  it('rejects when signal is aborted during execution', async () => {
    const abort = new AbortController();
    // Abort shortly after invocation starts
    setTimeout(() => abort.abort(), 50);
    await expect(
      syntaxCheck(testConfig(), path.join(FIXTURES, 'valid.c'), { signal: abort.signal }),
    ).rejects.toThrow();
  });

  it('kills the whole process group, not just the spawned child', async () => {
    const fs = await import('fs');
    const os = await import('os');
    const pidFile = path.join(os.tmpdir(), `msvc6_lsp_grandchild_${randomUUID()}.pid`);
    process.env.GRANDCHILD_PID_FILE = pidFile;
    const abort = new AbortController();
    const cfg = {
      ...testConfig(),
      useWine: false,
      clPath: path.join(FIXTURES, 'spawn_grandchild.sh'),
    };

    try {
      const run = syntaxCheck(cfg, path.join(FIXTURES, 'valid.c'), { signal: abort.signal });
      setTimeout(() => abort.abort(), 50);
      await expect(run).rejects.toThrow();

      const grandchildPid = await readPidFile(pidFile);
      expect(grandchildPid).toBeGreaterThan(0);
      await expect(waitUntilDead(grandchildPid, 5000)).resolves.toBe(true);
    } finally {
      delete process.env.GRANDCHILD_PID_FILE;
      fs.rmSync(pidFile, { force: true });
    }
  });
});

/** Reads the grandchild pid once the fixture has written it. */
async function readPidFile(pidFile: string, timeoutMs = 10000): Promise<number> {
  const fs = await import('fs');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, 'utf-8').trim());
      if (pid > 0) return pid;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`fixture never wrote a grandchild pid to ${pidFile}`);
}

/**
 * Resolves true once the pid is gone. A reaped-but-unwaited zombie counts as
 * dead: the group kill delivered, the pid merely has not been collected.
 * On a platform without /proc there is nothing to assert, so report dead.
 */
async function waitUntilDead(pid: number, timeoutMs: number): Promise<boolean> {
  const fs = await import('fs');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let stat: string;
    try {
      stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
    } catch {
      return true;
    }
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
    if (state === 'Z') return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}
