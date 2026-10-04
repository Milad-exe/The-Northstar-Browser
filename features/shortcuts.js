const log = require('./log');
const zoom = require('./zoom');
const { app } = require('electron');
const focusMode = require('./focus-mode');
const profiles = require('./profiles'); // spaces, for P2-6 space-switch shortcuts
class Shortcuts {
    mainWindow; // BrowserWindow this shortcut set is bound to
    tabManager; // Tabs instance for that window
    windowManager; // WindowManager — for new-window shortcuts
    shortcuts;
    constructor(mainWindow, tabManager, windowManager = null) {
        this.mainWindow = mainWindow;
        this.tabManager = tabManager;
        this.windowManager = windowManager;
        this.shortcuts = new Map();
        this.setupEventListeners();
    }
    // Keyboard shortcuts are delivered by a SINGLE app-level route, installed
    // once in WindowManager (see WindowManager._routeShortcuts): every
    // webContents — the chrome, each tab, and every overlay (hamburger menu,
    // omnibox, panels, prompts) — forwards `before-input-event` to its window's
    // Shortcuts.handleInput. A key event only ever reaches the ONE webContents
    // that holds keyboard focus, so routing them ALL through one place is what
    // makes a shortcut fire regardless of which surface is focused.
    //
    // This used to be wired per-webContents from here, and only the chrome and
    // the tabs got a listener — which is exactly why a shortcut like Ctrl+H or
    // Ctrl+, worked only while a TAB held focus: open the hamburger menu or click
    // into the address bar and the focused overlay, having no listener, swallowed
    // the key. These methods are kept as no-ops for their existing call sites.
    setupEventListeners() { }
    setupAllTabListeners() { }
    setupTabListener(_tab) { }
    onTabCreated(_tab) { }
    registerWebContents(_wc) { }
    unregisterWebContents(_wc) { }
    // Callbacks may return false to suppress preventDefault (lets the event reach the page).
    handleInput(event, input) {
        // A bare Alt tap toggles the in-chrome menu bar (Windows only — mac has
        // the system bar, Linux the native framed bar). Tracked across the whole
        // keystroke, so it must run for keyUp too, before the keyDown-only gate.
        this._trackAltTap(input);
        if (input.type !== 'keyDown')
            return;
        // While the in-chrome menu bar is open it owns the keyboard: drive its
        // mnemonics and arrows from HERE, before the shortcut table, because this
        // handler sees every keystroke (via the central before-input-event route)
        // no matter which surface holds OS focus — the bar opens over a page whose
        // native view keeps focus, so a renderer-side key listener would never
        // receive the letter. preventDefault keeps the key off the page.
        if (this._routeMenuBarKey(input)) {
            event.preventDefault();
            return;
        }
        for (const [accelerator, callback] of this.shortcuts) {
            if (this.matchesAccelerator(input, accelerator)) {
                // A shortcut firing while the context menu is up dismisses it
                // first — it should go away when another shortcut takes over,
                // not sit on top of the state the shortcut just changed. The
                // menu took keyboard focus, so this keystroke arrived through
                // IT; done before the callback so what the shortcut opens wins.
                try {
                    const wd = this.getWindowData();
                    if (wd?.ctxMenuOpen)
                        require('./overlay-menu').hide(wd);
                }
                catch (e) { log.debug('shortcuts', 'handleInput overlay', e); }
                const result = callback();
                if (result !== false)
                    event.preventDefault();
                break;
            }
        }
    }
    // A "tap" is Alt pressed and released with nothing in between — no other key,
    // and no other modifier held with it. Chords like Alt+D or Alt+Left must not
    // toggle the bar, so any non-Alt keyDown while Alt is down invalidates the tap.
    _trackAltTap(input) {
        if (process.platform !== 'win32')
            return; // native menu bar owns Alt on mac/Linux
        const isAlt = input.key === 'Alt';
        if (input.type === 'keyDown') {
            if (isAlt && !input.control && !input.meta && !input.shift) {
                // The START of an Alt press (ignore auto-repeat while held) arms a
                // fresh tap — unconditionally, so a prior keystroke can't leave it
                // stuck disarmed (the bug that made Alt need a second press).
                if (!this._altHeld) {
                    this._altHeld = true;
                    this._altTapValid = true;
                }
            }
            else if (this._altHeld) {
                this._altTapValid = false; // another key while Alt is held → a chord
            }
        }
        else if (input.type === 'keyUp' && isAlt) {
            const wasTap = this._altHeld && this._altTapValid;
            this._altHeld = false;
            this._altTapValid = false;
            if (wasTap) {
                try { require('./menu-bar').toggle(this.getWindowData()); }
                catch (e) { log.debug('shortcuts', 'alt tap', e); }
            }
        }
    }
    // Forward a keystroke to the open in-chrome menu bar. Returns true if it was
    // consumed (the caller then preventDefaults it). Only active on Windows and
    // only while the bar reports itself open (ipc/menu.js → wd.menuBarOpen).
    _routeMenuBarKey(input) {
        if (process.platform !== 'win32')
            return false;
        const wd = this.getWindowData();
        // Only while the bar is open AND no dropdown is showing. Once a dropdown is
        // up the overlay itself holds focus and owns the keyboard (its own access
        // keys drive the submenu chain), so main must not also grab the keys.
        if (!wd || !wd.menuBarOpen || wd.ctxMenuOpen || input.control || input.meta || input.alt)
            return false;
        const send = (msg) => {
            try { if (!wd.window.isDestroyed()) wd.window.webContents.send('menubar-key', msg); }
            catch (e) { log.debug('shortcuts', 'menubar-key', e); }
        };
        const k = input.key;
        if (k === 'Escape') { send({ action: 'hide' }); return true; }
        if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowDown' || k === 'ArrowUp' || k === 'Enter') {
            send({ action: k });
            return true;
        }
        if (k && k.length === 1) {
            const idx = require('./menu-bar').indexForKey(k.toLowerCase());
            if (idx >= 0) { send({ action: 'open', index: idx }); return true; }
        }
        return false;
    }
    registerAllShortcuts() {
        this.registerTabShortcuts();
        this.registerNavigationShortcuts();
        this.registerAddressBarShortcuts();
        this.registerPageShortcuts();
        this.registerBrowserShortcuts();
        this.registerWindowShortcuts();
        this.registerDeveloperShortcuts();
        this.registerApplicationShortcuts();
    }
    // ── Helpers ────────────────────────────────────────────────────────────────
    activeTab() {
        return this.tabManager.tabMap.get(this.tabManager.activeTabIndex) ?? null;
    }
    getWindowData() {
        return this.windowManager
            ? this.windowManager.getWindowByWebContents(this.mainWindow.webContents)
            : null;
    }
    openInternalPage(filePath, type, title) {
        // Settings/History/Bookmarks always arrive as their own tab — they are
        // destinations, not a navigation of whatever you were reading.
        // (filePath/title kept for call-site compatibility.)
        this.tabManager.openInternalPage(type);
    }
    reopenClosedTab() {
        const closed = this.tabManager.closedTabHistory;
        if (!closed || closed.length === 0)
            return;
        const last = closed.pop();
        /* Nothing to reopen means nothing happens. It used to open a BLANK
           tab, which is not "reopen closed tab" — and this browser has no
           blank tab to open. */
        if (last && last.url && last.url !== 'newtab') {
            const newIndex = this.tabManager.createTab();
            this.tabManager.loadUrl(newIndex, last.url);
        }
    }
    // ── Tab shortcuts ──────────────────────────────────────────────────────────
    registerTabShortcuts() {
        // New tab — opens the new-tab page (P2 pivot: replaces the Palette).
        this.registerShortcut('CmdOrCtrl+T', () => {
            try { this.tabManager?.openInternalPage?.('home'); }
            catch (e) { log.debug('shortcuts', 'registerTabShortcuts', e); }
        });
        // New private tab — fully isolated session, wiped when the tab closes.
        // It opens on the (private, history-free) new-tab page, like Ctrl+T.
        this.registerShortcut('CmdOrCtrl+Alt+T', () => {
            this.tabManager.openNewTabPage(true);
        });
        // Open the current site in a fresh isolated (persistent) session — the
        // quick, keyboard path to the "Open Isolated Instance" action. Blank tab
        // if the current one isn't a real page.
        this.registerShortcut('CmdOrCtrl+Alt+I', () => {
            const url = this.tabManager.tabUrls.get(this.tabManager.activeTabIndex);
            const httpUrl = (typeof url === 'string' && /^https?:/i.test(url)) ? url : null;
            this.tabManager.openIsolatedInstance(httpUrl);
        });
        // New window
        this.registerShortcut('CmdOrCtrl+N', () => {
            if (this.windowManager)
                this.windowManager.createWindow();
        });
        // New private window — Cmd/Ctrl+Shift+N (Chrome) and Cmd/Ctrl+Shift+P
        // both open one. Every tab inside is private, each with its
        // own isolated session (see Features/private-session.js).
        const openPrivateWindow = () => {
            if (this.windowManager)
                this.windowManager.createWindow(800, 600, { private: true });
        };
        this.registerShortcut('CmdOrCtrl+Shift+N', openPrivateWindow);
        this.registerShortcut('CmdOrCtrl+Shift+P', openPrivateWindow);
        // Close tab
        this.registerShortcut('CmdOrCtrl+W', () => {
            const currentTabIndex = this.tabManager.activeTabIndex;
            // Let the tab manager pick the next tab (visually-adjacent, via
            // tabOrder) — same logic the close button uses, so they're consistent.
            this.tabManager.removeTabWithTargetFocus(currentTabIndex, null);
            setTimeout(() => {
                if (!this.mainWindow.isDestroyed() && this.mainWindow.isVisible()) {
                    this.mainWindow.focus();
                    this.mainWindow.show();
                    const activeTab = this.tabManager.tabMap.get(this.tabManager.activeTabIndex);
                    if (activeTab?.webContents)
                        activeTab.webContents.focus();
                }
            }, 10);
        });
        // Reopen last closed tab
        this.registerShortcut('CmdOrCtrl+Shift+T', () => {
            this.reopenClosedTab();
        });
        // Duplicate active tab (opens in background)
        this.registerShortcut('CmdOrCtrl+Shift+K', () => {
            const url = this.tabManager.tabUrls.get(this.tabManager.activeTabIndex);
            if (url && url !== 'newtab' && !url.startsWith('file://')) {
                let title = url;
                try {
                    title = new URL(url).hostname;
                }
                catch (e) { log.debug('shortcuts', 'openPrivateWindow', e); }
                this.tabManager.createLazyTab(url, title, false, false, true, true);
            }
            // Nothing to duplicate means nothing happens. It used to open a
            // blank tab, which is not a duplicate of anything.
        });
        // Next / previous tab
        this.registerShortcut('CmdOrCtrl+Tab', () => this.switchToNextTab());
        this.registerShortcut('CmdOrCtrl+Shift+Tab', () => this.switchToPreviousTab());
        // Ctrl+PageDown/Up for tab cycling (Windows/Linux standard)
        if (process.platform !== 'darwin') {
            this.registerShortcut('Ctrl+PageDown', () => this.switchToNextTab());
            this.registerShortcut('Ctrl+PageUp', () => this.switchToPreviousTab());
        }
        // Switch to tab 1-8 by position; 9 always goes to the last tab (Chrome convention)
        for (let i = 1; i <= 8; i++) {
            const n = i;
            this.registerShortcut(`CmdOrCtrl+${n}`, () => this.switchToTabByNumber(n));
        }
        this.registerShortcut('CmdOrCtrl+9', () => {
            const tabIndexes = this._orderedTabIndexes();
            if (tabIndexes.length > 0)
                this.tabManager.showTab(tabIndexes[tabIndexes.length - 1]);
        });
        // Switch SPACE by number / step (P2-6). Ctrl+Alt+1…9 jumps to the Nth
        // space in the foot order; Ctrl+Alt+↑/↓ steps through them. Distinct from
        // Ctrl+1…9 (tabs) by the Alt modifier. Main asks the renderer to switch,
        // the same path the "last tab closed" auto-switch uses.
        for (let i = 1; i <= 9; i++) {
            const n = i;
            this.registerShortcut(`CmdOrCtrl+Alt+${n}`, () => this.switchToSpaceByNumber(n));
        }
        this.registerShortcut('CmdOrCtrl+Alt+Up', () => this.switchSpaceBy(-1));
        this.registerShortcut('CmdOrCtrl+Alt+Down', () => this.switchSpaceBy(1));
        // Tab search, as Chrome's Ctrl+Shift+A: the new-tab page in its tab-search
        // mode — type to filter this space's open tabs, Enter jumps, Esc returns.
        this.registerShortcut('CmdOrCtrl+Shift+A', () => {
            try { this.tabManager.openTabSearch(); }
            catch (e) { log.debug('shortcuts', 'tab search', e); }
        });
        // Space switcher (P2-7): open the #space-header menu in the renderer.
        this.registerShortcut('CmdOrCtrl+Shift+M', () => {
            try { this.mainWindow.webContents.send('open-space-switcher'); }
            catch (e) { log.debug('shortcuts', 'space switcher', e); }
        });
        // Clear browsing data (P2-7): Settings, opened to the privacy section.
        this.registerShortcut('CmdOrCtrl+Shift+Delete', () => {
            try { this.tabManager?.openInternalPage?.('settings', 'privacy'); }
            catch (e) { log.debug('shortcuts', 'clear data', e); }
        });
        // Split view — Ctrl/Cmd+Shift+E toggles the active tab against the last
        // one you were on. Previously this feature had no keyboard access at all.
        this.registerShortcut('CmdOrCtrl+Shift+E', () => {
            this.tabManager.toggleSplit();
        });
        // Pin / unpin active tab — Ctrl+Shift+L
        this.registerShortcut('CmdOrCtrl+Shift+L', () => {
            this.tabManager.pinTab(this.tabManager.activeTabIndex);
        });
    }
    // ── Navigation shortcuts ───────────────────────────────────────────────────
    registerNavigationShortcuts() {
        // Back / Forward — Alt+Left/Right (the Windows & Linux standard). NOT
        // Ctrl+Left/Right: that is "move by word" in every text field, so binding
        // it to navigation hijacked cursor movement in the address bar and page
        // inputs. macOS additionally gets Cmd+[ / Cmd+] and Cmd+Left / Cmd+Right,
        // where those ARE the platform's back/forward.
        this.registerShortcut('Alt+Left', () => {
            this.tabManager.goBack(this.tabManager.activeTabIndex);
        });
        this.registerShortcut('Alt+Right', () => {
            this.tabManager.goForward(this.tabManager.activeTabIndex);
        });
        if (process.platform === 'darwin') {
            this.registerShortcut('Cmd+[', () => this.tabManager.goBack(this.tabManager.activeTabIndex));
            this.registerShortcut('Cmd+Left', () => this.tabManager.goBack(this.tabManager.activeTabIndex));
            this.registerShortcut('Cmd+]', () => this.tabManager.goForward(this.tabManager.activeTabIndex));
            this.registerShortcut('Cmd+Right', () => this.tabManager.goForward(this.tabManager.activeTabIndex));
        }
        // Reload
        this.registerShortcut('CmdOrCtrl+R', () => {
            this.tabManager.reload(this.tabManager.activeTabIndex);
        });
        // F5 reload (Windows/Linux standard)
        if (process.platform !== 'darwin') {
            this.registerShortcut('F5', () => {
                this.tabManager.reload(this.tabManager.activeTabIndex);
            });
        }
        // Hard reload (ignore cache)
        this.registerShortcut('CmdOrCtrl+Shift+R', () => {
            const tab = this.activeTab();
            if (tab)
                tab.webContents.reloadIgnoringCache();
        });
        // Stop loading — only intercepts when the page is actually loading;
        // returns false otherwise so Escape reaches the web page normally.
        this.registerShortcut('Escape', () => {
            if (this.tabManager?.isHtmlFullScreen)
                return false;
            const tab = this.activeTab();
            if (tab && tab.webContents.isLoading()) {
                tab.webContents.stop();
                return; // preventDefault
            }
            return false; // pass through to page
        });
    }
    // ── Address bar shortcuts ──────────────────────────────────────────────────
    registerAddressBarShortcuts() {
        const focusBar = () => {
            this.mainWindow.webContents.executeJavaScript('try { const el = document.getElementById("searchBar"); if (el) { el.focus(); el.select(); } } catch {}').catch(() => { });
        };
        this.registerShortcut('CmdOrCtrl+K', focusBar);
        this.registerShortcut('CmdOrCtrl+L', focusBar);
        // F6 moves between the page and the chrome,: from
        // the page it lands in the address bar (Tab then walks the toolbar and
        // the tab strip), and from the chrome it hands focus back to the page.
        this.registerShortcut('F6', () => {
            const chromeFocused = (() => {
                try { return this.mainWindow.webContents.isFocused(); }
                catch { return false; }
            })();
            if (!chromeFocused) {
                focusBar();
                return;
            }
            const tab = this.activeTab();
            try { tab?.webContents.focus(); }
            catch (e) { log.debug('shortcuts', 'chromeFocused', e); }
        });
        this.registerShortcut('Alt+D', focusBar); // Windows / Edge convention
    }
    // ── Page shortcuts ─────────────────────────────────────────────────────────
    registerPageShortcuts() {
        // Find in page
        this.registerShortcut('CmdOrCtrl+F', () => {
            const tab = this.activeTab();
            if (tab && this.tabManager.findDialog) {
                this.tabManager.findDialog.show(tab);
            }
        });
        // Find next / previous (P0-8). Ctrl+G / F3 and the Shift variants are the
        // standard "repeat the last find" keys. The dialog's handleNext/Previous
        // are internally guarded: no-op until there is a search term + active tab,
        // so pressing them cold does nothing rather than erroring.
        const findNext = () => this.tabManager.findDialog?.handleNext();
        const findPrev = () => this.tabManager.findDialog?.handlePrevious();
        this.registerShortcut('CmdOrCtrl+G', findNext);
        this.registerShortcut('F3', findNext);
        this.registerShortcut('CmdOrCtrl+Shift+G', findPrev);
        this.registerShortcut('Shift+F3', findPrev);
        // Open the downloads panel (P0-8). The renderer owns the panel, so this
        // just pokes the chrome; initDownloads listens for it.
        this.registerShortcut('CmdOrCtrl+J', () => {
            try { this.mainWindow.webContents.send('downloads:shortcut-open'); }
            catch (e) { log.debug('shortcuts', 'downloads:shortcut-open', e); }
        });
        // Print
        this.registerShortcut('CmdOrCtrl+P', () => {
            const tab = this.activeTab();
            if (tab)
                tab.webContents.print();
        });
        // Save page as
        this.registerShortcut('CmdOrCtrl+S', () => {
            const tab = this.activeTab();
            if (tab) {
                const url = tab.webContents.getURL();
                if (url && url.startsWith('http'))
                    tab.webContents.downloadURL(url);
            }
        });
        // Undo / Redo
        this.registerShortcut('CmdOrCtrl+Z', () => {
            const tab = this.activeTab();
            if (tab?.webContents.isFocused())
                tab.webContents.undo();
            else if (this.mainWindow.webContents.isFocused())
                this.mainWindow.webContents.undo();
        });
        if (process.platform === 'darwin') {
            this.registerShortcut('CmdOrCtrl+Shift+Z', () => {
                const tab = this.activeTab();
                if (tab?.webContents.isFocused())
                    tab.webContents.redo();
                else if (this.mainWindow.webContents.isFocused())
                    this.mainWindow.webContents.redo();
            });
        }
        else {
            this.registerShortcut('CmdOrCtrl+Y', () => {
                const tab = this.activeTab();
                if (tab?.webContents.isFocused())
                    tab.webContents.redo();
                else if (this.mainWindow.webContents.isFocused())
                    this.mainWindow.webContents.redo();
            });
        }
        // Zoom
        this.registerShortcut('CmdOrCtrl+Plus', () => this.zoomIn());
        this.registerShortcut('CmdOrCtrl+-', () => this.zoomOut());
        this.registerShortcut('CmdOrCtrl+0', () => this.resetZoom());
    }
    // ── Browser UI shortcuts ───────────────────────────────────────────────────
    registerBrowserShortcuts() {
        // Settings — Cmd+, (macOS standard) or Ctrl+, (Windows/Linux)
        this.registerShortcut('CmdOrCtrl+,', () => {
            this.openInternalPage('renderer/Settings/index.html', 'settings', 'Settings');
        });
        // History — Cmd+Y (macOS, Chrome convention) or Ctrl+H (Windows/Linux)
        if (process.platform === 'darwin') {
            this.registerShortcut('CmdOrCtrl+Y', () => {
                this.openInternalPage('renderer/History/index.html', 'history', 'History');
            });
        }
        else {
            this.registerShortcut('CmdOrCtrl+H', () => {
                this.openInternalPage('renderer/History/index.html', 'history', 'History');
            });
        }
        // Bookmarks page
        this.registerShortcut('CmdOrCtrl+Shift+O', () => {
            this.openInternalPage('renderer/Bookmarks/index.html', 'bookmarks', 'Bookmarks');
        });
        // Add bookmark (triggers the bookmark prompt in the renderer)
        this.registerShortcut('CmdOrCtrl+D', () => {
            this.mainWindow.webContents.send('bookmark-add-from-bar');
        });
        // Toggle bookmark bar
        this.registerShortcut('CmdOrCtrl+Shift+B', () => {
            this.mainWindow.webContents.send('toggle-bookmark-bar');
        });
        // Compact mode: hide the sidebar; the page goes full-bleed. Per window.
        // On Ctrl+\ (Cmd+\), NOT Ctrl+Shift+C — that combo is Chrome's
        // inspect-element, which web devs reach for constantly (P1-7). Ctrl+\ is
        // unused by Chrome, and avoids the Shift+\ = "|" layout trap of this
        // produced-character matcher.
        this.registerShortcut('CmdOrCtrl+\\', () => {
            if (!this.tabManager)
                return;
            this.tabManager.sidebarCompact = !this.tabManager.sidebarCompact;
            try {
                this.mainWindow.webContents.send('sidebar-compact-changed', this.tabManager.sidebarCompact);
                this.tabManager.resizeAllTabs();
            }
            catch (e) { log.debug('shortcuts', 'registerBrowserShortcuts', e); }
        });
        // Toggle tab bar side (left sidebar ⇄ classic top strip).
        // Applies to every window: chrome reflows + page bounds resize.
        this.registerShortcut('CmdOrCtrl+Shift+S', () => {
            const p = this.tabManager?.persistence;
            if (!p || !this.windowManager)
                return;
            const next = (p.get('tabBarSide') ?? 'side') === 'top' ? 'side' : 'top';
            // One shared path (persist + reflow every window) — see setTabBarSide.
            this.windowManager.setTabBarSide(next);
        });
        // Toggle focus mode
        this.registerShortcut('CmdOrCtrl+Shift+F', () => {
            const wd = this.getWindowData();
            if (wd)
                focusMode.toggle(wd);
        });
        // Reader view — Cmd/Ctrl+Alt+R (a common convention)
        this.registerShortcut('CmdOrCtrl+Alt+R', () => {
            if (this.tabManager)
                this.tabManager.toggleReader(this.tabManager.activeTabIndex);
        });
        // Picture-in-Picture — Cmd/Ctrl+Alt+P
        this.registerShortcut('CmdOrCtrl+Alt+P', () => {
            if (this.tabManager)
                this.tabManager.togglePictureInPicture(this.tabManager.activeTabIndex);
        });
    }
    // ── Window shortcuts ───────────────────────────────────────────────────────
    registerWindowShortcuts() {
        // Minimize
        this.registerShortcut('CmdOrCtrl+M', () => {
            if (!this.mainWindow.isDestroyed())
                this.mainWindow.minimize();
        });
        // Fullscreen — F11 (all platforms) + Ctrl+Cmd+F (macOS native shortcut)
        this.registerShortcut('F11', () => this.toggleFullScreen());
        if (process.platform === 'darwin') {
            this.registerShortcut('Ctrl+Cmd+F', () => this.toggleFullScreen());
        }
        // Close window
        this.registerShortcut('CmdOrCtrl+Shift+W', () => {
            if (this.tabManager)
                this.tabManager.allowClose = true;
            if (!this.mainWindow.isDestroyed())
                this.mainWindow.close();
        });
    }
    // ── Developer shortcuts ────────────────────────────────────────────────────
    registerDeveloperShortcuts() {
        // Devtools open for web content only — internal chrome pages (new tab,
        // settings, history, …) are app UI and stay closed outside --dev runs.
        const devtoolsAllowed = (wc) => {
            if (process.argv.includes('--dev'))
                return true;
            try {
                return /^https?:/i.test(wc.getURL() || '');
            }
            catch {
                return false;
            }
        };
        this.registerShortcut('F12', () => {
            const tab = this.activeTab();
            if (tab && devtoolsAllowed(tab.webContents))
                tab.webContents.toggleDevTools();
        });
        this.registerShortcut('CmdOrCtrl+Shift+I', () => {
            const tab = this.activeTab();
            if (tab && devtoolsAllowed(tab.webContents))
                tab.webContents.toggleDevTools();
        });
        // Ctrl+Shift+J is Chrome's "open the page's console" (P1-7). Electron
        // exposes no API to pre-select the Console panel, so this opens the
        // active page's devtools — which is what the key means to muscle memory,
        // in packaged builds too, not only --dev.
        this.registerShortcut('CmdOrCtrl+Shift+J', () => {
            const tab = this.activeTab();
            if (tab && devtoolsAllowed(tab.webContents))
                tab.webContents.toggleDevTools();
        });
        // Renderer devtools (for debugging the chrome UI itself) moves to a
        // dev-only combo so it never shadows the page console above.
        this.registerShortcut('CmdOrCtrl+Alt+Shift+J', () => {
            if (process.argv.includes('--dev'))
                this.mainWindow.webContents.toggleDevTools();
        });
    }
    // ── Application shortcuts ──────────────────────────────────────────────────
    registerApplicationShortcuts() {
        // Quit
        this.registerShortcut('CmdOrCtrl+Q', () => {
            if (this.windowManager) {
                this.windowManager.getAllWindows().forEach(wd => {
                    if (wd.tabs)
                        wd.tabs.allowClose = true;
                });
            }
            app.quit();
        });
        // Close all windows (keep app running — macOS style)
        this.registerShortcut('CmdOrCtrl+Shift+Q', () => {
            if (this.windowManager) {
                this.windowManager.getAllWindows().forEach(wd => {
                    if (wd.tabs)
                        wd.tabs.allowClose = true;
                });
                this.windowManager.closeAllWindows();
            }
        });
    }
    // ── Registration ───────────────────────────────────────────────────────────
    registerShortcut(accelerator, callback) {
        this.shortcuts.set(accelerator, callback);
    }
    // ── Accelerator matching ───────────────────────────────────────────────────
    matchesAccelerator(input, accelerator) {
        const parts = accelerator.toLowerCase().split('+');
        const key = parts[parts.length - 1];
        const modifiers = parts.slice(0, -1);
        // Key matching — handle named keys and aliases
        let keyMatches = input.key.toLowerCase() === key;
        if (!keyMatches) {
            if (key === 'tab' && input.key === 'Tab')
                keyMatches = true;
            else if (key === 'left' && input.key === 'ArrowLeft')
                keyMatches = true;
            else if (key === 'right' && input.key === 'ArrowRight')
                keyMatches = true;
            else if (key === 'up' && input.key === 'ArrowUp')
                keyMatches = true;
            else if (key === 'down' && input.key === 'ArrowDown')
                keyMatches = true;
            else if (key === 'pageup' && input.key === 'PageUp')
                keyMatches = true;
            else if (key === 'pagedown' && input.key === 'PageDown')
                keyMatches = true;
            else if (key === 'plus' && (input.key === '+' || input.key === '='))
                keyMatches = true;
            else if (key === 'minus' && (input.key === '-' || input.key === '_'))
                keyMatches = true;
            else if (key === 'space' && input.key === ' ')
                keyMatches = true;
            else if (key === 'return' && input.key === 'Enter')
                keyMatches = true;
            else if (key === 'enter' && input.key === 'Enter')
                keyMatches = true;
            else if (key === 'delete' && input.key === 'Delete')
                keyMatches = true;
            else if (key.match(/^[0-9]$/) && input.key === key)
                keyMatches = true;
            // A layout whose digit row needs Shift (AZERTY: Ctrl+1 produces '&')
            // still means Ctrl+1 — match the physical key. Never with Alt held:
            // Ctrl+Alt is AltGr on Windows, and AltGr+digit types '@', '#', '|'…
            else if (key.match(/^[0-9]$/) && !input.alt && (input.code === 'Digit' + key || input.code === 'Numpad' + key))
                keyMatches = true;
        }
        if (!keyMatches)
            return false;
        // Modifier matching
        // CmdOrCtrl → Cmd on macOS, Ctrl on Windows/Linux
        // Ctrl / Cmd → explicit, platform-independent
        const platform = process.platform;
        const hasCmdOrCtrl = modifiers.includes('cmdorctrl');
        const hasCtrl = modifiers.includes('ctrl');
        const hasCmd = modifiers.includes('cmd');
        const hasShift = modifiers.includes('shift');
        const hasAlt = modifiers.includes('alt');
        const wantsMeta = (hasCmdOrCtrl && platform === 'darwin') || hasCmd;
        const wantsCtrl = (hasCmdOrCtrl && platform !== 'darwin') || hasCtrl;
        const shiftOk = hasShift
            ? input.shift === true
            : (input.shift === false ||
                (key === 'plus' && (input.key === '+' || input.key === '=')) ||
                (key === 'minus' && input.key === '_'));
        return ((wantsMeta ? input.meta === true : input.meta === false) &&
            (wantsCtrl ? input.control === true : input.control === false) &&
            shiftOk &&
            (hasAlt ? input.alt === true : input.alt === false));
    }
    // ── Tab cycling helpers ────────────────────────────────────────────────────
    switchToNextTab() {
        const indexes = this._orderedTabIndexes();
        const current = indexes.indexOf(this.tabManager.activeTabIndex);
        if (current !== -1)
            this.tabManager.showTab(indexes[(current + 1) % indexes.length]);
    }
    switchToPreviousTab() {
        const indexes = this._orderedTabIndexes();
        const current = indexes.indexOf(this.tabManager.activeTabIndex);
        if (current !== -1)
            this.tabManager.showTab(indexes[(current - 1 + indexes.length) % indexes.length]);
    }
    switchToTabByNumber(number) {
        const indexes = this._orderedTabIndexes();
        if (number >= 1 && number <= indexes.length)
            this.tabManager.showTab(indexes[number - 1]);
    }
    // ── Space switching (P2-6) ───────────────────────────────────────────────
    // Spaces are profiles here; switching is renderer-driven, so main asks the
    // renderer to switch via the same 'switch-to-workspace' channel the auto-
    // switch uses. profiles.list() is the foot order.
    switchToSpaceByNumber(number) {
        try {
            const list = profiles.list();
            const target = list[number - 1];
            if (target)
                this.mainWindow.webContents.send('switch-to-workspace', target.id);
        }
        catch (e) { log.debug('shortcuts', 'switchToSpaceByNumber', e); }
    }
    switchSpaceBy(step) {
        try {
            const list = profiles.list();
            if (list.length < 2)
                return;
            const cur = String(this.tabManager?.profileId ?? '1');
            const i = list.findIndex(p => String(p.id) === cur);
            const next = list[((i < 0 ? 0 : i) + step + list.length) % list.length];
            if (next)
                this.mainWindow.webContents.send('switch-to-workspace', next.id);
        }
        catch (e) { log.debug('shortcuts', 'switchSpaceBy', e); }
    }
    _orderedTabIndexes() {
        // Visual (tab-bar) order, restricted to the CURRENT SPACE's live tabs.
        // The window keeps EVERY space's tabs alive in tabMap (see
        // features/tabs/organize.js), so filtering only by tabMap let Ctrl+Tab /
        // Ctrl+Shift+Tab and Ctrl+1–9 walk straight into another space's tabs —
        // switching the whole window's context to a space you are not in. Cycling
        // must stay within the active space, exactly like the sidebar shows.
        const inWs = this.tabManager.tabsInWorkspace(this.tabManager.profileId);
        // ...and in the order the sidebar DRAWS them. The sidebar puts a new tab
        // at the top of the loose tabs while tabOrder appends it, so following
        // tabOrder sent Ctrl+1 to the bottom-most tab. The renderer reports its
        // drawn order (ipc 'tabs:visual-order'); any tab it hasn't reported yet
        // falls in after, in tabOrder.
        const visual = this.tabManager.visualOrder;
        if (!Array.isArray(visual) || !visual.length)
            return inWs;
        const live = new Set(inWs);
        const drawn = visual.filter(i => live.has(i));
        const seen = new Set(drawn);
        return [...drawn, ...inWs.filter(i => !seen.has(i))];
    }
    // ── Zoom helpers ───────────────────────────────────────────────────────────
    // Each of these remembers the new level for the site (features/zoom.js), so
    // the next visit opens at the size the user chose.
    _setZoom(level) {
        const tab = this.activeTab();
        if (!tab)
            return;
        const clamped = Math.max(-3, Math.min(5, level));
        tab.webContents.setZoomLevel(clamped);
        const idx = this.tabManager?.activeTabIndex;
        const url = this.tabManager?.tabUrls?.get(idx) || '';
        zoom.remember(url, clamped, !this.tabManager?.privateTabs?.has(idx) && !this.tabManager?.isPrivateWindow);
    }
    zoomIn() {
        const tab = this.activeTab();
        if (tab)
            this._setZoom(tab.webContents.getZoomLevel() + 0.5);
    }
    zoomOut() {
        const tab = this.activeTab();
        if (tab)
            this._setZoom(tab.webContents.getZoomLevel() - 0.5);
    }
    resetZoom() {
        this._setZoom(0);
    }
    toggleFullScreen() {
        this.mainWindow.setFullScreen(!this.mainWindow.isFullScreen());
    }
    // ── Lifecycle ──────────────────────────────────────────────────────────────
    unregisterAllShortcuts() {
        this.shortcuts.clear();
    }
    isShortcutRegistered(accelerator) {
        return this.shortcuts.has(accelerator);
    }
    getRegisteredShortcuts() {
        return Array.from(this.shortcuts.keys());
    }
}

module.exports = Shortcuts;