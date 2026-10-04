/**
 * Preload for the theme popup.
 *
 * SANDBOXED, like every overlay preload: it can require('electron') and
 * nothing else — no relative modules, no node built-ins (CLAUDE.md invariant
 * 13). That is why the theme bridge is written out here rather than shared
 * with preload/settings-preload.js, and why the theme's own CSS arrives
 * through insertCSS from the main process instead of being applied here.
 */
const { contextBridge, ipcRenderer } = require('electron');

// Keep the panel wearing the theme it is editing.
ipcRenderer.on('theme-changed', (_e, theme) => {
    if (theme && theme !== 'default')
        document.documentElement.setAttribute('data-theme', theme);
    else
        document.documentElement.removeAttribute('data-theme');
});

contextBridge.exposeInMainWorld('northstarThemes', {
    list: () => ipcRenderer.invoke('themes-list'),
    preview: (seed) => ipcRenderer.invoke('theme-preview', seed),
    // Paint a seed on screen without saving it — what a drag uses.
    live: (seed) => ipcRenderer.invoke('theme-live', seed),
    save: (theme) => ipcRenderer.invoke('theme-save', theme),
    remove: (id) => ipcRenderer.invoke('theme-delete', id),
    onChanged: (fn) => ipcRenderer.on('themes-changed', () => fn()),
});

contextBridge.exposeInMainWorld('northstarSettings', {
    set: (key, val) => ipcRenderer.invoke('settings-set', key, val),
    get: () => ipcRenderer.invoke('settings-get'),
});

contextBridge.exposeInMainWorld('overlayThemePanel', {
    close: () => ipcRenderer.invoke('theme-panel-close'),
    // Which theme this panel edits: { scope: <space id> | null }.
    context: () => ipcRenderer.invoke('theme-panel-context'),
    onScope: (fn) => ipcRenderer.on('theme-panel-scope', (_e, scope) => fn(scope)),
});

contextBridge.exposeInMainWorld('northstarProfiles', {
    list: () => ipcRenderer.invoke('profiles:list'),
    update: (id, patch) => ipcRenderer.invoke('profiles:update', id, patch),
});
// Overlay enter/exit motion (P1-6). Main signals a show (overlay:enter) and a
// close (overlay:leave); the page fades, then acks overlay:leave-done so main
// hides the view. Sandboxed-safe: electron IPC only.
contextBridge.exposeInMainWorld('overlayAnim', {
    onEnter: (fn) => ipcRenderer.on('overlay:enter', () => fn()),
    onLeave: (fn) => ipcRenderer.on('overlay:leave', () => fn()),
    leaveDone: () => { try { ipcRenderer.send('overlay:leave-done'); } catch (e) { /* view gone */ } },
});
