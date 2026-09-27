# msvc600-lsp

An LSP server that provides real-time C/C++ syntax checking using Microsoft Visual C++ 6.0 (MSVC6) running under Wine on Linux/macOS.

## How It Works

The server intercepts `textDocument/didOpen`, `textDocument/didChange`, and `textDocument/didSave` events from your editor. For each change it:

1. Writes the buffer to a temp file
2. Invokes `CL.EXE /Zs` (syntax-check only) through Wine
3. Parses MSVC's diagnostic output into LSP `Diagnostic` objects
4. Publishes them back to the editor

Debouncing (300 ms by default, see `debounceMs`) and abort-on-stale ensure only the latest edit triggers a check.

## Prerequisites

- **Node.js ≥ 18**
- **Wine** (Linux/macOS) or native Windows
- **MSVC 6.0 installation** — the `VC/VC98` directory must be present at the package root (use `bun run setup` to configure include paths)

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

### Configuration

Every setting has three sources. Later entries win:

1. Built-in defaults
2. Environment variables
3. `initializationOptions` from your client

`initializationOptions` is validated during `initialize`. An unknown key, a value of the wrong type, a `warnLevel` outside 0-4, or a `clPath` that does not exist fails the handshake with a message naming the offending field, instead of starting a server that misbehaves on the first keystroke. The same applies to environment variables at startup.

#### Fields

| Field | Type | Default | Environment variable | Description |
|-------|------|---------|----------------------|-------------|
| `msvcBasePath` | `string` | `<pkg>/VC/VC98` | `MSVC6LSP_MSVC_BASE_PATH` | Root of the MSVC 6.0 installation |
| `clPath` | `string` | `<base>/BIN/CL.EXE` | `MSVC6LSP_CL_PATH` | Absolute path to CL.EXE |
| `includePaths` | `string[]` | `["C:\\msvc6\\include"]` | `MSVC6LSP_INCLUDE_PATHS` | Directories passed as `/I` to CL.EXE |
| `warnLevel` | `0-4` | `4` | `MSVC6LSP_WARN_LEVEL` | Warning level (`/W0`–`/W4`) |
| `additionalFlags` | `string[]` | `[]` | `MSVC6LSP_ADDITIONAL_FLAGS` | Extra flags forwarded verbatim |
| `wineExecutable` | `string` | `"wine"` | `MSVC6LSP_WINE_EXECUTABLE` | Path to the Wine binary |
| `useWine` | `boolean` | `true` on non-Windows | `MSVC6LSP_USE_WINE` | Whether to invoke CL.EXE through Wine |
| `debounceMs` | `0`-`60000` | `300` | `MSVC6LSP_DEBOUNCE_MS` | Idle time before an edit is checked |
| `checkTimeoutMs` | `1000`-`600000` | `30000` | `MSVC6LSP_CHECK_TIMEOUT_MS` | Wall-clock limit for one CL.EXE run |
| `tempDir` | `string` | the system temp dir | `MSVC6LSP_TEMP_DIR` | Directory for the buffers handed to CL.EXE |

- List-valued variables (`MSVC6LSP_INCLUDE_PATHS`, `MSVC6LSP_ADDITIONAL_FLAGS`) are separated by `;`, the form CL.EXE itself uses, so Windows-style entries survive on any platform.
- `MSVC6LSP_USE_WINE` accepts `true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off`.
- Overriding `msvcBasePath` without giving `includePaths` retargets the include paths at that root: `C:\msvc6\include` under Wine, `<base>/INCLUDE` on Windows.
- A variable set to an empty string is an error, not an unset variable.

#### Runtime Configuration

`workspace/didChangeConfiguration` may change `includePaths`, `warnLevel`, and `debounceMs`. Everything else, especially `additionalFlags`, is locked to startup to prevent arbitrary CL.EXE flag injection. Rejected values are reported in the client's LSP log; they never take the server down.

#### Verifying the active configuration

The server logs its effective configuration as a `window/logMessage` during `initialize`, with paths under your home directory shortened to `~`. It shows up in your editor's LSP output channel (VS Code: Output -> Language Server) and is the fastest way to confirm which source won.

## Architecture

```
src/
├── config.ts       # Configuration types, validation, Wine path conversion
├── compiler.ts     # CL.EXE invocation (syntax-check mode)
├── diagnostics.ts  # MSVC output parser → LSP Diagnostic conversion
└── server.ts       # LSP server lifecycle, debouncing, abort handling
```

**Key design decisions:**

- **Temp files + abort controllers**: Each validation writes to a unique temp file and tracks an `AbortController`. New edits abort stale in-flight checks.
- **Sequence numbers**: A per-URI counter discards results from stale validations that complete after a newer one started.
- **Security boundary**: Runtime config changes are restricted to non-executable fields to prevent CL.EXE flag injection.

## Supported File Types

| Extension | Language | CL.EXE Flag |
|-----------|----------|-------------|
| `.c` | C | `/TC` |
| `.cpp`, `.cxx`, `.cc` | C++ | `/TP` |
| `.hpp`, `.hxx` | C++ header | `/TP` |
| `.h` | C/C++ header | (none — inferred by CL.EXE) |

## Development

```bash
bun run test          # Run test suite
bun run test:watch    # Watch mode
bun run build         # Compile TypeScript
bun run watch         # Watch + compile
bun run setup         # Configure Wine include paths
```

## License

See project root for license information.
