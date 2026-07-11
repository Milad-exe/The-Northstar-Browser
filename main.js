/**
 * Northstar — main process entry point.
 *
 * Responsibilities:
 *  - Bootstrap Electron (flags, UA fallback, session setup)
 *  - Create the first BrowserWindow via WindowManager
 *  - Register all IPC handlers by delegating to feature modules in ipc/
 *
 * IPC modules:
 *  ipc/tabs.js           — tab CRUD, navigation, drag-drop across windows, persist mode
 *  ipc/menu.js           — hamburger menu overlay + click-outside dismissal
 *  ipc/suggestions.js    — URL/search autocomplete overlay
 *  ipc/history.js        — browsing history read/search
 *  ipc/bookmarks.js      — bookmark CRUD, bar context menu, bookmark-prompt overlay
 *  ipc/folder-dropdown.js — folder cascade panel + extern bookmark drag
 *  ipc/settings.js       — settings, focus mode, window controls, chrome layout
 */

// ── Pre-ready flags (must run before app.whenReady) ──────────────────────────

const { app, ipcMain, session, BrowserWindow, Menu, webContents, nativeTheme, screen } = require('electron');
const path          = require('path');
const UserAgent     = require('./Features/user-agent');

app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
// Use Chromium's built-in (mock) storage for its cookie/password encryption key
// instead of the OS keychain. The keychain path makes macOS pop a "wants to use
// your confidential information in <app> Safe Storage" prompt on every launch of
// an unsigned dev build; this suppresses it. (Our own password store encrypts
// via Features/encryption.js, so nothing depends on the keychain.)
app.commandLine.appendSwitch('use-mock-keychain');
app.userAgentFallback = UserAgent.generate();

// ── Imports ──────────────────────────────────────────────────────────────────
const WindowManager      = require('./Features/window-manager');
const focusMode          = require('./Features/focus-mode');
const adBlocker          = require('./Features/ad-blocker');
const privacy            = require('./Features/privacy');
const sitePermissions    = require('./Features/site-permissions');
const privateSessionSetup = require('./Features/private-session');
const downloadManager    = require('./Features/download-manager');
const extensionManager   = require('./Features/extensions');

// IPC feature modules
const tabsIpc          = require('./ipc/tabs');
const menuIpc          = require('./ipc/menu');
const suggestionsIpc   = require('./ipc/suggestions');
const historyIpc       = require('./ipc/history');
const bookmarksIpc     = require('./ipc/bookmarks');
const folderDropdownIpc = require('./ipc/folder-dropdown');
const settingsIpc      = require('./ipc/settings');
const downloadsIpc     = require('./ipc/downloads');
const extensionsIpc    = require('./ipc/extensions');
const passwordsIpc     = require('./ipc/passwords');
const siteInfoIpc      = require('./ipc/site-info');
const miniPlayerIpc    = require('./ipc/mini-player');

// ── App ──────────────────────────────────────────────────────────────────────

class Northstar {
    constructor() {
        this.windowManager = new WindowManager();
        this.registerIpc();
        this.initApp();
    }

    registerIpc() {
        const deps = {
            wm:           this.windowManager,
            webContents,
            BrowserWindow,
            screen,
            nativeTheme,
            app,
            focusMode,
        };
        tabsIpc.register(ipcMain, deps);
        menuIpc.register(ipcMain, deps);
        suggestionsIpc.register(ipcMain, deps);
        historyIpc.register(ipcMain, deps);
        bookmarksIpc.register(ipcMain, deps);
        folderDropdownIpc.register(ipcMain, deps);
        settingsIpc.register(ipcMain, deps);
        downloadsIpc.register(ipcMain, deps);
        extensionsIpc.register(ipcMain, deps);
        passwordsIpc.register(ipcMain, deps);
        siteInfoIpc.register(ipcMain, deps);
        miniPlayerIpc.register(ipcMain, deps);
    }

    initApp() {
        app.whenReady().then(async () => {
            // Widevine CDM (castlabs Electron build) — required to decrypt DRM
            // video such as Crunchyroll / Netflix / Spotify. Must finish loading
            // before any window is created. No-op on a vanilla Electron binary.
            try {
                const { components } = require('electron');
                if (components && components.whenReady) await components.whenReady();
            } catch (e) { console.error('Widevine components load failed:', e && e.message); }

            const savedTheme = this.windowManager.persistence.get('theme');
            nativeTheme.themeSource = (savedTheme === 'chalk' || savedTheme === 'mist') ? 'light' : 'dark';

            app.dock?.setIcon(path.join(__dirname, 'logo.png')); // macOS only

            Menu.setApplicationMenu(null);

            // Spellchecker — enable and set languages (OS locale + English fallback).
            // Context-menu suggestions/add-to-dictionary are wired in tab-context-menu.js.
            try {
                const sess = session.defaultSession;
                sess.setSpellCheckerEnabled(true);
                const available = sess.availableSpellCheckerLanguages || [];
                const wanted = [app.getLocale(), 'en-US'].filter(Boolean);
                const langs = [...new Set(wanted)].filter(l => !available.length || available.includes(l));
                sess.setSpellCheckerLanguages(langs.length ? langs : ['en-US']);
            } catch {}

            // Ad blocking — network-level (cancel requests) + cosmetic (hide elements).
            // NOT awaited: parsing ~250k filter rules must not delay the first
            // window. Until it finishes, shouldBlock() just returns false.
            adBlocker.init().catch(() => {});
            // The privacy orchestrator owns the default session's request pipeline:
            // ad/tracker blocking + HTTPS upgrade + tracking-param stripping +
            // GPC/DNT signals + referer / third-party-cookie hygiene. Each layer is
            // toggled live from Settings → Privacy; ipc/settings.js seeds it from disk.
            privacy.setup(session.defaultSession);

            // DNS — respect the OS / VPN resolver instead of forcing a specific
            // DoH provider. Forcing Cloudflare (1.1.1.1) bypasses a VPN's own DNS,
            // so geo-routed CDNs (video / streaming) resolve to an edge that isn't
            // reachable through the tunnel and the connection is reset during the
            // TLS handshake (ERR_CONNECTION_RESET). 'automatic' still upgrades to
            // DoH when the system resolver advertises it. Must run after ready.
            try {
                app.configureHostResolver({ secureDnsMode: 'automatic' });
            } catch {}

            // Private session — in-memory only, nothing persisted to disk.
            // partition without 'persist:' prefix = no disk writes.
            const privateSession = session.fromPartition('private', { cache: false });
            // privateSessionSetup replaces UserAgent.setupSession — Electron only allows ONE
            // onBeforeSendHeaders listener per session; the combined handler covers UA spoof,
            // Sec-GPC, Accept-Language normalization, cross-origin Referer stripping, and
            // response-side Referrer-Policy / X-DNS-Prefetch-Control injection.
            privateSessionSetup.setup(privateSession);
            adBlocker.enableBlockingInSession(privateSession);

            // Download manager — Firefox-style auto-save to the Downloads folder
            // with progress in the toolbar panel. Both sessions share one list.
            downloadManager.attach(session.defaultSession);
            downloadManager.attach(privateSession, { private: true });
            privateSession.registerPreloadScript({
                type: 'frame', id: 'chrome-spoof-private',
                filePath: path.join(__dirname, 'preload/chrome-spoof.js'),
            });
            privateSession.registerPreloadScript({
                type: 'frame', id: 'adblock-cosmetic-private',
                filePath: path.join(__dirname, 'preload/ad-block-cosmetic.js'),
            });
            privateSession.registerPreloadScript({
                type: 'frame', id: 'private-hardening',
                filePath: path.join(__dirname, 'preload/private-hardening.js'),
            });

            // Align the JS environment with the Chrome UA (userAgentData brands,
            // window.chrome surface) so Google/Cloudflare consistency checks pass.
            session.defaultSession.registerPreloadScript({
                type:     'frame',
                id:       'chrome-spoof',
                filePath: path.join(__dirname, 'preload/chrome-spoof.js'),
            });

            // Cosmetic ad hiding — inject CSS to suppress ad containers not caught
            // at the network level.
            session.defaultSession.registerPreloadScript({
                type:     'frame',
                id:       'ad-block-cosmetic',
                filePath: path.join(__dirname, 'preload/ad-block-cosmetic.js'),
            });

            // Permissions: allow by default, but honour any per-site "Block" set
            // from the lock-icon site-info panel. Maps Electron permission names
            // to the ones the panel manages.
            const permAllowed = (origin, permission, details) => {
                if (!origin) return true;
                if (permission === 'geolocation')   return sitePermissions.decide(origin, 'location');
                if (permission === 'notifications')  return sitePermissions.decide(origin, 'notifications');
                if (permission === 'media') {
                    const types = (details && details.mediaTypes) || [];
                    if (types.includes('video') && !sitePermissions.decide(origin, 'camera'))     return false;
                    if (types.includes('audio') && !sitePermissions.decide(origin, 'microphone')) return false;
                    return true;
                }
                return true; // everything else keeps the allow-all behaviour
            };
            session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
                const origin = sitePermissions.originOf((details && details.requestingUrl) || wc?.getURL?.() || '');
                cb(permAllowed(origin, permission, details));
            });
            session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
                return permAllowed(sitePermissions.originOf(requestingOrigin || ''), permission, details);
            });

            this.windowManager.createWindow();

            // Extensions — enable Chrome Web Store install + reload persisted
            // extensions and set up the chrome.* APIs. Runs AFTER the first
            // window so extension loading never delays startup; any tabs created
            // in the meantime are registered with the extension system once ready.
            extensionManager.setup(session.defaultSession, this.windowManager)
                .then(() => {
                    for (const wd of this.windowManager.getAllWindows()) {
                        try {
                            wd.tabs?.tabMap.forEach(tab => extensionManager.addTab(tab.webContents, wd.window));
                        } catch {}
                    }
                })
                .catch(() => {});

            app.on('activate', () => {
                if (BrowserWindow.getAllWindows().length === 0) {
                    this.windowManager.createWindow();
                }
            });
        });

        app.on('before-quit', () => {
            // Persist from the primary window synchronously before all windows close
            try { this.windowManager.savePrimaryState(); } catch {}
            try {
                this.windowManager.getAllWindows().forEach(w => {
                    if (w?.tabs) w.tabs.allowClose = true;
                });
            } catch {}
            // Wipe the private session unconditionally on quit — covers the case
            // where private tabs/windows are still open when the user quits.
            try {
                const priv = session.fromPartition('private', { cache: false });
                priv.clearStorageData();
                priv.clearCache();
                priv.clearHostResolverCache();
                priv.clearAuthCache();
            } catch {}
        });

        app.on('window-all-closed', () => {
            if (process.platform !== 'darwin') app.quit();
        });
    }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

new Northstar();
