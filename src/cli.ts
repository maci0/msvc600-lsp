import * as fs from 'fs';
import * as path from 'path';
import { ENV_NAMES } from './config';

/** Program name used in usage text and error messages. */
const PROGRAM = 'msvc600-lsp';

/** Exit code for a usage error: bad flag, missing value, stray argument. */
export const USAGE_EXIT_CODE = 2;

/**
 * What the command line asked for. `serve` is the only outcome that leaves the
 * process running; every other outcome prints its streams and exits with the
 * given code, so the exit code and the text stay attached to each other.
 */
export type CliOutcome =
  | { kind: 'serve' }
  | { kind: 'exit'; code: number; stdout: string; stderr: string };

const USAGE = `Usage: ${PROGRAM} [options]

Language server that syntax-checks C/C++ buffers with Microsoft Visual C++ 6.0.
It speaks LSP over a pipe and writes nothing to stdout except protocol frames.

Options:
      --stdio           communicate over stdin/stdout
      --node-ipc        communicate over the Node IPC channel
      --socket=<port>   connect to a TCP server on <port>
  -h, --help            print this help and exit
  -V, --version         print the version and exit

Configuration comes from MSVC600_* environment variables and from the client's
initializationOptions, in that order of increasing precedence. No configuration
is passed on the command line; 'initialize' reports the effective values.

Environment:
${ENV_NAMES.map((name) => `  ${name}`).join('\n')}

Examples:
  ${PROGRAM} --stdio
  MSVC600_WARN_LEVEL=2 ${PROGRAM} --stdio
  ${PROGRAM} --socket=6009`;

function helpText(version: string): string {
  return `${USAGE}

Version: ${version}
`;
}

/**
 * The package version, read from the manifest that ships next to the compiled
 * entry point. A missing or unreadable manifest is not a reason to refuse to
 * start, so it degrades to `unknown`.
 */
export function readVersion(rootDir: string = path.join(__dirname, '..')): string {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(rootDir, 'package.json'), 'utf-8'),
    ) as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Usage error: the message names the offending argument, then points at --help. */
function usageError(problem: string): CliOutcome {
  return {
    kind: 'exit',
    code: USAGE_EXIT_CODE,
    stdout: '',
    stderr: `${PROGRAM}: ${problem}\n${USAGE.split('\n')[0]}\nTry '${PROGRAM} --help' for the full list of options.\n`,
  };
}

/**
 * Parses the command line. Only the transport and the two informational flags
 * are accepted; anything else is a usage error rather than an argument the
 * server reads past, so a typo cannot start a server configured differently
 * from what was asked for.
 */
export function parseArgs(argv: readonly string[], version: string): CliOutcome {
  let transport = false;

  for (const arg of argv) {
    if (arg === '--stdio' || arg === '--node-ipc') {
      transport = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      return { kind: 'exit', code: 0, stdout: helpText(version), stderr: '' };
    }
    if (arg === '--version' || arg === '-V') {
      return { kind: 'exit', code: 0, stdout: `${version}\n`, stderr: '' };
    }
    if (arg.startsWith('--socket=')) {
      const port = arg.slice('--socket='.length);
      if (!/^\d+$/.test(port)) {
        return usageError(`--socket needs a port number, got '${port}'`);
      }
      transport = true;
      continue;
    }
    if (arg.startsWith('-')) {
      return usageError(`unknown option '${arg}'`);
    }
    return usageError(`unexpected argument '${arg}'`);
  }

  // The server has no default transport to fall back on, so a bare invocation
  // names the three that exist rather than failing inside the LSP library.
  if (!transport) {
    return usageError('no transport selected; pass --stdio, --node-ipc, or --socket=<port>');
  }

  return { kind: 'serve' };
}

/**
 * Runs the command line and, when the process is not to serve, writes the
 * outcome's streams and exits with its code. Help and version go to stdout so a
 * script can capture them; a usage error goes to stderr and exits 2, so a
 * script that ignores it does not read an error page as the server's output.
 */
export function runCli(argv: readonly string[] = process.argv.slice(2)): void {
  const outcome = parseArgs(argv, readVersion());
  if (outcome.kind === 'serve') return;

  if (outcome.stdout) process.stdout.write(outcome.stdout);
  if (outcome.stderr) process.stderr.write(outcome.stderr);
  process.exit(outcome.code);
}
