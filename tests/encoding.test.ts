import { describe, it, expect } from 'vitest';
import { encodeSourceText, prepareSourceText, stripByteOrderMark, stripLoneSurrogates } from '../src/encoding';

describe('stripByteOrderMark', () => {
  it('removes a leading U+FEFF', () => {
    expect(stripByteOrderMark('\ufeffint main(void) { return 0; }')).toBe(
      'int main(void) { return 0; }',
    );
  });

  it('leaves content without a BOM untouched', () => {
    expect(stripByteOrderMark('int main(void) { return 0; }')).toBe(
      'int main(void) { return 0; }',
    );
  });

  it('only removes the first BOM, so a BOM later in the file survives', () => {
    expect(stripByteOrderMark('a\ufeffb')).toBe('a\ufeffb');
  });
});

describe('stripLoneSurrogates', () => {
  it('drops an unpaired high surrogate', () => {
    expect(stripLoneSurrogates('a\ud800b')).toBe('ab');
  });

  it('drops an unpaired low surrogate', () => {
    expect(stripLoneSurrogates('a\udc00b')).toBe('ab');
  });

  it('keeps a well-formed surrogate pair as the character it encodes', () => {
    expect(stripLoneSurrogates('a\ud83d\ude00b')).toBe('a\u{1f600}b');
  });

  it('keeps a pair that follows a dropped half', () => {
    expect(stripLoneSurrogates('\ud800\ud83d\ude00')).toBe('\u{1f600}');
  });

  it('leaves ASCII and well-formed non-ASCII text alone', () => {
    const source = 'const char *s = "caf\u00e9 \u4e2d\u6587";';
    expect(stripLoneSurrogates(source)).toBe(source);
  });
});

describe('encodeSourceText', () => {
  it('writes well-formed UTF-8 rather than substituting U+FFFD', () => {
    expect(encodeSourceText('a\ud800b').toString('utf-8')).toBe('ab');
  });

  it('drops the BOM from the encoded bytes', () => {
    expect(encodeSourceText('\ufeffint x;').toString('utf-8')).toBe('int x;');
  });

  it('reports a byte length that matches what lands on disk', () => {
    const text = 'a\ud800b';
    // 2 bytes written; the raw string measures 5 because the lone half would
    // otherwise be replaced by a three-byte U+FFFD.
    expect(encodeSourceText(text).byteLength).toBe(2);
    expect(Buffer.byteLength(text, 'utf-8')).toBe(5);
  });

  it('encodes astral characters as their four-byte UTF-8 form', () => {
    expect(encodeSourceText('\u{1f600}').byteLength).toBe(4);
  });

  it('is idempotent, so a second pass does not change the bytes', () => {
    const once = encodeSourceText('\ufeffa\ud800b');
    expect(encodeSourceText(once.toString('utf-8'))).toEqual(once);
  });
});

describe('prepareSourceText', () => {
  it('strips both a BOM and an ill-formed half', () => {
    expect(prepareSourceText('\ufeffint x;\udfff')).toBe('int x;');
  });
});
