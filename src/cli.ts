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

/** Lowest and highest TCP port the LSP transport can be pointed at. */
const MIN_PORT = 1;
const MAX_PORT = 65535;

const OUTPUT_VALUES = ['auto', 'text', 'json'] as const;
type OutputMode = (typeof OUTPUT_VALUES)[number];
type RenderFormat = 'text' | 'json';
type InfoCommand = 'help' | 'version' | 'schema';

const USAGE = `Usage: ${PROGRAM} [options]

Language server that syntax-checks C/C++ buffers with Microsoft Visual C++ 6.0.
It speaks LSP over a pipe and writes nothing to stdout except protocol frames.
Exactly one transport option is required to serve; naming two is a usage error.
schema, help, and version exit without a transport and without Wine.

Options:
      --stdio           communicate over stdin/stdout
      --node-ipc        communicate over the Node IPC channel
      --socket=<port>   connect to a TCP server on <port>
      schema [command]  print the clispec 0.3 document and exit
  -o, --output=<format>
                        auto, text, or json. Applies to schema, help, version,
                        and usage errors. schema is always JSON. Ignored while
                        serving: stdout stays LSP frames.
  -h, --help            print this help and exit
  -V, --version         print the version and exit

help and version are also accepted as words. -o auto is text on a terminal and
JSON when stdout is not a terminal. -o json on a usage error writes one JSON
line to stderr and leaves stdout empty. schema [command] keeps only that
command and commands under it; an unknown name prints a document whose command
list is empty.

Configuration comes from MSVC600_* environment variables and from the client's
initializationOptions, in that order of increasing precedence. No configuration
and no secrets are passed on the command line; 'initialize' reports the
effective values.

Environment:
${ENV_NAMES.map((name) => `  ${name}`).join('\n')}

Examples:
  ${PROGRAM} --stdio
  MSVC600_WARN_LEVEL=2 ${PROGRAM} --stdio
  ${PROGRAM} --socket=6009
  ${PROGRAM} schema
  ${PROGRAM} -o json --version`;

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

function isOutputValue(value: string): value is OutputMode {
  return (OUTPUT_VALUES as readonly string[]).includes(value);
}

/** Last explicit -o / --output. A bad value is a usage error; the mode stays the last good one. */
function readOutputMode(argv: readonly string[]): { mode: OutputMode; error?: string } {
  let mode: OutputMode = 'auto';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    let flag = '';
    let value: string | undefined;
    if (arg === '-o' || arg === '--output') {
      flag = arg;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        return { mode, error: `${arg} needs a value (auto, text, or json)` };
      }
      value = next;
      i++;
    } else if (arg.startsWith('--output=')) {
      flag = '--output';
      value = arg.slice('--output='.length);
    } else if (arg.startsWith('-o=')) {
      flag = '-o';
      value = arg.slice('-o='.length);
    } else {
      continue;
    }
    if (!isOutputValue(value)) {
      return { mode, error: `${flag} must be auto, text, or json, got '${value}'` };
    }
    mode = value;
  }
  return { mode };
}

function resolveFormat(mode: OutputMode, stdoutIsTTY: boolean): RenderFormat {
  if (mode === 'auto') return stdoutIsTTY ? 'text' : 'json';
  return mode;
}

/** Indented on a terminal so a person can read it; one line when piped. */
function formatJson(value: unknown, stdoutIsTTY: boolean): string {
  const body = stdoutIsTTY ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  return `${body}\n`;
}

/** Usage error: text is three stderr lines; JSON is one envelope line and empty stdout. */
function usageError(problem: string, format: RenderFormat): CliOutcome {
  if (format === 'json') {
    const envelope = {
      error: {
        kind: 'usage',
        message: `${PROGRAM}: ${problem}`,
        hint: `Try '${PROGRAM} --help' for the full list of options.`,
      },
    };
    return {
      kind: 'exit',
      code: USAGE_EXIT_CODE,
      stdout: '',
      stderr: `${JSON.stringify(envelope)}\n`,
    };
  }
  return {
    kind: 'exit',
    code: USAGE_EXIT_CODE,
    stdout: '',
    stderr: `${PROGRAM}: ${problem}\n${USAGE.split('\n')[0]}\nTry '${PROGRAM} --help' for the full list of options.\n`,
  };
}

interface SchemaCommand {
  name: string;
  description: string;
  effects: 'read_only' | 'idempotent' | 'non_idempotent';
  output_kind?: 'opaque';
  media_type?: string;
  cardinality?: 'single';
  output_fields?: ReadonlyArray<{
    name: string;
    type: string;
    description?: string;
    items?: { type: string };
  }>;
  args?: ReadonlyArray<Record<string, unknown>>;
  errors?: readonly string[];
  example?: { args: readonly string[] };
}

interface SchemaDocument {
  clispec: '0.3';
  name: string;
  version: string;
  description: string;
  output: { tty: 'text'; piped: 'json' };
  global_args: ReadonlyArray<Record<string, unknown>>;
  commands: SchemaCommand[];
  errors: ReadonlyArray<Record<string, unknown>>;
}

/** clispec 0.3 document. Built from the version argument so schema needs no Wine and no config. */
function schemaDocument(version: string): SchemaDocument {
  const stringField = (name: string, description: string) => ({ name, type: 'string', description });
  return {
    clispec: '0.3',
    name: PROGRAM,
    version,
    description:
      'Language server that syntax-checks C and C++ buffers with Microsoft Visual C++ 6.0.',
    output: { tty: 'text', piped: 'json' },
    global_args: [
      {
        name: '--output',
        short: '-o',
        type: 'string',
        enum: ['auto', 'text', 'json'],
        default: 'auto',
        description:
          'Format for schema, help, version, and usage errors. auto is text on a terminal and JSON otherwise. schema is always JSON. The serving process ignores this flag. No configuration or secrets are accepted on the command line.',
      },
    ],
    commands: [
      {
        name: 'schema',
        description:
          'Print this clispec 0.3 document and exit. Does not start the server, open Wine, or read configuration. An optional command path keeps that command and commands under it.',
        effects: 'read_only',
        cardinality: 'single',
        output_fields: [
          stringField('clispec', 'Spec version. Always 0.3.'),
          stringField('name', 'Program name.'),
          stringField('version', 'Package version.'),
          { name: 'description', type: 'string' },
          { name: 'output', type: 'object', description: 'Default format on a terminal and on a pipe.' },
          { name: 'global_args', type: 'array', items: { type: 'object' } },
          { name: 'commands', type: 'array', items: { type: 'object' } },
          { name: 'errors', type: 'array', items: { type: 'object' } },
        ],
        args: [
          {
            name: 'path',
            type: 'string',
            required: false,
            description:
              'Command path to keep. Omitted, the document lists every command. A path that matches nothing leaves commands empty.',
          },
        ],
        errors: ['usage'],
        example: { args: [] },
      },
      {
        name: 'help',
        description: 'Print usage, the environment variables, and the version. Invoked as --help, -h, or help.',
        effects: 'read_only',
        cardinality: 'single',
        output_fields: [stringField('text', 'The same usage text the text format prints.')],
        errors: ['usage'],
        example: { args: [] },
      },
      {
        name: 'version',
        description: 'Print the package version. Invoked as --version, -V, or version.',
        effects: 'read_only',
        cardinality: 'single',
        output_fields: [stringField('version', 'Package version.')],
        errors: ['usage'],
        example: { args: [] },
      },
      {
        name: 'serve',
        description:
          'Serve LSP on the named transport. Compiles open buffers and publishes diagnostics. It does not edit sources. A second process is not a replay of the first, and a retry cannot be made safe.',
        effects: 'non_idempotent',
        output_kind: 'opaque',
        media_type: 'application/vscode-jsonrpc',
        args: [
          {
            name: '--stdio',
            type: 'boolean',
            description: 'Communicate over stdin and stdout. Exactly one transport is required.',
          },
          {
            name: '--node-ipc',
            type: 'boolean',
            description: 'Communicate over the Node IPC channel. Exactly one transport is required.',
          },
          {
            name: '--socket',
            type: 'integer',
            description: 'Connect to a TCP server on this port, from 1 to 65535. Pass it as --socket=<port>.',
          },
        ],
        errors: ['usage', 'failure'],
        example: { args: ['--stdio'] },
      },
    ],
    errors: [
      {
        kind: 'usage',
        exit_code: USAGE_EXIT_CODE,
        retryable: false,
        description: 'The command line was rejected. Nothing was started.',
      },
      {
        kind: 'failure',
        exit_code: 1,
        retryable: false,
        description:
          'The server failed while starting or while speaking the protocol. Reported as text on stderr, not as a clispec envelope on stdout.',
      },
    ],
  };
}

function filterSchema(document: SchemaDocument, commandPath: string | null): SchemaDocument {
  if (commandPath === null) return document;
  return {
    ...document,
    commands: document.commands.filter(
      (command) => command.name === commandPath || command.name.startsWith(`${commandPath} `),
    ),
  };
}

function renderHelp(version: string, format: RenderFormat, stdoutIsTTY: boolean): string {
  const text = helpText(version);
  return format === 'json' ? formatJson({ text }, stdoutIsTTY) : text;
}

function renderVersion(version: string, format: RenderFormat, stdoutIsTTY: boolean): string {
  return format === 'json' ? formatJson({ version }, stdoutIsTTY) : `${version}\n`;
}

/**
 * Parses the command line. The transport, schema, help, version, and --output
 * are accepted; anything else is a usage error rather than an argument the
 * server reads past, so a typo cannot start a server configured differently
 * from what was asked for.
 *
 * A port is range-checked here because the transport the LSP library opens
 * afterwards reports an out-of-range port as a stack trace and exit 1, which
 * would tell a script the server failed rather than that its command line was
 * wrong.
 *
 * `stdoutIsTTY` decides `auto`. Callers that omit it get text, which is what a
 * terminal shows. The process entry point passes the real stdout.
 */
export function parseArgs(
  argv: readonly string[],
  version: string,
  stdoutIsTTY = true,
): CliOutcome {
  const picked = readOutputMode(argv);
  const format = resolveFormat(picked.mode, stdoutIsTTY);
  if (picked.error !== undefined) return usageError(picked.error, format);

  let transport: string | null = null;
  let command: InfoCommand | null = null;
  let schemaPath: string | null = null;
  let sawSchemaPath = false;

  const select = (name: string): CliOutcome | null => {
    if (transport === null || transport === name) {
      transport = name;
      return null;
    }
    return usageError(`more than one transport given ('${transport}' and '${name}')`, format);
  };

  const selectCommand = (name: InfoCommand): CliOutcome | null => {
    if (command !== null && command !== name) {
      return usageError(`more than one command given ('${command}' and '${name}')`, format);
    }
    command = name;
    return null;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '-o' || arg === '--output') {
      i++;
      continue;
    }
    if (arg.startsWith('--output=') || arg.startsWith('-o=')) continue;

    if (arg === '--stdio' || arg === '--node-ipc') {
      const clash = select(arg);
      if (clash) return clash;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      const clash = selectCommand('help');
      if (clash) return clash;
      continue;
    }
    if (arg === '--version' || arg === '-V') {
      const clash = selectCommand('version');
      if (clash) return clash;
      continue;
    }
    if (arg.startsWith('--socket=')) {
      const port = arg.slice('--socket='.length);
      if (!/^\d+$/.test(port)) {
        return usageError(`--socket needs a port number, got '${port}'`, format);
      }
      const value = Number(port);
      if (value < MIN_PORT || value > MAX_PORT) {
        return usageError(
          `--socket needs a port between ${MIN_PORT} and ${MAX_PORT}, got '${port}'`,
          format,
        );
      }
      const clash = select(arg);
      if (clash) return clash;
      continue;
    }
    if (arg.startsWith('-')) {
      return usageError(`unknown option '${arg}'`, format);
    }

    // The token after `schema` is a filter, including when that token is itself
    // a command name (`schema help`). A later stray word is still an error.
    if (command === 'schema' && !sawSchemaPath) {
      schemaPath = arg;
      sawSchemaPath = true;
      continue;
    }
    if (arg === 'schema' || arg === 'help' || arg === 'version') {
      if (command !== null) return usageError(`unexpected argument '${arg}'`, format);
      command = arg;
      continue;
    }
    return usageError(`unexpected argument '${arg}'`, format);
  }

  if (command === 'help') {
    return { kind: 'exit', code: 0, stdout: renderHelp(version, format, stdoutIsTTY), stderr: '' };
  }
  if (command === 'version') {
    return { kind: 'exit', code: 0, stdout: renderVersion(version, format, stdoutIsTTY), stderr: '' };
  }
  if (command === 'schema') {
    if (transport !== null) return usageError('schema does not take a transport', format);
    return {
      kind: 'exit',
      code: 0,
      stdout: formatJson(filterSchema(schemaDocument(version), schemaPath), stdoutIsTTY),
      stderr: '',
    };
  }

  // The server has no default transport to fall back on, so a bare invocation
  // names the three that exist rather than failing inside the LSP library.
  if (transport === null) {
    return usageError('no transport selected; pass --stdio, --node-ipc, or --socket=<port>', format);
  }

  return { kind: 'serve' };
}

/**
 * Runs the command line and, when the process is not to serve, writes the
 * outcome's streams and exits with its code. Help, version, and schema go to
 * stdout so a script can capture them; a usage error goes to stderr and exits
 * 2, so a script that ignores it does not read an error page as the server's
 * output. While serving, stdout is LSP frames only: this function writes
 * nothing in that case, including when -o json was passed.
 */
export function runCli(argv: readonly string[] = process.argv.slice(2)): void {
  const outcome = parseArgs(argv, readVersion(), process.stdout.isTTY === true);
  if (outcome.kind === 'serve') return;

  if (outcome.stdout) process.stdout.write(outcome.stdout);
  if (outcome.stderr) process.stderr.write(outcome.stderr);
  process.exit(outcome.code);
}
