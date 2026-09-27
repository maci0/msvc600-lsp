import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe } from 'vitest';

export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
export const MSVC_ROOT = path.join(PROJECT_ROOT, 'VC', 'VC98');
export const CL_EXE = path.join(MSVC_ROOT, 'BIN', 'CL.EXE');
export const SERVER_ENTRY = path.join(PROJECT_ROOT, 'dist', 'server.js');

/** Why a real CL.EXE run cannot happen on this machine, or null when it can. */
export type ToolchainBlocker = 'msvc6-missing' | 'wine-missing' | 'not-built';

const BLOCKER_HINT: Record<ToolchainBlocker, string> = {
  'msvc6-missing': `CL.EXE not found at ${CL_EXE}; put the MSVC 6.0 tree in VC/VC98`,
  'wine-missing': 'wine not found on PATH; install Wine or run natively on Windows',
  'not-built': `dist/server.js missing; run "bun run build"`,
};

function which(command: string): boolean {
  try {
    execFileSync('sh', ['-c', `command -v ${command}`], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/** Blocker for spawning the real compiler. `dist/` only matters to the server tests. */
export function compilerBlocker(): ToolchainBlocker | null {
  if (!fs.existsSync(CL_EXE)) return 'msvc6-missing';
  if (process.platform !== 'win32' && !which('wine')) return 'wine-missing';
  return null;
}

export function serverBlocker(): ToolchainBlocker | null {
  const blocker = compilerBlocker() ?? (fs.existsSync(SERVER_ENTRY) ? null : 'not-built');
  if (blocker) {
    console.warn(`[skip] MSVC6 integration tests disabled: ${BLOCKER_HINT[blocker]}`);
  }
  return blocker;
}

/** `describe` that skips when the real MSVC6 toolchain is unavailable. */
export const describeWithCompiler = describe.skipIf(compilerBlocker() !== null);
export const describeWithServer = describe.skipIf(serverBlocker() !== null);
