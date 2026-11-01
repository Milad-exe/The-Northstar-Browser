const { WebContentsView, ipcMain } = require('electron');
const { resolveAppFile } = require('../app-paths');
const { CARD_TOP, SHELL_PAD, W_MD } = require('./overlay-bounds');
const FIND_W = W_MD;
const FIND_H = 64; // one row: renderer/FindDialog/styles.css .find-bar + its padding
const path = require('path');
const log = require('./log');
class FindDialogManager {
    dialogs; // parentWindow webContents id → dialog
    static instance;
    constructor() {
        this.dialogs = new Map();
        this.setupGlobalIPC();
    }
    static getInstance() {
        if (!FindDialogManager.instance) {
            FindDialogManager.instance = new FindDialogManager();
        }
        return FindDialogManager.instance;
    }
    createDialog(parentWindow) {
        const windowId = parentWindow.webContents.id;
        if (!this.dialogs.has(windowId)) {
            this.dialogs.set(windowId, new FindDialog(parentWindow, this));
        }
        return this.dialogs.get(windowId);
    }
    removeDialog(windowId) {
        this.dialogs.delete(windowId);
    }
    setupGlobalIPC() {
        ipcMain.handle('find-search', (event, searchTerm) => {
            const dialog = this.getDialogForEvent(event);
            if (dialog) {
                dialog.handleSearch(searchTerm);
            }
        });
        ipcMain.handle('find-next', (event) => {
            const dialog = this.getDialogForEvent(event);
            if (dialog) {
                dialog.handleNext();
            }
        });
        ipcMain.handle('find-previous', (event) => {
            const dialog = this.getDialogForEvent(event);
            if (dialog) {
                dialog.handlePrevious();
            }
        });
        ipcMain.handle('find-clear', (event) => {
            const dialog = this.getDialogForEvent(event);
            if (dialog) {
                dialog.handleClear();
            }
        });
        ipcMain.handle('find-close', (event) => {
            const dialog = this.getDialogForEvent(event);
            if (dialog) {
                dialog.close();
            }
        });
    }
    getDialogForEvent(event) {
        for (const [windowId, dialog] of this.dialogs) {
            if (dialog.view && dialog.view.webContents === event.sender) {
                return dialog;
            }
        }
        return null;
    }
}
class FindDialog {
    manager;
    parentWindow; // BrowserWindow the bar sits in
    parentWindowId; // that window's webContents id
    view; // the bar's WebContentsView, inside parentWindow (overlay-registry.js)
    activeTab; // TabView the search runs in
    currentSearchTerm;
    isDestroyed;
    constructor(parentWindow, manager) {
        this.parentWindow = parentWindow;
        this.manager = manager;
        this.view = null;
        this.activeTab = null;
        this.currentSearchTerm = '';
        this.parentWindowId = parentWindow.webContents.id;
        this.isDestroyed = false;
        this.parentWindow.on('closed', () => {
            this.isDestroyed = true;
            this.cleanup();
            this.manager.removeDialog(this.parentWindowId);
        });
    }
    cleanup() {
        this.close(false);
        this.activeTab = null;
        this.parentWindow = null;
    }
    /* Where the bar goes: the top-right corner of the page it searches. It is
       a view INSIDE the window, not a window of its own — it used to be a
       frameless always-on-top BrowserWindow, which floated over every other
       app, stayed put when the browser moved or minimised, and outlived the
       tab it was opened for. */
    bounds() {
        let area = null;
        try {
            const r = this.activeTab?.getBounds?.();
            if (r && r.width > 0 && r.x >= 0)
                area = r;
        }
        catch (e) { log.debug('find', 'bounds', e); }
        if (!area) {
            const b = this.parentWindow.getContentBounds();
            area = { x: SHELL_PAD, y: CARD_TOP, width: b.width - 2 * SHELL_PAD, height: b.height - CARD_TOP - SHELL_PAD };
        }
        const width = Math.min(FIND_W, Math.max(200, area.width));
        return { x: Math.round(area.x + area.width - width), y: Math.round(area.y), width, height: FIND_H };
    }
    layout() {
        if (!this.view || !this.parentWindow || this.parentWindow.isDestroyed())
            return;
        try { this.view.setBounds(this.bounds()); }
        catch (e) { log.debug('find', 'layout', e); }
    }
    show(activeTab) {
        if (this.isDestroyed || !this.parentWindow || this.parentWindow.isDestroyed())
            return;
        // Opened for a different tab: that tab's search is over.
        if (this.view && this.activeTab !== activeTab)
            this.close();
        this.activeTab = activeTab;
        if (this.view) {
            this.layout();
            this.view.webContents.focus();
            return;
        }
        const view = new WebContentsView({
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, '../preload/find-preload.js')
            }
        });
        view.setBackgroundColor('#00000000');
        this.view = view;
        this.parentWindow.contentView.addChildView(view);
        this.layout();
        view.webContents.loadFile(resolveAppFile('renderer/FindDialog/index.html'));
        view.webContents.once('did-finish-load', () => {
            if (this.view === view)
                view.webContents.focus();
        });
        view.webContents.on('before-input-event', (event, input) => {
            if (input.key === 'Escape' && input.type === 'keyDown') {
                this.close();
                event.preventDefault();
            }
        });
    }
    /** `refocus`: hand typing back to the searched page (not when the page is
        going away or another tab is taking over). */
    close(refocus = true) {
        const view = this.view;
        if (!view)
            return;
        this.view = null;
        this.currentSearchTerm = '';
        if (this.activeTab && !this.activeTab.webContents.isDestroyed())
            this.activeTab.webContents.stopFindInPage('clearSelection');
        const win = this.parentWindow;
        try {
            if (win && !win.isDestroyed()) {
                win.contentView.removeChildView(view);
                // Typing goes back to the page that was being searched.
                if (refocus && this.activeTab && !this.activeTab.webContents.isDestroyed())
                    this.activeTab.webContents.focus();
            }
        }
        catch (e) { log.debug('find', 'close', e); }
        try { if (!view.webContents.isDestroyed()) view.webContents.close(); }
        catch (e) { log.debug('find', 'close', e); }
    }
    handleSearch(searchTerm) {
        if (this.isDestroyed)
            return;
        this.currentSearchTerm = searchTerm;
        if (this.activeTab && searchTerm && !this.activeTab.webContents.isDestroyed()) {
            // Electron's findNext means 'begin a NEW find session' — true for the first
            // request of a term, false for the follow-ups. It was the other way
            // round, so typing never started a session and the match count only
            // appeared after Enter.
            this.activeTab.webContents.findInPage(searchTerm, { findNext: true });
        }
    }
    handleNext() {
        if (this.isDestroyed)
            return;
        if (this.activeTab && this.currentSearchTerm && !this.activeTab.webContents.isDestroyed()) {
            this.activeTab.webContents.findInPage(this.currentSearchTerm, { findNext: false, forward: true });
        }
    }
    handlePrevious() {
        if (this.isDestroyed)
            return;
        if (this.activeTab && this.currentSearchTerm && !this.activeTab.webContents.isDestroyed()) {
            this.activeTab.webContents.findInPage(this.currentSearchTerm, { findNext: false, forward: false });
        }
    }
    handleClear() {
        if (this.isDestroyed)
            return;
        if (this.activeTab && !this.activeTab.webContents.isDestroyed()) {
            this.activeTab.webContents.stopFindInPage('clearSelection');
        }
    }
    handleFindResult(result) {
        if (this.isDestroyed)
            return;
        if (this.view && !this.view.webContents.isDestroyed()) {
            this.view.webContents.send('find-matches-updated', result.activeMatchOrdinal, result.matches);
        }
    }
}

module.exports = FindDialogManager;