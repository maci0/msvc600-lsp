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
exports.createTempSourcePath = createTempSourcePath;
exports.sweepStaleTempFiles = sweepStaleTempFiles;
exports.stripByteOrderMark = stripByteOrderMark;
exports.syntaxCheckContent = syntaxCheckContent;
const child_process_1 = require("child_process");
const crypto_1 = require("crypto");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const config_1 = require("./config");
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
 * Decodes CL.EXE output bytes. A `TextDecoder` never throws on malformed
 * input, so undecodable bytes become U+FFFD rather than aborting the check.
 */
function decodeOutput(bytes, encoding) {
    return new TextDecoder(encoding).decode(bytes);
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
        // encoding: 'buffer' keeps the raw code-page bytes; they are decoded
        // below with the configured output encoding, not assumed to be UTF-8.
        {
            env,
            timeout: 30000,
            maxBuffer: 1024 * 1024,
            signal: opts.signal,
            killSignal: 'SIGKILL',
            encoding: 'buffer',
        }, (error, stdoutBytes, stderrBytes) => {
            const stdout = decodeOutput(stdoutBytes, config.outputEncoding);
            const stderr = decodeOutput(stderrBytes, config.outputEncoding);
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
 * Returns a fresh, unused path for a scratch source file. The random name
 * makes two concurrent checks of the same document independent rather than
 * overwriting each other's input.
 */
function createTempSourcePath(languageId) {
    const ext = languageId === 'cpp' ? '.cpp' : '.c';
    return path.join(os.tmpdir(), `${TEMP_SOURCE_PREFIX}${(0, crypto_1.randomUUID)()}${ext}`);
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
 * Writes `content` to a temp file and runs a syntax check on it.
 * The temp file is cleaned up after the check completes.
 *
 * **Public API** — not used internally by the LSP server (which manages its
 * own temp files for abort/stale-result handling), but exported for
 * programmatic consumers who want a simpler one-shot interface.
 */
async function syntaxCheckContent(config, content, languageId) {
    const tempFile = createTempSourcePath(languageId);
    try {
        fs.writeFileSync(tempFile, stripByteOrderMark(content), {
            encoding: 'utf-8',
            mode: 0o600,
        });
        const result = await syntaxCheck(config, tempFile);
        return { ...result, tempFile };
    }
    finally {
        try {
            fs.unlinkSync(tempFile);
        }
        catch {
            // Temp file may already be gone — not an error.
        }
    }
}
//# sourceMappingURL=compiler.js.map