const { contextBridge, ipcRenderer } = require('electron');
// The catalogue, so this panel's labels follow the language setting. Inlined
// rather than required from a shared module: overlay preloads are SANDBOXED
// (only the chrome window sets sandbox:false), and a sandboxed preload can
// require 'electron' and nothing else.
try {
    contextBridge.exposeInMainWorld('northstarI18n', {
        getSync: () => { try { return ipcRenderer.sendSync('i18n-sync') || {}; } catch { return {}; } },
    });
}
catch { }
try {
    const settings = ipcRenderer.sendSync('settings-get-sync');
    if (settings && settings.theme && settings.theme !== 'default') {
        const applyTheme = () => document.documentElement.setAttribute('data-theme', settings.theme);
        if (document.documentElement)
            applyTheme();
        else
            document.addEventListener('DOMContentLoaded', applyTheme);
    }
}
catch (e) { }
ipcRenderer.on('theme-changed', (_e, theme) => {
    if (theme && theme !== 'default') {
        document.documentElement.setAttribute('data-theme', theme);
    }
    else {
        document.documentElement.removeAttribute('data-theme');
    }
});
contextBridge.exposeInMainWorld("electronAPI", {
    platform: process.platform,
    windowClick: (pos) => ipcRenderer.send("window-click", pos),
    addTab: () => ipcRenderer.invoke("menu-new-tab"),
    addPrivateTab: () => ipcRenderer.invoke("addPrivateTab"),
    newWindow: () => ipcRenderer.invoke("newWindow"),
    newPrivateWindow: () => ipcRenderer.invoke("newPrivateWindow"),
    openHistoryTab: () => ipcRenderer.invoke("open-history-tab"),
    openRecentlyClosed: (rect) => ipcRenderer.invoke("recently-closed-menu", rect),
    openBookmarksTab: () => ipcRenderer.invoke("open-bookmarks-tab"),
    openSettingsTab: (section) => ipcRenderer.invoke("open-settings-tab", section),
    closeMenu: () => ipcRenderer.invoke("close-menu"),
    toggleBookmarkBar: () => ipcRenderer.send("toggle-bookmark-bar"),
    getSettings: () => ipcRenderer.invoke("settings-get"),
    find: () => ipcRenderer.invoke("menu-find"),
    print: () => ipcRenderer.invoke("menu-print"),
    savePage: () => ipcRenderer.invoke("menu-save-page"),
    zoom: (dir) => ipcRenderer.invoke("menu-zoom", dir),
    reportHeight: (h) => ipcRenderer.send("menu-report-height", h),
});
// Expose persistence controls to the menu renderer
contextBridge.exposeInMainWorld('persist', {
    getMode: () => ipcRenderer.invoke('getPersistMode'),
    setMode: (enabled) => ipcRenderer.invoke('setPersistMode', enabled),
});
