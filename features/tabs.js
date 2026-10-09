const { WebContentsView, Menu, dialog } = require('electron');
const { resolveAppFile } = require('../app-paths');
const log = require('./log');
const { TabSleeper } = require('./tabs/sleep');
const { overlayViewsOf } = require('./overlay-registry');
const overlayMenu = require('./overlay-menu');
const i18n = require('./i18n');
const preloadForPage = require('./tabs/preload-for-page');
const path = require('path');
const UserAgent = require('./user-agent');
const containers = require('./containers');
const profiles = require('./profiles');
const permissionUI = require('./permission-ui');
const captivePortal = require('./captive-portal');
const contextMenu = require('./tab-context-menu');
const faviconStore = require('./favicon-store');
const NavigationHistory = require('./navigation-history');
const FindDialogManager = require('./find-dialog');
const focusMode = require('./focus-mode');
const { READERABLE_JS, EXTRACT_JS, PIP_JS } = require('./reader');
const extensions = require('./extensions');
// The SAME window-relative sidebar clamp the renderer uses for --sidebar-w. Main
// positions the page view's left edge at this.sidebarWidth, so if the two clamps
// disagree the page view covers (or leaves a gap beside) the sidebar's resize
// handle — the "sidebar is behind the tab view" bug on wide/maximized windows.
const { clampSidebarWidth, mergeOrder } = require('../renderer/lib/util');
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
                try { player.exitFullscreen(); } catch (e) { log.debug('tabs', 'toggleYouTubeFullscreen', e); }
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
// Internal-page helpers (northstar:// scheme, section list, URL↔token) live in a
// shared leaf module so the listeners mixin can use internalTokenFor too.
const { INTERNAL_PAGES, SETTINGS_SECTIONS, parseNorthstarUrl, parseInternalToken, internalTokenFor } = require('./tabs/internal-page');
class Tabs {
    // ── Wiring ────────────────────────────────────────────────────────────
    mainWindow;
    history;
    persistence; // Persistence — injected by WindowManager
    navigationHistory;
    findDialog; // FindDialog for this window
    shortcuts; // Shortcuts — set later via setShortcuts()
    windowManager; // WindowManager — set later via setWindowManager()
    // ── Tab bookkeeping ───────────────────────────────────────────────────
    tabMap; // tabIndex → live view
    tabUrls; // tabIndex → last committed URL
    tabOrder; // visual order of tab indices
    tabLastActive; // tabIndex → Date.now() of last activation
    activeTabIndex;
    nextTabIndex; // monotonically increasing id source
    pinnedTabs;
    privateTabs;
    isPrivateWindow;
    closedTabHistory; // stack for "Reopen Closed Tab"
    // ── Window close / fullscreen state machines ──────────────────────────
    allowClose;
    closePreventionActive;
    isHtmlFullScreen; // page called requestFullscreen()
    htmlFullScreenRequested;
    userFullScreenActive; // user pressed F11 / green button
    // ── Reader mode ───────────────────────────────────────────────────────
    readerMode; // tab indices currently showing the reader view
    readerArticles; // tabIndex → extracted article
    readerOriginal; // tabIndex → original URL to restore on exit
    // ── Timers / transient ────────────────────────────────────────────────
    bookmarkBarHeight;
    saveTimer;
    _pendingPrevActive; // tab to reactivate after a background-tab close
    constructor(mainWindow, History, Persistence, options = {}) {
        this.mainWindow = mainWindow;
        // Identifies this window inside the multi-window session file. Set by
        // WindowManager; a stable per-run id is all the state file needs.
        this.windowKey = options.windowKey ?? 0;
        this.history = History;
        this.persistence = Persistence || null;
        this.navigationHistory = new NavigationHistory();
        this.findDialog = FindDialogManager.getInstance().createDialog(mainWindow);
        this.shortcuts = null;
        this.tabMap = new Map();
        this.tabUrls = new Map();
        // Tab sleeping: free the renderer process of long-inactive background
        // tabs (Chrome's "memory saver"). tabLastActive tracks when a tab was
        // last the active tab; the scan puts stale ones to sleep.
        this.tabLastActive = new Map();
        // Tab sleeping is a COLLABORATOR (features/tabs/sleep.js), not a mixin:
        // it owns its own timer and names exactly what it reads off Tabs.
        this.sleeper = new TabSleeper(this);
        this.sleeper.start();
        // The sleeper reads this for the kNotificationsEnabled protection — a tab
        // whose origin may show notifications is never discarded (features/tabs/sleep.js).
        this.sitePermissions = require('./site-permissions');
        // -1 until a tab exists: a window opens with none, and pointing at
        // tab 0 while the map is empty makes every lookup a silent miss.
        this.activeTabIndex = -1;
        this.nextTabIndex = 0;
        this.allowClose = false;
        this.closePreventionActive = false;
        this.isHtmlFullScreen = false;
        this.htmlFullScreenRequested = false;
        this.userFullScreenActive = false;
        this.pinnedTabs = new Set();
        this.privateTabs = new Set();
        this.tabContainers = new Map(); // tabIndex → container id
        this.nextContainerId = 1;
        this.isPrivateWindow = options?.private ?? false;
        // Live sidebar width (px) — drag-resizable, persisted. Clamped with the
        // renderer's window-relative rule (clampSidebarWidth) so the page view's
        // left edge always lines up with the rendered sidebar. Recomputed on
        // window resize (below), since the limits scale with the window and the
        // window may still maximize after this constructor runs.
        this.sidebarWidth = this._computeSidebarWidth();
        this.sidePanelWidth = 0; // set while an extension side panel is docked
        // Which workspace/profile this window is currently browsing as ('1' =
        // default session + legacy stores). Containers scope within it. Tabs are
        // tagged with the workspace they were opened in (tabProfiles) so
        // switching workspaces swaps the visible tab set IN PLACE.
        this.profileId = options?.profile ? String(options.profile) : '1';
        this.tabProfiles = new Map(); // tabIndex → workspace/profile id
        this.folders = []; // [{ id, name, collapsed, workspace }] — tab folders
        this.tabLabels = new Map(); // tabIndex → user-set label overriding the page title
        this.tabIcons = new Map(); // tabIndex → user-set icon overriding the favicon
        this.pinnedHome = new Map(); // tabIndex → the url a pinned tab resets to
        this.tabFolders = new Map(); // tabIndex → folderId
        this._folderSeq = 1;
        this.tabScroll = new Map(); // tabIndex → last reported scrollY (session restore)
        this.splitPair = null; // [firstIdx, secondIdx] when split view is active
        this.splitOrient = 'row'; // 'row' = side by side, 'col' = stacked
        this.splitRatio = 0.5; // fraction of the page card taken by the first pane
        this.splitDivider = null; // draggable bar between the two panes
        this.splitHandles = [null, null]; // per-pane reposition handle (top centre)
        this.splitDrop = null; // drop-zone overlay shown while a tab is dragged
        this.glanceView = null; // floating page-preview overlay ("glance")
        this.glanceBackdrop = null; // dim view behind the glance
        this.glanceBar = null; // header strip above the glance card
        this.glanceUrl = null;
        this.sidebarCompact = false; // side mode: sidebar hidden, page full-bleed
        this.tabOrder = [];
        this.closedTabHistory = []; // stack of {url, title} for "Reopen Closed Tab"
        this.readerMode = new Set(); // tab indices currently showing the reader view
        this.readerArticles = new Map(); // tabIndex → extracted article (served to the reader page)
        this.readerOriginal = new Map(); // tabIndex → original URL to restore on exit
        this.mainWindow.on('resize', () => {
            // The sidebar's allowed width scales with the window, so a resize
            // (crucially, the maximize that fires AFTER this constructor) can move
            // the clamp. Recompute with the same rule the renderer uses and, if it
            // moved, push the new width so the rendered sidebar and the page view's
            // left edge stay aligned — otherwise the page view creeps over the
            // resize handle and it can't be grabbed.
            const w = this._computeSidebarWidth();
            if (w !== this.sidebarWidth) {
                this.sidebarWidth = w;
                try { this.mainWindow.webContents.send('sidebar-width-changed', w); }
                catch (e) { log.debug('tabs', 'resize sidebar-width', e); }
            }
            this.resizeAllTabs();
        });
        this.mainWindow.on('enter-full-screen', () => {
            if (!this.isHtmlFullScreen)
                this.userFullScreenActive = true;
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
                        tab.webContents.executeJavaScript('if (document.fullscreenElement) document.exitFullscreen();').catch(() => { });
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
                    try {
                        if (!this.mainWindow.isDestroyed())
                            this.mainWindow.close();
                    }
                    catch (e) { log.debug('tabs', 'constructor', e); }
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
    createLazyTab(url, title, isPinned, isPrivate = false, insertAfterActive = false, eager = false, containerId = null, workspaceId = null) {
        const tabIndex = this.nextTabIndex;
        this.nextTabIndex++;
        const makePrivate = isPrivate || this.isPrivateWindow;
        // Restore may rebuild tabs of a non-active workspace — honour the saved
        // workspace tag; live-created lazy tabs use the current one.
        const workspace = workspaceId ? String(workspaceId) : this.profileId;
        // Container binding is fixed here (chosen at creation, like private) and
        // only applies to non-private tabs.
        const container = (!makePrivate && containerId != null && String(containerId) !== '') ? String(containerId) : null;
        const webPrefs = {
            autoplayPolicy: 'user-gesture-required',
            preload: preloadForPage(url),
            contextIsolation: true,
            nodeIntegration: false,
            // Elastic overscroll. Electron defaults this OFF, which is why
            // scrolling felt subtly unlike every other Mac browser — hitting the
            // top or bottom of a page just stopped dead instead of rubber-banding.
            scrollBounce: true,
        };
        if (makePrivate) {
            webPrefs.session = this._getPrivateSession();
            webPrefs.v8CacheOptions = 'none'; // disable V8 bytecode cache for private tabs
        }
        else if (container) {
            webPrefs.session = containers.get(container);
        }
        else if (this.profileId !== '1') {
            webPrefs.session = profiles.sessionFor(this.profileId);
        }
        const tab = new WebContentsView({ webPreferences: webPrefs });
        try { tab.setBorderRadius(Tabs.PAGE_RADIUS); } catch (e) { log.debug('tabs', 'container', e); }
        if (makePrivate) {
            tab.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
            tab.privateSession = webPrefs.session; // wiped when the tab closes
        }
        this.mainWindow.contentView.addChildView(tab);
        this.raiseFloatingViews();
        tab.setVisible(false); // Do not show initially
        UserAgent.setupTab(tab);
        this._applyTabBackground(tab, url || 'newtab');
        // Every non-private tab is registered; addTab resolves the host for the
        // tab's own session, so extensions work in every space and container.
        // Private tabs stay out, matching Chrome's incognito default.
        if (!makePrivate)
            extensions.addTab(tab.webContents, this.mainWindow);
        // Setup context menu
        tab.webContents.on("context-menu", async (_event, params) => {
            let menuParams = params;
            if (params?.linkURL) {
                try {
                    await tab.webContents.executeJavaScript('try { const s = window.getSelection && window.getSelection(); if (s) s.removeAllRanges(); } catch {}', true);
                }
                catch (e) { log.debug('tabs', 'container', e); }
                menuParams = { ...params, selectionText: '' };
            }
            const contextMenuInstance = new contextMenu(tab, menuParams, this);
            const template = contextMenuInstance.getTemplate();
            /* The app's own menu, not the OS's — a right-click on a page should
               look like a right-click anywhere else in this browser. Falls back
               to native if the overlay cannot be shown, so a menu is never
               simply missing. */
            const bounds = this.getTabBounds();
            if (overlayMenu.popup(this.getWindowData(), template,
                bounds.x + (params.x || 0), bounds.y + (params.y || 0)))
                return;
            const menu = Menu.buildFromTemplate(template);
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
        // current one (Chrome/the standard style); everything else (session restore,
        // etc.) appends to the end so restored order is preserved.
        const afterIdx = (insertAfterActive && this.tabOrder.includes(this.activeTabIndex))
            ? this.activeTabIndex : null;
        const afterPos = afterIdx !== null ? this.tabOrder.indexOf(afterIdx) : -1;
        if (afterPos !== -1)
            this.tabOrder.splice(afterPos + 1, 0, tabIndex);
        else
            this.tabOrder.push(tabIndex);
        if (isPinned) {
            this.pinnedTabs.add(tabIndex);
        }
        if (makePrivate) {
            this.privateTabs.add(tabIndex);
        }
        tab.isPrivate = makePrivate;
        tab.containerId = container;
        if (container)
            this.tabContainers.set(tabIndex, container);
        this.tabProfiles.set(tabIndex, workspace);
        tab.lazyLoaded = false;
        let tempTitle = title || url || i18n.t('tab.untitled');
        if ((!title || title === i18n.t('tab.untitled') || title === 'New Tab' || title === '') && url && url.startsWith('http')) {
            try {
                tempTitle = new URL(url).hostname;
            }
            catch (e) { log.debug('tabs', 'afterIdx', e); }
        }
        tab.lazyTitle = tempTitle;
        // Session restore is the only caller that leaves a tab lazy (every other
        // one loads eagerly), and it rebuilds tabs without the tile bindings that
        // died with the last window — so this is where an Essential's tab finds
        // its tile again instead of the tile opening a second copy of it.
        if (!eager)
            this._scheduleEssentialRebind();
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
            container: container,
            containerColor: container ? containers.colorFor(container) : null,
            containerMeta: container ? containers.meta(container) : null,
            workspace: workspace,
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
        // view-source: of a web page loads the same way (Ctrl+U, "View page source").
        if (eager && /^(view-source:)?https?:/i.test(url || '')) {
            tab.lazyLoaded = true;
            tab.mutedUntilShown = true;
            tab.bgHoldMedia = true; // hold background autoplay until first viewed
            try {
                tab.webContents.audioMuted = true;
            }
            catch (e) { log.debug('tabs', 'afterIdx', e); }
            try {
                tab.webContents.loadURL(url);
            }
            catch (e) { log.debug('tabs', 'afterIdx', e); }
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
                return i18n.t('tab.untitled');
            }
            if (urlType === 'history') {
                return 'History';
            }
            if (urlType === 'settings') {
                return 'Settings';
            }
            if (fallbackTitle)
                return fallbackTitle;
            const t = tab && tab.webContents ? tab.webContents.getTitle() : '';
            return t || i18n.t('tab.untitled');
        }
        catch {
            return i18n.t('tab.untitled');
        }
    }
    updateWindowTitle(index, explicitTitle) {
        try {
            const title = explicitTitle || this.computeDisplayTitleFor(index);
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                this.mainWindow.setTitle(title);
            }
        }
        catch (e) { log.debug('tabs', 'updateWindowTitle', e); }
    }
    setWindowManager(windowManager) {
        this.windowManager = windowManager;
    }
    getWindowData() {
        if (!this.windowManager)
            return null;
        return this.windowManager.getWindowByWebContents(this.mainWindow.webContents);
    }
    raiseFloatingViews() {
        const wd = this.getWindowData();
        if (!wd?.window?.contentView)
            return;
        // The overlay set lives in ONE place (features/overlay-registry.js), so
        // this list and getWindowByWebContents can never disagree about what an
        // overlay is (CLAUDE.md invariant 4).
        for (const view of overlayViewsOf(wd)) {
            try {
                wd.window.contentView.removeChildView(view);
                wd.window.contentView.addChildView(view);
            }
            catch (e) { log.debug('tabs', 'raiseFloatingViews', e); }
        }
    }
    setShortcuts(shortcuts) {
        this.shortcuts = shortcuts;
    }
    createTab(insertAfterIndex = null, shouldActivate = true, isPrivate = false, containerId = null) {
        const tabIndex = this.nextTabIndex;
        this.nextTabIndex++;
        const makePrivate = isPrivate || this.isPrivateWindow;
        // A container = a persistent isolated cookie jar (features/containers.js).
        // Private tabs are already isolated (in-memory), so container only applies
        // to normal tabs. Two tabs in different containers can hold independent
        // logins to the same site without one clobbering the other.
        const container = (!makePrivate && containerId != null) ? String(containerId) : null;
        const webPrefs = {
            autoplayPolicy: 'user-gesture-required',
            preload: path.join(__dirname, '../preload/preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            scrollBounce: true, // see createTab()
        };
        if (makePrivate) {
            webPrefs.session = this._getPrivateSession();
            webPrefs.v8CacheOptions = 'none';
        }
        else if (container) {
            webPrefs.session = containers.get(container);
        }
        else if (this.profileId !== '1') {
            webPrefs.session = profiles.sessionFor(this.profileId);
        }
        const tab = new WebContentsView({ webPreferences: webPrefs });
        try { tab.setBorderRadius(Tabs.PAGE_RADIUS); } catch (e) { log.debug('tabs', 'container', e); }
        if (makePrivate) {
            tab.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
            tab.privateSession = webPrefs.session; // wiped when the tab closes
        }
        this.mainWindow.contentView.addChildView(tab);
        this._loadBlank(tab);
        this.raiseFloatingViews();
        UserAgent.setupTab(tab);
        this._applyTabBackground(tab, 'newtab');
        // Registered against the host for this tab's own session, so lazy tabs in
        // any space get extensions too. Private tabs stay out.
        if (!makePrivate)
            extensions.addTab(tab.webContents, this.mainWindow);
        tab.webContents.on("context-menu", async (_event, params) => {
            let menuParams = params;
            if (params?.linkURL) {
                try {
                    await tab.webContents.executeJavaScript('try { const s = window.getSelection && window.getSelection(); if (s) s.removeAllRanges(); } catch {}', true);
                }
                catch (e) { log.debug('tabs', 'container', e); }
                menuParams = { ...params, selectionText: '' };
            }
            const contextMenuInstance = new contextMenu(tab, menuParams, this);
            const template = contextMenuInstance.getTemplate();
            /* The app's own menu, not the OS's — a right-click on a page should
               look like a right-click anywhere else in this browser. Falls back
               to native if the overlay cannot be shown, so a menu is never
               simply missing. */
            const bounds = this.getTabBounds();
            if (overlayMenu.popup(this.getWindowData(), template,
                bounds.x + (params.x || 0), bounds.y + (params.y || 0)))
                return;
            const menu = Menu.buildFromTemplate(template);
            menu.popup({ window: this.mainWindow });
        });
        const bounds = this.getTabBounds();
        tab.setBounds(bounds);
        tab.setVisible(false);
        this.tabMap.set(tabIndex, tab);
        this.tabUrls.set(tabIndex, 'newtab');
        this.tabLastActive.set(tabIndex, Date.now());
        if (makePrivate) {
            this.privateTabs.add(tabIndex);
        }
        tab.isPrivate = makePrivate;
        tab.containerId = container;
        if (container)
            this.tabContainers.set(tabIndex, container);
        this.tabProfiles.set(tabIndex, this.profileId);
        // insertAfterIndex: existing tab index to insert after, -1 for the
        // front of the order (cross-window drop before the first tab), else end.
        const afterPos = (insertAfterIndex !== null && insertAfterIndex !== undefined && insertAfterIndex !== -1)
            ? this.tabOrder.indexOf(insertAfterIndex)
            : -1;
        if (insertAfterIndex === -1) {
            this.tabOrder.unshift(tabIndex);
        }
        else if (afterPos !== -1) {
            this.tabOrder.splice(afterPos + 1, 0, tabIndex);
        }
        else {
            this.tabOrder.push(tabIndex);
        }
        const previousActiveTabIndex = this.activeTabIndex;
        if (shouldActivate) {
            this.activeTabIndex = tabIndex;
            // createTab pre-sets activeTabIndex before showTab runs, so showTab
            // can't derive which tab we came from — carry it across explicitly
            // (used by the mini player's "walked away from a playing tab" hook).
            this._pendingPrevActive = previousActiveTabIndex;
        }
        this.navigationHistory.initializeTab(tabIndex, 'newtab');
        this.setupTabListeners(tabIndex, tab);
        this.mainWindow.webContents.send('tab-created', {
            index: tabIndex,
            title: i18n.t('tab.untitled'),
            totalTabs: this.tabMap.size,
            afterIndex: insertAfterIndex === -1 ? -1 : (afterPos !== -1 ? insertAfterIndex : null),
            active: shouldActivate,
            private: makePrivate,
            container: container,
            containerColor: container ? containers.colorFor(container) : null,
            containerMeta: container ? containers.meta(container) : null,
            workspace: this.profileId,
            // An Essential's view is represented by its tile, never by a strip
            // row — say so at creation so the row is never drawn visible.
            essential: !!this._creatingEssential,
        });
        if (shouldActivate) {
            this.showTab(tabIndex);
        }
        else {
            const activeTab = this.tabMap.get(previousActiveTabIndex);
            if (activeTab) {
                activeTab.setVisible(true);
            }
            // Opened in the background (e.g. a link/video opened in a new tab):
            // keep it muted and HOLD any media until the user actually views it,
            // so it can't autoplay in the background. Both flags clear on first
            // showTab. (media-started-playing pauses held media.)
            tab.mutedUntilShown = true;
            tab.bgHoldMedia = true;
            try { tab.webContents.audioMuted = true; } catch (e) { log.debug('tabs', 'focusOmnibox', e); }
        }
        this.saveStateDebounced();
        this.sendTabUpdate(tabIndex, tab, '', i18n.t('tab.untitled'));
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
        return tabIndex;
    }
    // Open (url) in a BRAND-NEW isolated instance — a fresh persistent isolated
    // session auto-named from the site. Two of these to the same site hold fully
    // independent logins, so switching tabs never carries one session over to the
    // other. This is the primary "open an isolated instance" action.
    openIsolatedInstance(url, insertAfterIndex = null) {
        const c = containers.createForUrl(url, this.profileId);
        return this.openInContainer(url, c.id, insertAfterIndex);
    }
    // Open (url) in an EXISTING instance (reuse its session — stay signed in).
    openInContainer(url, containerId, insertAfterIndex = null) {
        const idx = this.createTab(insertAfterIndex, true, false, containerId);
        if (url)
            this.loadUrl(idx, url);
        return idx;
    }
    // ── Autonomous isolation routing ──────────────────────────────────────────
    // Decide how a user-opened url should be sessioned. Never re-routes something
    // already in an instance (stickiness) or a private tab; only http(s) sites.
    //   → { mode: 'default' | 'keep' | 'isolate' | 'ask' }
    // Auto-isolation was removed with the profile concept: which cookie jar a
    // tab uses is decided by its Space's Profile now, not by per-site rules.
    resolveIsolation() {
        return { mode: 'default' };
    }
    _routeTypedToInstance(index, url) {
        const inst = containers.instanceForHost(url, this.profileId);
        const orderPos = this.tabOrder.indexOf(index);
        const insertAfter = orderPos > 0 ? this.tabOrder[orderPos - 1] : -1;
        const newIdx = this.openInContainer(url, inst.id, insertAfter);
        this.removeTab(index);
        return newIdx;
    }
    // User-initiated open (typed URL / bookmark / history). Routes flagged sites
    // into their isolated tenant instance (prompting the first time), else loads
    // normally in place. THE entry point ipc/tabs.js 'loadUrl' calls.
    async openUrlUserInitiated(index, url) {
        const r = this.resolveIsolation(index, url, this.tabContainers.get(index) || null);
        if (r.mode === 'isolate')
            return this._routeTypedToInstance(index, url);
        if (r.mode === 'ask') {
            const decision = await this._promptIsolate(this.tabMap.get(index)?.webContents, url);
            if (decision === 'isolate')
                return this._routeTypedToInstance(index, url);
        }
        this.loadUrl(index, url);
    }
    // A tab's instance is fixed at creation and never changes (its isolated
    // session is chosen then) — there is deliberately no "move tab to instance".
    // To use a different instance you open a NEW tab in it (openInContainer).
    //
    // Duplicate a tab into a NEW tab in the SAME container (or default) session.
    duplicateTab(index) {
        if (!this.tabMap.has(index))
            return null;
        const url = this.tabUrls.get(index);
        const httpUrl = (typeof url === 'string' && /^https?:/i.test(url)) ? url : null;
        const orderPos = this.tabOrder.indexOf(index);
        const insertAfter = orderPos !== -1 ? index : null;
        const id = this.tabContainers.get(index) || null;
        const idx = this.createTab(insertAfter, true, this.privateTabs.has(index), id);
        if (httpUrl)
            this.loadUrl(idx, httpUrl);
        return idx;
    }
    // A captive portal was detected → open its sign-in page in a new tab on the
    // DEFAULT session so the network's auth cookie applies to normal browsing.
    openCaptivePortalSignIn(url) {
        try {
            if (!this.mainWindow || this.mainWindow.isDestroyed())
                return;
            const idx = this.createTab(this.activeTabIndex, true, false);
            this.loadUrl(idx, url || 'http://neverssl.com/');
            /* Say WHY a tab just appeared. Deliberately carries no id, so it is
               not remembered — the next network is a different question, and a
               "never tell me about captive portals again" would be a bad thing
               to be able to answer by accident. */
            try {
                this.mainWindow.webContents.send('notice', {
                    text: i18n.t('notice.captivePortal'),
                });
            }
            catch (e) { log.debug('tabs', 'openCaptivePortalSignIn', e); }
        }
        catch (e) { log.debug('tabs', 'openCaptivePortalSignIn', e); }
    }
    // Open an internal page (settings/history/bookmarks) via the northstar://
    // scheme. Internal pages can't just navigate an existing tab because
    // Settings needs its own privileged preload, chosen at tab creation.
    //
    // replaceActive is for ONE caller: a northstar:// url typed into the
    // omnibox, which is a navigation of the current tab and must behave like
    // one. Opening these from the menu, the keyboard or another page always
    // adds a tab — they are destinations. It used to also replace whenever the
    // active tab's url token was 'newtab', which createTab() stores for any
    // tab opened without a url, so a fresh tab was silently consumed.
    openInternalPage(type, section = null, replaceActive = false) {
        const page = INTERNAL_PAGES[type];
        if (!page)
            return null;
        // The new-tab page is a NORMAL tab showing a page, not a page tab: it is
        // what you browse FROM, so the view must be on the right session —
        // private window, this space's profile session — and registered with
        // extensions. createTabWithPage builds on the default session, so a site
        // typed on the NTP of a private window loaded outside the private session.
        if (type === 'home') {
            if (replaceActive && this.tabMap.has(this.activeTabIndex)) {
                this.navigationHistory.addEntry(this.activeTabIndex, 'home');
                this._loadNewTabPage(this.activeTabIndex);
                return this.activeTabIndex;
            }
            return this.openNewTabPage();
        }
        const activeIdx = this.activeTabIndex;
        const canReplace = replaceActive && this.tabMap.has(activeIdx);
        const newIdx = this.createTabWithPage(page.file, type, page.title, {
            section,
            insertAfter: canReplace ? activeIdx : null,
        });
        if (canReplace && newIdx !== activeIdx)
            this.removeTab(activeIdx);
        return newIdx;
    }
    createTabWithPage(pagePath, pageType, pageTitle, opts = {}) {
        const section = opts.section || null;
        const tabIndex = this.nextTabIndex;
        this.nextTabIndex++;
        const tab = new WebContentsView({
            webPreferences: {
                autoplayPolicy: 'user-gesture-required',
                preload: preloadForPage(pageType),
                contextIsolation: true,
                nodeIntegration: false
            }
        });
        try { tab.setBorderRadius(Tabs.PAGE_RADIUS); } catch (e) { log.debug('tabs', 'createTabWithPage', e); }
        this.mainWindow.contentView.addChildView(tab);
        tab.webContents.loadFile(resolveAppFile(pagePath), section ? { hash: section } : undefined);
        this.raiseFloatingViews();
        UserAgent.setupTab(tab);
        this._applyTabBackground(tab, pageType);
        /* Internal pages are NOT registered with the extension system. They are
           chrome, served from file://, where content scripts cannot run — so an
           extension that messages every tab it knows about (1Password does, on
           a timer) got "Could not establish connection. Receiving end does not
           exist." for each one, forever. Settings is also simply none of an
           extension's business. */
        const bounds = this.getTabBounds();
        tab.setBounds(bounds);
        tab.lazyTitle = pageTitle || pageType;
        const token = section ? `${pageType}/${section}` : pageType;
        this.tabMap.set(tabIndex, tab);
        this.tabUrls.set(tabIndex, token);
        // The space it was opened in. Unset, tabsInWorkspace read it as space 1,
        // so a Settings/History tab opened in another space showed up in space 1.
        this.tabProfiles.set(tabIndex, this.profileId);
        // Position: after a given tab (for in-place replacement of the new-tab
        // page), otherwise append.
        const afterPos = (opts.insertAfter != null) ? this.tabOrder.indexOf(opts.insertAfter) : -1;
        if (afterPos !== -1)
            this.tabOrder.splice(afterPos + 1, 0, tabIndex);
        else
            this.tabOrder.push(tabIndex);
        this.activeTabIndex = tabIndex;
        this.navigationHistory.initializeTab(tabIndex, token);
        this.setupTabListeners(tabIndex, tab);
        this.mainWindow.webContents.send('tab-created', {
            index: tabIndex,
            title: pageTitle || pageType,
            totalTabs: this.tabMap.size,
            afterIndex: afterPos !== -1 ? opts.insertAfter : null,
            workspace: this.profileId,
        });
        this.sendTabUpdate(tabIndex, tab, token, pageTitle);
        this.showTab(tabIndex);
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
        return tabIndex;
    }
    // With macOS vibrancy the window is transparent, so a tab that doesn't fully
    // paint would bleed the frosted material through. Internal pages (new tab,
    // settings, history, bookmarks) opt INTO that frost with a transparent view;
    // web content gets an opaque white backing (matching Chrome) so nothing bleeds.
    /**
     * Load "no page" into a tab.
     *
     * A blank tab is about:blank (the 'newtab' token). New tabs the user asks
     * for open the new-tab page instead (openNewTabPage); this is for tabs that
     * are about to be given a url. The view is transparent
     * (_applyTabBackground), so about:blank shows the chrome's own page card.
     */
    // Essentials — the tile grid at the top of the sidebar. An Essential IS a
    // tab, and the whole binding lives in features/tabs/essentials.js (mixed
    // into this prototype at the bottom of the file).
    _loadBlank(tab) {
        try { tab.webContents.loadURL('about:blank'); }
        catch (e) { log.debug('tabs', '_loadBlank', e); }
    }
    /** A new active tab showing the new-tab page — private when asked (or in a
     *  private window), so a new private tab has a field to type into rather
     *  than an empty page. */
    openNewTabPage(isPrivate = false, mode = null) {
        const idx = this.createTab(null, true, !!isPrivate);
        this.navigationHistory.initializeTab(idx, 'home'); // Back returns here
        this._loadNewTabPage(idx, mode);
        return idx;
    }
    /** Tab search (Ctrl+Shift+A): the new-tab page in its #tabs mode, which
     *  lists this space's open tabs. It is a throwaway — picking a tab or
     *  pressing Esc closes it (finishTabSearch), it never lands in "reopen
     *  closed tab", and Esc returns you to the tab you came from. */
    openTabSearch() {
        const from = this.activeTabIndex;
        // Already searching? Don't stack a second one.
        if (this.tabSearchFrom?.has(from))
            return from;
        const idx = this.openNewTabPage(false, 'tabs');
        if (!this.tabSearchFrom)
            this.tabSearchFrom = new Map();
        this.tabSearchFrom.set(idx, from);
        return idx;
    }
    /** End a tab search from its page: switch to `target` (or back to where the
     *  search was opened from when null) and close the search tab. */
    finishTabSearch(searchIdx, target = null) {
        if (!this.tabSearchFrom?.has(searchIdx))
            return false;
        const from = this.tabSearchFrom.get(searchIdx);
        const dest = (target != null && this.tabMap.has(target)) ? target : from;
        this.removeTabWithTargetFocus(searchIdx, this.tabMap.has(dest) ? dest : null);
        if (this.tabMap.has(dest) && this.activeTabIndex !== dest)
            this.showTab(dest);
        return true;
    }
    /** Show the new-tab page in an existing tab, in place. It runs on the
     *  general preload (its bridges are gated to file://), so any tab can load
     *  it. The hash carries its flags: `private` (show no history) and `tabs`
     *  (tab-search mode, see openTabSearch). */
    _loadNewTabPage(index, mode = null) {
        const tab = this.tabMap.get(index);
        if (!tab)
            return;
        const priv = this.privateTabs.has(index) || this.isPrivateWindow;
        const hash = [priv ? 'private' : '', mode === 'tabs' ? 'tabs' : ''].filter(Boolean).join(',');
        try {
            tab.setNavigatingProgrammatically?.(true);
            tab.webContents.loadFile(resolveAppFile(INTERNAL_PAGES.home.file), hash ? { hash } : undefined);
        }
        catch (e) { log.warn('tabs', '_loadNewTabPage', e); }
        this.tabUrls.set(index, 'home');
        this.sendTabUpdate(index, tab, 'home', INTERNAL_PAGES.home.title);
    }
    _applyTabBackground(tab, urlOrType) {
        const t = urlOrType || '';
        const internal = t === 'newtab' || t === 'settings' || t === 'history' || t === 'bookmarks' ||
            (typeof t === 'string' && /\/(Settings|History|Bookmarks)\//.test(t));
        try {
            /* A web page's view paints this before the site paints anything, so
               it is what you see for the length of a navigation. Hardcoded white
               meant a white flash on every load of every dark theme — the single
               most visible thing the browser did. It is the theme's page colour
               now, which is also what the card around it is. */
            tab.setBackgroundColor(internal ? '#00000000' : this._pageColor());
        }
        catch (e) { log.debug('tabs', '_applyTabBackground', e); }
    }

    /** The current theme's page colour, resolved for THIS window's space. */
    _pageColor() {
        try {
            const themeRuntime = require('./theme-runtime');
            const themes = require('./themes');
            return themes.pageColorOf(themeRuntime.themeFor(this.mainWindow.webContents));
        }
        catch (e) {
            log.debug('tabs', '_pageColor', e);
            return '#121213';
        }
    }

    /** Re-tint every open page view — called when the theme changes. */
    repaintTabBackgrounds() {
        const color = this._pageColor();
        for (const [idx, tab] of this.tabMap) {
            const url = this.tabUrls.get(idx) || '';
            const internal = url === 'newtab' || /^(settings|history|bookmarks)(\/|$)/.test(url);
            try { tab.setBackgroundColor(internal ? '#00000000' : color); }
            catch (e) { log.debug('tabs', 'repaintTabBackgrounds', e); }
        }
    }

    _colorSchemeMode() {
        try {
            const themeRuntime = require('./theme-runtime');
            const themes = require('./themes');
            return themes.modeOf(themeRuntime.themeFor(this.mainWindow.webContents)) === 'light' ? 'light' : 'dark';
        }
        catch (e) { log.debug('tabs', '_colorSchemeMode', e); return 'dark'; }
    }

    _emulateColorScheme(tab, mode) {
        const wc = tab && tab.webContents;
        if (!wc || wc.isDestroyed())
            return;
        try {
            if (!wc.debugger.isAttached())
                wc.debugger.attach('1.3');
        }
        catch (e) { log.debug('tabs', 'colour scheme attach', e); return; }
        wc.debugger.sendCommand('Emulation.setEmulatedMedia', {
            features: [{ name: 'prefers-color-scheme', value: mode }],
        }).catch((e) => log.debug('tabs', 'colour scheme send', e));
    }

    // did-navigate: the page has (re)rendered under the current mode.
    _markColorSchemeRendered(tab) {
        const mode = this._colorSchemeMode();
        if (tab) tab._renderedMode = mode;
        this._emulateColorScheme(tab, mode);
    }

    // Theme changed: emulate on every tab (CSS-based dark mode restyles live from
    // this), and reload the ACTIVE tab if its page rendered under the other mode
    // and won't restyle on its own — JS-driven sites like YouTube/Google read the
    // scheme once at load, which is why they needed a manual refresh.
    applyColorSchemeAll() {
        const mode = this._colorSchemeMode();
        for (const [idx, tab] of this.tabMap) {
            this._emulateColorScheme(tab, mode);
            if (idx !== this.activeTabIndex)
                continue;
            const wc = tab.webContents;
            const url = (wc && !wc.isDestroyed() && wc.getURL()) || '';
            if (/^https?:/i.test(url) && tab._renderedMode !== undefined && tab._renderedMode !== mode) {
                tab._renderedMode = mode;   // set first so did-navigate doesn't re-trigger
                try { wc.reload(); }
                catch (e) { log.debug('tabs', 'colour scheme reload', e); }
            }
        }
    }
    // Shell margin around the floating page card (matches the shell padding in
    // Browser/styles.css). The page floats in a rounded card on a tinted shell
    // instead of filling the window edge-to-edge.
    static SHELL_PAD = 8;
    static PAGE_RADIUS = 8;
    // Width of the left tab sidebar (tabBarSide: 'side').
    static SIDEBAR_W = 256;
    static SIDEBAR_MAX = 460; // resize clamp (min 180)
    // Shell inset above the tab strip (matches body padding-top in
    // Browser/styles.css) so the space above the tabs matches the space below.
    static SHELL_TOP = 6;
    // Chrome geometry. These MUST match the --bar-h / --tabstrip-h / --card-radius
    // tokens in renderer/styles/themes.css: the page view is positioned
    // underneath the chrome from here, and there is no build step sharing values
    // between the two, so changing one side alone silently misaligns the page.
    // Split-view geometry lives in features/tabs/split.js with its methods.
    static MAX_RESTORED_HISTORY = 25; // back/forward entries kept per tab in the session file
    // Glance geometry lives in features/tabs/glance.js with its methods.
    static UTILITY_BAR_H = 40;
    static TAB_BAR_H = 44;
    // The page card is inset from the shell by SHELL_PAD on every side — top
    // included. (Browser/styles.css mirrors this with margin on #content-area;
    // an unmatched gap here showed as a sliver of chrome above the page.)

    // 0 while a video (or the OS) is truly fullscreen — the page must be
    // edge-to-edge and square there; otherwise the rounded floating card.
    _pageRadius() {
        const fs = this.isHtmlFullScreen || (this.mainWindow && this.mainWindow.isSimpleFullScreen && this.mainWindow.isSimpleFullScreen());
        // Top strip: the page is flush with the window under the toolbar band,
        // square like any top-tabs browser (Browser/styles.css mirrors this on
        // #content-area). Only the sidebar layout keeps the rounded card.
        const top = (this.persistence?.get('tabBarSide') ?? 'side') === 'top';
        return (fs || top) ? 0 : Tabs.PAGE_RADIUS;
    }

    // The rendered sidebar width for THIS window, using the renderer's own
    // window-relative clamp so the page view lines up with it exactly. Reads the
    // persisted raw width each time so it re-expands/contracts as the window grows
    // or shrinks (the limits scale with the window).
    _computeSidebarWidth() {
        const raw = Math.round(Number(this.persistence?.get('sidebarWidth')) || Tabs.SIDEBAR_W);
        let winW = 0;
        try { winW = this.mainWindow.getContentBounds().width; }
        catch (e) { log.debug('tabs', '_computeSidebarWidth', e); }
        return clampSidebarWidth(raw, winW);
    }

    getTabBounds() {
        const contentBounds = this.mainWindow.getContentBounds();
        if (this.mainWindow && (this.isHtmlFullScreen || this.mainWindow.isSimpleFullScreen())) {
            return { x: 0, y: 0, width: contentBounds.width, height: contentBounds.height };
        }
        const pad = Tabs.SHELL_PAD;
        // An open extension side panel reserves a column on the right, so the
        // page card shrinks rather than being covered (matching Chrome).
        const rightInset = this.sidePanelWidth || 0;
        // Sidebar mode: tabs live in a left column, so the page starts after it
        // and only the utility bar (+ optional bookmark bar) sits above.
        if ((this.persistence?.get('tabBarSide') ?? 'side') !== 'top') {
            const yOffset = Tabs.UTILITY_BAR_H + Tabs.SHELL_PAD + Tabs.SHELL_TOP + (this.bookmarkBarHeight || 0);
            // Compact mode: the sidebar is hidden, so the page spans full width.
            const leftInset = this.sidebarCompact ? pad : this.sidebarWidth;
            let width = contentBounds.width - leftInset - pad - rightInset;
            let height = contentBounds.height - yOffset - pad;
            if (width < 0)
                width = 0;
            if (height < 0)
                height = 0;
            return { x: leftInset, y: yOffset, width: Math.floor(width), height: Math.floor(height) };
        }
        // Top strip: shell top inset (body padding-top) + tab strip + toolbar
        // band + optional bookmark bar, then the page FLUSH to the window's
        // left, right and bottom edges — no card inset, as in any top-tabs
        // browser. Browser/styles.css mirrors this (html[data-tabbar="top"]
        // #content-area { margin: 0 }).
        const yOffset = Tabs.TAB_BAR_H + Tabs.UTILITY_BAR_H
            + Tabs.SHELL_TOP + (this.bookmarkBarHeight || 0);
        let width = contentBounds.width - rightInset;
        let height = contentBounds.height - yOffset;
        if (width < 0)
            width = 0;
        if (height < 0)
            height = 0;
        return { x: 0, y: yOffset, width: Math.floor(width), height: Math.floor(height) };
    }
    isYouTubeUrl(url) {
        try {
            const host = new URL(url).hostname || '';
            return host.includes('youtube.com') || host === 'youtu.be';
        }
        catch {
            return false;
        }
    }
    applyYouTubeSpaceFix(tab, url) {
        if (!tab || !tab.webContents || tab.webContents.isDestroyed())
            return;
        const currentUrl = url || (tab.webContents.getURL ? tab.webContents.getURL() : '');
        if (!this.isYouTubeUrl(currentUrl))
            return;
        try {
            tab.webContents.executeJavaScript(YOUTUBE_SPACE_FIX_JS, true);
        }
        catch (e) { log.debug('tabs', 'applyYouTubeSpaceFix', e); }
    }
    applyYouTubeExitFullscreen(tab) {
        if (!tab || !tab.webContents || tab.webContents.isDestroyed())
            return;
        const currentUrl = tab.webContents.getURL ? tab.webContents.getURL() : '';
        if (!this.isYouTubeUrl(currentUrl))
            return;
        try {
            tab.webContents.executeJavaScript('window.__inkYouTubeExitFullscreen && window.__inkYouTubeExitFullscreen();', true);
        }
        catch (e) { log.debug('tabs', 'applyYouTubeExitFullscreen', e); }
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
        }
        catch (e) { log.debug('tabs', 'sendMediaIndicators', e); }
    }
    sendTabUpdate(tabIndex, tab, url, title, favicon) {
        let displayUrl = url;
        // A user-set label wins over whatever the page reports, and keeps winning
        // as the page navigates — until it is reset.
        const custom = this.tabLabels?.get(tabIndex);
        let displayTitle = custom || title || this.computeDisplayTitleFor(tabIndex) || "New Tab";
        // Internal pages: settings/bookmarks/history (and settings/<section>) keep
        // their token so the omnibox can show it as a northstar:// url; the new-tab
        // page and any bare file:// url show a blank address bar.
        const base = (typeof url === 'string' ? url.split('/')[0] : '');
        const isInternalToken = ['settings', 'bookmarks', 'history'].includes(base);
        const isBlankInternal = url === 'newtab' || (url && url.startsWith('file://') && !isInternalToken);
        if (isBlankInternal) {
            displayUrl = '';
            if (url && url.includes('/Settings/index.html'))
                displayTitle = 'Settings';
            else if (url && url.includes('/Bookmarks/index.html'))
                displayTitle = 'Bookmarks';
            else if (url && url.includes('/History/index.html'))
                displayTitle = 'History';
            else
                displayTitle = i18n.t('tab.untitled');
        }
        else if (isInternalToken) {
            displayUrl = url; // 'settings' / 'settings/appearance' / 'history' / 'bookmarks'
            if (base === 'settings')
                displayTitle = 'Settings';
            else if (base === 'bookmarks')
                displayTitle = 'Bookmarks';
            else if (base === 'history')
                displayTitle = 'History';
        }
        // Provide a default favicon instantly for http/https URLs to prevent empty gaps
        let resolvedFavicon = favicon;
        if (this.privateTabs.has(tabIndex)) {
            // The chrome renderer loads favicons through the DEFAULT session, so
            // fetching one for a private tab would leak the hostname outside the
            // private session.
            resolvedFavicon = null;
        }
        else if (!resolvedFavicon && url && url.startsWith('http')) {
            // Prefer the icon we already REMEMBERED for this host from an earlier
            // visit — otherwise a plain sendTabUpdate (a did-navigate, a title
            // change, a same-tab sub-navigation that fires no page-favicon-updated)
            // fell back to <origin>/favicon.ico, which 404s on the many sites that
            // declare their icon at another path, and the tab "lost" its favicon.
            // Falls back to /favicon.ico only when nothing is cached; the real
            // declared icon still arrives via page-favicon-updated and replaces it.
            try {
                const origin = new URL(url).origin;
                resolvedFavicon = faviconStore.getForHost(new URL(url).hostname) || `${origin}/favicon.ico`;
            }
            catch (e) { log.debug('tabs', 'base', e); }
        }
        const ctrId = this.tabContainers.get(tabIndex) || null;
        this.mainWindow.webContents.send('url-updated', {
            index: tabIndex,
            url: displayUrl,
            title: displayTitle,
            favicon: resolvedFavicon,
            private: this.privateTabs.has(tabIndex),
            container: ctrId,
            containerMeta: ctrId ? containers.meta(ctrId) : null,
            // So the tab menu can offer "Reset label" only when there is a
            // user label to reset, rather than as an always-present no-op.
            hasCustomLabel: !!this.tabLabels?.get(tabIndex),
        });
        // Keep the window title in sync with the active tab
        if (tabIndex === this.activeTabIndex) {
            this.updateWindowTitle(tabIndex, displayTitle);
        }
    }
    // ── Tab sleeping ──────────────────────────────────────────────────────────
    // Free the renderer process of long-inactive background tabs (a
    // memory saver). The WebContentsView and its navigation history survive;
    // showTab()/loadUrl() transparently revive the tab with a reload. Never
    // sleeps: the active tab, pinned tabs, tabs playing audio/media, internal
    // pages, unloaded lazy tabs, or tabs with DevTools open.
    // Tell the chrome a tab started/stopped loading so it can show a tab
    // spinner and flip the reload button to a stop button (and back).
    // phase (P1-1): 'waiting' between did-start-loading and the response
    // committing (grey ring, no favicon), then 'loading' once content arrives
    // (accent ring, favicon inside). Ignored when loading is false.
    sendLoadingState(tabIndex, loading, phase = 'loading') {
        try {
            this.mainWindow.webContents.send('tab-loading', { index: tabIndex, loading: !!loading, phase });
        }
        catch (e) { log.debug('tabs', 'sendLoadingState', e); }
    }
    sendNavigationUpdate(tabIndex) {
        if (this.tabMap.has(tabIndex) && tabIndex === this.activeTabIndex) {
            try {
                this.mainWindow.webContents.send('navigation-updated', {
                    index: tabIndex,
                    canGoBack: this.canGoBack(tabIndex),
                    canGoForward: this.canGoForward(tabIndex)
                });
            }
            catch (error) { log.debug('tabs', 'sendNavigationUpdate', error); }
        }
    }
    updateHistoryTitle(url, title, profile = null) {
        if (!this.history || !url || url.startsWith('file://') || url === 'newtab')
            return;
        this.history.updateTitle(url, title, profile || null)
            .catch(error => log.debug('tabs', 'updateHistoryTitle', error));
    }
    addToHistory(url, title, profile = null) {
        if (this.history && url && !url.startsWith('file://')) {
            const profileName = profile ? (containers.meta(profile)?.name || null) : null;
            this.history.addToHistory(url, title || url, profile || null, profileName).catch(error => {
            });
            // chrome.history.onVisited fires for REAL browsing, not just for
            // visits an extension recorded through the API.
            try { require('./ext-events').historyVisited(url, title, this.profileId || '1'); }
            catch (e) { log.debug('tabs', 'addToHistory', e); }
        }
    }
    // Split view, glance and workspace/folder management live in
    // features/tabs/{split,glance,organize}.js and are mixed into this
    // prototype at the bottom of the file — this class was 3k lines and the
    // three of them are self-contained.
    /**
     * The last tab in the window just closed.
     *
     * In the TOP STRIP the window *is* the tab strip, so it goes with the last
     * tab — what most browsers do. In SIDEBAR mode the window is a
     * workspace that happens to hold tabs, so it stays: closing your last tab
     * should not throw away the window, its size, its space or its session.
     * It stays EMPTY — no blank tab, and no new-tab page until you ask for one.
     *
     * Deferred and re-checked on the next tick either way: rapid tab operations
     * (double-close races) pass through a transient empty state, and acting on
     * that closed the window spuriously.
     */
    _onEmptied() {
        setImmediate(() => {
            if (this.mainWindow.isDestroyed() || this.tabMap.size !== 0)
                return;
            if ((this.persistence?.get('tabBarSide') ?? 'side') === 'top') {
                this.allowClose = true;
                this.mainWindow.close();
                return;
            }
            this.activeTabIndex = -1;
            try { this.mainWindow.webContents.send('tab-switched', { index: -1 }); }
            catch (e) { log.debug('tabs', '_onEmptied', e); }
        });
    }
    showTab(index) {
        // A glance is transient — dismiss it on any tab switch.
        this.closeGlance();
        // The Essentials grid highlights whichever tile owns the tab you are on.
        setImmediate(() => this.sendEssentialTabs());
        // Switching to a tab outside the split pair dissolves the split.
        if (this.splitPair && !this.splitPair.includes(index))
            this._clearSplit();
        this.tabMap.forEach((tab, i) => {
            tab.setVisible(false);
        });
        if (this.tabMap.has(index)) {
            const tab = this.tabMap.get(index);
            // Background tabs skip live resizing (see resizeAllTabs) — catch up
            // on the current bounds before this one becomes visible.
            tab.setBounds(this.getTabBounds());
            try { tab.setBorderRadius(this._pageRadius()); } catch (e) { log.debug('tabs', 'showTab', e); }
            tab.setVisible(true);
            this._emulateColorScheme(tab, this._colorSchemeMode());
            // Sleep bookkeeping: the outgoing tab starts ageing now; the incoming
            // tab is fresh. Wake it if the sleep scan discarded its renderer.
            this.tabLastActive.set(this.activeTabIndex, Date.now());
            this.tabLastActive.set(index, Date.now());
            if (tab.slept)
                this.sleeper.wake(tab);
            // Eager background tabs load muted; restore sound on first view.
            if (tab.mutedUntilShown) {
                tab.mutedUntilShown = false;
                try {
                    tab.webContents.audioMuted = false;
                }
                catch (e) { log.debug('tabs', 'showTab', e); }
            }
            // Viewing the tab releases the background-media hold, so media may
            // play now that the user is actually looking at it.
            tab.bgHoldMedia = false;
            // Mini player: hide when arriving at the media tab; show when
            // walking away from a tab that is still playing. createTab pre-sets
            // activeTabIndex, so prefer the explicit previous index it stashes.
            const prevActiveIndex = (this._pendingPrevActive !== undefined)
                ? this._pendingPrevActive : this.activeTabIndex;
            this._pendingPrevActive = undefined;
            this.activeTabIndex = index;
            try {
                miniPlayer.onTabSwitch(this.getWindowData(), prevActiveIndex, index);
            }
            catch (e) { log.debug('tabs', 'prevActiveIndex', e); }
            // Picture the tab you just left, for its hover card (as Chromium
            // does on tab-backgrounded). It survives that tab going to sleep.
            if (prevActiveIndex !== index && prevActiveIndex != null) {
                try { require('./tab-hover-card').captureOnBackground(this.getWindowData(), prevActiveIndex); }
                catch (e) { log.debug('tabs', 'hover-card capture', e); }
            }
            if (tab.lazyLoaded === false) {
                tab.lazyLoaded = true;
                const lazyUrl = this.tabUrls.get(index);
                const internal = parseInternalToken(lazyUrl);
                if (internal) {
                    // Any internal page token — history, bookmarks, settings, or a
                    // settings section — loads its file:// page (never as a web URL,
                    // which 404s). Sections restore to their section via the hash.
                    const page = INTERNAL_PAGES[internal.type];
                    tab.webContents.loadFile(resolveAppFile(page.file), internal.section ? { hash: internal.section } : undefined);
                }
                else if (lazyUrl && lazyUrl !== 'newtab' && !lazyUrl.startsWith('file://')) {
                    tab.webContents.loadURL(lazyUrl);
                }
                else {
                    const isPrivTab = this.privateTabs.has(index);
                    this._loadBlank(tab);
                }
            }
            else if (tab.needsReloadForFocusMode) {
                tab.needsReloadForFocusMode = false;
                tab.needsReloadForShortform = false;
                tab.webContents.reload();
            }
            else if (tab.needsReloadForShortform) {
                tab.needsReloadForShortform = false;
                tab.webContents.reload();
            }
            const currentUrl = this.tabUrls.get(index) || '';
            this.mainWindow.webContents.send('tab-switched', {
                index: index,
                url: currentUrl === 'newtab' ? '' : currentUrl,
                totalTabs: this.tabMap.size
            });
            this.sendNavigationUpdate(index);
            // Reflect the newly active tab's loading state on the reload button.
            try {
                this.sendLoadingState(index, tab.webContents.isLoading());
            }
            catch (e) { log.debug('tabs', 'prevActiveIndex', e); }
            // Sync reader/PiP button visibility to the newly active tab.
            try {
                this.mainWindow.webContents.send('media-state', { index, playing: !!tab.hasPlayingMedia });
                if (this.readerMode.has(index)) {
                    this.mainWindow.webContents.send('reader-state', { index, active: true, available: true });
                }
                else {
                    this.detectReaderable(index, tab);
                }
            }
            catch (e) { log.debug('tabs', 'prevActiveIndex', e); }
            // Update window title to reflect the newly active tab
            this.updateWindowTitle(index);
            // Notify the extension system of the active tab (chrome.tabs + actions)
            if (!this.privateTabs.has(index))
                extensions.selectTab(tab.webContents); // resolves the session's host
            // Put the website back into focus so keyboard events register immediately
            tab.webContents.focus();
            this.raiseFloatingViews();
        }
        // Split view: after showing the active half full, lay both halves out.
        if (this.splitPair && this.splitPair.includes(index))
            this._layoutSplit();
    }
    loadUrl(index, url) {
        // northstar:// internal pages open in a NEW tab. They cannot navigate an
        // existing tab (Settings needs its own privileged preload, chosen at tab
        // creation), and replacing the active tab in place meant typing
        // northstar://settings destroyed the page you were reading. The one
        // exception is a blank tab, which has nothing to preserve and would
        // otherwise be left behind as an orphan.
        // northstar:// as typed, OR a bare stored token ('history', 'settings/…')
        // that a restore/reload can hand back — both must resolve to the internal
        // page, never be fetched as a web address (which 404s).
        const internal = parseNorthstarUrl(url) || parseInternalToken(url);
        // The new-tab page needs no special preload, so it loads IN this tab,
        // like any address (northstar://home typed, a restored 'home' token).
        if (internal?.type === 'home' && this.tabMap.has(index)) {
            this.navigationHistory.addEntry(index, 'home');
            this._loadNewTabPage(index);
            return;
        }
        if (internal) {
            this.activeTabIndex = index;
            const blank = this.tabUrls.get(index) === 'newtab';
            this.openInternalPage(internal.type, internal.section, blank);
            return;
        }
        if (this.tabMap.has(index)) {
            const tab = this.tabMap.get(index);
            tab.slept = false; // loading revives a slept (discarded) renderer
            // Leaving the new-tab page: fade it out NOW. Chromium keeps the old
            // document painted until the new one commits, and a static clock
            // sitting there for the whole network wait reads as "stuck".
            tab.webContents.loadURL(url);
            this.tabUrls.set(index, url);
            // Set a temporary title before the page actually loads
            let tempTitle = url;
            try {
                tempTitle = new URL(url).hostname;
            }
            catch (e) { log.debug('tabs', 'loadUrl', e); }
            tab.lazyTitle = tempTitle;
            this.sendTabUpdate(index, tab, url, tempTitle);
            this.navigationHistory.addEntry(index, url);
            this.saveStateDebounced();
            setTimeout(() => {
                this.sendNavigationUpdate(index);
            }, 200);
        }
    }
    destroyTab(tab) {
        try {
            tab.webContents.audioMuted = true;
        }
        catch (e) { log.debug('tabs', 'destroyTab', e); }
        try {
            this.mainWindow.contentView.removeChildView(tab);
        }
        catch (e) { log.debug('tabs', 'destroyTab', e); }
        try {
            tab.webContents.destroy();
        }
        catch (e) { log.debug('tabs', 'destroyTab', e); }
        // Private tab → its isolated session dies with it. Deferred one tick
        // so the webContents teardown settles before storage is cleared.
        if (tab.privateSession) {
            const sess = tab.privateSession;
            tab.privateSession = null;
            setImmediate(() => { try {
                privateSessions.destroyTabSession(sess);
            }
            catch (e) { log.debug('tabs', 'destroyTab', e); } });
        }
    }
    recordClosed(index) {
        // Private tabs must not be resurrectable via "reopen closed tab".
        if (this.privateTabs.has(index))
            return;
        // A tab-search page is a throwaway, not something you'd reopen. (Every
        // close passes through here, so this is also where its entry is dropped.)
        if (this.tabSearchFrom?.delete(index))
            return;
        const url = this.tabUrls.get(index);
        if (url && url !== 'newtab' && !url.startsWith('file://')) {
            const tab = this.tabMap.get(index);
            let title = url;
            try {
                title = tab?.webContents?.getTitle() || url;
            }
            catch (e) { log.debug('tabs', 'recordClosed', e); }
            this.closedTabHistory.push({ url, title, closedAt: Date.now() });
            if (this.closedTabHistory.length > 20)
                this.closedTabHistory.shift();
        }
    }
    // The tab to activate after `index` is closed: the visually-adjacent tab in
    // tab-bar order (right neighbour, else left). Call BEFORE removing `index`.
    // the common behaviour; keyed off tabOrder so it respects drag-reorder.
    _neighborInOrder(index) {
        const order = this.tabOrder;
        const pos = order.indexOf(index);
        if (pos === -1)
            return null;
        for (let i = pos + 1; i < order.length; i++)
            if (this.tabMap.has(order[i]))
                return order[i];
        for (let i = pos - 1; i >= 0; i--)
            if (this.tabMap.has(order[i]))
                return order[i];
        return null;
    }
    // Like _neighborInOrder but stays inside the closed tab's workspace, so
    // closing the last tab of a workspace never jumps to another workspace's tab.
    _neighborInWorkspace(index) {
        const ws = String(this.tabProfiles.get(index) || this.profileId || '1');
        const order = this.tabOrder;
        const pos = order.indexOf(index);
        if (pos === -1)
            return null;
        const ok = (i) => this.tabMap.has(i) && String(this.tabProfiles.get(i) || '1') === ws;
        for (let i = pos + 1; i < order.length; i++) if (ok(order[i])) return order[i];
        for (let i = pos - 1; i >= 0; i--) if (ok(order[i])) return order[i];
        return null;
    }
    removeTab(index) {
        if (this.tabMap.has(index)) {
            this._forgetEssentialTab(index);
            const wasActive = this.activeTabIndex === index;
            const nextActive = wasActive ? this._neighborInWorkspace(index) : null;
            const tab = this.tabMap.get(index);
            this.recordClosed(index);
            this.destroyTab(tab);
            this.tabMap.delete(index);
            this.tabUrls.delete(index);
            this.pinnedTabs.delete(index);
            this.privateTabs.delete(index); // session wipe happens in destroyTab()
            this.tabContainers.delete(index); // container SESSION persists (shared, reusable)
            this.tabProfiles.delete(index);
            if (this.tabFolders.delete(index)) this.broadcastFolders();
            if (this.splitPair && this.splitPair.includes(index))
                this._clearSplit();
            this.tabOrder = this.tabOrder.filter(i => i !== index);
            this.tabScroll.delete(index);
            this.tabLastActive.delete(index);
            try {
                miniPlayer.onTabClosed(this.getWindowData(), index);
            }
            catch (e) { log.debug('tabs', 'removeTab', e); }
            this.navigationHistory.removeTab(index);
            this.mainWindow.webContents.send('tab-removed', {
                index: index,
                totalTabs: this.tabMap.size
            });
            if (wasActive) {
                if (nextActive !== null && this.tabMap.has(nextActive)) {
                    this.showTab(nextActive);
                }
                else {
                    // Emptying a space KEEPS you in it — the page area just falls
                    // back to its empty state. Jumping to whichever other space
                    // happened to hold a tab moved you somewhere you did not ask
                    // to go.
                    this.activeTabIndex = -1;
                    try { this.mainWindow.webContents.send('tab-switched', { index: -1 }); }
                    catch (e) { log.debug('tabs', 'removeTab', e); }
                }
            }
            if (this.tabMap.size === 0)
                this._onEmptied();
            this.saveStateDebounced();
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
            this.recordClosed(index);
            this.destroyTab(tab);
            this.tabMap.delete(index);
            this.tabUrls.delete(index);
            this.pinnedTabs.delete(index);
            this.privateTabs.delete(index); // session wipe happens in destroyTab()
            this.tabContainers.delete(index); // container SESSION persists (shared, reusable)
            this.tabProfiles.delete(index);
            if (this.tabFolders.delete(index)) this.broadcastFolders();
            if (this.splitPair && this.splitPair.includes(index))
                this._clearSplit();
            this.tabOrder = this.tabOrder.filter(i => i !== index);
            this.tabScroll.delete(index);
            this.tabLastActive.delete(index);
            try {
                miniPlayer.onTabClosed(this.getWindowData(), index);
            }
            catch (e) { log.debug('tabs', 'nextActive', e); }
            this.navigationHistory.removeTab(index);
            this.mainWindow.webContents.send('tab-removed', {
                index: index,
                totalTabs: this.tabMap.size
            });
            if (this.tabMap.size === 0)
                this._onEmptied();
            else {
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
            this.saveStateDebounced();
        }
    }
    getTotalTabs() {
        return this.tabMap.size;
    }
    /**
     * Catch background tabs up on the current bounds once a resize has settled.
     *
     * resizeAllTabs() deliberately resizes only the visible tab, because moving
     * every background view on each resize tick makes dragging a window edge
     * crawl. The cost landed on tab SWITCHING instead: an incoming tab was laid
     * out at the old size, so it relayed out and repainted as it appeared —
     * which is the jank that makes switching feel unlike some browsers, where every
     * tab is already the right size.
     *
     * Doing it once, after the drag stops, gets both.
     */
    _scheduleBackgroundResize() {
        clearTimeout(this._bgResizeTimer);
        this._bgResizeTimer = setTimeout(() => {
            this._bgResizeTimer = null;
            if (!this.mainWindow || this.mainWindow.isDestroyed())
                return;
            const bounds = this.getTabBounds();
            const radius = this._pageRadius();
            this.tabMap.forEach((tab, index) => {
                if (index === this.activeTabIndex || tab.lazyLoaded === false || tab.slept)
                    return;
                try {
                    tab.setBounds(bounds);
                    tab.setBorderRadius(radius);
                }
                catch (e) { log.debug('tabs', '_scheduleBackgroundResize', e); }
            });
        }, 200);
    }

    resizeAllTabs() {
        // Re-clamp the side panel's reserved width BEFORE measuring the page,
        // or a resize lays the page out against the previous width.
        try {
            const wd0 = this.getWindowData();
            if (wd0?.sidePanelOpen)
                require('./side-panel').syncWidth(wd0);
        }
        catch (e) { log.debug('tabs', 'resizeAllTabs', e); }
        const bounds = this.getTabBounds();
        // Only the visible tab is resized immediately. Background views would
        // each relayout + repaint on every setBounds — with many tabs open
        // that turns window resizing into a jank festival. Hidden tabs get
        // their bounds applied in showTab() the moment they become visible.
        const radius = this._pageRadius();
        this.tabMap.forEach((tab, index) => {
            if (index === this.activeTabIndex) {
                tab.setBounds(bounds);
                try { tab.setBorderRadius(radius); } catch (e) { log.debug('tabs', 'resizeAllTabs', e); }
            }
        });
        if (this.splitPair)
            this._layoutSplit();
        if (this.splitDrop)
            try {
                if (this.splitDrop.getVisible())
                    this.splitDrop.setBounds(bounds);
            }
            catch (e) { log.debug('tabs', 'resizeAllTabs', e); }
        if (this.glanceView)
            this._layoutGlance();
        // Every bounds change funnels through here — window resize, sidebar
        // drag, side panel, fullscreen exit — so this is the one place that has
        // to schedule the settled catch-up for background tabs.
        this._scheduleBackgroundResize();
        // The extension side panel shares the page row, so it re-lays out here.
        try {
            const wd = this.getWindowData();
            if (wd?.sidePanelOpen)
                require('./side-panel').layout(wd);
        }
        catch (e) { log.debug('tabs', 'resizeAllTabs', e); }
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
        const isPinned = this.pinnedTabs.has(index);
        if (!isPinned) {
            const totalTabs = this.tabMap.size;
            const futurePinned = this.pinnedTabs.size + 1;
            const futureUnpinned = totalTabs - futurePinned;
            /* No auto-created tab. "Always keep one unpinned tab" is a
               top-tab-strip rule; this browser is allowed to have NO tabs at
               all (CLAUDE.md: a window opens with none, and closing the last
               leaves it that way), so pinning your only tab used to spawn a
               blank one out of nowhere. */
            void futureUnpinned;
            this.pinnedTabs.add(index);
            // Pinning captures where the tab "lives"; Reset returns here however
            // far the tab has since navigated.
            const here = this.tabUrls.get(index);
            if (here && here !== 'newtab' && !this.pinnedHome.has(index))
                this.pinnedHome.set(index, here);
        }
        else {
            this.pinnedTabs.delete(index);
            this.pinnedHome.delete(index);
        }
        this.mainWindow.webContents.send('pin-tab', { index });
        this.saveStateDebounced();
    }
    reorderTabs(newOrder) {
        if (!Array.isArray(newOrder))
            return;
        // The chrome sends the tabs it DRAWS — this space's, not the other
        // spaces' or the Essentials'. Demanding every tab here silently dropped
        // every drag once a second space existed; merge instead, so the drawn
        // tabs swap among their own slots and the rest keep theirs.
        const full = this.tabOrder.filter(i => this.tabMap.has(i));
        for (const i of this.tabMap.keys())
            if (!full.includes(i))
                full.push(i);
        this.tabOrder = mergeOrder(full, newOrder.map(Number));
        this.saveStateDebounced();
    }
    buildSerializableState() {
        const includeAll = !!(this.persistence && this.persistence.getPersistMode());
        const order = this.tabOrder.length ? this.tabOrder : Array.from(this.tabMap.keys());
        // A blank new-tab page (url token 'newtab', no navigation, not an
        // essential's saved home) carries nothing worth restoring — persisting it
        // just means an empty "New tab" reappears on the next launch. Never save one.
        const isBlankNewTab = (idx) =>
            !this._essentialHomeOfTab(idx) && (this.tabUrls.get(idx) || 'newtab') === 'newtab';
        const selected = (includeAll
            ? order.filter(idx => !this.privateTabs.has(idx))
            : order.filter(idx => this.pinnedTabs.has(idx) && !this.privateTabs.has(idx)))
            .filter(idx => !isBlankNewTab(idx));
        const keepHistory = this.persistence?.get('restoreTabHistory') !== false;
        const tabs = selected.map((idx) => {
            /* An Essential comes back at its OWN page, not three links deep
               into wherever it was left last night — a pin that reverts to the
               url it was pinned at is the behaviour of both browsers this
               follows (they reset their pins to the original link they were
               pinned at). Its
               back/forward tree and reading position go with it, since they
               describe a session that has ended. */
            const essentialHome = this._essentialHomeOfTab(idx);
            const url = essentialHome || this.tabUrls.get(idx) || 'newtab';
            let title = this.computeDisplayTitleFor(idx) || i18n.t('tab.untitled');
            // Back/forward and scroll position, so a restored tab is the tab you
            // left rather than a fresh load of the same address. Capped: a very
            // long history is not worth an unbounded state file.
            let history = null, historyIndex = 0;
            if (keepHistory && !essentialHome) {
                const h = this.navigationHistory.getHistory(idx);
                if (h && Array.isArray(h.entries) && h.entries.length > 1) {
                    const entries = h.entries
                        .slice()
                        .sort((a, b) => a.index - b.index)
                        .map(e => ({ url: e.data, title: e.title || null }));
                    const pos = h.entries.findIndex(e => e.index === h.currentIndex);
                    const start = Math.max(0, entries.length - Tabs.MAX_RESTORED_HISTORY);
                    history = entries.slice(start);
                    historyIndex = Math.max(0, (pos === -1 ? entries.length - 1 : pos) - start);
                }
            }
            return {
                url,
                title,
                pinned: this.pinnedTabs.has(idx),
                container: this.tabContainers.get(idx) || null,
                workspace: this.tabProfiles.get(idx) || '1',
                folder: this.tabFolders.get(idx) || null,
                label: this.tabLabels.get(idx) || null,
                icon: this.tabIcons.get(idx) || null,
                home: this.pinnedHome.get(idx) || null,
                scroll: essentialHome ? 0 : (this.tabScroll.get(idx) || 0),
                ...(history ? { history, historyIndex } : {}),
            };
        });
        // Map active to its ordinal within the SAVED list (selected), not the
        // full tab order — filtered-out tabs (private / unpinned) would shift
        // the index and the wrong tab would be focused on restore.
        const activeOrdinal = Math.max(0, selected.indexOf(this.activeTabIndex));
        return { tabs, activeIndex: activeOrdinal, persistAllTabs: includeAll, profile: this.profileId, activeWorkspace: this.profileId, folders: this.folders.map(f => ({ ...f })) };
    }
    saveStateDebounced() {
        if (!this.persistence)
            return;
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
            try {
                this.persistence.saveWindowState(this.windowKey, this.buildSerializableState());
            }
            catch (e) { log.debug('tabs', 'saveStateDebounced', e); }
        }, 200);
    }
}

// ── Prototype mixins ─────────────────────────────────────────────────────────
// Cohesive subsystems kept out of this file. They are plain objects of methods,
// so `this` is the Tabs instance and nothing needs to require Tabs back.
/* Tabs is split across features/tabs/*.js — plain objects of methods mixed in
   here, so `this` is the Tabs instance and none of them require Tabs back.
   Each file is one concern: split view, glance, folders/organise, essentials,
   every webContents listener, history navigation, and the two modes that
   replace the page (reader, PiP).

   This reduces file size and gives each concern an owner; it does NOT make
   them independent. They still share one `this`, so Tabs remains the hub —
   real decoupling would mean collaborators with their own state, which is a
   bigger change than a file split. */
Object.assign(Tabs.prototype,
    require('./tabs/split'), require('./tabs/glance'), require('./tabs/organize'),
    require('./tabs/essentials'), require('./tabs/listeners'),
    require('./tabs/navigation'), require('./tabs/reader'));

Tabs.parseNorthstarUrl = parseNorthstarUrl;
module.exports = Tabs;