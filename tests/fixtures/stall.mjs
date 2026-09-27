#!/usr/bin/env node
// Stand-in for a CL.EXE run that never finishes, so the timeout path can be
// exercised without a real hung compiler.
setTimeout(() => process.exit(0), 60_000);
