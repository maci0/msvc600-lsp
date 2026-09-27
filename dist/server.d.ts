import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Msvc6Config } from './config';
declare const connection: import("vscode-languageserver/node")._Connection<import("vscode-languageserver/node")._, import("vscode-languageserver/node")._, import("vscode-languageserver/node")._, import("vscode-languageserver/node")._, import("vscode-languageserver/node")._, import("vscode-languageserver/node")._, import("vscode-languageserver/lib/common/inlineCompletion.proposed").InlineCompletionFeatureShape, import("vscode-languageserver/node")._>;
declare const documents: TextDocuments<TextDocument>;
declare function validateDocument(textDocument: TextDocument): Promise<void>;
/** Returns the current live config — typed `Readonly` to prevent accidental mutation. */
declare function getConfig(): Readonly<Msvc6Config>;
export { connection, documents, getConfig, validateDocument };
//# sourceMappingURL=server.d.ts.map