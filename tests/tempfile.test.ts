import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { syntaxCheckContent } from '../src/compiler';
import { Msvc6Config, defaultConfig, DEFAULT_CHECK_TIMEOUT_MS, DEFAULT_MAX_OUTPUT_BYTES } from '../src/config';
import { CL_EXE, MSVC_ROOT } from './helpers/toolchain';
import {
  createSystemTempFileStore,
  createSimulatedTempFileStore,
  createTempSource,
  sweepStaleTempFiles,
  staleTempMinAgeMs,
  DocumentTooLargeError,
  MAX_SOURCE_BYTES,
} from '../src/tempfile';

function testConfig(): Msvc6Config {
  return {
    ...defaultConfig(),
    msvcBasePath: MSVC_ROOT,
    clPath: CL_EXE,
    includePaths: ['C:\\msvc6\\include'],
    useWine: true,
    checkTimeoutMs: DEFAULT_CHECK_TIMEOUT_MS,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
  };
}

describe('createSimulatedTempFileStore', () => {
  it('replays the same paths for the same call sequence', () => {
    const run = () => {
      const store = createSimulatedTempFileStore({ dir: '/tmp/sim' });
      const first = store.write('int a;\n', '.c');
      const second = store.write('int b;\n', '.cpp');
      store.remove(first);
      return { events: store.events, second };
    };

    const firstRun = run();
    expect(firstRun.events).toEqual(run().events);
    expect(firstRun.events.map((e) => `${e.op} ${path.basename(e.file)}`)).toEqual([
      'write msvc6_lsp_000001.c',
      'write msvc6_lsp_000002.cpp',
      'remove msvc6_lsp_000001.c',
    ]);
    expect(path.basename(firstRun.second)).toBe('msvc6_lsp_000002.cpp');
  });

  it('hands each write a distinct path carrying the requested extension', () => {
    const store = createSimulatedTempFileStore({ dir: '/tmp/sim' });
    const first = store.write('a', '.c');
    const second = store.write('b', '.cpp');
    expect(first).toBe(path.join('/tmp/sim', 'msvc6_lsp_000001.c'));
    expect(second).toBe(path.join('/tmp/sim', 'msvc6_lsp_000002.cpp'));
  });

  it('keeps written content readable until the file is removed', () => {
    const store = createSimulatedTempFileStore();
    const file = store.write('int main(void) { return 0; }\n', '.c');
    expect(store.read(file)).toBe('int main(void) { return 0; }\n');
    store.remove(file);
    expect(store.read(file)).toBeUndefined();
    expect(store.files.size).toBe(0);
  });

  it('throws once on an injected write failure, then recovers', () => {
    const store = createSimulatedTempFileStore();
    store.failNextWrite(new Error('ENOSPC: no space left on device'));
    expect(() => store.write('a', '.c')).toThrow('ENOSPC');
    expect(store.files.size).toBe(0);
    expect(store.events).toHaveLength(0);

    const file = store.write('a', '.c');
    expect(store.read(file)).toBe('a');
  });
});

describe('createSystemTempFileStore', () => {
  it('writes a 0o600 file and removes it', () => {
    const store = createSystemTempFileStore();
    const file = store.write('int main(void) { return 0; }\n', '.c');
    try {
      // A POSIX mode is only reported as one on a POSIX host: Windows answers
      // 0o666 for every writable file, so there is no owner-only mode to read.
      if (process.platform !== 'win32') {
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      }
      expect(fs.readFileSync(file, 'utf-8')).toBe('int main(void) { return 0; }\n');
    } finally {
      store.remove(file);
    }
    expect(fs.existsSync(file)).toBe(false);
  });

  it('refuses to write through a path another file already occupies', () => {
    const planted = path.join(os.tmpdir(), `msvc6_lsp_planted_${process.pid}.c`);
    fs.writeFileSync(planted, 'planted\n');
    const store = createSystemTempFileStore({ generateName: () => `planted_${process.pid}` });
    try {
      expect(() => store.write('int a;\n', '.c')).toThrow(/EEXIST/);
      expect(fs.readFileSync(planted, 'utf-8')).toBe('planted\n');
    } finally {
      fs.rmSync(planted, { force: true });
    }
  });

  it('tolerates removing a file that is already gone', () => {
    const store = createSystemTempFileStore();
    expect(() =>
      store.remove(path.join(os.tmpdir(), 'msvc6_lsp_absent_000001.c')),
    ).not.toThrow();
  });

  it('uses the supplied name source so a run can be reproduced', () => {
    let counter = 0;
    const store = createSystemTempFileStore({
      dir: os.tmpdir(),
      generateName: () => `seeded_${++counter}`,
    });
    const file = store.write('int a;\n', '.c');
    try {
      expect(path.basename(file)).toBe('msvc6_lsp_seeded_1.c');
    } finally {
      store.remove(file);
    }
  });
});

describe('syntaxCheckContent through a simulated store', () => {
  const missingCompiler: Msvc6Config = {
    ...testConfig(),
    useWine: false,
    clPath: '/nonexistent/CL.EXE',
  };

  it('stages BOM-stripped content at a reproducible path and cleans up', async () => {
    const store = createSimulatedTempFileStore({ dir: '/tmp/sim' });
    await expect(
      syntaxCheckContent(missingCompiler, '﻿int main(void) { return 0; }\n', 'c', {
        store,
      }),
    ).rejects.toThrow('ENOENT');

    expect(store.events.map((e) => e.op)).toEqual(['write', 'remove']);
    expect(store.events[0].content).toBe('int main(void) { return 0; }\n');
    expect(store.files.size).toBe(0);
  });

  it('leaves nothing behind when the staging write fails', async () => {
    const store = createSimulatedTempFileStore();
    store.failNextWrite(new Error('ENOSPC: no space left on device'));
    await expect(
      syntaxCheckContent(missingCompiler, 'int main(void) { return 0; }\n', 'c', {
        store,
      }),
    ).rejects.toThrow('ENOSPC');
    expect(store.events).toHaveLength(0);
  });
});
describe('sweepStaleTempFiles', () => {
  const HOUR_MS = 60 * 60 * 1000;

  function makeTemp(name: string, ageMs: number): string {
    const file = path.join(os.tmpdir(), name);
    fs.writeFileSync(file, 'x');
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(file, when, when);
    return file;
  }

  it('removes an orphaned scratch file and reports it', () => {
    const file = makeTemp(`msvc6_lsp_orphan_${process.pid}.c`, 2 * HOUR_MS);
    try {
      expect(sweepStaleTempFiles()).toContain(file);
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('keeps a scratch file an in-flight check may still own', () => {
    const file = makeTemp(`msvc6_lsp_live_${process.pid}.cpp`, 60 * 1000);
    try {
      expect(sweepStaleTempFiles()).not.toContain(file);
      expect(fs.existsSync(file)).toBe(true);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('leaves files it did not create alone', () => {
    const file = makeTemp(`unrelated_${process.pid}.c`, 2 * HOUR_MS);
    try {
      expect(sweepStaleTempFiles()).not.toContain(file);
      expect(fs.existsSync(file)).toBe(true);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('is a no-op the second time over the same leftovers', () => {
    const file = makeTemp(`msvc6_lsp_twice_${process.pid}.c`, 2 * HOUR_MS);
    try {
      expect(sweepStaleTempFiles()).toContain(file);
      expect(sweepStaleTempFiles()).not.toContain(file);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});

describe('staleTempMinAgeMs', () => {
  it('clears the longest check the default timeout allows', () => {
    expect(staleTempMinAgeMs(30_000)).toBeGreaterThan(30_000);
  });

  it('grows past a timeout longer than the default age', () => {
    expect(staleTempMinAgeMs(4 * 60 * 60 * 1000)).toBeGreaterThan(4 * 60 * 60 * 1000);
  });
});

describe('sweepStaleTempFiles with a raised age', () => {
  const HOUR_MS = 60 * 60 * 1000;
  const LONG_CHECK_MS = 4 * 60 * 60 * 1000;

  function makeTemp(name: string, ageMs: number): string {
    const file = path.join(os.tmpdir(), name);
    fs.writeFileSync(file, 'x');
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(file, when, when);
    return file;
  }

  it('keeps a file a slow check is still reading', () => {
    const file = makeTemp(`msvc6_lsp_slow_${process.pid}.c`, 2 * HOUR_MS);
    try {
      expect(sweepStaleTempFiles()).toContain(file);
    } finally {
      fs.rmSync(file, { force: true });
    }

    const again = makeTemp(`msvc6_lsp_slow_${process.pid}.c`, 2 * HOUR_MS);
    try {
      expect(
        sweepStaleTempFiles({ minAgeMs: staleTempMinAgeMs(LONG_CHECK_MS) }),
      ).not.toContain(again);
      expect(fs.existsSync(again)).toBe(true);
    } finally {
      fs.rmSync(again, { force: true });
    }
  });
});

describe('createTempSource', () => {
  const created: string[] = [];

  afterEach(() => {
    for (const p of created.splice(0)) {
      try {
        fs.unlinkSync(p);
      } catch {
        // already gone
      }
    }
  });

  it('writes the content to a fresh file the caller owns', () => {
    const tempFile = createTempSource('int main(void) { return 0; }\n', '.c');
    created.push(tempFile);
    expect(fs.readFileSync(tempFile, 'utf-8')).toBe('int main(void) { return 0; }\n');
  });

  it('strips a leading BOM so the file starts at the first declaration', () => {
    const tempFile = createTempSource('\ufeffint main(void) { return 0; }\n', '.c');
    created.push(tempFile);
    expect(fs.readFileSync(tempFile, 'utf-8')).toBe('int main(void) { return 0; }\n');
  });

  it.runIf(process.platform !== 'win32')('creates the file readable by its owner only', () => {
    const tempFile = createTempSource('int x;\n', '.c');
    created.push(tempFile);
    expect(fs.statSync(tempFile).mode & 0o777).toBe(0o600);
  });

  // Counts a directory this test owns, not os.tmpdir(): test files run in
  // parallel workers that share the OS temp directory, so a count taken across
  // the shared one can see a sibling worker's file appear mid-assertion.
  it('refuses content over the syntax-check size limit, leaving no file behind', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msvc600-tmpstore-'));
    try {
      const store = createSystemTempFileStore({ dir });
      const oversized = 'a'.repeat(MAX_SOURCE_BYTES + 1);
      expect(() => store.write(oversized, '.c')).toThrow(DocumentTooLargeError);
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

