/**
 * Characters that must not reach the client's log verbatim: C0 and C1
 * controls, the Unicode line and paragraph separators, the invisible and
 * bidi-control ranges, and the variation selectors. Error text handed to the
 * logger carries config-supplied paths and compiler output, so a newline or an
 * escape in either can forge a log line, reorder the text around it, or make
 * two different paths render identically.
 *
 * The invisible ranges are listed in full because each is a separate block:
 * a filler such as U+3000 or U+1160 pads one path out to the width of another
 * while comparing unequal, U+FEFF hides a byte-order mark in the middle of a
 * line, and a variation selector or tag character keeps two spellings of the
 * same base character from looking alike in the log but differing on disk.
 * The spaces are here for the same reason as the fillers: U+00A0, U+2007 and
 * U+202F all render as a space at any width, so two paths differing only in
 * which space they use are one difference the eye cannot see. U+034F shows
 * nothing and combines with nothing while splitting the grapheme it sits in,
 * and U+180B-U+180D are Mongolian free variation selectors, the same trick as
 * U+FE00-U+FE0F.
 */
const LOG_UNSAFE = /[\u0000-\u001f\u007f-\u009f\u00a0\u00ad\u034f\u061c\u180b-\u180f\u2028\u2029\u2007\u200b-\u200f\u202a-\u202e\u202f\u2060-\u206f\u2329\u232a\u3000\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffb]|[\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;

/** Replaces every control, format, and bidi character with `?`. */
export function sanitizeForLog(text: string): string {
  return text.replace(LOG_UNSAFE, '?');
}
