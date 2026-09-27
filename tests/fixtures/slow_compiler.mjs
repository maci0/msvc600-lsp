#!/usr/bin/env node
// Stand-in for CL.EXE in tests that need to observe how many checks run at
// once. Each run appends one start and one end marker, timestamped, to the
// file named by MSVC6_TEST_TRACE; the test computes the peak overlap.
import { appendFileSync } from 'fs';

const DELAY_MS = 150;
const trace = process.env.MSVC6_TEST_TRACE;
const mark = (kind) => {
  if (trace) appendFileSync(trace, `${kind} ${process.hrtime.bigint()}\n`);
};

mark('start');
setTimeout(() => {
  mark('end');
  process.exit(0);
}, DELAY_MS);
