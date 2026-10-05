'use strict';
/**
 * Spell-check settings IPC (features/spellcheck.js). Changing them is a
 * trusted-surface action, like every other setting: a web page must not be
 * able to reconfigure the browser.
 */
const spellcheck = require('../features/spellcheck');
const log = require('../features/log');
const { isTrustedInternalSender } = require('../features/ipc-guard');

function register(ipcMain) {
    const trusted = (e, what) => {
        if (isTrustedInternalSender(e.sender))
            return true;
        log.warn('spellcheck', `blocked ${what} from an untrusted sender`);
        return false;
    };
    ipcMain.handle('spellcheck:state', (e) => trusted(e, 'state') ? spellcheck.state() : null);
    ipcMain.handle('spellcheck:set', (e, patch) => trusted(e, 'set') ? spellcheck.set(patch) : null);
    ipcMain.handle('spellcheck:words', (e) => trusted(e, 'words') ? spellcheck.words() : []);
    ipcMain.handle('spellcheck:add-word', (e, w) => trusted(e, 'add-word') ? spellcheck.addWord(w) : false);
    ipcMain.handle('spellcheck:remove-word', (e, w) => trusted(e, 'remove-word') ? spellcheck.removeWord(w) : false);
}

module.exports = { register };
