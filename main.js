/**
 * Ink Browser — main process entry point.
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
app.userAgentFallback = UserAgent.generate();

// ── Imports ──────────────────────────────────────────────────────────────────
const WindowManager      = require('./Features/window-manager');
const focusMode          = require('./Features/focus-mode');
const adBlocker          = require('./Features/ad-blocker');
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

// ── App ──────────────────────────────────────────────────────────────────────

class Ink {
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
    }

    initApp() {
        app.whenReady().then(async () => {
            const savedTheme = this.windowManager.persistence.get('theme');
            nativeTheme.themeSource = (savedTheme === 'chalk' || savedTheme === 'mist') ? 'light' : 'dark';

            app.dock?.setIcon(path.join(__dirname, 'logo.png')); // macOS only

            // Apply the Chrome UA + header normalization to the default session
            UserAgent.setupSession(session.defaultSession);
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
            // init() loads the cached filter list synchronously then refreshes in background.
            await adBlocker.init();
            adBlocker.enableBlockingInSession(session.defaultSession);

            // Extensions — enable Chrome Web Store install + reload persisted
            // extensions into the default session, and set up the chrome.* API
            // implementation. Non-fatal if it fails.
            await extensionManager.setup(session.defaultSession, this.windowManager).catch(() => {});

            // DNS-over-HTTPS — prefer Cloudflare's DoH but fall back to the system
            // resolver. 'secure' (DoH-only) stalls every page load on networks
            // that block or throttle 1.1.1.1, which made URLs slow or entirely
            // unreachable. Must be called after app.whenReady().
            try {
                app.configureHostResolver({
                    secureDnsMode:    'automatic',
                    secureDnsServers: ['https://1.1.1.1/dns-query', 'https://1.0.0.1/dns-query'],
                });
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

            // Allow all permission requests (camera, mic, notifications, etc.)
            session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(true));

            this.windowManager.createWindow();

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

new Ink();
