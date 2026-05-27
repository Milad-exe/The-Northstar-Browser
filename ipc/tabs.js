/**
 * IPC handlers — tab management and window drag/drop.
 *
 * Covers: create, remove, switch, load, navigate, pin, reorder,
 *         move tab to another window, detach to new window,
 *         and session persistence mode.
 */

function register(ipcMain, { wm, BrowserWindow }) {

    // ── Basic tab operations ──────────────────────────────────────────────────

    ipcMain.handle('addTab', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd) wd.tabs.createTab();
    });

    // Open a URL in a new background tab without loading it until the user switches to it
    ipcMain.handle('addTabLazy', (_e, url) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd) return;
        let title = url;
        try { title = new URL(url).hostname; } catch {}
        wd.tabs.createLazyTab(url, title, false);
    });

    ipcMain.handle('removeTab', (_e, index) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd) wd.tabs.removeTab(index);
    });

    ipcMain.handle('switchTab', (_e, index) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd) wd.tabs.showTab(index);
    });

    ipcMain.handle('loadUrl', (_e, index, url) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd) wd.tabs.loadUrl(index, url);
    });

    ipcMain.handle('goBack', (_e, index) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd) wd.tabs.goBack(index);
    });

    ipcMain.handle('goForward', (_e, index) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd) wd.tabs.goForward(index);
    });

    ipcMain.handle('reload', (_e, index) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd) wd.tabs.reload(index);
    });

    ipcMain.handle('newWindow', () => {
        wm.createWindow();
    });

    ipcMain.handle('addPrivateTab', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd?.tabs) wd.tabs.createTab(null, true, true);
    });

    ipcMain.handle('newPrivateWindow', (_e) => {
        wm.createWindow(800, 600, { private: true });
    });

    ipcMain.handle('isPrivateWindow', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        return wd?.tabs?.isPrivateWindow ?? false;
    });

    ipcMain.handle('getTabUrl', (_e, index) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        return wd ? (wd.tabs.tabUrls.get(index) || '') : '';
    });

    ipcMain.handle('pinTab', (_e, index) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd && wd.tabs) { wd.tabs.pinTab(index); return true; }
        return false;
    });

    ipcMain.handle('reorderTabs', (_e, order) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd && wd.tabs) { wd.tabs.reorderTabs(order); return true; }
        return false;
    });

    // ── Navigation helpers (used by history / bookmarks pages) ───────────────

    ipcMain.handle('navigate-active-tab', (_e, url) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd) return false;
        wd.tabs.loadUrl(wd.tabs.activeTabIndex, url);
        return true;
    });

    ipcMain.handle('active-tab-go-back', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd) return false;
        wd.tabs.goBack(wd.tabs.activeTabIndex);
        return true;
    });

    // ── Persistence mode ─────────────────────────────────────────────────────

    ipcMain.handle('getPersistMode', () => {
        return wm.persistence.getPersistMode();
    });

    ipcMain.handle('setPersistMode', (_e, enabled) => {
        wm.persistence.setPersistMode(!!enabled);
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd && wd.tabs) { try { wd.tabs.saveStateDebounced(); } catch {} }
        return true;
    });

    // ── Tab drag / drop across windows ───────────────────────────────────────

    ipcMain.handle('get-this-window-id', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        return wd ? wd.id : null;
    });

    ipcMain.handle('get-window-at-point', (_e, screenX, screenY) => {
        const matches = wm.getAllWindows().filter(w => {
            const b = w.window.getBounds();
            return screenX >= b.x && screenX <= b.x + b.width &&
                   screenY >= b.y && screenY <= b.y + b.height;
        });
        if (!matches.length) return null;
        if (matches.length === 1) return { id: matches[0].id };

        // Multiple overlapping windows — return the top-most visible one
        for (let i = BrowserWindow.getAllWindows().length - 1; i >= 0; i--) {
            const bw    = BrowserWindow.getAllWindows()[i];
            const match = matches.find(w => w.window === bw);
            if (match && bw.isVisible() && !bw.isMinimized()) return { id: match.id };
        }
        return { id: matches[0].id };
    });

    ipcMain.handle('move-tab-to-window', async (_e, fromId, tabIndex, targetId, url) => {
        const src = wm.getWindowById(fromId);
        const dst = wm.getWindowById(targetId);
        if (!src || !dst) return false;
        try {
            if (!url || url === 'newtab') {
                dst.tabs.createTab();
            } else {
                const idx = dst.tabs.createTab();
                dst.tabs.loadUrl(idx, url);
            }
            src.tabs.removeTab(tabIndex);
            return true;
        } catch (err) {
            console.error('move-tab-to-window:', err);
            return false;
        }
    });

    ipcMain.handle('detach-to-new-window', async (_e, tabIndex, screenX, screenY, url) => {
        const src = wm.getWindowByWebContents(_e.sender);
        if (!src) return false;
        try {
            const newWin = wm.createWindow(800, 600);
            newWin.window.setBounds({
                x: Math.max(0, Math.floor(screenX - 400)),
                y: Math.max(0, Math.floor(screenY - 300)),
                width: 800, height: 600,
            });
            if (url && url !== 'newtab') {
                newWin.window.webContents.once('did-finish-load', () => {
                    const firstIdx = Array.from(newWin.tabs.tabMap.keys())[0];
                    if (firstIdx !== undefined) newWin.tabs.loadUrl(firstIdx, url);
                });
            }
            src.tabs.removeTab(tabIndex);
            return true;
        } catch (err) {
            console.error('detach-to-new-window:', err);
            return false;
        }
    });
}

module.exports = { register };
