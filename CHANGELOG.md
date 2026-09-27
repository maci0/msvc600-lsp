# Changelog

All notable changes to `msvc600-lsp` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The package version is `0.1.0`, below `1.0.0`, so before `1.0.0` a minor bump may carry a
breaking change to the LSP surface. No tag has been cut and the package is `UNLICENSED`, so
`0.1.0` below describes the whole surface as it stands, not a change to a published release.
`CONTRIBUTING.md` covers the bump-and-changelog process for the first tag and after it.

## [Unreleased]

Nothing yet. The next change lands here under `### Breaking`, `### Added`, or `### Fixed`.

## [0.1.0] - 2026-09-27

Not published, and never tagged. The notes below are written for the first consumer: there is
no earlier release to upgrade from.

### Added

- LSP server for MSVC 6.0 under Wine, checking open C, C++, and header buffers through
  `CL.EXE /Zs` and publishing the parsed diagnostics.
- Configuration for `msvcBasePath`, `clPath`, `includePaths`, `warnLevel`, `additionalFlags`,
  `wineExecutable`, `useWine`, `outputEncoding`, `checkTimeoutMs`, and `maxOutputBytes`,
  resolved in the order defaults, `MSVC600_*` environment, `initializationOptions`. A launch
  that cannot pass `initializationOptions` (a remote session, a container, an editor that only
  sets an environment) configures the same way. A variable set to an empty string is rejected
  rather than read as unset, because "no include paths" and "no include paths configured" are
  different setups.
- A rejected configuration value is reported on the server's log channel naming the field and
  the reason, instead of being dropped in silence, and the effective configuration is logged
  once on `initialize`.
- `workspace/didChangeConfiguration` for `includePaths` and `warnLevel`; every other field is
  fixed at initialization, so a runtime notification cannot inject CL.EXE flags.
- Debounced validation that aborts stale checks, and generation numbers that publish only the
  newest result for a document.
- A command line: `--stdio`, `--node-ipc`, or `--socket=<port>` selects the transport, and
  `--help` and `--version` print and exit 0. There is no default transport, so a bare
  `msvc600-lsp` is a usage error on stderr with exit code 2, not a server that starts. A serving
  process never exits on its own; a startup failure surfaces as the runtime's own nonzero exit.
- `--help` on both shell scripts, with exit code 2 for a bad argument.
- At most two `CL.EXE` children run at once; the rest queue, so a settings change over a large
  workspace cannot spawn a process per open document.

### Fixed

- `checkTimeoutMs` and `maxOutputBytes` reach the CL.EXE invocation. Both options were
  accepted, validated, logged as part of the effective configuration, and then ignored: every
  check ran under the built-in 30 s timeout and 1 MiB output cap, so raising the timeout left a
  hung Wine running to completion and lowering the output cap truncated nothing.
- A check that timed out, could not spawn CL.EXE, or was killed publishes one
  `msvc600-check-failed` diagnostic on the file instead of an empty list, so a hung or broken
  toolchain never reads as a clean file. Output past `maxOutputBytes` is still published, with
  the dropped tail logged.
- The server's validation queue and the compiler's spawn limit no longer disagree, so the
  documented two-child cap is the effective one.
- A buffer over 8 MiB is not written to the temp directory at all and reports a single
  `msvc6-too-large` note.
- A lone surrogate in the buffer no longer reaches CL.EXE: the unpaired half is dropped, since
  it encodes no character, instead of being written as a replacement character that shifts every
  column after it.
- Scratch sources are created exclusively with mode `0600`, so a file or symlink another local
  user planted at that path is never written through, and a startup sweep removes leftovers from
  a run that was killed before its cleanup.
- Every message written to the client log has its control, format, and bidi characters replaced
  with `?`, so a newline in a configured path or in compiler output cannot forge a log line.
