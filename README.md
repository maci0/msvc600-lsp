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

- **Bun** — runs every script in `package.json`, including `build`, `test`, and `start`
- **Node.js ≥ 18**
- **Wine** (Linux/macOS) or native Windows
- **MSVC 6.0 installation**: `VC/VC98/{BIN,INCLUDE,LIB}` must be present at the package root, since that path is the default `msvcBasePath`. On Linux, `bun run setup` mirrors the tree into `~/.wine/drive_c/msvc6` with a lowercased copy of every file, because MSVC headers use mixed-case `#include` lines that do not resolve on a case-sensitive filesystem. The script is Linux-only (it writes to `~/.wine/drive_c`), so on macOS point `includePaths` at `VC/VC98/INCLUDE` instead.

The test suite is an integration suite: it spawns the real `CL.EXE` through Wine, so Wine and an MSVC 6.0 install are required to run `bun run test`.

## Installation

```bash
bun install
bun run build
```

## Usage

```bash
# Start the LSP server on stdio
bun run start
```

Configure your editor's LSP client to launch `bun dist/server.js --stdio`.

### Initialization Options

Pass these in your client's `initializationOptions`:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `msvcBasePath` | `string` | `<pkg>/VC/VC98` | Root of the MSVC 6.0 installation |
| `clPath` | `string` | `<base>/BIN/CL.EXE` | Absolute path to CL.EXE |
| `includePaths` | `string[]` | `["C:\\msvc6\\include"]` under Wine, `[<base>/INCLUDE]` on Windows | Directories passed as `/I` to CL.EXE, where absolute POSIX entries are converted to Wine paths |
| `warnLevel` | `0-4` | `4` | Warning level (`/W0`–`/W4`) |
| `additionalFlags` | `string[]` | `[]` | Extra flags forwarded verbatim |
| `wineExecutable` | `string` | `"wine"` | Path to the Wine binary |
| `useWine` | `boolean` | `true` on non-Windows | Whether to invoke CL.EXE through Wine |

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

Other fields (especially `additionalFlags`) cannot be changed at runtime, so a runtime notification cannot inject CL.EXE flags. They are still set freely at startup, where the client also picks `clPath` and `wineExecutable`, so anything able to speak the server's stdio channel can choose the binary that runs and the flags it receives. See `docs/THREAT_MODEL.md`. Fields that fail validation are dropped rather than rejected, so a bad value silently leaves the previous one in place. Changing the config re-validates every open document.

## Architecture

```
src/
├── config.ts         # Configuration types, validation, Wine path conversion
├── compiler.ts       # CL.EXE invocation (syntax-check mode)
├── diagnostics.ts    # MSVC output parser → LSP Diagnostic conversion
├── observability.ts  # Structured log lines, repeat suppression, validation counters
└── server.ts         # LSP server lifecycle, debouncing, abort handling
```

**Key design decisions:**

- **Temp files + abort controllers**: Each validation writes to a unique temp file and tracks an `AbortController`. New edits abort stale in-flight checks.
- **Sequence numbers**: A per-URI counter discards results from stale validations that complete after a newer one started.
- **Security boundary**: Runtime config changes cannot touch `additionalFlags` or the executable paths, which are fixed at initialization. That limits a notification to include paths and warning level; it does not constrain what the client sends at startup.

## Troubleshooting

Every event the server emits is one `window/logMessage` line in the editor's LSP output channel, formatted as `<ISO timestamp> <level> <message> key=value ...`. Levels are `error` for a check that produced nothing, `warn` for output that was truncated, and `info` for startup, slow checks, and nothing else. Identical lines are collapsed within a minute and the next occurrence carries `repeat=<n>`, so a CL.EXE that cannot be spawned logs once instead of once per keystroke.

Send the `msvc6/status` request to read the counters for the running server:

```jsonc
// request
{ "jsonrpc": "2.0", "id": 1, "method": "msvc6/status", "params": {} }
// result: uptime, and validations { started, completed, failed, aborted,
// timedOut, truncated, total/max/last duration, last success and failure
// timestamps, last failure }, plus the configured clPath and wineExecutable
```

The two failures worth separating are `compiler could not be started` (the log carries `code=ENOENT|EACCES|ENOTDIR` and the `executable` that failed, so a missing Wine prefix is distinct from a missing CL.EXE) and `validation timed out` (CL.EXE exceeded 30 s and was killed; the buffer is not checked, and its diagnostics are cleared).

## Supported File Types

| Extension | Language | CL.EXE Flag |
|-----------|----------|-------------|
| `.c` | C | `/TC` |
| `.cpp`, `.cxx`, `.cc` | C++ | `/TP` |
| `.hpp`, `.hxx` | C++ header | `/TP` |
| `.h` | C/C++ header | (none — inferred by CL.EXE) |

## Limits

The open buffer is checked as a standalone translation unit, so a header that relies on types or include guards supplied by a `.c` file reports errors a real build would not.

Diagnostics are line-scoped: each one spans columns 0 to the end of the reported line, because CL.EXE gives no column numbers for these messages. A check is killed after 30 s, and output past 1 MiB is truncated, which drops the tail of the diagnostic list.

## Development

```bash
bun run test          # Run test suite
bun run test:watch    # Watch mode
bun run build         # Compile TypeScript
bun run watch         # Watch + compile
bun run setup         # Mirror MSVC6 into the Wine prefix with lowercased copies (Linux only)
```

## License

None declared yet. The repository ships no license file, so no permission to use or redistribute the code has been granted.
