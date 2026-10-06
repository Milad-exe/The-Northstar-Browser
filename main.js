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
const path = require('path');
const UserAgent = require('./features/user-agent');
// A browser must not die because one deferred callback touched a destroyed
// window (e.g. a load callback firing after its window was closed). Log it and
// keep running — the same resilience Chrome has.
const log = require('./features/log');
process.on('uncaughtException', (err) => {
    log.error('main', 'uncaught exception (survived)', err);
});
// A rejected promise nobody awaited is the same class of bug and, until now,
// vanished entirely.
process.on('unhandledRejection', (reason) => {
    log.error('main', 'unhandled rejection (survived)', reason);
});
// Windows: tie the running process to the installed Start-menu/taskbar shortcut.
// electron-builder's NSIS installer stamps that shortcut with the appId as its
// AppUserModelID; without a matching setAppUserModelId() here Windows can't
// associate the live window with it, so the taskbar groups it on its own and the
// right-click jump list falls back to a stale/cached generic icon. Must be set
// before any window is created. (appId — keep in sync with build.appId.)
// A source run (npm start / npm run dev) gets its OWN id: with the installed
// app's, Windows grouped the dev window under the installed shortcut and drew
// THAT shortcut's icon — the one baked into the installed exe — so an icon
// change never showed in dev however the window's own icon was set.
if (process.platform === 'win32') {
    app.setAppUserModelId(app.isPackaged ? 'com.northstar.browser' : 'com.northstar.browser.dev');
}
// Single-instance lock — a browser must run as ONE process per profile.
// Without it, a second launch (or a previous run that hasn't fully exited)
// opens a rival process against the SAME profile directory, and the two fight
// over the Cache / GPUCache / Service Worker locks. Chromium then logs
// "Unable to move the cache: Access is denied (0x5)" / "Unable to create cache"
// and runs with the HTTP disk cache DISABLED — so every resource is re-fetched
// from the network (pages load slowly) and service-worker-backed sites
// (WhatsApp, Outlook, YouTube, …) fail to initialise. The second instance
// forwards its launch to the running one (which surfaces a window) and exits.
// `--user-data-dir` overrides the profile, so each such profile locks
// independently (used by the e2e harness). Must run before app.whenReady().
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
    // Another Northstar already owns this profile. In dev this is almost always
    // the INSTALLED app still open — say so plainly, because otherwise the dev
    // build just vanishes ("npm run dev did nothing").
    if (process.argv.includes('--dev')) {
        // eslint-disable-next-line no-console
        console.error('\n[dev] Northstar is already running (probably the installed app).\n' +
            '      Close it, then run `npm run dev` again — the dev build shares your\n' +
            '      real profile and can only run as the single instance.\n');
    }
    app.quit();
}
/* A signal is a QUIT, not a kill. Node ends the process on SIGTERM/SIGINT
   without ever reaching 'before-quit', which is where the session snapshot is
   written — so `npm run dev`'s restart, and any plain `pkill`, threw the whole
   window state away and every tab came back empty. Route them through
   app.quit() so the normal teardown runs; the guard is because a second signal
   arriving mid-quit must not restart the teardown. */
let quittingBySignal = false;
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    try {
        process.on(sig, () => {
            if (quittingBySignal)
                return;
            quittingBySignal = true;
            try { app.quit(); }
            catch (e) { process.exit(0); }
        });
    }
    catch (e) { log.debug('main', 'signal handler', e); }
}
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
// HTTP/3 (QUIC): opt every connection into the h3 handshake race. It is TLS 1.3
// underneath — no security trade-off — and Chromium already falls back to TCP
// where UDP/443 is blocked, so this only ever speeds up h3-capable CDNs. On by
// default in Chromium; asserted here so it stays on across Electron upgrades.
app.commandLine.appendSwitch('enable-quic');
// Use Chromium's built-in (mock) storage for its cookie/password encryption key
// instead of the OS keychain. This is a macOS concern ONLY: there, the keychain
// path pops a "wants to use your confidential information in <app> Safe Storage"
// prompt on every launch of an unsigned dev build, and this suppresses it. The
// switch is macOS-specific — applying it on Windows/Linux is meaningless and
// prints a Chromium notice about a keychain (a mac term) at startup, so it is
// gated. (Our own password store encrypts via features/encryption.js, so
// nothing depends on the OS store either way.)
if (process.platform === 'darwin')
    app.commandLine.appendSwitch('use-mock-keychain');
// Disable FedCM (the browser-native "Sign in with Google" flow). Chromium
// exposes navigator.credentials.get({identity}) + window.IdentityCredential, so
// Google Identity Services picks the FedCM path — but Electron doesn't render
// the FedCM account-chooser UI, so the request hangs forever and "Continue with
// Google" silently does nothing. Turning FedCM off makes GSI fall back to the
// popup OAuth flow, which we DO support (window.open popups open a real window
// with window.opener intact — see tabs.js setWindowOpenHandler).
app.commandLine.appendSwitch('disable-features', 'FedCm');
app.userAgentFallback = UserAgent.generate();
// ── Imports ──────────────────────────────────────────────────────────────────
const WindowManager = require('./features/window-manager');
const focusMode = require('./features/focus-mode');
const adBlocker = require('./features/ad-blocker');
const privacy = require('./features/privacy');
const permissionPrompt = require('./features/permission-prompt');
const permissionUI = require('./features/permission-ui');
const privateSessions = require('./features/private-session');
const downloadManager = require('./features/download-manager');
const appIcon = require('./features/app-icon');
const themes = require('./features/themes');
const themeRuntime = require('./features/theme-runtime');
const extensionManager = require('./features/extensions');
// IPC feature modules
const ipcRegistrar = require('./ipc');
const certErrors = require('./features/cert-errors');
const defaultBrowser = require('./features/default-browser');
// ── App ──────────────────────────────────────────────────────────────────────
class Northstar {
    windowManager;
    constructor() {
        this.windowManager = new WindowManager();
        this.registerIpc();
        this.initApp();
        // Test seam — exposes internals to the Playwright harness only when
        // NORTHSTAR_TEST=1. Gated on an UNPACKAGED build too, so a shipped binary
        // can never expose internals even if the env var is set.
        if (process.env.NORTHSTAR_TEST === '1' && !app.isPackaged) {
            global.__northstarTest = {
                wm: this.windowManager, focusMode, privacy, adBlocker,
                containers: require('./features/containers'),
                profiles: require('./features/profiles'),
                encryption: require('./features/encryption'),
                searchEngines: require('./features/search-engines'),
                zoom: require('./features/zoom'),
                defaultBrowser,
                certErrors,
                updates: require('./features/updates'),
                i18n: require('./features/i18n'),
                userData: require('./features/user-data'),
                history: require('./features/history'),
                searchEngines: require('./features/search-engines'),
                tabContextMenu: require('./features/tab-context-menu'),
                log,
            };
        }
    }
    registerIpc() {
        const deps = {
            wm: this.windowManager,
            webContents,
            BrowserWindow,
            screen,
            nativeTheme,
            app,
            focusMode,
        };
        // Every ipc/<area>.js that exports register() is wired up automatically
        // (see ipc/index.js) — a new one needs no edit here.
        ipcRegistrar.registerAll(ipcMain, deps);
        // permissionUI lives in features/, not ipc/, so it is registered by hand.
        permissionUI.register(ipcMain, deps); // doorhanger controller: init(wm) + IPC
    }
    initApp() {
        // TLS failures get a real interstitial (what's wrong, which certificate,
        // an informed way through) instead of the generic network error page.
        certErrors.register(app);
        /* Open what the OS hands us — open-url on macOS, argv on Windows and
           Linux — so a link that arrives lands in a tab rather than nowhere.

           This deliberately does NOT call registerProtocols(). That runs
           setAsDefaultProtocolClient('http'/'https'), which on macOS makes the
           SYSTEM put up "change your default browser?" — and it ran on every
           single launch, so the answer was asked for again every time the app
           started. It was never needed to appear in the OS's browser list
           either: the packaged Info.plist already declares both schemes
           (build.protocols in package.json), which is what puts Northstar
           there. Registering is now what the "Make default" button in Settings
           does, when the user actually asks for it. */
        try {
            defaultBrowser.init(this.windowManager);
        }
        catch (e) {
            log.warn('main', 'link intake setup failed', e);
        }
        app.whenReady().then(async () => {
            themes.bind(this.windowManager.persistence);
            // Spaces can carry their own theme, so a surface resolves through
            // the window it belongs to before falling back to the global one.
            themeRuntime.bind({ wm: this.windowManager, profiles: require('./features/profiles') });
            const savedTheme = this.windowManager.persistence.get('theme');
            // `mode` comes from the registry now: it used to be a hardcoded
            // list of two ids, so any theme added after it — and every theme a
            // user makes — booted with the wrong nativeTheme and native
            // widgets (scrollbars, pickers) came up in the wrong scheme.
            nativeTheme.themeSource = themes.modeOf(savedTheme) === 'light' ? 'light' : 'dark';
            /* The icon follows the theme (features/app-icon.js), and it is set
               FIRST — before Widevine, before any window. Two things used to
               leave the wrong mark in the dock at launch:

                 - this ran after `await components.whenReady()`, so for as long
                   as the CDM took to load the dock showed whatever the bundle
                   carried, then visibly swapped;
                 - it was skipped entirely for the default theme, on the grounds
                   that the bundle icon is built from `default`. That holds for a
                   packaged build and nowhere else: run from source the dock
                   belongs to Electron, and a bundle whose .icns predates a
                   redesign keeps showing the old mark for the whole session,
                   because nothing ever overrides it.

               Setting it unconditionally, early, costs one nativeImage read.
               The per-theme PNGs carry the macOS safe-area margin (824 in 1024)
               so this does not render larger than the bundle icon it replaces.

               What this CANNOT fix: between the process starting and
               `whenReady` firing, the dock shows the bundle icon, which is
               built from `default`. On a non-default theme that flash is the
               OS's, not ours. */
            appIcon.apply(savedTheme || 'default', this.windowManager);
            // Derived + user themes have no CSS in the stylesheets; every surface
            // gets its tokens injected as it loads (features/theme-runtime.js).
            app.on('web-contents-created', (_ev, wc) => themeRuntime.attach(wc));
            // Widevine CDM (castlabs Electron build) — required to decrypt DRM
            // video such as Crunchyroll / Netflix / Spotify. No-op on a vanilla
            // Electron binary.
            //
            // PERF: this is loaded IN PARALLEL, not awaited, so the CDM (which can
            // take several hundred ms to a second) no longer blocks the first
            // window from painting. The CDM only has to be ready before DRM
            // *playback* begins — which is long after startup, once a user visits
            // a streaming site and hits play — not before a window exists. The
            // session's security setup below (privacy, permissions, preloads)
            // still runs before any window is created; only this DRM load moved
            // off the critical path.
            try {
                const { components } = require('electron');
                if (components && components.whenReady) {
                    components.whenReady()
                        .then(() => log.debug('main', 'Widevine components ready'))
                        .catch((e) => log.warn('main', 'Widevine components load failed', e));
                }
            }
            catch (e) {
                log.warn('main', 'Widevine components load failed', e);
            }
            // The classic menu bar (File / Edit / View / History / Bookmarks /
            // Profiles / Tools / Help), built in features/app-menu.js. On the
            // system menu bar on macOS; on Windows/Linux it is hidden until Alt
            // is pressed (Firefox-style — window-manager.js sets autoHideMenuBar).
            // Its accelerators are display-only off macOS so they do not
            // double-fire against before-input-event (see app-menu.js).
            try { require('./features/app-menu').install(this.windowManager); }
            catch (e) { log.warn('main', 'app-menu', e); }
            // Spell check: Settings → Languages owns it, for EVERY session (each
            // space, container and private tab has its own). Context-menu
            // suggestions/add-to-dictionary are wired in tab-context-menu.js.
            try { require('./features/spellcheck').init(this.windowManager.persistence); }
            catch (e) { log.warn('main', 'spell check', e); }
            // Ad blocking — network-level (cancel requests) + cosmetic (hide elements).
            // NOT awaited: parsing ~250k filter rules must not delay the first
            // window. Until it finishes, shouldBlock() just returns false.
            adBlocker.init().catch(() => { });
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
            }
            catch (e) { log.debug('main', 'cycle', e); }
            // Private sessions are created PER TAB (Features/private-session.js
            // createTabSession) — each private tab gets its own in-memory
            // partition with the full hardening stack, so no cookies/cache/
            // storage ever carry over between tabs, private or not.
            // Download manager — standard auto-save to the Downloads folder
            // with progress in the toolbar panel. Private tab sessions attach
            // their own handler at creation; all sessions share one list.
            downloadManager.attach(session.defaultSession);
            // Align the JS environment with the Chrome UA (userAgentData brands,
            // window.chrome surface) so Google/Cloudflare consistency checks pass.
            session.defaultSession.registerPreloadScript({
                type: 'frame',
                id: 'chrome-spoof',
                filePath: path.join(__dirname, 'preload/chrome-spoof.js'),
            });
            // Cosmetic ad hiding — inject CSS to suppress ad containers not caught
            // at the network level.
            session.defaultSession.registerPreloadScript({
                type: 'frame',
                id: 'ad-block-cosmetic',
                filePath: path.join(__dirname, 'preload/ad-block-cosmetic.js'),
            });
            // Permissions: standard — device/resource access (camera, mic,
            // location, notifications) is blocked by default and pops a prompt;
            // "Remember this decision" persists per-origin and shows in the
            // lock-icon site-info panel. Sensitive unprompted permissions
            // (USB/serial/HID/bluetooth, storage-access, …) are denied outright.
            permissionPrompt.attach(session.defaultSession);
            // First window opens as the profile the tab state was saved under, so
            // restore lands in the right profile.
            let startProfile = '1';
            try { startProfile = String(this.windowManager.persistence.loadState()?.profile || '1'); }
            catch (e) { log.debug('main', 'cycle', e); }
            // Print which build this is, right up front — so a stale `npm start`
            // or the packaged-vs-source mix-up is obvious in the terminal.
            try { log.info('main', require('./features/build-info').label()); }
            catch (e) { log.debug('main', 'build-info', e); }
            this.windowManager.createWindow(800, 600, { profile: startProfile });
            // First launch: offer the import wizard once, the way other browsers
            // do — but only if there is actually another browser to import from.
            setTimeout(() => {
                try {
                    const p = this.windowManager.persistence;
                    if (p.get('importPrompted'))
                        return;
                    const importer = require('./features/import');
                    if (importer.detectSources().length) {
                        const wd = this.windowManager.getPrimaryWindow();
                        if (wd?.window && !wd.window.isDestroyed())
                            require('./ipc/import-wizard').open(wd.window, wd.profileId || startProfile);
                    }
                    p.set('importPrompted', true);
                }
                catch (e) { log.debug('main', 'import prompt', e); }
            }, 1400);
            // Captive-portal check on startup: public Wi-Fi that needs a sign-in
            // is caught before the user tries to browse, and its login page opens
            // automatically. (Also re-checked whenever a page load fails — see
            // tabs.js did-fail-load.)
            setTimeout(() => {
                try {
                    const captivePortal = require('./features/captive-portal');
                    captivePortal.check((loginUrl) => {
                        const wd = this.windowManager.getPrimaryWindow && this.windowManager.getPrimaryWindow();
                        if (wd && wd.tabs)
                            wd.tabs.openCaptivePortalSignIn(loginUrl);
                    });
                }
                catch (e) { log.debug('main', 'cycle', e); }
            }, 2500);
            // Housekeeping: once tabs have restored, drop dormant isolated sessions
            // (no open tab + no stored login) so they don't accumulate on disk.
            setTimeout(() => {
                try {
                    const containers = require('./features/containers');
                    const active = new Set();
                    for (const wd of this.windowManager.windows.values())
                        for (const id of (wd.tabs?.tabContainers?.values?.() || []))
                            active.add(id);
                    containers.gc(active);
                }
                catch (e) { log.debug('main', 'cycle', e); }
            }, 6000);
            // Dev live reload (--dev): edits under app/renderer refresh the UI
            // instantly — internal pages reload; the chrome hot-swaps CSS only
            // (a full chrome reload would drop the tab strip's runtime state).
            if (process.argv.includes('--dev')) {
                const fs = require('fs');
                let reloadTimer = null;
                /* Reload only on a REAL edit. On Windows fs.watch fires 'change'
                   for file ACCESS too, and opening any panel loadFile-READS its
                   renderer/*.html — indistinguishable from an edit by event alone.
                   Reloading on those blanked EVERY overlay at once (a white flash
                   across the whole UI) every time a panel opened. Gate exactly as
                   scripts/dev.js does: past a startup settle window, the file's
                   mtime must be newer than launch (so a read of a pre-existing
                   file is ignored) AND newer than the last time we saw it (so a
                   re-read of an already-edited file is ignored). */
                const devStartedAt = Date.now();
                const SETTLE_MS = 1800;
                const seenMtime = new Map();
                try {
                    fs.watch(path.join(__dirname, 'renderer'), { recursive: true }, (_e, rel) => {
                        if (!rel || Date.now() - devStartedAt < SETTLE_MS)
                            return;
                        const p = String(rel).split(path.sep).join('/');
                        if (!/\.(js|html|css)$/.test(p))
                            return;
                        let mtime = 0;
                        try { mtime = fs.statSync(path.join(__dirname, 'renderer', rel)).mtimeMs; }
                        catch { return; } // vanished / temp file
                        const prev = seenMtime.get(rel) || 0;
                        seenMtime.set(rel, mtime);
                        if (mtime <= prev || mtime < devStartedAt)
                            return; // a read/touch, not a write since launch → spurious
                        clearTimeout(reloadTimer);
                        reloadTimer = setTimeout(() => {
                            const { frameAlive } = require('./features/wc-ready');
                            for (const wc of webContents.getAllWebContents()) {
                                if (!frameAlive(wc))
                                    continue;
                                const url = wc.getURL();
                                if (!url.startsWith('file://'))
                                    continue;
                                if (url.includes('/Browser/index.html')) {
                                    wc.executeJavaScript(`document.querySelectorAll('link[rel=stylesheet]').forEach(l=>{const u=new URL(l.href);u.searchParams.set('t',Date.now());l.href=u.toString();})`).catch(() => { });
                                }
                                else {
                                    wc.reloadIgnoringCache();
                                }
                            }
                        }, 300);
                    });
                }
                catch (e) { log.debug('main', 'cycle', e); }
            }
            // Extensions — enable Chrome Web Store install + reload persisted
            // extensions and set up the chrome.* APIs. Runs AFTER the first
            // window so extension loading never delays startup; any tabs created
            // in the meantime are registered with the extension system once ready.
            extensionManager.setup(session.defaultSession, this.windowManager)
                .then(() => {
                for (const wd of this.windowManager.getAllWindows()) {
                    try {
                        wd.tabs?.tabMap.forEach(tab => extensionManager.addTab(tab.webContents, wd.window));
                    }
                    catch (e) { log.debug('main', 'cycle', e); }
                }
            })
                .catch(() => { });
            app.on('activate', () => {
                if (BrowserWindow.getAllWindows().length === 0) {
                    this.windowManager.createWindow();
                }
            });
            // A second launch (blocked by the single-instance lock) forwards here.
            // Behave like a browser: surface an existing window, or open a new one.
            app.on('second-instance', () => {
                try {
                    const primary = this.windowManager.getPrimaryWindow();
                    const win = primary?.window;
                    if (win && !win.isDestroyed()) {
                        if (win.isMinimized())
                            win.restore();
                        win.show();
                        win.focus();
                    }
                    else {
                        this.windowManager.createWindow();
                    }
                }
                catch {
                    try {
                        this.windowManager.createWindow();
                    }
                    catch (e) { log.debug('main', 'cycle', e); }
                }
            });
        });
        app.on('before-quit', () => {
            // Persist from the primary window synchronously before all windows close
            try {
                this.windowManager.savePrimaryState();
            }
            catch (e) { log.debug('main', 'cycle', e); }
            try {
                this.windowManager.getAllWindows().forEach(w => {
                    if (w?.tabs)
                        w.tabs.allowClose = true;
                });
            }
            catch (e) { log.debug('main', 'cycle', e); }
            // Wipe every per-tab private session unconditionally on quit —
            // covers private tabs/windows still open when the user quits.
            try {
                privateSessions.wipeAll();
            }
            catch (e) { log.debug('main', 'cycle', e); }
        });
        app.on('window-all-closed', () => {
            if (process.platform !== 'darwin')
                app.quit();
        });
    }
}
// ── Bootstrap ─────────────────────────────────────────────────────────────────
// Only the instance that owns the single-instance lock builds the app; a second
// launch has already been told to quit above (and forwarded via 'second-instance').
if (gotSingleInstanceLock) {
    new Northstar();
}
