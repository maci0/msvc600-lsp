# Contributing

## Setup

```bash
bun install
bun run doctor    # prints every missing prerequisite; exit 0 means the suite can run
bun run build
```

`bun run doctor` checks the things that otherwise fail one at a time: the `packageManager` bun
version, `node_modules`, ShellCheck, `VC/VC98/BIN/CL.EXE`, Wine, and the case-insensitive include
overlay that `bun run setup` creates. See "Prerequisites" in the README for where MSVC 6.0 comes
from; the tree is not in git.

## Before you push

```bash
bun run check
```

`check` is the whole local gate, in order: `shellcheck scripts/*.sh`, then `tsc --noEmit` over
`src/` plus `tsc -p tsconfig.test.json` over `src/` and `tests/`, then the full test suite. Run
`bun run check` before every push. CI (`.github/workflows/ci.yml`) runs that same gate on Linux,
preceded by `bun install --frozen-lockfile` so a lockfile that no longer resolves fails the build
instead of being rewritten, and runs the typecheck, test suite and build on Linux, macOS and
Windows. It installs no Wine, so the CL.EXE integration tests skip themselves there and only the
tests that need no toolchain actually execute. `bun run ci` is the CI sequence locally.

`tsconfig.json` is the build config and emits `dist/` from `src/` alone. `tsconfig.test.json`
extends it with `noEmit` to type-check the test tree, which the build config excludes. Both are
run by `bun run typecheck`; a test file that no longer compiles fails the gate, not just the
test run.

## Test layout

- `tests/config.test.ts`, `tests/cli.test.ts`, `tests/wine-path.test.ts`, `tests/diagnostics.test.ts`,
  and the non-toolchain half of `tests/compiler.test.ts` need no external process.
  `bun run test:unit` runs those files.
- The `describeWithToolchain` blocks in `tests/compiler.test.ts` and `tests/server.test.ts`, plus
  the `LSP Server tool failure signalling` block in `tests/server.test.ts`, spawn the real
  `CL.EXE` through Wine and skip themselves when Wine or `VC/VC98` is absent. Put pure logic
  tests in the unit files, outside `describeWithToolchain`, so they stay runnable everywhere.
- `tests/fixtures/` holds the `.c` and `.cpp` inputs the compiler suite checks.
- `tests/fuzz-diagnostics.test.ts` and `tests/fuzz-config.test.ts` fuzz the two parsers that
  take untrusted text: CL.EXE output and the client's `initializationOptions`. Each starts from a
  corpus of real captures in the file and derives its cases with the seeded generator in
  `tests/helpers/fuzz.ts`, so a run is reproducible. Every case asserts an invariant rather than
  merely surviving, and a failure prints the input, which is the regression test to add. A parser
  of untrusted input needs one of these before it needs another example-based test.

Run one file or one test:

```bash
bun run test tests/diagnostics.test.ts
bun run test -t 'toLspDiagnostics'
```

## Conventions

- TypeScript `strict` is on, alongside `noImplicitOverride`, `noImplicitReturns`,
  `noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`,
  `exactOptionalPropertyTypes`, and `isolatedModules`. No `any`; no unused code.
  `noUncheckedIndexedAccess` is not on yet: `src/diagnostics.ts` destructures
  `RegExpExecArray` capture groups, which it types as possibly undefined.
- `scripts/*.sh` are linted with ShellCheck and must pass `bun run lint` with no findings.
- Errors returned to the editor go through `parseDiagnostics` in `src/diagnostics.ts`; a new
  MSVC message format needs a test in `tests/diagnostics.test.ts` next to the existing ones.
- Comments explain contracts and non-obvious constraints (why SIGKILL, why NFC normalization),
  not what the next line does.
