/**
 * IPC handlers — password autofill + save prompt + management.
 *
 * Security: the origin a page can read/save credentials for is derived from the
 * sender's own URL, never trusted from arguments. The plaintext password from a
 * "save?" offer is held only in the main process (per window) and is never sent
 * to the prompt UI — the prompt only shows the origin and username.
 */
const log = require('../features/log');
const path = require('path');
const { resolveAppFile } = require('../app-paths');
const { WebContentsView } = require('electron');
const store = require('../features/password-store');
const { isTrustedInternalSender } = require('../features/ipc-guard');
const { panelBounds, PANEL_RADIUS, W_MD } = require('../features/overlay-bounds');
const PROMPT_W = W_MD;
const PROMPT_H = 150;
function senderOrigin(sender) {
    try {
        const u = new URL(sender.getURL());
        if (u.protocol !== 'http:' && u.protocol !== 'https:')
            return null;
        return u.origin;
    }
    catch {
        return null;
    }
}
function register(ipcMain, { wm }) {
    store.onChanged(() => {
        for (const wd of wm.getAllWindows()) {
            try {
                wd.window.webContents.send('passwords-changed');
            }
            catch (e) { log.debug('passwords', 'register', e); }
        }
    });
    // ── Autofill (called from a tab's content script) ────────────────────────
    ipcMain.handle('passwords-get-for-origin', (_e) => {
        const origin = senderOrigin(_e.sender);
        if (!origin)
            return [];
        return store.getForOrigin(origin);
    });
    // ── Save offer (on login submit) ─────────────────────────────────────────
    ipcMain.handle('passwords-offer', (_e, payload) => {
        const origin = senderOrigin(_e.sender);
        if (!origin)
            return false;
        const username = String(payload?.username || '');
        const password = String(payload?.password || '');
        if (!password)
            return false;
        const state = store.status(origin, username, password);
        if (state === 'exists' || state === 'never')
            return false;
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd)
            return false;
        wd.pendingPassword = { origin, username, password };
        showPrompt(wd, { origin, username, mode: state });
        return true;
    });
    ipcMain.handle('passwords-save-confirmed', (_e) => {
        const wd = ownerWindow(_e.sender);
        if (wd?.pendingPassword) {
            store.upsert(wd.pendingPassword);
            wd.pendingPassword = null;
        }
        closePrompt(wd);
        return true;
    });
    ipcMain.handle('passwords-never', (_e) => {
        const wd = ownerWindow(_e.sender);
        if (wd?.pendingPassword) {
            store.addNever(wd.pendingPassword.origin);
            wd.pendingPassword = null;
        }
        closePrompt(wd);
        return true;
    });
    ipcMain.handle('passwords-prompt-close', (_e) => {
        const wd = ownerWindow(_e.sender);
        if (wd) {
            wd.pendingPassword = null;
            closePrompt(wd);
        }
        return true;
    });
    ipcMain.handle('passwords-prompt-data', (_e) => {
        // Served to the prompt view: origin + username only (never the password).
        const wd = wm.getAllWindows().find(w => w.passwordPrompt?.webContents === _e.sender);
        if (!wd?.pendingPassword)
            return null;
        const { origin, username } = wd.pendingPassword;
        return { origin, username };
    });
    // ── Management (settings page) ────────────────────────────────────────────
    // These reveal/mutate stored credentials, so they answer ONLY the app's own
    // trusted internal pages — never web content, never a local file:// page.
    const deny = (channel) => log.warn('passwords', `blocked ${channel} from untrusted sender`);
    ipcMain.handle('passwords-list', (_e) => {
        if (!isTrustedInternalSender(_e.sender)) { deny('passwords-list'); return []; }
        return store.list();
    });
    ipcMain.handle('passwords-reveal', (_e, id) => {
        if (!isTrustedInternalSender(_e.sender)) { deny('passwords-reveal'); return null; }
        return store.getPassword(id);
    });
    ipcMain.handle('passwords-delete', (_e, id) => {
        if (!isTrustedInternalSender(_e.sender)) { deny('passwords-delete'); return false; }
        return store.delete(id);
    });
    // ── Prompt overlay helpers ────────────────────────────────────────────────
    function ownerWindow(sender) {
        return wm.getWindowByWebContents(sender)
            || wm.getAllWindows().find(w => w.passwordPrompt?.webContents === sender);
    }
    async function showPrompt(wd, data) {
        try {
            if (!wd.passwordPrompt) {
                const view = new WebContentsView({
                    webPreferences: {
                        preload: path.join(__dirname, '../preload/password-prompt-preload.js'),
                        contextIsolation: true, nodeIntegration: false,
                    },
                });
                view.setBackgroundColor('#00000000');
                try { view.setBorderRadius(PANEL_RADIUS) } catch (e) { log.debug('passwords', 'showPrompt', e); }
                wd.passwordPrompt = view;
                wd.window.contentView.addChildView(view);
                view.webContents.loadFile(resolveAppFile('renderer/PasswordPrompt/index.html'));
                await new Promise(res => view.webContents.once('did-finish-load', () => res()));
            }
            const b = wd.window.getContentBounds();
            wd.passwordPrompt.setBounds(panelBounds(wd.window, { width: PROMPT_W, height: PROMPT_H }));
            try {
                wd.window.contentView.removeChildView(wd.passwordPrompt);
                wd.window.contentView.addChildView(wd.passwordPrompt);
            }
            catch (e) { log.debug('passwords', 'showPrompt', e); }
            wd.passwordPrompt.setVisible(true);
            require('./popup-dismiss').arm(wd); // a press outside closes it
            wd.passwordPrompt.webContents.send('password-prompt-data', data);
        }
        catch (err) {
            console.error('password prompt:', err);
        }
    }
    function closePrompt(wd) {
        if (wd?.passwordPrompt) {
            try {
                wd.passwordPrompt.setVisible(false);
            }
            catch (e) { log.debug('passwords', 'closePrompt', e); }
        }
    }
}

module.exports = { register };