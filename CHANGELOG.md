# Changelog

All notable changes to `msvc600-lsp` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The package is at `0.1.0`, below `1.0.0`, so a release may carry breaking changes to the
LSP surface. No release tag has been published yet, so every entry below describes the
package version, not a published artifact.

## [Unreleased]

### Fixed

- Scratch-source staging lives in one module again. `tempfile.ts` owns the `TempFileStore`
  boundary and the sweep, while `compiler.ts` carried a second write path with its own copy of
  the name prefix and no exclusive-create or size check, plus two helpers no caller used. One
  write policy now applies to every scratch source, and the size limit is enforced by the store
  itself rather than only by one entry point.
- A leading BOM is stripped in one place. `compiler.ts` exported a second copy of the helper
  that `encoding.ts` already owns, so a change to BOM handling reached only one of the two.
- The tree compiles again. `compiler.ts` imported the `Semaphore` from a `concurrency.ts` that
  a cleanup had deleted, so `bun run typecheck` failed before anything could be built or run.
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
