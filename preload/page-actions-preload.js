/**
 * Preload for the page-actions panel.
 *
 * SANDBOXED like every overlay preload: it can require('electron') and nothing
 * else — no relative modules, no node built-ins (CLAUDE.md invariant 13). The
 * theme arrives as injected CSS from the main process, which is why there is no
 * token bridge here.
 */
const { contextBridge, ipcRenderer } = require('electron');

ipcRenderer.on('theme-changed', (_e, theme) => {
    if (theme && theme !== 'default')
        document.documentElement.setAttribute('data-theme', theme);
    else
        document.documentElement.removeAttribute('data-theme');
});

contextBridge.exposeInMainWorld('overlayPageActions', {
    run: (action) => ipcRenderer.invoke('page-actions-run', action),
    close: () => ipcRenderer.invoke('page-actions-close'),
    onState: (fn) => ipcRenderer.on('page-actions-state', (_e, s) => fn(s)),
});
// Overlay enter/exit motion (P1-6). Main signals a show (overlay:enter) and a
// close (overlay:leave); the page fades, then acks overlay:leave-done so main
// hides the view. Sandboxed-safe: electron IPC only.
contextBridge.exposeInMainWorld('overlayAnim', {
    onEnter: (fn) => ipcRenderer.on('overlay:enter', () => fn()),
    onLeave: (fn) => ipcRenderer.on('overlay:leave', () => fn()),
    leaveDone: () => { try { ipcRenderer.send('overlay:leave-done'); } catch (e) { /* view gone */ } },
});
