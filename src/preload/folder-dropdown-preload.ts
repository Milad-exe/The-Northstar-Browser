import { contextBridge, ipcRenderer } from 'electron';
try {
    const settings = ipcRenderer.sendSync('settings-get-sync');
    if (settings && settings.theme && settings.theme !== 'default') {
        const apply = () => document.documentElement.setAttribute('data-theme', settings.theme);
        if (document.documentElement) apply();
        else document.addEventListener('DOMContentLoaded', apply);
    }
} catch {}

ipcRenderer.on('theme-changed', (_e, theme) => {
    if (theme && theme !== 'default') document.documentElement.setAttribute('data-theme', theme);
    else document.documentElement.removeAttribute('data-theme');
});

contextBridge.exposeInMainWorld('folderDropdown', {
    onInit:           (cb) => ipcRenderer.on('folder-dropdown-init',           (_e, data) => cb(data)),
    onRefreshPanel:   (cb) => ipcRenderer.on('folder-dropdown-refresh-panel',  (_e, data) => cb(data)),
    onStartRename:    (cb) => ipcRenderer.on('folder-dropdown-start-rename',   (_e, data) => cb(data)),
    navigate:         (url)              => ipcRenderer.send('folder-dropdown-navigate', url),
    openNewTab:       (url)              => ipcRenderer.send('folder-dropdown-new-tab', url),
    close:            ()                 => ipcRenderer.send('folder-dropdown-close'),
    showCtxMenu:      (item)             => ipcRenderer.send('folder-dropdown-ctx-menu', item),
    updateBounds:     (w, h)             => ipcRenderer.send('folder-dropdown-update-bounds', w, h),
    raise:            ()                 => ipcRenderer.send('folder-dropdown-raise'),
    dragStart:        (id, folderId)     => ipcRenderer.send('folder-dropdown-drag-start', id, folderId),
    dragEnd:          ()                 => ipcRenderer.send('folder-dropdown-drag-end'),
    updateById:       (id, updates)      => ipcRenderer.invoke('bookmarks-update-by-id', id, updates),
    reorderInFolder:  (folderId, ids)    => ipcRenderer.invoke('bookmarks-reorder-in-folder', folderId, ids),
    moveIntoFolder:   (itemId, folderId, beforeId) => ipcRenderer.invoke('bookmarks-move-into-folder', itemId, folderId, beforeId ?? null),
    moveOutOfFolder:  (itemId, folderId) => ipcRenderer.invoke('bookmarks-move-out-of-folder', itemId, folderId, null),
});
