/**
 * IPC — lock-icon site-info panel (connection, permissions, clear data).
 *
 * Rendered as a WebContentsView overlay (like the hamburger menu) so it draws
 * above the page. Opened from the chrome renderer when the address-bar lock icon
 * is clicked; the panel's own preload (siteinfo-preload.js) reads/writes data.
 */
const path = require('path');
const { resolveAppFile } = require('../app-paths');
const { WebContentsView, session } = require('electron');
const PANEL_W = 300;
function computeInfo(url, sitePermissions) {
    let origin = null, host = '', secure = false, internal = false;
    try {
        const u = new URL(url);
        origin = u.origin;
        host = u.hostname;
        secure = u.protocol === 'https:';
        internal = !/^https?:$/.test(u.protocol);
    }
    catch {
        internal = true;
    }
    return {
        origin, host, secure, internal,
        permissions: origin && !internal ? sitePermissions.list(origin) : [],
    };
}
function activeUrlOf(wd) {
    try {
        return wd.tabs.tabUrls.get(wd.tabs.activeTabIndex) || '';
    }
    catch {
        return '';
    }
}
// The active tab's webContents (permission changes are scoped to its session).
function activeTabOf(wd) {
    try {
        return wd.tabs.tabMap.get(wd.tabs.activeTabIndex) || null;
    }
    catch {
        return null;
    }
}
// Revoking an in-use grant (camera/mic/location) only takes effect on reload —
// an already-open stream keeps running otherwise. Reload every tab currently on
// the origin, in the scope the change applies to: just this private tab's
// session for a private override, all non-private tabs for a stored change.
function reloadOriginTabs(wm, origin, { privateSession = null } = {}) {
    for (const w of wm.getAllWindows()) {
        if (!w.tabs)
            continue;
        w.tabs.tabMap.forEach((tab, index) => {
            try {
                const wc = tab.webContents;
                if (!wc || wc.isDestroyed())
                    return;
                if (privateSession ? wc.session !== privateSession : tab.isPrivate)
                    return;
                if (new URL(wc.getURL()).origin !== origin)
                    return;
                w.tabs.reload(index);
            }
            catch { }
        });
    }
}
function closePanel(wd) {
    if (!wd || !wd.siteInfoView)
        return;
    try {
        wd.window.contentView.removeChildView(wd.siteInfoView);
    }
    catch { }
    try {
        wd.siteInfoView.webContents.close?.();
    }
    catch { }
    wd.siteInfoView = null;
    wd.siteInfoInfo = null;
    wd.siteInfoSession = null;
    wd.siteInfoClosedAt = Date.now(); // lets a lock-click that blurred us act as a toggle
    if (wd.siteInfoCleanup) {
        try {
            wd.siteInfoCleanup();
        }
        catch { }
        wd.siteInfoCleanup = null;
    }
}
// Cookies whose domain belongs to the site (eTLD+1) — for the panel's counter.
async function countCookies(site, sess) {
    if (!site)
        return 0;
    try {
        const all = await (sess || session.defaultSession).cookies.get({});
        return all.filter(c => {
            const d = (c.domain || '').replace(/^\./, '');
            return d === site || d.endsWith('.' + site);
        }).length;
    }
    catch {
        return 0;
    }
}
function register(ipcMain, { wm }) {
    const sitePermissions = require('../features/site-permissions').default;
    const permissionPrompt = require('../features/permission-prompt');
    // Toggle open at the given anchor rect { x, y } (address-bar coords).
    ipcMain.handle('open-site-info', async (e, anchor) => {
        const wd = wm.getWindowByWebContents(e.sender);
        if (!wd)
            return false;
        if (wd.siteInfoView) {
            closePanel(wd);
            return false;
        }
        // The click that opens can be the same one that just blurred the panel
        // closed — treat it as a toggle instead of instantly reopening.
        if (wd.siteInfoClosedAt && Date.now() - wd.siteInfoClosedAt < 350)
            return false;
        const info = computeInfo(activeUrlOf(wd), sitePermissions);
        if (info.internal || !info.origin)
            return false; // nothing to show for internal pages
        // Permission changes apply to the active tab's session: private tabs get
        // in-memory, session-scoped overrides (never written to disk); normal
        // tabs get the persistent per-origin store.
        const tab = activeTabOf(wd);
        info.private = !!(tab && tab.isPrivate);
        wd.siteInfoSession = tab && !tab.webContents.isDestroyed() ? tab.webContents.session : null;
        if (info.private && wd.siteInfoSession) {
            info.permissions = permissionPrompt.listStates(wd.siteInfoSession, info.origin);
        }
        info.site = sitePermissions.siteOf(info.host);
        info.protectionOff = sitePermissions.isProtectionOff(info.site);
        info.cookieCount = await countCookies(info.site, info.private ? wd.siteInfoSession : null);
        const view = new WebContentsView({
            webPreferences: {
                preload: path.join(__dirname, '../preload/siteinfo-preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
            },
        });
        view.setBackgroundColor('#00000000');
        wd.window.contentView.addChildView(view);
        view.webContents.loadFile(resolveAppFile('renderer/SiteInfo/index.html'));
        const winW = wd.window.getBounds().width;
        const left = Math.max(8, Math.min(Math.round((anchor && anchor.x) || 12) - 10, winW - PANEL_W - 8));
        const top = Math.max(2, Math.round((anchor && anchor.y) || 86) + 4);
        view.setBounds({ x: left, y: top, width: PANEL_W, height: 300 });
        wd.siteInfoView = view;
        wd.siteInfoInfo = info;
        // Focus the panel so a click anywhere outside it blurs → closes it.
        // Also close when the whole window loses focus (switching apps).
        view.webContents.once('dom-ready', () => { try {
            view.webContents.focus();
        }
        catch { } });
        const onContentsBlur = () => closePanel(wd);
        const onWindowBlur = () => closePanel(wd);
        view.webContents.on('blur', onContentsBlur);
        wd.window.once('blur', onWindowBlur);
        wd.siteInfoCleanup = () => {
            try {
                view.webContents.removeListener('blur', onContentsBlur);
            }
            catch { }
            try {
                wd.window.removeListener('blur', onWindowBlur);
            }
            catch { }
        };
        return true;
    });
    ipcMain.handle('site-info-current', (e) => {
        const wd = wm.getWindowByWebContents(e.sender);
        return wd && wd.siteInfoInfo ? wd.siteInfoInfo : { internal: true, permissions: [] };
    });
    ipcMain.handle('site-permission-set', (e, name, value) => {
        const wd = wm.getWindowByWebContents(e.sender);
        const info = wd && wd.siteInfoInfo;
        if (!info || !info.origin)
            return true;
        // Was the permission usable before this change? (stored/override allow,
        // or a doorhanger grant without "Remember" that's still live)
        const prev = info.private && wd.siteInfoSession
            ? permissionPrompt.effectiveState(wd.siteInfoSession, info.origin, name)
            : sitePermissions.state(info.origin, name);
        const wasUsable = prev === 'allow' || permissionPrompt.hasTempAllow(info.origin, name);
        if (info.private) {
            if (wd.siteInfoSession)
                permissionPrompt.setOverride(wd.siteInfoSession, info.origin, name, value);
        }
        else {
            sitePermissions.set(info.origin, name, value); // also clears temp grants (change event)
        }
        // Revoking camera/mic/location that a page may be actively using only
        // takes effect on reload (an open stream keeps running) — reload the
        // origin's tabs, like Firefox stopping the device when you block it.
        if (value !== 'allow' && wasUsable && permissionPrompt.liveUse(name)) {
            reloadOriginTabs(wm, info.origin, { privateSession: info.private ? wd.siteInfoSession : null });
        }
        return true;
    });
    ipcMain.handle('site-clear-data', async (e) => {
        const wd = wm.getWindowByWebContents(e.sender);
        const info = wd && wd.siteInfoInfo;
        if (info && info.origin) {
            const sess = (info.private && wd.siteInfoSession) || session.defaultSession;
            try {
                await sess.clearStorageData({ origin: info.origin });
                return true;
            }
            catch { }
        }
        return false;
    });
    // Panel reports its content height so we can size the view snugly.
    ipcMain.handle('site-info-resize', (e, height) => {
        const wd = wm.getWindowByWebContents(e.sender);
        if (wd && wd.siteInfoView) {
            try {
                const b = wd.siteInfoView.getBounds();
                wd.siteInfoView.setBounds({ ...b, height: Math.max(80, Math.min(560, Math.round(height))) });
            }
            catch { }
        }
    });
    // Per-site protections shield: persist, close the panel, reload the page so
    // the change takes effect immediately (Firefox does the same).
    ipcMain.handle('site-protection-set', (e, off) => {
        const wd = wm.getWindowByWebContents(e.sender);
        const info = wd && wd.siteInfoInfo;
        if (!info || !info.site)
            return false;
        sitePermissions.setProtection(info.site, !!off);
        closePanel(wd);
        try {
            wd.tabs.reload(wd.tabs.activeTabIndex);
        }
        catch { }
        return true;
    });
    // One async round trip answering "should cosmetic hiding stay on for this
    // host?" (ad-block enabled AND the site's shield is not off). Replaces the
    // old sendSync channel that blocked every page's document-start.
    ipcMain.handle('cosmetic-filter-state', (_e, host) => {
        try {
            const privacy = require('../features/privacy');
            if (privacy.getConfig().adBlockEnabled === false)
                return false;
            return !sitePermissions.isProtectionOff(sitePermissions.siteOf(host || ''));
        }
        catch {
            return true;
        }
    });
    ipcMain.handle('close-site-info', (e) => { closePanel(wm.getWindowByWebContents(e.sender)); });
}

module.exports = { register, closePanel };