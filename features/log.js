/**
 * Northstar — logging
 *
 * The codebase leans on `try { … } catch { }` to keep one broken feature from
 * taking the window down. That is the right instinct, but it also means a
 * half-working feature leaves no trace at all. This gives those handlers
 * somewhere to put the error: a rotating file under `userData/logs` plus the
 * console, so a bug report can be more than "it just didn't work".
 *
 * Never log page content, URLs' query strings, credentials or cookies — the log
 * is a diagnostic aid, not a browsing record. Callers pass a short scope and a
 * message; the Error's stack is included, its message is not trusted to be
 * short.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 512 * 1024; // rotate at half a megabyte
const KEEP = 2; // current + one previous
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

let logDir = null;
let logPath = null;
let fd = null;     // the open log file; written synchronously (see rotate)
let size = 0;      // bytes in the current file, so rotation needs no stat per line
let minLevel = LEVELS.info;
let failed = false; // a broken log must never break the browser
let consoleDead = false; // stdout/stderr pipe went away (parent exited)
let writing = false; // re-entrancy guard: a log call must never log itself

/* When the process that launched us exits (a dev script, a test runner), our
   stdout/stderr pipes break and every console write fails with EPIPE —
   asynchronously, as an 'error' on the stream. Unhandled, that surfaced as an
   uncaughtException, which main.js logs, which wrote to the console again: a
   loop that pinned the main process and grew the log by hundreds of MB. An
   'error' listener turns it into "stop writing to the console". */
for (const s of [process.stdout, process.stderr]) {
    try {
        s?.on?.('error', () => { consoleDead = true; });
    }
    catch { consoleDead = true; }
}

function init() {
    if (logDir || failed)
        return;
    try {
        const { app } = require('electron');
        logDir = path.join(app.getPath('userData'), 'logs');
        fs.mkdirSync(logDir, { recursive: true });
        logPath = path.join(logDir, 'northstar.log');
        if (process.env.NORTHSTAR_LOG_LEVEL && LEVELS[process.env.NORTHSTAR_LOG_LEVEL])
            minLevel = LEVELS[process.env.NORTHSTAR_LOG_LEVEL];
    }
    catch {
        failed = true;
    }
}

function openLog() {
    fd = fs.openSync(logPath, 'a');
    size = fs.fstatSync(fd).size;
}

/* The file is held as a plain descriptor and closed synchronously before the
   rename. With a write stream, end() closes LATER, so on Windows the rename
   hit a still-open file, failed silently, and the log never rotated. */
function rotate() {
    if (size < MAX_BYTES)
        return;
    try {
        if (fd != null) {
            fs.closeSync(fd);
            fd = null;
        }
        for (let i = KEEP - 1; i >= 1; i--) {
            const from = i === 1 ? logPath : `${logPath}.${i - 1}`;
            const to = `${logPath}.${i}`;
            if (fs.existsSync(from))
                fs.renameSync(from, to);
        }
    }
    catch { /* rotation is best-effort */ }
    // If the rename failed, start the file over rather than let it grow.
    try {
        fd = fs.openSync(logPath, size >= MAX_BYTES * 4 ? 'w' : 'a');
        size = fs.fstatSync(fd).size;
    }
    catch { fd = null; }
}

function write(level, scope, message, err) {
    init();
    if (failed || writing || LEVELS[level] < minLevel)
        return;
    writing = true;
    try { writeLine(level, scope, message, err); }
    finally { writing = false; }
}

function writeLine(level, scope, message, err) {
    const stamp = new Date().toISOString();
    let line = `${stamp} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
    if (err) {
        const detail = err instanceof Error ? (err.stack || err.message) : String(err);
        line += `\n    ${String(detail).split('\n').join('\n    ')}`;
    }
    if (!consoleDead) {
        try {
            if (level === 'error' || level === 'warn')
                console[level === 'error' ? 'error' : 'warn'](line);
            else if (process.env.NORTHSTAR_LOG_LEVEL)
                console.log(line);
        }
        catch { consoleDead = true; }
    }
    try {
        if (fd == null)
            openLog();
        rotate();
        if (fd == null)
            return;
        const buf = Buffer.from(line + '\n');
        fs.writeSync(fd, buf);
        size += buf.length;
    }
    catch {
        failed = true; // disk full / read-only profile — stop trying
    }
}

const log = {
    debug: (scope, message, err) => write('debug', scope, message, err),
    info: (scope, message, err) => write('info', scope, message, err),
    warn: (scope, message, err) => write('warn', scope, message, err),
    error: (scope, message, err) => write('error', scope, message, err),
    /** Path of the current log file, for Settings → "Open log". */
    path() {
        init();
        return logPath;
    },
    /** Last `n` lines, for the About page's diagnostics box. */
    tail(n = 200) {
        init();
        try {
            const text = fs.readFileSync(logPath, 'utf-8');
            const lines = text.split('\n');
            return lines.slice(Math.max(0, lines.length - n)).join('\n');
        }
        catch {
            return '';
        }
    },
};

module.exports = log;
