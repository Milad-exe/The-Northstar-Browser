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
const Bruno              = require('./Features/Bruno');
const focusMode          = require('./Features/focus-mode');
const adBlocker          = require('./Features/ad-blocker');
const privateSessionSetup = require('./Features/private-session');

// IPC feature modules
const tabsIpc          = require('./ipc/tabs');
const menuIpc          = require('./ipc/menu');
const suggestionsIpc   = require('./ipc/suggestions');
const historyIpc       = require('./ipc/history');
const bookmarksIpc     = require('./ipc/bookmarks');
const folderDropdownIpc = require('./ipc/folder-dropdown');
const settingsIpc      = require('./ipc/settings');

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
    }

    initApp() {
        app.whenReady().then(async () => {
            const savedTheme = this.windowManager.persistence.get('theme');
            nativeTheme.themeSource = (savedTheme === 'chalk' || savedTheme === 'mist') ? 'light' : 'dark';

            app.dock?.setIcon(path.join(__dirname, 'logo.png')); // macOS only

            // Apply Firefox UA + privacy headers to every request on the default session
            UserAgent.setupSession(session.defaultSession);
            Menu.setApplicationMenu(null);

            // Ad blocking — network-level (cancel requests) + cosmetic (hide elements).
            // init() loads the cached filter list synchronously then refreshes in background.
            await adBlocker.init();
            adBlocker.enableBlockingInSession(session.defaultSession);

            // DNS-over-HTTPS — routes all resolver queries through Cloudflare's DoH.
            // Must be called after app.whenReady().
            try {
                app.configureHostResolver({
                    secureDnsMode:    'secure',
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

            // Inject window.chrome spoof into every web page so Google doesn't
            // redirect to the "unsupported browser" page.
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

            // Bruno panel — registers its own IPC handlers internally
            new Bruno();

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

const inkInstance = new Ink();
global.inkInstance = inkInstance; // Bruno feature needs global access
