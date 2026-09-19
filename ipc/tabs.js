/**
 * IPC handlers — tab management and window drag/drop.
 *
 * Covers: create, remove, switch, load, navigate, pin, reorder,
 *         move tab to another window, detach to new window,
 *         and session persistence mode.
 */
const log = require('../features/log');
const { isTrustedInternalSender } = require('../features/ipc-guard');
const overlayMenu = require('../features/overlay-menu');
const { Menu, net } = require('electron');
const { sanitizeUrl } = require('../features/url-security');
const zoom = require('../features/zoom');
const faviconStore = require('../features/favicon-store');
// Favicon fetch cache: page/favicon URL → data-URL (or '' for a known failure).
// Bounded; cleared wholesale when full. Lives for the process lifetime.
const _faviconCache = new Map();
// Fetch one URL over Electron's net stack; resolve a data: URL or '' on failure.
function fetchFaviconOnce(url) {
    return new Promise((resolve) => {
        let settled = false;
        const done = (v) => { if (!settled) {
            settled = true;
            resolve(v);
        } };
        try {
            const req = net.request({ url, useSessionCookies: false });
            const chunks = [];
            let total = 0;
            req.on('response', (res) => {
                const status = res.statusCode || 0;
                const type = String(res.headers['content-type'] || res.headers['Content-Type'] || '');
                if (status < 200 || status >= 300 || !type.includes('image')) {
                    res.on('data', () => { });
                    res.on('end', () => done(''));
                    return;
                }
                res.on('data', (c) => {
                    total += c.length;
                    if (total > 512 * 1024) {
                        try {
                            req.abort();
                        }
                        catch (e) { log.debug('tabs', 'done', e); }
                        return done('');
                    }
                    chunks.push(c);
                });
                res.on('end', () => {
                    if (!chunks.length)
                        return done('');
                    const mime = type.split(';')[0].trim() || 'image/x-icon';
                    done(`data:${mime};base64,${Buffer.concat(chunks).toString('base64')}`);
                });
                res.on('error', () => done(''));
            });
            req.on('error', () => done(''));
            setTimeout(() => { try {
                req.abort();
            }
            catch (e) { log.debug('tabs', 'done', e); } done(''); }, 6000);
            req.end();
        }
        catch {
            done('');
        }
    });
}
// Candidate favicon URLs to try in order. Only the site itself — never a
// third-party aggregator (Google's s2 service would leak every domain to
// Google). Try the given icon, then the site's root /favicon.ico as a fallback.
function faviconCandidates(url) {
    try {
        const u = new URL(url);
        const root = `${u.origin}/favicon.ico`;
        return url === root ? [url] : [url, root];
    }
    catch (e) { log.debug('tabs', 'faviconCandidates', e); }
    return [url];
}
// Fetch a favicon in the MAIN process and return it as a data: URL. The chrome
// renderer is a file:// page; on some setups (notably Windows) loading a remote
// favicon <img> straight from that origin fails, so the tab strip renders no
// icons. Fetching here — same network stack, no file:// origin — is reliable
// everywhere, cached, and the returned data URL can't itself fail to load.
async function fetchFaviconDataUrl(url) {
    if (!url || !/^https?:\/\//i.test(url))
        return '';
    const cached = _faviconCache.get(url);
    if (cached !== undefined)
        return cached;
    let result = '';
    for (const cand of faviconCandidates(url)) {
        result = await fetchFaviconOnce(cand);
        if (result)
            break;
    }
    if (_faviconCache.size > 1000)
        _faviconCache.clear();
    _faviconCache.set(url, result);
    return result;
}
// Compact label for a per-tab history entry ("host/path…")
function navEntryLabel(url) {
    if (!url || url === 'newtab')
        return 'New Tab';
    if (url === 'settings')
        return 'Settings';
    if (url === 'history')
        return 'History';
    if (url === 'bookmarks')
        return 'Bookmarks';
    try {
        const u = new URL(url);
        let label = u.hostname.replace(/^www\./, '') + (u.pathname !== '/' ? u.pathname : '');
        if (u.search)
            label += u.search;
        return label.length > 60 ? label.slice(0, 57) + '…' : label;
    }
    catch {
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
            if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && (p.x || p.y))
                return p;
        }
        catch (e) { log.debug('tabs', 'dropPoint', e); }
        return { x: screenX || 0, y: screenY || 0 };
    };
    // Reading position from a page's preload (throttled there). Stored per tab
    // so buildSerializableState() can put it in the session file.
    ipcMain.on('page:scroll', (e, y) => {
        const wd = wm.getWindowByWebContents(e.sender);
        if (!wd?.tabs || !Number.isFinite(y))
            return;
        for (const [idx, tab] of wd.tabs.tabMap) {
            if (tab?.webContents === e.sender) {
                wd.tabs.tabScroll.set(idx, Math.max(0, Math.round(y)));
                return;
            }
        }
    });
    // ── Basic tab operations ──────────────────────────────────────────────────
    ipcMain.handle('addTab', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        // Returns the new tab's index so callers can load into it (Duplicate Tab).
        return wd ? wd.tabs.createTab() : null;
    });
    // Private tab: fully isolated in-memory session, wiped when the tab closes.
    ipcMain.handle('addPrivateTab', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd)
            wd.tabs.createTab(null, true, true);
    });
    // Open a URL in a new background tab without loading it until the user switches to it
    ipcMain.handle('addTabLazy', (_e, url) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd)
            return;
        const safe = sanitizeUrl(url);
        let title = safe;
        try {
            title = new URL(safe).hostname;
        }
        catch (e) { log.debug('tabs', 'addTabLazy', e); }
        wd.tabs.createLazyTab(safe, title, false, false, true, true);
    });
    ipcMain.handle('removeTab', (_e, index) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd)
            wd.tabs.removeTab(index);
    });
    ipcMain.handle('switchTab', (_e, index) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd)
            wd.tabs.showTab(index);
    });
    // User-initiated open (omnibox / bookmark / history): may auto-route a flagged
    // site into its isolated tenant instance (openUrlUserInitiated), unlike the
    // internal wd.tabs.loadUrl used for programmatic loads.
    ipcMain.handle('loadUrl', (_e, index, url) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd)
            wd.tabs.openUrlUserInitiated(index, sanitizeUrl(url));
    });
    // Reopen a container-tagged history/bookmark/suggestion in its container (a
    // new tab on that container's session, so you land back in the right
    // account). If the container is gone, fall back to a fresh one for the site.
    ipcMain.handle('tab:openInContainer', (_e, containerId, url) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd)
            return;
        const containers = require('../features/containers');
        const safe = sanitizeUrl(url);
        if (containerId != null && containers.meta(String(containerId)))
            wd.tabs.openInContainer(safe, String(containerId));
        else
            wd.tabs.openIsolatedInstance(safe);
    });
    // ── Profiles (browsing selves; windows belong to one) ─────────
    const profiles = require('../features/profiles');
    const broadcastProfiles = () => {
        try {
            for (const w of wm.windows.values())
                w.window?.webContents?.send('profiles:changed');
        }
        catch (e) { log.debug('tabs', 'broadcastProfiles', e); }
    };
    ipcMain.handle('profiles:current', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        return profiles.meta(wd?.profileId || '1');
    });
    ipcMain.handle('profiles:list', () => profiles.list());
    ipcMain.handle('profiles:rename', (_e, id, name) => {
        const p = profiles.rename(id, name);
        broadcastProfiles();
        return p;
    });
    ipcMain.handle('profiles:update', (_e, id, patch) => {
        if (!isTrustedInternalSender(_e.sender)) {
            log.warn('tabs', 'blocked profiles:update from untrusted sender');
            return null;
        }
        const p = profiles.update(id, patch);
        broadcastProfiles();
        // A space's theme is worn by every window in that space, so changing it
        // has to re-resolve the surfaces — nothing moved, but what they resolve
        // to did.
        if (patch && 'theme' in patch) {
            try { require('../features/theme-runtime').repaintAll(wm); }
            catch (e) { log.debug('tabs', 'profiles:update theme', e); }
        }
        return p;
    });
    // ── Sidebar resize ────────────────────────────────────────────────────────
    // The page is a native view layered over the chrome. While the cursor is over
    // the sidebar the renderer drives the drag (pointermove → sidebar:resize); the
    // moment it crosses onto the page view the renderer goes deaf, so we ALSO drive
    // the drag from the page view's own input-event stream. The page stays visible
    // and resizes live under the cursor, and mouseUp there ends the drag (the
    // renderer is told via 'sidebar-resize-ended' since its pointerup never fires).
    // Drag below RAIL_SNAP collapses to an icon-only rail (RAIL_W); otherwise the
    // width is clamped to a comfortable [MIN_W, MAX_W]. The 56..180 band never
    // persists, so the divider snaps between rail and expanded (flat).
    // Measured off the reference: the sidebar spans ~9.5% of the window at its
    // minimum and ~29.6% at its maximum, so the clamps scale with the window
    // rather than sitting at fixed pixels. Absolute floors keep it usable on a
    // very narrow window.
    // No icon-rail collapse: dragging narrow stops at the minimum with labels
    // intact, rather than snapping to an icons-only strip.
    // The clamp itself lives in renderer/lib/util.js, so the drag in the chrome
    // and this side (which takes over once the pointer is over the page view)
    // cannot drift apart — they did, and the sidebar kept shrinking on screen
    // after the page had stopped moving.
    const { clampSidebarWidth } = require('../renderer/lib/util');
    const winWidthOf = (wd) => {
        try { return wd?.window?.getContentBounds?.().width || 0; }
        catch (e) { log.debug('tabs', 'winWidthOf', e); return 0; }
    };
    const clampW = (w, wd) => clampSidebarWidth(w, winWidthOf(wd));
    function applyWidthLive(wd, width) {
        const t = wd.tabs;
        if (width === t.sidebarWidth) return;
        t.sidebarWidth = width;
        try { t.resizeAllTabs(); } catch (e) { log.debug('tabs', 'applyWidthLive', e); }
        try { wd.window.webContents.send('sidebar-width-changed', width); } catch (e) { log.debug('tabs', 'applyWidthLive', e); }
    }
    // A width change forces Chromium to relayout the whole document synchronously
    // on the CPU — a wontfix limitation (electron #3615) that no throttle escapes,
    // so a heavy page (Wikipedia) stutters when resized live. For those we HIDE the
    // page for the duration of the drag (applyWidthBlank): the sidebar still resizes
    // live over a blank card, and the one costly relayout happens once, on release,
    // when the view is shown again. Light (internal) pages keep the live resize.
    function applyWidthBlank(wd, width) {
        const t = wd.tabs;
        if (width === t.sidebarWidth) return;
        t.sidebarWidth = width;
        // No page setBounds — the view is hidden. Only the chrome sidebar tracks
        // the cursor live; endResize resizes + reveals the page.
        try { wd.window.webContents.send('sidebar-width-changed', width); } catch (e) { log.debug('tabs', 'applyWidthBlank', e); }
    }
    function endResize(wd, width) {
        const t = wd?.tabs;
        if (!t || !t._sidebarResizing) return;
        t._sidebarResizing = false;
        if (t._sidebarPoll) { clearInterval(t._sidebarPoll); t._sidebarPoll = null; }
        if (t._sidebarPollSafety) { clearTimeout(t._sidebarPollSafety); t._sidebarPollSafety = null; }
        if (t._sidebarInput) {
            const { wc, chromeWc, onInput } = t._sidebarInput;
            try { if (wc && !wc.isDestroyed()) wc.removeListener('input-event', onInput); } catch (e) { log.debug('tabs', 'endResize', e); }
            try { if (chromeWc && !chromeWc.isDestroyed()) chromeWc.removeListener('input-event', onInput); } catch (e) { log.debug('tabs', 'endResize', e); }
            t._sidebarInput = null;
        }
        // Trust the LIVE width the cursor poll kept in t.sidebarWidth, not the
        // `width` a caller passes: the renderer's commit sends its own `pending`,
        // which is stale because its pointermove never fired over the page view —
        // using it would snap the sidebar back to where the drag started.
        const final = clampW(t.sidebarWidth, wd);
        try { wm.persistence.set('sidebarWidth', final); } catch (e) { log.debug('tabs', 'endResize', e); }
        // Width is a global setting — apply to every window so they stay in sync.
        for (const w of wm.windows.values()) {
            try {
                w.tabs.sidebarWidth = final;
                w.tabs.resizeAllTabs();
                w.window.webContents.send('sidebar-width-changed', final);
                // Release may have landed on the page view, so the renderer's own
                // pointerup never fired — force it to drop its drag state.
                w.window.webContents.send('sidebar-resize-ended', final);
            }
            catch (e) { log.debug('tabs', 'endResize', e); }
        }
        // Reveal a page that was blanked for the drag — resizeAllTabs above already
        // set its true width, so it comes back correctly sized (one relayout).
        if (t._sidebarBlankTab) {
            const blanked = t._sidebarBlankTab;
            t._sidebarBlankTab = null;
            try { if (blanked.webContents && !blanked.webContents.isDestroyed()) blanked.setVisible(true); }
            catch (e) { log.debug('tabs', 'endResize reveal', e); }
        }
    }
    ipcMain.handle('sidebar:resize-start', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        const t = wd?.tabs;
        if (!t) return;
        t._sidebarResizing = true;
        // Hide the active page for the drag and snap on release, rather than
        // relayout it on every frame (which stutters on a heavy page — Chromium
        // relayouts synchronously, a wontfix limitation; see applyWidthBlank). Done
        // for EVERY tab regardless of weight: the blank-then-snap is uniform and
        // never risks a laggy live resize, and predicting "heavy" reliably isn't
        // possible (DOM node count is a poor proxy for relayout cost).
        t._sidebarBlankTab = null;
        try {
            const tab0 = t.tabMap.get(t.activeTabIndex);
            if (tab0 && tab0.webContents && !tab0.webContents.isDestroyed()) {
                tab0.setVisible(false);
                t._sidebarBlankTab = tab0;
            }
        }
        catch (e) { log.debug('tabs', 'resize-start blank', e); }
        // The chrome and the page are separate native views. Once the cursor
        // crosses the sidebar↔page seam mid-drag, NEITHER the renderer's
        // pointermove NOR the page view's input-event is delivered to us (the OS
        // routes the moves to whichever native view is under the cursor, or to
        // neither) — which is why the drag silently did nothing. So drive the
        // resize from the OS cursor directly: view-agnostic and always correct.
        // The new width is simply the cursor's x within the window content.
        if (t._sidebarPoll) clearInterval(t._sidebarPoll);
        // ENDING the drag is the hard part. The release can land on the page's
        // native view, so NEITHER the renderer's pointerup NOR the page view's
        // mouseUp is guaranteed to reach us (same reason the moves don't). The
        // reliable signal is the cursor itself going still: once the drag has
        // moved, half a second of no movement means the button is up and the
        // event was missed. That, plus the fast-path events below, ends it.
        let lastX = null, lastMoveAt = Date.now(), movedOnce = false;
        const IDLE_MS = 480;
        // Full 60Hz for cursor tracking. When the page is blanked (heavy) the tick
        // only moves the chrome sidebar (cheap); a light page resizes live.
        const tick = () => {
            if (!t._sidebarResizing) return;
            try {
                const pt = screen.getCursorScreenPoint();
                if (lastX === null || pt.x !== lastX) { lastX = pt.x; lastMoveAt = Date.now(); movedOnce = true; }
                else if (movedOnce && Date.now() - lastMoveAt > IDLE_MS) { endResize(wd, t.sidebarWidth); return; }
                const cb = wd.window.getContentBounds();
                const w = clampW(pt.x - cb.x, wd);
                t._sidebarBlankTab ? applyWidthBlank(wd, w) : applyWidthLive(wd, w);
            }
            catch (e) { log.debug('tabs', 'resize poll', e); }
        };
        t._sidebarPoll = setInterval(tick, 16);
        // Hard safety net: only reached if the drag never moved at all (a
        // press-and-hold with no motion), since any motion arms the idle-end.
        t._sidebarPollSafety = setTimeout(() => { if (t._sidebarResizing) endResize(wd, t.sidebarWidth); }, 8000);
        // Fast-path ends: the page view's mouseUp AND the chrome window's own
        // input-event (the drag began on the chrome, so with mouse capture the
        // release may come back to it) — whichever reaches us first wins; the
        // idle-detector above is the backstop when neither does.
        // ONLY mouseUp ends it. NOT mouseLeave: the chrome view fires mouseLeave
        // the instant the cursor crosses the sidebar→page seam mid-drag — which
        // is the very crossing this poll exists to survive — so ending on it
        // killed every rightward drag on contact with the page ("dragging does
        // nothing"). The release is fully covered without it (chrome mouseUp,
        // page-view mouseUp, and the 480ms idle backstop).
        const endOnUp = (_ev, input) => {
            if (!t._sidebarResizing) return;
            if (input.type === 'mouseUp') endResize(wd, t.sidebarWidth);
        };
        const wc = t.tabMap.get(t.activeTabIndex)?.webContents;
        const chromeWc = wd.window.webContents;
        t._sidebarInput = { wc: wc || null, chromeWc, onInput: endOnUp };
        try { if (wc) wc.on('input-event', endOnUp); } catch (e) { log.debug('tabs', 'onInput', e); }
        try { chromeWc.on('input-event', endOnUp); } catch (e) { log.debug('tabs', 'onInput chrome', e); }
    });
    // Chrome context menus are chrome DOM, but the page is a native view painted
    // over it — a click on the page never reaches the chrome, so the menu would
    // stay open. While one is up, watch the active tab's input stream and tell
    // the chrome to close on any press there.
    // Keyboard focus lives with the active tab's view, so an inline input in the
    // chrome (folder rename, space name) gets a caret but receives no keystrokes
    // until the chrome itself is focused.
    ipcMain.on('chrome:focus', (_e) => {
        try { wm.getWindowByWebContents(_e.sender)?.window?.webContents?.focus(); }
        catch (e) { log.debug('tabs', 'chrome:focus', e); }
    });
    // …and the inverse. Clicking a toolbar button leaves focus on that button,
    // so after Reload the keyboard was aimed at the chrome rather than at the
    // page — the next keystroke went nowhere. Every browser hands focus back.
    // Mouse thumb buttons forwarded from a page (see preload.js) — the page view
    // eats WM_APPCOMMAND, so this is how back/forward reach the tab over a page.
    ipcMain.on('nav:mouse', (_e, dir) => {
        try {
            const t = wm.getWindowByWebContents(_e.sender)?.tabs;
            if (!t) return;
            if (dir === 'back') t.goBack(t.activeTabIndex);
            else if (dir === 'forward') t.goForward(t.activeTabIndex);
        }
        catch (e) { log.debug('tabs', 'nav:mouse', e); }
    });
    ipcMain.on('page:focus', (_e) => {
        try {
            const t = wm.getWindowByWebContents(_e.sender)?.tabs;
            const wc = t && t.tabMap.get(t.activeTabIndex)?.webContents;
            if (wc && !wc.isDestroyed())
                wc.focus();
        }
        catch (e) { log.debug('tabs', 'page:focus', e); }
    });
    ipcMain.on('chrome-menu-open', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        const t = wd?.tabs;
        if (!t || t._menuWatch) return;
        const wc = t.tabMap.get(t.activeTabIndex)?.webContents;
        // No active tab (an emptied space) means no page view to steal the
        // pointer, so the renderer's own pointermove/up drive the drag and there
        // is nothing to attach to here.
        if (!wc) return;
        const onInput = (_ev, input) => {
            if (input.type === 'mouseDown' || input.type === 'rawKeyDown')
                try { wd.window.webContents.send('close-chrome-menus'); } catch (e) { log.debug('tabs', 'onInput', e); }
        };
        t._menuWatch = { wc, onInput };
        try { wc.on('input-event', onInput); } catch (e) { log.debug('tabs', 'onInput', e); }
    });
    ipcMain.on('chrome-menu-close', (_e) => {
        const t = wm.getWindowByWebContents(_e.sender)?.tabs;
        if (!t?._menuWatch) return;
        try { t._menuWatch.wc.removeListener('input-event', t._menuWatch.onInput); } catch (e) { log.debug('tabs', 'chrome-menu-close', e); }
        t._menuWatch = null;
    });
    ipcMain.handle('sidebar:resize', (_e, w) => {
        // The renderer drives the drag while the cursor is over the sidebar (the
        // main-process poll takes over once it crosses onto the page). This path
        // must honour the SAME blank-vs-live decision as the poll, or a heavy page
        // resizes live here — laggy, and the view stays shown — before the poll
        // ever runs (the exact "Wikipedia still laggy / shows the view" bug).
        const wd = wm.getWindowByWebContents(_e.sender);
        const t = wd?.tabs;
        if (!t?._sidebarResizing) return;
        const width = clampW(w, wd);
        t._sidebarBlankTab ? applyWidthBlank(wd, width) : applyWidthLive(wd, width);
    });
    ipcMain.handle('sidebar:resize-commit', (_e, w) => {
        endResize(wm.getWindowByWebContents(_e.sender), w);
    });
    // Switch this window to a workspace IN PLACE.
    ipcMain.handle('workspaces:switch', (_e, id) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd)
            wm.switchWorkspace(wd, id);
    });
    ipcMain.handle('workspaces:create', (_e) => {
        const p = profiles.create();
        broadcastProfiles();
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd)
            wm.switchWorkspace(wd, p.id);
        return p;
    });
    // Delete a space: close its tabs, move off it if it is active, then drop the
    // record and wipe its jar. Destructive and not recoverable — the renderer
    // confirms first.
    ipcMain.handle('workspaces:reorder', (_e, ids) => {
        const ok = profiles.reorder(ids);
        if (ok) broadcastProfiles();
        return ok;
    });
    ipcMain.handle('workspaces:delete', (_e, id) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        const key = String(id);
        if (!wd?.tabs || key === '1' || profiles.list().length <= 1)
            return false;
        if (String(wd.tabs.profileId) === key) {
            const other = profiles.list().find(p => p.id !== key);
            if (!other)
                return false;
            wm.switchWorkspace(wd, other.id);
        }
        for (const idx of wd.tabs.tabsInWorkspace(key))
            try { wd.tabs.removeTab(idx); }
            catch (e) { log.debug('tabs', 'workspaces:delete', e); }
        // Folders belonging to the space go with it.
        try {
            wd.tabs.folders = wd.tabs.folders.filter(f => String(f.workspace) !== key);
            wd.tabs.broadcastFolders();
        }
        catch (e) { log.debug('tabs', 'workspaces:delete', e); }
        const ok = profiles.remove(key);
        if (ok)
            broadcastProfiles();
        return ok;
    });
    // Switcher menu: pick a workspace (switches in place), open one in a NEW
    // window, add a workspace, or rename the current one.
    ipcMain.on('profiles:menu', (_e, x, y, targetId) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd)
            return;
        const current = wd.profileId || '1';
        const renameTarget = targetId || current;
        const template = [{ label: 'Workspace', enabled: false }, { type: 'separator' }];
        for (const p of profiles.list()) {
            template.push({
                label: p.name, type: 'checkbox', checked: p.id === current,
                click: () => { if (p.id !== current) wm.switchWorkspace(wd, p.id); },
            });
        }
        template.push({ type: 'separator' }, {
            label: 'New Workspace…',
            click: () => {
                const p = profiles.create();
                broadcastProfiles();
                wm.switchWorkspace(wd, p.id);
                try { wd.window.webContents.send('rename-profile', p.id); } catch (e) { log.debug('tabs', 'profiles:menu', e); } // prompt to name it
            },
        }, {
            label: 'Open in New Window',
            submenu: profiles.list().map(p => ({ label: p.name, click: () => wm.createWindow(1000, 700, { profile: p.id }) })),
        }, {
            label: 'Rename Workspace…',
            click: () => { try { wd.window.webContents.send('rename-profile', renameTarget); } catch (e) { log.debug('tabs', 'profiles:menu', e); } },
        });
        try {
            if (overlayMenu.popup(wd, template, x, y))
                return;
            Menu.buildFromTemplate(template).popup({ window: wd.window, x: Math.round(x), y: Math.round(y) });
        }
        catch (e) { log.debug('tabs', 'profiles:menu', e); }
    });
    // ── Essentials (pinned favourites; per profile) ────────────────────────────
    const broadcastEssentials = () => {
        try {
            for (const w of wm.windows.values())
                w.window?.webContents?.send('essentials-changed');
        }
        catch (e) { log.debug('tabs', 'broadcastEssentials', e); }
    };
    // The Essential's identity — the url it was made from, plus its container.
    const essentialKey = (url, profile) => `${url}|${profile || ''}`;
    ipcMain.handle('essentials:list', (_e) => profiles.essentials(wm.profileOf(_e.sender)));
    ipcMain.handle('essentials:add', (_e, url, title, profile) => {
        if (!/^https?:/i.test(url || '')) return false;
        let label = title;
        if (!label) { try { label = new URL(url).hostname.replace(/^www\./, ''); } catch { label = url; } }
        const ok = profiles.addEssential(wm.profileOf(_e.sender), { url, title: label, profile: profile || null });
        if (ok) {
            // The tab it was made from BECOMES the tile's tab, the way dragging
            // a tab up into a global favourite does. Otherwise you were left with
            // the tab you promoted still in the strip and a tile that opened a
            // second copy of it on the first click.
            try { wm.getWindowByWebContents(_e.sender)?.tabs?.adoptEssentialTab(essentialKey(url, profile), url); }
            catch (e) { log.debug('tabs', 'essentials:add adopt', e); }
            broadcastEssentials();
        }
        return ok;
    });
    // An Essential IS a tab: open it, or return to the one it already owns.
    ipcMain.handle('essentials:open', (_e, url, profile) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd?.tabs || !/^https?:/i.test(url || ''))
            return null;
        const item = profiles.essentials(wm.profileOf(_e.sender))
            .find(x => x.url === url && (x.profile || null) === (profile || null));
        const home = (item && item.home) || url;
        return wd.tabs.openEssential(essentialKey(url, profile), home, profile || null);
    });
    // Take its tab back to its page (creating the tab if it has none).
    ipcMain.handle('essentials:goHome', (_e, url, profile) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd?.tabs)
            return false;
        const item = profiles.essentials(wm.profileOf(_e.sender))
            .find(x => x.url === url && (x.profile || null) === (profile || null));
        const home = (item && item.home) || url;
        return wd.tabs.goHomeEssential(essentialKey(url, profile), home, profile || null);
    });
    // Which page it goes back to. Passing nothing uses the page its tab is on.
    ipcMain.handle('essentials:setHome', (_e, url, profile, home) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        let next = home;
        if (!next && wd?.tabs) {
            // Bindings are keyed by space, so reading the map directly here found
            // nothing and "use this page as its page" quietly did nothing.
            const bound = wd.tabs.essentialTabIndex(essentialKey(url, profile));
            if (bound != null)
                next = wd.tabs.tabUrls.get(bound);
        }
        const ok = profiles.setEssentialHome(wm.profileOf(_e.sender), url, profile || null, next);
        if (ok) broadcastEssentials();
        return ok;
    });
    ipcMain.handle('essentials:rename', (_e, url, profile, title) => {
        const ok = profiles.renameEssential(wm.profileOf(_e.sender), url, profile || null, title);
        if (ok) broadcastEssentials();
        return ok;
    });
    ipcMain.handle('essentials:icon', (_e, url, profile, icon) => {
        const ok = profiles.setEssentialIcon(wm.profileOf(_e.sender), url, profile || null, icon);
        if (ok) broadcastEssentials();
        return ok;
    });
    ipcMain.handle('essentials:remove', (_e, url, profile) => {
        const ok = profiles.removeEssential(wm.profileOf(_e.sender), url, profile || null);
        // Its tab stays open — removing an Essential is not closing a tab — but
        // it has to go back to being an ordinary row, since the strip hides the
        // row of any tab a tile owns and there is no tile left to reach it by.
        if (ok) {
            for (const w of wm.windows.values()) {
                try { w.tabs?.unbindEssential(essentialKey(url, profile)); }
                catch (e) { log.debug('tabs', 'essentials:remove unbind', e); }
            }
        }
        broadcastEssentials();
        return ok;
    });
    // ── Glance: peek a page in a floating preview over the current tab ──────────
    // Alt+click a link in a PAGE — the reference's primary Glance trigger. The
    // sender is the tab's webContents, not the chrome, so resolve its window.
    ipcMain.on('glance:from-page', (_e, url) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd?.tabs && /^https?:/i.test(url || '')) wd.tabs.openGlance(sanitizeUrl(url));
    });
    ipcMain.handle('glance:open', (_e, url) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd?.tabs && url) wd.tabs.openGlance(url);
    });
    ipcMain.handle('glance:close', (_e) => {
        wm.getWindowByWebContents(_e.sender)?.tabs?.closeGlance();
    });
    // The glance header strip's two buttons.
    ipcMain.on('glance:bar-close', (_e) => {
        wm.getWindowByWebContents(_e.sender)?.tabs?.closeGlance();
    });
    ipcMain.on('glance:bar-promote', (_e) => {
        wm.getWindowByWebContents(_e.sender)?.tabs?.promoteGlance();
    });
    // ── Folders (tab groups) ───────────────────────────────────────────────────
    ipcMain.handle('folders:create', (_e, name, parent) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        return wd?.tabs ? wd.tabs.createFolder(name, wd.tabs.profileId, parent) : null;
    });
    ipcMain.handle('folders:rename', (_e, id, name) => { wm.getWindowByWebContents(_e.sender)?.tabs?.renameFolder(id, name); });
    ipcMain.handle('folders:delete', (_e, id) => { wm.getWindowByWebContents(_e.sender)?.tabs?.deleteFolder(id); });
    ipcMain.handle('folders:toggle', (_e, id, collapsed) => { wm.getWindowByWebContents(_e.sender)?.tabs?.toggleFolder(id, collapsed); });
    ipcMain.handle('folders:icon', (_e, id, icon) => { wm.getWindowByWebContents(_e.sender)?.tabs?.setFolderIcon(id, icon); });
    ipcMain.handle('tab:split', (_e, index, position) => {
        wm.getWindowByWebContents(_e.sender)?.tabs?.splitWithActive(Number(index), position || 'right');
    });
    ipcMain.handle('tab:closeSplit', (_e) => {
        wm.getWindowByWebContents(_e.sender)?.tabs?.closeSplit();
    });
    // ── Split view: divider resize, pane reposition, drop zones ───────────────
    // The divider is a thin overlay view, so the pointer is over a PAGE view for
    // all but the first pixel of the drag. Same trick as the sidebar resizer:
    // watch the panes' raw input streams and drive the ratio from there.
    function endSplitResize(t) {
        if (!t?._splitResize)
            return;
        for (const { wc, onInput } of t._splitResize)
            try { wc.removeListener('input-event', onInput); } catch (e) { log.debug('tabs', 'endSplitResize', e); }
        t._splitResize = null;
    }
    ipcMain.on('split:resize-start', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        const t = wd?.tabs;
        if (!t?.splitPair)
            return;
        endSplitResize(t);
        const hooks = [];
        t.splitPair.forEach((idx, i) => {
            const wc = t.tabMap.get(idx)?.webContents;
            if (!wc)
                return;
            // input.x/y are relative to that pane's own top-left corner — and the
            // pane moves as the ratio changes, so re-read its bounds every event.
            const onInput = (_ev, input) => {
                if (input.type === 'mouseMove') {
                    const pane = t._splitHalves()[i];
                    const page = t.getTabBounds();
                    const r = t.splitOrient === 'col'
                        ? (pane.y + input.y - page.y) / Math.max(1, page.height)
                        : (pane.x + input.x - page.x) / Math.max(1, page.width);
                    t.setSplitRatio(r);
                }
                else if (input.type === 'mouseUp' || input.type === 'mouseLeave') {
                    endSplitResize(t);
                }
            };
            try { wc.on('input-event', onInput); } catch (e) { log.debug('tabs', 'onInput', e); }
            hooks.push({ wc, onInput });
        });
        t._splitResize = hooks.length ? hooks : null;
    });
    ipcMain.on('split:resize-end', (_e) => {
        endSplitResize(wm.getWindowByWebContents(_e.sender)?.tabs);
    });
    ipcMain.on('split:move', (_e, pane, dir) => {
        wm.getWindowByWebContents(_e.sender)?.tabs?.moveSplitPane(Number(pane), dir);
    });
    // A tab drag released over the page card (the chrome never sees that release
    // — the drop overlay does).
    ipcMain.on('split-drop:drop', (_e, zone) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd?.tabs)
            return;
        wd.tabs.handleSplitDrop(zone);
        try { wd.window.webContents.send('tab-drag-ended'); } catch (e) { log.debug('tabs', 'split-drop:drop', e); }
    });
    ipcMain.handle('tab:reopenClosed', (_e) => { wm.getWindowByWebContents(_e.sender)?.tabs?.reopenClosedTab(); });
    ipcMain.handle('sidebar:toggleCompact', (_e) => { wm.getWindowByWebContents(_e.sender)?.tabs?.toggleCompact(); });
    ipcMain.handle('folders:assign', (_e, index, folderId) => { wm.getWindowByWebContents(_e.sender)?.tabs?.setTabFolder(index, folderId); });
    ipcMain.handle('tab:setHome', (_e, index, url) => wm.getWindowByWebContents(_e.sender)?.tabs?.setPinnedHome(index, url) || false);
    ipcMain.handle('tab:resetPinned', (_e, index) => wm.getWindowByWebContents(_e.sender)?.tabs?.resetPinnedTab(index) || false);
    ipcMain.handle('tab:getHome', (_e, index) => wm.getWindowByWebContents(_e.sender)?.tabs?.pinnedHome.get(Number(index)) || '');
    ipcMain.handle('tab:unload', (_e, index) => wm.getWindowByWebContents(_e.sender)?.tabs?.unloadTab(index) || false);
    ipcMain.handle('tab:unloadWorkspace', (_e, ws) => wm.getWindowByWebContents(_e.sender)?.tabs?.unloadWorkspace(ws) || 0);
    ipcMain.handle('tab:setIcon', (_e, index, icon) => {
        wm.getWindowByWebContents(_e.sender)?.tabs?.setTabIcon(index, icon);
    });
    ipcMain.handle('tab:setLabel', (_e, index, label) => {
        wm.getWindowByWebContents(_e.sender)?.tabs?.setTabLabel(index, label);
    });
    ipcMain.handle('folders:reorder', (_e, ids) => { wm.getWindowByWebContents(_e.sender)?.tabs?.reorderFolders(ids); });
    ipcMain.handle('folders:move', (_e, id, workspace) => { wm.getWindowByWebContents(_e.sender)?.tabs?.moveFolderToWorkspace(id, workspace); });
    ipcMain.handle('folders:reparent', (_e, id, parent) => { wm.getWindowByWebContents(_e.sender)?.tabs?.reparentFolder(id, parent); });
    // ── Containers as Space Profiles ───────────────────────────────────────────
    ipcMain.handle('containers:listNamed', (_e) => {
        const containers = require('../features/containers');
        return containers.listNamed();
    });
    ipcMain.handle('containers:remove', (_e, id) => {
        const containers = require('../features/containers');
        // Any space bound to this container would be left pointing at a jar that
        // no longer exists — unbind them back to their own storage first.
        let unbound = 0;
        for (const p of profiles.list()) {
            if (String(p.container) === String(id)) {
                profiles.update(p.id, { container: null });
                unbound++;
            }
        }
        const ok = containers.remove(String(id));
        if (unbound) broadcastProfiles();
        return ok;
    });
    ipcMain.handle('containers:createNamed', (_e, name) => {
        const containers = require('../features/containers');
        return containers.createNamed(name);
    });
    ipcMain.handle('folders:list', (_e) => {
        const t = wm.getWindowByWebContents(_e.sender)?.tabs;
        if (!t) return { folders: [], assignments: [] };
        const folders = t.foldersForWorkspace(t.profileId).map(f => ({ ...f }));
        const ids = new Set(folders.map(f => f.id));
        const assignments = [...t.tabFolders.entries()].filter(([idx, fid]) => t.tabMap.has(idx) && ids.has(fid));
        return { folders, assignments };
    });
    // ── Profile naming (optional rename; auto-numbered by default) ─────────────
    // id → current display name, used to label container-tagged entries
    // (a rename reflects everywhere without rewriting stored entries).
    ipcMain.handle('goBack', (_e, index) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd)
            wd.tabs.goBack(index);
    });
    ipcMain.handle('goForward', (_e, index) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd)
            wd.tabs.goForward(index);
    });
    ipcMain.handle('reload', (_e, index) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd)
            wd.tabs.reload(index);
    });
    ipcMain.handle('stopTab', (_e, index) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        const tab = wd?.tabs?.tabMap.get(index);
        if (tab) {
            try {
                tab.webContents.stop();
            }
            catch (e) { log.debug('tabs', 'stopTab', e); }
        }
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
        if (wd && wd.tabs) {
            wd.tabs.pinTab(index);
            return true;
        }
        return false;
    });
    // Speaker icon on a tab → toggle that tab's audio.
    ipcMain.handle('muteTab', (_e, index) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd && wd.tabs) {
            wd.tabs.muteTab(index);
            return true;
        }
        return false;
    });
    ipcMain.handle('reorderTabs', (_e, order) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd && wd.tabs) {
            wd.tabs.reorderTabs(order);
            return true;
        }
        return false;
    });
    // Long-press / right-click on back-forward buttons: show the tab's full
    // navigation stack (newest first, current entry checked) as a native menu.
    ipcMain.handle('show-nav-history-menu', (_e, index, x, y) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd?.tabs)
            return false;
        const h = wd.tabs.navigationHistory.getHistory(index);
        if (!h || !Array.isArray(h.entries) || h.entries.length < 2)
            return false;
        const template = [...h.entries].reverse().map(entry => ({
            // Prefer the page title (some browsers show titles in this list); fall
            // back to a compact host/path label when the title isn't known yet.
            label: entry.title || navEntryLabel(entry.data),
            type: 'checkbox',
            checked: entry.index === h.currentIndex,
            enabled: entry.index !== h.currentIndex,
            click: () => { try {
                wd.tabs.goToHistoryIndex(index, entry.index);
            }
            catch (e) { log.debug('tabs', 'show-nav-history-menu', e); } },
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
        if (!wd?.tabs)
            return false;
        const idx = (typeof index === 'number') ? index : wd.tabs.activeTabIndex;
        wd.tabs.toggleReader(idx);
        return true;
    });
    // Served to the reader page: find which tab this webContents is, return its article.
    ipcMain.handle('reader-get-article', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd?.tabs)
            return null;
        for (const [idx, tab] of wd.tabs.tabMap) {
            if (tab?.webContents === _e.sender)
                return wd.tabs.getReaderArticle(idx);
        }
        return null;
    });
    // Called from the reader page's own "close" button. Guarded so it only ever
    // exits an active reader view (a normal page calling this is a no-op).
    ipcMain.handle('reader-exit', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd?.tabs)
            return false;
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
        if (!wd?.tabs)
            return false;
        const idx = (typeof index === 'number') ? index : wd.tabs.activeTabIndex;
        wd.tabs.togglePictureInPicture(idx);
        return true;
    });
    // ── Menu actions (find / print / zoom on the active tab) ──────────────────
    const activeTabOf = (wd) => wd?.tabs ? (wd.tabs.tabMap.get(wd.tabs.activeTabIndex) || null) : null;
    ipcMain.handle('menu-find', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        const tab = activeTabOf(wd);
        if (tab && wd.tabs.findDialog) {
            try {
                wd.tabs.findDialog.show(tab);
            }
            catch (e) { log.debug('tabs', 'menu-find', e); }
            return true;
        }
        return false;
    });
    ipcMain.handle('menu-print', (_e) => {
        const tab = activeTabOf(wm.getWindowByWebContents(_e.sender));
        if (tab) {
            try {
                tab.webContents.print();
            }
            catch (e) { log.debug('tabs', 'menu-print', e); }
        }
        return true;
    });
    /* Save the page you are on, as a complete document (the html plus the
       resources it needs) so it opens offline. Electron asks for the path
       itself, so there is no dialog to build here. */
    ipcMain.handle('menu-save-page', async (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        const tab = activeTabOf(wd);
        if (!tab)
            return false;
        const { dialog } = require('electron');
        let name = 'page';
        try { name = (new URL(tab.webContents.getURL()).hostname || 'page').replace(/^www\./, ''); }
        catch (e) { log.debug('tabs', 'menu-save-page name', e); }
        try {
            const r = await dialog.showSaveDialog(wd.window, {
                title: 'Save page as',
                defaultPath: name + '.html',
                filters: [{ name: 'Web page, complete', extensions: ['html'] }],
            });
            if (r.canceled || !r.filePath)
                return false;
            await tab.webContents.savePage(r.filePath, 'HTMLComplete');
            return true;
        }
        catch (e) {
            log.warn('tabs', 'could not save the page', e);
            return false;
        }
    });
    ipcMain.handle('menu-zoom', (_e, dir) => {
        const tab = activeTabOf(wm.getWindowByWebContents(_e.sender));
        if (!tab)
            return 100;
        const wc = tab.webContents;
        try {
            if (dir !== 'get') {
                let level = wc.getZoomLevel();
                if (dir === 'in')
                    level = Math.min(5, level + 0.5);
                else if (dir === 'out')
                    level = Math.max(-3, level - 0.5);
                else
                    level = 0; // reset
                wc.setZoomLevel(level);
                // Remember it for this site (never for private tabs).
                const idx = wd.tabs.activeTabIndex;
                zoom.remember(wd.tabs.tabUrls.get(idx) || '', level,
                    !wd.tabs.privateTabs.has(idx) && !wd.tabs.isPrivateWindow);
            }
            return Math.round(wc.getZoomFactor() * 100);
        }
        catch {
            return 100;
        }
    });
    // ── Navigation helpers (used by history / bookmarks pages) ───────────────
    ipcMain.handle('navigate-active-tab', (_e, url) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd)
            return false;
        wd.tabs.loadUrl(wd.tabs.activeTabIndex, sanitizeUrl(url));
        return true;
    });
    ipcMain.handle('active-tab-go-back', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd)
            return false;
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
            if (typeof origin !== 'string' || !/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin))
                return;
            const n = (preconnectCounts.get(e.sender.id) || 0) + 1;
            if (n > 60)
                return;
            if (n === 1)
                e.sender.once('destroyed', () => preconnectCounts.delete(e.sender.id));
            preconnectCounts.set(e.sender.id, n);
            e.sender.session.preconnect({ url: origin, numSockets: 1 });
        }
        catch (e) { log.debug('tabs', 'n', e); }
    });
    // ── Omnibox preconnect ─────────────────────────────────────────────────────
    // The chrome reports the highlighted URL suggestion's origin; warm it on the
    // ACTIVE tab's session (where the navigation will land) so Enter starts hot.
    // Skips private tabs so browsing intent for a private tab never touches the
    // network before the user commits. Origin-only — no path or query string.
    const omniboxPreconnectCounts = new Map(); // chrome wc.id → count
    ipcMain.on('omnibox-preconnect', (e, origin) => {
        try {
            if (typeof origin !== 'string' || !/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin))
                return;
            const wd = wm.getWindowByWebContents(e.sender);
            if (!wd?.tabs)
                return;
            const idx = wd.tabs.activeTabIndex;
            // Never pre-warm from a private tab, or a whole private window.
            if (wd.tabs.isPrivateWindow || wd.tabs.privateTabs?.has?.(idx))
                return;
            const n = (omniboxPreconnectCounts.get(e.sender.id) || 0) + 1;
            if (n > 120)
                return; // per chrome-window lifetime budget
            if (n === 1)
                e.sender.once('destroyed', () => omniboxPreconnectCounts.delete(e.sender.id));
            omniboxPreconnectCounts.set(e.sender.id, n);
            const active = wd.tabs.tabMap.get(idx);
            const sess = active?.webContents?.session || e.sender.session;
            sess.preconnect({ url: origin, numSockets: 1 });
        }
        catch (err) { log.debug('tabs', 'omnibox-preconnect', err); }
    });
    // ── Persistence mode ─────────────────────────────────────────────────────
    ipcMain.handle('getPersistMode', () => {
        return wm.persistence.getPersistMode();
    });
    ipcMain.handle('setPersistMode', (_e, enabled) => {
        wm.persistence.setPersistMode(!!enabled);
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd && wd.tabs) {
            try {
                wd.tabs.saveStateDebounced();
            }
            catch (e) { log.debug('tabs', 'setPersistMode', e); }
        }
        return true;
    });
    // ── Tab drag / drop across windows ───────────────────────────────────────
    ipcMain.handle('get-this-window-id', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        return wd ? wd.id : null;
    });
    // ── Tab drag (nothing moves until RELEASE) ────────────────
    // While a tab is dragged outside its strip, the main process only tracks
    // the cursor: it raises the window under the pointer (so the user can see
    // the drop target) and highlights that window's strip. The actual move /
    // detach happens on drop. Escape in the renderer aborts everything.
    const MERGE_STRIP_H = 48; // top region of a window that counts as its tab strip
    let dragTrack = null; // { timer, raisedId, hoverTarget }
    let lastRaisedId = null; // kept for get-window-at-point tie-breaking
    const windowAtCursor = (p, excludeId) => {
        const matches = wm.getAllWindows().filter(w => {
            if (w.id === excludeId || w.window.isDestroyed() || w.window.isMinimized())
                return false;
            const b = w.window.getBounds();
            return p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
        });
        // getAllWindows() is creation order, not z-order. When windows overlap,
        // prefer the one we raised under the cursor — it's the one the user sees.
        return matches.find(w => w.id === lastRaisedId) || matches[0] || null;
    };
    // Which edge of a window's page card a screen point falls in — the same
    // thirds rule the drop sheet paints with (EDGE in renderer/SplitDrop/drop.js).
    // null = the middle, i.e. no split.
    const DROP_EDGE = 0.32;
    const cardPointIn = (wd, p) => {
        try {
            const cb = wd.window.getContentBounds();
            const card = wd.tabs.getTabBounds();
            const x = p.x - cb.x - card.x, y = p.y - cb.y - card.y;
            if (x < 0 || y < 0 || x > card.width || y > card.height)
                return null;
            return { fx: x / Math.max(1, card.width), fy: y / Math.max(1, card.height) };
        }
        catch {
            return null;
        }
    };
    const edgeZone = (f) => {
        if (!f)
            return null;
        const d = { left: f.fx, right: 1 - f.fx, top: f.fy, bottom: 1 - f.fy };
        let best = 'left';
        for (const k of Object.keys(d))
            if (d[k] < d[best])
                best = k;
        return d[best] <= DROP_EDGE ? best : null;
    };
    /**
     * Move a dragged tab into `target` (another window) and, if it was dropped on
     * an edge, split it against the page that window was showing.
     */
    const moveIntoWindow = (src, tabIndex, target, url, zone) => {
        const prevActive = target.tabs.activeTabIndex;
        const idx = target.tabs.createTab(null, true);
        if (url)
            target.tabs.loadUrl(idx, url);
        src.tabs.removeTab(tabIndex); // closes the source window if it was its last tab
        if (zone && target.tabs.tabMap.has(prevActive))
            target.tabs.splitWithActive(prevActive, zone);
        try {
            target.window.focus();
            target.window.moveTop();
        }
        catch (e) { log.debug('tabs', 'moveIntoWindow', e); }
        return 'moved';
    };
    const setMergeHover = (wd, on) => {
        try {
            if (wd && !wd.window.isDestroyed())
                wd.window.webContents.send('tab-merge-hover', !!on);
        }
        catch (e) { log.debug('tabs', 'setMergeHover', e); }
    };
    const stopDragTrack = () => {
        if (!dragTrack)
            return;
        clearInterval(dragTrack.timer);
        if (dragTrack.hoverTarget)
            setMergeHover(dragTrack.hoverTarget, false);
        if (dragTrack.cardTarget)
            try { dragTrack.cardTarget.tabs.hideSplitDrop(); } catch (e) { log.debug('tabs', 'stopDragTrack', e); }
        dragTrack = null;
    };
    ipcMain.on('tab-drag-track', (_e, on, tabIndex) => {
        const wd0 = wm.getWindowByWebContents(_e.sender);
        if (!on) {
            stopDragTrack();
            wd0?.tabs?.hideSplitDrop();
            return;
        }
        // Catch the drag the moment it leaves the strip for the page card: the
        // page is a native view, so only an overlay of our own can see it there.
        try { wd0?.tabs?.showSplitDrop(Number(tabIndex)); }
        catch (e) { log.debug('tabs', 'tab-drag-track', e); }
        if (dragTrack)
            return;
        const srcWd = wd0;
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
                        try {
                            if (srcWd && !srcWd.window.isDestroyed())
                                srcWd.window.moveTop();
                        }
                        catch (e) { log.debug('tabs', 'tab-drag-track', e); }
                    }
                    // Highlight the strip we'd drop into (other windows only).
                    const overStrip = over && over !== srcWd && p.y <= over.window.getBounds().y + MERGE_STRIP_H;
                    const hoverTarget = overStrip ? over : null;
                    if (hoverTarget !== dragTrack.hoverTarget) {
                        if (dragTrack.hoverTarget)
                            setMergeHover(dragTrack.hoverTarget, false);
                        if (hoverTarget)
                            setMergeHover(hoverTarget, true);
                        dragTrack.hoverTarget = hoverTarget;
                    }
                    // Over ANOTHER window's page card: that window's sheet can't
                    // see the pointer (the drag belongs to the source window), so
                    // drive its highlight from this poll instead.
                    const f = (over && over !== srcWd && !overStrip) ? cardPointIn(over, p) : null;
                    const cardTarget = f ? over : null;
                    if (dragTrack.cardTarget && dragTrack.cardTarget !== cardTarget)
                        try { dragTrack.cardTarget.tabs.hideSplitDrop(); } catch (e) { log.debug('tabs', 'f', e); }
                    dragTrack.cardTarget = cardTarget;
                    if (cardTarget)
                        try { cardTarget.tabs.hintSplitDrop(edgeZone(f)); } catch (e) { log.debug('tabs', 'f', e); }
                }
                catch (e) { log.debug('tabs', 'f', e); }
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
        src?.tabs?.hideSplitDrop();
        if (!src)
            return 'none';
        try {
            const p = screen.getCursorScreenPoint();
            const target = hovered || windowAtCursor(p);
            const safeUrl = url && url !== 'newtab' ? sanitizeUrl(url) : null;
            // ── Drop on ANOTHER window's tab strip → move the tab there ──────
            const onStrip = hovered ? true
                : (target && p.y <= target.window.getBounds().y + MERGE_STRIP_H);
            if (target && target.id !== src.id && onStrip) {
                // Ask the target chrome where the cursor lands in its strip so
                // the tab is inserted AT the drop position.
                let insertAfter = null;
                try {
                    const tb = target.window.getBounds();
                    insertAfter = await target.window.webContents.executeJavaScript(`window.__tabDropIndex ? window.__tabDropIndex(${Math.round(p.x - tb.x)}) : null`, true);
                }
                catch (e) { log.debug('tabs', 'hovered', e); }
                const idx = target.tabs.createTab(Number.isInteger(insertAfter) ? insertAfter : null, true);
                if (safeUrl)
                    target.tabs.loadUrl(idx, safeUrl);
                src.tabs.removeTab(tabIndex); // closes the source window if it was the last tab
                setMergeHover(target, false);
                try {
                    target.window.focus();
                    target.window.moveTop();
                }
                catch (e) { log.debug('tabs', 'hovered', e); }
                return 'moved';
            }
            // ── Drop on THIS window's own page card → split ──────────────────
            // Normally the drop sheet over the card reports that release itself;
            // this is the fallback for when the chrome sees it instead (event
            // routing between the chrome and the native page views is the
            // platform's call). The timestamp keeps the two from both firing.
            if (target && target.id === src.id && Date.now() - (src.tabs._splitDropAt || 0) > 400) {
                const f = cardPointIn(src, p);
                if (f) {
                    src.tabs.hideSplitDrop();
                    src.tabs.splitDropped(tabIndex, edgeZone(f));
                    return 'split';
                }
            }
            // ── Drop on ANOTHER window's page card → move the tab there ──────
            // Dropped on an edge it splits against that window's current page,
            // dropped in the middle it just joins as a tab. (The release is
            // delivered to the source window — a drag keeps its origin window —
            // so this side resolves it; the target only showed the hint sheet.)
            if (target && target.id !== src.id) {
                const f = cardPointIn(target, p);
                if (f) {
                    target.tabs.hideSplitDrop();
                    setMergeHover(target, false);
                    return moveIntoWindow(src, tabIndex, target, safeUrl, edgeZone(f));
                }
            }
            // ── Drop anywhere else → detach into its own window ──────────────
            if (src.tabs.tabMap.size <= 1) {
                // Only tab: the "detached window" is just the source window moved.
                const b = src.window.getBounds();
                src.window.setBounds({ x: Math.round(p.x - 140), y: Math.round(p.y - 20), width: b.width, height: b.height });
                try {
                    src.window.focus();
                }
                catch (e) { log.debug('tabs', 'hovered', e); }
                return 'window-moved';
            }
            const newWin = wm.createWindow(900, 640);
            newWin.window.setBounds({ x: Math.round(p.x - 140), y: Math.round(p.y - 20), width: 900, height: 640 });
            if (safeUrl) {
                newWin.window.webContents.once('did-finish-load', () => {
                    try {
                        if (newWin.window.isDestroyed())
                            return;
                        const firstIdx = Array.from(newWin.tabs.tabMap.keys())[0];
                        if (firstIdx !== undefined)
                            newWin.tabs.loadUrl(firstIdx, safeUrl);
                    }
                    catch (e) { log.debug('tabs', 'hovered', e); }
                });
            }
            src.tabs.removeTab(tabIndex);
            try {
                newWin.window.focus();
            }
            catch (e) { log.debug('tabs', 'hovered', e); }
            return 'detached';
        }
        catch (err) {
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
        if (!matches.length)
            return null;
        if (matches.length === 1)
            return { id: matches[0].id };
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
        if (focused)
            return { id: focused.id };
        for (let i = BrowserWindow.getAllWindows().length - 1; i >= 0; i--) {
            const bw = BrowserWindow.getAllWindows()[i];
            const match = matches.find(w => w.window === bw);
            if (match && bw.isVisible() && !bw.isMinimized())
                return { id: match.id };
        }
        return { id: matches[0].id };
    });
    ipcMain.handle('move-tab-to-window', async (_e, fromId, tabIndex, targetId, url) => {
        const src = wm.getWindowById(fromId);
        const dst = wm.getWindowById(targetId);
        if (!src || !dst)
            return false;
        try {
            // Carry the tab's identity across: container (shared session, so the
            // jar is preserved) and private flag stay with the tab.
            const containerId = src.tabs.tabContainers.get(tabIndex) || null;
            const isPrivate = src.tabs.privateTabs.has(tabIndex);
            const idx = dst.tabs.createTab(null, true, isPrivate, containerId);
            if (url && url !== 'newtab')
                dst.tabs.loadUrl(idx, sanitizeUrl(url));
            src.tabs.removeTab(tabIndex);
            // The tab now lives in the destination window — focus follows it
            // (most browsers do the same), otherwise the move looks like nothing
            // happened when the destination sits behind the source.
            try {
                dst.window.focus();
                dst.window.moveTop();
            }
            catch (e) { log.debug('tabs', 'move-tab-to-window', e); }
            return true;
        }
        catch (err) {
            console.error('move-tab-to-window:', err);
            return false;
        }
    });
    ipcMain.handle('detach-to-new-window', async (_e, tabIndex, screenX, screenY, url) => {
        const src = wm.getWindowByWebContents(_e.sender);
        if (!src)
            return false;
        try {
            const { x, y } = dropPoint(screenX, screenY);
            const containerId = src.tabs.tabContainers.get(tabIndex) || null;
            const isPrivate = src.tabs.privateTabs.has(tabIndex);
            const newWin = wm.createWindow(800, 600);
            newWin.window.setBounds({
                x: Math.max(0, Math.floor(x - 400)),
                y: Math.max(0, Math.floor(y - 300)),
                width: 800, height: 600,
            });
            const safeUrl = (url && url !== 'newtab') ? sanitizeUrl(url) : null;
            newWin.window.webContents.once('did-finish-load', () => {
                try {
                    if (newWin.window.isDestroyed())
                        return;
                    // Detached tab keeps its container/private identity: open a
                    // matching tab and drop the window's default one.
                    if (containerId || isPrivate) {
                        const firstIdx = Array.from(newWin.tabs.tabMap.keys())[0];
                        const idx = newWin.tabs.createTab(null, true, isPrivate, containerId);
                        if (safeUrl)
                            newWin.tabs.loadUrl(idx, safeUrl);
                        if (firstIdx !== undefined && firstIdx !== idx)
                            newWin.tabs.removeTab(firstIdx);
                    }
                    else if (safeUrl) {
                        const firstIdx = Array.from(newWin.tabs.tabMap.keys())[0];
                        if (firstIdx !== undefined)
                            newWin.tabs.loadUrl(firstIdx, safeUrl);
                    }
                }
                catch (e) { log.debug('tabs', 'safeUrl', e); }
            });
            src.tabs.removeTab(tabIndex);
            return true;
        }
        catch (err) {
            console.error('detach-to-new-window:', err);
            return false;
        }
    });
    // Fallback favicon loader for the tab strip — used when the renderer's own
    // <img src=faviconUrl> fails to load (see renderer setFaviconFallback).
    ipcMain.handle('favicon-fetch', (_e, url) => fetchFaviconDataUrl(url));
    // Cached favicon for a host (from sites you've visited) — NO network fetch.
    // Used for omnibox suggestions / bookmarks so typing can't fire a favicon
    // request to every suggested domain.
    ipcMain.handle('favicon-cached', (_e, host) => faviconStore.getForHost(host));
}

module.exports = { register };