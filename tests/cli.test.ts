import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { parseArgs, readVersion, USAGE_EXIT_CODE } from '../src/cli';
import { PROJECT_ROOT } from './helpers/toolchain';

const VERSION = '9.9.9';

function exitOf(argv: string[]): { code: number; stdout: string; stderr: string } {
  const outcome = parseArgs(argv, VERSION);
  if (outcome.kind === 'serve') throw new Error(`expected ${argv.join(' ')} to exit`);
  return outcome;
}

describe('parseArgs', () => {
  it('serves on each transport the LSP library understands', () => {
    for (const argv of [['--stdio'], ['--node-ipc'], ['--socket=6009']]) {
      expect(parseArgs(argv, VERSION)).toEqual({ kind: 'serve' });
    }
  });

  it('prints help on stdout and exits 0', () => {
    for (const argv of [['--help'], ['-h']]) {
      const out = exitOf(argv);
      expect(out.code).toBe(0);
      expect(out.stderr).toBe('');
      expect(out.stdout).toContain('Usage: msvc600-lsp [options]');
    }
  });

  it('documents every environment variable it reads', () => {
    const { stdout } = exitOf(['--help']);
    expect(stdout).toContain('MSVC600_WARN_LEVEL');
    expect(stdout).toContain('MSVC600_INCLUDE_PATHS');
    expect(stdout).toContain('MSVC600_CL_PATH');
  });

  it('prints the version on stdout and exits 0', () => {
    for (const argv of [['--version'], ['-V']]) {
      const out = exitOf(argv);
      expect(out.code).toBe(0);
      expect(out.stdout).toBe(`${VERSION}\n`);
      expect(out.stderr).toBe('');
    }
  });

  it('answers a help request that follows a transport flag', () => {
    expect(exitOf(['--stdio', '--help']).code).toBe(0);
  });

  it('rejects an unknown option on stderr with the usage exit code', () => {
    const out = exitOf(['--sdio']);
    expect(out.code).toBe(USAGE_EXIT_CODE);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain("unknown option '--sdio'");
    expect(out.stderr).toContain('--help');
  });

  it('rejects a stray positional argument', () => {
    const out = exitOf(['--stdio', 'file.cpp']);
    expect(out.code).toBe(USAGE_EXIT_CODE);
    expect(out.stderr).toContain("unexpected argument 'file.cpp'");
  });

  it('rejects a bare invocation instead of failing inside the LSP library', () => {
    const out = exitOf([]);
    expect(out.code).toBe(USAGE_EXIT_CODE);
    expect(out.stderr).toContain('no transport selected');
  });

  it('names the value of a malformed --socket', () => {
    const out = exitOf(['--socket=notaport']);
    expect(out.code).toBe(USAGE_EXIT_CODE);
    expect(out.stderr).toContain("--socket needs a port number, got 'notaport'");
  });
});

describe('readVersion', () => {
  it('reads the version from the manifest that ships with the entry point', () => {
    expect(readVersion(PROJECT_ROOT)).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('degrades to unknown when the manifest is not there', () => {
    expect(readVersion(path.join(PROJECT_ROOT, 'no-such-dir'))).toBe('unknown');
  });
});
