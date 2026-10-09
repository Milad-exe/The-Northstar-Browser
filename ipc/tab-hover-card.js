'use strict';
/**
 * Tab hover card IPC: the chrome asks for the card over a tab, or for it to
 * go. The card itself lives in features/tab-hover-card.js.
 */
const hoverCard = require('../features/tab-hover-card');

function register(ipcMain, { wm }) {
    ipcMain.on('hovercard:show', (e, data) => {
        const wd = wm.getWindowByWebContents(e.sender);
        if (wd)
            hoverCard.show(wd, data);
    });
    ipcMain.on('hovercard:hide', (e) => {
        hoverCard.hide(wm.getWindowByWebContents(e.sender));
    });
    // Keep the tab pictures a restored session will show (while windows exist).
    require('electron').app.on('before-quit', () => hoverCard.saveThumbs(wm));
}

module.exports = { register };
