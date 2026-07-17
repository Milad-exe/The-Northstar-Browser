'use strict';
import { contextBridge, ipcRenderer } from 'electron';
// Match the browser's active theme so the panel doesn't look out of place.
try {
    const s = ipcRenderer.sendSync('settings-get-sync');
    const theme = (s && s.theme) || 'default';
    const apply = () => document.documentElement.setAttribute('data-theme', theme);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply);
    else apply();
} catch {}

contextBridge.exposeInMainWorld('permissionUI', {
    onData:  (cb)                   => ipcRenderer.on('permission-data', (_e, data) => cb(data)),
    decide:  (id, allowed, remember, dismissed) => ipcRenderer.invoke('permission-decide', { id, allowed, remember, dismissed }),
    resize:  (height)               => ipcRenderer.invoke('permission-ui-resize', height),
});
