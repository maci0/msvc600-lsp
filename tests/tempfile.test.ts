import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { syntaxCheckContent } from '../src/compiler';
import { Msvc6Config, defaultConfig } from '../src/config';
import { CL_EXE, MSVC_ROOT } from './helpers/toolchain';
import { createSystemTempFileStore, createSimulatedTempFileStore } from '../src/tempfile';

function testConfig(): Msvc6Config {
  return {
    ...defaultConfig(),
    msvcBasePath: MSVC_ROOT,
    clPath: CL_EXE,
    includePaths: ['C:\\msvc6\\include'],
    useWine: true,
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
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(file, 'utf-8')).toBe('int main(void) { return 0; }\n');
    } finally {
      store.remove(file);
    }
    expect(fs.existsSync(file)).toBe(false);
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
