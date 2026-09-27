import { execFileSync } from 'child_process';
import { describe } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
export const MSVC_ROOT = path.join(PROJECT_ROOT, 'VC', 'VC98');
export const CL_EXE = path.join(MSVC_ROOT, 'BIN', 'CL.EXE');

/** Why a real CL.EXE run cannot happen on this machine, or null when it can. */
export type ToolchainBlocker = 'msvc6-missing' | 'wine-missing';

const BLOCKER_HINT: Record<ToolchainBlocker, string> = {
  'msvc6-missing': `CL.EXE not found at ${CL_EXE}; put the MSVC 6.0 tree in VC/VC98`,
  'wine-missing': 'wine not found on PATH; install Wine or run natively on Windows',
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

/** Blocker for spawning the real compiler, or null when CL.EXE can run. */
export function compilerBlocker(): ToolchainBlocker | null {
  if (!fs.existsSync(CL_EXE)) return 'msvc6-missing';
  if (process.platform !== 'win32' && !which('wine')) return 'wine-missing';
  return null;
}

/** `describe` that skips when the real MSVC6 toolchain is unavailable. */
const blocker = compilerBlocker();
if (blocker) {
  console.warn(`[skip] MSVC6 integration tests disabled: ${BLOCKER_HINT[blocker]}`);
}

export const describeWithToolchain = describe.skipIf(blocker !== null);
