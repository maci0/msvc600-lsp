# msvc600-lsp

An LSP server that provides real-time C/C++ syntax checking using Microsoft Visual C++ 6.0 (MSVC6) running under Wine on Linux/macOS.

## How It Works

The server intercepts `textDocument/didOpen`, `textDocument/didChange`, and `textDocument/didSave` events from your editor. For each change it:

1. Writes the buffer to a temp file
2. Invokes `CL.EXE /Zs` (syntax-check only) through Wine
3. Parses MSVC's diagnostic output into LSP `Diagnostic` objects
4. Publishes them back to the editor

Debouncing (300 ms) and abort-on-stale ensure only the latest edit triggers a check.

## Prerequisites

- **Bun 1.4.0** — runs every script in `package.json`, including `build`, `test`, and `start`. The
  version is pinned by `packageManager` in `package.json`, which is what wrote `bun.lock`; `bun run
  doctor` reports a mismatch.
- **Node.js ≥ 18**
- **ShellCheck** — lints `scripts/*.sh` as part of `bun run check`, which is the one command that needs a POSIX shell and ShellCheck; `typecheck`, `test`, and `build` run everywhere CI runs them.
- **Wine** (Linux/macOS) or native Windows
- **MSVC 6.0 installation**: `VC/VC98/{BIN,INCLUDE,LIB}` must be present at the package root, since that path is the default `msvcBasePath`. On Linux, `bun run setup` mirrors the tree into the Wine prefix (`$WINEPREFIX/drive_c/msvc6`, or `~/.wine/drive_c/msvc6` when `WINEPREFIX` is unset) with a lowercased copy of every file, because MSVC headers use mixed-case `#include` lines that do not resolve on a case-sensitive filesystem. The script is Linux-only (it writes to the prefix's `drive_c`), so on macOS point `includePaths` at `VC/VC98/INCLUDE` instead.

The test suite is an integration suite: it spawns the real `CL.EXE` through Wine, so Wine and an MSVC 6.0 install are required to run `bun run test`.

## Installation

```bash
bun install
bun run build
```

CI installs with `bun install --frozen-lockfile`, so a stale `bun.lock` fails the build rather than
resolving to something new. Use the same flag when you want to know your tree matches the lockfile.

## Usage

```bash
# Start the LSP server on stdio
bun run start
```

Configure your editor's LSP client to launch `bun dist/server.js --stdio`.

### Command Line

```
Usage: msvc600-lsp [options]

Options:
      --stdio           communicate over stdin/stdout
      --node-ipc        communicate over the Node IPC channel
      --socket=<port>   connect to a TCP server on <port>
  -h, --help            print this help and exit
  -V, --version         print the version and exit
```

`--help` also lists every `MSVC600_*` variable and ends with the running version, so it is the
one command to read when setting a client up.

The server has no default transport, so a bare `msvc600-lsp` is a usage error rather than a
crash, and naming two transports is a usage error rather than a silent choice of the first.
`--socket` takes a port from 1 to 65535; anything else is rejected before the connection is
opened, because a bad port otherwise surfaces as a stack trace and exit 1. Exit codes: `0`
success, `1` the server failed to start, `2` bad argument. `--help` and `--version` write to
stdout; a usage error writes to stderr and leaves stdout empty, so a script capturing stdout never
reads an error page as server output. Nothing else is configurable on the command line:
configuration comes from the environment and from `initializationOptions`, described below.

### Configuration

Values come from three sources. Later wins:

1. Built-in defaults (below)
2. `MSVC600_*` environment variables
3. The client's `initializationOptions`

Two fields, `includePaths` and `warnLevel`, can also be changed while the server runs; see
Runtime Configuration.

A value that fails validation is dropped and reported on the server's log channel
(`window/logMessage` in VS Code, the LSP client's log) naming the field and the reason, so a
misspelled key or a value of the wrong type is visible instead of leaving a default in place
unexplained. The effective configuration is logged once on `initialize`. Nothing in this
configuration is secret, so the log is not redacted.

### Initialization Options

Pass these in your client's `initializationOptions`:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `msvcBasePath` | `string` | `<pkg>/VC/VC98` | Root of the MSVC 6.0 installation |
| `clPath` | `string` | `<base>/BIN/CL.EXE` | Absolute path to CL.EXE. Derived from `msvcBasePath` when omitted |
| `includePaths` | `string[]` | `["C:\\msvc6\\include"]` under Wine, `[<base>/INCLUDE]` on Windows, following `msvcBasePath` when it is set | Directories passed as `/I` to CL.EXE, where absolute POSIX entries are converted to Wine paths |
| `warnLevel` | `0-4` | `4` | Warning level (`/W0`–`/W4`) |
| `additionalFlags` | `string[]` | `[]` | Extra flags forwarded verbatim |
| `wineExecutable` | `string` | `"wine"` | Path to the Wine binary |
| `useWine` | `boolean` | `true` on non-Windows | Whether to invoke CL.EXE through Wine |
| `outputEncoding` | `string` | `"utf8"` | Label `TextDecoder` uses on CL.EXE output. Use the toolchain's console code page (e.g. `cp1252`) if diagnostics come out as mojibake. An unknown label is rejected at load, since it would otherwise throw at decode time |
| `checkTimeoutMs` | `number` | `30000` | Milliseconds before a check is killed. A hung Wine is worse than no diagnostics |
| `maxOutputBytes` | `number` | `1048576` | Cap on captured CL.EXE output. Past it the tail of the diagnostic list is lost |

`outputEncoding` defaults to `utf8` because Wine's UTF-8 console already passes ASCII-safe
CL.EXE output through unchanged. Switch it if diagnostics carry characters above U+007F.

### Environment Variables

Every option above has an environment variable, so a launch that cannot pass
`initializationOptions` (a remote session, a container, an editor that only sets an environment)
configures the same way:

| Variable | Value |
|----------|-------|
| `MSVC600_MSVC_BASE_PATH` | path |
| `MSVC600_CL_PATH` | path |
| `MSVC600_INCLUDE_PATHS` | `;`-separated list (a semicolon, because the entries carry Windows drive letters) |
| `MSVC600_WARN_LEVEL` | `0`-`4` |
| `MSVC600_ADDITIONAL_FLAGS` | `;`-separated list |
| `MSVC600_WINE_EXECUTABLE` | path |
| `MSVC600_USE_WINE` | `true`, `false`, `1`, `0` |
| `MSVC600_OUTPUT_ENCODING` | `TextDecoder` label |
| `MSVC600_CHECK_TIMEOUT_MS` | positive integer |
| `MSVC600_MAX_OUTPUT_BYTES` | positive integer |

```bash
MSVC600_WARN_LEVEL=2 MSVC600_INCLUDE_PATHS='C:\msvc6\include;/opt/msvc/INCLUDE' bun dist/server.js --stdio
```

A variable that is left unset is not applied. A variable set to an empty string is rejected and
logged, because "no include paths" and "no include paths configured" are different setups and
only one of them is what was meant.

### Runtime Configuration

Only `includePaths` and `warnLevel` can be changed at runtime via `workspace/didChangeConfiguration`. The payload is read from the `msvc6` key, and anything else in the settings object is ignored:

```json
{
  "msvc6": {
    "includePaths": ["C:\\msvc6\\include"],
    "warnLevel": 3
  }
}
```

Other fields (especially `additionalFlags`) cannot be changed at runtime, so a runtime notification cannot inject CL.EXE flags. They are still set freely at startup, where the client also picks `clPath` and `wineExecutable`, so anything able to speak the server's stdio channel can choose the binary that runs and the flags it receives. See `docs/THREAT_MODEL.md`. Rejected fields are dropped and logged, so a bad value leaves the previous one in place with a reason attached. Changing the config re-validates every open document.

## Architecture

```
src/
├── cli.ts               # Command-line parsing, help text, exit codes
├── compiler.ts          # CL.EXE invocation (syntax-check mode)
├── concurrency.ts       # Counting semaphore bounding CL.EXE children
├── config.ts            # Configuration types and validation
├── diagnostics.ts       # MSVC output parser → LSP Diagnostic conversion
├── encoding.ts          # Source preparation: BOM strip, lone surrogates, UTF-8 bytes
├── logging.ts           # Control-character stripping for the client log
├── server.ts            # LSP server lifecycle, debouncing, abort handling
├── task-queue.ts        # Bounded per-URI cancellation queue for validations
├── tempfile.ts          # Scratch-source boundary: staging, 0600 writes, stale-file sweep
├── validation-state.ts  # Per-URI generation counter deciding which result may publish
└── wine-path.ts         # POSIX ↔ Wine path conversion
```

**Key design decisions:**

- **Temp files + abort controllers**: Each validation writes to a unique temp file and tracks an `AbortController`. New edits abort stale in-flight checks, and a startup sweep removes scratch files left behind by a crashed run. The file is created exclusively with mode `0600`, so a file or symlink another local user planted at that path is never written through.
- **Validation generations**: A process-wide counter hands each validation a number that is never reused. A result is published only while its number is still the newest one for its URI, so a check that finishes late, or one belonging to a document that was closed and reopened, is discarded.
- **Security boundary**: Runtime config changes cannot touch `additionalFlags` or the executable paths, which are fixed at initialization. That limits a notification to include paths and warning level; it does not constrain what the client sends at startup.

## Supported File Types

| Extension | Language | CL.EXE Flag |
|-----------|----------|-------------|
| `.c` | C | `/TC` |
| `.cpp`, `.cxx`, `.cc` | C++ | `/TP` |
| `.hpp`, `.hxx` | C++ header | `/TP` |
| `.h` | C/C++ header | (none — inferred by CL.EXE) |

## Limits

The open buffer is checked as a standalone translation unit, so a header that relies on types or include guards supplied by a `.c` file reports errors a real build would not.

Diagnostics are line-scoped: each one spans columns 0 to the end of the reported line, because CL.EXE gives no column numbers for these messages. A check is killed after `checkTimeoutMs` (30 s by default), and output past `maxOutputBytes` (1 MiB by default) is truncated, which drops the tail of the diagnostic list.

At most two `CL.EXE` children run at once; the rest queue, so a large revalidation after a settings change cannot spawn a process per open document. Buffers above 8 MiB are not written to the temp directory at all, and the editor shows a single `msvc6-too-large` note in their place.

A check that never ran, whether CL.EXE cannot be spawned or the scratch source cannot be written, publishes one error diagnostic at the top of the file saying so rather than an empty list, so a broken setup never reads as a clean file.

A check that never completes, or that cannot start CL.EXE at all, is reported as an `msvc600-check-failed` diagnostic on the file rather than as an empty list, so a broken toolchain is never mistaken for a clean file. Truncated output still publishes its diagnostics, and the dropped tail is logged to the server log.

## Development

```bash
bun run doctor        # Preflight: name every missing prerequisite before a test fails on it (POSIX shell)
bun run setup         # Mirror MSVC6 into the Wine prefix with lowercased copies (Linux only)
bun run build         # Compile TypeScript
bun run typecheck     # Type-check src/ and tests/
bun run test          # Run test suite
bun run test:unit     # Tests that run without Wine or an MSVC 6.0 install
bun run test:watch    # Watch mode
bun run watch         # Watch + compile
bun run check         # The pre-push gate: shellcheck, typecheck, then the full test suite (needs a POSIX shell)
bun run ci            # What CI runs: frozen-lockfile install, then check
```

`bun run check` is what `CONTRIBUTING.md` asks you to run before every push. For running a
single file or a single test by name, see "Test layout" in `CONTRIBUTING.md`.

Both shell scripts take `--help`. `doctor.sh` writes each missing prerequisite to stderr and
exits 1; `setup-includes.sh` takes `--dest DIR` to mirror the overlay somewhere other than
`$HOME/.wine/drive_c/msvc6`. A bad argument to either is exit code 2.

## License

None granted yet. `package.json` declares `"license": "UNLICENSED"` and the repository ships no
license file, so no permission to use or redistribute the code has been granted.
