/**
 * IPC handlers — tab management and window drag/drop.
 *
 * Covers: create, remove, switch, load, navigate, pin, reorder,
 *         move tab to another window, detach to new window,
 *         and session persistence mode.
 */

const { Menu } = require('electron');
const { sanitizeUrl } = require('../Features/url-security');

// Compact label for a per-tab history entry ("host/path…" like Firefox's list)
function navEntryLabel(url) {
    if (!url || url === 'newtab') return 'New Tab';
    if (url === 'settings')  return 'Settings';
    if (url === 'history')   return 'History';
    if (url === 'bookmarks') return 'Bookmarks';
    try {
        const u = new URL(url);
        let label = u.hostname.replace(/^www\./, '') + (u.pathname !== '/' ? u.pathname : '');
        if (u.search) label += u.search;
        return label.length > 60 ? label.slice(0, 57) + '…' : label;
    } catch {
        return url.length > 60 ? url.slice(0, 57) + '…' : url;
    }
}

function register(ipcMain, { wm, BrowserWindow, screen }) {
    // Chromium reports screenX/screenY as (0,0) on `dragend` when the drop lands
    // outside the window — which is exactly the tear-off case. Read the real OS
    // cursor position in the main process instead; fall back to the passed coords.
    const dropPoint = (screenX, screenY) => {
        try {
            const p = screen && screen.getCursorScreenPoint && screen.getCursorScreenPoint();
            if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && (p.x || p.y)) return p;
        } catch {}
        return { x: screenX || 0, y: screenY || 0 };
    };

    // ── Basic tab operations ──────────────────────────────────────────────────

    ipcMain.handle('addTab', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd) wd.tabs.createTab();
    });

    // Private tab: fully isolated in-memory session, wiped when the tab closes.
    ipcMain.handle('addPrivateTab', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd) wd.tabs.createTab(null, true, true);
    });

    // Open a URL in a new background tab without loading it until the user switches to it
    ipcMain.handle('addTabLazy', (_e, url) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd) return;
        const safe = sanitizeUrl(url);
        let title = safe;
        try { title = new URL(safe).hostname; } catch {}
        wd.tabs.createLazyTab(safe, title, false, false, true, true);
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
        if (wd) wd.tabs.loadUrl(index, sanitizeUrl(url));
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

    ipcMain.handle('stopTab', (_e, index) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        const tab = wd?.tabs?.tabMap.get(index);
        if (tab) { try { tab.webContents.stop(); } catch {} }
    });

    ipcMain.handle('newWindow', () => {
        wm.createWindow();
    });

    ipcMain.handle('newPrivateWindow', (_e) => {
        wm.createWindow(800, 600, { private: true });
    });

    ipcMain.handle('isPrivateWindow', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        return wd?.tabs?.isPrivateWindow ?? false;
    });

    // Synchronous variant used during renderer startup (keeps init single-tick)
    ipcMain.on('is-private-window-sync', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        _e.returnValue = wd?.tabs?.isPrivateWindow ?? false;
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

    // Long-press / right-click on back-forward buttons: show the tab's full
    // navigation stack (newest first, current entry checked) as a native menu.
    ipcMain.handle('show-nav-history-menu', (_e, index, x, y) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd?.tabs) return false;

        const h = wd.tabs.navigationHistory.getHistory(index);
        if (!h || !Array.isArray(h.entries) || h.entries.length < 2) return false;

        const template = [...h.entries].reverse().map(entry => ({
            // Prefer the page title (Firefox shows titles in this list); fall
            // back to a compact host/path label when the title isn't known yet.
            label:   entry.title || navEntryLabel(entry.data),
            type:    'checkbox',
            checked: entry.index === h.currentIndex,
            enabled: entry.index !== h.currentIndex,
            click:   () => { try { wd.tabs.goToHistoryIndex(index, entry.index); } catch {} },
        }));

        Menu.buildFromTemplate(template).popup({
            window: wd.window,
            x: Math.round(x),
            y: Math.round(y),
        });
        return true;
    });

    // ── Reader mode + Picture-in-Picture ─────────────────────────────────────

    ipcMain.handle('reader-toggle', (_e, index) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd?.tabs) return false;
        const idx = (typeof index === 'number') ? index : wd.tabs.activeTabIndex;
        wd.tabs.toggleReader(idx);
        return true;
    });

    // Served to the reader page: find which tab this webContents is, return its article.
    ipcMain.handle('reader-get-article', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd?.tabs) return null;
        for (const [idx, tab] of wd.tabs.tabMap) {
            if (tab?.webContents === _e.sender) return wd.tabs.getReaderArticle(idx);
        }
        return null;
    });

    // Called from the reader page's own "close" button. Guarded so it only ever
    // exits an active reader view (a normal page calling this is a no-op).
    ipcMain.handle('reader-exit', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd?.tabs) return false;
        for (const [idx, tab] of wd.tabs.tabMap) {
            if (tab?.webContents === _e.sender && wd.tabs.readerMode.has(idx)) {
                wd.tabs.toggleReader(idx);
                return true;
            }
        }
        return false;
    });

    ipcMain.handle('toggle-pip', (_e, index) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd?.tabs) return false;
        const idx = (typeof index === 'number') ? index : wd.tabs.activeTabIndex;
        wd.tabs.togglePictureInPicture(idx);
        return true;
    });

    // ── Menu actions (find / print / zoom on the active tab) ──────────────────

    const activeTabOf = (wd) => wd?.tabs ? (wd.tabs.tabMap.get(wd.tabs.activeTabIndex) || null) : null;

    ipcMain.handle('menu-find', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        const tab = activeTabOf(wd);
        if (tab && wd.tabs.findDialog) { try { wd.tabs.findDialog.show(tab); } catch {} return true; }
        return false;
    });

    ipcMain.handle('menu-print', (_e) => {
        const tab = activeTabOf(wm.getWindowByWebContents(_e.sender));
        if (tab) { try { tab.webContents.print(); } catch {} }
        return true;
    });

    ipcMain.handle('menu-zoom', (_e, dir) => {
        const tab = activeTabOf(wm.getWindowByWebContents(_e.sender));
        if (!tab) return 100;
        const wc = tab.webContents;
        try {
            if (dir !== 'get') {
                let level = wc.getZoomLevel();
                if (dir === 'in')       level = Math.min(5, level + 0.5);
                else if (dir === 'out') level = Math.max(-3, level - 0.5);
                else                    level = 0; // reset
                wc.setZoomLevel(level);
            }
            return Math.round(wc.getZoomFactor() * 100);
        } catch { return 100; }
    });

    // ── Navigation helpers (used by history / bookmarks pages) ───────────────

    ipcMain.handle('navigate-active-tab', (_e, url) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd) return false;
        wd.tabs.loadUrl(wd.tabs.activeTabIndex, sanitizeUrl(url));
        return true;
    });

    ipcMain.handle('active-tab-go-back', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd) return false;
        wd.tabs.goBack(wd.tabs.activeTabIndex);
        return true;
    });

    // ── Hover preconnect ──────────────────────────────────────────────────────
    // The web preload reports link hovers; warm DNS + TCP + TLS to that origin
    // so the click starts on a hot connection (~100–300 ms saved per cross-site
    // navigation). Uses the sender's own session, so private tabs warm the
    // private session and leave no trace in the default one.
    const preconnectCounts = new Map(); // webContents.id → count (per page lifetime budget)
    ipcMain.on('link-preconnect', (e, origin) => {
        try {
            if (typeof origin !== 'string' || !/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin)) return;
            const n = (preconnectCounts.get(e.sender.id) || 0) + 1;
            if (n > 60) return;
            if (n === 1) e.sender.once('destroyed', () => preconnectCounts.delete(e.sender.id));
            preconnectCounts.set(e.sender.id, n);
            e.sender.session.preconnect({ url: origin, numSockets: 1 });
        } catch {}
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

    // ── Tab drag (Firefox model: nothing moves until RELEASE) ────────────────
    // While a tab is dragged outside its strip, the main process only tracks
    // the cursor: it raises the window under the pointer (so the user can see
    // the drop target) and highlights that window's strip. The actual move /
    // detach happens on drop. Escape in the renderer aborts everything.
    const MERGE_STRIP_H = 48;        // top region of a window that counts as its tab strip
    let dragTrack = null;            // { timer, raisedId, hoverTarget }
    let lastRaisedId = null;         // kept for get-window-at-point tie-breaking

    const windowAtCursor = (p, excludeId) => {
        const matches = wm.getAllWindows().filter(w => {
            if (w.id === excludeId || w.window.isDestroyed() || w.window.isMinimized()) return false;
            const b = w.window.getBounds();
            return p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
        });
        // getAllWindows() is creation order, not z-order. When windows overlap,
        // prefer the one we raised under the cursor — it's the one the user sees.
        return matches.find(w => w.id === lastRaisedId) || matches[0] || null;
    };

    const setMergeHover = (wd, on) => {
        try {
            if (wd && !wd.window.isDestroyed()) wd.window.webContents.send('tab-merge-hover', !!on);
        } catch {}
    };

    const stopDragTrack = () => {
        if (!dragTrack) return;
        clearInterval(dragTrack.timer);
        if (dragTrack.hoverTarget) setMergeHover(dragTrack.hoverTarget, false);
        dragTrack = null;
    };

    ipcMain.on('tab-drag-track', (_e, on) => {
        if (!on) { stopDragTrack(); return; }
        if (dragTrack) return;
        const srcWd = wm.getWindowByWebContents(_e.sender);
        dragTrack = { raisedId: null, hoverTarget: null, timer: setInterval(() => {
            try {
                const p = screen.getCursorScreenPoint();
                const over = windowAtCursor(p);
                const overId = over ? over.id : null;
                if (overId !== null && overId !== dragTrack.raisedId) {
                    dragTrack.raisedId = overId;
                    lastRaisedId = overId;
                    over.window.moveTop();
                    // Source window stays on top so its dragged-tab ghost is visible.
                    try { if (srcWd && !srcWd.window.isDestroyed()) srcWd.window.moveTop(); } catch {}
                }
                // Highlight the strip we'd drop into (other windows only).
                const overStrip = over && over !== srcWd && p.y <= over.window.getBounds().y + MERGE_STRIP_H;
                const hoverTarget = overStrip ? over : null;
                if (hoverTarget !== dragTrack.hoverTarget) {
                    if (dragTrack.hoverTarget) setMergeHover(dragTrack.hoverTarget, false);
                    if (hoverTarget)           setMergeHover(hoverTarget, true);
                    dragTrack.hoverTarget = hoverTarget;
                }
            } catch {}
        }, 60) };
    });

    // Resolve a drop that ended OUTSIDE the source strip. Returns what happened.
    ipcMain.handle('tab-drag-drop', async (_e, tabIndex, url) => {
        // The strip highlighted during the drag is the drop target the user
        // saw — prefer it over recomputing from scratch (which can pick a
        // different window when several overlap).
        const hovered = (dragTrack && dragTrack.hoverTarget && !dragTrack.hoverTarget.window.isDestroyed())
            ? dragTrack.hoverTarget : null;
        stopDragTrack();
        const src = wm.getWindowByWebContents(_e.sender);
        if (!src) return 'none';
        try {
            const p = screen.getCursorScreenPoint();
            const target = hovered || windowAtCursor(p);
            const safeUrl = url && url !== 'newtab' ? sanitizeUrl(url) : null;

            // ── Drop on ANOTHER window's tab strip → move the tab there ──────
            const onStrip = hovered ? true
                : (target && p.y <= target.window.getBounds().y + MERGE_STRIP_H);
            if (target && target.id !== src.id && onStrip) {
                // Ask the target chrome where the cursor lands in its strip so
                // the tab is inserted AT the drop position (Firefox behaviour).
                let insertAfter = null;
                try {
                    const tb = target.window.getBounds();
                    insertAfter = await target.window.webContents.executeJavaScript(
                        `window.__tabDropIndex ? window.__tabDropIndex(${Math.round(p.x - tb.x)}) : null`, true);
                } catch {}
                const idx = target.tabs.createTab(Number.isInteger(insertAfter) ? insertAfter : null, true);
                if (safeUrl) target.tabs.loadUrl(idx, safeUrl);
                src.tabs.removeTab(tabIndex);   // closes the source window if it was the last tab
                setMergeHover(target, false);
                try { target.window.focus(); target.window.moveTop(); } catch {}
                return 'moved';
            }

            // ── Drop anywhere else → detach into its own window ──────────────
            if (src.tabs.tabMap.size <= 1) {
                // Only tab: the "detached window" is just the source window moved.
                const b = src.window.getBounds();
                src.window.setBounds({ x: Math.round(p.x - 140), y: Math.round(p.y - 20), width: b.width, height: b.height });
                try { src.window.focus(); } catch {}
                return 'window-moved';
            }
            const newWin = wm.createWindow(900, 640);
            newWin.window.setBounds({ x: Math.round(p.x - 140), y: Math.round(p.y - 20), width: 900, height: 640 });
            if (safeUrl) {
                newWin.window.webContents.once('did-finish-load', () => {
                    try {
                        if (newWin.window.isDestroyed()) return;
                        const firstIdx = Array.from(newWin.tabs.tabMap.keys())[0];
                        if (firstIdx !== undefined) newWin.tabs.loadUrl(firstIdx, safeUrl);
                    } catch {}
                });
            }
            src.tabs.removeTab(tabIndex);
            try { newWin.window.focus(); } catch {}
            return 'detached';
        } catch (err) {
            console.error('tab-drag-drop:', err);
            return 'none';
        }
    });

    ipcMain.handle('get-window-at-point', (_e, screenX, screenY) => {
        const { x, y } = dropPoint(screenX, screenY);
        const matches = wm.getAllWindows().filter(w => {
            const b = w.window.getBounds();
            return x >= b.x && x <= b.x + b.width &&
                   y >= b.y && y <= b.y + b.height;
        });
        if (!matches.length) return null;
        if (matches.length === 1) return { id: matches[0].id };

        // Multiple overlapping windows. getAllWindows() is CREATION order, not
        // z-order, so it can't tell which window is visually on top. But during
        // a tab drag we raised the window under the cursor (moveTop) — that one
        // is the topmost and is the drop target the user is looking at.
        const raised = matches.find(w => w.id === lastRaisedId);
        if (raised && !raised.window.isDestroyed() && raised.window.isVisible()) {
            return { id: raised.id };
        }
        const focusedBw = BrowserWindow.getFocusedWindow();
        const focused = focusedBw && matches.find(w => w.window === focusedBw);
        if (focused) return { id: focused.id };
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
                dst.tabs.loadUrl(idx, sanitizeUrl(url));
            }
            src.tabs.removeTab(tabIndex);
            // The tab now lives in the destination window — focus follows it
            // (Chrome does the same), otherwise the move looks like nothing
            // happened when the destination sits behind the source.
            try { dst.window.focus(); dst.window.moveTop(); } catch {}
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
            const { x, y } = dropPoint(screenX, screenY);
            const newWin = wm.createWindow(800, 600);
            newWin.window.setBounds({
                x: Math.max(0, Math.floor(x - 400)),
                y: Math.max(0, Math.floor(y - 300)),
                width: 800, height: 600,
            });
            if (url && url !== 'newtab') {
                const safeUrl = sanitizeUrl(url);
                newWin.window.webContents.once('did-finish-load', () => {
                    try {
                        if (newWin.window.isDestroyed()) return;
                        const firstIdx = Array.from(newWin.tabs.tabMap.keys())[0];
                        if (firstIdx !== undefined) newWin.tabs.loadUrl(firstIdx, safeUrl);
                    } catch {}
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
