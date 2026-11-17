'use strict';
/**
 * "Use graphics acceleration when available" — the same switch Chrome, Edge
 * and Firefox carry. Off hands page drawing to the CPU, which frees the GPU for
 * a game running alongside (at the cost of CPU time and heavier video/WebGL).
 *
 * The setting lives in features/persistence.js like any other (invariant 1),
 * but it has to be applied BEFORE app 'ready' — app.disableHardwareAcceleration()
 * is refused after that — and the settings file is encrypted with a key that
 * may not be readable yet. So the one bit is mirrored to a small plain file
 * next to it, which main.js reads synchronously at startup. A change takes
 * effect on the next launch, as it does in every browser.
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const log = require('./log');

const file = () => path.join(app.getPath('userData'), 'northstar', 'gpu.json');
let launchedWith = true;

function read() {
    try {
        return JSON.parse(fs.readFileSync(file(), 'utf-8')).hardwareAcceleration !== false;
    }
    catch (e) {
        if (e.code !== 'ENOENT')
            log.warn('gpu', 'could not read the graphics setting; keeping acceleration on', e);
        return true; // fail safe: the default
    }
}

/** main.js, before 'ready': turn acceleration off if the user asked. */
function applyAtStartup() {
    launchedWith = read();
    if (!launchedWith) {
        app.disableHardwareAcceleration();
        log.info('gpu', 'graphics acceleration is off (Settings › Performance)');
    }
}

/** Mirror the persisted value for the next launch. */
function save(on) {
    try {
        fs.mkdirSync(path.dirname(file()), { recursive: true });
        fs.writeFileSync(file(), JSON.stringify({ hardwareAcceleration: !!on }));
    }
    catch (e) { log.warn('gpu', 'could not save the graphics setting', e); }
}

/** Repair the mirror from the persisted setting (e.g. the file was deleted). */
function sync(on) {
    if (read() !== !!on)
        save(on);
}

module.exports = { applyAtStartup, save, sync, launchedWith: () => launchedWith };
