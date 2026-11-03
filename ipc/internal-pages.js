'use strict';
/**
 * "Am I one of the app's own pages?" — asked synchronously by preload/preload.js
 * on file:// pages before it exposes the internal bridges (bookmarks, history,
 * settings, tabs…). Being file:// is not enough: an HTML file the user opens
 * from disk is file:// too. The answer is the same rule every privileged
 * handler enforces (features/ipc-guard.js), applied to the asking frame.
 */
const { isTrustedInternalUrl } = require('../features/ipc-guard');

function register(ipcMain) {
    ipcMain.on('ipc-guard:is-internal', (e) => {
        let url = '';
        try { url = e.senderFrame?.url || e.sender.getURL(); }
        catch { url = ''; }
        e.returnValue = isTrustedInternalUrl(url);
    });
}

module.exports = { register };
