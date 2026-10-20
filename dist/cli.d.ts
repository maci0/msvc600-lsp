/** Exit code for a usage error: bad flag, missing value, stray argument. */
export declare const USAGE_EXIT_CODE = 2;
/**
 * What the command line asked for. `serve` is the only outcome that leaves the
 * process running; every other outcome prints its streams and exits with the
 * given code, so the exit code and the text stay attached to each other.
 */
export type CliOutcome = {
    kind: 'serve';
} | {
    kind: 'exit';
    code: number;
    stdout: string;
    stderr: string;
};
/**
 * The package version, read from the manifest that ships next to the compiled
 * entry point. A missing or unreadable manifest is not a reason to refuse to
 * start, so it degrades to `unknown`.
 */
export declare function readVersion(rootDir?: string): string;
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
export declare function parseArgs(argv: readonly string[], version: string, stdoutIsTTY?: boolean): CliOutcome;
/**
 * Runs the command line and, when the process is not to serve, writes the
 * outcome's streams and exits with its code. Help, version, and schema go to
 * stdout so a script can capture them; a usage error goes to stderr and exits
 * 2, so a script that ignores it does not read an error page as the server's
 * output. While serving, stdout is LSP frames only: this function writes
 * nothing in that case, including when -o json was passed.
 */
export declare function runCli(argv?: readonly string[]): void;
//# sourceMappingURL=cli.d.ts.map