/**
 * IPC — mini media player panel actions (play/pause, mute, go-to-tab, hide).
 * The panel itself is managed by Features/mini-player.js.
 */
const miniPlayer = require('../features/mini-player');
function register(ipcMain, { wm }) {
    ipcMain.handle('mp-action', (e, act, value) => {
        miniPlayer.action(wm.getWindowByWebContents(e.sender), String(act || ''), value);
        return true;
    });
}

module.exports = { register };