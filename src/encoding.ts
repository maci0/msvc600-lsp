/**
 * Text preparation at the boundary between the editor's in-memory buffer and
 * the UTF-8 file CL.EXE reads. Every helper is pure and idempotent, so a
 * document may pass through them more than once without changing.
 */

/**
 * A UTF-16 code unit that cannot start or continue a surrogate pair. JSON
 * accepts `"\ud800"` as a complete string, so a client (or any producer of the
 * buffer) can hand over text that is not valid UTF-16. `Buffer.from(text,
 * 'utf-8')` replaces each such unit with U+FFFD, which silently changes the
 * source the compiler sees and makes the file longer than the byte length the
 * caller measured. Dropping the unit is the faithful reading: an unpaired half
 * encodes no character at all.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Removes UTF-16 code units that are not part of a well-formed pair. */
export function stripLoneSurrogates(text: string): string {
  return text.replace(LONE_SURROGATE, '');
}

/**
 * Drops a leading U+FEFF. Editors hand buffers over with a UTF-8 BOM intact,
 * and MSVC6 lexes those three bytes as source, reporting an error on the
 * first declaration of an otherwise valid file.
 *
 * A U+FEFF anywhere else is left alone: inside a buffer it is a zero-width
 * no-break space, not a BOM, and removing it would change the source.
 */
export function stripByteOrderMark(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

/**
 * The exact characters CL.EXE will read for `content`: no BOM, no ill-formed
 * UTF-16. Callers that measure a size limit against the resulting UTF-8 bytes
 * must encode this, not the original string.
 */
export function prepareSourceText(content: string): string {
  return stripLoneSurrogates(stripByteOrderMark(content));
}

/**
 * The exact bytes CL.EXE will read for `content`, UTF-8 encoded. Measuring a
 * size limit against this buffer is the same measurement the file on disk
 * carries.
 */
export function encodeSourceText(content: string): Buffer {
  return Buffer.from(prepareSourceText(content), 'utf-8');
}
