const { contextBridge, ipcRenderer } = require('electron');
// SANDBOXED, like every overlay preload: electron IPC only, no shared modules.
// The catalogue + theme so the prompt matches the app the instant it shows.
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
        if (document.documentElement) applyTheme();
        else document.addEventListener('DOMContentLoaded', applyTheme);
    }
}
catch (e) { }
ipcRenderer.on('theme-changed', (_e, theme) => {
    if (theme && theme !== 'default') document.documentElement.setAttribute('data-theme', theme);
    else document.documentElement.removeAttribute('data-theme');
});
// The hang prompt itself (P2-3): the host that stalled, and the two choices.
contextBridge.exposeInMainWorld('hangPrompt', {
    onData: (fn) => ipcRenderer.on('hang:data', (_e, d) => fn(d)),
    wait: () => ipcRenderer.send('hang:wait'),
    stop: () => ipcRenderer.send('hang:stop'),
});
// Overlay enter/exit motion (P1-6).
contextBridge.exposeInMainWorld('overlayAnim', {
    onEnter: (fn) => ipcRenderer.on('overlay:enter', () => fn()),
    onLeave: (fn) => ipcRenderer.on('overlay:leave', () => fn()),
    leaveDone: () => { try { ipcRenderer.send('overlay:leave-done'); } catch (e) { /* gone */ } },
});
