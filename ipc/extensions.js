/**
 * IPC handlers — extension management (Settings page).
 *
 * Browser-action buttons/popups are handled by the <browser-action-list>
 * element (electron-chrome-extensions), not here.
 */
const log = require('../features/log');
const path = require('path');
const { dialog, WebContentsView } = require('electron');
const { signalEnter, playOutThenHide } = require('./../features/overlay-anim');
const { resolveAppFile } = require('../app-paths');
const extensions = require('../features/extensions');
const WEB_STORE_URL = 'https://chromewebstore.google.com/';
// ── Toolbar panel (puzzle icon) — same overlay pattern as the downloads panel ──
const { panelBounds, PANEL_RADIUS, W_MD } = require('../features/overlay-bounds');
const { isTrustedInternalSender } = require('../features/ipc-guard');
const PANEL_WIDTH = W_MD;
// Mirrors renderer/ExtensionsPanel/styles.css + the shared panel anatomy: a
// --bar-h head, a --row-h foot over its divider, two-line rows, and an empty
// state that needs more than one row's worth of room to read as a sentence.
const HEAD_H = 48;
const FOOT_H = 41;
const ITEM_H = 58;
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
    try { view.setBorderRadius(PANEL_RADIUS) } catch (e) { log.debug('extensions', 'if', e); }
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
    wd.extensionsPanelOpen = false;
    // Fade the card out (P1-6), then hide the view and tell the chrome.
    playOutThenHide(wd.extensionsPanel, () => {
        try { wd.window.webContents.send('extensions-panel-closed'); }
        catch (e) { log.debug('extensions', 'hidePanel', e); }
    });
    return true;
}
/**
 * Gap-layer handlers (see preload/ext-polyfill.js).
 *
 * These serve TWO kinds of caller and the difference matters:
 *   - extension service workers, whose IPC router is their own (a worker's
 *     messages never reach the global ipcMain), so handlers are attached per
 *     worker as it starts;
 *   - extension PAGES (popups, options, MV2 backgrounds), which are ordinary
 *     renderers on the global ipcMain. A content blocker's popup toggling
 *     per-site rules goes through this path.
 *
 * Everything below is parameterised by a small context object so one set of
 * implementations covers both.
 */
// Worker registry + event fan-out live in features/ext-events.js, because the
// browser's own mutation sites (Tabs.addToHistory, the bookmark handlers) have
// to drive these events too — not just extension-initiated changes.
const extEvents = require('../features/ext-events');
// One line per missing API, so the next gap is named in the log rather than
// surfacing as a mystery failure inside the extension. Where a working
// alternative exists, name it — the developer reading this log is the person
// who can act on it.
const GAP_HINTS = {
    'chrome.identity.getAuthToken': 'use chrome.identity.launchWebAuthFlow, which is implemented',
    'chrome.tabCapture.capture': 'use chrome.tabCapture.getMediaStreamId with getUserMedia',
};
const seenGaps = new Set();
function logGap({ id, api } = {}) {
    const key = `${id}:${api}`;
    if (seenGaps.has(key))
        return;
    seenGaps.add(key);
    const hint = GAP_HINTS[api];
    console.warn(`[extensions] ${id} needs ${api}, which this browser does not implement`
        + (hint ? ` — ${hint}` : ''));
}
const broadcastToWorkers = (channel, data) => extEvents.broadcast(channel, data);

/**
 * Install the gap handlers onto one transport.
 * ctx = { handle, extIdOf, profileIdOf, wm }
 */
function installGapHandlers(ctx) {
    const { handle, extIdOf, profileIdOf, wm } = ctx;
    const { webContents } = require('electron');
    // electron-chrome-extensions uses the webContents id as the chrome tab id.
    const tabWcById = (id) => {
        if (id == null) return null;
        try { return webContents.fromId(Number(id)) || null; }
        catch { return null; }
    };
    const needId = (e) => {
        const id = extIdOf(e);
        if (!id)
            throw new Error('cannot identify the calling extension');
        return id;
    };

    // ── chrome.windows, when the browser has no tabs ─────────────────────────
    // electron-chrome-extensions learns about a window only through addTab(),
    // so a window with NO tabs does not exist as far as extensions are
    // concerned: windows.getCurrent() answers null and getAll() answers []. The
    // browser opens with no tabs, so a password manager asking for the current
    // window at startup got null and its background script died on `.id`.
    //
    // These describe the real windows in the same shape and with the same ids
    // the library uses (Electron's BrowserWindow.id), so the two agree once
    // tabs do exist — the polyfill only falls back when the library is empty.
    const windowDetails = (wd) => {
        const win = wd?.window;
        if (!win || win.isDestroyed())
            return null;
        const [left, top] = win.getPosition();
        const [width, height] = win.getSize();
        let state = 'normal';
        if (win.isMinimized()) state = 'minimized';
        else if (win.isMaximized()) state = 'maximized';
        else if (win.isFullScreen()) state = 'fullscreen';
        return {
            id: win.id,
            focused: win.isFocused(),
            top, left, width, height,
            incognito: !!wd.private,
            type: 'normal',
            state,
            alwaysOnTop: win.isAlwaysOnTop(),
            tabs: [],
            sessionId: 'default',
        };
    };
    const allWindowDetails = () => {
        const out = [];
        for (const wd of (wm.windows?.values?.() || []))
            { const d = windowDetails(wd); if (d) out.push(d); }
        return out;
    };
    handle('ext:windows.getAll', () => allWindowDetails());
    handle('ext:windows.getCurrent', () => {
        const wd = wm.getMostRecentlyFocusedWindow?.() || wm.getPrimaryWindow?.();
        return windowDetails(wd) || allWindowDetails()[0] || null;
    });

    // ── chrome.tabCapture ────────────────────────────────────────────────────
    handle('ext:getMediaStreamId', (_e, { targetTabId, consumerTabId } = {}) => {
        // Chrome hands back an id the CONSUMER can pass to getUserMedia with
        // chromeMediaSource:'tab'. Electron's equivalent is target.getMediaSourceId
        // (requestWebContents), so both ends have to resolve to real contents.
        const primary = wm.getPrimaryWindow?.();
        const target = tabWcById(targetTabId)
            || primary?.tabs?.tabMap?.get(primary?.tabs?.activeTabIndex)?.webContents;
        if (!target)
            throw new Error('tabCapture: no target tab');
        // A service-worker IPC event has no .sender, so resolve the consumer
        // ourselves: the extension's own page (its offscreen document is what
        // calls getUserMedia), else the chrome window.
        const id = extIdOf(_e);
        const origin = id ? `chrome-extension://${id}` : '';
        const consumer = tabWcById(consumerTabId)
            || (origin ? webContents.getAllWebContents().find(w => {
                try { return w.getURL().startsWith(origin); }
                catch { return false; }
            }) : null)
            || primary?.window?.webContents;
        if (!consumer)
            throw new Error('tabCapture: no consumer context');
        try { return target.getMediaSourceId(consumer); }
        catch (err) { throw new Error('tabCapture: ' + err.message); }
    });

    // ── chrome.declarativeNetRequest ─────────────────────────────────────────
    // Chromium exposes DNR inside Electron but never enforces it (see the note
    // in preload/ext-polyfill.js), so the polyfill overrides the native surface
    // and every call lands here instead.
    const dnr = require('../features/dnr');
    handle('ext:dnr.updateRules', (_e, { kind, removeRuleIds, addRules } = {}) => dnr.updateRules(needId(_e), { removeRuleIds, addRules }, kind === 'session' ? 'session' : 'dynamic'));
    handle('ext:dnr.getRules', (_e, { kind } = {}) => dnr.getRules(needId(_e), kind === 'session' ? 'session' : 'dynamic'));
    handle('ext:dnr.updateEnabledRulesets', (_e, o = {}) => dnr.updateEnabledRulesets(needId(_e), o));
    handle('ext:dnr.getEnabledRulesets', (_e) => dnr.getEnabledRulesets(needId(_e)));
    handle('ext:dnr.getAvailableStaticRuleCount', (_e) => dnr.getAvailableStaticRuleCount(needId(_e)));
    handle('ext:dnr.getMatchedRules', (_e, { filter } = {}) => dnr.getMatchedRules(needId(_e), filter));
    handle('ext:dnr.testMatchOutcome', (_e, { request } = {}) => dnr.testMatchOutcome(needId(_e), request || {}));
    handle('ext:dnr.isRegexSupported', (_e, { regex, isCaseSensitive } = {}) => dnr.isRegexSupported(regex, isCaseSensitive));

    // ── chrome.history ───────────────────────────────────────────────────────
    // Our store keeps one entry per URL (most recent visit), so visitCount and
    // the per-visit list are single-visit approximations rather than fabricated.
    const historyStore = (e) => wm.historyFor(profileIdOf(e));
    const toHistoryItem = (e) => ({
        id: e.url,
        url: e.url,
        title: e.title || '',
        lastVisitTime: Date.parse(e.timestamp || 0) || 0,
        visitCount: 1,
        typedCount: 0,
    });
    handle('ext:history.search', async (_e, { text, startTime, endTime, maxResults } = {}) => {
        const all = await historyStore(_e).loadHistory();
        const q = String(text || '').toLowerCase();
        const rows = all.filter((row) => {
            if (q && !(row.url || '').toLowerCase().includes(q) && !(row.title || '').toLowerCase().includes(q))
                return false;
            const t = Date.parse(row.timestamp || 0) || 0;
            if (startTime && t < startTime)
                return false;
            if (endTime && t > endTime)
                return false;
            return true;
        });
        return rows.slice(0, maxResults || 100).map(toHistoryItem);
    });
    handle('ext:history.getVisits', async (_e, { url } = {}) => {
        const all = await historyStore(_e).loadHistory();
        const hit = all.find(r => r.url === url);
        if (!hit)
            return [];
        return [{
                id: url,
                visitId: url,
                visitTime: Date.parse(hit.timestamp || 0) || 0,
                referringVisitId: '0',
                transition: 'link',
            }];
    });
    handle('ext:history.addUrl', async (_e, { url, title } = {}) => {
        if (!url)
            throw new Error('url is required');
        await historyStore(_e).addToHistory(url, title || url, null, null);
        extEvents.historyVisited(url, title, profileIdOf(_e));
        return true;
    });
    handle('ext:history.deleteUrl', async (_e, { url } = {}) => {
        const store = historyStore(_e);
        const all = await store.loadHistory();
        for (const row of all.filter(x => x.url === url))
            await store.removeFromHistory(row.url, row.timestamp);
        broadcastToWorkers('ext:history.visitRemoved', { allHistory: false, urls: [url] });
        return true;
    });
    handle('ext:history.deleteRange', async (_e, { startTime, endTime } = {}) => {
        const store = historyStore(_e);
        const all = await store.loadHistory();
        const doomed = all.filter((row) => {
            const t = Date.parse(row.timestamp || 0) || 0;
            return t >= (startTime || 0) && t <= (endTime || Date.now());
        });
        for (const row of doomed)
            await store.removeFromHistory(row.url, row.timestamp);
        broadcastToWorkers('ext:history.visitRemoved', { allHistory: false, urls: doomed.map(r => r.url) });
        return true;
    });
    handle('ext:history.deleteAll', async (_e) => {
        await historyStore(_e).clearHistory();
        broadcastToWorkers('ext:history.visitRemoved', { allHistory: true, urls: [] });
        return true;
    });

    // ── chrome.bookmarks ─────────────────────────────────────────────────────
    // Chrome's tree is rooted at '0' with fixed folders beneath it; ours is a
    // flat top level. '1' is presented as the bar so extensions that hardcode
    // the well-known ids (most of them do) land somewhere sensible.
    const ROOT_ID = '0';
    const BAR_ID = '1';
    const bmStore = (e) => wm.bookmarksFor(profileIdOf(e));
    // Keep the bookmark bar / bookmarks page in sync when an extension writes.
    const broadcastBookmarks = () => {
        try { require('./utils').broadcastBookmarksChanged(webContents); }
        catch (e) { log.debug('extensions', 'broadcastBookmarks', e); }
    };
    const toNode = (item, parentId, index) => {
        const node = {
            id: String(item.id),
            parentId,
            index,
            title: item.title || '',
            dateAdded: item.addedAt || 0,
        };
        if (item.type === 'folder') {
            node.children = (item.children || [])
                .filter(c => c.type !== 'divider')
                .map((c, i) => toNode(c, String(item.id), i));
            node.dateGroupModified = item.addedAt || 0;
        }
        else {
            node.url = item.url;
        }
        return node;
    };
    const barNode = async (e) => {
        const items = await bmStore(e).getAll();
        return {
            id: BAR_ID,
            parentId: ROOT_ID,
            index: 0,
            title: 'Bookmarks Bar',
            children: items.filter(i => i.type !== 'divider').map((i, idx) => toNode(i, BAR_ID, idx)),
        };
    };
    const flatten = (node, out = []) => {
        out.push(node);
        for (const c of node.children || [])
            flatten(c, out);
        return out;
    };
    const findNode = async (e, id) => {
        const bar = await barNode(e);
        return flatten(bar).find(n => n.id === String(id)) || null;
    };
    handle('ext:bookmarks.getTree', async (_e) => [{
            id: ROOT_ID, title: '', children: [await barNode(_e)],
        }]);
    handle('ext:bookmarks.getSubTree', async (_e, { id } = {}) => {
        if (String(id) === ROOT_ID)
            return [{ id: ROOT_ID, title: '', children: [await barNode(_e)] }];
        const n = await findNode(_e, id);
        return n ? [n] : [];
    });
    handle('ext:bookmarks.get', async (_e, { id } = {}) => {
        const ids = Array.isArray(id) ? id : [id];
        const all = flatten(await barNode(_e));
        return ids.map(i => all.find(n => n.id === String(i))).filter(Boolean);
    });
    handle('ext:bookmarks.getChildren', async (_e, { id } = {}) => {
        if (String(id) === ROOT_ID)
            return [await barNode(_e)];
        const n = await findNode(_e, id);
        return n?.children || [];
    });
    handle('ext:bookmarks.getRecent', async (_e, { count } = {}) => {
        return flatten(await barNode(_e)).filter(n => n.url)
            .sort((a, b) => (b.dateAdded || 0) - (a.dateAdded || 0))
            .slice(0, count || 10);
    });
    handle('ext:bookmarks.search', async (_e, { query } = {}) => {
        const q = (typeof query === 'string' ? query : query?.query || '').toLowerCase();
        return flatten(await barNode(_e)).filter(n => n.id !== BAR_ID && (
            (n.title || '').toLowerCase().includes(q) || (n.url || '').toLowerCase().includes(q)));
    });
    // Establish the diff baseline before mutating, or the first change would
    // only set the snapshot and its own event would be lost.
    const ensurePrimed = (e) => extEvents.primeBookmarks(profileIdOf(e));
    handle('ext:bookmarks.create', async (_e, { bookmark } = {}) => {
        await ensurePrimed(_e);
        const store = bmStore(_e);
        const b = bookmark || {};
        const parent = b.parentId && String(b.parentId) !== BAR_ID && String(b.parentId) !== ROOT_ID
            ? String(b.parentId) : null;
        let id;
        if (b.url) {
            await store.add(b.url, b.title || b.url, null);
            const all = await store.getAll();
            id = all.find(x => x.url === b.url)?.id;
            if (parent && id)
                await store.moveIntoFolder(id, parent);
        }
        else {
            id = parent ? await store.addFolderInto(b.title, parent) : await store.addFolder(b.title);
        }
        const node = id ? await findNode(_e, id) : null;
        broadcastBookmarks();
        return node;
    });
    handle('ext:bookmarks.update', async (_e, { id, changes } = {}) => {
        await ensurePrimed(_e);
        await bmStore(_e).updateById(String(id), changes || {});
        const node = await findNode(_e, id);
        broadcastBookmarks();
        return node;
    });
    handle('ext:bookmarks.move', async (_e, { id, dest } = {}) => {
        await ensurePrimed(_e);
        const store = bmStore(_e);
        const target = dest?.parentId ? String(dest.parentId) : BAR_ID;
        if (target === BAR_ID || target === ROOT_ID)
            await store.moveOutOfFolder(String(id), null, null);
        else
            await store.moveIntoFolder(String(id), target);
        const node = await findNode(_e, id);
        broadcastBookmarks();
        return node;
    });
    handle('ext:bookmarks.remove', async (_e, { id } = {}) => {
        await ensurePrimed(_e);
        await bmStore(_e).removeById(String(id));
        broadcastBookmarks();
        return true;
    });

    // ── chrome.identity ──────────────────────────────────────────────────────
    handle('ext:identity.launchWebAuthFlow', (_e, { url, interactive } = {}) => {
        const id = needId(_e);
        const wd = wm.getMostRecentlyFocusedWindow?.() || wm.getPrimaryWindow?.();
        let session = null;
        try {
            const profiles = require('../features/profiles');
            session = profiles.sessionFor(profileIdOf(_e));
        }
        catch (e) { log.debug('extensions', 'ensurePrimed', e); }
        return require('../features/ext-identity')
            .launchWebAuthFlow(id, { url, interactive }, wd?.window || null, session);
    });

    // ── chrome.proxy ─────────────────────────────────────────────────────────
    // Per session, so an extension in one space cannot reroute the others.
    const proxySessionFor = (e) => {
        try {
            const profiles = require('../features/profiles');
            return profiles.sessionFor(profileIdOf(e));
        }
        catch { return null; }
    };
    const extProxy = require('../features/ext-proxy');
    handle('ext:proxy.set', (_e, { value } = {}) => extProxy.set(needId(_e), proxySessionFor(_e), { value }));
    handle('ext:proxy.get', (_e) => extProxy.get(needId(_e)));
    handle('ext:proxy.clear', (_e) => extProxy.clear(needId(_e)));

    // ── chrome.devtools ──────────────────────────────────────────────────────
    // Only reachable from a page we loaded as a devtools_page (see
    // features/devtools-ext.js); the polyfill installs the namespace nowhere else.
    const devtoolsExt = require('../features/devtools-ext');
    const activeWindow = () => wm.getMostRecentlyFocusedWindow?.() || wm.getPrimaryWindow?.() || wm.getAllWindows?.()[0] || null;
    handle('ext:devtools.eval', async (_e, { expression } = {}) => {
        const wc = devtoolsExt.inspectedTab(activeWindow());
        if (!wc)
            return { value: undefined, error: 'no inspected tab' };
        try { return { value: await wc.executeJavaScript(String(expression), true) }; }
        catch (err) { return { value: undefined, error: String(err && err.message || err) }; }
    });
    handle('ext:devtools.reload', (_e, { ignoreCache } = {}) => {
        const wc = devtoolsExt.inspectedTab(activeWindow());
        try { ignoreCache ? wc?.reloadIgnoringCache() : wc?.reload(); }
        catch (e) { log.debug('extensions', 'activeWindow', e); }
        return true;
    });
    handle('ext:devtools.createPanel', (_e, panel = {}) => devtoolsExt.registerPanel(needId(_e), panel));

    // ── chrome.sidePanel ─────────────────────────────────────────────────────
    const sidePanel = require('../features/side-panel');
    handle('ext:sidePanel.setOptions', (_e, o = {}) => sidePanel.setOptions(needId(_e), o));
    handle('ext:sidePanel.getOptions', (_e, o = {}) => sidePanel.getOptions(needId(_e), o));
    handle('ext:sidePanel.setPanelBehavior', (_e, o = {}) => sidePanel.setPanelBehavior(needId(_e), o));
    handle('ext:sidePanel.open', (_e, o = {}) => sidePanel.open(needId(_e), o, wm));
}

/**
 * Per-service-worker wiring. Called as each extension worker starts, because a
 * worker's IPC router is separate from the global ipcMain.
 */
function attachGapHandlers(sw, wm) {
    const router = sw.ipc;
    // A service-worker IPC event carries no .sender, so the calling extension is
    // identified by its scope (chrome-extension://<id>/).
    const extIdOf = () => {
        try { return new URL(sw.scope).hostname; }
        catch { return null; }
    };
    // Which space this worker belongs to — its session is the space's session,
    // and history/bookmarks are per-space stores. Resolved once, up front, so
    // the event fan-out can route by space.
    let cachedProfile = '1';
    try {
        const profiles = require('../features/profiles');
        for (const p of profiles.list() || []) {
            const id = String(p?.id ?? p);
            if (profiles.sessionFor(id) === sw.session) {
                cachedProfile = id;
                break;
            }
        }
    }
    catch (e) { log.debug('extensions', 'extIdOf', e); }
    const profileIdOf = () => cachedProfile;
    extEvents.addWorker(sw, cachedProfile);
    // Establish the bookmark baseline now, so this worker's first real edit
    // does not arrive as a create event for every existing bookmark.
    extEvents.primeBookmarks(cachedProfile);
    installGapHandlers({
        handle: (channel, fn) => router.handle(channel, fn),
        extIdOf,
        profileIdOf,
        wm,
    });
    // One line per missing API, so the next gap is named in the log.
    router.on('ext:unsupported', (_e, payload = {}) => logGap(payload));
}

/**
 * Global wiring for extension PAGES (popup, options, MV2 background). Registered
 * once; the sender's own URL identifies the extension.
 */
function registerFrameGapHandlers(ipcMain, wm) {
    const extIdOf = (e) => {
        try {
            const u = new URL(e.sender.getURL());
            return u.protocol === 'chrome-extension:' ? u.hostname : null;
        }
        catch { return null; }
    };
    installGapHandlers({
        handle: (channel, fn) => ipcMain.handle(channel, (e, ...args) => {
            // Only extension pages may reach the gap layer.
            if (!extIdOf(e))
                throw new Error('not an extension context');
            return fn(e, ...args);
        }),
        extIdOf,
        profileIdOf: (e) => wm.profileOf(e.sender),
        wm,
    });
    ipcMain.on('ext:unsupported', (_e, payload = {}) => logGap(payload));
}

function register(ipcMain, { wm }) {
    // Extension pages (popups, options) reach the gap layer over the global
    // ipcMain; service workers get their own router in attachGapHandlers.
    extEvents.setWindowManager(wm);
    /* Hand the gap layer DOWN to features/extensions. It used to reach up and
       require this module at call time, which made features depend on ipc —
       the inverse of how these layers are meant to sit, and the one edge every
       circular dependency in the tree passed through. */
    try { extensions.setGapHandlers(attachGapHandlers); }
    catch (e) { log.debug('extensions', 'setGapHandlers', e); }
    registerFrameGapHandlers(ipcMain, wm);
    extensions.onChanged(() => {
        for (const wd of wm.getAllWindows()) {
            try {
                wd.window.webContents.send('extensions-changed');
            }
            catch (e) { log.debug('extensions', 'register', e); }
            if (wd.extensionsPanel) {
                try {
                    wd.extensionsPanel.webContents.send('extensions-data', listWithPinned());
                }
                catch (e) { log.debug('extensions', 'register', e); }
            }
        }
    });
    // Side panel: Chrome opens it on the toolbar action click when the extension
    // called setPanelBehavior({openPanelOnActionClick:true}). The renderer has to
    // decide synchronously to beat the library's own click handling, so the set
    // of such extensions is pushed to it rather than queried per click.
    const sidePanelFeature = require('../features/side-panel');
    const pushBehavior = (ids) => {
        for (const wd of wm.getAllWindows()) {
            try { wd.window.webContents.send('ext-sidepanel-behavior', ids); }
            catch (e) { log.debug('extensions', 'pushBehavior', e); }
        }
    };
    sidePanelFeature.onBehaviorChanged(pushBehavior);
    ipcMain.handle('side-panel-behavior-get', () => sidePanelFeature.openOnActionClickIds());
    ipcMain.handle('side-panel-open-for', async (_e, extensionId) => {
        try {
            await sidePanelFeature.open(extensionId, {}, wm);
            return { ok: true };
        }
        catch (err) {
            return { ok: false, error: err.message };
        }
    });
    // Side panel — closed from its own header strip, or by the chrome UI.
    ipcMain.handle('side-panel-close', (_e) => {
        const sidePanel = require('../features/side-panel');
        let wd = wm.getWindowByWebContents(_e.sender);
        if (!wd) {
            for (const w of wm.getAllWindows()) {
                if (w.sidePanelHeader?.webContents === _e.sender) {
                    wd = w;
                    break;
                }
            }
        }
        return sidePanel.close(wd);
    });
    // Synchronous because chrome.devtools.inspectedWindow.tabId is a plain
    // property an extension reads the moment its devtools page runs.
    ipcMain.on('ext:devtools.tabIdSync', (e) => {
        let id = -1;
        try {
            const wd = wm.getMostRecentlyFocusedWindow?.() || wm.getPrimaryWindow?.();
            id = wd?.tabs?.tabMap?.get(wd.tabs.activeTabIndex)?.webContents?.id ?? -1;
        }
        catch (e) { log.debug('extensions', 'ext:devtools.tabIdSync', e); }
        e.returnValue = id;
    });
    // DevTools-panel extensions: load their devtools_page so panels register,
    // then show a chosen panel in the side panel column.
    ipcMain.handle('devtools-panels-list', async (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender) || wm.getPrimaryWindow();
        if (!wd)
            return [];
        try { return await require('../features/devtools-ext').discover(wd); }
        catch (err) {
            console.error('devtools-panels-list:', err.message);
            return [];
        }
    });
    ipcMain.handle('devtools-panel-open', async (_e, panelId) => {
        const wd = wm.getWindowByWebContents(_e.sender) || wm.getPrimaryWindow();
        try { return await require('../features/devtools-ext').openPanel(wd, panelId, wm); }
        catch (err) {
            return { ok: false, error: err.message };
        }
    });
    // Installing/removing/toggling extensions is a trusted-surface action:
    // answer only the app's own internal pages, never web or local-file content.
    const extTrusted = (e, channel) => {
        if (isTrustedInternalSender(e.sender))
            return true;
        log.warn('extensions', `blocked ${channel} from untrusted sender`);
        return false;
    };
    ipcMain.handle('extensions-list', () => listWithPinned());
    ipcMain.handle('extensions-remove', (_e, id) => extTrusted(_e, 'extensions-remove') ? extensions.remove(id) : false);
    ipcMain.handle('extensions-set-enabled', (_e, id, enabled) => extTrusted(_e, 'extensions-set-enabled') ? extensions.setEnabled(id, enabled) : false);
    ipcMain.handle('extensions-open-options', (_e, id) => extTrusted(_e, 'extensions-open-options') ? extensions.openOptions(id) : false);
    // Install by Chrome Web Store ID or URL.
    ipcMain.handle('extensions-install-id', async (_e, idOrUrl) => {
        if (!extTrusted(_e, 'extensions-install-id')) return { ok: false, error: 'blocked' };
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
        if (!extTrusted(_e, 'extensions-add')) return { canceled: true };
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
                catch (e) { log.debug('extensions', 'extensions-open-store', e); }
                return true;
            }
        }
        const idx = wd.tabs.createLazyTab(WEB_STORE_URL, 'Chrome Web Store', false, false, true, true);
        try {
            wd.tabs.showTab(idx);
            wd.window.focus();
        }
        catch (e) { log.debug('extensions', 'extensions-open-store', e); }
        return true;
    });
    // Chrome clicks / page clicks dismiss an open action popup.
    ipcMain.handle('extensions-close-action-popup', () => {
        extensions.closePopups();
        return true;
    });
    // standard pinning: missing key = pinned (extensions land in the
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
            catch (e) { log.debug('extensions', 'extensions-set-pinned', e); }
            if (wd.extensionsPanel) {
                try {
                    wd.extensionsPanel.webContents.send('extensions-data', listWithPinned());
                }
                catch (e) { log.debug('extensions', 'extensions-set-pinned', e); }
            }
        }
        return true;
    });
    // Panel row click — activate the extension's action in the chrome page
    // (opens its popup / fires its onClicked), exactly's panel.
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
        catch (e) { log.debug('extensions', 'extensions-activate', e); }
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
            // DevTools panels get their own rows, so they count toward the
            // height — otherwise the section opens below the fold.
            let extraRows = 0;
            try { extraRows = require('../features/devtools-ext').listPanels().length; }
            catch (e) { log.debug('extensions', 'extensions-panel-toggle', e); }
            view.setBounds(boundsFor(wd.window, anchor, items.length + extraRows));
            // Re-add on every open: newly created tab views would otherwise
            // sit above the panel in the contentView child order.
            try {
                wd.window.contentView.removeChildView(view);
            }
            catch (e) { log.debug('extensions', 'extensions-panel-toggle', e); }
            try {
                wd.window.contentView.addChildView(view);
            }
            catch (e) { log.debug('extensions', 'extensions-panel-toggle', e); }
            view.webContents.send('extensions-data', items);
            view.setVisible(true);
            wd.extensionsPanelOpen = true;
            wd.extensionsPanelAnchor = anchor; // for the self-measured resize
            signalEnter(view); // P1-6 fade-in
            return true;
        }
        catch (err) {
            console.error('extensions-panel-toggle:', err);
            return false;
        }
    });
    // The panel measures its own rendered height and asks to be resized. Rows
    // are not a uniform height (the DevTools section adds a header plus rows),
    // so a count-based estimate clipped the last row.
    ipcMain.handle('extensions-panel-height', (_e, height) => {
        let wd = wm.getWindowByWebContents(_e.sender);
        if (!wd) {
            for (const w of wm.getAllWindows()) {
                if (w.extensionsPanel?.webContents === _e.sender) { wd = w; break; }
            }
        }
        const anchor = wd?.extensionsPanelAnchor;
        if (!wd?.extensionsPanel || !anchor || !Number.isFinite(height))
            return false;
        const h = Math.max(80, Math.min(MAX_PANEL_H, Math.ceil(height) + 2));
        try {
            wd.extensionsPanel.setBounds(panelBounds(wd.window, { anchor, width: PANEL_WIDTH, height: h }));
        }
        catch (e) { log.debug('extensions', 'extensions-panel-height', e); }
        return true;
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

module.exports = { attachGapHandlers, registerFrameGapHandlers, register };