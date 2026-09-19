const { BrowserWindow, Menu, screen, app } = require('electron');
const { resolveAppFile } = require('../app-paths');
const path = require('path');
const Tabs = require('./tabs');
const Persistence = require('./persistence');
const History = require('./history');
const Bookmarks = require('./bookmarks');
const Shortcuts = require('./shortcuts');
const contextMenu = require('./window-context-menu');
const zoom = require('./zoom');
const searchEngines = require('./search-engines');
const i18n = require('./i18n');
const log = require('./log');
const { isOverlayOf } = require('./overlay-registry');
const overlayMenu = require('./overlay-menu');
const appIcon = require('./app-icon');
// Windows 11 (build 22000+) can draw the native Mica backdrop behind the window,
// the closest thing to macOS's vibrancy — a subtle desktop-tinted translucency
// under the chrome. Older Windows and Linux have no such material and keep a
// solid shell. Enabling Mica needs a transparent window backgroundColor, so it
// must be gated strictly: a transparent background with no material behind it is
// a broken (see-through) window.
const IS_WIN11 = process.platform === 'win32'
    && parseInt((require('os').release().split('.')[2] || '0'), 10) >= 22000;
class WindowManager {
    windows; // windowId → { id, window, tabs, shortcuts, menu, … overlays }
    nextWindowId;
    lastFocusedWindowId; // most recently focused window (persistence primary)
    restored; // saved tab state already restored into a window?
    cachedHistory;
    cachedBookmarks;
    cachedPersistence;
    constructor() {
        this.windows = new Map();
        this.cachedHistory = null;
        this.cachedBookmarks = null;
        this.nextWindowId = 0;
        this.cachedPersistence = null;
        this.restored = false;
        // Track most recently focused BrowserWindow
        this.lastFocusedWindowId = null;
        // Keyboard shortcuts, ONE routing point. Every keystroke reaches only the
        // webContents that holds focus, and the chrome, each tab and every overlay
        // (hamburger menu, omnibox, panels, prompts) are all separate
        // WebContentsViews. Forwarding before-input-event for ANY of them to the
        // owning window's Shortcuts is what makes a shortcut fire no matter which
        // surface is focused — previously only tabs and the chrome had a listener,
        // so Ctrl+H / Ctrl+, went dead the moment a menu or the address bar took
        // focus. getWindowByWebContents already resolves chrome, tabs AND overlays
        // to their window, so this one hook covers them all (and any added later).
        try { app.on('web-contents-created', (_e, wc) => this._routeShortcuts(wc)); }
        catch (e) { log.warn('window-manager', 'shortcut routing', e); }
    }
    /** Forward a webContents' keyboard input to its window's Shortcuts. Attached
     *  once per webContents; unknown contents (devtools, extension backgrounds)
     *  resolve to no window and are simply ignored. */
    _routeShortcuts(wc) {
        if (!wc || wc.__nsShortcutRouted)
            return;
        wc.__nsShortcutRouted = true;
        wc.on('before-input-event', (event, input) => {
            try { this.getWindowByWebContents(wc)?.shortcuts?.handleInput(event, input); }
            catch (e) { log.debug('window-manager', 'route input', e); }
        });
    }
    get history() {
        if (!this.cachedHistory) {
            this.cachedHistory = new History();
        }
        return this.cachedHistory;
    }
    get persistence() {
        if (!this.cachedPersistence) {
            this.cachedPersistence = new Persistence();
            // Modules that hold user preferences but must not depend on
            // Persistence (construction order) are fed from here, once.
            try {
                History.setRetention({
                    maxDays: this.cachedPersistence.get('historyDays'),
                    maxEntries: this.cachedPersistence.get('historyMaxEntries'),
                });
                zoom.init(this.cachedPersistence);
                searchEngines.init(this.cachedPersistence);
                i18n.init(this.cachedPersistence);
            }
            catch (e) {
                log.warn('window-manager', 'could not apply stored preferences', e);
            }
        }
        return this.cachedPersistence;
    }
    get bookmarks() {
        if (!this.cachedBookmarks) {
            this.cachedBookmarks = new Bookmarks();
        }
        return this.cachedBookmarks;
    }
    // ── Per-profile stores ────────────────────────────────────────────────────
    // Profile 1 keeps the legacy files (no migration); other profiles get their
    // own '-p<id>'-suffixed history/bookmark files.
    historyFor(profileId) {
        const pid = String(profileId || '1');
        if (pid === '1')
            return this.history;
        if (!this.profileHistories)
            this.profileHistories = new Map();
        if (!this.profileHistories.has(pid))
            this.profileHistories.set(pid, new History(`-p${pid}`));
        return this.profileHistories.get(pid);
    }
    bookmarksFor(profileId) {
        const pid = String(profileId || '1');
        if (pid === '1')
            return this.bookmarks;
        if (!this.profileBookmarks)
            this.profileBookmarks = new Map();
        if (!this.profileBookmarks.has(pid))
            this.profileBookmarks.set(pid, new Bookmarks(`-p${pid}`));
        return this.profileBookmarks.get(pid);
    }
    // Profile of the window owning `sender` (chrome, overlay, or tab wc).
    profileOf(sender) {
        const wd = this.getWindowByWebContents(sender);
        return wd?.profileId || '1';
    }
    // Switch a window to another workspace IN PLACE: repoint its
    // profile + history store, reveal that workspace's tabs, and tell the chrome
    // to filter the strip + refresh essentials/bookmarks/profile chip.
    switchWorkspace(wd, id) {
        id = String(id);
        if (!wd?.tabs || (wd.profileId || '1') === id)
            return;
        wd.profileId = id;
        wd.tabs.profileId = id;
        wd.tabs.history = this.historyFor(id);
        try {
            wd.tabs.applyWorkspace();
        }
        catch (e) { log.debug('window-manager', 'switchWorkspace', e); }
        /* A space carries its own theme, and this switch repoints the window's
           space in place — so the window now resolves to a different theme
           without anything having moved. Nothing else triggers that repaint,
           which is why a space's colours used to arrive only on the next
           unrelated theme change. */
        // Essential tiles show whether THIS space has a tab for them.
        try { wd.tabs.sendEssentialTabs(); }
        catch (e) { log.debug('window-manager', 'switchWorkspace essentials', e); }
        try { require('./theme-runtime').repaintAll(this); }
        catch (e) { log.debug('window-manager', 'switchWorkspace theme', e); }
        try {
            wd.window.webContents.send('workspace-switched', id);
            // These views are per-workspace — re-emit their change events so the
            // bookmark bar + Essentials reload for the new workspace.
            wd.window.webContents.send('bookmarks-changed');
            wd.window.webContents.send('essentials-changed');
        }
        catch (e) { log.debug('window-manager', 'switchWorkspace', e); }
        // Folders are per-workspace too. Without this the strip keeps the old
        // workspace's folders — and on the startup restore, which switches into
        // the saved workspace, they never appear at all.
        try { wd.tabs.broadcastFolders(); }
        catch (e) { log.debug('window-manager', 'switchWorkspace', e); }
    }
    // Sidebar ⇄ top-strip, in one place so the Settings toggle, the ⌘⇧S shortcut
    // and the context-menu item all reflow identically: persist the choice, then
    // every window re-lays its chrome (renderer) and re-fits its page views.
    setTabBarSide(value) {
        const v = value === 'top' ? 'top' : 'side';
        try { this.persistence.set('tabBarSide', v); }
        catch (e) { log.debug('window-manager', 'setTabBarSide', e); }
        for (const w of this.windows.values()) {
            try {
                w.window.webContents.send('tabbar-side-changed', v);
                w.tabs.resizeAllTabs();
            }
            catch (e) { log.debug('window-manager', 'setTabBarSide reflow', e); }
        }
        return v;
    }
    _clampBoundsToDisplays(bounds) {
        try {
            const displays = screen.getAllDisplays();
            const { x, y, width, height } = bounds;
            const visible = displays.some(d => {
                const wa = d.workArea;
                return x < wa.x + wa.width - 50 &&
                    x + width > wa.x + 50 &&
                    y < wa.y + wa.height - 50 &&
                    y + height > wa.y + 50;
            });
            if (!visible) {
                const primary = screen.getPrimaryDisplay().workArea;
                return { x: primary.x, y: primary.y, width, height };
            }
        }
        catch (e) { log.debug('window-manager', '_clampBoundsToDisplays', e); }
        return bounds;
    }
    _persistWindowBounds(window, options = {}) {
        try {
            if (!window || window.isDestroyed())
                return;
            const { forceNormal = false } = options || {};
            const isMinimized = typeof window.isMinimized === 'function' ? window.isMinimized() : false;
            const isMaximized = forceNormal ? false
                : (typeof window.isMaximized === 'function' ? window.isMaximized() : false);
            const windowData = this.getWindowByWebContents?.(window.webContents);
            const isHtmlFullScreen = !!windowData?.tabs?.isHtmlFullScreen;
            const isFullScreen = forceNormal ? false
                : (!isHtmlFullScreen && (typeof window.isFullScreen === 'function' ? window.isFullScreen() : false));
            const bounds = window.getBounds();
            const normalBounds = (isMinimized || isMaximized || isFullScreen) && typeof window.getNormalBounds === 'function'
                ? window.getNormalBounds()
                : bounds;
            if (normalBounds && normalBounds.width > 0 && normalBounds.height > 0) {
                this.persistence.set('windowBounds', normalBounds);
                this.persistence.set('windowState', {
                    bounds,
                    normalBounds,
                    isMaximized,
                    isFullScreen,
                });
            }
        }
        catch (e) { log.debug('window-manager', 'normalBounds', e); }
    }
    _persistPrimaryWindowBounds() {
        try {
            const focused = BrowserWindow.getFocusedWindow();
            if (focused && !focused.isDestroyed()) {
                this._persistWindowBounds(focused);
                return;
            }
            const primary = this.getPrimaryWindow();
            if (primary?.window)
                this._persistWindowBounds(primary.window);
        }
        catch (e) { log.debug('window-manager', '_persistPrimaryWindowBounds', e); }
    }
    createWindow(width = 800, height = 600, options = {}) {
        const windowId = this.nextWindowId++;
        // Restore saved size/position when there are no open windows
        const savedState = this.windows.size === 0
            ? this.persistence.get('windowState')
            : null;
        const savedBounds = this.windows.size === 0
            ? (savedState?.normalBounds || savedState?.bounds || this.persistence.get('windowBounds'))
            : null;
        const restoredBounds = (savedBounds && savedBounds.width > 0 && savedBounds.height > 0)
            ? this._clampBoundsToDisplays(savedBounds)
            : null;
        const window = new BrowserWindow({
            width: restoredBounds ? restoredBounds.width : width,
            height: restoredBounds ? restoredBounds.height : height,
            ...(restoredBounds ? { x: restoredBounds.x, y: restoredBounds.y } : {}),
            // Hidden until ready-to-show: with a transparent background the
            // window would otherwise appear as an empty ghost at normal bounds
            // before the chrome paints (and before maximize/fullscreen apply).
            show: false,
            minWidth: 800,
            minHeight: 600,
            icon: path.join(__dirname, process.platform === 'win32' ? '../logo-win.png' : '../logo.png'),
            frame: process.platform === 'linux' ? true : false,
            titleBarStyle: process.platform === 'win32' || process.platform === 'linux' ? 'default' : 'hiddenInset',
            // Native auto-hide menu bar (revealed by Alt) only on LINUX, where the
            // window is framed and Electron can actually draw it. NOT on Windows:
            // the window is frameless so there is no bar to draw, and leaving
            // autoHideMenuBar on there makes Chromium hijack the Alt key to toggle
            // that invisible bar — eating the keypress and stealing focus, which is
            // exactly what broke the in-chrome Alt bar (it needs the raw Alt via
            // before-input-event). macOS uses the system menu bar.
            ...(process.platform === 'linux' ? { autoHideMenuBar: true } : {}),
            // Centre on the utility bar, which spans the top: shell-top inset
            // plus half the bar height, less half a 12px light. Derived rather
            // than hardcoded so it follows the bar height.
            trafficLightPosition: { x: 14, y: Tabs.SHELL_TOP + Math.round(Tabs.UTILITY_BAR_H / 2) - 6 },
            // macOS otherwise swallows the first click on a window that is not
            // key: it activates the window and the control never sees it. That
            // is the "I had to click twice" feeling when coming back from
            // another app, or after focus has moved into a page view. Browsers
            // deliver that first click, so this does too.
            acceptFirstMouse: true,
            // Native window material shows through the translucent chrome (the
            // renderer paints the chrome with alpha under [data-vibrancy]):
            //   macOS      — NSVisualEffectView vibrancy
            //   Windows 11 — Mica (needs a transparent backgroundColor)
            //   otherwise  — a solid shell fill (no material available)
            ...(process.platform === 'darwin'
                ? { vibrancy: 'under-window', visualEffectState: 'active', backgroundColor: '#00000000' }
                : IS_WIN11
                    ? { backgroundMaterial: 'mica', backgroundColor: '#00000000' }
                    : { backgroundColor: '#0e0f11' }), // --shell (themes.css)
            webPreferences: {
                preload: path.join(__dirname, "../preload/preload.js"),
                // The chrome UI loads only trusted local files, and its preload
                // must require the extension browser-action module from disk
                // (impossible in a sandboxed preload). Tabs stay sandboxed.
                sandbox: false,
                contextIsolation: true,
            }
        });
        // The `icon:` above is the default-theme mark; a window opened while a
        // different theme is selected needs the matching one. No-op on macOS,
        // where the icon belongs to the app rather than the window.
        appIcon.applyToWindow(window, this.persistence.get('theme'));
        // ── Gesture / hardware navigation ────────────────────────────────────
        // Neither of these existed, so two habits that work in every other
        // browser silently did nothing here: the macOS swipe gesture, and the
        // back/forward buttons on a mouse (Windows/Linux).
        const navigate = (back) => {
            const wd = this.getWindowByWebContents(window.webContents);
            const tabs = wd?.tabs;
            if (!tabs)
                return;
            try { back ? tabs.goBack(tabs.activeTabIndex) : tabs.goForward(tabs.activeTabIndex); }
            catch (e) { log.debug('window-manager', 'navigate', e); }
        };
        // macOS three-finger swipe (System Settings → Trackpad → "Swipe between
        // pages"). The two-finger overscroll variant is a Chromium browser-side
        // feature Electron does not expose, so it stays unavailable.
        window.on('swipe', (_e, direction) => {
            if (direction === 'left')
                navigate(true);
            else if (direction === 'right')
                navigate(false);
        });
        // Mouse thumb buttons.
        // Fires when the mouse thumb buttons reach the WINDOW — the case where the
        // cursor is over the chrome. Over a PAGE the page view swallows
        // WM_APPCOMMAND before it gets here, so the tab preload also forwards the
        // buttons (ipc 'nav:mouse'); both routes call the same navigate().
        window.on('app-command', (e, cmd) => {
            if (cmd === 'browser-backward') { e.preventDefault?.(); navigate(true); }
            else if (cmd === 'browser-forward') { e.preventDefault?.(); navigate(false); }
        });
        // Windows: right-clicking a window-drag region (the top strip beside the
        // controls, the utility bar / omnibox) is treated by the OS as a caption
        // right-click and pops the native window system menu (Restore/Move/Size/
        // Close). We provide our own context menus, so suppress the OS one — this
        // event is Windows-only and never fires elsewhere.
        window.on('system-context-menu', (event) => {
            event.preventDefault();
        });
        window.on('maximize', () => {
            try {
                window.webContents.send('window-maximize-changed', true);
            }
            catch (e) { log.debug('window-manager', 'navigate', e); }
            this._persistWindowBounds(window);
        });
        window.on('unmaximize', () => {
            try {
                window.webContents.send('window-maximize-changed', false);
            }
            catch (e) { log.debug('window-manager', 'navigate', e); }
            this._persistWindowBounds(window);
        });
        window.on('enter-full-screen', () => {
            this._persistWindowBounds(window);
        });
        window.on('leave-full-screen', () => {
            this._persistWindowBounds(window);
        });
        // First reveal happens only after the chrome has painted, at its final
        // state (restored bounds + maximize/fullscreen), so the drag regions in
        // the tab strip / toolbar are grabbable from the very first frame.
        const shouldFullScreen = !!savedState?.isFullScreen;
        const shouldMaximize = !!savedState?.isMaximized && !shouldFullScreen;
        window.once('ready-to-show', () => {
            try {
                if (shouldFullScreen)
                    window.setFullScreen(true);
                else if (shouldMaximize)
                    window.maximize();
            }
            catch (e) { log.debug('window-manager', 'navigate', e); }
            // inactive: tab tear-off — focusing a new window mid-drag would
            // break mouse capture.
            /* deferShow: the window is built and loaded but stays hidden until
               someone reveals it — the first-launch splash uses this so the
               browser boots BEHIND the animation rather than after it. */
            if (options?.deferShow)
                return;
            try {
                options?.inactive ? window.showInactive() : window.show();
            }
            catch (e) { log.debug('window-manager', 'navigate', e); }
        });
        window.loadFile(resolveAppFile('renderer/Browser/index.html'));
        // Safety net: if the renderer never signals ready-to-show (load error),
        // don't leave the user with an invisible window.
        setTimeout(() => {
            try {
                // A deferred window is hidden on purpose; reveal() shows it.
                if (!window.isDestroyed() && !window.isVisible() && !options?.deferShow)
                    window.show();
            }
            catch (e) { log.debug('window-manager', 'navigate', e); }
        }, 3000);
        // Save window bounds whenever it moves or resizes (debounced)
        let _saveBoundsTimer = null;
        const _saveBounds = () => {
            clearTimeout(_saveBoundsTimer);
            _saveBoundsTimer = setTimeout(() => {
                if (!window || window.isDestroyed())
                    return;
                // Maximise (Windows snap), fullscreen and minimise all fire a
                // resize/move too. Those states are recorded by their own handlers
                // (maximize/unmaximize/enter-full-screen/…); running here with
                // forceNormal would stamp isMaximized:false over them, so the
                // window reopened un-maximised. Only record NORMAL-state geometry.
                const maxed = typeof window.isMaximized === 'function' && window.isMaximized();
                const full = typeof window.isFullScreen === 'function' && window.isFullScreen();
                const mini = typeof window.isMinimized === 'function' && window.isMinimized();
                if (maxed || full || mini)
                    return;
                this._persistWindowBounds(window, { forceNormal: true });
            }, 400);
        };
        window.on('resize', _saveBounds);
        window.on('move', _saveBounds);
        // If this is the last window, persist its bounds and tab state before it
        // closes. On Windows/Linux 'before-quit' fires after this window has
        // already been removed from the map, so savePrimaryState() finds no
        // primary window — this is the last reliable moment to save.
        window.on('close', () => {
            this._persistWindowBounds(window);
            // Quitting already took the whole-session snapshot (savePrimaryState)
            // and froze it, so there is nothing to do here.
            if (this._quitting)
                return;
            try {
                if (!tabs.tabMap.size || tabs.isPrivateWindow)
                    return;
                if (this.windows.size === 1) {
                    // Closing the last window IS ending the session — and on
                    // Windows/Linux 'before-quit' arrives too late to see it.
                    this.persistence.saveWindowState(windowId, tabs.buildSerializableState());
                    this.persistence.flushStateSync();
                    this.persistence.freeze();
                }
                else {
                    // One window of several, closed by hand: the user threw it
                    // away, so it should not come back next launch.
                    this.persistence.forgetWindowState(windowId);
                }
            }
            catch (e) {
                log.warn('window-manager', 'could not save the window session', e);
            }
        });
        // Track focus order: most recently focused is considered primary for persistence
        window.on('focus', () => {
            this.lastFocusedWindowId = windowId;
            // Native widgets + the page's default colour scheme follow the focused
            // window's space theme mode.
            try { require('./theme-runtime').syncNativeTheme(this); }
            catch (e) { log.debug('window-manager', 'focus theme', e); }
            // Keyboard shortcuts (and the Alt menu bar) are delivered through
            // before-input-event, which fires only on the webContents that holds
            // keyboard focus. On a frameless window, coming back to it — or
            // clicking the title-bar drag region — can leave focus on the native
            // frame with NO webContents focused, so keys (Alt especially) go
            // nowhere and the user has to press twice. If nothing holds focus,
            // hand it to the active tab. Focusing the webContents (not a specific
            // element) shows no focus ring.
            try {
                const { webContents } = require('electron');
                if (!webContents.getFocusedWebContents()) {
                    const t = tabs && tabs.tabMap.get(tabs.activeTabIndex);
                    if (t && t.webContents && !t.webContents.isDestroyed())
                        t.webContents.focus();
                    else if (!window.isDestroyed())
                        window.webContents.focus();
                }
            }
            catch (e) { log.debug('window-manager', 'focus ensure', e); }
        });
        // Each window belongs to one profile: its tabs browse on that profile's
        // session and record into that profile's history/bookmarks.
        const profileId = String(options?.profile || '1');
        const tabs = new Tabs(window, this.historyFor(profileId), this.persistence, { private: !!options?.private, profile: profileId, windowKey: windowId });
        const shortcuts = new Shortcuts(window, tabs, this);
        tabs.setShortcuts(shortcuts);
        tabs.setWindowManager(this);
        window.webContents.on("context-menu", async (_event, params) => {
            // Determine the element under the cursor to enrich params for context decisions
            try {
                const contextInfo = await window.webContents.executeJavaScript(`(() => {
                        const el = document.elementFromPoint(${params.x}, ${params.y});
                        const tabEl = el ? el.closest('.tab-button') : null;
                        const tabBarEl = el ? el.closest('#tab-bar') : null;
                        return {
                            targetElementId: el ? (el.id || '') : '',
                            isTabButton: !!tabEl,
                            rightClickedTabIndex: tabEl ? (parseInt(tabEl.dataset.index) ?? null) : null,
                            targetAreaIsTabBar: !!tabBarEl && !tabEl,
                        };
                    })()`);
                params.targetElementId = contextInfo.targetElementId;
                params.isTabButton = contextInfo.isTabButton;
                params.rightClickedTabIndex = contextInfo.rightClickedTabIndex;
                params.targetAreaIsTabBar = contextInfo.targetAreaIsTabBar;
            }
            catch (_) { log.debug('window-manager', '_saveBounds', _); }
            const contextMenuInstance = new contextMenu(window, params, this);
            if (contextMenuInstance.getTemplate().length === 0) {
                return;
            }
            const template = contextMenuInstance.getTemplate();
            // The app's own menu; native only if the overlay cannot be shown.
            if (overlayMenu.popup(this.getWindowByWebContents(window.webContents), template, 0, 0))
                return;
            const menu = Menu.buildFromTemplate(template);
            menu.popup({ window });
        });
        const windowData = {
            id: windowId,
            window: window,
            tabs: tabs,
            shortcuts: shortcuts,
            profileId: profileId,
            menu: null
        };
        this.windows.set(windowId, windowData);
        window.webContents.once('did-finish-load', () => {
            // Notify renderer if this is a private window
            if (options?.private) {
                window.webContents.send('set-private-window', true);
            }
            // Restore only once into the first opened window (if any state
            // exists), and only into a window of the profile the state was saved
            // under. A window created FOR a restore carries its slice with it.
            let state = options?.restoreState || null;
            if (!state && !this.restored && this.persistence.hasState()) {
                const saved = this.persistence.loadAllWindowStates();
                state = saved[0] || null;
                this._pendingWindowStates = saved.slice(1);
            }
            // Drop any blank new-tab pages an earlier session persisted — an empty
            // "New tab" must never come back on load, even from an existing state file.
            if (state && Array.isArray(state.tabs))
                state.tabs = state.tabs.filter(t => t && t.url && t.url !== 'newtab');
            if (state && state.tabs && state.tabs.length > 0 && String(state.profile || '1') === profileId) {
                try {
                    // Rebuild every workspace's tabs (each tagged with its own
                    // workspace + container); only the active workspace's show.
                    const tabKeys = [];
                    state.tabs.forEach((t) => {
                        tabs.createLazyTab(t.url, t.title, t.pinned, false, false, false, t.container || null, t.workspace || '1');
                        const key = tabs.nextTabIndex - 1;
                        tabKeys.push(key);
                        // Bring the tab's own back/forward tree and reading
                        // position with it, not just its address.
                        if (Array.isArray(t.history) && t.history.length > 1)
                            tabs.navigationHistory.restoreTab(key, t.history, t.historyIndex || 0);
                        if (t.scroll > 0)
                            tabs.tabScroll.set(key, t.scroll);
                    });
                    // Restore tab folders (tab groups) + their tab membership.
                    if (Array.isArray(state.folders) && state.folders.length) {
                        tabs.folders = state.folders.map(f => ({ ...f }));
                        let maxSeq = 0;
                        for (const f of tabs.folders) { const n = parseInt(String(f.id).replace(/^f/, '')); if (n > maxSeq) maxSeq = n; }
                        tabs._folderSeq = maxSeq + 1;
                        state.tabs.forEach((t, i) => { if (t.folder) tabs.tabFolders.set(tabKeys[i], t.folder); });
                    }
                    // User-set labels and icons override page metadata, so they
                    // have to come back before the tabs report their own titles.
                    state.tabs.forEach((t, i) => {
                        if (t.label) tabs.tabLabels.set(tabKeys[i], t.label);
                        if (t.icon) tabs.tabIcons.set(tabKeys[i], t.icon);
                        if (t.home) tabs.pinnedHome.set(tabKeys[i], t.home);
                    });
                    const activeWs = String(state.activeWorkspace || state.profile || '1');
                    if (activeWs !== profileId) {
                        tabs.profileId = activeWs;
                        windowData.profileId = activeWs;
                        tabs.history = this.historyFor(activeWs);
                    }
                    // Restore assigns folders straight onto the Tabs instance, so
                    // nothing tells the chrome about them: its own init fetch runs
                    // against the pre-restore workspace and comes back empty, and
                    // restored folders never appear. Push them once it can listen.
                    try {
                        const wc = windowData.window.webContents;
                        if (wc.isLoading())
                            wc.once('did-finish-load', () => { try { tabs.broadcastFolders(); } catch (e) { log.debug('window-manager', '_saveBounds', e); } });
                        else
                            tabs.broadcastFolders();
                    }
                    catch (e) { log.debug('window-manager', '_saveBounds', e); }
                    // Focus the saved active tab if it's in the active workspace,
                    // else the active workspace's first tab.
                    const inWs = tabs.tabsInWorkspace(tabs.profileId);
                    const savedActive = (typeof state.activeIndex === 'number') ? tabKeys[state.activeIndex] : undefined;
                    const focusIdx = (savedActive != null && inWs.includes(savedActive)) ? savedActive : inWs[0];
                    if (typeof focusIdx === 'number')
                        tabs.showTab(focusIdx);
                }
                catch (e) {
                    // A failed restore used to be silent, so a session that came
                    // back empty looked like the state file was simply missing.
                    log.error('window-manager', 'session restore failed', e);
                }
                this.restored = true;
                // The rest of last session's windows, once this one is up.
                this._restoreRemainingWindows();
            }
            else if (options?.url) {
                // Opened FOR a link ("open in new window"): the window starts on
                // that page rather than on a blank tab with the palette up.
                const idx = tabs.createTab(null, true, !!options?.private);
                tabs.loadUrl(idx, options.url);
            }
            // …and nothing else. A fresh window opens with NO tabs: an empty
            // rail and the page card in the theme's own colour. It used to
            // create a blank tab, which then raised the palette, so the browser
            // greeted you with a dialog you had not asked for.
            // Whether or not there was anything to restore, the restore slot is
            // now spent: a window opened LATER in the session must start empty,
            // not re-run the restore and clone another window's tabs.
            this.restored = true;
            shortcuts.registerAllShortcuts();
            // The window has now resolved its final space, so re-assert the theme:
            // syncs nativeTheme to the space's mode, repaints every surface (so an
            // overlay created earlier isn't left in the stock palette) and pushes
            // the colour scheme onto restored tabs.
            try { require('./theme-runtime').repaintAll(this); }
            catch (e) { log.debug('window-manager', 'startup theme', e); }
        });
        window.on('closed', () => {
            if (shortcuts) {
                shortcuts.unregisterAllShortcuts();
            }
            this.windows.delete(windowId);
            // If other windows remain, move focus to the most recently focused one (or any)
            if (this.windows.size > 0) {
                // Micro-UX tweak: only bring a window forward if one of ours isn't already focused
                const focused = BrowserWindow.getFocusedWindow();
                if (!focused) {
                    const next = this.getMostRecentlyFocusedWindow() || this.getPrimaryWindow() || Array.from(this.windows.values())[0];
                    if (next && next.window && !next.window.isDestroyed()) {
                        try {
                            next.window.show();
                            next.window.focus();
                            // Ensure the active tab's webContents receives focus
                            setTimeout(() => {
                                try {
                                    const activeIdx = next.tabs.activeTabIndex;
                                    const activeTab = next.tabs.tabMap.get(activeIdx);
                                    if (activeTab && activeTab.webContents) {
                                        activeTab.webContents.focus();
                                    }
                                }
                                catch (e) { log.debug('window-manager', 'focusIdx', e); }
                            }, 20);
                        }
                        catch (e) { log.debug('window-manager', 'focusIdx', e); }
                    }
                }
                // After a window closes, persist bounds from the remaining primary window.
                this._persistPrimaryWindowBounds();
            }
        });
        window.webContents.setWindowOpenHandler(({ url }) => {
            this.createWindow();
            return { action: 'deny' };
        });
        return windowData;
    }
    /* Show a window created with `deferShow` — the first-launch splash builds
       the browser behind its animation and reveals it when the animation ends.
       Idempotent: a window already visible is left alone. */
    reveal(wd) {
        const w = wd?.window;
        if (!w || w.isDestroyed() || w.isVisible())
            return false;
        try { w.show(); w.focus(); return true; }
        catch (e) { log.debug('window-manager', 'reveal', e); return false; }
    }
    getWindowByWebContents(webContents) {
        for (const [id, windowData] of this.windows) {
            if (windowData.window.webContents === webContents)
                return windowData;
            // Any overlay view (menu, panel, prompt, split/glance furniture)
            // resolves to its window through the ONE shared set — see
            // features/overlay-registry.js. Previously every view was named
            // here AND in Tabs.raiseFloatingViews, and the two drifted.
            if (isOverlayOf(windowData, webContents))
                return windowData;
            // A popup opened by a page in this window (window.open) has no
            // chrome of its own; resolve it to its opener.
            if (windowData.popups && [...windowData.popups].some(w => !w.isDestroyed?.() && w.webContents === webContents))
                return windowData;
            // And the tabs themselves — a tab's own WebContentsView resolves to
            // its window. (This is the branch the overlay-registry refactor must
            // not drop: without it a page cannot resolve its window for
            // permissions, context menus, downloads.)
            if (windowData.tabs) {
                for (const [, tab] of windowData.tabs.tabMap) {
                    if (tab && tab.webContents === webContents)
                        return windowData;
                }
            }
        }
        return null;
    }
    getAllWindows() {
        return Array.from(this.windows.values());
    }
    getWindowById(id) {
        return this.windows.get(id) || null;
    }
    getWindowCount() {
        return this.windows.size;
    }
    // Most recently focused window, if still open
    getMostRecentlyFocusedWindow() {
        if (this.lastFocusedWindowId !== null) {
            const win = this.windows.get(this.lastFocusedWindowId);
            if (win)
                return win;
        }
        return null;
    }
    // Primary window for persistence is the most recently focused; fallback to oldest
    getPrimaryWindow() {
        const recent = this.getMostRecentlyFocusedWindow();
        if (recent)
            return recent;
        if (this.windows.size === 0)
            return null;
        const entries = Array.from(this.windows.entries()).sort((a, b) => a[0] - b[0]);
        return entries[0][1] || null;
    }
    /** Re-open the other windows from last session, offset so they don't stack. */
    _restoreRemainingWindows() {
        const pending = this._pendingWindowStates || [];
        this._pendingWindowStates = [];
        if (!pending.length || this.persistence.get('restoreAllWindows') === false)
            return;
        pending.forEach((state, i) => {
            setTimeout(() => {
                try {
                    this.createWindow(1000, 700, {
                        profile: String(state.profile || '1'),
                        restoreState: state,
                    });
                }
                catch (e) {
                    log.warn('window-manager', 'could not restore an extra window', e);
                }
            }, 400 * (i + 1));
        });
    }
    /**
     * Quit path: record EVERY open window, synchronously, so the whole session
     * comes back. Also flips `_quitting`, which tells each window's 'close'
     * handler to keep its slice instead of dropping it (a window closed by hand
     * during a session is meant to be gone; one closed by quitting is not).
     */
    savePrimaryState() {
        this._quitting = true;
        try {
            const all = this.getAllWindows().filter(w => w?.tabs && !w.tabs.isPrivateWindow && w.tabs.tabMap.size);
            if (!all.length)
                return false;
            const keepAll = this.persistence.get('restoreAllWindows') !== false;
            for (const w of (keepAll ? all : all.slice(0, 1))) {
                try { this.persistence.saveWindowState(w.id, w.tabs.buildSerializableState()); }
                catch (e) { log.warn('window-manager', 'could not record a window for restore', e); }
            }
            this.persistence.flushStateSync();
            this.persistence.freeze(); // teardown must not rewrite the snapshot
            return true;
        }
        catch (e) {
            log.error('window-manager', 'session save failed', e);
            return false;
        }
    }
    closeAllWindows() {
        for (const [id, windowData] of this.windows) {
            if (windowData.shortcuts) {
                windowData.shortcuts.unregisterAllShortcuts();
            }
            if (!windowData.window.isDestroyed()) {
                windowData.window.close();
            }
        }
        this.windows.clear();
    }
}

module.exports = WindowManager;