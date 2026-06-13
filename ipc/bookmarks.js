/**
 * IPC handlers — bookmark CRUD, bar context menus, and the bookmark-prompt overlay.
 *
 * All mutating operations broadcast 'bookmarks-changed' to every open WebContents
 * so every view (bookmark bar, bookmarks page, history) stays in sync.
 */

const path = require('path');
const { WebContentsView, Menu } = require('electron');
const { broadcastBookmarksChanged } = require('./utils');
const { sanitizeUrl } = require('../Features/url-security');

// Bookmark-prompt popup dimensions
const PROMPT_W = 320;
const PROMPT_H = 260;

function register(ipcMain, { wm, webContents }) {

    const broadcast = () => broadcastBookmarksChanged(webContents);

    const getSenderTabIndex = (wd, senderWebContents) => {
        if (!wd?.tabs?.tabMap) return null;
        for (const [index, tab] of wd.tabs.tabMap.entries()) {
            if (tab?.webContents === senderWebContents) return index;
        }
        return null;
    };

    // ── Read ─────────────────────────────────────────────────────────────────

    ipcMain.handle('bookmarks-get', async () => {
        return wm.bookmarks.getAll();
    });

    ipcMain.handle('bookmarks-has', async (_e, url) => {
        return wm.bookmarks.has(url);
    });

    // ── Write ─────────────────────────────────────────────────────────────────

    ipcMain.handle('bookmarks-add', async (_e, url, title) => {
        const added = await wm.bookmarks.add(sanitizeUrl(url), title);
        broadcast();
        return added;
    });

    ipcMain.handle('bookmarks-remove', async (_e, url) => {
        const ok = await wm.bookmarks.remove(url);
        broadcast();
        return ok;
    });

    ipcMain.handle('bookmarks-remove-by-id', async (_e, id) => {
        const ok = await wm.bookmarks.removeById(id);
        broadcast();
        return ok;
    });

    ipcMain.handle('bookmarks-update-title', async (_e, url, title) => {
        await wm.bookmarks.updateTitle(url, title);
        broadcast();
        return true;
    });

    ipcMain.handle('bookmarks-update-by-id', async (_e, id, updates) => {
        const ok = await wm.bookmarks.updateById(id, updates);
        broadcast();
        return ok;
    });

    // ── Folders & structure ───────────────────────────────────────────────────

    ipcMain.handle('bookmarks-add-folder', async (_e, title) => {
        const id = await wm.bookmarks.addFolder(title);
        broadcast();
        return id;
    });

    ipcMain.handle('bookmarks-add-divider', async () => {
        const id = await wm.bookmarks.addDivider();
        broadcast();
        return id;
    });

    ipcMain.handle('bookmarks-reorder', async (_e, ids) => {
        await wm.bookmarks.reorder(ids);
        broadcast();
        return true;
    });

    ipcMain.handle('bookmarks-reorder-in-folder', async (_e, folderId, orderedIds) => {
        const ok = await wm.bookmarks.reorderInFolder(folderId, orderedIds);
        if (ok) broadcast();
        return ok;
    });

    ipcMain.handle('bookmarks-move-into-folder', async (_e, itemId, folderId, insertBeforeId) => {
        const ok = await wm.bookmarks.moveIntoFolder(itemId, folderId, insertBeforeId);
        if (ok) broadcast();
        return ok;
    });

    ipcMain.handle('bookmarks-move-out-of-folder', async (_e, itemId, folderId, insertBeforeId) => {
        const ok = await wm.bookmarks.moveOutOfFolder(itemId, folderId, insertBeforeId);
        if (ok) broadcast();
        return ok;
    });

    // ── Tab helpers ───────────────────────────────────────────────────────────

    ipcMain.handle('open-url-in-new-tab', (_e, url, switchToTab = false) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd) return false;
        const sourceTabIndex = getSenderTabIndex(wd, _e.sender);
        const shouldActivate = !!switchToTab;
        const idx = wd.tabs.createTab(sourceTabIndex, shouldActivate);
        wd.tabs.loadUrl(idx, sanitizeUrl(url));
        return true;
    });

    ipcMain.handle('open-bookmarks-tab', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd) wd.tabs.createTabWithPage('renderer/Bookmarks/index.html', 'bookmarks', 'Bookmarks');
    });

    // ── Bookmark-prompt overlay ───────────────────────────────────────────────

    ipcMain.handle('bookmark-prompt-open', async (_e, bounds, url, title, hasObj, id, mode) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd) return false;
        try {
            if (!wd.bookmarkPrompt) {
                wd.bookmarkPrompt = new WebContentsView({
                    webPreferences: {
                        preload: path.join(__dirname, '../preload/bookmark-prompt-preload.js'),
                        contextIsolation: true,
                        nodeIntegration: false,
                    },
                });
                wd.bookmarkPrompt.setBackgroundColor('#00000000');
                wd.window.contentView.addChildView(wd.bookmarkPrompt);
            }

            const x = Math.max(0, Math.floor(bounds.right) - PROMPT_W);
            const y = Math.max(0, Math.floor(bounds.bottom) + 8);
            wd.bookmarkPrompt.setBounds({ x, y, width: PROMPT_W, height: PROMPT_H });
            wd.bookmarkPrompt.webContents.loadFile('renderer/BookmarkPrompt/index.html');
            await new Promise(res => wd.bookmarkPrompt.webContents.once('did-finish-load', res));
            wd.bookmarkPrompt.webContents.focus();
            wd.bookmarkPrompt.webContents.send('init-prompt', { url, title, hasObj, id, mode });
            return true;
        } catch (err) {
            console.error('bookmark-prompt-open:', err);
            return false;
        }
    });

    ipcMain.handle('bookmark-prompt-close', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd || !wd.bookmarkPrompt) return false;
        try {
            wd.window.contentView.removeChildView(wd.bookmarkPrompt);
            wd.bookmarkPrompt = null;
            wd.window.webContents.focus();
            wd.window.webContents.send('bookmark-prompt-closed');
            return true;
        } catch (err) {
            console.error('bookmark-prompt-close:', err);
            return false;
        }
    });

    // ── Bar context menu ──────────────────────────────────────────────────────

    ipcMain.on('show-bookmark-bar-context-menu', (_e, item) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd) showBookmarkBarContextMenu(wd, item, wm, webContents);
    });

    // Simple single-bookmark context menu (used from the bookmarks page)
    ipcMain.on('show-bookmark-context-menu', (_e, url) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd) return;
        const sourceTabIndex = getSenderTabIndex(wd, _e.sender);
        Menu.buildFromTemplate([
            { label: 'Open in New Tab',       click: () => { const i = wd.tabs.createTab(sourceTabIndex, false); wd.tabs.loadUrl(i, url); } },
            { label: 'Open in Background Tab', click: () => { const i = wd.tabs.createTab(sourceTabIndex, false); wd.tabs.loadUrl(i, url); } },
            { type: 'separator' },
            { label: 'Copy URL', click: () => { require('electron').clipboard.writeText(url); } },
            { type: 'separator' },
            { label: 'Remove Bookmark', click: async () => { await wm.bookmarks.remove(url); broadcast(); } },
        ]).popup({ window: wd.window });
    });
}

// ── showBookmarkBarContextMenu ────────────────────────────────────────────────

function showBookmarkBarContextMenu(wd, item, wm, webContents) {
    const { type, id, url, title, bookmarkBarVisible: barVisible } = item || {};
    const broadcast = () => broadcastBookmarksChanged(webContents);

    const addItems = [
        { type: 'separator' },
        { label: 'Add Bookmark', click: () => wd.window.webContents.send('bookmark-add-from-bar') },
        { label: 'Add Folder',   click: () => wd.window.webContents.send('bookmark-new-folder-prompt') },
        { label: 'Add Divider',  click: async () => { await wm.bookmarks.addDivider(); broadcast(); } },
    ];

    let template = [];

    if (type === 'bookmark') {
        template = [
            { label: 'Open',               click: () => wd.tabs.loadUrl(wd.tabs.activeTabIndex, url) },
            { label: 'Open in New Tab',    click: () => { const i = wd.tabs.createTab(null, false); wd.tabs.loadUrl(i, url); } },
            { label: 'Open in Background', click: () => { const i = wd.tabs.createTab(null, false); wd.tabs.loadUrl(i, url); } },
            { type: 'separator' },
            { label: 'Edit',   click: () => wd.window.webContents.send('bookmark-edit-prompt', { id, url, title }) },
            { label: 'Delete', click: async () => { await wm.bookmarks.removeById(id); broadcast(); } },
            ...addItems,
        ];
    } else if (type === 'folder') {
        template = [
            { label: 'Open All in New Tabs', click: async () => {
                const all    = await wm.bookmarks.getAll();
                const folder = all.find(b => b.id === id);
                if (folder?.children) {
                    folder.children.filter(c => c.type === 'bookmark').forEach(c => {
                        const i = wd.tabs.createTab(null, false); wd.tabs.loadUrl(i, c.url);
                    });
                }
            }},
            { type: 'separator' },
            { label: 'Rename', click: () => wd.window.webContents.send('bookmark-folder-rename', { id, title }) },
            { label: 'Delete', click: async () => { await wm.bookmarks.removeById(id); broadcast(); } },
            ...addItems,
        ];
    } else if (type === 'divider') {
        template = [
            { label: 'Delete Divider', click: async () => { await wm.bookmarks.removeById(id); broadcast(); } },
        ];
    } else {
        // bar background
        template = [
            { label: 'Add Bookmark', click: () => wd.window.webContents.send('bookmark-add-from-bar') },
            { label: 'Add Folder',   click: () => wd.window.webContents.send('bookmark-new-folder-prompt') },
            { label: 'Add Divider',  click: async () => { await wm.bookmarks.addDivider(); broadcast(); } },
            { type: 'separator' },
            { label: 'Show Bookmark Bar', type: 'checkbox', checked: !!barVisible,
              click: () => wd.window.webContents.send('toggle-bookmark-bar') },
        ];
    }

    Menu.buildFromTemplate(template).popup({ window: wd.window });
}

module.exports = { register };
