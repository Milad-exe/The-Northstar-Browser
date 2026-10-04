/**
 * IPC handlers — download manager panel + item actions.
 *
 * The panel is a WebContentsView overlay anchored under the downloads toolbar
 * button (same pattern as the suggestions overlay: created once per window,
 * then shown/hidden). Item updates are pushed both to the chrome renderer
 * (toolbar button state) and to the open panel (list rows).
 */
const log = require('../features/log');
const path = require('path');
const { resolveAppFile } = require('../app-paths');
const { WebContentsView, shell, app } = require('electron');
const downloadManager = require('../features/download-manager');
const { signalEnter, playOutThenHide } = require('../features/overlay-anim');
const { panelBounds, PANEL_RADIUS, W_MD } = require('../features/overlay-bounds');
const PANEL_WIDTH = W_MD;
// Mirrors renderer/Downloads/styles.css + the shared panel anatomy: a
// --bar-h head, a --row-h foot over its divider, and rows that are two lines
// tall. The empty state needs more than one row's worth of room to read as a
// sentence rather than as a clipped label.
const HEAD_H = 48;   // --bar-h
const FOOT_H = 41;   // --row-h + its divider
const ITEM_H = 58;   // two lines at the new type scale
const EMPTY_H = 108;
const MAX_PANEL_H = 500;
function boundsFor(win, anchor, count) {
    const body = count > 0 ? count * ITEM_H + 8 : EMPTY_H;
    return panelBounds(win, {
        anchor,
        width: PANEL_WIDTH,
        height: Math.min(MAX_PANEL_H, HEAD_H + FOOT_H + body),
    });
}
async function ensurePanel(wd) {
    if (wd.downloadsPanel) {
        if (wd.downloadsPanelReady)
            await wd.downloadsPanelReady;
        return wd.downloadsPanel;
    }
    const view = new WebContentsView({
        webPreferences: {
            preload: path.join(__dirname, '../preload/downloads-preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    view.setBackgroundColor('#00000000');
    try { view.setBorderRadius(PANEL_RADIUS) } catch (e) { log.debug('downloads', 'if', e); }
    view.setVisible(false);
    wd.downloadsPanel = view;
    wd.window.contentView.addChildView(view);
    view.webContents.loadFile(resolveAppFile('renderer/Downloads/index.html'));
    wd.downloadsPanelReady = new Promise(res => view.webContents.once('did-finish-load', () => res()));
    await wd.downloadsPanelReady;
    return view;
}
function hidePanel(wd) {
    if (!wd?.downloadsPanel)
        return false;
    // Play the close fade inside the page, then hide the view (P1-6). The flag
    // flips now so a re-click reopens cleanly; the chrome is told once hidden.
    wd.downloadsPanelOpen = false;
    playOutThenHide(wd.downloadsPanel, () => {
        try { wd.window.webContents.send('downloads-panel-closed'); }
        catch (e) { log.debug('downloads', 'hidePanel', e); }
    });
    return true;
}
function register(ipcMain, { wm }) {
    // Push every item change to all windows: chrome button + open panels.
    downloadManager.onChanged((record) => {
        for (const wd of wm.getAllWindows()) {
            try {
                wd.window.webContents.send('downloads-changed', record);
            }
            catch (e) { log.debug('downloads', 'register', e); }
            if (wd.downloadsPanel) {
                try {
                    wd.downloadsPanel.webContents.send('downloads-data', downloadManager.getAll());
                }
                catch (e) { log.debug('downloads', 'register', e); }
            }
        }
    });
    // P1-4: the chrome asks once whether a screen reader is active, so the
    // partial panel never auto-closes under one. sendSync keeps the chrome's
    // decision synchronous at startup.
    ipcMain.on('downloads-a11y', (e) => {
        try { e.returnValue = app.isAccessibilitySupportEnabled(); }
        catch { e.returnValue = false; }
    });
    // The panel view reports its own hover; forward it to that window's chrome so
    // the auto-close countdown pauses while the pointer is over the panel.
    ipcMain.on('downloads-panel-hover-report', (e, hovered) => {
        for (const wd of wm.getAllWindows()) {
            if (wd.downloadsPanel?.webContents === e.sender) {
                try { wd.window.webContents.send('downloads-panel-hover', !!hovered); }
                catch (err) { log.debug('downloads', 'panel-hover', err); }
                break;
            }
        }
    });
    ipcMain.handle('downloads-get', () => downloadManager.getAll());
    ipcMain.handle('downloads-action', (_e, action, id, confirmed) => {
        switch (action) {
            case 'cancel':
                downloadManager.cancel(id);
                break;
            case 'pause':
                downloadManager.pause(id);
                break;
            case 'resume':
                downloadManager.resume(id);
                break;
            case 'open-file':
                // confirmed (P1-5): the panel sends true only on a dangerous
                // file's deliberate second click.
                downloadManager.openFile(id, confirmed === true);
                break;
            case 'show-in-folder':
                downloadManager.showInFolder(id);
                break;
            case 'remove':
                downloadManager.remove(id);
                break;
            case 'clear-finished':
                downloadManager.clearFinished();
                break;
            case 'show-all':
                // No downloads library page exists — reveal the folder instead.
                try { shell.openPath(app.getPath('downloads')); }
                catch (e) { log.debug('downloads', 'downloads-action', e); }
                break;
        }
        return true;
    });
    // Toggle the panel under the toolbar button. Returns the new open state.
    ipcMain.handle('downloads-panel-toggle', async (_e, anchor) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd)
            return false;
        if (wd.downloadsPanelOpen) {
            hidePanel(wd);
            return false;
        }
        try {
            const view = await ensurePanel(wd);
            const items = downloadManager.getAll();
            view.setBounds(boundsFor(wd.window, anchor, items.length));
            view.webContents.send('downloads-data', items);
            view.setVisible(true);
            wd.downloadsPanelOpen = true;
            signalEnter(view); // P1-6 fade-in
            return true;
        }
        catch (err) {
            console.error('downloads-panel-toggle:', err);
            return false;
        }
    });
    ipcMain.handle('downloads-panel-close', (_e) => {
        // Called from the chrome renderer OR from inside the panel itself.
        let wd = wm.getWindowByWebContents(_e.sender);
        if (!wd) {
            for (const w of wm.getAllWindows()) {
                if (w.downloadsPanel?.webContents === _e.sender) {
                    wd = w;
                    break;
                }
            }
        }
        return hidePanel(wd);
    });
}

module.exports = { register };