# Threat model: msvc600-lsp

Last reviewed: 2026-09-27. Reviewed against commit `15e6f72` and the
uncommitted `src/`, `scripts/`, `package.json` tree.

The server runs as a local process, started by an editor, and speaks LSP over
stdio. There is no network listener, no database, and no credential store, so
the attack surface is small. The whole model reduces to two questions: who can
speak the stdio channel, and who controls the command line that reaches
`CL.EXE`.

## Risk-ranked summary

| # | Threat | Boundary | Impact | Existing control |
|---|--------|----------|--------|------------------|
| 1 | Initialization options choose the executable and the flags | client to server (initializationOptions) | Arbitrary program execution and file writes as the editing user | None. Deliberate, but undocumented in README |
| 2 | A hostile client sets `includePaths` to a directory it controls | server to CL.EXE | Header shadowing turns any open C/C++ file into attacker-chosen compile input | `validateConfig` type checks only (`src/config.ts:76-81`) |
| 3 | `didChangeConfiguration` revalidates every open document, no concurrency cap | client to server | Process and memory exhaustion, editor stall | Debounce and abort per URI only (`src/server.ts:84-92`) |
| 4 | Document text is written to a shared temp directory | server to filesystem | Source code exposure to other local users; temp leak on crash | `0o600` mode and random names (`src/server.ts:179-182`) |
| 5 | `CL.EXE` stdout is parsed with a regex and republished to the editor | compiler to editor | Malformed or hostile output reaching the UI; diagnostic spoofing | File-path filter to the temp file only (`src/diagnostics.ts:97`) |
| 6 | The include overlay lowercases header names into `~/.wine` | setup script to filesystem | A header named `stdio.h` can be shadowed by a differently-cased one | None. `scripts/setup-includes.sh:23-49` |
| 7 | No audit trail for security events | all | Incidents cannot be reconstructed | Errors only reach `connection.console.error` |

## 1. Attack surface

Entry points, all of them local. There is no HTTP, RPC, webhook, or network
listener in the tree.

| Entry point | Location | Source of input |
|-------------|----------|-----------------|
| stdio JSON-RPC connection | `src/server.ts:20`, `src/server.ts:211` | The spawning editor, or anything that can exec the process and write to its stdin |
| `initialize` / `initializationOptions` | `src/server.ts:43` | Client-supplied object, merged into config |
| `workspace/didChangeConfiguration` | `src/server.ts:67` | Client-supplied `settings.msvc6` |
| `textDocument/didOpen`, `didChange` (full sync) | `src/server.ts:95` | Full document text, unbounded in size |
| `textDocument/didSave` | `src/server.ts:112` | Document identity |
| `textDocument/didClose` | `src/server.ts:124` | Document identity |
| Document URI (used to pick the extension) | `src/server.ts:144` | Client-supplied string, parsed with `URI.parse` |
| `CL.EXE` stdout and stderr | `src/diagnostics.ts:41` | Compiler output parsed by regex |
| Process environment | `src/compiler.ts:82` | Inherited in full; the server only adds `WINEDEBUG=-all` |
| `bun run setup` | `scripts/setup-includes.sh:10` | Writes to `$HOME/.wine/drive_c/msvc6` |

No admin port, no debug endpoint, no default service. The only runtime
dependency surface is the four `vscode-languageserver*` packages and
`vscode-uri` in `package.json:18-23`.

## 2. Trust boundaries

1. **Client to server.** Unauthenticated. Anything that can start the process
   or write to its stdin is the client; there is no token, no handshake, no
   origin check. This is inherent to stdio LSP, so the mitigation is
   deployment, not code: the server must be launched by the user's editor and
   not exposed as a service.
2. **Server to `CL.EXE`.** `execFile` with an argument vector
   (`src/compiler.ts:86`). No shell, so no metacharacter injection. The
   argument vector is assembled from config in `src/compiler.ts:23-46`.
3. **Server to Wine.** On non-Windows the config-supplied `wineExecutable` is
   the program that is actually exec'd (`src/compiler.ts:79-80`).
4. **Server to temp filesystem.** Full document text at `os.tmpdir()`
   (`src/server.ts:179-182`).
5. **Compiler output to editor.** Compiled text is turned into diagnostics and
   shown in the editor (`src/diagnostics.ts:92`).
6. **Setup script to `$HOME`.** `scripts/setup-includes.sh` copies binaries and
   libraries into the Wine prefix.

## 3. Assets

- Source code under edit, which passes through the process and the temp
  directory.
- The user's filesystem, reachable through `includePaths` and through any
  `additionalFlags` accepted at startup.
- The Wine prefix at `~/.wine/drive_c`, including every `CL.EXE` invocation
  path.
- Editor availability: every validation is a process spawn, and under Wine a
  heavyweight one.

## 4. Threats per boundary

**Client to server**

- *Elevation of privilege.* `initializationOptions` accepts `clPath`,
  `wineExecutable`, and `additionalFlags`
  (`src/config.ts:73-75`, `src/config.ts:90-102`). A client that reaches the
  stdio channel picks which binary runs and can pass flags such as `/Fo` or
  `/Fe`, which make `CL.EXE` write files. Runtime reconfiguration cannot do
  this (`src/server.ts:75-79`), but startup can, so the startup path is the
  privileged one.
- *Tampering.* `includePaths` from either source is passed to `/I`
  (`src/compiler.ts:28-33`). A client that controls an include directory
  controls the headers the preprocessor sees for every open file.
- *Denial of service.* `didChangeConfiguration` iterates all open documents
  and spawns a check for each (`src/server.ts:84-92`) with no cap on
  concurrent children. Document text is also unbounded, and the LSP layer
  accepts an unbounded number of open documents.
- *Information disclosure.* Diagnostics are filtered to the temp file
  (`src/diagnostics.ts:97`), so a diagnostic for another path is dropped, but
  the message text itself is compiler-controlled and reaches the editor UI.

**Server to filesystem**

- *Information disclosure.* Temp files hold complete file contents. The name
  is a random UUID and the mode is `0o600`, which leaves only the shared
  directory listing and crash leftovers. A process killed between write and
  unlink leaves the content behind; `os.tmpdir()` is not cleaned by the server.

**Compiler output to editor**

- *Tampering / spoofing.* The diagnostic regex
  (`src/diagnostics.ts:26-27`) accepts any text matching
  `file(line): error CODE: message`. Since only the temp file passes the
  filter, injected diagnostics land on the file being edited and display a
  message chosen by whatever produced the output.

**Setup script**

- *Tampering.* The overlay copies every header twice, original and lowercased
  (`scripts/setup-includes.sh:23-31`). On a case-insensitive lookup two
  different files can resolve to the same name, so a header that arrives with
  the MSVC tree decides which one is found.

## 5. Mitigations

Implemented:

- Argument vectors instead of a shell, so config values cannot smuggle in
  shell syntax: `src/compiler.ts:86`.
- `execFile` with `timeout: 30000`, `maxBuffer: 1 MiB`, an `AbortSignal` and
  `SIGKILL`: `src/compiler.ts:90`.
- Runtime configuration is restricted to `includePaths` and `warnLevel`;
  `additionalFlags` is rejected there: `src/server.ts:75-79`.
- Type and range validation of every config field: `src/config.ts:65-108`.
- Debounce and per-URI abort discard stale work: `src/server.ts:95-110`,
  `src/server.ts:167-170`.
- Per-URI sequence numbers stop an older result from overwriting a newer one:
  `src/server.ts:163-186`.
- Temp files are unlinked in a `finally` block: `src/server.ts:198-207`.
- Document extension is checked against an allowlist before any work is done:
  `src/server.ts:157-160`.

Not implemented, ranked by exploitability then impact:

1. No restriction on what startup configuration may set, including the
   executable path. Any process that can open the stdio channel gets
   `additionalFlags` and `clPath`.
2. No cap on concurrent `CL.EXE` children, and no cap on open documents.
3. No bound on document size before it is written to disk.
4. No authentication or provenance check on the stdio peer.
5. No logging of configuration changes, so a client that alters the toolchain
   leaves no trace beyond diagnostics.

Single points of failure: the `validateConfig` allowlist is the only control
between the client and the command line, and the extension allowlist at
`src/server.ts:157-160` is the only control that decides whether a document
reaches the compiler at all.

## 6. Abuse cases

- A malicious workspace or editor extension opens a file, then sends
  `didChangeConfiguration` repeatedly with a wide `includePaths` list. Each
  message forces a revalidation of every open document, spawning one Wine
  process per document with no concurrency limit
  (`src/server.ts:84-92`).
- A document with a hostile `#include` name reaches `CL.EXE`; the resulting
  error text is republished verbatim as a diagnostic message
  (`src/diagnostics.ts:105-107`), which is the only way untrusted text is
  rendered in the editor.
- A hostile client that reaches the stdio channel sets
  `additionalFlags: ["/Fe<path>"]` at initialization and the next validation
  writes a file. The runtime path blocks this; the startup path does not.
- Nothing in the tree is enforced client-side only, but the deployment rule
  that only a real editor starts the server is currently unwritten anywhere.

## 7. Response readiness

- Security-relevant events (toolchain path changes, spawn failures) are only
  written to `connection.console.error` (`src/server.ts:62`,
  `src/server.ts:89`, `src/server.ts:106`). There is no persistent audit
  trail.
- There is no `SECURITY.md` and no documented route from a reported
  vulnerability to a shipped fix. No contact is recorded here, because
  inventing one would be worse than the gap.
- Owner and review cadence are unassigned.

## Known documentation drift

`README.md` described the runtime restriction as a security boundary without
saying that startup configuration grants full control of the executable and
the flags. That wording was corrected; the underlying behavior is unchanged
and is recorded above as threat 1.
