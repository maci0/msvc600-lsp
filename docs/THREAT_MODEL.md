# Threat model: msvc600-lsp

Last reviewed: 2026-09-27, against commit `5d8806c` and the working tree. Every
line reference below was re-read against the code in this tree on that date.

The server is a local process that speaks LSP to whatever launched it. It never
binds a socket, but it will connect to a TCP peer or a Node IPC peer when the
command line says so, so the peer is not always the user's editor. The attack
surface therefore reduces to two questions: who can reach the protocol channel,
and who controls the command line that reaches `CL.EXE`.

## Risk-ranked summary

| # | Threat | Boundary | Impact | Existing control |
|---|--------|----------|--------|------------------|
| 1 | The command line selects the transport, and `--socket=<port>` dials a remote peer | argv to process | An unauthenticated remote host, or any local process that joins the IPC channel, gets the same authority as the editor: which binary runs and which flags it gets | None. Allowlisted transport flags only, port range checked (`src/cli.ts:105-127`) |
| 2 | Initialization options choose the executable and the flags | client to server (`initializationOptions`) | Arbitrary program execution and file writes as the editing user | None. Deliberate, and stated in `README.md:155` |
| 3 | A hostile client sets `includePaths` to a directory it controls | client to server to `CL.EXE` | Header shadowing turns any open C/C++ file into attacker-chosen compile input | Type and range validation only (`src/config.ts:121-207`) |
| 4 | Document text is written to a shared temp directory | server to filesystem | Source code exposure to other local users; temp leak on crash | `0o600` mode, UUID names, exclusive create (`src/tempfile.ts:11`, `src/tempfile.ts:90-95`); 8 MiB cap before the write (`src/tempfile.ts:27`, `src/tempfile.ts:45-51`); startup sweep of orphans (`src/tempfile.ts:206-231`) |
| 5 | A client can open an unbounded number of documents and revalidate them all | client to server | Process and memory exhaustion, editor stall | `TaskQueue` caps concurrent `CL.EXE` children at 2 (`src/server.ts:75`, `src/compiler.ts:24`, `src/task-queue.ts:110-123`); debounce and abort per URI (`src/server.ts:209-216`); a notification that changes nothing is a no-op (`src/server.ts:193`) |
| 6 | `CL.EXE` stdout is parsed with a regex and republished to the editor | compiler to editor | Diagnostic spoofing: hostile output text reaches the editor UI as a message | File-path filter to the temp file only (`src/diagnostics.ts:106-113`) |
| 7 | `outputEncoding` is client-supplied and selects how compiler bytes become text | client to server to compiler | A wrong label mangles output into the editor, and a decode that disagrees with the filter degrades the filter | Label checked against `TextDecoder` at load (`src/config.ts:172-182`, `src/config.ts:246-253`) |
| 8 | Config-supplied paths reach the log without `sanitizeForLog` | config to client log | A path with a bidi or invisible character renders as a different path than the one on disk | None on the startup and issue log lines; the error and runtime-change lines do sanitize (`src/server.ts:88`, `src/server.ts:197-201`, vs `src/server.ts:141-147`) |
| 9 | The include overlay writes each header under three spellings | setup script to filesystem | On a case-insensitive lookup two different files resolve to the same name; re-running overwrites whatever is there | None. `scripts/setup-includes.sh:91-98`, `scripts/setup-includes.sh:100-119` |
| 10 | No audit trail for security events | all | Incidents cannot be reconstructed | Errors reach `connection.console.error` only |

## 1. Attack surface

Entry points. There is no HTTP server, webhook, or inbound listener in the tree.
The transports below are outbound or inherited; the risk they add is who ends up
on the far end of them.

| Entry point | Location | Source of input |
|-------------|----------|-----------------|
| Command line, parsed before the connection is built | `src/cli.ts:93-142`, called at `src/server.ts:47` | Whoever starts the process: transport flags, `--socket` port, `--help`, `--version` |
| Transport selection by the LSP library | `src/server.ts:49` | The same argv: `--stdio`, `--node-ipc`, `--socket=<port>` |
| stdio JSON-RPC connection | `src/server.ts:49`, `src/server.ts:378` | The spawning editor, or anything that can write to the process's stdin |
| TCP connection named by `--socket` | `src/cli.ts:116-127` | Whoever is listening at the address the launcher named, with no authentication and no TLS |
| Node IPC channel named by `--node-ipc` | `src/cli.ts:105-106` | Any local process that learns the channel name or holds the inherited descriptor |
| `initialize` / `initializationOptions` | `src/server.ts:123`, `src/server.ts:133-139` | Client-supplied object, merged into the config |
| `workspace/didChangeConfiguration` | `src/server.ts:173` | Client-supplied `settings.msvc6` |
| `textDocument/didOpen`, incremental `didChange`, `didSave` | `src/server.ts:209-221` | Buffer content and document identity, incremental since `src/server.ts:157` |
| Document URI, used to pick the extension and the scratch-file suffix | `src/server.ts:251-261`, `src/server.ts:283-284` | Client-supplied string, parsed with `URI.parse` |
| `CL.EXE` stdout and stderr | `src/diagnostics.ts:41` | Compiler output parsed by regex |
| Process environment | `src/compiler.ts:155-157` | Inherited in full; the server only adds `WINEDEBUG=-all` |
| `MSVC600_*` environment variables | `src/config.ts:256`, `src/config.ts:266-277`, read at `src/config.ts:302-342` | Read at startup, below `initializationOptions` in precedence |
| `bun run setup` | `scripts/setup-includes.sh:23` | Writes to `$HOME/.wine/drive_c/msvc6`, or to `--dest` |
| `bun run doctor` | `scripts/doctor.sh:1` | Reads the environment and prints resolved paths; no writes |

No admin port, no debug endpoint, no default service. The runtime dependency
surface is the four `vscode-languageserver*` packages and `vscode-uri`
(`package.json:28-32`).

## 2. Trust boundaries

1. **Process to command line.** The argv decides which transport the LSP library
   opens before any request is handled (`src/cli.ts:93-142`). Nothing else in the
   tree reads argv.
2. **Remote or IPC peer to server.** Over stdio this is the user's editor.
   Over `--socket` it is whoever holds the address, and over `--node-ipc`
   whoever holds the channel. The server cannot tell them apart: there is no
   token, no handshake, and no origin check. Under stdio that is inherent to the
   transport, so the mitigation is deployment (launch the server from the
   editor, not as a service); under `--socket` and `--node-ipc` the peer is a
   network or IPC identity the launcher chose, and nothing in the code limits
   what that choice can be.
3. **Client to config.** Untrusted. `initializationOptions` is merged at
   `src/server.ts:133-139`, the environment at `src/server.ts:55-56`, and the
   runtime notification is restricted to two fields at `src/server.ts:184-189`.
4. **Server to `CL.EXE`.** `execFile` with an argument vector
   (`src/compiler.ts:175-190`), so no shell and no metacharacter injection. The
   vector is assembled in `src/compiler.ts:54-77`.
5. **Server to Wine.** On non-Windows the config-supplied `wineExecutable` is
   the program actually exec'd, with `clPath` as its first argument
   (`src/compiler.ts:150-151`).
6. **Server to temp filesystem.** Full document text at `os.tmpdir()`
   (`src/server.ts:305`, `src/tempfile.ts:83-105`). This is the only write the
   server performs outside the toolchain's own output.
7. **Compiler output to editor.** Compiled text becomes diagnostics shown in the
   editor (`src/diagnostics.ts:114-133`).
8. **Setup script to `$HOME`.** `scripts/setup-includes.sh` copies headers,
   libraries, and the compiler into the Wine prefix.
9. **Repository tree to compiler.** `defaultConfig` resolves `msvcBasePath`
   from the package directory (`src/config.ts:87`), so whoever can write to the
   checkout controls which `CL.EXE` runs. The toolchain is not in git
   (`README.md:24`), which is a deployment control, not a code one.

## 3. Assets

- Source code under edit, which passes through the process and the temp
  directory.
- The user's filesystem, reachable through `includePaths`, through
  `additionalFlags` accepted at startup, and through a writable checkout
  (`src/config.ts:87`).
- The Wine prefix at `~/.wine/drive_c/msvc6`, which holds the compiler, the
  standard headers, and the import libraries (`scripts/setup-includes.sh:23`).
- Editor availability: every validation is a process spawn, and under Wine a
  heavyweight one.
- The client's own trust in the diagnostics. A squelched or spoofed warning is a
  silent correctness failure in the code being edited, and `publishCheckFailure`
  exists precisely because an empty list would read as "clean"
  (`src/server.ts:100-121`).

## 4. Threats per boundary

**Process to command line**

- *Spoofing / elevation of privilege.* `--socket=<port>` names a peer with no
  proof of identity, and nothing in the tree constrains it to loopback
  (`src/cli.ts:116-124`). A launch that passes a routable address hands
  everything in boundary 2 to a remote host. `--node-ipc` does the same for a
  local process that can obtain the channel.
- *Tampering.* No configuration is accepted on the command line, so a bad
  argument cannot change which binary runs; every non-transport argument is a
  usage error (`src/cli.ts:129-131`) and a bare invocation is one too
  (`src/cli.ts:137-139`). This boundary is closed for configuration and open
  for transport.

**Client to server**

- *Elevation of privilege.* `initializationOptions` accepts `clPath`,
  `wineExecutable`, `useWine`, `additionalFlags`, `msvcBasePath`,
  `checkTimeoutMs`, and `maxOutputBytes` (`src/config.ts:23-48`). A peer that
  reaches the protocol channel picks which binary runs, whether the Wine layer
  is used at all, and can pass flags such as `/Fo` or `/Fe`, which make
  `CL.EXE` write files. Runtime reconfiguration cannot do this
  (`src/server.ts:184-189`); startup can, so the startup path is the privileged
  one.
- *Elevation of privilege, environment.* `MSVC600_CL_PATH`,
  `MSVC600_WINE_EXECUTABLE`, and `MSVC600_ADDITIONAL_FLAGS` carry the same
  power from the parent process (`src/config.ts:266-277`), below
  `initializationOptions` in precedence. Anything that can start the server
  with a chosen environment picks the binary and its flags without speaking the
  protocol at all. It could already influence `PATH`, which decides how the
  default `wineExecutable` resolves, so the added reach is `additionalFlags` and
  an absolute path outside `PATH`.
- *Tampering.* `includePaths` from any source is passed to `/I`
  (`src/compiler.ts:59-64`), and absolute POSIX entries are converted to Wine
  paths by string rewriting (`src/wine-path.ts:13`). A client that controls an
  include directory controls the headers the preprocessor sees for every open
  file.
- *Denial of service.* `didChangeConfiguration` queues a check for every open
  document (`src/server.ts:203-206`). The queue runs at most
  `MAX_CONCURRENT_CHECKS` of them at a time (`src/server.ts:75`,
  `src/compiler.ts:24`, `src/task-queue.ts:110-123`), and a repeat of the
  settings already in force returns before the loop (`src/server.ts:193`), so a
  peer that resends the notification cannot fan out one child per open file.
  The number of open documents is still unbounded, and each one can hold up to
  8 MiB of text in the process (`src/tempfile.ts:27`).
- *Information disclosure.* `outputEncoding` names the `TextDecoder` label used
  on raw compiler bytes (`src/compiler.ts:162-173`). It is checked at load so it
  cannot crash the server (`src/config.ts:246-253`), but any label the platform
  accepts is allowed, and a label that disagrees with the one the filter was
  derived under can turn a path into text that no longer matches the temp file
  the diagnostics are filtered against.
- *Information disclosure (diagnostics).* Diagnostics are filtered to the temp
  file (`src/diagnostics.ts:106-113`), but the message text is compiler- or
  source-controlled and reaches the editor UI.

**Server to filesystem**

- *Information disclosure.* Temp files hold complete buffer contents. The name
  is a random UUID and the mode is `0o600`, and the create is exclusive (`wx`),
  so a file or symlink another local user planted at that path is never written
  through (`src/tempfile.ts:90-95`). What remains is the shared directory
  listing and crash leftovers. A process killed between write and unlink leaves
  the content behind; the startup sweep removes it once it is older than an
  hour or older than the configured check timeout, whichever is longer
  (`staleTempMinAgeMs`, `src/tempfile.ts:22`; default constant at
  `src/tempfile.ts:24`). The age has to cover the timeout because the sweep
  deletes from a directory shared with every other running server, and a
  source still being read by a live check would otherwise be unlinked
  underneath it.
- *Tampering (local).* The sweep matches a fixed prefix and a known extension
  (`src/tempfile.ts:8`, `src/tempfile.ts:210-211`), stats with `lstat`, and
  skips anything that is not a regular file
  (`src/tempfile.ts:216-220`), so it deletes only its own scratch files. It
  still means any local process can plant a decoy name in the shared temp
  directory to have that file deleted, and a decoy older than an hour is
  removed without the owner being asked.

**Compiler output to editor**

- *Tampering / spoofing.* The diagnostic regex
  (`src/diagnostics.ts:26-27`) accepts any text matching
  `file(line): error CODE: message`. Since only the temp file passes the filter,
  injected diagnostics land on the file being edited and display a message
  chosen by whatever produced the output. Continuation lines are appended to
  that message verbatim (`src/diagnostics.ts:121-124`).

**Setup script**

- *Tampering.* Every header is written three times, under its own name and its
  lower- and upper-case spellings (`scripts/setup-includes.sh:91-98`,
  `scripts/setup-includes.sh:100-105`, and the same for `GL/`, `SYS/`,
  `OBJMODEL/` at `scripts/setup-includes.sh:107-119`). On a case-insensitive
  lookup two different files can resolve to the same name, so a header that
  arrives with the MSVC tree decides which one is found. The script copies with
  `cp -f` into `$HOME/.wine/drive_c/msvc6` with no ownership or mode
  assertions, and re-running it overwrites whatever is already there.

## 5. Mitigations

Implemented:

- The command line accepts only the three transport flags and the two
  informational flags, and no configuration at all, so an argument cannot
  redirect the toolchain: `src/cli.ts:93-142`, checked before the connection is
  created (`src/server.ts:47`).
- A `--socket` port must be digits in 1-65535, rejected before the connection is
  opened: `src/cli.ts:116-124`.
- Argument vectors instead of a shell, so config values cannot smuggle in shell
  syntax: `src/compiler.ts:175-190`.
- `execFile` with the configured `checkTimeoutMs` (30 s by default,
  `src/compiler.ts:27`) and `maxOutputBytes` (1 MiB by default,
  `src/compiler.ts:30`), an `AbortSignal`, and `SIGKILL` because Wine ignores
  `SIGTERM`: `src/compiler.ts:183-189`. Both bounds are validated positive
  integers at load (`src/config.ts:148-153`); a peer that raises them buys a
  longer-lived child, not a new capability.
- Runtime configuration is restricted to `includePaths` and `warnLevel`;
  `additionalFlags` is rejected there: `src/server.ts:184-189`, with the
  equality test that makes a repeated notification a no-op at
  `src/config.ts:234-240`.
- Type and range validation of every config field, with every rejected value
  reported by name: `src/config.ts:121-207`, surfaced at `src/server.ts:129-138`
  and `src/server.ts:176-179`. An `outputEncoding` label is rejected at load
  rather than at decode (`src/config.ts:172-182`).
- `MSVC600_*` environment variables go through the same validation and the same
  issue reporting as the two protocol sources: `src/config.ts:302-342`,
  `src/server.ts:55-59`.
- Buffer text is capped at 8 MiB before anything is written, and the editor is
  told the buffer was not checked instead of being left looking clean:
  `src/tempfile.ts:27`, `src/tempfile.ts:45-51`, `src/server.ts:335-338`,
  `src/server.ts:364-375`.
- Debounce and a per-URI abort discard stale work: `src/server.ts:209-216`,
  `src/scheduler.ts:40-65`, and `TaskQueue.submit` supersedes the entry already
  held for its key (`src/task-queue.ts:59-68`).
- Validation generations never repeat, so a result from before a close cannot
  overwrite a newer one: `src/validation-state.ts:29-45`, used at
  `src/server.ts:281` and `src/server.ts:309`.
- Concurrent `CL.EXE` children are capped at `MAX_CONCURRENT_CHECKS` twice over,
  by the queue and by a semaphore inside the spawn path
  (`src/server.ts:75`, `src/compiler.ts:105`, `src/task-queue.ts:110-123`).
- `shutdown` clears the debounce timers, aborts every in-flight child, and waits
  briefly for them to unlink their temp files: `src/server.ts:234-245`.
- Temp files are unlinked in a `finally` block (`src/server.ts:352-360`), and
  leftovers from a killed run are removed at startup
  (`src/server.ts:382-386`, `src/tempfile.ts:206-231`).
- Document extension is checked against an allowlist before any work is done:
  `src/server.ts:274-278`, against the list at `src/config.ts:13-15`.
- Control, format, and bidi characters are stripped from every error path that
  logs config-supplied or compiler-supplied text: `src/logging.ts:15-19`, used at
  `src/server.ts:88`, `src/server.ts:108`, `src/server.ts:197-201`,
  `src/server.ts:324-328`.

Not implemented, ranked by exploitability then impact:

1. No restriction on what startup configuration may set, including the
   executable path and `useWine`. Any peer that reaches the protocol channel gets
   `additionalFlags`, `clPath`, and `wineExecutable`.
2. No authentication, TLS, or address restriction on `--socket`, and no channel
   check on `--node-ipc`. The peer is whoever the launcher named.
3. No cap on open documents, so the queue's wait list still grows with the
   number of open files.
4. No restriction on which directories `includePaths` may name.
5. `sanitizeForLog` is not applied to the effective-configuration log line
   (`src/server.ts:141-147`) or to the issue lines it prints
   (`src/server.ts:129-138`, `src/server.ts:176-179`). `JSON.stringify` escapes
   C0 controls, so a newline cannot forge a log line, but bidi and invisible
   characters pass through and can make two different paths look alike.
6. No provenance check on the stdio peer.
7. Configuration is logged to the LSP log channel (`connection.console`), which
   is not a durable audit trail: a peer that alters the toolchain leaves a trace
   only for as long as the client keeps its log.

Single points of failure: the `validateConfig` field allowlist is the only
control between the peer and the command line, and the extension allowlist at
`src/server.ts:276` is the only control that decides whether a document reaches
the compiler at all.

## 6. Abuse cases

- A launcher (an editor extension, a workspace config, a container entrypoint)
  starts the server with `--socket` aimed at a host it controls, or with
  `initializationOptions` setting `additionalFlags: ["/Fe<path>"]`. The next
  validation writes a file, or runs whatever `clPath` names, as the editing
  user. Setting `useWine: false` alongside a chosen `clPath` skips Wine entirely
  (`src/compiler.ts:150-151`). Nothing in the tree distinguishes this launch from
  an editor's own.
- A malicious workspace or editor extension opens many files, then sends
  `didChangeConfiguration` repeatedly with a wide `includePaths` list. Each
  change revalidates every open document (`src/server.ts:203-206`); the queue
  keeps the resulting spawn to at most two children at a time
  (`src/server.ts:75`), so the cost is latency and temp-file churn rather than
  process exhaustion.
- A document with a hostile `#include` name reaches `CL.EXE`; the resulting
  error text is republished verbatim as a diagnostic message
  (`src/diagnostics.ts:121-124`), which is the only way untrusted text is
  rendered in the editor.
- A client that writes to the checkout can place a different `CL.EXE` under
  `VC/VC98/BIN`, because `defaultConfig` resolves the toolchain from the package
  directory (`src/config.ts:87`).
- A local process plants `msvc6_lsp_<name>.c` in the shared temp directory. It
  survives the sweep while it is young and is deleted an hour later without ever
  being the server's file.
- Nothing in the tree is enforced client-side only, but the deployment rule that
  the server is launched by the user's own editor, and never with `--socket` at a
  routable address, is unwritten. `README.md:155` states what the stdio channel
  implies; it does not state the rule.

## 7. Response readiness

- Security-relevant events (toolchain path changes, spawn failures, truncation,
  sweep failures) are only written to `connection.console.error` or `.warn`
  (`src/server.ts:88`, `src/server.ts:108`, `src/server.ts:324-328`,
  `src/server.ts:382-386`). Startup and runtime configuration, including every
  rejected value, goes to `connection.console.info` and `.warn`
  (`src/server.ts:129-138`, `src/server.ts:141-147`, `src/server.ts:176-179`,
  `src/server.ts:197-201`). There is no persistent audit trail.
- There is no `SECURITY.md` and no documented route from a reported vulnerability
  to a shipped fix. No contact is recorded here, because inventing one would be
  worse than the gap.
- Owner and review cadence are unassigned.

## Documentation accuracy

`README.md` states the security-relevant claims this model depends on, and each
was checked against the code:

- The command line carries no configuration, and the three transports it does
  accept are listed: `README.md:47-77`, matching `src/cli.ts:24-47`.
- Runtime configuration changes are limited to `includePaths` and `warnLevel`,
  and cannot inject `CL.EXE` flags, while startup configuration can: `README.md:155`,
  matching `src/server.ts:184-189` and `src/config.ts:121-207`.
- A value that fails validation is dropped and reported rather than rejected: `README.md:89-93`,
  matching `src/config.ts:121-207` and `src/server.ts:176-179`.
- Changing the configuration re-validates every open document: `README.md:155`,
  matching `src/server.ts:203-206`.
- A check is killed after 30 s and output past 1 MiB is truncated: `README.md:195`,
  matching `src/compiler.ts:183-189` and `src/config.ts:71-74`.
- Buffers above 8 MiB are never written to the temp directory: `README.md:197`,
  matching `src/tempfile.ts:27`, `src/tempfile.ts:45-51`.
- A check that never ran publishes an error diagnostic rather than an empty
  list: `README.md:199`, matching `src/server.ts:100-121` and
  `src/server.ts:340-343`.
- The log is not redacted because nothing in the configuration is secret: `README.md:93`.
  True, and it is also the reason gap 5 in section 5 exists.

Two documentation gaps were recorded here in an earlier pass and are now closed
in the README: it states that `--socket` and `--node-ipc` put a peer of the
launcher's choosing on the protocol boundary (`README.md:72-76`), and that the
runtime restriction does not constrain the peer's identity
(`README.md:180`). The wording at `README.md:180` had previously described the
runtime restriction without saying that startup configuration grants full
control of the executable and the flags, nor that the peer is unauthenticated.

One deployment rule remains unwritten because it is an instruction rather than a
description, and no reviewer has set it: the server is launched by the user's own
editor, and never with `--socket` at a routable address.
