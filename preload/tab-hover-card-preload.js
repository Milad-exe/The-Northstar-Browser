const { contextBridge, ipcRenderer } = require('electron');
// SANDBOXED, like every overlay preload: electron IPC only, no shared modules
// (CLAUDE.md invariant 13). Theme + catalogue so the card matches the app the
// instant it shows.
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
// The card: main sends what to show; the page answers with the size it needs.
contextBridge.exposeInMainWorld('hoverCard', {
    onData: (fn) => ipcRenderer.on('hovercard:data', (_e, d) => fn(d)),
    reportSize: (s) => ipcRenderer.send('hovercard:size', s),
});
// Overlay enter/exit motion (P1-6).
contextBridge.exposeInMainWorld('overlayAnim', {
    onEnter: (fn) => ipcRenderer.on('overlay:enter', () => fn()),
    onLeave: (fn) => ipcRenderer.on('overlay:leave', () => fn()),
    leaveDone: () => { try { ipcRenderer.send('overlay:leave-done'); } catch (e) { /* gone */ } },
});
