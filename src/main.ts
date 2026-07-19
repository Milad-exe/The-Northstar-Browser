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

import { app, ipcMain, session, BrowserWindow, Menu, webContents, nativeTheme, screen } from 'electron';
import path from 'path';
import UserAgent from './features/user-agent';
// A browser must not die because one deferred callback touched a destroyed
// window (e.g. a load callback firing after its window was closed). Log it and
// keep running — the same resilience Chrome has.
process.on('uncaughtException', (err) => {
    console.error('[main] uncaught exception (survived):', (err && err.stack) || err);
});

app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
// Use Chromium's built-in (mock) storage for its cookie/password encryption key
// instead of the OS keychain. The keychain path makes macOS pop a "wants to use
// your confidential information in <app> Safe Storage" prompt on every launch of
// an unsigned dev build; this suppresses it. (Our own password store encrypts
// via Features/encryption.js, so nothing depends on the keychain.)
app.commandLine.appendSwitch('use-mock-keychain');
app.userAgentFallback = UserAgent.generate();

// ── Imports ──────────────────────────────────────────────────────────────────
import WindowManager from './features/window-manager';
import focusMode from './features/focus-mode';
import adBlocker from './features/ad-blocker';
import * as privacy from './features/privacy';
import * as permissionPrompt from './features/permission-prompt';
import * as permissionUI from './features/permission-ui';
import * as privateSessions from './features/private-session';
import downloadManager from './features/download-manager';
import extensionManager from './features/extensions';
// IPC feature modules
import * as tabsIpc from './ipc/tabs';
import * as menuIpc from './ipc/menu';
import * as suggestionsIpc from './ipc/suggestions';
import * as historyIpc from './ipc/history';
import * as bookmarksIpc from './ipc/bookmarks';
import * as folderDropdownIpc from './ipc/folder-dropdown';
import * as settingsIpc from './ipc/settings';
import * as downloadsIpc from './ipc/downloads';
import * as extensionsIpc from './ipc/extensions';
import * as passwordsIpc from './ipc/passwords';
import * as siteInfoIpc from './ipc/site-info';
import * as miniPlayerIpc from './ipc/mini-player';
// ── App ──────────────────────────────────────────────────────────────────────

class Northstar {
    windowManager: WindowManager;

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
        permissionUI.register(ipcMain, deps); // doorhanger controller: init(wm) + IPC
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
            nativeTheme.themeSource = (savedTheme === 'porcelain' || savedTheme === 'dune') ? 'light' : 'dark';

            // No dock.setIcon: the bundle icon (icon.icns) is already the Northstar
            // mark. Overriding it at runtime with a full-bleed PNG made the dock
            // icon render edge-to-edge — larger than the padded bundle rendering —
            // so it visibly "expanded" the moment the app finished launching.

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

            // Private sessions are created PER TAB (Features/private-session.js
            // createTabSession) — each private tab gets its own in-memory
            // partition with the full hardening stack, so no cookies/cache/
            // storage ever carry over between tabs, private or not.

            // Download manager — Firefox-style auto-save to the Downloads folder
            // with progress in the toolbar panel. Private tab sessions attach
            // their own handler at creation; all sessions share one list.
            downloadManager.attach(session.defaultSession);

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

            // Permissions: Firefox-style — device/resource access (camera, mic,
            // location, notifications) is blocked by default and pops a prompt;
            // "Remember this decision" persists per-origin and shows in the
            // lock-icon site-info panel. Sensitive unprompted permissions
            // (USB/serial/HID/bluetooth, storage-access, …) are denied outright.
            permissionPrompt.attach(session.defaultSession);

            this.windowManager.createWindow();

            // Dev live reload (--dev): edits under app/renderer refresh the UI
            // instantly — internal pages reload; the chrome hot-swaps CSS only
            // (a full chrome reload would drop the tab strip's runtime state).
            if (process.argv.includes('--dev')) {
                const fs = require('fs');
                let reloadTimer = null;
                try {
                    fs.watch(path.join(__dirname, 'renderer'), { recursive: true }, () => {
                        clearTimeout(reloadTimer);
                        reloadTimer = setTimeout(() => {
                            for (const wc of webContents.getAllWebContents()) {
                                const url = wc.getURL();
                                if (!url.startsWith('file://')) continue;
                                if (url.includes('/Browser/index.html')) {
                                    wc.executeJavaScript(
                                        `document.querySelectorAll('link[rel=stylesheet]').forEach(l=>{const u=new URL(l.href);u.searchParams.set('t',Date.now());l.href=u.toString();})`
                                    ).catch(() => {});
                                } else {
                                    wc.reloadIgnoringCache();
                                }
                            }
                        }, 300);
                    });
                } catch {}
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
            // Wipe every per-tab private session unconditionally on quit —
            // covers private tabs/windows still open when the user quits.
            try { privateSessions.wipeAll(); } catch {}
        });

        app.on('window-all-closed', () => {
            if (process.platform !== 'darwin') app.quit();
        });
    }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

new Northstar();
