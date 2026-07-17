import { contextBridge, ipcRenderer } from 'electron';
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

contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  windowClick: (pos) => ipcRenderer.send("window-click", pos),
  addTab: () => ipcRenderer.invoke("addTab"),
  addPrivateTab: () => ipcRenderer.invoke("addPrivateTab"),
  newWindow: () => ipcRenderer.invoke("newWindow"),
  newPrivateWindow: () => ipcRenderer.invoke("newPrivateWindow"),
  openHistoryTab: () => ipcRenderer.invoke("open-history-tab"),
  openBookmarksTab: () => ipcRenderer.invoke("open-bookmarks-tab"),
  openSettingsTab: () => ipcRenderer.invoke("open-settings-tab"),
  closeMenu: () => ipcRenderer.invoke("close-menu"),
  toggleBookmarkBar: () => ipcRenderer.send("toggle-bookmark-bar"),
  getSettings: () => ipcRenderer.invoke("settings-get"),
  find:  () => ipcRenderer.invoke("menu-find"),
  print: () => ipcRenderer.invoke("menu-print"),
  zoom:  (dir) => ipcRenderer.invoke("menu-zoom", dir),
});

// Expose persistence controls to the menu renderer
contextBridge.exposeInMainWorld('persist', {
  getMode: () => ipcRenderer.invoke('getPersistMode'),
  setMode: (enabled) => ipcRenderer.invoke('setPersistMode', enabled),
});
