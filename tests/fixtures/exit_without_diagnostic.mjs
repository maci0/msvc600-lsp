#!/usr/bin/env node
// Stand-in for a CL.EXE run that fails without a parseable diagnostic: the
// tool refused the command line, so there is no file(line) : error CODE: text
// to parse and the exit code is the only evidence the check failed.
process.stdout.write('Command line error D8021 : invalid numeric argument \'/Zn\'\n');
process.exit(2);
