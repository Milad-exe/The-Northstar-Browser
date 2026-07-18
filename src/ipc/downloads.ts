/**
 * IPC handlers — download manager panel + item actions.
 *
 * The panel is a WebContentsView overlay anchored under the downloads toolbar
 * button (same pattern as the suggestions overlay: created once per window,
 * then shown/hidden). Item updates are pushed both to the chrome renderer
 * (toolbar button state) and to the open panel (list rows).
 */

import path from 'path';
import { resolveAppFile } from '../app-paths';
import { WebContentsView } from 'electron';
import downloadManager from '../features/download-manager';
const PANEL_WIDTH  = 340;
const HEADER_H     = 40;
const ITEM_H       = 58;
const MAX_PANEL_H  = 420;

function panelBounds(anchor, count) {
    const height = Math.min(MAX_PANEL_H, HEADER_H + Math.max(1, count) * ITEM_H);
    return {
        x:      Math.max(0, Math.floor(anchor.right - PANEL_WIDTH)),
        y:      Math.floor(anchor.bottom + 6),
        width:  PANEL_WIDTH,
        height,
    };
}

async function ensurePanel(wd) {
    if (wd.downloadsPanel) {
        if (wd.downloadsPanelReady) await wd.downloadsPanelReady;
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
    view.setVisible(false);
    wd.downloadsPanel = view;
    wd.window.contentView.addChildView(view);
    view.webContents.loadFile(resolveAppFile('renderer/Downloads/index.html'));
    wd.downloadsPanelReady = new Promise<void>(res => view.webContents.once('did-finish-load', () => res()));
    await wd.downloadsPanelReady;
    return view;
}

function hidePanel(wd) {
    if (!wd?.downloadsPanel) return false;
    try {
        wd.downloadsPanel.setVisible(false);
        wd.downloadsPanelOpen = false;
        try { wd.window.webContents.send('downloads-panel-closed'); } catch {}
        return true;
    } catch { return false; }
}

function register(ipcMain, { wm }) {

    // Push every item change to all windows: chrome button + open panels.
    downloadManager.onChanged((record) => {
        for (const wd of wm.getAllWindows()) {
            try { wd.window.webContents.send('downloads-changed', record); } catch {}
            if (wd.downloadsPanel) {
                try { wd.downloadsPanel.webContents.send('downloads-data', downloadManager.getAll()); } catch {}
            }
        }
    });

    ipcMain.handle('downloads-get', () => downloadManager.getAll());

    ipcMain.handle('downloads-action', (_e, action, id) => {
        switch (action) {
            case 'cancel':         downloadManager.cancel(id);       break;
            case 'pause':          downloadManager.pause(id);        break;
            case 'resume':         downloadManager.resume(id);       break;
            case 'open-file':      downloadManager.openFile(id);     break;
            case 'show-in-folder': downloadManager.showInFolder(id); break;
            case 'remove':         downloadManager.remove(id);       break;
            case 'clear-finished': downloadManager.clearFinished();  break;
        }
        return true;
    });

    // Toggle the panel under the toolbar button. Returns the new open state.
    ipcMain.handle('downloads-panel-toggle', async (_e, anchor) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd) return false;

        if (wd.downloadsPanelOpen) { hidePanel(wd); return false; }

        try {
            const view  = await ensurePanel(wd);
            const items = downloadManager.getAll();
            view.setBounds(panelBounds(anchor, items.length));
            view.webContents.send('downloads-data', items);
            view.setVisible(true);
            wd.downloadsPanelOpen = true;
            return true;
        } catch (err) {
            console.error('downloads-panel-toggle:', err);
            return false;
        }
    });

    ipcMain.handle('downloads-panel-close', (_e) => {
        // Called from the chrome renderer OR from inside the panel itself.
        let wd = wm.getWindowByWebContents(_e.sender);
        if (!wd) {
            for (const w of wm.getAllWindows()) {
                if (w.downloadsPanel?.webContents === _e.sender) { wd = w; break; }
            }
        }
        return hidePanel(wd);
    });
}

export { register };