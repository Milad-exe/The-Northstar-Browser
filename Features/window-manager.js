const { BrowserWindow, Menu, screen } = require('electron');
const path = require("path");
const Tabs = require("./tabs");
const Persistence = require("./persistence");
const History = require("./history");
const Bookmarks = require("./bookmarks");
const Shortcuts = require("./shortcuts");
const contextMenu = require("./window-context-menu");

class WindowManager {
    constructor() {
        this.windows = new Map();
        this.cachedHistory = null;
        this.cachedBookmarks = null;
        this.nextWindowId = 0;
        this.cachedPersistence = null;
        this.restored = false;
        // Track most recently focused BrowserWindow
        this.lastFocusedWindowId = null;
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
        }
        return this.cachedPersistence;
    }

    get bookmarks() {
        if (!this.cachedBookmarks) {
            this.cachedBookmarks = new Bookmarks();
        }
        return this.cachedBookmarks;
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
        } catch {}
        return bounds;
    }

    _persistWindowBounds(window, options = {}) {
        try {
            if (!window || window.isDestroyed()) return;
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
        } catch {}
    }

    _persistPrimaryWindowBounds() {
        try {
            const focused = BrowserWindow.getFocusedWindow();
            if (focused && !focused.isDestroyed()) {
                this._persistWindowBounds(focused);
                return;
            }
            const primary = this.getPrimaryWindow();
            if (primary?.window) this._persistWindowBounds(primary.window);
        } catch {}
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
            width:  restoredBounds ? restoredBounds.width  : width,
            height: restoredBounds ? restoredBounds.height : height,
            ...(restoredBounds ? { x: restoredBounds.x, y: restoredBounds.y } : {}),
            // inactive: shown via showInactive() below — used for tab tear-off,
            // where focusing a new window mid-drag would break mouse capture.
            ...(options?.inactive ? { show: false } : {}),
            minWidth: 800,
            minHeight: 600,
            icon: path.join(__dirname, '../logo.png'),
            frame: process.platform === 'linux' ? true : false,
            titleBarStyle: process.platform === 'win32' || process.platform === 'linux' ? 'default' : 'hiddenInset',
            trafficLightPosition: { x: 14, y: 15 }, // Vertically center within the 42px top tab strip
            // macOS frosted-glass: the window material shows through the
            // translucent chrome (renderer paints the chrome with alpha).
            ...(process.platform === 'darwin'
                ? { vibrancy: 'under-window', visualEffectState: 'active', backgroundColor: '#00000000' }
                : { backgroundColor: '#0c0c0c' }),
            webPreferences: {
                preload: path.join(__dirname, "../preload/preload.js"),
                // The chrome UI loads only trusted local files, and its preload
                // must require the extension browser-action module from disk
                // (impossible in a sandboxed preload). Tabs stay sandboxed.
                sandbox: false,
                contextIsolation: true,
            }
        });

        window.on('maximize',   () => {
            try { window.webContents.send('window-maximize-changed', true); } catch {}
            this._persistWindowBounds(window);
        });
        window.on('unmaximize', () => {
            try { window.webContents.send('window-maximize-changed', false); } catch {}
            this._persistWindowBounds(window);
        });

        window.on('enter-full-screen', () => {
            this._persistWindowBounds(window);
        });
        window.on('leave-full-screen', () => {
            this._persistWindowBounds(window);
        });

        const shouldFullScreen = !!savedState?.isFullScreen;
        const shouldMaximize = !!savedState?.isMaximized && !shouldFullScreen;
        if (shouldFullScreen || shouldMaximize) {
            window.once('ready-to-show', () => {
                try {
                    if (shouldFullScreen) window.setFullScreen(true);
                    else window.maximize();
                } catch {}
            });
        }

        window.loadFile('renderer/Browser/index.html');
        if (options?.inactive) {
            window.once('ready-to-show', () => { try { window.showInactive(); } catch {} });
        }

        // Save window bounds whenever it moves or resizes (debounced)
        let _saveBoundsTimer = null;
        const _saveBounds = () => {
            clearTimeout(_saveBoundsTimer);
            _saveBoundsTimer = setTimeout(() => {
                this._persistWindowBounds(window, { forceNormal: true });
            }, 400);
        };
        window.on('resize', _saveBounds);
        window.on('move',   _saveBounds);

        // If this is the last window, persist its bounds and tab state before it
        // closes. On Windows/Linux 'before-quit' fires after this window has
        // already been removed from the map, so savePrimaryState() finds no
        // primary window — this is the last reliable moment to save.
        window.on('close', () => {
            if (this.windows.size === 1) {
                this._persistWindowBounds(window);
                try {
                    if (tabs.tabMap.size > 0 && !tabs.isPrivateWindow) {
                        this.persistence.saveState(tabs.buildSerializableState());
                    }
                } catch {}
            }
        });

        // Track focus order: most recently focused is considered primary for persistence
        window.on('focus', () => {
            this.lastFocusedWindowId = windowId;
        });
        
        const tabs = new Tabs(window, this.history, this.persistence, { private: !!options?.private });
        const shortcuts = new Shortcuts(window, tabs, this);

        tabs.setShortcuts(shortcuts);
        tabs.setWindowManager(this);

        window.webContents.on("context-menu", async (_event, params) => {
            // Determine the element under the cursor to enrich params for context decisions
            try {
                const contextInfo = await window.webContents.executeJavaScript(
                    `(() => {
                        const el = document.elementFromPoint(${params.x}, ${params.y});
                        const tabEl = el ? el.closest('.tab-button') : null;
                        const tabBarEl = el ? el.closest('#tab-bar') : null;
                        return {
                            targetElementId: el ? (el.id || '') : '',
                            isTabButton: !!tabEl,
                            rightClickedTabIndex: tabEl ? (parseInt(tabEl.dataset.index) ?? null) : null,
                            targetAreaIsTabBar: !!tabBarEl && !tabEl,
                        };
                    })()`
                );
                params.targetElementId = contextInfo.targetElementId;
                params.isTabButton = contextInfo.isTabButton;
                params.rightClickedTabIndex = contextInfo.rightClickedTabIndex;
                params.targetAreaIsTabBar = contextInfo.targetAreaIsTabBar;
            } catch (_) {}

            const contextMenuInstance = new contextMenu(window, params, this);
            
            if (contextMenuInstance.getTemplate().length === 0) {
                return;
            }

            const menu = Menu.buildFromTemplate(contextMenuInstance.getTemplate());
            menu.popup({ window });
        })

        const windowData = {
            id: windowId,
            window: window,
            tabs: tabs,
            shortcuts: shortcuts,
            menu: null
        };

        this.windows.set(windowId, windowData);

        window.webContents.once('did-finish-load', () => {
            // Notify renderer if this is a private window
            if (options?.private) {
                window.webContents.send('set-private-window', true);
            }

            // Restore only once into the first opened window (if any state exists)
            const state = (!this.restored && this.persistence.hasState()) ? this.persistence.loadState() : null;
            if (state && state.tabs && state.tabs.length > 0) {
                try {
                    // Create in saved order
                    state.tabs.forEach((t) => {
                        tabs.createLazyTab(t.url, t.title, t.pinned);
                    });
                    
                    // Focus saved active if valid
                    if (typeof state.activeIndex === 'number') {
                        const tabKeys = Array.from(tabs.tabMap.keys()).sort((a,b)=>a-b);
                        const focusIdx = tabKeys[state.activeIndex] ?? tabKeys[0];
                        if (typeof focusIdx === 'number') tabs.showTab(focusIdx);
                    } else {
                        // Show first tab by default
                        const tabKeys = Array.from(tabs.tabMap.keys()).sort((a,b)=>a-b);
                        if (tabKeys.length > 0) tabs.showTab(tabKeys[0]);
                    }
                } catch {
                    // Fallback: at least one tab
                    if (tabs.getTotalTabs() === 0) tabs.createTab();
                }
                this.restored = true;
            } else {
                tabs.createTab();
            }
            shortcuts.registerAllShortcuts();
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
                                } catch {}
                            }, 20);
                        } catch {}
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

    getWindowByWebContents(webContents) {
        for (const [id, windowData] of this.windows) {
            if (windowData.window.webContents === webContents) return windowData;
            // Also match child WebContentsViews (suggestions, menu, bookmarkPrompt, folderDropdown, downloads)
            if (windowData.suggestions?.webContents === webContents) return windowData;
            if (windowData.menu?.webContents === webContents) return windowData;
            if (windowData.bookmarkPrompt?.webContents === webContents) return windowData;
            if (windowData.folderDropdown?.webContents === webContents) return windowData;
            if (windowData.downloadsPanel?.webContents === webContents) return windowData;
            if (windowData.passwordPrompt?.webContents === webContents) return windowData;
            if (windowData.siteInfoView?.webContents === webContents) return windowData;
            if (windowData.miniPlayer?.webContents === webContents) return windowData;
            // Match tab WebContentsViews
            if (windowData.tabs) {
                for (const [, tab] of windowData.tabs.tabMap) {
                    if (tab && tab.webContents === webContents) return windowData;
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
            if (win) return win;
        }
        return null;
    }

    // Primary window for persistence is the most recently focused; fallback to oldest
    getPrimaryWindow() {
        const recent = this.getMostRecentlyFocusedWindow();
        if (recent) return recent;
        if (this.windows.size === 0) return null;
        const entries = Array.from(this.windows.entries()).sort((a, b) => a[0] - b[0]);
        return entries[0][1] || null;
    }

    // Save the current state from the primary window (synchronously) into persistence
    savePrimaryState() {
        try {
            const primary = this.getPrimaryWindow();
            if (!primary || !primary.tabs) return false;
            const state = primary.tabs.buildSerializableState();
            this.persistence.saveState(state);
            return true;
        } catch (e) {
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