#!/usr/bin/env node
// Stand-in for CL.EXE that is killed from outside the exec timeout: it writes
// one diagnostic and then dies on SIGKILL, the way the OOM killer or an
// operator ends a runaway Wine. Node reports that as a signal kill with no
// status, so a run cut short here must not read as a completed check.
process.stdout.write('/tmp/valid.c(1) : error C2146: error : missing ;\n');
process.kill(process.pid, 'SIGKILL');
setTimeout(() => {}, 60000);
