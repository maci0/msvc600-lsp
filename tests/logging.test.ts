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

  it('replaces characters that render as nothing but change the bytes', () => {
    // A path padded with U+3000 compares unequal to the same path without it.
    expect(sanitizeForLog('cl.exe\u3000')).toBe('cl.exe?');
    expect(sanitizeForLog('a\u00adb')).toBe('a?b');
    expect(sanitizeForLog('a\u200cb')).toBe('a?b');
    expect(sanitizeForLog('a\ufeffb')).toBe('a?b');
  });

  it('replaces variation selectors, which keep two spellings looking alike', () => {
    expect(sanitizeForLog('\u2764\ufe0f')).toBe('\u2764?');
    expect(sanitizeForLog('\ud83c\udff4\udb40\udc67')).toBe('\ud83c\udff4?');
  });

  it('replaces the bidi embedding and isolate controls', () => {
    expect(sanitizeForLog('a\u2066b\u2069c')).toBe('a?b?c');
  });

  it('replaces spaces that render as a space, so two paths look the same', () => {
    expect(sanitizeForLog('a\u00a0b')).toBe('a?b');
    expect(sanitizeForLog('a\u2007b')).toBe('a?b');
    expect(sanitizeForLog('a\u202fb')).toBe('a?b');
  });

  it('replaces the grapheme-joining and Mongolian variation selectors', () => {
    expect(sanitizeForLog('a\u034fb')).toBe('a?b');
    expect(sanitizeForLog('a\u180bb')).toBe('a?b');
    expect(sanitizeForLog('a\u180eb')).toBe('a?b');
  });

  it('leaves ordinary non-ASCII text alone', () => {
    const message = 'CL.EXE failed: 错误 C1083: Cannot open source file';
    expect(sanitizeForLog(message)).toBe(message);
  });
});
