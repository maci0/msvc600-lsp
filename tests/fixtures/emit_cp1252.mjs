#!/usr/bin/env node
// Stand-in for CL.EXE: writes a diagnostic in cp1252, the console code page
// MSVC6 uses on a Western Windows install. Byte 0xE9 is `é` there and an
// invalid UTF-8 sequence everywhere else.
process.stdout.write(
  Buffer.from([0x5a, 0x3a, 0x5c, 0x74, 0x6d, 0x70, 0x5c, 0x63, 0x61, 0x66, 0xe9, 0x2e, 0x63]),
);
process.exit(1);
