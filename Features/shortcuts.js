const { app } = require('electron');
const focusMode = require('./focus-mode');

class Shortcuts {
    constructor(mainWindow, tabManager, windowManager = null) {
        this.mainWindow = mainWindow;
        this.tabManager = tabManager;
        this.windowManager = windowManager;
        this.shortcuts = new Map();
        this.setupEventListeners();
    }

    setupEventListeners() {
        this.mainWindow.webContents.on('before-input-event', (event, input) => {
            this.handleInput(event, input);
        });

        this.setupAllTabListeners();
    }

    setupAllTabListeners() {
        this.tabManager.tabMap.forEach((tab) => {
            this.setupTabListener(tab);
        });
    }

    setupTabListener(tab) {
        if (!tab.shortcutListenerSetup) {
            tab.webContents.on('before-input-event', (event, input) => {
                this.handleInput(event, input);
            });
            tab.shortcutListenerSetup = true;
        }
    }

    onTabCreated(tab) {
        this.setupTabListener(tab);
    }

    registerWebContents(wc) {
        if (wc.inkShortcutHandler) return;
        const handler = (event, input) => this.handleInput(event, input);
        wc.inkShortcutHandler = handler;
        wc.on('before-input-event', handler);
    }

    unregisterWebContents(wc) {
        if (wc.inkShortcutHandler) {
            wc.removeListener('before-input-event', wc.inkShortcutHandler);
            wc.inkShortcutHandler = null;
        }
    }

    // Callbacks may return false to suppress preventDefault (lets the event reach the page).
    handleInput(event, input) {
        if (input.type !== 'keyDown') return;
        for (const [accelerator, callback] of this.shortcuts) {
            if (this.matchesAccelerator(input, accelerator)) {
                const result = callback();
                if (result !== false) event.preventDefault();
                break;
            }
        }
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
        this.tabManager.createTabWithPage(filePath, type, title);
    }

    reopenClosedTab() {
        const closed = this.tabManager.closedTabHistory;
        if (!closed || closed.length === 0) return;
        const last = closed.pop();
        if (last && last.url && last.url !== 'newtab') {
            const newIndex = this.tabManager.createTab();
            this.tabManager.loadUrl(newIndex, last.url);
        } else {
            this.tabManager.createTab();
        }
    }

    // ── Tab shortcuts ──────────────────────────────────────────────────────────

    registerTabShortcuts() {
        // New tab
        this.registerShortcut('CmdOrCtrl+T', () => {
            this.tabManager.createTab();
        });

        // New window
        this.registerShortcut('CmdOrCtrl+N', () => {
            if (this.windowManager) this.windowManager.createWindow();
        });

        // New private window
        this.registerShortcut('CmdOrCtrl+Shift+N', () => {
            if (this.windowManager) this.windowManager.createWindow(800, 600, { private: true });
        });

        // New private tab
        this.registerShortcut('CmdOrCtrl+Shift+P', () => {
            this.tabManager.createTab(null, true, true);
        });

        // Close tab
        this.registerShortcut('CmdOrCtrl+W', () => {
            const currentTabIndex = this.tabManager.activeTabIndex;
            const totalTabs = this.tabManager.tabMap.size;

            if (totalTabs > 1) {
                const allTabIndexes = Array.from(this.tabManager.tabMap.keys()).sort((a, b) => a - b);
                const currentPosition = allTabIndexes.indexOf(currentTabIndex);
                let targetTabIndex = null;

                if (currentPosition !== -1) {
                    if (currentPosition < allTabIndexes.length - 1) {
                        targetTabIndex = allTabIndexes[currentPosition + 1];
                    } else if (currentPosition > 0) {
                        targetTabIndex = allTabIndexes[currentPosition - 1];
                    }
                }

                this.tabManager.removeTabWithTargetFocus(currentTabIndex, targetTabIndex);
            } else {
                this.tabManager.removeTab(currentTabIndex);
            }

            setTimeout(() => {
                if (!this.mainWindow.isDestroyed() && this.mainWindow.isVisible()) {
                    this.mainWindow.focus();
                    this.mainWindow.show();
                    const activeTab = this.tabManager.tabMap.get(this.tabManager.activeTabIndex);
                    if (activeTab?.webContents) activeTab.webContents.focus();
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
                try { title = new URL(url).hostname; } catch {}
                this.tabManager.createLazyTab(url, title, false);
            } else {
                this.tabManager.createTab();
            }
        });

        // Next / previous tab
        this.registerShortcut('CmdOrCtrl+Tab', () => this.switchToNextTab());
        this.registerShortcut('CmdOrCtrl+Shift+Tab', () => this.switchToPreviousTab());

        // Ctrl+PageDown/Up for tab cycling (Windows/Linux standard)
        if (process.platform !== 'darwin') {
            this.registerShortcut('Ctrl+PageDown', () => this.switchToNextTab());
            this.registerShortcut('Ctrl+PageUp',   () => this.switchToPreviousTab());
        }

        // Switch to tab 1-8 by position; 9 always goes to the last tab (Chrome convention)
        for (let i = 1; i <= 8; i++) {
            const n = i;
            this.registerShortcut(`CmdOrCtrl+${n}`, () => this.switchToTabByNumber(n));
        }
        this.registerShortcut('CmdOrCtrl+9', () => {
            const tabIndexes = Array.from(this.tabManager.tabMap.keys()).sort((a, b) => a - b);
            if (tabIndexes.length > 0) this.tabManager.showTab(tabIndexes[tabIndexes.length - 1]);
        });

        // Pin / unpin active tab — Ctrl+Shift+L (moved to free up Shift+P for private tab)
        this.registerShortcut('CmdOrCtrl+Shift+L', () => {
            this.tabManager.pinTab(this.tabManager.activeTabIndex);
        });
    }

    // ── Navigation shortcuts ───────────────────────────────────────────────────

    registerNavigationShortcuts() {
        // Back — Cmd/Ctrl+Left (primary) + Alt+Left + Cmd+[ (macOS)
        this.registerShortcut('CmdOrCtrl+Left', () => {
            this.tabManager.goBack(this.tabManager.activeTabIndex);
        });
        this.registerShortcut('Alt+Left', () => {
            this.tabManager.goBack(this.tabManager.activeTabIndex);
        });
        if (process.platform === 'darwin') {
            this.registerShortcut('Cmd+[', () => {
                this.tabManager.goBack(this.tabManager.activeTabIndex);
            });
        }

        // Forward — Cmd/Ctrl+Right (primary) + Alt+Right + Cmd+] (macOS)
        this.registerShortcut('CmdOrCtrl+Right', () => {
            this.tabManager.goForward(this.tabManager.activeTabIndex);
        });
        this.registerShortcut('Alt+Right', () => {
            this.tabManager.goForward(this.tabManager.activeTabIndex);
        });
        if (process.platform === 'darwin') {
            this.registerShortcut('Cmd+]', () => {
                this.tabManager.goForward(this.tabManager.activeTabIndex);
            });
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
            if (tab) tab.webContents.reloadIgnoringCache();
        });

        // Stop loading — only intercepts when the page is actually loading;
        // returns false otherwise so Escape reaches the web page normally.
        this.registerShortcut('Escape', () => {
            if (this.tabManager?.isHtmlFullScreen) return false;
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
            this.mainWindow.webContents.executeJavaScript(
                'try { const el = document.getElementById("searchBar"); if (el) { el.focus(); el.select(); } } catch {}'
            ).catch(() => {});
        };

        this.registerShortcut('CmdOrCtrl+K', focusBar);
        this.registerShortcut('CmdOrCtrl+L', focusBar);
        this.registerShortcut('F6',           focusBar);
        this.registerShortcut('Alt+D',        focusBar); // Windows / Edge convention
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

        // Print
        this.registerShortcut('CmdOrCtrl+P', () => {
            const tab = this.activeTab();
            if (tab) tab.webContents.print();
        });

        // Save page as
        this.registerShortcut('CmdOrCtrl+S', () => {
            const tab = this.activeTab();
            if (tab) {
                const url = tab.webContents.getURL();
                if (url && url.startsWith('http')) tab.webContents.downloadURL(url);
            }
        });

        // Undo / Redo
        this.registerShortcut('CmdOrCtrl+Z', () => {
            const tab = this.activeTab();
            if (tab?.webContents.isFocused())         tab.webContents.undo();
            else if (this.mainWindow.webContents.isFocused()) this.mainWindow.webContents.undo();
        });

        if (process.platform === 'darwin') {
            this.registerShortcut('CmdOrCtrl+Shift+Z', () => {
                const tab = this.activeTab();
                if (tab?.webContents.isFocused())         tab.webContents.redo();
                else if (this.mainWindow.webContents.isFocused()) this.mainWindow.webContents.redo();
            });
        } else {
            this.registerShortcut('CmdOrCtrl+Y', () => {
                const tab = this.activeTab();
                if (tab?.webContents.isFocused())         tab.webContents.redo();
                else if (this.mainWindow.webContents.isFocused()) this.mainWindow.webContents.redo();
            });
        }

        // Zoom
        this.registerShortcut('CmdOrCtrl+Plus',  () => this.zoomIn());
        this.registerShortcut('CmdOrCtrl+-',     () => this.zoomOut());
        this.registerShortcut('CmdOrCtrl+0',     () => this.resetZoom());
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
        } else {
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

        // Toggle focus mode
        this.registerShortcut('CmdOrCtrl+Shift+F', () => {
            const wd = this.getWindowData();
            if (wd) focusMode.toggle(wd);
        });

        // Reader view — Cmd/Ctrl+Alt+R (Firefox convention)
        this.registerShortcut('CmdOrCtrl+Alt+R', () => {
            if (this.tabManager) this.tabManager.toggleReader(this.tabManager.activeTabIndex);
        });

        // Picture-in-Picture — Cmd/Ctrl+Alt+P
        this.registerShortcut('CmdOrCtrl+Alt+P', () => {
            if (this.tabManager) this.tabManager.togglePictureInPicture(this.tabManager.activeTabIndex);
        });
    }

    // ── Window shortcuts ───────────────────────────────────────────────────────

    registerWindowShortcuts() {
        // Minimize
        this.registerShortcut('CmdOrCtrl+M', () => {
            if (!this.mainWindow.isDestroyed()) this.mainWindow.minimize();
        });

        // Fullscreen — F11 (all platforms) + Ctrl+Cmd+F (macOS native shortcut)
        this.registerShortcut('F11', () => this.toggleFullScreen());
        if (process.platform === 'darwin') {
            this.registerShortcut('Ctrl+Cmd+F', () => this.toggleFullScreen());
        }

        // Close window
        this.registerShortcut('CmdOrCtrl+Shift+W', () => {
            if (this.tabManager) this.tabManager.allowClose = true;
            if (!this.mainWindow.isDestroyed()) this.mainWindow.close();
        });
    }

    // ── Developer shortcuts ────────────────────────────────────────────────────

    registerDeveloperShortcuts() {
        this.registerShortcut('F12', () => {
            const tab = this.activeTab();
            if (tab) tab.webContents.toggleDevTools();
        });

        this.registerShortcut('CmdOrCtrl+Shift+I', () => {
            const tab = this.activeTab();
            if (tab) tab.webContents.toggleDevTools();
        });

        // Renderer devtools (for debugging the chrome UI itself)
        this.registerShortcut('CmdOrCtrl+Shift+J', () => {
            this.mainWindow.webContents.toggleDevTools();
        });
    }

    // ── Application shortcuts ──────────────────────────────────────────────────

    registerApplicationShortcuts() {
        // Quit
        this.registerShortcut('CmdOrCtrl+Q', () => {
            if (this.windowManager) {
                this.windowManager.getAllWindows().forEach(wd => {
                    if (wd.tabs) wd.tabs.allowClose = true;
                });
            }
            app.quit();
        });

        // Close all windows (keep app running — macOS style)
        this.registerShortcut('CmdOrCtrl+Shift+Q', () => {
            if (this.windowManager) {
                this.windowManager.getAllWindows().forEach(wd => {
                    if (wd.tabs) wd.tabs.allowClose = true;
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
            if      (key === 'tab'      && input.key === 'Tab')        keyMatches = true;
            else if (key === 'left'     && input.key === 'ArrowLeft')  keyMatches = true;
            else if (key === 'right'    && input.key === 'ArrowRight') keyMatches = true;
            else if (key === 'up'       && input.key === 'ArrowUp')    keyMatches = true;
            else if (key === 'down'     && input.key === 'ArrowDown')  keyMatches = true;
            else if (key === 'pageup'   && input.key === 'PageUp')     keyMatches = true;
            else if (key === 'pagedown' && input.key === 'PageDown')   keyMatches = true;
            else if (key === 'plus'     && (input.key === '+' || input.key === '=')) keyMatches = true;
            else if (key === 'minus'    && (input.key === '-' || input.key === '_')) keyMatches = true;
            else if (key === 'space'    && input.key === ' ')          keyMatches = true;
            else if (key === 'return'   && input.key === 'Enter')      keyMatches = true;
            else if (key === 'enter'    && input.key === 'Enter')      keyMatches = true;
            else if (key === 'delete'   && input.key === 'Delete')     keyMatches = true;
            else if (key.match(/^[0-9]$/) && input.key === key)        keyMatches = true;
        }
        if (!keyMatches) return false;

        // Modifier matching
        // CmdOrCtrl → Cmd on macOS, Ctrl on Windows/Linux
        // Ctrl / Cmd → explicit, platform-independent
        const platform = process.platform;
        const hasCmdOrCtrl = modifiers.includes('cmdorctrl');
        const hasCtrl      = modifiers.includes('ctrl');
        const hasCmd       = modifiers.includes('cmd');
        const hasShift     = modifiers.includes('shift');
        const hasAlt       = modifiers.includes('alt');

        const wantsMeta  = (hasCmdOrCtrl && platform === 'darwin') || hasCmd;
        const wantsCtrl  = (hasCmdOrCtrl && platform !== 'darwin') || hasCtrl;

        const shiftOk = hasShift
            ? input.shift === true
            : (
                input.shift === false ||
                (key === 'plus' && (input.key === '+' || input.key === '=')) ||
                (key === 'minus' && input.key === '_')
            );

        return (
            (wantsMeta ? input.meta    === true : input.meta    === false) &&
            (wantsCtrl ? input.control === true : input.control === false) &&
            shiftOk &&
            (hasAlt    ? input.alt     === true : input.alt     === false)
        );
    }

    // ── Tab cycling helpers ────────────────────────────────────────────────────

    switchToNextTab() {
        const indexes = this._orderedTabIndexes();
        const current = indexes.indexOf(this.tabManager.activeTabIndex);
        if (current !== -1) this.tabManager.showTab(indexes[(current + 1) % indexes.length]);
    }

    switchToPreviousTab() {
        const indexes = this._orderedTabIndexes();
        const current = indexes.indexOf(this.tabManager.activeTabIndex);
        if (current !== -1) this.tabManager.showTab(indexes[(current - 1 + indexes.length) % indexes.length]);
    }

    switchToTabByNumber(number) {
        const indexes = this._orderedTabIndexes();
        if (number >= 1 && number <= indexes.length) this.tabManager.showTab(indexes[number - 1]);
    }

    _orderedTabIndexes() {
        return Array.from(this.tabManager.tabMap.keys()).sort((a, b) => a - b)
            .filter(i => this.tabManager.tabUrls.has(i));
    }

    // ── Zoom helpers ───────────────────────────────────────────────────────────

    zoomIn() {
        const tab = this.activeTab();
        if (tab) tab.webContents.setZoomLevel(tab.webContents.getZoomLevel() + 0.5);
    }

    zoomOut() {
        const tab = this.activeTab();
        if (tab) tab.webContents.setZoomLevel(tab.webContents.getZoomLevel() - 0.5);
    }

    resetZoom() {
        const tab = this.activeTab();
        if (tab) tab.webContents.setZoomLevel(0);
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
