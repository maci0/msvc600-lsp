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

  it('rejects a port outside the range the transport can open', () => {
    for (const argv of [['--socket=0'], ['--socket=99999']]) {
      const out = exitOf(argv);
      expect(out.code).toBe(USAGE_EXIT_CODE);
      expect(out.stdout).toBe('');
      expect(out.stderr).toContain('--socket needs a port between 1 and 65535');
    }
  });

  it('rejects two transports instead of letting the first one win silently', () => {
    for (const argv of [
      ['--stdio', '--node-ipc'],
      ['--stdio', '--socket=6009'],
      ['--socket=6009', '--stdio'],
    ]) {
      const out = exitOf(argv);
      expect(out.code).toBe(USAGE_EXIT_CODE);
      expect(out.stdout).toBe('');
      expect(out.stderr).toContain('more than one transport given');
    }
  });

  it('accepts the same transport named twice', () => {
    expect(parseArgs(['--stdio', '--stdio'], VERSION)).toEqual({ kind: 'serve' });
  });

  it('keeps the text usage error as three stderr lines', () => {
    const out = exitOf(['--sdio']);
    expect(out.stderr).toBe(
      "msvc600-lsp: unknown option '--sdio'\n" +
        'Usage: msvc600-lsp [options]\n' +
        "Try 'msvc600-lsp --help' for the full list of options.\n",
    );
  });

  it('prints a clispec 0.3 document for schema and does not serve', () => {
    const out = exitOf(['schema']);
    expect(out.code).toBe(0);
    expect(out.stderr).toBe('');
    const doc = JSON.parse(out.stdout) as {
      clispec: string;
      name: string;
      version: string;
      commands: Array<{ name: string; effects: string; output_kind?: string; media_type?: string }>;
      errors: Array<{ kind: string; exit_code: number }>;
      output: { tty: string; piped: string };
      global_args: unknown[];
    };
    expect(doc.clispec).toBe('0.3');
    expect(doc.name).toBe('msvc600-lsp');
    expect(doc.version).toBe(VERSION);
    expect(doc.output).toEqual({ tty: 'text', piped: 'json' });
    expect(doc.global_args.length).toBeGreaterThan(0);
    expect(doc.errors.map((error) => error.kind).sort()).toEqual(['failure', 'usage']);
    const serve = doc.commands.find((command) => command.name === 'serve');
    expect(serve?.effects).toBe('non_idempotent');
    expect(serve?.output_kind).toBe('opaque');
    expect(serve?.media_type).toBe('application/vscode-jsonrpc');
    for (const name of ['schema', 'help', 'version']) {
      expect(doc.commands.find((command) => command.name === name)?.effects).toBe('read_only');
    }
  });

  it('filters schema to one command and exits 0 when the path matches nothing', () => {
    const filtered = JSON.parse(exitOf(['schema', 'serve']).stdout) as {
      commands: Array<{ name: string }>;
    };
    expect(filtered.commands.map((command) => command.name)).toEqual(['serve']);
    const empty = JSON.parse(exitOf(['schema', 'missing']).stdout) as { commands: unknown[] };
    expect(empty.commands).toEqual([]);
    expect(exitOf(['schema', 'missing']).code).toBe(0);
  });

  it('keeps schema as JSON when -o text is asked', () => {
    const out = exitOf(['-o', 'text', 'schema']);
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout).clispec).toBe('0.3');
  });

  it('rejects schema combined with a transport', () => {
    const out = exitOf(['schema', '--stdio']);
    expect(out.code).toBe(USAGE_EXIT_CODE);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain('schema does not take a transport');
  });

  it('prints help and version as JSON when -o json is set', () => {
    const help = exitOf(['-o', 'json', '--help']);
    expect(help.code).toBe(0);
    expect(help.stderr).toBe('');
    const helpDoc = JSON.parse(help.stdout) as { text: string };
    expect(helpDoc.text).toContain('Usage: msvc600-lsp [options]');
    expect(helpDoc.text).toContain('schema');

    const version = exitOf(['--output', 'json', '--version']);
    expect(JSON.parse(version.stdout)).toEqual({ version: VERSION });
  });

  it('keeps -o text as plain text even when stdout is not a terminal', () => {
    const out = parseArgs(['-o', 'text', '--version'], VERSION, false);
    if (out.kind !== 'exit') throw new Error('expected version to exit');
    expect(out.stdout).toBe(`${VERSION}\n`);
    expect(out.stdout.startsWith('{')).toBe(false);
  });

  it('uses JSON for auto when stdout is not a terminal', () => {
    const out = parseArgs(['--version'], VERSION, false);
    if (out.kind !== 'exit') throw new Error('expected version to exit');
    expect(JSON.parse(out.stdout)).toEqual({ version: VERSION });
  });

  it('writes a usage envelope as the only stderr line when -o json is set', () => {
    const out = exitOf(['-o', 'json', '--sdio']);
    expect(out.code).toBe(USAGE_EXIT_CODE);
    expect(out.stdout).toBe('');
    const lines = out.stderr.split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      error: {
        kind: 'usage',
        message: "msvc600-lsp: unknown option '--sdio'",
        hint: "Try 'msvc600-lsp --help' for the full list of options.",
      },
    });
  });

  it('rejects a bad --output value', () => {
    const out = exitOf(['--output', 'yaml']);
    expect(out.code).toBe(USAGE_EXIT_CODE);
    expect(out.stderr).toContain("must be auto, text, or json, got 'yaml'");
  });

  it('still serves when -o json is passed with a transport', () => {
    expect(parseArgs(['-o', 'json', '--stdio'], VERSION)).toEqual({ kind: 'serve' });
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
