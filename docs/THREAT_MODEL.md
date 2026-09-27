# Threat model: msvc600-lsp

Last reviewed: 2026-09-27. Reviewed against commit `15e6f72` and the
uncommitted `src/`, `scripts/`, `package.json` tree. Validation concurrency
was subsequently bounded; see `src/task-queue.ts` and section 5.

The server runs as a local process, started by an editor, and speaks LSP over
stdio. There is no network listener, no database, and no credential store, so
the attack surface is small. The whole model reduces to two questions: who can
speak the stdio channel, and who controls the command line that reaches
`CL.EXE`.

## Risk-ranked summary

| # | Threat | Boundary | Impact | Existing control |
|---|--------|----------|--------|------------------|
| 1 | Initialization options choose the executable and the flags | client to server (initializationOptions) | Arbitrary program execution and file writes as the editing user | None. Deliberate, but undocumented in README |
| 2 | A hostile client sets `includePaths` to a directory it controls | server to CL.EXE | Header shadowing turns any open C/C++ file into attacker-chosen compile input | `validateConfig` type checks only (`src/config.ts:112-199`) |
| 3 | `didChangeConfiguration` revalidates every open document | client to server | Process and memory exhaustion, editor stall | `TaskQueue` caps concurrent `CL.EXE` children at 2 (`src/server.ts:68`, `src/task-queue.ts`); debounce and abort per URI (`src/server.ts:164-177`); a notification that changes nothing is a no-op (`src/server.ts:147`) |
| 4 | Document text is written to a shared temp directory | server to filesystem | Source code exposure to other local users; temp leak on crash | `0o600` mode, random names, and an exclusive create (`src/server.ts:282-287`, `src/tempfile.ts:52-54`); orphans from a crashed run are swept at startup (`src/server.ts:335`) |
| 5 | `CL.EXE` stdout is parsed with a regex and republished to the editor | compiler to editor | Malformed or hostile output reaching the UI; diagnostic spoofing | File-path filter to the temp file only (`src/diagnostics.ts:97`) |
| 6 | The include overlay lowercases header names into `~/.wine` | setup script to filesystem | A header named `stdio.h` can be shadowed by a differently-cased one | None. `scripts/setup-includes.sh:23-49` |
| 7 | No audit trail for security events | all | Incidents cannot be reconstructed | Errors only reach `connection.console.error` |

## 1. Attack surface

Entry points, all of them local. There is no HTTP, RPC, webhook, or network
listener in the tree.

| Entry point | Location | Source of input |
|-------------|----------|-----------------|
| stdio JSON-RPC connection | `src/server.ts:40`, `src/server.ts:330` | The spawning editor, or anything that can exec the process and write to its stdin |
| `initialize` / `initializationOptions` | `src/server.ts:81` | Client-supplied object, merged into config |
| `workspace/didChangeConfiguration` | `src/server.ts:127` | Client-supplied `settings.msvc6` |
| `textDocument/didOpen`, `didChange` (full sync) | `src/server.ts:164` | Full document text, unbounded in size |
| `textDocument/didSave` | `src/server.ts:179` | Document identity |
| `textDocument/didClose` | `src/server.ts:189` | Document identity |
| Document URI (used to pick the extension) | `src/server.ts:222` | Client-supplied string, parsed with `URI.parse` |
| `CL.EXE` stdout and stderr | `src/diagnostics.ts:41` | Compiler output parsed by regex |
| Process environment | `src/compiler.ts:200-202` | Inherited in full; the server only adds `WINEDEBUG=-all` |
| `MSVC600_*` environment variables | `src/config.ts:253-289` | Read at startup, below `initializationOptions` in precedence |
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
   (`src/compiler.ts:204`). No shell, so no metacharacter injection. The
   argument vector is assembled from config in `src/compiler.ts:56-79`.
3. **Server to Wine.** On non-Windows the config-supplied `wineExecutable` is
   the program that is actually exec'd (`src/compiler.ts:88-89`).
4. **Server to temp filesystem.** Full document text at `os.tmpdir()`
   (`src/server.ts:282-287`), and, for the entry points that stage content
   themselves, through the `TempFileStore` boundary (`src/tempfile.ts:25`).
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
  (`src/config.ts:23-48`). A client that reaches the
  stdio channel picks which binary runs and can pass flags such as `/Fo` or
  `/Fe`, which make `CL.EXE` write files. Runtime reconfiguration cannot do
  this (`src/server.ts:135-143`), but startup can, so the startup path is the
  privileged one.
- *Elevation of privilege, environment.* `MSVC600_CL_PATH`,
  `MSVC600_WINE_EXECUTABLE`, and `MSVC600_ADDITIONAL_FLAGS` carry the same
  power from the parent process (`src/config.ts:272-312`), below
  `initializationOptions` in precedence. Anything that can start the server
  with a chosen environment therefore picks the binary and its flags without
  speaking the protocol at all. It could already influence `PATH`, which
  decides how the default `wineExecutable` resolves, so the added reach is
  `additionalFlags` and an absolute path outside `PATH`.
- *Tampering.* `includePaths` from either source is passed to `/I`
  (`src/compiler.ts:29-34`). A client that controls an include directory
  controls the headers the preprocessor sees for every open file.
- *Denial of service.* `didChangeConfiguration` queues a check for every open
  document (`src/server.ts:161-162`); the queue runs at most
  `MAX_CONCURRENT_CHECKS` of them at a time (`src/server.ts:68`), so a client
  that resends the notification cannot fan out one child per open file.
  Document text is still unbounded, and the LSP layer accepts an unbounded
  number of open documents.
- *Information disclosure.* Diagnostics are filtered to the temp file
  (`src/diagnostics.ts:97`), so a diagnostic for another path is dropped, but
  the message text itself is compiler-controlled and reaches the editor UI.

**Server to filesystem**

- *Information disclosure.* Temp files hold complete file contents. The name
  is a random UUID and the mode is `0o600`, which leaves only the shared
  directory listing and crash leftovers. A process killed between write and
  unlink leaves the content behind; the startup sweep
  (`sweepStaleTempFiles`) removes it once it is older than an hour.

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
  shell syntax: `src/compiler.ts:204`.
- `execFile` with `timeout: 30000`, `maxBuffer: 1 MiB`, an `AbortSignal` and
  `SIGKILL`: `src/compiler.ts:210-217`.
- Runtime configuration is restricted to `includePaths` and `warnLevel`;
  `additionalFlags` is rejected there: `src/server.ts:135-143`.
- Type and range validation of every config field, with every rejected value
  logged by name: `src/config.ts:112-199`, `src/server.ts:88`, `src/server.ts:95`,
  `src/server.ts:132`.
- `MSVC600_*` environment variables go through the same validation and the
  same issue reporting as the two protocol sources: `src/config.ts:289-330`.
- Debounce and a per-URI abort discard stale work: `src/server.ts:164-177`,
  and `TaskQueue.submit` supersedes the entry already held for its key
  (`src/task-queue.ts`).
- Validation generations never repeat, so a result from before a close cannot
  overwrite a newer one: `src/validation-state.ts`, `src/server.ts:247`, `src/server.ts:290`.
- Concurrent `CL.EXE` children are capped at `MAX_CONCURRENT_CHECKS`:
  `src/server.ts:68`, `src/task-queue.ts`.
- `shutdown` clears the debounce timers, aborts every in-flight child, and
  waits briefly for them to unlink their temp files: `src/server.ts:204-217`.
- Temp files are unlinked in a `finally` block: `src/server.ts:306-312`, and
  leftovers from a killed run are removed at startup: `src/compiler.ts:265-296`.
- Content staged through the `TempFileStore` boundary is written with the same
  `0o600` mode and random name: `src/tempfile.ts:52-54`.
- Document extension is checked against an allowlist before any work is done:
  `src/server.ts:242-244`.

Not implemented, ranked by exploitability then impact:

1. No restriction on what startup configuration may set, including the
   executable path. Any process that can open the stdio channel gets
   `additionalFlags` and `clPath`.
2. No cap on open documents, so the queue's wait list still grows with the
   number of open files.
3. No bound on document size before it is written to disk.
4. No authentication or provenance check on the stdio peer.
5. Configuration is logged to the LSP log channel (`connection.console`),
   which is not a durable audit trail: a client that alters the toolchain
   leaves a trace only for as long as the client keeps its log.

Single points of failure: the `validateConfig` allowlist is the only control
between the client and the command line, and the extension allowlist at
`src/server.ts:242` is the only control that decides whether a document
reaches the compiler at all.

## 6. Abuse cases

- A malicious workspace or editor extension opens a file, then sends
  `didChangeConfiguration` repeatedly with a wide `includePaths` list. Each
  message revalidates every open document (`src/server.ts:161`); the queue
  keeps the resulting spawn to at most `MAX_CONCURRENT_CHECKS` at a time
  (`src/server.ts:68`), so the cost is latency rather than process exhaustion.
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
  written to `connection.console.error` (`src/server.ts:78`,
  `src/server.ts:305`, `src/server.ts:337`). Startup and runtime
  configuration, including every rejected value, goes to
  `connection.console.info` and `.warn` (`src/server.ts:86-88`,
  `src/server.ts:93-100`, `src/server.ts:130-133`, `src/server.ts:151-155`).
  There is no persistent audit trail.
- There is no `SECURITY.md` and no documented route from a reported
  vulnerability to a shipped fix. No contact is recorded here, because
  inventing one would be worse than the gap.
- Owner and review cadence are unassigned.

## Known documentation drift

`README.md` described the runtime restriction as a security boundary without
saying that startup configuration grants full control of the executable and
the flags. That wording was corrected; the underlying behavior is unchanged
and is recorded above as threat 1.
