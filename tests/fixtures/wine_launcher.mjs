#!/usr/bin/env node
// Stands in for the Wine launcher in tests that need a real grandchild. Like
// Wine, it starts the compiler as a child of its own process group and then
// waits, so a kill aimed only at the launcher leaves the compiler running.
// MSVC6_TEST_PIDFILE names the file the grandchild's pid is written to.
import { spawn } from 'child_process';
import { writeFileSync } from 'fs';

const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
  stdio: 'ignore',
});

const pidFile = process.env.MSVC6_TEST_PIDFILE;
if (pidFile) writeFileSync(pidFile, String(child.pid));

// Stay alive until the group is killed.
setInterval(() => {}, 1000);
