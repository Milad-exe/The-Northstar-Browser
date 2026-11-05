/**
 * IPC handlers — settings, focus mode, window controls, and chrome layout.
 *
 * Also handles: bookmark bar visibility toggle, chrome height reporting
 * (tab resize), overlay open/close (collapse/restore tab views), and
 * address bar focus forwarding.
 */
const log = require('../features/log');
const { loginWithGoogle } = require('../features/google-auth');
const privacy = require('../features/privacy');
const searchEngines = require('../features/search-engines');
const i18n = require('../features/i18n');
const History = require('../features/history');
const zoom = require('../features/zoom');
const appIcon = require('../features/app-icon');
const themes = require('../features/themes');
const themeRuntime = require('../features/theme-runtime');
const themeDerive = require('../features/theme-derive');
const { isTrustedInternalSender } = require('../features/ipc-guard');
// Privacy / tracking-protection settings routed through the privacy orchestrator.
const PRIVACY_KEYS = [
    'adBlockEnabled', 'blockThirdPartyCookies', 'httpsUpgrade',
    'stripTrackingParams', 'privacySignals', 'trimReferrer',
];
function register(ipcMain, { wm, webContents, nativeTheme, app, focusMode }) {
    focusMode.setShortformEnabled(wm, !!wm.persistence.get('blockShortform'));
    // Seed every privacy layer from persisted settings (defaults are maximal).
    PRIVACY_KEYS.forEach(k => privacy.setConfig(k, wm.persistence.get(k)));
    // Configuration-mutating handlers answer only the app's own internal pages.
    const trusted = (e, channel) => {
        if (isTrustedInternalSender(e.sender))
            return true;
        log.warn('settings', `blocked ${channel} from untrusted sender`);
        return false;
    };
    // ── Settings ──────────────────────────────────────────────────────────────
    // The renderer resolves typed text to a URL synchronously, so it needs the
    // engine list in the settings payload — built-ins included, so there is one
    // definition of them (features/search-engines.js) rather than a copy in the
    // omnibox.
    const withEngines = (s) => {
        s.engines = searchEngines.all();
        // The chrome paints its labels during startup, so the catalogue has to
        // travel with the settings rather than in a later round trip.
        s.i18n = { locale: i18n.currentLocale(), catalogue: i18n.catalogue() };
        return s;
    };
    ipcMain.handle('settings-get', () => {
        const s = withEngines(wm.persistence.getAll());
        s._version = app.getVersion();
        return s;
    });
    // Synchronous read used by preload scripts at startup
    ipcMain.on('settings-get-sync', (_e) => {
        _e.returnValue = withEngines(wm.persistence.getAll());
    });
    // Just the catalogue, for overlay panels (preload/i18n-bridge.js). They
    // paint before an async round trip could land, and they have no reason to
    // see the rest of the settings.
    ipcMain.on('i18n-sync', (_e) => {
        _e.returnValue = { locale: i18n.currentLocale(), catalogue: i18n.catalogue() };
    });
    // ── Language ──────────────────────────────────────────────────────────────
    ipcMain.handle('i18n:locales', () => i18n.locales());
    ipcMain.handle('i18n:set', (_e, id) => {
        if (!trusted(_e, 'i18n:set')) return i18n.currentLocale();
        const resolved = i18n.setLanguage(id);
        // Every window re-reads its labels; the pages that own their own markup
        // localise on load.
        webContents.getAllWebContents().forEach(wc => {
            try { wc.send('language-changed', { locale: resolved, catalogue: i18n.catalogue() }); }
            catch (e) { log.debug('settings', 'language broadcast', e); }
        });
        return resolved;
    });
    // ── Per-site zoom ─────────────────────────────────────────────────────────
    ipcMain.handle('zoom:list', () => zoom.all());
    ipcMain.handle('zoom:clear', (_e, origin) => {
        if (!trusted(_e, 'zoom:clear')) return false;
        zoom.clear(origin || null);
        // Apply immediately to anything currently showing that origin.
        wm.getAllWindows().forEach(w => {
            w.tabs?.tabMap?.forEach((tab, idx) => {
                const url = w.tabs.tabUrls.get(idx) || '';
                if (!origin || zoom.originOf(url) === origin)
                    zoom.apply(tab.webContents, url);
            });
        });
        return true;
    });
    // ── Search engines ────────────────────────────────────────────────────────
    ipcMain.handle('engines:list', () => searchEngines.all());
    ipcMain.handle('engines:save', (_e, engine) => {
        if (!trusted(_e, 'engines:save')) return { ok: false };
        try {
            const saved = searchEngines.upsert(engine);
            broadcastEngines();
            return { ok: true, engine: saved };
        }
        catch (err) {
            return { ok: false, error: err?.message || 'Could not save that engine.' };
        }
    });
    ipcMain.handle('engines:remove', (_e, id) => {
        if (!trusted(_e, 'engines:remove')) return false;
        const removed = searchEngines.remove(id);
        if (removed)
            broadcastEngines();
        return removed;
    });
    function broadcastEngines() {
        const list = searchEngines.all();
        webContents.getAllWebContents().forEach(wc => {
            try { wc.send('engines-changed', list); }
            catch (e) { log.debug('settings', 'broadcastEngines', e); }
        });
    }
    ipcMain.handle('settings-set', (_e, key, value) => {
        // Mutating persisted settings (search engine, privacy toggles, …) is a
        // trusted-surface action; a web page must not be able to reconfigure the
        // browser even if it somehow acquired the bridge.
        if (!isTrustedInternalSender(_e.sender)) {
            log.warn('settings', 'blocked settings-set from untrusted sender');
            return false;
        }
        wm.persistence.set(key, value);
        if (key === 'theme') {
            // One call does the lot: nativeTheme, the dock icon, the
            // theme-changed broadcast, and — for derived and user themes — the
            // token CSS every surface needs, since those have no block in the
            // stylesheets to switch to.
            themeRuntime.apply(value, wm);
        }
        if (key === 'tabBarSide') {
            // Switching sidebar ⇄ top strip reflows every window. One shared path
            // for the Settings toggle, the ⌘⇧S shortcut and the context menu.
            // (persistence was already set above; setTabBarSide re-sets the same
            // value harmlessly and does the reflow.)
            wm.setTabBarSide(value);
        }
        if (key === 'utilityBar') {
            // Chrome windows re-apply toolbar visibility live.
            wm.getAllWindows().forEach(w => {
                try {
                    w.window.webContents.send('utility-bar-changed', value);
                }
                catch (e) { log.debug('settings', 'settings-set', e); }
            });
        }
        if (key === 'searchSuggestions') {
            // Takes effect on the next keystroke, not the next launch.
            wm.getAllWindows().forEach(w => {
                try { w.window.webContents.send('search-suggestions-changed', !!value); }
                catch (e) { log.debug('settings', 'settings-set', e); }
            });
        }
        if (key === 'persistAllTabs') {
            const wd = wm.getWindowByWebContents(_e.sender);
            if (wd?.tabs) {
                try {
                    wd.tabs.saveStateDebounced();
                }
                catch (e) { log.debug('settings', 'settings-set', e); }
            }
        }
        if (key === 'blockShortform') {
            focusMode.setShortformEnabled(wm, !!value);
        }
        // Retention changes take effect on the next read, not the next restart.
        if (key === 'historyDays' || key === 'historyMaxEntries') {
            History.setRetention({
                maxDays: wm.persistence.get('historyDays'),
                maxEntries: wm.persistence.get('historyMaxEntries'),
            });
        }
        if (PRIVACY_KEYS.includes(key)) {
            privacy.setConfig(key, value);
            // Ad blocking also drives the cosmetic preload — broadcast so it can
            // inject / remove element-hiding CSS live.
            if (key === 'adBlockEnabled') {
                webContents.getAllWebContents().forEach(wc => {
                    try {
                        wc.send('adblock-set-enabled', !!value);
                    }
                    catch (e) { log.debug('settings', 'settings-set', e); }
                });
            }
        }
        return true;
    });
    // Live tracking-protection stats for the Privacy settings panel.
    ipcMain.handle('privacy-get-stats', () => privacy.getStats());
    ipcMain.handle('settings-clear-history', async () => {
        try {
            return await wm.history.clearHistory();
        }
        catch {
            return false;
        }
    });
    // Clear browsing data across a time range. Note: Electron can't scope
    // cookies/cache/site-data to a time range, so those clear entirely when
    // selected; the range applies to history and download list.
    ipcMain.handle('clear-browsing-data', async (_e, payload) => {
        if (!isTrustedInternalSender(_e.sender)) {
            log.warn('settings', 'blocked clear-browsing-data from untrusted sender');
            return { ok: false };
        }
        const { session } = require('electron');
        const downloadManager = require('../features/download-manager');
        const { range = 'all', types = {} } = payload || {};
        const SPANS = { hour: 3600e3, day: 864e5, week: 6048e5, month: 24192e5, all: Infinity };
        const span = SPANS[range] ?? Infinity;
        const since = span === Infinity ? 0 : Date.now() - span;
        const sess = session.defaultSession;
        try {
            if (types.history) {
                await wm.history.clearSince(since);
            }
            if (types.downloads) {
                downloadManager.clearFinished();
            }
            if (types.cache) {
                await sess.clearCache();
            }
            if (types.cookies) {
                await sess.clearStorageData({
                    storages: ['cookies', 'localstorage', 'indexdb', 'websql',
                        'serviceworkers', 'cachestorage', 'filesystem', 'shadercache'],
                });
                try {
                    await sess.clearAuthCache();
                }
                catch (e) { log.debug('settings', 'clear-browsing-data', e); }
            }
            // Notify chrome so the history/bookmark UIs can refresh.
            try {
                wm.getAllWindows().forEach(w => w.window.webContents.send('browsing-data-cleared'));
            }
            catch (e) { log.debug('settings', 'clear-browsing-data', e); }
            return { ok: true };
        }
        catch (err) {
            return { ok: false, error: err.message };
        }
    });
    // section is optional ('passwords', 'extensions', …) — omitted opens the root.
    ipcMain.handle('open-settings-tab', (_e, section) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd?.tabs)
            wd.tabs.openInternalPage('settings', section || null);
    });
    /* `webContents` is a parameter of register(), so this lives here rather
       than at module scope — where it was, and where every save threw a
       ReferenceError *after* persisting, so the theme was stored and the UI
       was told the save had failed. */
    const broadcastThemes = () => {
        webContents.getAllWebContents().forEach(wc => {
            try { wc.send('themes-changed'); }
            catch (e) { log.debug('settings', 'broadcastThemes', e); }
        });
    };

    /* ── User themes ──────────────────────────────────────────────────────
       A theme is stored as its SEED (mode + ground + accent + optional ink),
       never as a token set: derived tokens are cheap to recompute and a stored
       token set would freeze today's ramp into every theme anyone ever saved. */
    ipcMain.handle('themes-list', () => {
        return { themes: themes.all(), current: wm.persistence.get('theme') };
    });
    // Preview without saving — the editor needs the real palette to paint a
    // swatch, and the contrast numbers to say why a pick is being refused.
    ipcMain.handle('theme-preview', (_e, seed) => {
        const check = themeDerive.validate(seed || {});
        if (!check.ok)
            return { ok: false, errors: check.errors, contrast: check.contrast || null };
        const { tokens, mode, icon } = themeDerive.derive(seed);
        return { ok: true, tokens, mode, icon, contrast: check.contrast };
    });
    /* Paint a seed on this window's surfaces without saving it. This is what a
       drag uses: no stylesheet swap, no disk write, no repaint of other
       windows — just the palette on screen while you move the dot. */
    ipcMain.handle('theme-live', (_e, seed) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd)
            return false;
        if (!seed) {
            themeRuntime.clearPreview(wm, wd);
            return true;
        }
        const check = themeDerive.validate(seed);
        if (!check.ok)
            return false;
        themeRuntime.previewLive(wm, wd, themeDerive.derive(seed).tokens);
        return true;
    });

    ipcMain.handle('theme-save', (_e, input) => {
        if (!trusted(_e, 'theme-save')) return { ok: false };
        const list = [...(wm.persistence.get('customThemes') || [])];
        const existing = input?.id ? list.find(t => t.id === input.id) : null;
        /* Honour the id the editor passes even on the FIRST save. Each scope
           (the global setting, or one space) edits a single deterministic slot —
           `custom:global`, `custom:sp<id>` — and every edit overwrites THAT slot
           in place. Without preserving the id, prepareCustom minted a fresh
           random one each time, which is exactly the accumulating "Blue 2, Blue
           3" list we are replacing with edit-in-place. */
        const prepared = themes.prepareCustom(input, input?.id || existing?.id || null);
        if (!prepared.ok)
            return { ok: false, errors: prepared.errors };
        if (existing) {
            list[list.indexOf(existing)] = prepared.theme;
        }
        else {
            list.push(prepared.theme);
        }
        wm.persistence.set('customThemes', list);
        /* Repaint unconditionally. The old check — "is this the global theme?" —
           missed every window whose SPACE wears this theme, so live editing
           showed nothing unless you happened to be editing the global one. */
        try { themeRuntime.clearPreview(wm, wm.getWindowByWebContents(_e.sender)); }
        catch (e) { log.debug('settings', 'clearPreview', e); }
        themeRuntime.repaintAll(wm);
        broadcastThemes();
        return { ok: true, theme: prepared.theme, contrast: prepared.contrast };
    });
    ipcMain.handle('theme-delete', (_e, id) => {
        if (!trusted(_e, 'theme-delete')) return { ok: false };
        const list = (wm.persistence.get('customThemes') || []).filter(t => t.id !== id);
        wm.persistence.set('customThemes', list);
        // Deleting the theme in use would otherwise leave every window wearing
        // a palette that no longer exists.
        if (wm.persistence.get('theme') === id) {
            wm.persistence.set('theme', 'default');
            themeRuntime.apply('default', wm);
        }
        broadcastThemes();
        return { ok: true };
    });

    ipcMain.handle('google-login', async (_e, clientId, clientSecret) => {
        if (!trusted(_e, 'google-login')) return { success: false, error: 'blocked' };
        try {
            const data = await loginWithGoogle(clientId, clientSecret);
            return { success: true, data };
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
    // ── Focus mode ─────────────────────────────────────────────────────────────
    ipcMain.handle('focus-mode-toggle', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd)
            return false;
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
        if (wd?.tabs)
            wd.tabs.collapseAllTabs();
    });
    ipcMain.on('overlay-close', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd?.tabs)
            wd.tabs.restoreAllTabs();
    });
    // ── Bookmark bar chrome ───────────────────────────────────────────────────
    // Forward bookmark-bar toggle from any view (e.g. menu) to the chrome renderer
    ipcMain.on('toggle-bookmark-bar', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd)
            wd.window.webContents.send('toggle-bookmark-bar');
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
        if (wd)
            wd.window.webContents.send('focus-address-bar');
    });
    // ── Window controls (minimize / maximize / close) ─────────────────────────
    ipcMain.handle('window-minimize', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd)
            wd.window.minimize();
    });
    ipcMain.handle('window-maximize', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd)
            return;
        if (wd.window.isMaximized())
            wd.window.unmaximize();
        else
            wd.window.maximize();
    });
    ipcMain.handle('window-close', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd)
            return;
        if (wd.tabs)
            wd.tabs.allowClose = true;
        wd.window.close();
    });
    ipcMain.handle('window-is-maximized', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        return wd ? wd.window.isMaximized() : false;
    });
}


module.exports = { register };