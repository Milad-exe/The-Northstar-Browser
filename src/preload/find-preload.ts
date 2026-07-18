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

contextBridge.exposeInMainWorld('findAPI', {
    search: (searchTerm) => ipcRenderer.invoke('find-search', searchTerm),
    findNext: () => ipcRenderer.invoke('find-next'),
    findPrevious: () => ipcRenderer.invoke('find-previous'),
    clearSearch: () => ipcRenderer.invoke('find-clear'),
    close: () => ipcRenderer.invoke('find-close'),
    
    onMatchesUpdated: (callback) => {
        ipcRenderer.on('find-matches-updated', (_e, current, total) => {
            callback(current, total);
        });
    }
});