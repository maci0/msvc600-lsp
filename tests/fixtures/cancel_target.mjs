#!/usr/bin/env node
// Stands in for a CL.EXE run that stays alive until the server aborts it.
// The test waits until this pid is on disk, then sends $/cancelRequest.
import { writeFileSync } from 'fs';

const pidfile = process.env.MSVC6_CANCEL_PIDFILE;
if (pidfile) writeFileSync(pidfile, `${process.pid}\n`);
setInterval(() => {}, 1000);
