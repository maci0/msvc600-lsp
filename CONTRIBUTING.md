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

`check` is the whole local gate: `tsc --noEmit` over `src/`, then the full test suite. The
repository has no CI pipeline yet, so this is the only gate; run it before every push.

## Test layout

- `tests/config.test.ts`, `tests/diagnostics.test.ts` are pure unit tests, no external
  process. `bun run test:unit` runs just these.
- `tests/compiler.test.ts` and `tests/server.test.ts` spawn the real `CL.EXE` through Wine and
  skip themselves when Wine or `VC/VC98` is absent. Put pure logic tests in the unit files so
  they stay runnable everywhere; a test that needs CL.EXE belongs behind `describeWithToolchain`.
- `tests/fixtures/` holds the `.c` and `.cpp` inputs the compiler suite checks.
- `tests/fuzz.diagnostics.test.ts` and `tests/fuzz.config.test.ts` fuzz the two untrusted
  input surfaces: CL.EXE output text and the client's config payloads. They run in
  `bun run test` and need no toolchain. `tests/helpers/fuzz.ts` is the seeded PRNG, the
  mutation operators, and the per-case wall-clock budget they share.

The fuzz harnesses are deterministic: a fixed seed drives a fixed iteration count, so a
failure reproduces from the seed and input the failure message prints. Each harness
encodes invariants as assertions rather than relying on the fuzzer to find a crash: a
fuzzer proves bugs exist, an assertion turns a wrong answer into a visible failure.
`budgetMs` is a ReDoS guard, so a regex change that backtracks on adversarial input fails
the case instead of hanging the suite.

When you add a parser over input this project does not control, give it a seed corpus of
the real shapes it sees, not placeholder strings, and add the fuzz file next to its unit
test.


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
