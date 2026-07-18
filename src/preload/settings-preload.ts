import { contextBridge, ipcRenderer } from 'electron';
// macOS frosted-glass flag (Settings runs with this preload).
try {
    if (process.platform === 'darwin') {
        const mark = () => document.documentElement.setAttribute('data-vibrancy', 'true');
        if (document.documentElement) mark();
        else document.addEventListener('DOMContentLoaded', mark);
    }
} catch (e) {}

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

contextBridge.exposeInMainWorld('northstarSettings', {
  get:          ()          => ipcRenderer.invoke('settings-get'),
  set:          (key, val)  => ipcRenderer.invoke('settings-set', key, val),
  clearHistory: ()          => ipcRenderer.invoke('settings-clear-history'),
  clearBrowsingData: (opts) => ipcRenderer.invoke('clear-browsing-data', opts),
  privacyStats: ()          => ipcRenderer.invoke('privacy-get-stats'),
  toggleBookmarkBar: ()     => ipcRenderer.send('toggle-bookmark-bar'),
  openHistoryTab:  ()       => ipcRenderer.invoke('open-history-tab'),
  openBookmarksTab: ()      => ipcRenderer.invoke('open-bookmarks-tab'),
});

contextBridge.exposeInMainWorld('northstarPasswords', {
  list:      ()   => ipcRenderer.invoke('passwords-list'),
  reveal:    (id) => ipcRenderer.invoke('passwords-reveal', id),
  remove:    (id) => ipcRenderer.invoke('passwords-delete', id),
  onChanged: (cb) => ipcRenderer.on('passwords-changed', () => cb()),
});

contextBridge.exposeInMainWorld('northstarExtensions', {
  list:       ()            => ipcRenderer.invoke('extensions-list'),
  add:        (mode)        => ipcRenderer.invoke('extensions-add', mode),
  installId:  (idOrUrl)     => ipcRenderer.invoke('extensions-install-id', idOrUrl),
  openStore:  ()            => ipcRenderer.invoke('extensions-open-store'),
  remove:     (id)          => ipcRenderer.invoke('extensions-remove', id),
  setEnabled: (id, enabled) => ipcRenderer.invoke('extensions-set-enabled', id, enabled),
  openOptions:(id)          => ipcRenderer.invoke('extensions-open-options', id),
  onChanged:  (cb)          => ipcRenderer.on('extensions-changed', () => cb()),
});

document.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  try { ipcRenderer.send('content-view-click'); } catch {}
}, true);
