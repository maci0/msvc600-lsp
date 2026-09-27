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
- **ShellCheck** — lints `scripts/*.sh` as part of `bun run check`
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
├── config.ts       # Configuration types and validation
├── wine-path.ts    # POSIX ↔ Wine path conversion
├── compiler.ts     # CL.EXE invocation (syntax-check mode)
├── diagnostics.ts  # MSVC output parser → LSP Diagnostic conversion
├── scheduler.ts    # Debounce timer boundary (real timer, or a stepped one in simulation)
├── tempfile.ts     # Temp-file boundary: real filesystem, or an in-memory simulated store
└── server.ts       # LSP server lifecycle, debouncing, abort handling
```

**Key design decisions:**

- **Temp files + abort controllers**: Each validation writes to a unique temp file and tracks an `AbortController`. New edits abort stale in-flight checks, and a startup sweep removes scratch files left behind by a crashed run. The file is created exclusively with mode `0600`, so a file or symlink another local user planted at that path is never written through.
- **Nondeterministic edges are injected**: Disk writes go through `TempFileStore` and the debounce goes through `Scheduler`, so a run can be replayed from a recorded call sequence with reproducible file names. Production keeps `crypto.randomUUID` names and `0o600` files; a simulation supplies its own store and scheduler.
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

Diagnostics are line-scoped: each one spans columns 0 to the end of the reported line, because CL.EXE gives no column numbers for these messages. A check is killed after 30 s, and output past 1 MiB is truncated, which drops the tail of the diagnostic list.

At most four `CL.EXE` children run at once; the rest queue, so a large revalidation after a settings change cannot spawn a process per open document. Buffers above 8 MiB are not written to the temp directory at all, and the editor shows a single `msvc6-too-large` note in their place.

## Development

```bash
bun run doctor        # Preflight: name every missing prerequisite before a test fails on it
bun run setup         # Mirror MSVC6 into the Wine prefix with lowercased copies (Linux only)
bun run build         # Compile TypeScript
bun run typecheck     # Type-check src/ and tests/
bun run test          # Run test suite
bun run test:unit     # Tests that run without Wine or an MSVC 6.0 install
bun run test:watch    # Watch mode
bun run watch         # Watch + compile
bun run check         # The pre-push gate: typecheck, then the full test suite
```

`bun run check` is what `CONTRIBUTING.md` asks you to run before every push. For running a
single file or a single test by name, see "Test layout" in `CONTRIBUTING.md`.

## License

None declared yet. The repository ships no license file, so no permission to use or redistribute the code has been granted.
