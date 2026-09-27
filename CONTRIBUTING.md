# Contributing

## Setup

```bash
bun install
bun run doctor    # prints every missing prerequisite; exit 0 means the suite can run
bun run build
```

`bun run doctor` checks the things that otherwise fail one at a time: bun, `node_modules`,
`VC/VC98/BIN/CL.EXE`, Wine, and the case-insensitive include overlay that `bun run setup`
creates. See "Prerequisites" in the README for where MSVC 6.0 comes from; the tree is not
in git.

## Before you push

```bash
bun run check
```

`check` is the whole local gate: `tsc --noEmit` over `src/`, `tsc -p tsconfig.test.json`
over `src/` and `tests/`, then the full test suite. The repository has no CI pipeline yet, so
this is the only gate; run it before every push.

`tsconfig.json` is the build config and emits `dist/` from `src/` alone. `tsconfig.test.json`
extends it with `noEmit` to type-check the test tree, which the build config excludes. Both are
run by `bun run typecheck`; a test file that no longer compiles fails the gate, not just the
test run.

## Test layout

- `tests/config.test.ts`, `tests/diagnostics.test.ts`, and the non-toolchain half of
  `tests/compiler.test.ts` need no external process. `bun run test:unit` runs those three files.
- The `describeWithToolchain` blocks in `tests/compiler.test.ts`, and all of
  `tests/server.test.ts`, spawn the real `CL.EXE` through Wine and skip themselves when Wine or
  `VC/VC98` is absent. Put pure logic tests outside `describeWithToolchain` so they stay
  runnable everywhere.
- `tests/fixtures/` holds the `.c` and `.cpp` inputs the compiler suite checks.

Run one file or one test:

```bash
bun run test tests/diagnostics.test.ts
bun run test -t 'groupByFile'
```

## Conventions

- TypeScript `strict` is on. No `any`; no unused code.
- Errors returned to the editor go through `parseDiagnostics` in `src/diagnostics.ts`; a new
  MSVC message format needs a test in `tests/diagnostics.test.ts` next to the existing ones.
- Comments explain contracts and non-obvious constraints (why SIGKILL, why NFC normalization),
  not what the next line does.
