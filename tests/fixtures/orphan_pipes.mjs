#!/usr/bin/env node
// Stand-in for a CL.EXE run that leaves a grandchild holding the inherited
// stdout and stderr pipes, which is what a Wine run does: the child exits,
// wineserver keeps the handles, and a caller that waits for end-of-file on
// those pipes waits forever. The grandchild is short-lived so it never outlives
// the test that spawned it.
import { spawn } from 'child_process';

const GRANDCHILD_LIFETIME_MS = 2000;

spawn(process.execPath, ['-e', `setTimeout(() => {}, ${GRANDCHILD_LIFETIME_MS})`], {
  stdio: 'inherit',
});

process.stdout.write('Z:\\tmp\\orphan.c(1) : error C2065: undeclared identifier\n');
process.exit(1);
