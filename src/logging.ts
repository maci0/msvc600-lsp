/**
 * Characters that must not reach the client's log verbatim: C0 and C1
 * controls, the Unicode line and paragraph separators, zero-width marks, and
 * the bidi overrides. Error text handed to the logger carries config-supplied
 * paths and compiler output, so a newline or an escape in either can forge a
 * log line or reorder the text around it.
 */
const LOG_UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Replaces every control, format, and bidi character with `?`. */
export function sanitizeForLog(text: string): string {
  return text.replace(LOG_UNSAFE, '?');
}
