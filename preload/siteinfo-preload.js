'use strict';
const { contextBridge, ipcRenderer } = require('electron');
// Match the browser's active theme so the panel doesn't look out of place.
try {
    const s = ipcRenderer.sendSync('settings-get-sync');
    const theme = (s && s.theme) || 'default';
    const apply = () => document.documentElement.setAttribute('data-theme', theme);
    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', apply);
    else
        apply();
}
catch { }
contextBridge.exposeInMainWorld('siteInfoApi', {
    getInfo: () => ipcRenderer.invoke('site-info-current'),
    setPermission: (name, value) => ipcRenderer.invoke('site-permission-set', name, value),
    setProtection: (off) => ipcRenderer.invoke('site-protection-set', off),
    clearData: () => ipcRenderer.invoke('site-clear-data'),
    resize: (height) => ipcRenderer.invoke('site-info-resize', height),
    close: () => ipcRenderer.invoke('close-site-info'),
});
