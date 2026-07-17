/**
 * IPC handlers — extension management (Settings page).
 *
 * Browser-action buttons/popups are handled by the <browser-action-list>
 * element (electron-chrome-extensions), not here.
 */

import { dialog } from 'electron';
import extensions from '../features/extensions';
const WEB_STORE_URL = 'https://chromewebstore.google.com/';

function register(ipcMain, { wm }) {

    extensions.onChanged(() => {
        for (const wd of wm.getAllWindows()) {
            try { wd.window.webContents.send('extensions-changed'); } catch {}
        }
    });

    ipcMain.handle('extensions-list', () => extensions.list());

    ipcMain.handle('extensions-remove', (_e, id) => extensions.remove(id));
    ipcMain.handle('extensions-set-enabled', (_e, id, enabled) => extensions.setEnabled(id, enabled));
    ipcMain.handle('extensions-open-options', (_e, id) => extensions.openOptions(id));

    // Install by Chrome Web Store ID or URL.
    ipcMain.handle('extensions-install-id', async (_e, idOrUrl) => {
        try {
            const info = await extensions.installById(idOrUrl);
            return { ok: true, ...info };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    // mode: 'unpacked' (folder) | 'crx' (file)
    ipcMain.handle('extensions-add', async (_e, mode) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        const parent = wd?.window;
        const opts = mode === 'crx'
            ? { title: 'Select extension (.crx)', properties: ['openFile'], filters: [{ name: 'Chrome Extension', extensions: ['crx', 'zip'] }] }
            : { title: 'Select unpacked extension folder', properties: ['openDirectory'] };
        try {
            const res = parent ? await dialog.showOpenDialog(parent, opts as any) : await dialog.showOpenDialog(opts as any);
            if (res.canceled || !res.filePaths?.length) return { canceled: true };
            const info = mode === 'crx'
                ? await extensions.installCrx(res.filePaths[0])
                : await extensions.installUnpacked(res.filePaths[0]);
            return { ok: true, ...info };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    // Open the Chrome Web Store in a new tab (its "Add to Chrome" button works).
    ipcMain.handle('extensions-open-store', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd?.tabs) wd.tabs.createLazyTab(WEB_STORE_URL, 'Chrome Web Store', false, false, true, true);
        return true;
    });
}

export { register };