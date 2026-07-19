const { contextBridge, ipcRenderer } = require('electron');
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
// Preload for the Suggestions Overlay WebContentsView
contextBridge.exposeInMainWorld('overlaySuggestions', {
    onData: (callback) => ipcRenderer.on('suggestions-data', (_e, payload) => callback(payload)),
    close: () => ipcRenderer.invoke('suggestions-close'),
    select: (item) => ipcRenderer.invoke('suggestions-select', item),
    pointerDown: () => ipcRenderer.invoke('suggestions-pointer-down')
});
