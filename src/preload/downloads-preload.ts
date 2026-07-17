import { contextBridge, ipcRenderer } from 'electron';
try {
    const settings = ipcRenderer.sendSync('settings-get-sync');
    if (settings && settings.theme && settings.theme !== 'default') {
        const applyTheme = () => document.documentElement.setAttribute('data-theme', settings.theme);
        if (document.documentElement) applyTheme();
        else document.addEventListener('DOMContentLoaded', applyTheme);
    }
} catch (e) {}

ipcRenderer.on('theme-changed', (_e, theme) => {
    if (theme && theme !== 'default') {
        document.documentElement.setAttribute('data-theme', theme);
    } else {
        document.documentElement.removeAttribute('data-theme');
    }
});

// Preload for the Downloads panel WebContentsView
contextBridge.exposeInMainWorld('overlayDownloads', {
    getAll: ()           => ipcRenderer.invoke('downloads-get'),
    action: (name, id)   => ipcRenderer.invoke('downloads-action', name, id),
    close:  ()           => ipcRenderer.invoke('downloads-panel-close'),
    onData: (callback)   => ipcRenderer.on('downloads-data', (_e, items) => callback(items)),
});
