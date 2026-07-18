import { contextBridge, ipcRenderer } from 'electron';
try {
    const settings = ipcRenderer.sendSync('settings-get-sync');
    if (settings && settings.theme && settings.theme !== 'default') {
        const apply = () => document.documentElement.setAttribute('data-theme', settings.theme);
        if (document.documentElement) apply();
        else document.addEventListener('DOMContentLoaded', apply);
    }
} catch (e) {}

ipcRenderer.on('theme-changed', (_e, theme) => {
    if (theme && theme !== 'default') document.documentElement.setAttribute('data-theme', theme);
    else document.documentElement.removeAttribute('data-theme');
});

contextBridge.exposeInMainWorld('electronAPI', {
  onInitPrompt:   (callback)       => ipcRenderer.on('init-prompt', callback),
  addBookmark:    (url, title)      => ipcRenderer.invoke('bookmarks-add', url, title),
  updateTitle:    (url, title)      => ipcRenderer.invoke('bookmarks-update-title', url, title),
  removeBookmark: (url)             => ipcRenderer.invoke('bookmarks-remove', url),
  removeById:     (id)              => ipcRenderer.invoke('bookmarks-remove-by-id', id),
  updateById:     (id, updates)     => ipcRenderer.invoke('bookmarks-update-by-id', id, updates),
  addFolder:      (title)           => ipcRenderer.invoke('bookmarks-add-folder', title),
  closePrompt:    ()                => ipcRenderer.invoke('bookmark-prompt-close'),
});
