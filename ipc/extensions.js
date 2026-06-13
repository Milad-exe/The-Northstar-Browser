'use strict';

function register(ipcMain, { extensions }) {
    ipcMain.handle('extension-install', async (_e, cwsId) => {
        try {
            const result = await extensions.installFromId(cwsId);
            return { ok: true, ...result };
        } catch (e) {
            console.error('[extension-install]', e.message);
            return { ok: false, error: e.message };
        }
    });

    ipcMain.handle('extension-is-installed', (_e, cwsId) => {
        return extensions.isInstalled(cwsId);
    });

    ipcMain.handle('extension-list', () => {
        return extensions.getAll();
    });

    ipcMain.handle('extension-uninstall', async (_e, cwsId) => {
        try {
            await extensions.uninstall(cwsId);
            return { ok: true };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });
}

module.exports = { register };
