import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
export const MSVC_ROOT = path.join(PROJECT_ROOT, 'VC', 'VC98');
export const CL_EXE = path.join(MSVC_ROOT, 'BIN', 'CL.EXE');
export const SERVER_ENTRY = path.join(PROJECT_ROOT, 'dist', 'server.js');

/** Why the real MSVC6 toolchain cannot run here, or null when it can. */
export type ToolchainBlocker = 'msvc6-missing' | 'wine-missing' | 'not-built';

function which(command: string): string | null {
  try {
    return execFileSync('sh', ['-c', `command -v ${command}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

export function toolchainBlocker(): ToolchainBlocker | null {
  if (!fs.existsSync(CL_EXE)) return 'msvc6-missing';
  if (process.platform !== 'win32' && !which('wine')) return 'wine-missing';
  if (!fs.existsSync(SERVER_ENTRY)) return 'not-built';
  return null;
}

const BLOCKER_HINT: Record<ToolchainBlocker, string> = {
  'msvc6-missing': `CL.EXE not found at ${CL_EXE}. Place the MSVC 6.0 tree in VC/VC98.`,
  'wine-missing': 'wine not found on PATH. Install Wine, or set useWine=false on Windows.',
  'not-built': `dist/server.js missing. Run "bun run build" first.`,
};

/** True when the wine/CL.EXE integration tests can run on this machine. */
export function hasMsvcToolchain(): boolean {
  return blockerForTests() === null;
}

function blockerForTests(): ToolchainBlocker | null {
  const blocker = toolchainBlocker();
  if (blocker === 'not-built') return null; // buildArgs/syntaxCheck tests do not need dist/
  return blocker;
}

export function skipReason(): string {
  const blocker = toolchainBlocker();
  if (blocker === null) return '';
  const hint = BLOCKER_HINT[blocker];
  console.warn(`[skipped] MSVC6 integration tests need the real toolchain: ${hint}`);
  return hint;
}
