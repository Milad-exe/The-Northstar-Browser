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
    // DevTools-panel extensions are listed here because there is no DevTools
    // frontend to host them; opening one shows it in the side panel.
    devtoolsPanels: () => ipcRenderer.invoke('devtools-panels-list'),
    openDevtoolsPanel: (panelId) => ipcRenderer.invoke('devtools-panel-open', panelId),
    // Rows are not a uniform height, so the panel measures itself and main
    // resizes to fit rather than guessing from a row count.
    setHeight: (h) => ipcRenderer.invoke('extensions-panel-height', h),
});
// Overlay enter/exit motion (P1-6). Main signals a show (overlay:enter) and a
// close (overlay:leave); the page fades, then acks overlay:leave-done so main
// hides the view. Sandboxed-safe: electron IPC only.
contextBridge.exposeInMainWorld('overlayAnim', {
    onEnter: (fn) => ipcRenderer.on('overlay:enter', () => fn()),
    onLeave: (fn) => ipcRenderer.on('overlay:leave', () => fn()),
    leaveDone: () => { try { ipcRenderer.send('overlay:leave-done'); } catch (e) { /* view gone */ } },
});
