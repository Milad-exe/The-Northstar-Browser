'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Match the browser's active theme.
try {
    const s = ipcRenderer.sendSync('settings-get-sync');
    const theme = (s && s.theme) || 'default';
    const apply = () => document.documentElement.setAttribute('data-theme', theme);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply);
    else apply();
} catch {}

contextBridge.exposeInMainWorld('miniPlayerApi', {
    action:  (act, value) => ipcRenderer.invoke('mp-action', act, value),
    onState: (fn)  => ipcRenderer.on('mp-state', (_e, s) => fn(s)),
});
