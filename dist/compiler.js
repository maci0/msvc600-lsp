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
exports.DocumentTooLargeError = exports.MAX_OUTPUT_BYTES = exports.COMPILE_TIMEOUT_MS = exports.MAX_CONCURRENT_CHECKS = exports.MAX_SOURCE_BYTES = void 0;
exports.buildArgs = buildArgs;
exports.createTempSource = createTempSource;
exports.syntaxCheck = syntaxCheck;
exports.sweepStaleTempFiles = sweepStaleTempFiles;
exports.stripByteOrderMark = stripByteOrderMark;
exports.createTempSourceFile = createTempSourceFile;
exports.removeTempSourceFile = removeTempSourceFile;
exports.syntaxCheckContent = syntaxCheckContent;
const child_process_1 = require("child_process");
const crypto_1 = require("crypto");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const util_1 = require("util");
const config_1 = require("./config");
const encoding_1 = require("./encoding");
const wine_path_1 = require("./wine-path");
const tempfile_1 = require("./tempfile");
const concurrency_1 = require("./concurrency");
/** Scratch sources are named with this prefix so a crashed run leaves identifiable leftovers. */
const TEMP_SOURCE_PREFIX = 'msvc6_lsp_';
/** Suffixes a scratch source may carry. */
const TEMP_SOURCE_EXTENSIONS = ['.c', '.cpp'];
/**
 * Age at which a scratch file is treated as orphaned by a crashed run. Well
 * above the 30s check timeout, so a file in flight inside another server
 * process is never removed.
 */
const STALE_TEMP_MIN_AGE_MS = 60 * 60 * 1000;
/** Upper bound on the source text handed to a syntax check. */
exports.MAX_SOURCE_BYTES = 8 * 1024 * 1024;
/**
 * Concurrent CL.EXE children allowed at once. Each one is a heavyweight process
 * (a full Wine services startup on non-Windows), so the number is kept at the
 * parallelism a developer machine absorbs; the rest queue rather than dropping.
 * The server schedules through the same number, so the two layers of the
 * pipeline agree on one limit.
 */
exports.MAX_CONCURRENT_CHECKS = 2;
/** Wall-clock limit for one CL.EXE run before the process is killed. */
exports.COMPILE_TIMEOUT_MS = 30000;
/** Cap on captured stdout and stderr, per stream. */
exports.MAX_OUTPUT_BYTES = 1024 * 1024;
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
        const resolvedInc = config.useWine && inc.startsWith('/') ? (0, wine_path_1.toWinePath)(inc) : inc;
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
    args.push(config.useWine ? (0, wine_path_1.toWinePath)(filePath) : filePath);
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
 * Decodes CL.EXE output bytes. A `TextDecoder` never throws on malformed
 * input, so undecodable bytes become U+FFFD rather than aborting the check.
 */
function decodeOutput(bytes, decoder) {
    return decoder.decode(bytes);
}
/**
 * Whether the child was killed by the exec timeout rather than by the caller.
 * A timeout kill carries no string `code` (it is `null`) and no `status`, so
 * only `killed` distinguishes it from an ordinary non-zero exit.
 */
function isTimeoutKill(error) {
    return error != null && error.killed === true;
}
/** Raised when a buffer exceeds {@link MAX_SOURCE_BYTES}. */
class DocumentTooLargeError extends Error {
    byteLength;
    constructor(byteLength) {
        super(`document is ${byteLength} bytes, over the ${exports.MAX_SOURCE_BYTES} byte syntax-check limit`);
        this.name = 'DocumentTooLargeError';
        this.byteLength = byteLength;
    }
}
exports.DocumentTooLargeError = DocumentTooLargeError;
/**
 * Writes `content` to a fresh temp file with the given extension and returns
 * its path. The bytes written are the prepared UTF-8 source, so the size check
 * and the file on disk agree. The caller owns the file and must unlink it.
 *
 * The create is exclusive (`wx`): a path that already exists in the shared
 * temp directory is an error rather than something to truncate, so a file or
 * symlink planted by another local user is never written through. `mode`
 * applies only to a file this call creates, which is why the flag matters.
 */
function createTempSource(content, ext) {
    const body = (0, encoding_1.encodeSourceText)(content);
    if (body.byteLength > exports.MAX_SOURCE_BYTES) {
        throw new DocumentTooLargeError(body.byteLength);
    }
    const tempFile = path.join(os.tmpdir(), `${TEMP_SOURCE_PREFIX}${(0, crypto_1.randomUUID)()}${ext}`);
    fs.writeFileSync(tempFile, body, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
    return tempFile;
}
const checkSlots = new concurrency_1.Semaphore(exports.MAX_CONCURRENT_CHECKS);
function abortError() {
    const error = new Error('CL.EXE check aborted');
    error.code = 'ABORT_ERR';
    return error;
}
/**
 * Runs CL.EXE in syntax-check mode (`/Zs`) on the given file.
 *
 * At most {@link MAX_CONCURRENT_CHECKS} children run at once; the rest queue,
 * so a burst of open documents cannot spawn an unbounded number of Wine
 * processes. A queued check whose signal aborts leaves the queue without ever
 * taking a slot.
 *
 * Always resolves — compiler errors are reported via `exitCode` and
 * `rawOutput`, not via promise rejection. Rejects only when no check could
 * be attempted at all: the executable could not be spawned (ENOENT, EACCES,
 * ENOTDIR), the call was aborted, or `outputEncoding` is not a known label.
 * A run that was killed by `timeoutMs` resolves with `timedOut: true` and an
 * exit code that carries no diagnostic meaning.
 */
async function syntaxCheck(config, filePath, opts = {}) {
    const release = await checkSlots.acquire(opts.signal);
    if (release === null)
        throw abortError();
    try {
        if (opts.signal?.aborted)
            throw abortError();
        return await runCheck(config, filePath, opts);
    }
    finally {
        release();
    }
}
function runCheck(config, filePath, opts) {
    return new Promise((resolve, reject) => {
        const args = buildArgs(config, filePath);
        const executable = config.useWine ? config.wineExecutable : config.clPath;
        const execArgs = config.useWine ? [config.clPath, ...args] : args;
        const env = config.useWine
            ? { ...process.env, WINEDEBUG: '-all' }
            : { ...process.env };
        // Built before the spawn: an unknown encoding label throws here, and a
        // throw inside the executor rejects instead of escaping from the
        // execFile callback as an uncaught exception.
        let decoder;
        try {
            decoder = new util_1.TextDecoder(config.outputEncoding);
        }
        catch (e) {
            reject(new Error(`Cannot run ${executable} on ${filePath}: unsupported outputEncoding ` +
                `${JSON.stringify(config.outputEncoding)} (${e.message})`));
            return;
        }
        (0, child_process_1.execFile)(executable, execArgs, 
        // killSignal: SIGKILL because Wine ignores SIGTERM reliably.
        // encoding: 'buffer' keeps the raw code-page bytes; they are decoded
        // below with the configured output encoding, not assumed to be UTF-8.
        {
            env,
            timeout: opts.timeoutMs ?? config.checkTimeoutMs,
            maxBuffer: config.maxOutputBytes,
            signal: opts.signal,
            killSignal: 'SIGKILL',
            encoding: 'buffer',
        }, (error, stdoutBytes, stderrBytes) => {
            const stdout = decodeOutput(stdoutBytes, decoder);
            const stderr = decodeOutput(stderrBytes, decoder);
            if (error) {
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
            const timedOut = !truncated && isTimeoutKill(error);
            const exitCode = getExitCode(error);
            const rawOutput = stdout + '\n' + stderr;
            resolve({ stdout, stderr, exitCode, rawOutput, truncated, timedOut });
        });
    });
}
/**
 * Deletes scratch sources left behind by a run that was killed before its
 * cleanup, and returns the paths removed. A server that is restarted after a
 * crash otherwise accumulates one orphaned file per interrupted check, and no
 * later run ever reclaims them. Removing only files older than
 * {@link STALE_TEMP_MIN_AGE_MS} keeps this safe alongside a concurrently
 * running server; running it twice in a row removes nothing the second time.
 */
function sweepStaleTempFiles(now = Date.now()) {
    const removed = [];
    for (const entry of fs.readdirSync(os.tmpdir())) {
        if (!entry.startsWith(TEMP_SOURCE_PREFIX))
            continue;
        if (!TEMP_SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext)))
            continue;
        const file = path.join(os.tmpdir(), entry);
        let stats;
        try {
            stats = fs.lstatSync(file);
        }
        catch {
            continue; // Vanished between listing and stat.
        }
        if (!stats.isFile())
            continue;
        if (now - stats.mtimeMs < STALE_TEMP_MIN_AGE_MS)
            continue;
        try {
            fs.unlinkSync(file);
            removed.push(file);
        }
        catch {
            // Another process removed it first, or it is not ours to delete.
        }
    }
    return removed;
}
/**
 * Drops a leading U+FEFF. Editors hand buffers over with a UTF-8 BOM intact,
 * and MSVC6 lexes those three bytes as source, reporting an error on the
 * first declaration of an otherwise valid file.
 */
function stripByteOrderMark(content) {
    return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}
/**
 * Writes `content` to a fresh temp file with `ext` and returns its path.
 * The caller owns the file and must pass the path to {@link removeTempSourceFile}.
 */
function createTempSourceFile(content, ext) {
    const tempFile = path.join(os.tmpdir(), `msvc6_lsp_${(0, crypto_1.randomUUID)()}${ext}`);
    fs.writeFileSync(tempFile, stripByteOrderMark(content), { encoding: 'utf-8', mode: 0o600 });
    return tempFile;
}
/** Deletes a temp source file. A file that is already gone is not an error. */
function removeTempSourceFile(tempFile) {
    try {
        fs.unlinkSync(tempFile);
    }
    catch {
        // Already removed, or never created.
    }
}
/**
 * Writes `content` to a temp file and runs a syntax check on it.
 * The temp file is cleaned up after the check completes.
 *
 * Exported for the test suite; the server drives {@link createTempSourceFile}
 * itself so it can abort stale checks.
 */
async function syntaxCheckContent(config, content, languageId, opts = {}) {
    const ext = languageId === 'cpp' ? '.cpp' : '.c';
    const store = opts.store ?? (0, tempfile_1.createSystemTempFileStore)();
    const tempFile = store.write((0, encoding_1.prepareSourceText)(content), ext);
    try {
        const result = await syntaxCheck(config, tempFile);
        return { ...result, tempFile };
    }
    finally {
        store.remove(tempFile);
    }
}
//# sourceMappingURL=compiler.js.map