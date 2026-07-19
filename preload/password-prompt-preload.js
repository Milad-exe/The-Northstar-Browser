const { contextBridge, ipcRenderer } = require('electron');
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
contextBridge.exposeInMainWorld('pwPrompt', {
    onData: (cb) => ipcRenderer.on('password-prompt-data', (_e, d) => cb(d)),
    save: () => ipcRenderer.invoke('passwords-save-confirmed'),
    never: () => ipcRenderer.invoke('passwords-never'),
    close: () => ipcRenderer.invoke('passwords-prompt-close'),
});
