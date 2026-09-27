import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  syntaxCheck,
  syntaxCheckContent,
  buildArgs,
  stripByteOrderMark,
  createTempSourcePath,
  sweepStaleTempFiles,
} from '../src/compiler';
import { Msvc6Config } from '../src/config';
import { CL_EXE, MSVC_ROOT, describeWithToolchain } from './helpers/toolchain';

const FIXTURES = path.resolve(__dirname, 'fixtures');

function testConfig(): Msvc6Config {
  return {
    msvcBasePath: MSVC_ROOT,
    clPath: CL_EXE,
    includePaths: ['C:\\msvc6\\include'],
    warnLevel: 4,
    additionalFlags: [],
    wineExecutable: 'wine',
    outputEncoding: 'utf8',
    useWine: true,
  };
}

describeWithToolchain('syntaxCheck', () => {
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

describe('stripByteOrderMark', () => {
  it('removes a leading U+FEFF', () => {
    expect(stripByteOrderMark('\ufeffint main(void) { return 0; }')).toBe(
      'int main(void) { return 0; }',
    );
  });

  it('leaves content without a BOM untouched', () => {
    expect(stripByteOrderMark('int main(void) { return 0; }')).toBe(
      'int main(void) { return 0; }',
    );
  });

  it('only removes the first BOM, so a BOM later in the file survives', () => {
    expect(stripByteOrderMark('a\ufeffb')).toBe('a\ufeffb');
  });
});

describeWithToolchain('syntaxCheckContent', () => {
  it('checks content that starts with a UTF-8 BOM', async () => {
    const result = await syntaxCheckContent(
      testConfig(),
      '\ufeffint main(void) { return 0; }\n',
      'c',
    );
    expect(result.exitCode).toBe(0);
  });
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

  it.runIf(process.platform !== 'win32')(
    'decodes output with the configured encoding instead of assuming UTF-8',
    async () => {
      const cfg = {
        ...testConfig(),
        useWine: false,
        clPath: path.join(FIXTURES, 'emit_cp1252.mjs'),
        outputEncoding: 'cp1252',
      };
      const result = await syntaxCheck(cfg, path.join(FIXTURES, 'valid.c'));
      expect(result.stdout).toBe('Z:\\tmp\\café.c');
    },
  );

  it.runIf(process.platform !== 'win32')(
    'yields a replacement character for bytes the encoding cannot map',
    async () => {
      const cfg = {
        ...testConfig(),
        useWine: false,
        clPath: path.join(FIXTURES, 'emit_cp1252.mjs'),
        outputEncoding: 'utf8',
      };
      const result = await syntaxCheck(cfg, path.join(FIXTURES, 'valid.c'));
      expect(result.stdout).toBe('Z:\\tmp\\caf\uFFFD.c');
    },
  );
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

describeWithToolchain('syntaxCheck — abort signal', () => {
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
});

describe('createTempSourcePath', () => {
  it('picks the extension from the language id', () => {
    expect(path.basename(createTempSourcePath('cpp'))).toMatch(/^msvc6_lsp_.+\.cpp$/);
    expect(path.basename(createTempSourcePath('c'))).toMatch(/^msvc6_lsp_.+\.c$/);
  });

  it('returns a different path on every call', () => {
    expect(createTempSourcePath('c')).not.toBe(createTempSourcePath('c'));
  });
});

describe('sweepStaleTempFiles', () => {
  const HOUR_MS = 60 * 60 * 1000;

  function makeTemp(name: string, ageMs: number): string {
    const file = path.join(os.tmpdir(), name);
    fs.writeFileSync(file, 'x');
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(file, when, when);
    return file;
  }

  it('removes an orphaned scratch file and reports it', () => {
    const file = makeTemp(`msvc6_lsp_orphan_${process.pid}.c`, 2 * HOUR_MS);
    try {
      expect(sweepStaleTempFiles()).toContain(file);
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('keeps a scratch file an in-flight check may still own', () => {
    const file = makeTemp(`msvc6_lsp_live_${process.pid}.cpp`, 60 * 1000);
    try {
      expect(sweepStaleTempFiles()).not.toContain(file);
      expect(fs.existsSync(file)).toBe(true);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('leaves files it did not create alone', () => {
    const file = makeTemp(`unrelated_${process.pid}.c`, 2 * HOUR_MS);
    try {
      expect(sweepStaleTempFiles()).not.toContain(file);
      expect(fs.existsSync(file)).toBe(true);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('is a no-op the second time over the same leftovers', () => {
    const file = makeTemp(`msvc6_lsp_twice_${process.pid}.c`, 2 * HOUR_MS);
    try {
      expect(sweepStaleTempFiles()).toContain(file);
      expect(sweepStaleTempFiles()).not.toContain(file);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});
