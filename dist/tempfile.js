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
exports.DocumentTooLargeError = exports.MAX_SOURCE_BYTES = exports.TEMP_PREFIX = void 0;
exports.createSystemTempFileStore = createSystemTempFileStore;
exports.createSimulatedTempFileStore = createSimulatedTempFileStore;
exports.createTempSource = createTempSource;
exports.staleTempMinAgeMs = staleTempMinAgeMs;
exports.sweepStaleTempFiles = sweepStaleTempFiles;
const crypto_1 = require("crypto");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const encoding_1 = require("./encoding");
const config_1 = require("./config");
/**
 * Prefix shared by every temp file the server creates, so leaked files are
 * identifiable. Both the store below and the compiler's own scratch-source
 * writer name files with it, and the sweep that reclaims them matches on it: a
 * second copy of this string would leave one writer's orphans unswept forever.
 */
exports.TEMP_PREFIX = 'msvc6_lsp_';
/** Temp files hold unsaved editor buffers — 0o600 keeps other local users out. */
const TEMP_FILE_MODE = 0o600;
/** Digits in the simulated store's sequence-derived file names. */
const SIMULATED_NAME_DIGITS = 6;
/**
 * Age at which a scratch file is treated as orphaned by a crashed run. Above
 * the default `checkTimeoutMs`, the longest a check takes out of the box, so a
 * file in flight inside another server process is never removed. A caller
 * running with a longer `checkTimeoutMs` must raise the age with it; see
 * {@link staleTempMinAgeMs}.
 */
const STALE_TEMP_MIN_AGE_MS = 60 * 60 * 1000;
/** Slack added to the check timeout when deriving the sweep's stale age. */
const STALE_TEMP_AGE_MARGIN_MS = 60 * 1000;
/** Upper bound on the source text handed to a syntax check. */
exports.MAX_SOURCE_BYTES = 8 * 1024 * 1024;
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
 * Encodes `content` to the bytes a scratch source is written as, refusing a
 * buffer the compiler would not accept. One check, so a file on disk and the
 * reported size can never disagree, whichever write path staged it.
 */
function encodeSource(content) {
    const body = (0, encoding_1.encodeSourceText)(content);
    if (body.byteLength > exports.MAX_SOURCE_BYTES) {
        throw new DocumentTooLargeError(body.byteLength);
    }
    return body;
}
/** A {@link TempFileStore} backed by the real filesystem. */
function createSystemTempFileStore(opts = {}) {
    const dir = opts.dir ?? os.tmpdir();
    const generateName = opts.generateName ?? crypto_1.randomUUID;
    return {
        write(content, extension) {
            const file = path.join(dir, `${exports.TEMP_PREFIX}${generateName()}${extension}`);
            // `wx` fails if the path is taken, so a file or symlink another local
            // user planted in the shared temp directory is never written through.
            fs.writeFileSync(file, encodeSource(content), { mode: TEMP_FILE_MODE, flag: 'wx' });
            return file;
        },
        remove(file) {
            try {
                fs.unlinkSync(file);
            }
            catch {
                // Temp file may already be gone, or never created. Nothing to clean up.
            }
        },
    };
}
/**
 * A deterministic {@link TempFileStore} for tests and simulation.
 *
 * Names are derived from a call counter instead of entropy, so the same call
 * sequence always yields the same paths, the same `CL.EXE` argument vector, and
 * therefore the same diagnostics.
 */
function createSimulatedTempFileStore(opts = {}) {
    const dir = opts.dir ?? os.tmpdir();
    const files = new Map();
    const events = [];
    let sequence = 0;
    let pendingWriteError = null;
    return {
        files,
        events,
        write(content, extension) {
            if (pendingWriteError) {
                const error = pendingWriteError;
                pendingWriteError = null;
                throw error;
            }
            sequence += 1;
            const file = path.join(dir, `${exports.TEMP_PREFIX}${String(sequence).padStart(SIMULATED_NAME_DIGITS, '0')}${extension}`);
            files.set(file, content);
            events.push({ op: 'write', file, content });
            return file;
        },
        remove(file) {
            files.delete(file);
            events.push({ op: 'remove', file, content: '' });
        },
        read(file) {
            return files.get(file);
        },
        failNextWrite(error) {
            pendingWriteError = error;
        },
    };
}
/**
 * Writes `content` to a fresh scratch source in the OS temp directory and
 * returns its path. The bytes written are the prepared UTF-8 source, so the
 * size check and the file on disk agree. The caller owns the file and must
 * unlink it.
 *
 * The create is exclusive (`wx`): a path that already exists in the shared
 * temp directory is an error rather than something to truncate, so a file or
 * symlink planted by another local user is never written through. `mode`
 * applies only to a file this call creates, which is why the flag matters.
 */
function createTempSource(content, ext) {
    return createSystemTempFileStore().write(content, ext);
}
/**
 * The age a scratch source must reach before it is certainly not being read by
 * a live check: the configured check timeout, plus slack for staging and
 * cleanup. The sweep is a global delete over a shared directory, so its age
 * has to cover the slowest check in *any* running server, not just this one's
 * default.
 */
function staleTempMinAgeMs(checkTimeoutMs) {
    return Math.max(STALE_TEMP_MIN_AGE_MS, checkTimeoutMs + STALE_TEMP_AGE_MARGIN_MS);
}
/**
 * Deletes scratch sources left behind by a run that was killed before its
 * cleanup, and returns the paths removed. A server that is restarted after a
 * crash otherwise accumulates one orphaned file per interrupted check, and no
 * later run ever reclaims them. Removing only files older than `minAgeMs`
 * keeps this safe alongside a concurrently running server: the age bounds how
 * long a file a live check is still reading can survive, and a sweep never
 * removes a file it cannot prove is abandoned. Running it twice in a row
 * removes nothing the second time, because the first pass already unlinked
 * what it found.
 */
function sweepStaleTempFiles(opts = {}) {
    const now = opts.now ?? Date.now();
    const minAgeMs = opts.minAgeMs ?? STALE_TEMP_MIN_AGE_MS;
    const removed = [];
    for (const entry of fs.readdirSync(os.tmpdir())) {
        if (!entry.startsWith(exports.TEMP_PREFIX))
            continue;
        if (!config_1.SCRATCH_EXTENSIONS.some((ext) => entry.endsWith(ext)))
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
        if (now - stats.mtimeMs < minAgeMs)
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
//# sourceMappingURL=tempfile.js.map