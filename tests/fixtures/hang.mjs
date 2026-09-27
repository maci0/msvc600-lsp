#!/usr/bin/env node
// Stands in for a CL.EXE run that never terminates, so the exec timeout path
// can be exercised without the real toolchain.
setTimeout(() => {}, 60000);
