#!/usr/bin/env node
// Stand-in for CL.EXE that outruns maxOutputBytes, so a test can observe the
// truncation the server reports as `truncated` instead of a full log.
const LINE = 'Z:\\tmp\\noisy.c(1) : error C2065: undeclared identifier\n';
const LINES = 2048;
process.stdout.write(LINE.repeat(LINES));
process.exit(1);
