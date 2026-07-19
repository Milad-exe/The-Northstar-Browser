/**
 * IPC handlers — extension management (Settings page).
 *
 * Browser-action buttons/popups are handled by the <browser-action-list>
 * element (electron-chrome-extensions), not here.
 */
const path = require('path');
const { dialog, WebContentsView } = require('electron');
const { resolveAppFile } = require('../app-paths');
const extensions = require('../features/extensions');
const WEB_STORE_URL = 'https://chromewebstore.google.com/';
// ── Toolbar panel (puzzle icon) — same overlay pattern as the downloads panel ──
const PANEL_WIDTH = 320;
const HEADER_H = 38;
const FOOTER_H = 40;
const ITEM_H = 46;
const MAX_PANEL_H = 430;
function panelBounds(anchor, count) {
    const height = Math.min(MAX_PANEL_H, HEADER_H + FOOTER_H + Math.max(1, count) * ITEM_H + 2);
    return {
        x: Math.max(0, Math.floor(anchor.right - PANEL_WIDTH)),
        y: Math.floor(anchor.bottom + 6),
        width: PANEL_WIDTH,
        height,
    };
}
async function ensurePanel(wd) {
    if (wd.extensionsPanel) {
        if (wd.extensionsPanelReady)
            await wd.extensionsPanelReady;
        return wd.extensionsPanel;
    }
    const view = new WebContentsView({
        webPreferences: {
            preload: path.join(__dirname, '../preload/extensions-panel-preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    view.setBackgroundColor('#00000000');
    view.setVisible(false);
    wd.extensionsPanel = view;
    wd.window.contentView.addChildView(view);
    view.webContents.loadFile(resolveAppFile('renderer/ExtensionsPanel/index.html'));
    wd.extensionsPanelReady = new Promise(res => view.webContents.once('did-finish-load', () => res()));
    await wd.extensionsPanelReady;
    return view;
}
function hidePanel(wd) {
    if (!wd?.extensionsPanel)
        return false;
    try {
        wd.extensionsPanel.setVisible(false);
        wd.extensionsPanelOpen = false;
        try {
            wd.window.webContents.send('extensions-panel-closed');
        }
        catch { }
        return true;
    }
    catch {
        return false;
    }
}
function register(ipcMain, { wm }) {
    extensions.onChanged(() => {
        for (const wd of wm.getAllWindows()) {
            try {
                wd.window.webContents.send('extensions-changed');
            }
            catch { }
            if (wd.extensionsPanel) {
                try {
                    wd.extensionsPanel.webContents.send('extensions-data', listWithPinned());
                }
                catch { }
            }
        }
    });
    ipcMain.handle('extensions-list', () => listWithPinned());
    ipcMain.handle('extensions-remove', (_e, id) => extensions.remove(id));
    ipcMain.handle('extensions-set-enabled', (_e, id, enabled) => extensions.setEnabled(id, enabled));
    ipcMain.handle('extensions-open-options', (_e, id) => extensions.openOptions(id));
    // Install by Chrome Web Store ID or URL.
    ipcMain.handle('extensions-install-id', async (_e, idOrUrl) => {
        try {
            const info = await extensions.installById(idOrUrl);
            return { ok: true, ...info };
        }
        catch (err) {
            return { ok: false, error: err.message };
        }
    });
    // mode: 'unpacked' (folder) | 'crx' (file)
    ipcMain.handle('extensions-add', async (_e, mode) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        const parent = wd?.window;
        const opts = mode === 'crx'
            ? { title: 'Select extension (.crx)', properties: ['openFile'], filters: [{ name: 'Chrome Extension', extensions: ['crx', 'zip'] }] }
            : { title: 'Select unpacked extension folder', properties: ['openDirectory'] };
        try {
            const res = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
            if (res.canceled || !res.filePaths?.length)
                return { canceled: true };
            const info = mode === 'crx'
                ? await extensions.installCrx(res.filePaths[0])
                : await extensions.installUnpacked(res.filePaths[0]);
            return { ok: true, ...info };
        }
        catch (err) {
            return { ok: false, error: err.message };
        }
    });
    // Open the Chrome Web Store and bring it into focus. If a store tab is
    // already open in the window, switch to it instead of opening another.
    ipcMain.handle('extensions-open-store', (_e) => {
        let wd = wm.getWindowByWebContents(_e.sender);
        if (!wd) {
            for (const w of wm.getAllWindows()) {
                if (w.extensionsPanel?.webContents === _e.sender) {
                    wd = w;
                    break;
                }
            }
        }
        if (!wd?.tabs)
            return false;
        for (const [idx, url] of wd.tabs.tabUrls) {
            if (typeof url === 'string' && url.includes('chromewebstore.google.com')) {
                try {
                    wd.tabs.showTab(idx);
                    wd.window.focus();
                }
                catch { }
                return true;
            }
        }
        const idx = wd.tabs.createLazyTab(WEB_STORE_URL, 'Chrome Web Store', false, false, true, true);
        try {
            wd.tabs.showTab(idx);
            wd.window.focus();
        }
        catch { }
        return true;
    });
    // Chrome clicks / page clicks dismiss an open action popup (Firefox behavior).
    ipcMain.handle('extensions-close-action-popup', () => {
        extensions.closePopups();
        return true;
    });
    // Firefox-style pinning: missing key = pinned (extensions land in the
    // toolbar on install; unpinning moves them into the puzzle panel only).
    const pinnedMap = () => wm.persistence.get('extPinned') || {};
    const listWithPinned = () => {
        const pinned = pinnedMap();
        return extensions.list().map(row => ({ ...row, pinned: pinned[row.id] !== false }));
    };
    ipcMain.handle('extensions-set-pinned', (_e, id, pinned) => {
        const map = { ...pinnedMap(), [id]: !!pinned };
        wm.persistence.set('extPinned', map);
        for (const wd of wm.getAllWindows()) {
            try {
                wd.window.webContents.send('ext-pinned-changed', map);
            }
            catch { }
            if (wd.extensionsPanel) {
                try {
                    wd.extensionsPanel.webContents.send('extensions-data', listWithPinned());
                }
                catch { }
            }
        }
        return true;
    });
    // Panel row click — activate the extension's action in the chrome page
    // (opens its popup / fires its onClicked), exactly like Firefox's panel.
    ipcMain.handle('extensions-activate', (_e, id) => {
        let wd = wm.getWindowByWebContents(_e.sender);
        if (!wd) {
            for (const w of wm.getAllWindows()) {
                if (w.extensionsPanel?.webContents === _e.sender) {
                    wd = w;
                    break;
                }
            }
        }
        if (!wd)
            return false;
        hidePanel(wd);
        try {
            wd.window.webContents.send('ext-activate-action', id);
        }
        catch { }
        return true;
    });
    // Toggle the panel under the puzzle toolbar button. Returns the new state.
    ipcMain.handle('extensions-panel-toggle', async (_e, anchor) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd)
            return false;
        if (wd.extensionsPanelOpen) {
            hidePanel(wd);
            return false;
        }
        extensions.closePopups(); // opening the panel dismisses any action popup
        try {
            const view = await ensurePanel(wd);
            const items = listWithPinned();
            view.setBounds(panelBounds(anchor, items.length));
            // Re-add on every open: newly created tab views would otherwise
            // sit above the panel in the contentView child order.
            try {
                wd.window.contentView.removeChildView(view);
            }
            catch { }
            try {
                wd.window.contentView.addChildView(view);
            }
            catch { }
            view.webContents.send('extensions-data', items);
            view.setVisible(true);
            wd.extensionsPanelOpen = true;
            return true;
        }
        catch (err) {
            console.error('extensions-panel-toggle:', err);
            return false;
        }
    });
    ipcMain.handle('extensions-panel-close', (_e) => {
        // Called from the chrome renderer OR from inside the panel itself.
        let wd = wm.getWindowByWebContents(_e.sender);
        if (!wd) {
            for (const w of wm.getAllWindows()) {
                if (w.extensionsPanel?.webContents === _e.sender) {
                    wd = w;
                    break;
                }
            }
        }
        return hidePanel(wd);
    });
}

module.exports = { register };