/**
 * IPC handlers — folder-dropdown WebContentsView and extern bookmark drag.
 *
 * The folder dropdown is a transparent cascading panel that appears when the
 * user clicks a folder in the bookmark bar. Because HTML5 drag events don't
 * cross WebContentsView boundaries, dragging an item out of the dropdown uses
 * a cursor-polling loop to forward position events to the bar renderer.
 */

import path from 'path';
import { resolveAppFile } from '../app-paths';
import { WebContentsView, Menu } from 'electron';
import { closeFolderDropdown, broadcastBookmarksChanged } from './utils';
import { sanitizeUrl } from '../features/url-security';
// Cursor-poll interval when dragging a bookmark out of the dropdown (ms)
const EXTERN_DRAG_POLL_MS = 30;

function register(ipcMain, { wm, screen, webContents }) {

    // ── Open / close ──────────────────────────────────────────────────────────

    ipcMain.handle('folder-dropdown-open', async (_e, anchorRect, folderData) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd) return false;

        // Toggle: clicking the same folder again closes it
        if (wd.folderDropdown && wd.folderDropdownId === folderData.id) {
            closeFolderDropdown(wd);
            wd.window.webContents.focus();
            return true;
        }

        closeFolderDropdown(wd);
        try {
            const view = new WebContentsView({
                webPreferences: {
                    preload: path.join(__dirname, '../preload/folder-dropdown-preload.js'),
                    contextIsolation: true,
                    nodeIntegration: false,
                },
            });
            view.setBackgroundColor('#00000000');
            wd.window.contentView.addChildView(view);
            wd.folderDropdown   = view;
            wd.folderDropdownId = folderData.id;

            view.setBounds(initialBounds(anchorRect, folderData, wd.window));
            view.webContents.loadFile(resolveAppFile('renderer/FolderDropdown/index.html'));
            await new Promise<void>(res => view.webContents.once('did-finish-load', () => res()));

            // Re-insert as last child to ensure it renders above all tab views
            wd.window.contentView.removeChildView(view);
            wd.window.contentView.addChildView(view);

            view.webContents.on('console-message', (_e, level, msg, line) => {
                const tag = ['', 'warn', 'error', 'debug'][level] || '';
                console.log(`[dropdown${tag ? ':' + tag : ''}:${line}] ${msg}`);
            });
            view.webContents.send('folder-dropdown-init', {
                children:  folderData.children || [],
                folderId:  folderData.id,
                title:     folderData.title || 'Folder',
            });
            return true;
        } catch (err) {
            console.error('folder-dropdown-open:', err);
            closeFolderDropdown(wd);
            return false;
        }
    });

    ipcMain.on('folder-dropdown-close', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd) { closeFolderDropdown(wd); wd.window.webContents.focus(); }
    });

    // Re-insert the dropdown as the last contentView child so it stays above
    // tab views. Called from dragstart — Electron's drag system can silently
    // demote the view's z-order when another WebContentsView has focus.
    ipcMain.on('folder-dropdown-raise', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd?.folderDropdown) return;
        try {
            wd.window.contentView.removeChildView(wd.folderDropdown);
            wd.window.contentView.addChildView(wd.folderDropdown);
        } catch {}
    });

    // ── Resize / navigate ─────────────────────────────────────────────────────

    ipcMain.on('folder-dropdown-update-bounds', (_e, width, height) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd?.folderDropdown) return;
        try {
            const b    = wd.folderDropdown.getBounds();
            const winW = wd.window.getContentBounds().width;
            b.width    = width;
            b.height   = Math.min(height, 500);
            if (b.x + b.width > winW) b.x = Math.max(0, winW - b.width);
            wd.folderDropdown.setBounds(b);
        } catch {}
    });

    ipcMain.on('folder-dropdown-navigate', (_e, url) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd) return;
        closeFolderDropdown(wd);
        wd.window.webContents.focus();
        wd.tabs?.loadUrl(wd.tabs.activeTabIndex, sanitizeUrl(url));
    });

    ipcMain.on('folder-dropdown-new-tab', (_e, url) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd) return;
        closeFolderDropdown(wd);
        wd.window.webContents.focus();
        if (wd.tabs) {
            const idx = wd.tabs.createTab(null, false);
            wd.tabs.loadUrl(idx, sanitizeUrl(url));
        }
    });

    // ── Context menu ──────────────────────────────────────────────────────────

    ipcMain.on('folder-dropdown-ctx-menu', (_e, item) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd) showFolderDropdownContextMenu(wd, item, wm, webContents);
    });

    // ── Extern drag (from dropdown → bookmark bar) ────────────────────────────

    let pollInterval    = null;
    let pollWindowData  = null;

    function stopPoll() {
        if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
        pollWindowData = null;
    }

    ipcMain.on('folder-dropdown-drag-start', (_e, id, folderId) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd) return;

        closeFolderDropdown(wd);
        wd.window.webContents.send('extern-bookmark-drag-start', id, folderId);

        // Poll cursor position and forward to the bar renderer so it can
        // highlight drop targets (HTML5 drag doesn't cross view boundaries).
        stopPoll();
        pollWindowData = wd;
        pollInterval   = setInterval(() => {
            if (!pollWindowData) { stopPoll(); return; }
            const cursor   = screen.getCursorScreenPoint();
            const winBounds = pollWindowData.window.getBounds();
            try {
                pollWindowData.window.webContents.send(
                    'extern-bookmark-drag-position',
                    cursor.x - winBounds.x,
                    cursor.y - winBounds.y,
                );
            } catch {}
        }, EXTERN_DRAG_POLL_MS);
    });

    ipcMain.on('folder-dropdown-drag-end', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        stopPoll();
        if (wd) wd.window.webContents.send('extern-bookmark-drag-end');
    });

    ipcMain.on('extern-bookmark-drop', (_e) => {
        stopPoll();
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd) wd.window.webContents.send('extern-bookmark-drag-end');
    });
}

// ── showFolderDropdownContextMenu ─────────────────────────────────────────────

function showFolderDropdownContextMenu(wd, item, wm, webContents) {
    const { type, id, url, title, parentFolderId } = item || {};
    const broadcast = () => broadcastBookmarksChanged(webContents);

    const closeAndFocus = () => { closeFolderDropdown(wd); wd.window.webContents.focus(); };

    // Refresh the open dropdown panel for a specific folder without closing it.
    // Optionally triggers inline rename for a newly-created item.
    async function refreshPanel(folderId, renameId = null) {
        if (!wd.folderDropdown) return;
        broadcast();
        try {
            const all    = await wm.bookmarks.getAll();
            const folder = findFolderDeep(all, folderId);
            if (!folder) return;
            wd.folderDropdown.webContents.send('folder-dropdown-refresh-panel', {
                folderId,
                children: folder.children || [],
                renameId,
            });
        } catch {}
    }

    const startInlineRename = (itemId, itemTitle) => {
        if (!wd.folderDropdown) return;
        try { wd.folderDropdown.webContents.send('folder-dropdown-start-rename', { id: itemId, title: itemTitle }); } catch {}
    };

    // "New Folder / Divider Here" items scoped to the parent folder being viewed
    const addHereItems = parentFolderId ? [
        { type: 'separator' },
        { label: 'New Folder Here', click: async () => {
            const newId = await wm.bookmarks.addFolderInto('New Folder', parentFolderId);
            if (newId) await refreshPanel(parentFolderId, newId);
        }},
        { label: 'New Divider Here', click: async () => {
            await wm.bookmarks.addDividerInto(parentFolderId);
            await refreshPanel(parentFolderId);
        }},
    ] : [];

    let template = [];

    if (type === 'bookmark') {
        template = [
            { label: 'Open',               click: () => { closeAndFocus(); wd.tabs.loadUrl(wd.tabs.activeTabIndex, url); } },
            { label: 'Open in New Tab',    click: () => { closeAndFocus(); const i = wd.tabs.createTab(null, false); wd.tabs.loadUrl(i, url); } },
            { label: 'Open in Background', click: () => { const i = wd.tabs.createTab(null, false); wd.tabs.loadUrl(i, url); } },
            { type: 'separator' },
            { label: 'Edit',   click: () => { closeAndFocus(); wd.window.webContents.send('bookmark-edit-prompt', { id, url, title }); } },
            { label: 'Delete', click: async () => {
                await wm.bookmarks.removeById(id);
                if (parentFolderId) await refreshPanel(parentFolderId); else broadcast();
            }},
            ...addHereItems,
        ];
    } else if (type === 'folder') {
        template = [
            { label: 'Open All in New Tabs', click: async () => {
                const all    = await wm.bookmarks.getAll();
                const folder = findFolderDeep(all, id);
                if (folder?.children) {
                    folder.children.filter(c => c.type === 'bookmark').forEach(c => {
                        const i = wd.tabs.createTab(null, false);
                        wd.tabs.loadUrl(i, c.url);
                    });
                }
            }},
            { type: 'separator' },
            { label: 'Rename', click: () => startInlineRename(id, title) },
            { label: 'Delete', click: async () => {
                await wm.bookmarks.removeById(id);
                if (parentFolderId) await refreshPanel(parentFolderId);
                else { broadcast(); closeAndFocus(); }
            }},
            ...addHereItems,
        ];
    } else if (type === 'folder-bg') {
        template = [
            { label: 'New Folder Here', click: async () => {
                const newId = await wm.bookmarks.addFolderInto('New Folder', id);
                if (newId) await refreshPanel(id, newId);
            }},
            { label: 'New Divider Here', click: async () => {
                await wm.bookmarks.addDividerInto(id);
                await refreshPanel(id);
            }},
            { type: 'separator' },
            { label: 'Rename', click: () => startInlineRename(id, title) },
            { label: 'Delete', click: async () => {
                await wm.bookmarks.removeById(id);
                broadcast();
                closeAndFocus();
            }},
        ];
    } else if (type === 'divider') {
        template = [
            { label: 'Delete Divider', click: async () => {
                await wm.bookmarks.removeById(id);
                if (parentFolderId) await refreshPanel(parentFolderId); else broadcast();
            }},
            ...addHereItems,
        ];
    }

    if (template.length) Menu.buildFromTemplate(template).popup({ window: wd.window });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Compute initial pixel bounds for a newly opened dropdown. */
function initialBounds(anchorRect, folderData, win) {
    const children  = folderData.children || [];
    const itemCount = children.filter(c => c.type !== 'divider').length || 1;
    const sepCount  = children.filter(c => c.type === 'divider').length;
    // Single-panel width (matches PANEL_WIDTH + PANEL_PADDING in dropdown.js)
    const w    = 240 + 16;
    const h    = Math.min(itemCount * 28 + sepCount * 7 + 16, 480);
    const winW = win.getContentBounds().width;
    const x    = Math.max(0, Math.min(Math.floor(anchorRect.left), winW - w));
    const y    = Math.floor(anchorRect.bottom);
    return { x, y, width: w, height: h };
}

/** Recursively find a folder node by id inside the bookmark tree. */
function findFolderDeep(items, targetId) {
    for (const it of items) {
        if (it.id === targetId) return it;
        if (it.type === 'folder' && it.children) {
            const found = findFolderDeep(it.children, targetId);
            if (found) return found;
        }
    }
    return null;
}

export { register };