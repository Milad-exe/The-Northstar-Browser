import { clipboard } from 'electron';
class WindowContextMenu {
    window: any;                // BrowserWindow the menu belongs to
    windowManager: any;
    contextTemplate: any[];     // Electron MenuItem template being built

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
        if (!params.selectionText) return;
        // Skip in editable fields — Cut/Copy/Paste from addEditableItems covers it
        if (params.isEditable) return;
        const windowData = this.getWindowData();
        this.contextTemplate.push(
            {
                label: 'Copy',
                role: 'copy',
                enabled: params.editFlags.canCopy,
            },
            {
                label: `Search Google for "${params.selectionText.slice(0, 40)}${params.selectionText.length > 40 ? '…' : ''}"`,
                click: () => {
                    if (!windowData) return;
                    const newIndex = windowData.tabs.createTab();
                    windowData.tabs.loadUrl(newIndex, `https://www.google.com/search?q=${encodeURIComponent(params.selectionText)}`);
                },
            },
        );
    }

    addEditableItems(params) {
        if (!params.isEditable) return;
        this.sep();
        this.contextTemplate.push(
            { label: 'Undo',       role: 'undo',      enabled: params.editFlags.canUndo },
            { label: 'Redo',       role: 'redo',      enabled: params.editFlags.canRedo },
            { type: 'separator' },
            { label: 'Cut',        role: 'cut',       enabled: params.editFlags.canCut },
            { label: 'Copy',       role: 'copy',      enabled: params.editFlags.canCopy },
            { label: 'Paste',      role: 'paste',     enabled: params.editFlags.canPaste },
            { label: 'Select All', role: 'selectAll' },
        );
    }

    addTabItems(params) {
        if (!params.isTabButton) return;

        const windowData = this.getWindowData();
        if (!windowData) return;

        // Use the right-clicked tab's index; fall back to active tab
        const tabIndex = (params.rightClickedTabIndex != null && windowData.tabs.tabMap.has(params.rightClickedTabIndex))
            ? params.rightClickedTabIndex
            : windowData.tabs.activeTabIndex;

        const isPinned = windowData.tabs.pinnedTabs.has(tabIndex);
        const isMuted = (() => {
            try { return windowData.tabs.tabMap.get(tabIndex)?.webContents?.isAudioMuted() ?? false; } catch { return false; }
        })();

        this.sep();
        this.contextTemplate.push(
            {
                label: 'New Tab',
                click: () => windowData.tabs.createTab(),
            },
            { type: 'separator' },
            {
                label: 'Reload Tab',
                click: () => windowData.tabs.reload(tabIndex),
            },
            {
                label: 'Duplicate Tab',
                click: () => {
                    const url = windowData.tabs.tabUrls.get(tabIndex);
                    if (url && url !== 'newtab') {
                        const newIndex = windowData.tabs.createTab(tabIndex);
                        windowData.tabs.loadUrl(newIndex, url);
                    } else {
                        windowData.tabs.createTab(tabIndex);
                    }
                },
            },
            {
                label: isPinned ? 'Unpin Tab' : 'Pin Tab',
                click: () => windowData.tabs.pinTab(tabIndex),
            },
            {
                label: isMuted ? 'Unmute Tab' : 'Mute Tab',
                click: () => windowData.tabs.muteTab(tabIndex),
            },
            { type: 'separator' },
            {
                label: 'Close Tab',
                click: () => windowData.tabs.removeTab(tabIndex),
            },
            {
                label: 'Close Other Tabs',
                enabled: windowData.tabs.tabMap.size > 1,
                click: () => {
                    const toClose = Array.from(windowData.tabs.tabMap.keys()).filter(i => i !== tabIndex);
                    // Switch to the right-clicked tab first so focus is preserved
                    windowData.tabs.showTab(tabIndex);
                    toClose.forEach(i => windowData.tabs.removeTab(i));
                },
            },
        );

        // Reopen last closed tab if any
        const closed = windowData.tabs.closedTabHistory;
        if (closed && closed.length > 0) {
            this.sep();
            this.contextTemplate.push({
                label: 'Reopen Closed Tab',
                click: () => {
                    const last = closed.pop();
                    if (last && last.url && last.url !== 'newtab') {
                        const newIndex = windowData.tabs.createTab();
                        windowData.tabs.loadUrl(newIndex, last.url);
                    } else {
                        windowData.tabs.createTab();
                    }
                },
            });
        }
    }

    addTabBarItems(params) {
        // Show when right-clicking on empty tab bar space (not on a tab button)
        if (params.isTabButton) return;
        if (params.targetElementId !== 'tab-bar' && params.targetAreaIsTabBar !== true) return;

        const windowData = this.getWindowData();
        if (!windowData) return;

        this.sep();
        this.contextTemplate.push(
            {
                label: 'New Tab',
                click: () => windowData.tabs.createTab(),
            },
        );

        const closed = windowData.tabs.closedTabHistory;
        if (closed && closed.length > 0) {
            this.contextTemplate.push({
                label: 'Reopen Closed Tab',
                click: () => {
                    const last = closed.pop();
                    if (last && last.url && last.url !== 'newtab') {
                        const newIndex = windowData.tabs.createTab();
                        windowData.tabs.loadUrl(newIndex, last.url);
                    } else {
                        windowData.tabs.createTab();
                    }
                },
            });
        }
    }
}

export default WindowContextMenu;