#!/usr/bin/env node
// Stand-in for a CL.EXE run whose output is large enough to hit the configured
// maxBuffer, so the truncation path can be exercised without the toolchain.
const FILLER = 'x'.repeat(1024);

for (let i = 0; i < 64; i += 1) {
  process.stdout.write(`${FILLER}\n`);
}
