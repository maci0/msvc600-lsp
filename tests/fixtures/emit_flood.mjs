#!/usr/bin/env node
// Stand-in for CL.EXE: writes far more stdout than a test's maxOutputBytes
// allows, so the output-cap path can be observed. The byte count comes from
// the MSVC6_TEST_FLOOD_BYTES variable to keep the fixture free of a hardcoded
// size. The process ends on its own so stdout is flushed rather than cut short
// by process.exit().
const BYTES_PER_LINE = 64;
const total = Number(process.env.MSVC6_TEST_FLOOD_BYTES ?? 65536);

for (let written = 0; written < total; written += BYTES_PER_LINE + 1) {
  process.stdout.write('x'.repeat(BYTES_PER_LINE) + '\n');
}
