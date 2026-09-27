import { describe, it, expect } from 'vitest';
import { sanitizeForLog } from '../src/logging';

describe('sanitizeForLog', () => {
  it('leaves ordinary error text untouched', () => {
    const message = 'Validation error: Error: spawn /usr/bin/cl.exe ENOENT';
    expect(sanitizeForLog(message)).toBe(message);
  });

  it('replaces newlines so a crafted path cannot forge a log line', () => {
    const forged = 'Error: bad\n[info] toolchain path changed to /tmp/evil';
    expect(sanitizeForLog(forged)).toBe('Error: bad?[info] toolchain path changed to /tmp/evil');
  });

  it('replaces ANSI escape sequences', () => {
    expect(sanitizeForLog('\u001b[31merror\u001b[0m')).toBe('?[31merror?[0m');
  });

  it('replaces bidi overrides used to reorder displayed text', () => {
    expect(sanitizeForLog('cl.exe\u202egnp.exe')).toBe('cl.exe?gnp.exe');
  });

  it('replaces null bytes and other C0 controls', () => {
    expect(sanitizeForLog('a\u0000b\u001fc')).toBe('a?b?c');
  });
});
