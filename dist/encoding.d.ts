/**
 * Text preparation at the boundary between the editor's in-memory buffer and
 * the UTF-8 file CL.EXE reads. Every helper is pure and idempotent, so a
 * document may pass through them more than once without changing.
 */
/** Removes UTF-16 code units that are not part of a well-formed pair. */
export declare function stripLoneSurrogates(text: string): string;
/**
 * Drops a leading U+FEFF. Editors hand buffers over with a UTF-8 BOM intact,
 * and MSVC6 lexes those three bytes as source, reporting an error on the
 * first declaration of an otherwise valid file.
 *
 * A U+FEFF anywhere else is left alone: inside a buffer it is a zero-width
 * no-break space, not a BOM, and removing it would change the source.
 */
export declare function stripByteOrderMark(content: string): string;
/**
 * The exact characters CL.EXE will read for `content`: no BOM, no ill-formed
 * UTF-16. Callers that measure a size limit against the resulting UTF-8 bytes
 * must encode this, not the original string.
 */
export declare function prepareSourceText(content: string): string;
/**
 * The exact bytes CL.EXE will read for `content`, UTF-8 encoded. Measuring a
 * size limit against this buffer is the same measurement the file on disk
 * carries.
 */
export declare function encodeSourceText(content: string): Buffer;
//# sourceMappingURL=encoding.d.ts.map