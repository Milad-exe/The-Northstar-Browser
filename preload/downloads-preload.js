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
// Preload for the Downloads panel WebContentsView
contextBridge.exposeInMainWorld('overlayDownloads', {
    getAll: () => ipcRenderer.invoke('downloads-get'),
    action: (name, id, confirmed) => ipcRenderer.invoke('downloads-action', name, id, confirmed),
    close: () => ipcRenderer.invoke('downloads-panel-close'),
    onData: (callback) => ipcRenderer.on('downloads-data', (_e, items) => callback(items)),
});
// Report the panel's own hover so the auto-close countdown pauses over it (P1-4).
// The panel is a separate WebContentsView, so the chrome cannot see the pointer
// enter it. Fires on the viewport edges of this view.
const reportHover = (hovered) => { try { ipcRenderer.send('downloads-panel-hover-report', hovered); } catch { } };
window.addEventListener('mouseover', () => reportHover(true), { passive: true });
window.addEventListener('mouseout', (e) => { if (!e.relatedTarget) reportHover(false); }, { passive: true });
// Overlay enter/exit motion (P1-6). Main signals a show (overlay:enter) and a
// close (overlay:leave); the page fades, then acks overlay:leave-done so main
// hides the view. Sandboxed-safe: electron IPC only.
contextBridge.exposeInMainWorld('overlayAnim', {
    onEnter: (fn) => ipcRenderer.on('overlay:enter', () => fn()),
    onLeave: (fn) => ipcRenderer.on('overlay:leave', () => fn()),
    leaveDone: () => { try { ipcRenderer.send('overlay:leave-done'); } catch (e) { /* view gone */ } },
});
