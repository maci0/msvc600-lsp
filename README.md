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

### Initialization Options

Pass these in your client's `initializationOptions`:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `msvcBasePath` | `string` | `<pkg>/VC/VC98` | Root of the MSVC 6.0 installation |
| `clPath` | `string` | `<base>/BIN/CL.EXE` | Absolute path to CL.EXE |
| `includePaths` | `string[]` | `["C:\\msvc6\\include"]` | Directories passed as `/I` to CL.EXE |
| `warnLevel` | `0-4` | `4` | Warning level (`/W0`–`/W4`) |
| `additionalFlags` | `string[]` | `[]` | Extra flags forwarded verbatim |
| `wineExecutable` | `string` | `"wine"` | Path to the Wine binary |
| `useWine` | `boolean` | `true` on non-Windows | Whether to invoke CL.EXE through Wine |

### Runtime Configuration

Only `includePaths` and `warnLevel` can be changed at runtime via `workspace/didChangeConfiguration`. Other fields (especially `additionalFlags`) are locked to initialization to prevent arbitrary CL.EXE flag injection.

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
