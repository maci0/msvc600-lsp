"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildArgs = buildArgs;
exports.syntaxCheck = syntaxCheck;
exports.createTempFile = createTempFile;
exports.removeTempFile = removeTempFile;
exports.syntaxCheckContent = syntaxCheckContent;
const child_process_1 = require("child_process");
const crypto_1 = require("crypto");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const config_1 = require("./config");
/** Retries the unlink: a just-killed Wine process can still hold the file open. */
const TEMP_UNLINK_MAX_RETRIES = 3;
const TEMP_UNLINK_RETRY_DELAY_MS = 25;
/**
 * Builds the CL.EXE argument list for a syntax-only check.
 * Selects /TC (C) or /TP (C++) based on file extension.
 */
function buildArgs(config, filePath) {
    const args = ['/nologo', '/Zs'];
    args.push(`/W${config.warnLevel}`);
    for (const inc of config.includePaths) {
        // Wine cannot resolve POSIX paths — only absolute POSIX paths need conversion;
        // Windows-style and relative paths are already in a form CL.EXE understands.
        const resolvedInc = config.useWine && inc.startsWith('/') ? (0, config_1.toWinePath)(inc) : inc;
        args.push('/I', resolvedInc);
    }
    const ext = path.extname(filePath).toLowerCase();
    if (config_1.CPP_EXTENSIONS.includes(ext)) {
        args.push('/TP');
    }
    else if (config_1.C_EXTENSIONS.includes(ext)) {
        args.push('/TC');
    }
    args.push(...config.additionalFlags);
    args.push(config.useWine ? (0, config_1.toWinePath)(filePath) : filePath);
    return args;
}
/**
 * Extracts the child process exit code from an `execFile` callback error.
 *
 * Node.js `ExecException` always sets `error.code` to a *string* (e.g.
 * `'ENOENT'`, `'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'`). The numeric exit
 * code — when the child ran but returned non-zero — is exposed on the
 * non-standard `status` property set by `child_process` internals.
 * We check `status` first to avoid silently flattening every CL.EXE
 * failure to exit code 1.
 */
function getExitCode(error) {
    if (!error)
        return 0;
    const asExec = error;
    if (typeof asExec.status === 'number')
        return asExec.status;
    return 1;
}
/**
 * Runs CL.EXE in syntax-check mode (`/Zs`) on the given file.
 *
 * Always resolves — compiler errors are reported via `exitCode` and
 * `rawOutput`, not via promise rejection. Only rejects when the
 * executable itself cannot be spawned (e.g. ENOENT, EACCES).
 */
function syntaxCheck(config, filePath, opts = {}) {
    return new Promise((resolve, reject) => {
        const args = buildArgs(config, filePath);
        const executable = config.useWine ? config.wineExecutable : config.clPath;
        const execArgs = config.useWine ? [config.clPath, ...args] : args;
        const env = config.useWine
            ? { ...process.env, WINEDEBUG: '-all' }
            : { ...process.env };
        (0, child_process_1.execFile)(executable, execArgs, 
        // killSignal: SIGKILL because Wine ignores SIGTERM reliably.
        { env, timeout: 30000, maxBuffer: 1024 * 1024, signal: opts.signal, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
            if (error && typeof error.code === 'string') {
                const isSpawnFailure = error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'ENOTDIR';
                if (isSpawnFailure && !stdout && !stderr) {
                    reject(new Error(`Failed to execute ${executable}: ${error.code}`));
                    return;
                }
                if (error.code === 'ABORT_ERR') {
                    reject(error);
                    return;
                }
            }
            const truncated = error != null &&
                typeof error.code === 'string' &&
                error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
            const exitCode = getExitCode(error);
            const rawOutput = stdout + '\n' + stderr;
            resolve({ stdout, stderr, exitCode, rawOutput, truncated });
        });
    });
}
/**
 * Writes `content` to a uniquely named, owner-only temp file and returns its path.
 *
 * The caller owns the file and must pass it to {@link removeTempFile}.
 */
function createTempFile(content, langId) {
    const ext = langId === 'cpp' ? '.cpp' : '.c';
    const tempFile = path.join(os.tmpdir(), `msvc6_lsp_${(0, crypto_1.randomUUID)()}${ext}`);
    fs.writeFileSync(tempFile, content, { encoding: 'utf-8', mode: 0o600 });
    return tempFile;
}
/**
 * Deletes a temp file, retrying briefly while a killed Wine process releases it.
 *
 * A plain `unlinkSync` fails with EBUSY/EPERM while the compiler it belongs to
 * is still shutting down, and an aborted run hits that path on every edit —
 * each failure would strand one file in the temp directory for the session.
 * `force` makes an already-removed file a no-op.
 */
function removeTempFile(filePath) {
    try {
        fs.rmSync(filePath, {
            force: true,
            maxRetries: TEMP_UNLINK_MAX_RETRIES,
            retryDelay: TEMP_UNLINK_RETRY_DELAY_MS,
        });
    }
    catch {
        // Nothing else can reach this path once the run has settled, and a
        // leftover temp file is not worth failing a check over.
    }
}
/**
 * Writes `content` to a temp file and runs a syntax check on it.
 * The temp file is cleaned up after the check completes.
 *
 * **Public API** — not used internally by the LSP server (which manages its
 * own temp files for abort/stale-result handling), but exported for
 * programmatic consumers who want a simpler one-shot interface.
 */
async function syntaxCheckContent(config, content, languageId) {
    const tempFile = createTempFile(content, languageId === 'cpp' ? 'cpp' : 'c');
    try {
        const result = await syntaxCheck(config, tempFile);
        return { ...result, tempFile };
    }
    finally {
        removeTempFile(tempFile);
    }
}
//# sourceMappingURL=compiler.js.map