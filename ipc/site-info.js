/**
 * IPC — lock-icon site-info panel (connection, permissions, clear data).
 *
 * Rendered as a WebContentsView overlay (like the hamburger menu) so it draws
 * above the page. Opened from the chrome renderer when the address-bar lock icon
 * is clicked; the panel's own preload (siteinfo-preload.js) reads/writes data.
 */

const path = require('path');
const { WebContentsView, session } = require('electron');

const PANEL_W = 300;

function computeInfo(url, sitePermissions) {
    let origin = null, host = '', secure = false, internal = false;
    try {
        const u = new URL(url);
        origin = u.origin; host = u.hostname;
        secure = u.protocol === 'https:';
        internal = !/^https?:$/.test(u.protocol);
    } catch { internal = true; }
    return {
        origin, host, secure, internal,
        permissions: origin && !internal ? sitePermissions.list(origin) : [],
    };
}

function activeUrlOf(wd) {
    try { return wd.tabs.tabUrls.get(wd.tabs.activeTabIndex) || ''; } catch { return ''; }
}

function closePanel(wd) {
    if (!wd || !wd.siteInfoView) return;
    try { wd.window.contentView.removeChildView(wd.siteInfoView); } catch {}
    try { wd.siteInfoView.webContents.close?.(); } catch {}
    wd.siteInfoView = null;
    wd.siteInfoInfo = null;
    wd.siteInfoClosedAt = Date.now(); // lets a lock-click that blurred us act as a toggle
    if (wd.siteInfoCleanup) { try { wd.siteInfoCleanup(); } catch {} wd.siteInfoCleanup = null; }
}

// Cookies whose domain belongs to the site (eTLD+1) — for the panel's counter.
async function countCookies(site) {
    if (!site) return 0;
    try {
        const all = await session.defaultSession.cookies.get({});
        return all.filter(c => {
            const d = (c.domain || '').replace(/^\./, '');
            return d === site || d.endsWith('.' + site);
        }).length;
    } catch { return 0; }
}

function register(ipcMain, { wm }) {
    const sitePermissions = require('../Features/site-permissions');

    // Toggle open at the given anchor rect { x, y } (address-bar coords).
    ipcMain.handle('open-site-info', async (e, anchor) => {
        const wd = wm.getWindowByWebContents(e.sender);
        if (!wd) return false;
        if (wd.siteInfoView) { closePanel(wd); return false; }
        // The click that opens can be the same one that just blurred the panel
        // closed — treat it as a toggle instead of instantly reopening.
        if (wd.siteInfoClosedAt && Date.now() - wd.siteInfoClosedAt < 350) return false;

        const info = computeInfo(activeUrlOf(wd), sitePermissions);
        if (info.internal || !info.origin) return false; // nothing to show for internal pages
        info.site          = sitePermissions.siteOf(info.host);
        info.protectionOff = sitePermissions.isProtectionOff(info.site);
        info.cookieCount   = await countCookies(info.site);

        const view = new WebContentsView({
            webPreferences: {
                preload: path.join(__dirname, '../preload/siteinfo-preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
            },
        });
        view.setBackgroundColor('#00000000');
        wd.window.contentView.addChildView(view);
        view.webContents.loadFile('renderer/SiteInfo/index.html');

        const winW = wd.window.getBounds().width;
        const left = Math.max(8, Math.min(Math.round((anchor && anchor.x) || 12) - 10, winW - PANEL_W - 8));
        const top  = Math.max(2, Math.round((anchor && anchor.y) || 86) + 4);
        view.setBounds({ x: left, y: top, width: PANEL_W, height: 300 });

        wd.siteInfoView = view;
        wd.siteInfoInfo = info;

        // Focus the panel so a click anywhere outside it blurs → closes it.
        // Also close when the whole window loses focus (switching apps).
        view.webContents.once('dom-ready', () => { try { view.webContents.focus(); } catch {} });
        const onContentsBlur = () => closePanel(wd);
        const onWindowBlur   = () => closePanel(wd);
        view.webContents.on('blur', onContentsBlur);
        wd.window.once('blur', onWindowBlur);
        wd.siteInfoCleanup = () => {
            try { view.webContents.removeListener('blur', onContentsBlur); } catch {}
            try { wd.window.removeListener('blur', onWindowBlur); } catch {}
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
        if (info && info.origin) sitePermissions.set(info.origin, name, value);
        return true;
    });

    ipcMain.handle('site-clear-data', async (e) => {
        const wd = wm.getWindowByWebContents(e.sender);
        const info = wd && wd.siteInfoInfo;
        if (info && info.origin) {
            try { await session.defaultSession.clearStorageData({ origin: info.origin }); return true; } catch {}
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
            } catch {}
        }
    });

    // Per-site protections shield: persist, close the panel, reload the page so
    // the change takes effect immediately (Firefox does the same).
    ipcMain.handle('site-protection-set', (e, off) => {
        const wd = wm.getWindowByWebContents(e.sender);
        const info = wd && wd.siteInfoInfo;
        if (!info || !info.site) return false;
        sitePermissions.setProtection(info.site, !!off);
        closePanel(wd);
        try { wd.tabs.reload(wd.tabs.activeTabIndex); } catch {}
        return true;
    });

    // Sync check used by the cosmetic ad-hiding preload on every page.
    ipcMain.on('site-protection-off-sync', (e, host) => {
        try { e.returnValue = sitePermissions.isProtectionOff(sitePermissions.siteOf(host || '')); }
        catch { e.returnValue = false; }
    });

    ipcMain.handle('close-site-info', (e) => { closePanel(wm.getWindowByWebContents(e.sender)); });
}

module.exports = { register, closePanel };
