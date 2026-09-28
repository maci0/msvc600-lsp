# Changelog

All notable changes to `msvc600-lsp` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The package is at `0.2.0`, below `1.0.0`, so a release may carry breaking changes to the
LSP surface.

## [0.2.0] - 2026-09-28

### Fixed

- The include overlay runs under bash 3.2. The STL alias table is a fixed list, not
  `declare -A`, which macOS `/bin/bash` does not have.
- On a case-folding destination the overlay writes one spelling per file. A second
  spelling is the same directory entry, and removing one left the other missing.
- `toWinePath` maps a resolved path that does not name a drive onto `Z:`. On Windows a
  relative input resolves to a native drive path and stays native.
- On Windows a `.cmd` or `.bat` compiler path is started through the shell. `CL.EXE` is
  still started directly.

## [0.1.0] - 2026-09-27

### Added

- LSP server for MSVC 6.0 under Wine, checking open C, C++, and header buffers through
  `CL.EXE /Zs` and publishing the parsed diagnostics.
- Configuration for `msvcBasePath`, `clPath`, `includePaths`, `warnLevel`, `additionalFlags`,
  `wineExecutable`, `useWine`, `outputEncoding`, `checkTimeoutMs`, and `maxOutputBytes`,
  resolved in the order defaults, `MSVC600_*` environment, `initializationOptions`.
- `workspace/didChangeConfiguration` for `includePaths` and `warnLevel`; every other field is
  fixed at initialization.
- Debounced validation that aborts stale checks, and generation numbers that publish only the
  newest result for a document.

### Fixed

- The tree compiles again. `server.ts` imported `createDebouncer` and `realScheduler` from a
  `scheduler.ts` that was not in the tree, so every build and type check failed on a missing
  module. The module now exists, holding the timer seam and the per-URI debouncer, and
  `tests/scheduler.test.ts` pins the coalescing, per-key cancel, and cancel-all behavior.
- The startup sweep no longer removes a scratch source a live check is still reading.
  `checkTimeoutMs` is configurable, so a check can outlive the one-hour age the sweep
  hardcoded, and a second server process starting up would unlink the file a check in the
  first one was compiling. The age is now `staleTempMinAgeMs(config.checkTimeoutMs)`, the
  longer of an hour and the configured timeout plus slack.
- The setup script's STL alias pass reads the truncated header from the MSVC tree instead
  of from the overlay it just wrote. Reading its own output made a rerun rebuild aliases
  from a previous run's leftovers, which no change to the source tree could reclaim.
- A client-chosen option name could forge a log line. `validateConfig` reports an unknown
  `initializationOptions` key by key name, and the name is whatever object key the client
  sent. `formatIssues` interpolated it into the LSP log verbatim, so a newline in a key wrote a
  second line and a bidi override reordered the first. The effective-configuration line
  interpolated `clPath` and `wineExecutable`, free-form client strings, the same way. Every
  logged line is now stripped of control, format, and bidi characters, the set `logging.ts`
  already defined for compiler output.
- `checkTimeoutMs` and `maxOutputBytes` had no upper bound. Both size something the client
  controls directly: the window a check runs for, and the buffer its output accumulates in, so
  a client could ask for a check that holds memory without limit. A value past
  `MAX_CHECK_TIMEOUT_MS` (600000) or `MAX_CAPTURED_OUTPUT_BYTES` (67108864) is now rejected and
  reported by name, leaving the previous bound in place.
- `src/scheduler.ts`, the timer boundary `tests/scheduler.test.ts` drives with
  `createManualScheduler`, was missing from the tree, so the type check failed and the module
  could not be built.
- `tests/task-queue.test.ts` constructed a `TaskQueue` without the error handler the constructor
  requires, so the test tree did not type-check even when the source did.
- Scratch-source staging lives in one module again. `tempfile.ts` owns the `TempFileStore`
  boundary and the sweep, while `compiler.ts` carried a second write path with its own copy of
  the name prefix and no exclusive-create or size check, plus two helpers no caller used. One
  write policy now applies to every scratch source, and the size limit is enforced by the store
  itself rather than only by one entry point.
- A leading BOM is stripped in one place. `compiler.ts` exported a second copy of the helper
  that `encoding.ts` already owns, so a change to BOM handling reached only one of the two.
- The tree compiles again. `compiler.ts` imported the `Semaphore` from a `concurrency.ts` that
  a cleanup had deleted, so `bun run typecheck` failed before anything could be built or run.
- The effective configuration is reported from the values in force. The
  timeout and truncation messages named the built-in 30 s and 1 MiB defaults
  even when `checkTimeoutMs` or `maxOutputBytes` had been set to something
  else, and those two defaults were declared a second time in the compiler
  module.
- A `workspace/didChangeConfiguration` payload that sets a field other than
  `includePaths` or `warnLevel` now names the ignored fields on the log
  channel, instead of validating them and dropping them without a word.
- A `clPath` or `wineExecutable` that does not exist is reported once at
  `initialize`, instead of surfacing as the same spawn failure on every open
  file.
- `src/concurrency.ts`, which the compiler and its tests import, was missing
  from the tree, so the build and the test suite could not run.
- The `noisy_compiler.mjs` fixture passed a string to `writeSync` with no file
  descriptor, which current Node rejects, so the output-cap test never saw a
  child that overran `maxOutputBytes`.
- `checkTimeoutMs` and `maxOutputBytes` now reach the CL.EXE invocation. Both options were
  accepted, validated, logged as part of the effective configuration, and then ignored: every
  check ran under the built-in 30 s timeout and 1 MiB output cap, so raising the timeout left a
  hung Wine running to completion and lowering the output cap truncated nothing.
- At most two CL.EXE children run at once. The server scheduled validations through a queue of
  its own while the compiler spawned through a second, looser limit, so the documented
  behavior and the effective one disagreed.
- A timed-out or truncated check reported the built-in 30 s and 1 MiB caps in its message even
  when `checkTimeoutMs` and `maxOutputBytes` were set to something else.
- `src/concurrency.ts` was removed while `src/compiler.ts` still imported it, so the type check
  failed on a missing module.
- The noisy-output test fixture wrote to no file descriptor, so the stand-in compiler exited
  before emitting anything and the truncation path was never exercised.
- A check that ended early is no longer published as a clean file. A child killed by any signal
  other than the configured timeout, output truncated by `maxOutputBytes`, and a non-zero exit
  that produced no diagnostic for the file all reach the editor as a note that the list is
  incomplete, carrying the signal, the byte cap, or the exit code and CL.EXE's first output line.
  Each case previously published a prefix, or nothing, that read as a full clean result.
- The exit code reported for a failed check is the one CL.EXE returned. `execFile` carries it on
  `error.code`, not on `error.status`, so every failure was flattened to 1.
- The timeout and output-cap notes name `checkTimeoutMs` and `maxOutputBytes` as configured
  rather than the built-in defaults, which is what a client that changed them was told.
- A validation task that rejects is reported instead of being swallowed, and a scratch source
  that could not be unlinked is logged with its path, so a failed cleanup is not a silent
  leak of the unsaved buffer.
- `src/server.ts` imported `createDebouncer` from a `scheduler.ts` a refactor had deleted, so
  the type check failed and `dist/server.js` could not be built. The debounce now lives in
  `src/debounce.ts` as the keyed, timer-backed unit the server actually uses; the scheduler
  interface and its manual test double are gone with it.
- The server wrote each scratch source through one temp-file path and deleted it with a second,
  its own `unlink` in a try/catch. Both go through the process-wide `TempFileStore` now, so the
  exclusive create, the `0600` mode, and the removal are one policy instead of two.

### Changed

- The suffixes a scratch source may carry are declared once in `config.ts` and used by both the
  server and the stale-file sweep. The sweep filtered on its own copy of the list, so a scratch
  file staged under a suffix the copy lacked would have survived every later run, holding an
  unsaved editor buffer in the temp directory.
