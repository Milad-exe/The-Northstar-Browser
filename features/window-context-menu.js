const log = require('./log');
const i18n = require('./i18n');
class WindowContextMenu {
    window; // BrowserWindow the menu belongs to
    windowManager;
    contextTemplate; // Electron MenuItem template being built
    constructor(window, params, windowManager) {
        this.window = window;
        this.windowManager = windowManager;
        this.contextTemplate = [];
        this.addSelectionItems(params);
        this.addEditableItems(params);
        this.addTabItems(params);
        this.addTabBarItems(params);
    }
    getTemplate() {
        return this.contextTemplate;
    }
    sep() {
        const last = this.contextTemplate[this.contextTemplate.length - 1];
        if (last && last.type !== 'separator') {
            this.contextTemplate.push({ type: 'separator' });
        }
    }
    getWindowData() {
        return this.windowManager.getWindowByWebContents(this.window.webContents);
    }
    addSelectionItems(params) {
        if (!params.selectionText)
            return;
        // Skip in editable fields — Cut/Copy/Paste from addEditableItems covers it
        if (params.isEditable)
            return;
        const windowData = this.getWindowData();
        this.contextTemplate.push({
            label: 'Copy',
            role: 'copy',
            enabled: params.editFlags.canCopy,
        }, {
            label: `Search Google for "${params.selectionText.slice(0, 40)}${params.selectionText.length > 40 ? '…' : ''}"`,
            click: () => {
                if (!windowData)
                    return;
                const newIndex = windowData.tabs.createTab();
                windowData.tabs.loadUrl(newIndex, `https://www.google.com/search?q=${encodeURIComponent(params.selectionText)}`);
            },
        });
    }
    addEditableItems(params) {
        if (!params.isEditable)
            return;
        this.sep();
        this.contextTemplate.push({ label: 'Undo', role: 'undo', enabled: params.editFlags.canUndo }, { label: 'Redo', role: 'redo', enabled: params.editFlags.canRedo }, { type: 'separator' }, { label: 'Cut', role: 'cut', enabled: params.editFlags.canCut }, { label: 'Copy', role: 'copy', enabled: params.editFlags.canCopy }, { label: 'Paste', role: 'paste', enabled: params.editFlags.canPaste }, { label: 'Select All', role: 'selectAll' });
    }
    addTabItems(params) {
        if (!params.isTabButton)
            return;
        const windowData = this.getWindowData();
        if (!windowData)
            return;
        // Use the right-clicked tab's index; fall back to active tab
        const tabIndex = (params.rightClickedTabIndex != null && windowData.tabs.tabMap.has(params.rightClickedTabIndex))
            ? params.rightClickedTabIndex
            : windowData.tabs.activeTabIndex;
        const isPinned = windowData.tabs.pinnedTabs.has(tabIndex);
        const isMuted = (() => {
            try {
                return windowData.tabs.tabMap.get(tabIndex)?.webContents?.isAudioMuted() ?? false;
            }
            catch {
                return false;
            }
        })();
        this.sep();
        this.contextTemplate.push({
            label: i18n.t('chrome.newTab'),
            click: () => { windowData?.tabs?.openInternalPage('home'); },
        }, { type: 'separator' }, {
            label: 'Reload Tab',
            click: () => windowData.tabs.reload(tabIndex),
        }, {
            label: 'Duplicate Tab',
            click: () => windowData.tabs.duplicateTab(tabIndex),
        });
        // Split view: pair the right-clicked tab with the active one.
        if (windowData.tabs.isSplit()) {
            this.contextTemplate.push({ label: 'Close Split View', click: () => windowData.tabs.closeSplit() });
        }
        else if (tabIndex !== windowData.tabs.activeTabIndex && windowData.tabs.tabMap.size > 1) {
            this.contextTemplate.push({ label: 'Split With Active Tab', click: () => windowData.tabs.splitWithActive(tabIndex) });
        }
        // Folders: move this tab into / out of a tab folder (tab groups).
        {
            const t = windowData.tabs;
            const curFolder = t.tabFolders.get(tabIndex) || null;
            if (!t.pinnedTabs.has(tabIndex)) {
                if (curFolder) {
                    this.contextTemplate.push({ label: 'Remove from Folder', click: () => t.setTabFolder(tabIndex, null) });
                }
                else {
                    const wsFolders = t.foldersForWorkspace(t.profileId);
                    if (wsFolders.length)
                        this.contextTemplate.push({ label: 'Add to Folder', submenu: wsFolders.map(f => ({ label: f.name || 'Folder', click: () => t.setTabFolder(tabIndex, f.id) })) });
                }
            }
        }
        // Pin this site into the sidebar's Essentials grid (per profile; a
        // profile tab's essential keeps its profile).
        {
            const u = windowData.tabs.tabUrls.get(tabIndex);
            if (/^https?:/i.test(u || '')) {
                this.contextTemplate.push({
                    label: 'Add to Essentials',
                    click: () => {
                        const profiles = require('./profiles');
                        let title = u;
                        try { title = new URL(u).hostname.replace(/^www\./, ''); }
                        catch (e) { log.debug('window-context-menu', 'isMuted', e); }
                        profiles.addEssential(windowData.tabs.profileId || '1', {
                            url: u, title,
                            profile: windowData.tabs.tabContainers.get(tabIndex) || null,
                        });
                        /* Promote THIS tab into the tile rather than leaving both:
                           the strip hides a row a tile owns, so without the
                           binding you got a tile that opens a second copy and an
                           original row still sitting in the strip. */
                        try {
                            windowData.tabs.bindEssentialTab?.(
                                `${u}|${windowData.tabs.tabContainers.get(tabIndex) || ''}`, tabIndex);
                        }
                        catch (e) { log.debug('window-context-menu', 'bindEssentialTab', e); }
                        try { windowData.window.webContents.send('essentials-changed'); }
                        catch (e) { log.debug('window-context-menu', 'isMuted', e); }
                    },
                });
            }
        }
        // No profile naming prompt: Space Profiles decide which cookie jar a tab
        // uses, so per-tab containers are an implementation detail now.
        this.contextTemplate.push({
            label: isPinned ? 'Unpin Tab' : 'Pin Tab',
            click: () => windowData.tabs.pinTab(tabIndex),
        }, {
            label: isMuted ? 'Unmute Tab' : 'Mute Tab',
            click: () => windowData.tabs.muteTab(tabIndex),
        }, { type: 'separator' }, {
            label: 'Close Tab',
            click: () => windowData.tabs.removeTab(tabIndex),
        }, {
            label: 'Close Other Tabs',
            enabled: windowData.tabs.tabMap.size > 1,
            click: () => {
                const toClose = Array.from(windowData.tabs.tabMap.keys()).filter(i => i !== tabIndex);
                // Switch to the right-clicked tab first so focus is preserved
                windowData.tabs.showTab(tabIndex);
                toClose.forEach(i => windowData.tabs.removeTab(i));
            },
        });
        // Reopen last closed tab if any
        const closed = windowData.tabs.closedTabHistory;
        if (closed && closed.length > 0) {
            this.sep();
            this.contextTemplate.push({
                label: 'Reopen Closed Tab',
                click: () => {
                    const last = closed.pop();
                    // Nothing to reopen means nothing happens — a blank tab is
                    // not what "Reopen Closed Tab" promises, and this browser
                    // has none to open.
                    if (last && last.url && last.url !== 'newtab') {
                        const newIndex = windowData.tabs.createTab();
                        windowData.tabs.loadUrl(newIndex, last.url);
                    }
                },
            });
        }
    }
    addTabBarItems(params) {
        // Show when right-clicking on empty tab bar space (not on a tab button)
        if (params.isTabButton)
            return;
        if (params.targetElementId !== 'tab-bar' && params.targetAreaIsTabBar !== true)
            return;
        const windowData = this.getWindowData();
        if (!windowData)
            return;
        this.sep();
        this.contextTemplate.push({
            label: i18n.t('chrome.newTab'),
            click: () => { windowData?.tabs?.openInternalPage('home'); },
        });
        const closed = windowData.tabs.closedTabHistory;
        if (closed && closed.length > 0) {
            this.contextTemplate.push({
                label: 'Reopen Closed Tab',
                click: () => {
                    const last = closed.pop();
                    // Nothing to reopen means nothing happens — a blank tab is
                    // not what "Reopen Closed Tab" promises, and this browser
                    // has none to open.
                    if (last && last.url && last.url !== 'newtab') {
                        const newIndex = windowData.tabs.createTab();
                        windowData.tabs.loadUrl(newIndex, last.url);
                    }
                },
            });
        }
    }
}

module.exports = WindowContextMenu;