const { WebContentsView, BrowserWindow, Menu, shell, app }  = require('electron');
const path = require('path');
const History = require("./history");
const UserAgent = require("./user-agent");
const contextMenu = require("./tab-context-menu");
const NavigationHistory = require("./navigation-history");
const FindDialogManager = require("./find-dialog");
const focusMode = require("./focus-mode");
const { isSafeExternal } = require('./url-security');
const { READERABLE_JS, EXTRACT_JS, PIP_JS } = require('./reader');
const extensions = require('./extensions');
const miniPlayer = require('./mini-player');
const privateSessions = require('./private-session');

const YOUTUBE_SPACE_FIX_JS = `
(() => {
    if (window.__inkYouTubeSpaceFix) return;
    window.__inkYouTubeSpaceFix = true;

    let lastSpace = null;

    function isEditable(el) {
        if (!el) return false;
        if (el.isContentEditable) return true;
        const tag = el.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
        const role = el.getAttribute && el.getAttribute('role');
        return role && role.toLowerCase() === 'textbox';
    }

    function isYouTubeFullscreen() {
        const player = document.querySelector('.html5-video-player');
        return !!(
            document.fullscreenElement ||
            document.documentElement.classList.contains('ytp-fullscreen') ||
            document.body.classList.contains('ytp-fullscreen') ||
            (player && player.classList.contains('ytp-fullscreen'))
        );
    }

    function toggleYouTubeFullscreen() {
        const player = document.querySelector('#movie_player') ||
                       document.querySelector('.html5-video-player');
        if (isYouTubeFullscreen()) {
            // Exit: try HTML5 API first, then player API, then button
            if (document.fullscreenElement) {
                document.exitFullscreen().catch(() => {});
            } else if (player && typeof player.exitFullscreen === 'function') {
                try { player.exitFullscreen(); } catch {}
            } else {
                const btn = document.querySelector('.ytp-fullscreen-button');
                if (btn) btn.click();
            }
        } else {
            // Enter: try player requestFullscreen, then button
            if (player && typeof player.requestFullscreen === 'function') {
                player.requestFullscreen().catch(() => {});
            } else {
                const btn = document.querySelector('.ytp-fullscreen-button');
                if (btn) btn.click();
            }
        }
    }

    document.addEventListener('keydown', (e) => {
        if (e.repeat) return;
        if (e.code !== 'Space' && e.key !== ' ') return;
        if (isEditable(e.target) || isEditable(document.activeElement)) return;
        const video = document.querySelector('video');
        if (!video) return;
        lastSpace = {
            wasPaused: video.paused,
            time: Date.now(),
        };
    }, true);

    document.addEventListener('keyup', (e) => {
        if (e.code !== 'Space' && e.key !== ' ') return;
        if (isEditable(e.target) || isEditable(document.activeElement)) return;
        const video = document.querySelector('video');
        if (!video || !lastSpace) return;
        // If YouTube already handled the spacebar, don't toggle again.
        if (video.paused === lastSpace.wasPaused) {
            if (video.paused) video.play();
            else video.pause();
        }
        lastSpace = null;
    }, true);

    window.__inkYouTubeExitFullscreen = () => {
        if (isYouTubeFullscreen()) toggleYouTubeFullscreen();
    };
})();
`;

// The Settings page needs privileged APIs (passwords, extension management)
// that must NOT be exposed to ordinary web pages, so it uses a dedicated
// preload. Every other page (web content, History, Bookmarks, New Tab) uses
// the general preload.
function preloadForPage(kind) {
    const base = path.join(__dirname, '../preload');
    if (kind === 'settings' || (typeof kind === 'string' && kind.includes('/Settings/'))) {
        return path.join(base, 'settings-preload.js');
    }
    return path.join(base, 'preload.js');
}

class Tabs {
    constructor(mainWindow, History, Persistence, options = {}) {
        this.mainWindow = mainWindow
        this.history = History
        this.persistence = Persistence || null
        this.navigationHistory = new NavigationHistory()
        this.findDialog = FindDialogManager.getInstance().createDialog(mainWindow)
        this.shortcuts = null
        this.tabMap = new Map()
        this.tabUrls = new Map()
        // Tab sleeping: free the renderer process of long-inactive background
        // tabs (Chrome's "memory saver"). tabLastActive tracks when a tab was
        // last the active tab; the scan puts stale ones to sleep.
        this.tabLastActive = new Map()
        this._sleepTimer = setInterval(() => { try { this._sleepScan(); } catch {} }, 60_000)
        this.activeTabIndex = 0
        this.nextTabIndex = 0
        this.allowClose = false
        this.closePreventionActive = false
        this.isHtmlFullScreen = false
        this.htmlFullScreenRequested = false
        this.userFullScreenActive = false
        this.pinnedTabs = new Set()
        this.privateTabs = new Set()
        this.isPrivateWindow = options?.private ?? false
        this.tabOrder = []
        this.closedTabHistory = [] // stack of {url, title} for "Reopen Closed Tab"
        this.readerMode = new Set()       // tab indices currently showing the reader view
        this.readerArticles = new Map()   // tabIndex → extracted article (served to the reader page)
        this.readerOriginal = new Map()   // tabIndex → original URL to restore on exit
        
        this.mainWindow.on('resize', () => {
            this.resizeAllTabs()
        })
        
        this.mainWindow.on('enter-full-screen', () => {
            if (!this.isHtmlFullScreen) this.userFullScreenActive = true;
        });

        this.mainWindow.on('leave-full-screen', () => {
            // Capture before reset: true means OS fullscreen was entered because YouTube
            // requested it (not the user pressing F11). In that case, YouTube triggered
            // its own exitFullscreen() and is cleaning up its CSS itself — calling
            // applyYouTubeExitFullscreen here races the macOS animation and double-toggles
            // back into fullscreen (works on Windows where exit is instant, breaks on Mac).
            const wasHtmlRequested = this.htmlFullScreenRequested;
            this.userFullScreenActive = false;
            this.isHtmlFullScreen = false;
            this.htmlFullScreenRequested = false;
            this.resizeAllTabs();
            if (!wasHtmlRequested) {
                // OS fullscreen was user-initiated (F11 / green button) while YouTube was
                // in CSS fullscreen — force YouTube to clean up its own state.
                this.tabMap.forEach(tab => {
                    if (tab && tab.webContents) {
                        tab.webContents.executeJavaScript('if (document.fullscreenElement) document.exitFullscreen();').catch(() => {});
                        this.applyYouTubeExitFullscreen(tab);
                    }
                });
            }
        });
        
        this.mainWindow.on('close', (event) => {
            if (this.tabMap.size > 0 && !this.allowClose) {
                // A user-initiated OS close (macOS traffic light, Alt-F4, taskbar
                // menu) arrives here without allowClose set. Honor it: state was
                // already persisted by window-manager's handler on this same
                // event, so mark the window closeable and re-issue the close.
                event.preventDefault();
                this.allowClose = true;
                setImmediate(() => {
                    try { if (!this.mainWindow.isDestroyed()) this.mainWindow.close(); } catch {}
                });
            }
        });
        
        const originalClose = this.mainWindow.close.bind(this.mainWindow);
        const originalDestroy = this.mainWindow.destroy.bind(this.mainWindow);
        
        this.mainWindow.close = () => {
            if (this.tabMap.size > 0 && !this.allowClose) {
                return;
            }
            
            const result = originalClose();
            this.allowClose = false;
            return result;
        };
        
        this.mainWindow.destroy = () => {
            if (this.tabMap.size > 0 && !this.allowClose) {
                return;
            }
            
            return originalDestroy();
        };
    }

    _getPrivateSession() {
        // Every private tab gets its OWN isolated in-memory session — cookies,
        // cache and storage never carry over to any other tab, private or not.
        // The session is wiped in destroyTab() the moment the tab closes.
        return privateSessions.createTabSession();
    }

    createLazyTab(url, title, isPinned, isPrivate = false, insertAfterActive = false, eager = false) {
        const tabIndex = this.nextTabIndex;
        this.nextTabIndex++;
        const makePrivate = isPrivate || this.isPrivateWindow;

        const webPrefs = {
            preload: preloadForPage(url),
            contextIsolation: true,
            nodeIntegration: false,
        };
        if (makePrivate) {
            webPrefs.session        = this._getPrivateSession();
            webPrefs.v8CacheOptions = 'none'; // disable V8 bytecode cache for private tabs
        }

        const tab = new WebContentsView({ webPreferences: webPrefs });
        if (makePrivate) {
            tab.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
            tab.privateSession = webPrefs.session; // wiped when the tab closes
        }

        this.mainWindow.contentView.addChildView(tab);
        this.raiseFloatingViews();
        tab.setVisible(false); // Do not show initially

        UserAgent.setupTab(tab);
        this._applyTabBackground(tab, url || 'newtab');
        if (!makePrivate) extensions.addTab(tab.webContents, this.mainWindow);
        
        // Setup context menu
        tab.webContents.on("context-menu", async (_event, params) => {
            let menuParams = params;
            if (params?.linkURL) {
                try {
                    await tab.webContents.executeJavaScript(
                        'try { const s = window.getSelection && window.getSelection(); if (s) s.removeAllRanges(); } catch {}',
                        true,
                    );
                } catch {}
                menuParams = { ...params, selectionText: '' };
            }

            const contextMenuInstance = new contextMenu(tab, menuParams, this);
            const menu = Menu.buildFromTemplate(contextMenuInstance.getTemplate());
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                menu.popup({ window: this.mainWindow });
            }
        });

        const bounds = this.getTabBounds();
        tab.setBounds(bounds);

        this.tabMap.set(tabIndex, tab);
        this.tabUrls.set(tabIndex, url || 'newtab');
        this.tabLastActive.set(tabIndex, Date.now());
        // Placement: user "open in new tab" actions drop the tab right after the
        // current one (Chrome/Firefox style); everything else (session restore,
        // etc.) appends to the end so restored order is preserved.
        const afterIdx = (insertAfterActive && this.tabOrder.includes(this.activeTabIndex))
            ? this.activeTabIndex : null;
        const afterPos = afterIdx !== null ? this.tabOrder.indexOf(afterIdx) : -1;
        if (afterPos !== -1) this.tabOrder.splice(afterPos + 1, 0, tabIndex);
        else                 this.tabOrder.push(tabIndex);

        if (isPinned) {
            this.pinnedTabs.add(tabIndex);
        }
        if (makePrivate) {
            this.privateTabs.add(tabIndex);
        }
        tab.isPrivate = makePrivate;

        tab.lazyLoaded = false;

        let tempTitle = title || url || 'New Tab';
        if ((!title || title === 'New Tab' || title === '') && url && url.startsWith('http')) {
            try { tempTitle = new URL(url).hostname; } catch {}
        }
        tab.lazyTitle = tempTitle;

        this.navigationHistory.initializeTab(tabIndex, url || 'newtab');
        this.setupTabListeners(tabIndex, tab);

        tab.webContents.on('did-finish-load', () => {
            const windowData = this.getWindowData();
            if (windowData) {
                focusMode.applyToTab(windowData, tab.webContents, tab.webContents.getURL?.() ?? '');
            }
            this.applyYouTubeSpaceFix(tab, tab.webContents.getURL?.() ?? '');
            const title = tab.webContents.getTitle();
            if (title) {
                tab.lazyTitle = title;
                this.sendTabUpdate(tabIndex, tab, this.tabUrls.get(tabIndex) || '', title);
            }
        });

        this.mainWindow.webContents.send('tab-created', {
            index: tabIndex,
            title: tab.lazyTitle,
            totalTabs: this.tabMap.size,
            afterIndex: afterPos !== -1 ? afterIdx : null,
            active: false,
            private: makePrivate,
        });
        this.sendTabUpdate(tabIndex, tab, url || 'newtab', tab.lazyTitle);

        // Eager background load (user-initiated "open in new tab"): start loading
        // immediately while the view is hidden so the page is ready when the user
        // switches over — but muted until first shown, so background video/audio
        // can't blast. Because the page loads with visibilityState "hidden", sites
        // like YouTube hold their autoplay until the tab is actually viewed,
        // instead of racing it against the tab becoming visible mid-load.
        // Session restore keeps eager=false (loading 20 tabs at startup would
        // wreck launch time and memory).
        if (eager && /^https?:/i.test(url || '')) {
            tab.lazyLoaded = true;
            tab.mutedUntilShown = true;
            try { tab.webContents.audioMuted = true; } catch {}
            try { tab.webContents.loadURL(url); } catch {}
        }

        return tabIndex;
    }

    computeDisplayTitleFor(index, fallbackTitle) {
        try {
            const tab = this.tabMap.get(index);
            if (tab && tab.lazyLoaded === false && tab.lazyTitle) {
                return tab.lazyTitle;
            }
            if (tab && tab.lazyTitle && tab.webContents && !tab.webContents.isDestroyed() && !tab.webContents.getTitle()) {
                return tab.lazyTitle;
            }
            const urlType = this.tabUrls.get(index) || '';
            if (urlType === 'newtab' || (typeof urlType === 'string' && urlType.startsWith('file://'))) {
                return 'New Tab';
            }
            if (urlType === 'history') {
                return 'History';
            }
            if (urlType === 'settings') {
                return 'Settings';
            }
            if (fallbackTitle) return fallbackTitle;
            const t = tab && tab.webContents ? tab.webContents.getTitle() : '';
            return t || 'New Tab';
        } catch {
            return 'New Tab';
        }
    }

    updateWindowTitle(index, explicitTitle) {
        try {
            const title = explicitTitle || this.computeDisplayTitleFor(index);
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                this.mainWindow.setTitle(title);
            }
        } catch {}
    }

    setWindowManager(windowManager) {
        this.windowManager = windowManager;
    }

    getWindowData() {
        if (!this.windowManager) return null;
        return this.windowManager.getWindowByWebContents(this.mainWindow.webContents);
    }

    raiseFloatingViews() {
        const wd = this.getWindowData();
        if (!wd?.window?.contentView) return;

        const overlays = [wd.menu, wd.suggestions, wd.bookmarkPrompt, wd.folderDropdown, wd.downloadsPanel, wd.passwordPrompt];
        overlays.forEach((view) => {
            if (!view) return;
            try {
                wd.window.contentView.removeChildView(view);
                wd.window.contentView.addChildView(view);
            } catch {}
        });
    }

    setShortcuts(shortcuts) {
        this.shortcuts = shortcuts;
    }

    createTab(insertAfterIndex = null, shouldActivate = true, isPrivate = false) {
        const tabIndex = this.nextTabIndex
        this.nextTabIndex++
        const makePrivate = isPrivate || this.isPrivateWindow;

        const webPrefs = {
            preload: path.join(__dirname, '../preload/preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        };
        if (makePrivate) {
            webPrefs.session        = this._getPrivateSession();
            webPrefs.v8CacheOptions = 'none';
        }

        const tab = new WebContentsView({ webPreferences: webPrefs })
        if (makePrivate) {
            tab.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
            tab.privateSession = webPrefs.session; // wiped when the tab closes
        }
        this.mainWindow.contentView.addChildView(tab)
        tab.webContents.loadFile(makePrivate ? 'renderer/NewTab/private.html' : 'renderer/NewTab/index.html')
        this.raiseFloatingViews()

        UserAgent.setupTab(tab)
        this._applyTabBackground(tab, 'newtab')
        if (!makePrivate) extensions.addTab(tab.webContents, this.mainWindow)

        tab.webContents.on("context-menu", async (_event, params) => {
            let menuParams = params;
            if (params?.linkURL) {
                try {
                    await tab.webContents.executeJavaScript(
                        'try { const s = window.getSelection && window.getSelection(); if (s) s.removeAllRanges(); } catch {}',
                        true,
                    );
                } catch {}
                menuParams = { ...params, selectionText: '' };
            }

            const contextMenuInstance = new contextMenu(tab, menuParams, this);
            const menu = Menu.buildFromTemplate(contextMenuInstance.getTemplate());
            menu.popup({ window: this.mainWindow });
        })

        const bounds = this.getTabBounds()
        tab.setBounds(bounds)
        tab.setVisible(false)

        this.tabMap.set(tabIndex, tab)
        this.tabUrls.set(tabIndex, 'newtab')
        this.tabLastActive.set(tabIndex, Date.now())
        if (makePrivate) {
            this.privateTabs.add(tabIndex);
        }
        tab.isPrivate = makePrivate;
        // insertAfterIndex: existing tab index to insert after, -1 for the
        // front of the order (cross-window drop before the first tab), else end.
        const afterPos = (insertAfterIndex !== null && insertAfterIndex !== undefined && insertAfterIndex !== -1)
            ? this.tabOrder.indexOf(insertAfterIndex)
            : -1;
        if (insertAfterIndex === -1) {
            this.tabOrder.unshift(tabIndex);
        } else if (afterPos !== -1) {
            this.tabOrder.splice(afterPos + 1, 0, tabIndex);
        } else {
            this.tabOrder.push(tabIndex);
        }
        const previousActiveTabIndex = this.activeTabIndex
        if (shouldActivate) {
            this.activeTabIndex = tabIndex
            // createTab pre-sets activeTabIndex before showTab runs, so showTab
            // can't derive which tab we came from — carry it across explicitly
            // (used by the mini player's "walked away from a playing tab" hook).
            this._pendingPrevActive = previousActiveTabIndex
        }
        this.navigationHistory.initializeTab(tabIndex, 'newtab')
        this.setupTabListeners(tabIndex, tab)

        this.mainWindow.webContents.send('tab-created', {
            index: tabIndex,
            title: 'New Tab',
            totalTabs: this.tabMap.size,
            afterIndex: insertAfterIndex === -1 ? -1 : (afterPos !== -1 ? insertAfterIndex : null),
            active: shouldActivate,
            private: makePrivate,
        })

        if (shouldActivate) {
            this.showTab(tabIndex)
            // A freshly opened blank tab should focus the address bar, like
            // Chrome/Firefox. showTab() just gave OS focus to the tab's child
            // WebContentsView, so we must pull focus back to the chrome view
            // FIRST — otherwise the renderer's searchBar.focus() is a no-op and
            // keystrokes go to the (blank) page. We fire once immediately and
            // again after the newtab page finishes loading, because the page's
            // own load can re-grab OS focus and undo the first attempt.
            const focusAddressBar = () => {
                if (this.activeTabIndex !== tabIndex || this.mainWindow.isDestroyed()) return;
                try {
                    this.mainWindow.webContents.focus();
                    this.mainWindow.webContents.send('focus-address-bar');
                } catch {}
            };
            setImmediate(focusAddressBar);
            setTimeout(focusAddressBar, 200);
            tab.webContents.once('did-finish-load', () => setTimeout(focusAddressBar, 0));
        } else {
            const activeTab = this.tabMap.get(previousActiveTabIndex)
            if (activeTab) {
                activeTab.setVisible(true)
            }
        }
        this.saveStateDebounced()
        this.sendTabUpdate(tabIndex, tab, '', 'New Tab')

        tab.webContents.on('did-finish-load', () => {
            const windowData = this.getWindowData();
            if (windowData) {
                focusMode.applyToTab(windowData, tab.webContents, tab.webContents.getURL?.() ?? '');
            }
            this.applyYouTubeSpaceFix(tab, tab.webContents.getURL?.() ?? '');
            const title = tab.webContents.getTitle();
            if (title) {
                tab.lazyTitle = title;
                this.sendTabUpdate(tabIndex, tab, this.tabUrls.get(tabIndex) || '', title);
            }
        });

        return tabIndex
    }

    createTabWithPage(pagePath, pageType, pageTitle) {
        const tabIndex = this.nextTabIndex
        this.nextTabIndex++

        const tab = new WebContentsView({
            webPreferences: {
                preload: preloadForPage(pageType),
                contextIsolation: true,
                nodeIntegration: false
            }
        })
        this.mainWindow.contentView.addChildView(tab)
        tab.webContents.loadFile(pagePath)
        this.raiseFloatingViews()

        UserAgent.setupTab(tab)
        this._applyTabBackground(tab, pageType)
        extensions.addTab(tab.webContents, this.mainWindow)
        
        const bounds = this.getTabBounds()
        tab.setBounds(bounds)

        tab.lazyTitle = pageTitle || pageType;

        this.tabMap.set(tabIndex, tab)
        this.tabUrls.set(tabIndex, pageType)
        this.tabOrder.push(tabIndex)
        this.activeTabIndex = tabIndex
        this.navigationHistory.initializeTab(tabIndex, pageType)
        this.setupTabListeners(tabIndex, tab)
        
        this.mainWindow.webContents.send('tab-created', {
            index: tabIndex,
            title: pageTitle || pageType,
            totalTabs: this.tabMap.size
        })
        
        this.sendTabUpdate(tabIndex, tab, pageType, pageTitle);
        
        this.showTab(tabIndex)

        tab.webContents.on('did-finish-load', () => {
            const windowData = this.getWindowData();
            if (windowData) {
                focusMode.applyToTab(windowData, tab.webContents, tab.webContents.getURL?.() ?? '');
            }
            this.applyYouTubeSpaceFix(tab, tab.webContents.getURL?.() ?? '');
            const title = tab.webContents.getTitle();
            if (title) {
                tab.lazyTitle = title;
                this.sendTabUpdate(tabIndex, tab, this.tabUrls.get(tabIndex) || '', title);
            }
            this.saveStateDebounced();
        });
        return tabIndex
    }
    
    // With macOS vibrancy the window is transparent, so a tab that doesn't fully
    // paint would bleed the frosted material through. Internal pages (new tab,
    // settings, history, bookmarks) opt INTO that frost with a transparent view;
    // web content gets an opaque white backing (matching Chrome) so nothing bleeds.
    _applyTabBackground(tab, urlOrType) {
        const t = urlOrType || '';
        const internal =
            t === 'newtab' || t === 'settings' || t === 'history' || t === 'bookmarks' ||
            (typeof t === 'string' && /\/(NewTab|Settings|History|Bookmarks)\//.test(t));
        try { tab.setBackgroundColor(internal ? '#00000000' : '#ffffff'); } catch {}
    }

    getTabBounds() {
        const contentBounds = this.mainWindow.getContentBounds()
        
        if (this.mainWindow && (this.isHtmlFullScreen || this.mainWindow.isSimpleFullScreen())) {
            return { x: 0, y: 0, width: contentBounds.width, height: contentBounds.height };
        }
        
        // tab-bar (42px) + utility-bar (52px) + optional bookmark-bar (30px)
        const yOffset = 94 + (this.bookmarkBarHeight || 0)
        let width = contentBounds.width
        let height = contentBounds.height - yOffset
        if (width < 0) width = 0;
        if (height < 0) height = 0;
        return { x: 0, y: yOffset, width: Math.floor(width), height: Math.floor(height) }
    }

    isYouTubeUrl(url) {
        try {
            const host = new URL(url).hostname || '';
            return host.includes('youtube.com') || host === 'youtu.be';
        } catch {
            return false;
        }
    }

    applyYouTubeSpaceFix(tab, url) {
        if (!tab || !tab.webContents || tab.webContents.isDestroyed()) return;
        const currentUrl = url || (tab.webContents.getURL ? tab.webContents.getURL() : '');
        if (!this.isYouTubeUrl(currentUrl)) return;
        try { tab.webContents.executeJavaScript(YOUTUBE_SPACE_FIX_JS, true); } catch {}
    }

    applyYouTubeExitFullscreen(tab) {
        if (!tab || !tab.webContents || tab.webContents.isDestroyed()) return;
        const currentUrl = tab.webContents.getURL ? tab.webContents.getURL() : '';
        if (!this.isYouTubeUrl(currentUrl)) return;
        try { tab.webContents.executeJavaScript('window.__inkYouTubeExitFullscreen && window.__inkYouTubeExitFullscreen();', true); } catch {}
    }
    
    setupTabListeners(tabIndex, tab) {
        let isNavigatingProgrammatically = false;
        let lastAddedUrl = null;

        if (this.shortcuts) {
            this.shortcuts.onTabCreated(tab);
        }

        // Block dangerous protocol navigations (javascript:, data:, vbscript:) initiated
        // by page scripts or injected links.
        const blockDangerousNav = (event, url) => {
            try {
                const proto = new URL(url).protocol;
                if (proto === 'javascript:' || proto === 'data:' || proto === 'vbscript:') {
                    event.preventDefault();
                }
            } catch {}
        };
        tab.webContents.on('will-navigate', blockDangerousNav);
        tab.webContents.on('will-redirect', blockDangerousNav);

        // Route all window.open / target=_blank calls through our tab system instead
        // of letting Electron open a new BrowserWindow.
        tab.webContents.setWindowOpenHandler(({ url }) => {
            try {
                const proto = new URL(url).protocol;
                if (proto === 'javascript:' || proto === 'data:' || proto === 'vbscript:') {
                    return { action: 'deny' };
                }
            } catch {
                return { action: 'deny' };
            }
            // Open safe URLs as a new tab in the same window, right after this one.
            setImmediate(() => this.createLazyTab(url, url, false, false, true, true));
            return { action: 'deny' };
        });

        tab.webContents.on('did-navigate', (event, url) => {
            // Keep the view backing in sync: frosted (transparent) for internal
            // pages, opaque for web content so vibrancy doesn't bleed through.
            this._applyTabBackground(tab, url);
            // Reader view loaded — keep the address bar showing the real page URL
            // and the article title instead of the internal file:// path.
            if (url.includes('/Reader/index.html')) {
                const orig = this.readerOriginal.get(tabIndex) || '';
                const art  = this.readerArticles.get(tabIndex);
                this.tabUrls.set(tabIndex, orig || 'reader');
                lastAddedUrl = orig;
                this.sendTabUpdate(tabIndex, tab, orig, art?.title || 'Reader View');
                this.sendNavigationUpdate(tabIndex);
                try { this.mainWindow.webContents.send('reader-state', { index: tabIndex, active: true, available: true }); } catch {}
                isNavigatingProgrammatically = false;
                return;
            }
            // Any other navigation exits reader mode for this tab.
            if (this.readerMode.has(tabIndex)) {
                this.readerMode.delete(tabIndex);
                this.readerArticles.delete(tabIndex);
                try { this.mainWindow.webContents.send('reader-state', { index: tabIndex, active: false }); } catch {}
            }

            if (!url.startsWith('file://') && !isNavigatingProgrammatically) {
                if (lastAddedUrl !== url) {
                    this.tabUrls.set(tabIndex, url)
                    this.navigationHistory.addEntry(tabIndex, url)
                    lastAddedUrl = url;

                    this.sendTabUpdate(tabIndex, tab, url)
                    this.sendNavigationUpdate(tabIndex)
                    if (!this.privateTabs.has(tabIndex)) {
                        this.addToHistory(url, tab.webContents.getTitle())
                    }
                    this.saveStateDebounced()
                }
            } else if (url.startsWith('file://')) {
                let resolvedType = 'newtab';
                if (url.includes('/Settings/index.html')) resolvedType = 'settings';
                else if (url.includes('/Bookmarks/index.html')) resolvedType = 'bookmarks';
                else if (url.includes('/History/index.html')) resolvedType = 'history';

                this.tabUrls.set(tabIndex, resolvedType)
                lastAddedUrl = resolvedType;

                let title = 'New Tab';
                if (resolvedType === 'settings') title = 'Settings';
                else if (resolvedType === 'bookmarks') title = 'Bookmarks';
                else if (resolvedType === 'history') title = 'History';

                this.sendTabUpdate(tabIndex, tab, resolvedType, title)
                this.sendNavigationUpdate(tabIndex)
            }

            const windowData = this.getWindowData();
            if (windowData) focusMode.applyToTab(windowData, tab.webContents, url);
            this.applyYouTubeSpaceFix(tab, url);
            
            isNavigatingProgrammatically = false;
        })

        // All window.open / target="_blank" links open in a new tab, never a new BrowserWindow
        tab.webContents.setWindowOpenHandler(({ url }) => {
            setImmediate(() => {
                const isPriv = this.privateTabs.has(tabIndex);
                const newIndex = this.createTab(tabIndex, false, isPriv);
                this.loadUrl(newIndex, url);
            });
            return { action: 'deny' };
        });
        
        tab.webContents.on('did-navigate-in-page', (event, url) => {
            if (!url.startsWith('file://') && !isNavigatingProgrammatically) {
                const currentUrl = this.tabUrls.get(tabIndex);
                if (currentUrl !== url && lastAddedUrl !== url) {
                    this.tabUrls.set(tabIndex, url)
                    this.navigationHistory.addEntry(tabIndex, url)
                    lastAddedUrl = url;

                    this.sendTabUpdate(tabIndex, tab, url)
                    this.sendNavigationUpdate(tabIndex)
                    if (!this.privateTabs.has(tabIndex)) {
                        this.addToHistory(url, tab.webContents.getTitle())
                    }
                    this.saveStateDebounced()
                }
            }

            const windowData = this.getWindowData();
            if (windowData) focusMode.applyToTab(windowData, tab.webContents, url);
            this.applyYouTubeSpaceFix(tab, url);
        })
        
        tab.isNavigatingProgrammatically = () => isNavigatingProgrammatically;
        tab.setNavigatingProgrammatically = (value) => { isNavigatingProgrammatically = value; };

        // HTML5 Fullscreen (e.g. YouTube videos)
        tab.webContents.on('enter-html-full-screen', () => {
            this.isHtmlFullScreen = true;
            this.htmlFullScreenRequested = !this.userFullScreenActive;
            if (this.htmlFullScreenRequested && !this.mainWindow.isFullScreen()) {
                this.mainWindow.setFullScreen(true);
            }
            this.resizeAllTabs();
        });

        tab.webContents.on('leave-html-full-screen', () => {
            if (this.htmlFullScreenRequested && this.mainWindow.isFullScreen()) {
                // OS fullscreen will exit next. Keep isHtmlFullScreen = true so
                // getTabBounds() returns full-window bounds during the macOS exit
                // animation — avoids a corrupted intermediate state (full-window size
                // minus the 88px toolbar offset) that visually sticks until a mouse
                // event triggers a repaint. leave-full-screen clears the flag and does
                // the final resize once the animation is done.
                // Also keep htmlFullScreenRequested = true so leave-full-screen knows
                // NOT to call applyYouTubeExitFullscreen (which would race the animation
                // and double-toggle back into fullscreen on macOS).
                setTimeout(() => {
                    try {
                        if (this.mainWindow && !this.mainWindow.isDestroyed() && this.mainWindow.isFullScreen()) {
                            this.mainWindow.setFullScreen(false);
                        }
                    } catch {}
                }, 0);
            } else {
                // No OS fullscreen exit pending — clean up immediately.
                this.isHtmlFullScreen = false;
                this.htmlFullScreenRequested = false;
                // Do NOT call applyYouTubeExitFullscreen here — YouTube cleans up its own
                // CSS state (.ytp-fullscreen) when HTML5 fullscreen exits. Clicking the button
                // here causes a double-toggle and also fires spuriously when DevTools opens.
                this.resizeAllTabs();
            }
        });

        // Error page — skip aborts (e.g. navigating away mid-load) and sub-frame errors
        tab.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
            if (!isMainFrame) return;
            if (errorCode === -3) return; // ERR_ABORTED — user navigated away
            const params = new URLSearchParams({
                url:  validatedURL || '',
                code: String(errorCode),
                desc: errorDescription || '',
            });
            isNavigatingProgrammatically = true;
            tab.webContents.loadFile(
                path.join(__dirname, '../renderer/Error/index.html'),
                { search: '?' + params.toString() }
            );
        });

        tab.webContents.on('found-in-page', (event, result) => {
            if (this.findDialog) {
                this.findDialog.handleFindResult(result);
            }
        });
        
        tab.webContents.on('page-title-updated', (event, title) => {
            tab.lazyTitle = title;
            this.navigationHistory.setCurrentTitle(tabIndex, title);
            const currentUrl = this.tabUrls.get(tabIndex) || ''
            if (currentUrl !== 'newtab' && currentUrl !== 'history' && !currentUrl.startsWith('file://')) {
                this.sendTabUpdate(tabIndex, tab, currentUrl, title)
            }
        })

        tab.webContents.on('page-favicon-updated', (event, favicons) => {
            const currentUrl = this.tabUrls.get(tabIndex) || ''
            if (currentUrl !== 'newtab' && currentUrl !== 'history' && !currentUrl.startsWith('file://')) {
                const favicon = favicons && favicons.length > 0 ? favicons[0] : null
                this.sendTabUpdate(tabIndex, tab, currentUrl, tab.webContents.getTitle(), favicon)
            }
        })
        
        tab.webContents.on('did-start-loading', () => {
            this.sendLoadingState(tabIndex, true)
        })

        tab.webContents.on('did-finish-load', () => {
            this.sendNavigationUpdate(tabIndex)
            this.detectReaderable(tabIndex, tab)
        })

        tab.webContents.on('did-stop-loading', () => {
            this.sendNavigationUpdate(tabIndex)
            this.sendLoadingState(tabIndex, false)
        })

        // Picture-in-Picture is only offered while media is actually playing.
        // Track a per-tab flag and tell the chrome to show/hide the PiP button.
        tab.webContents.on('media-started-playing', () => {
            tab.hasPlayingMedia = true;
            if (tabIndex === this.activeTabIndex) {
                try { this.mainWindow.webContents.send('media-state', { index: tabIndex, playing: true }); } catch {}
            }
            // Mini player: media playing in a background tab shows the overlay.
            try { miniPlayer.onMediaState(this.getWindowData(), tabIndex, true); } catch {}
            this.sendMediaIndicators(tabIndex, tab); // muted tabs stay marked while playing
        });
        tab.webContents.on('media-paused', () => {
            tab.hasPlayingMedia = false;
            if (tabIndex === this.activeTabIndex) {
                try { this.mainWindow.webContents.send('media-state', { index: tabIndex, playing: false }); } catch {}
            }
            try { miniPlayer.onMediaState(this.getWindowData(), tabIndex, false); } catch {}
            this.sendMediaIndicators(tabIndex, tab);
        });

        // ── Tab-strip media indicators ────────────────────────────────────────
        // Speaker on audible tabs; mic/camera (recording) from the permission
        // layer's custom event — a granted getUserMedia is when capture starts.
        // Chromium gives no stream-ended signal, so recording clears on
        // navigation (the temp permission grants clear there too).
        tab.webContents.on('audio-state-changed', (e) => {
            tab.isAudible = !!e.audible;
            this.sendMediaIndicators(tabIndex, tab);
        });
        tab.webContents.on('media-capture-started', (names) => {
            if (!tab.capturing) tab.capturing = new Set();
            (Array.isArray(names) ? names : []).forEach(n => tab.capturing.add(n));
            this.sendMediaIndicators(tabIndex, tab);
        });
        tab.webContents.on('did-navigate', () => {
            if (tab.capturing && tab.capturing.size) {
                tab.capturing.clear();
                this.sendMediaIndicators(tabIndex, tab);
            }
        });
    }

    sendMediaIndicators(index, tab) {
        const cap = tab.capturing || new Set();
        const capture = cap.has('camera') ? 'camera' : (cap.has('microphone') ? 'mic' : null);
        try {
            this.mainWindow.webContents.send('tab-media-indicator', {
                index, audible: !!tab.isAudible, capture,
                muted: !!tab.webContents.isAudioMuted(),
                playing: !!tab.hasPlayingMedia,
            });
        } catch {}
    }

    sendTabUpdate(tabIndex, tab, url, title, favicon) {
        let displayUrl = url;
        let displayTitle = title || this.computeDisplayTitleFor(tabIndex) || "New Tab";
        
        let isInternal = ['newtab', 'settings', 'bookmarks', 'history'].includes(url) || (url && url.startsWith('file://'));

        if (isInternal) {
            displayUrl = '';
            if (url === 'settings' || (url && url.includes('/Settings/index.html'))) displayTitle = 'Settings';
            else if (url === 'bookmarks' || (url && url.includes('/Bookmarks/index.html'))) displayTitle = 'Bookmarks';
            else if (url === 'history' || (url && url.includes('/History/index.html'))) displayTitle = 'History';
            else displayTitle = 'New Tab';
        }
        
        // Provide a default favicon instantly for http/https URLs to prevent empty gaps
        let resolvedFavicon = favicon;
        if (this.privateTabs.has(tabIndex)) {
            // The chrome renderer loads favicons through the DEFAULT session —
            // fetching one for a private tab (especially via Google's favicon
            // service) would leak the hostname outside the private session.
            resolvedFavicon = null;
        } else if (!resolvedFavicon && url && url.startsWith('http')) {
            try {
                resolvedFavicon = `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=32`;
            } catch (e) {}
        }
        
        this.mainWindow.webContents.send('url-updated', {
            index: tabIndex,
            url: displayUrl,
            title: displayTitle,
            favicon: resolvedFavicon,
            private: this.privateTabs.has(tabIndex),
        })

        // Keep the window title in sync with the active tab
        if (tabIndex === this.activeTabIndex) {
            this.updateWindowTitle(tabIndex, displayTitle);
        }
    }
    
    // ── Tab sleeping ──────────────────────────────────────────────────────────
    // Free the renderer process of long-inactive background tabs (like Chrome's
    // memory saver). The WebContentsView and its navigation history survive;
    // showTab()/loadUrl() transparently revive the tab with a reload. Never
    // sleeps: the active tab, pinned tabs, tabs playing audio/media, internal
    // pages, unloaded lazy tabs, or tabs with DevTools open.
    _sleepScan() {
        if (!this.mainWindow || this.mainWindow.isDestroyed()) {
            clearInterval(this._sleepTimer);
            return;
        }
        const p = this.persistence;
        if (p && p.get('tabSleepEnabled') === false) return;
        const mins   = Math.max(1, Number(p?.get('tabSleepMinutes')) || 30);
        const cutoff = Date.now() - mins * 60_000;

        this.tabMap.forEach((tab, i) => {
            if (i === this.activeTabIndex || tab.slept) return;
            if (tab.lazyLoaded === false) return;          // not loaded — nothing to free
            if (this.pinnedTabs.has(i)) return;
            const url = this.tabUrls.get(i) || '';
            if (!/^https?:/i.test(url)) return;            // only real web pages
            if ((this.tabLastActive.get(i) || 0) > cutoff) return;
            try {
                const wc = tab.webContents;
                if (!wc || wc.isDestroyed() || wc.isCrashed()) return;
                if (tab.hasPlayingMedia || wc.isCurrentlyAudible()) return;
                if (wc.isDevToolsOpened()) return;
                tab.slept = true;
                wc.forcefullyCrashRenderer();              // frees the whole renderer process
            } catch {}
        });
    }

    // Tell the chrome a tab started/stopped loading so it can show a tab
    // spinner and flip the reload button to a stop button (and back).
    sendLoadingState(tabIndex, loading) {
        try {
            this.mainWindow.webContents.send('tab-loading', { index: tabIndex, loading: !!loading });
        } catch (e) {}
    }

    sendNavigationUpdate(tabIndex) {
        if (this.tabMap.has(tabIndex) && tabIndex === this.activeTabIndex) {
            try {
                this.mainWindow.webContents.send('navigation-updated', {
                    index: tabIndex,
                    canGoBack: this.canGoBack(tabIndex),
                    canGoForward: this.canGoForward(tabIndex)
                })
            } catch (error) {
                
            }
        }
    }
    
    addToHistory(url, title) {
        if (this.history && url && !url.startsWith('file://')) {
            this.history.addToHistory(url, title || url).catch(error => {
                
            })
        }
    }
    
    showTab(index) {
        this.tabMap.forEach((tab, i) => {
            tab.setVisible(false)
        })

        if (this.tabMap.has(index)) {
            const tab = this.tabMap.get(index);
            tab.setVisible(true)
            // Sleep bookkeeping: the outgoing tab starts ageing now; the incoming
            // tab is fresh. Wake it if the sleep scan discarded its renderer.
            this.tabLastActive.set(this.activeTabIndex, Date.now())
            this.tabLastActive.set(index, Date.now())
            if (tab.slept) {
                tab.slept = false;
                try { tab.webContents.reload(); } catch {}
            }
            // Eager background tabs load muted; restore sound on first view.
            if (tab.mutedUntilShown) {
                tab.mutedUntilShown = false;
                try { tab.webContents.audioMuted = false; } catch {}
            }
            // Mini player: hide when arriving at the media tab; show when
            // walking away from a tab that is still playing. createTab pre-sets
            // activeTabIndex, so prefer the explicit previous index it stashes.
            const prevActiveIndex = (this._pendingPrevActive !== undefined)
                ? this._pendingPrevActive : this.activeTabIndex;
            this._pendingPrevActive = undefined;
            this.activeTabIndex = index
            try { miniPlayer.onTabSwitch(this.getWindowData(), prevActiveIndex, index); } catch {}

            if (tab.lazyLoaded === false) {
                tab.lazyLoaded = true;
                const lazyUrl = this.tabUrls.get(index);
                if (lazyUrl === 'history') {
                    tab.webContents.loadFile('renderer/History/index.html');
                } else if (lazyUrl === 'bookmarks') {
                    tab.webContents.loadFile('renderer/Bookmarks/index.html');
                } else if (lazyUrl === 'settings') {
                    tab.webContents.loadFile('renderer/Settings/index.html');
                } else if (lazyUrl && lazyUrl !== 'newtab' && !lazyUrl.startsWith('file://')) {
                    tab.webContents.loadURL(lazyUrl);
                } else {
                    const isPrivTab = this.privateTabs.has(index);
                    tab.webContents.loadFile(isPrivTab ? 'renderer/NewTab/private.html' : 'renderer/NewTab/index.html');
                }
            } else if (tab.needsReloadForFocusMode) {
                tab.needsReloadForFocusMode = false;
                tab.needsReloadForShortform = false;
                tab.webContents.reload();
            } else if (tab.needsReloadForShortform) {
                tab.needsReloadForShortform = false;
                tab.webContents.reload();
            }

            const currentUrl = this.tabUrls.get(index) || ''
            
            this.mainWindow.webContents.send('tab-switched', {
                index: index,
                url: (currentUrl === 'newtab' || currentUrl === 'history') ? '' : currentUrl,
                totalTabs: this.tabMap.size
            })
            
            this.sendNavigationUpdate(index)

            // Reflect the newly active tab's loading state on the reload button.
            try { this.sendLoadingState(index, tab.webContents.isLoading()); } catch (e) {}

            // Sync reader/PiP button visibility to the newly active tab.
            try {
                this.mainWindow.webContents.send('media-state', { index, playing: !!tab.hasPlayingMedia });
                if (this.readerMode.has(index)) {
                    this.mainWindow.webContents.send('reader-state', { index, active: true, available: true });
                } else {
                    this.detectReaderable(index, tab);
                }
            } catch {}

            // Update window title to reflect the newly active tab
            this.updateWindowTitle(index)

            // Notify the extension system of the active tab (chrome.tabs + actions)
            if (!this.privateTabs.has(index)) extensions.selectTab(tab.webContents)

            // Put the website back into focus so keyboard events register immediately
            tab.webContents.focus()
            this.raiseFloatingViews()
        }
    }
    
    loadUrl(index, url) {
        if (this.tabMap.has(index)) {
            const tab = this.tabMap.get(index)
            tab.slept = false; // loading revives a slept (discarded) renderer
            tab.webContents.loadURL(url)
            this.tabUrls.set(index, url)
            
            // Set a temporary title before the page actually loads
            let tempTitle = url;
            try { tempTitle = new URL(url).hostname; } catch {}
            tab.lazyTitle = tempTitle;
            this.sendTabUpdate(index, tab, url, tempTitle);
            
            this.navigationHistory.addEntry(index, url)
            this.saveStateDebounced()

            setTimeout(() => {
                this.sendNavigationUpdate(index)
            }, 200)
        }
    }
    
    destroyTab(tab) {
        try { tab.webContents.audioMuted = true; } catch {}
        try { this.mainWindow.contentView.removeChildView(tab); } catch {}
        try { tab.webContents.destroy(); } catch {}
        // Private tab → its isolated session dies with it. Deferred one tick
        // so the webContents teardown settles before storage is cleared.
        if (tab.privateSession) {
            const sess = tab.privateSession;
            tab.privateSession = null;
            setImmediate(() => { try { privateSessions.destroyTabSession(sess); } catch {} });
        }
    }

    recordClosed(index) {
        // Private tabs must not be resurrectable via "reopen closed tab".
        if (this.privateTabs.has(index)) return;
        const url = this.tabUrls.get(index);
        if (url && url !== 'newtab' && !url.startsWith('file://')) {
            const tab = this.tabMap.get(index);
            let title = url;
            try { title = tab?.webContents?.getTitle() || url; } catch {}
            this.closedTabHistory.push({ url, title });
            if (this.closedTabHistory.length > 20) this.closedTabHistory.shift();
        }
    }

    // The tab to activate after `index` is closed: the visually-adjacent tab in
    // tab-bar order (right neighbour, else left). Call BEFORE removing `index`.
    // Chrome/Firefox behaviour; keyed off tabOrder so it respects drag-reorder.
    _neighborInOrder(index) {
        const order = this.tabOrder;
        const pos = order.indexOf(index);
        if (pos === -1) return null;
        for (let i = pos + 1; i < order.length; i++) if (this.tabMap.has(order[i])) return order[i];
        for (let i = pos - 1; i >= 0; i--)          if (this.tabMap.has(order[i])) return order[i];
        return null;
    }

    removeTab(index) {
        if (this.tabMap.has(index)) {
            const wasActive  = this.activeTabIndex === index;
            const nextActive = wasActive ? this._neighborInOrder(index) : null;
            const tab = this.tabMap.get(index)
            this.recordClosed(index)
            this.destroyTab(tab)
            this.tabMap.delete(index)
            this.tabUrls.delete(index)
            this.pinnedTabs.delete(index)
            this.privateTabs.delete(index); // session wipe happens in destroyTab()
            this.tabOrder = this.tabOrder.filter(i => i !== index)
            this.tabLastActive.delete(index)
            try { miniPlayer.onTabClosed(this.getWindowData(), index) } catch {}

            this.navigationHistory.removeTab(index)

            this.mainWindow.webContents.send('tab-removed', {
                index: index,
                totalTabs: this.tabMap.size
            })

            if (wasActive && this.tabMap.size > 0) {
                const target = (nextActive !== null && this.tabMap.has(nextActive))
                    ? nextActive : this.tabOrder[0];
                this.showTab(target)
            }

            if (this.tabMap.size === 0) {
                this.allowClose = true;
                this.mainWindow.close();
            }
            this.saveStateDebounced()
        }
    }
    
    removeTabWithTargetFocus(index, targetTabIndex = null) {
        if (this.tabMap.has(index)) {
            const wasActive = this.activeTabIndex === index;
            // Prefer an explicit valid target; otherwise fall back to the
            // visually-adjacent tab (right, else left) in tab-bar order.
            const nextActive = (targetTabIndex !== null && this.tabMap.has(targetTabIndex))
                ? targetTabIndex : this._neighborInOrder(index);
            const tab = this.tabMap.get(index);
            this.recordClosed(index)
            this.destroyTab(tab);
            this.tabMap.delete(index);
            this.tabUrls.delete(index);
            this.pinnedTabs.delete(index);
            this.privateTabs.delete(index); // session wipe happens in destroyTab()
            this.tabOrder = this.tabOrder.filter(i => i !== index)
            this.tabLastActive.delete(index);
            try { miniPlayer.onTabClosed(this.getWindowData(), index); } catch {}

            this.navigationHistory.removeTab(index);
            
            this.mainWindow.webContents.send('tab-removed', {
                index: index,
                totalTabs: this.tabMap.size
            });
            
            if (this.tabMap.size === 0) {
                this.allowClose = true;
                this.mainWindow.close();
            } else {
                if (wasActive) {
                    const target = (nextActive !== null && this.tabMap.has(nextActive))
                        ? nextActive : this.tabOrder[0];
                    this.showTab(target);
                }

                setTimeout(() => {
                    if (!this.mainWindow.isDestroyed()) {
                        this.mainWindow.focus();
                    }
                }, 20);
            }
            this.saveStateDebounced()
        }
    }
    
    getTotalTabs() {
        return this.tabMap.size
    }
    
    goBack(index) {
        if (this.tabMap.has(index)) {
            const tab = this.tabMap.get(index)
            const previousUrl = this.navigationHistory.goBack(index)
            const isPriv = this.privateTabs.has(index);
            const newTabFile = isPriv ? 'renderer/NewTab/private.html' : 'renderer/NewTab/index.html';

            if (previousUrl && previousUrl !== 'newtab') {
                tab.setNavigatingProgrammatically(true);
                tab.webContents.loadURL(previousUrl)
                this.tabUrls.set(index, previousUrl)
            } else if (previousUrl === 'newtab') {
                tab.setNavigatingProgrammatically(true);
                tab.webContents.loadFile(newTabFile)
                this.tabUrls.set(index, 'newtab')
            } else {
                tab.webContents.loadFile(newTabFile)
                this.tabUrls.set(index, 'newtab')
            }
            this.sendNavigationUpdate(index)
        }
    }

    goForward(index) {
        if (this.tabMap.has(index)) {
            const tab = this.tabMap.get(index)
            const nextUrl = this.navigationHistory.goForward(index);
            const isPriv = this.privateTabs.has(index);

            if (nextUrl && nextUrl !== 'newtab') {
                tab.setNavigatingProgrammatically(true);
                tab.webContents.loadURL(nextUrl)
                this.tabUrls.set(index, nextUrl)
            } else if (nextUrl === 'newtab') {
                tab.setNavigatingProgrammatically(true);
                tab.webContents.loadFile(isPriv ? 'renderer/NewTab/private.html' : 'renderer/NewTab/index.html')
                this.tabUrls.set(index, 'newtab')
            }
            this.sendNavigationUpdate(index)
        }
    }

    // Jump straight to a history entry (back/forward long-press dropdown)
    goToHistoryIndex(index, historyIndex) {
        if (!this.tabMap.has(index)) return;
        const tab = this.tabMap.get(index);
        const url = this.navigationHistory.goToIndex(index, historyIndex);
        if (url === null) return;

        tab.setNavigatingProgrammatically(true);
        if (url && url !== 'newtab') {
            tab.webContents.loadURL(url);
            this.tabUrls.set(index, url);
        } else {
            const isPriv = this.privateTabs.has(index);
            tab.webContents.loadFile(isPriv ? 'renderer/NewTab/private.html' : 'renderer/NewTab/index.html');
            this.tabUrls.set(index, 'newtab');
        }
        this.sendTabUpdate(index, tab, this.tabUrls.get(index));
        this.sendNavigationUpdate(index);
    }

    // ── Reader mode ────────────────────────────────────────────────────────────

    // Ask the page whether it looks like an article; tell the chrome to
    // enable/disable the reader button for the active tab.
    detectReaderable(index, tab) {
        if (this.readerMode.has(index)) return; // reader page itself isn't "readerable"
        const url = (tab.webContents.getURL && tab.webContents.getURL()) || '';
        if (!/^https?:/.test(url)) {
            if (index === this.activeTabIndex) {
                try { this.mainWindow.webContents.send('reader-state', { index, active: false, available: false }); } catch {}
            }
            return;
        }
        tab.webContents.executeJavaScript(READERABLE_JS, true)
            .then((ok) => {
                try { this.mainWindow.webContents.send('reader-state', { index, active: false, available: !!ok }); } catch {}
            })
            .catch(() => {});
    }

    async toggleReader(index) {
        const tab = this.tabMap.get(index);
        if (!tab) return;

        if (this.readerMode.has(index)) {
            // Exit — restore the original page.
            const orig = this.readerOriginal.get(index);
            this.readerMode.delete(index);
            this.readerArticles.delete(index);
            tab.setNavigatingProgrammatically(true);
            if (orig) { this.tabUrls.set(index, orig); tab.webContents.loadURL(orig); }
            else tab.webContents.reload();
            return;
        }

        let article = null;
        try { article = await tab.webContents.executeJavaScript(EXTRACT_JS, true); } catch {}
        if (!article || !article.ok) {
            try { this.mainWindow.webContents.send('reader-failed', { index }); } catch {}
            return;
        }
        this.readerArticles.set(index, article);
        this.readerOriginal.set(index, tab.webContents.getURL());
        this.readerMode.add(index);
        tab.setNavigatingProgrammatically(true);
        tab.webContents.loadFile('renderer/Reader/index.html');
    }

    getReaderArticle(index) {
        return this.readerArticles.get(index) || null;
    }

    // ── Picture-in-Picture ───────────────────────────────────────────────────────

    togglePictureInPicture(index) {
        const tab = this.tabMap.get(index);
        if (!tab || !tab.webContents || tab.webContents.isDestroyed()) return;
        // userGesture = true so the PiP request counts as user-activated.
        tab.webContents.executeJavaScript(PIP_JS, true).catch(() => {});
    }

    reload(index) {
        if (this.tabMap.has(index)) {
            const tab = this.tabMap.get(index)
            tab.webContents.reload()
            setTimeout(() => {
                this.sendNavigationUpdate(index)
            }, 100)
        }
    }
    
    canGoBack(index) {
        if (this.tabMap.has(index)) {
            const canGoBack = this.navigationHistory.canGoBack(index);
            return canGoBack;
        }
        return false
    }
    
    canGoForward(index) {
        if (this.tabMap.has(index)) {
            const canGoForward = this.navigationHistory.canGoForward(index);
            return canGoForward;
        }
        return false
    }
    
    resizeAllTabs() {
        const bounds = this.getTabBounds()

        this.tabMap.forEach((tab, index) => {
            tab.setBounds(bounds)
        })
    }

    collapseAllTabs() {
        // Move tabs off-screen so native views don't cover HTML overlays
        this.tabMap.forEach((tab) => {
            tab.setBounds({ x: -9999, y: -9999, width: 1, height: 1 });
        });
    }

    restoreAllTabs() {
        this.resizeAllTabs();
    }

    muteTab(index) {
        if (this.tabMap.has(index)) {
            const tab = this.tabMap.get(index);
            const isMuted = tab.webContents.isAudioMuted();
            tab.webContents.setAudioMuted(!isMuted);
            this.sendMediaIndicators(index, tab); // flip the speaker icon at once
        }
    }

    pinTab(index) {
        const isPinned = this.pinnedTabs.has(index)
        if (!isPinned) {
            const totalTabs = this.tabMap.size
            const futurePinned = this.pinnedTabs.size + 1
            const futureUnpinned = totalTabs - futurePinned
            if (futureUnpinned <= 0) {
                // Auto-create a new unpinned tab to keep at least one unpinned
                this.createTab()
            }
            this.pinnedTabs.add(index)
        } else {
            this.pinnedTabs.delete(index)
        }
        this.mainWindow.webContents.send('pin-tab', { index });
        this.saveStateDebounced()
    }

    reorderTabs(newOrder) {
        if (!Array.isArray(newOrder)) return;
        const allKeys = new Set(this.tabMap.keys());
        const ok = newOrder.every(k => allKeys.has(k)) && newOrder.length === allKeys.size;
        if (!ok) return;
        this.tabOrder = [...newOrder];
        this.saveStateDebounced();
    }

    buildSerializableState() {
        const includeAll = !!(this.persistence && this.persistence.getPersistMode());
        const order = this.tabOrder.length ? this.tabOrder : Array.from(this.tabMap.keys());
        const selected = includeAll
            ? order.filter(idx => !this.privateTabs.has(idx))
            : order.filter(idx => this.pinnedTabs.has(idx) && !this.privateTabs.has(idx));
        const tabs = selected.map((idx) => {
            const url = this.tabUrls.get(idx) || 'newtab';
            let title = this.computeDisplayTitleFor(idx) || 'New Tab';
            return {
                url,
                title,
                pinned: this.pinnedTabs.has(idx)
            };
        });
        // Map active to its ordinal within the SAVED list (selected), not the
        // full tab order — filtered-out tabs (private / unpinned) would shift
        // the index and the wrong tab would be focused on restore.
        const activeOrdinal = Math.max(0, selected.indexOf(this.activeTabIndex));
        return { tabs, activeIndex: activeOrdinal, persistAllTabs: includeAll };
    }

    saveStateDebounced() {
        if (!this.persistence) return;
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
            try { this.persistence.saveState(this.buildSerializableState()); } catch {}
        }, 200);
    }
}

module.exports = Tabs;
