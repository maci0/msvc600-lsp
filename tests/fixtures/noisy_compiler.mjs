#!/usr/bin/env node
// Stand-in for CL.EXE that outruns maxOutputBytes, so a test can observe the
// truncation the server reports as `truncated` instead of a full log. The
// lines go out through writeSync on fd 1 because process.exit would otherwise
// drop what is still buffered in the stdout pipe.
//
// writeSync is a single call per line and no more: once the reader is at
// maxOutputBytes the pipe it holds is non-blocking, so a full pipe answers
// EAGAIN and one failed write would end the fixture before it ever produced
// the output the test is about.
import { writeSync } from 'fs';

const LINE = Buffer.from('Z:\\tmp\\noisy.c(1) : error C2065: undeclared identifier\n');
const LINES = 2048;

for (let i = 0; i < LINES; i++) {
  let offset = 0;
  while (offset < LINE.length) {
    try {
      offset += writeSync(1, LINE, offset);
    } catch (error) {
      // The parent stopped reading (it hit its cap and killed us): the output
      // has served its purpose, so end quietly instead of failing the check.
      if (error.code === 'EPIPE') process.exit(1);
      if (error.code !== 'EAGAIN') throw error;
    }
  }
}
process.exit(1);
