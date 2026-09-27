#!/usr/bin/env node
// Stand-in for CL.EXE that outruns maxOutputBytes, so a test can observe the
// truncation the server reports as `truncated` instead of a full log. The
// lines go out through writeSync because process.exit would otherwise drop what
// is still buffered in the stdout pipe.
import { writeSync } from 'fs';

const LINE = 'Z:\\tmp\\noisy.c(1) : error C2065: undeclared identifier\n';
const LINES = 2048;
for (let i = 0; i < LINES; i++) {
  writeSync(1, LINE);
}
process.exit(1);
