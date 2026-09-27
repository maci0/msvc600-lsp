import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Msvc6Config } from './config';
declare const connection: import("vscode-languageserver/node")._Connection<import("vscode-languageserver/node")._, import("vscode-languageserver/node")._, import("vscode-languageserver/node")._, import("vscode-languageserver/node")._, import("vscode-languageserver/node")._, import("vscode-languageserver/node")._, import("vscode-languageserver/lib/common/inlineCompletion.proposed").InlineCompletionFeatureShape, import("vscode-languageserver/node")._>;
declare const documents: TextDocuments<TextDocument>;
/**
 * Queues a syntax check for `textDocument`, superseding any check already
 * queued or running for the same URI. The sequence number is taken here, at
 * submission, so a result can be matched back to the request that produced it
 * even while it waits for a free slot.
 */
declare function scheduleValidation(textDocument: TextDocument): void;
/** Returns the current live config — typed `Readonly` to prevent accidental mutation. */
declare function getConfig(): Readonly<Msvc6Config>;
export { connection, documents, getConfig, scheduleValidation };
//# sourceMappingURL=server.d.ts.map