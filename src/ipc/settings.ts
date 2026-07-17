/**
 * IPC handlers — settings, focus mode, window controls, and chrome layout.
 *
 * Also handles: bookmark bar visibility toggle, chrome height reporting
 * (tab resize), overlay open/close (collapse/restore tab views), and
 * address bar focus forwarding.
 */

import { loginWithGoogle } from '../features/google-auth';
import * as privacy from '../features/privacy';
// Privacy / tracking-protection settings routed through the privacy orchestrator.
const PRIVACY_KEYS = [
    'adBlockEnabled', 'blockThirdPartyCookies', 'httpsUpgrade',
    'stripTrackingParams', 'privacySignals', 'trimReferrer',
];

function register(ipcMain, { wm, webContents, nativeTheme, app, focusMode }) {

    focusMode.setShortformEnabled(wm, !!wm.persistence.get('blockShortform'));

    // Seed every privacy layer from persisted settings (defaults are maximal).
    PRIVACY_KEYS.forEach(k => privacy.setConfig(k, wm.persistence.get(k)));

    // ── Settings ──────────────────────────────────────────────────────────────

    ipcMain.handle('settings-get', () => {
        const s      = wm.persistence.getAll();
        s._version   = app.getVersion();
        return s;
    });

    // Synchronous read used by preload scripts at startup
    ipcMain.on('settings-get-sync', (_e) => {
        _e.returnValue = wm.persistence.getAll();
    });

    ipcMain.handle('settings-set', (_e, key, value) => {
        wm.persistence.set(key, value);

        if (key === 'theme') {
            nativeTheme.themeSource = (value === 'porcelain' || value === 'dune') ? 'light' : 'dark';
            webContents.getAllWebContents().forEach(wc => {
                try { wc.send('theme-changed', value); } catch {}
            });
        }

        if (key === 'persistAllTabs') {
            const wd = wm.getWindowByWebContents(_e.sender);
            if (wd?.tabs) { try { wd.tabs.saveStateDebounced(); } catch {} }
        }

        if (key === 'blockShortform') {
            focusMode.setShortformEnabled(wm, !!value);
        }

        if (PRIVACY_KEYS.includes(key)) {
            privacy.setConfig(key, value);
            // Ad blocking also drives the cosmetic preload — broadcast so it can
            // inject / remove element-hiding CSS live.
            if (key === 'adBlockEnabled') {
                webContents.getAllWebContents().forEach(wc => {
                    try { wc.send('adblock-set-enabled', !!value); } catch {}
                });
            }
        }

        return true;
    });

    // Live tracking-protection stats for the Privacy settings panel.
    ipcMain.handle('privacy-get-stats', () => privacy.getStats());

    ipcMain.handle('settings-clear-history', async () => {
        try { return await wm.history.clearHistory(); } catch { return false; }
    });

    // Clear browsing data across a time range. Note: Electron can't scope
    // cookies/cache/site-data to a time range, so those clear entirely when
    // selected; the range applies to history and download list.
    ipcMain.handle('clear-browsing-data', async (_e, payload) => {
        const { session } = require('electron');
        const downloadManager = require('../features/download-manager').default;
        const { range = 'all', types = {} } = payload || {};
        const SPANS = { hour: 3600e3, day: 864e5, week: 6048e5, month: 24192e5, all: Infinity };
        const span = SPANS[range] ?? Infinity;
        const since = span === Infinity ? 0 : Date.now() - span;
        const sess = session.defaultSession;

        try {
            if (types.history)   { await wm.history.clearSince(since); }
            if (types.downloads) { downloadManager.clearFinished(); }
            if (types.cache)     { await sess.clearCache(); }
            if (types.cookies) {
                await sess.clearStorageData({
                    storages: ['cookies', 'localstorage', 'indexdb', 'websql',
                               'serviceworkers', 'cachestorage', 'filesystem', 'shadercache'],
                });
                try { await sess.clearAuthCache(); } catch {}
            }
            // Notify chrome so the history/bookmark UIs can refresh.
            try { wm.getAllWindows().forEach(w => w.window.webContents.send('browsing-data-cleared')); } catch {}
            return { ok: true };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('open-settings-tab', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd) wd.tabs.createTabWithPage('renderer/Settings/index.html', 'settings', 'Settings');
    });

    ipcMain.handle('google-login', async (_e, clientId, clientSecret) => {
        try {
            const data = await loginWithGoogle(clientId, clientSecret);
            return { success: true, data };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    // ── Focus mode ─────────────────────────────────────────────────────────────

    ipcMain.handle('focus-mode-toggle', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd) return false;
        focusMode.toggle(wd);
        return focusMode.isActive(wd);
    });

    ipcMain.handle('focus-mode-get', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        return wd ? focusMode.isActive(wd) : false;
    });

    // ── Overlay (collapse / restore tab views) ────────────────────────────────

    ipcMain.on('overlay-open', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd?.tabs) wd.tabs.collapseAllTabs();
    });

    ipcMain.on('overlay-close', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd?.tabs) wd.tabs.restoreAllTabs();
    });

    // ── Bookmark bar chrome ───────────────────────────────────────────────────

    // Forward bookmark-bar toggle from any view (e.g. menu) to the chrome renderer
    ipcMain.on('toggle-bookmark-bar', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd) wd.window.webContents.send('toggle-bookmark-bar');
    });

    // Chrome renderer reports its height after the bookmark bar shows/hides
    ipcMain.on('chrome-height-changed', (_e, height) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd?.tabs) {
            wd.tabs.bookmarkBarHeight = height;
            wd.tabs.resizeAllTabs();
        }
    });

    // Forward address bar focus request (used by panels that need to hand focus back)
    ipcMain.on('focus-address-bar', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd) wd.window.webContents.send('focus-address-bar');
    });

    // ── Window controls (minimize / maximize / close) ─────────────────────────

    ipcMain.handle('window-minimize', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd) wd.window.minimize();
    });

    ipcMain.handle('window-maximize', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd) return;
        if (wd.window.isMaximized()) wd.window.unmaximize();
        else                         wd.window.maximize();
    });

    ipcMain.handle('window-close', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd) return;
        if (wd.tabs) wd.tabs.allowClose = true;
        wd.window.close();
    });

    ipcMain.handle('window-is-maximized', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        return wd ? wd.window.isMaximized() : false;
    });
}

export { register };