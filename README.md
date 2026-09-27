# msvc600-lsp

An LSP server that provides real-time C/C++ syntax checking using Microsoft Visual C++ 6.0 (MSVC6) running under Wine on Linux/macOS.

## How It Works

The server intercepts `textDocument/didOpen`, `textDocument/didChange`, and `textDocument/didSave` events from your editor. For each change it:

1. Writes the buffer to a temp file
2. Invokes `CL.EXE /Zs` (syntax-check only) through Wine
3. Parses MSVC's diagnostic output into LSP `Diagnostic` objects
4. Publishes them back to the editor

Debouncing (300 ms by default, `debounceMs`) and abort-on-stale ensure only the latest edit triggers a check.

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

Settings come from three layers. Precedence, lowest to highest:

1. built-in defaults
2. `MSVC6_*` environment variables
3. client `initializationOptions`

Every layer is validated at startup. A value that fails validation (wrong type,
out of range, misspelled key or variable) is reported in the client's output
log and the lower-precedence value is kept, so a typo never silently changes
behavior. The resolved config is logged on `initialize` and on every runtime
config change.

| Field | Env var | Type | Default | Description |
|-------|---------|------|---------|-------------|
| `msvcBasePath` | `MSVC6_BASE_PATH` | `string` | `<pkg>/VC/VC98` | Root of the MSVC 6.0 installation |
| `clPath` | `MSVC6_CL_PATH` | `string` | `<base>/BIN/CL.EXE` | Absolute path to CL.EXE |
| `includePaths` | `MSVC6_INCLUDE_PATHS` | `string[]` | `["C:\\msvc6\\include"]` | Directories passed as `/I` to CL.EXE, separated by `:` (`;` on Windows) |
| `warnLevel` | `MSVC6_WARN_LEVEL` | `0-4` | `4` | Warning level (`/W0`–`/W4`) |
| `additionalFlags` | `MSVC6_ADDITIONAL_FLAGS` | `string[]` | `[]` | Extra flags forwarded verbatim, whitespace separated |
| `wineExecutable` | `MSVC6_WINE_EXECUTABLE` | `string` | `"wine"` | Path to the Wine binary |
| `useWine` | `MSVC6_USE_WINE` | `boolean` | `true` on non-Windows | Whether to invoke CL.EXE through Wine |
| `compileTimeoutMs` | `MSVC6_COMPILE_TIMEOUT_MS` | `number` | `30000` | Wall-clock limit for one CL.EXE run |
| `maxOutputBytes` | `MSVC6_MAX_OUTPUT_BYTES` | `number` | `1048576` | Output captured before truncation |
| `debounceMs` | `MSVC6_DEBOUNCE_MS` | `number` | `300` | Delay between last edit and a check |

`includePaths` and `additionalFlags` accept an empty string to mean "no
entries"; every other setting treats an empty string as an error. Setting only
`msvcBasePath` re-derives `clPath` as `<base>/BIN/CL.EXE`. See `.env.example`
for a copyable template.

At startup the server checks that `clPath` and each include path exist and logs
a clear message when one does not. Wine drive paths (`C:\msvc6\...`) are
resolved by Wine, not the host filesystem, so they are not host-checked.

### Runtime Configuration

`workspace/didChangeConfiguration` accepts `includePaths`, `warnLevel`, and
`debounceMs` under the `msvc6` key. Other fields, especially `additionalFlags`,
are locked to initialization to prevent arbitrary CL.EXE flag injection. The
change is re-validated and the resolved config is logged.

## Architecture

```
src/
├── config.ts       # Config schema, env loading, validation, path checks, Wine path conversion
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
