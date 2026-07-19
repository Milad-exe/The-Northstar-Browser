const { contextBridge, ipcRenderer } = require('electron');
// Theme bootstrapping — same boilerplate as every overlay preload.
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
// Preload for the Extensions panel WebContentsView
contextBridge.exposeInMainWorld('extPanel', {
    list: () => ipcRenderer.invoke('extensions-list'),
    setEnabled: (id, enabled) => ipcRenderer.invoke('extensions-set-enabled', id, enabled),
    remove: (id) => ipcRenderer.invoke('extensions-remove', id),
    openOptions: (id) => ipcRenderer.invoke('extensions-open-options', id),
    openStore: () => ipcRenderer.invoke('extensions-open-store'),
    setPinned: (id, pinned) => ipcRenderer.invoke('extensions-set-pinned', id, pinned),
    activate: (id) => ipcRenderer.invoke('extensions-activate', id),
    close: () => ipcRenderer.invoke('extensions-panel-close'),
    onData: (callback) => ipcRenderer.on('extensions-data', (_e, items) => callback(items)),
});
