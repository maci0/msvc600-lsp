import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'setup-includes.sh');

/** An overlay tree as a sorted "name<TAB>contents" listing, for diffing two runs. */
function snapshot(dir: string): string {
  const lines: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort()) {
      const full = path.join(current, entry.name);
      const name = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(full, name);
      else lines.push(`${name}\t${fs.readFileSync(full, 'utf8')}`);
    }
  };
  walk(dir, '');
  return lines.join('\n');
}

/**
 * A throwaway copy of the script beside a synthetic VC/VC98 tree. The script
 * resolves the MSVC tree relative to its own location, so the fixture has to
 * mirror the layout rather than pass it in.
 */
function makeFixture(): { root: string; msvc: string; dest: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msvc6_lsp_setup_'));
  const msvc = path.join(root, 'VC', 'VC98');
  const dest = path.join(root, 'overlay');

  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(root, 'scripts', 'setup-includes.sh'));

  for (const sub of ['INCLUDE', path.join('INCLUDE', 'GL'), 'LIB', 'BIN']) {
    fs.mkdirSync(path.join(msvc, sub), { recursive: true });
  }
  fs.writeFileSync(path.join(msvc, 'INCLUDE', 'windows.h'), 'header\n');
  // Only the 8.3-truncated spelling exists here; the full name is created by
  // the alias pass, so it is a marker for what that pass did.
  fs.writeFileSync(path.join(msvc, 'INCLUDE', 'ALGRITHM'), 'truncated stl\n');
  fs.writeFileSync(path.join(msvc, 'INCLUDE', 'GL', 'gl.h'), 'opengl\n');
  fs.writeFileSync(path.join(msvc, 'LIB', 'msvcrt.lib'), 'lib\n');
  fs.writeFileSync(path.join(msvc, 'BIN', 'CL.EXE'), 'exe\n');

  return { root, msvc, dest };
}

function runSetup(fixture: { root: string; dest: string }): void {
  const script = path.join(fixture.root, 'scripts', 'setup-includes.sh');
  execFileSync('bash', [script, '--dest', fixture.dest], { stdio: 'pipe' });
}

describe('setup-includes.sh', () => {
  let fixture: { root: string; msvc: string; dest: string };

  beforeEach(() => {
    fixture = makeFixture();
  });

  afterEach(() => {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  it('reaches the same tree when run a second time', () => {
    runSetup(fixture);
    const first = snapshot(fixture.dest);

    runSetup(fixture);
    expect(snapshot(fixture.dest)).toBe(first);
  });

  it('rebuilds a removed header from the MSVC tree, not from its own output', () => {
    runSetup(fixture);
    // A partial wipe of the overlay: what the second run sees is a mix of its
    // own leftovers and genuinely missing files. Each must come from the source.
    fs.rmSync(path.join(fixture.dest, 'include', 'ALGRITHM'));

    runSetup(fixture);
    expect(fs.readFileSync(path.join(fixture.dest, 'include', 'ALGRITHM'), 'utf8')).toBe(
      'truncated stl\n',
    );
    expect(fs.readFileSync(path.join(fixture.dest, 'include', 'algorithm'), 'utf8')).toBe(
      'truncated stl\n',
    );
  });

  it('drops an alias whose source header no longer exists', () => {
    runSetup(fixture);
    expect(fs.existsSync(path.join(fixture.dest, 'include', 'ALGORITHM'))).toBe(true);

    // On a case-folding destination the overlay holds one spelling, because the
    // two names are one directory entry there; removing both would be an ENOENT
    // for the spelling that was never written.
    fs.rmSync(path.join(fixture.msvc, 'INCLUDE', 'ALGRITHM'));
    fs.rmSync(path.join(fixture.dest, 'include', 'algorithm'), { force: true });
    fs.rmSync(path.join(fixture.dest, 'include', 'ALGORITHM'), { force: true });

    runSetup(fixture);
    // A rerun reads the truncated header from the MSVC tree, so removing the
    // source cannot leave the alias standing in the overlay forever.
    expect(fs.existsSync(path.join(fixture.dest, 'include', 'algorithm'))).toBe(false);
    expect(fs.existsSync(path.join(fixture.dest, 'include', 'ALGORITHM'))).toBe(false);
  });

  it('refuses a tree missing a required directory, and creates nothing on a rerun', () => {
    fs.rmSync(path.join(fixture.msvc, 'LIB'), { recursive: true });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(() => runSetup(fixture)).toThrow();
      expect(fs.existsSync(fixture.dest)).toBe(false);
    }
  });
});
