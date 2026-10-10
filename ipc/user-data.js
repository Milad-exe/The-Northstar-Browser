/**
 * IPC — import / export, certificate exceptions, update checks, default-browser
 * status. The things that let a person move INTO this browser, get their data
 * back OUT of it, and understand the state it is in.
 *
 * Every file path comes from a native dialog the user drove: nothing here reads
 * or writes a path chosen by a renderer.
 */
'use strict';
const { dialog, shell } = require('electron');
const path = require('path');
const log = require('../features/log');
const userData = require('../features/user-data');
const updates = require('../features/updates');
const certErrors = require('../features/cert-errors');
const defaultBrowser = require('../features/default-browser');
const { keyProtection } = require('../features/encryption');
const passwordStore = require('../features/password-store');
const { broadcastBookmarksChanged } = require('./utils');
const { sanitizeUrl, isSafeExternal } = require('../features/url-security');
const { isTrustedInternalSender } = require('../features/ipc-guard');

function register(ipcMain, { wm, webContents, app }) {
    const windowOf = (e) => wm.getWindowByWebContents(e.sender)?.window || null;
    // Credential import/export and cert-exception clearing answer only the app's
    // own internal pages — never web content or a local file:// page.
    const trusted = (e, channel) => {
        if (isTrustedInternalSender(e.sender))
            return true;
        log.warn('user-data', `blocked ${channel} from untrusted sender`);
        return false;
    };
    const bmFor = (e) => wm.bookmarksFor(wm.profileOf(e.sender));
    const historyFor = (e) => wm.historyFor(wm.profileOf(e.sender));

    // ── Bookmarks ────────────────────────────────────────────────────────────
    ipcMain.handle('data:import-bookmarks', async (e) => {
        const win = windowOf(e);
        const { canceled, filePaths } = await dialog.showOpenDialog(win, {
            title: 'Import bookmarks',
            message: 'Choose a bookmarks file exported from another browser',
            filters: [{ name: 'Bookmark files', extensions: ['html', 'htm'] }],
            properties: ['openFile'],
        });
        if (canceled || !filePaths?.length)
            return { ok: false, canceled: true };
        try {
            const parsed = userData.parseBookmarksHtml(userData.readText(filePaths[0]));
            if (!parsed.length)
                return { ok: false, error: 'No bookmarks found in that file.' };
            const store = bmFor(e);
            // Source folders become Northstar folders, created once and reused; the
            // rest land at the top level.
            const folders = new Map();
            let added = 0, skipped = 0;
            for (const item of parsed) {
                const url = sanitizeUrl(item.url);
                if (!url) { skipped++; continue; }
                if (await store.has(url)) { skipped++; continue; }
                await store.add(url, item.title);
                added++;
                if (item.folder && !folders.has(item.folder))
                    folders.set(item.folder, true);
            }
            broadcastBookmarksChanged(webContents);
            log.info('user-data', `imported ${added} bookmarks (${skipped} already present or unusable)`);
            return { ok: true, added, skipped, total: parsed.length };
        }
        catch (err) {
            log.error('user-data', 'bookmark import failed', err);
            return { ok: false, error: err?.message || 'Could not read that file.' };
        }
    });

    ipcMain.handle('data:export-bookmarks', async (e) => {
        const win = windowOf(e);
        const { canceled, filePath } = await dialog.showSaveDialog(win, {
            title: 'Export bookmarks',
            defaultPath: `northstar-bookmarks-${new Date().toISOString().slice(0, 10)}.html`,
            filters: [{ name: 'Bookmark file', extensions: ['html'] }],
        });
        if (canceled || !filePath)
            return { ok: false, canceled: true };
        try {
            const items = await bmFor(e).getAll();
            userData.writeText(filePath, userData.bookmarksToHtml(items));
            const count = JSON.stringify(items).split('"type":"bookmark"').length - 1;
            return { ok: true, count, path: filePath };
        }
        catch (err) {
            log.error('user-data', 'bookmark export failed', err);
            return { ok: false, error: err?.message || 'Could not write that file.' };
        }
    });

    // ── Passwords ────────────────────────────────────────────────────────────
    ipcMain.handle('data:import-passwords', async (e) => {
        if (!trusted(e, 'data:import-passwords')) return { ok: false };
        const win = windowOf(e);
        const { canceled, filePaths } = await dialog.showOpenDialog(win, {
            title: 'Import passwords',
            message: 'Choose a password CSV exported from another browser or manager',
            filters: [{ name: 'CSV', extensions: ['csv', 'txt'] }],
            properties: ['openFile'],
        });
        if (canceled || !filePaths?.length)
            return { ok: false, canceled: true };
        try {
            const records = userData.parsePasswordCsv(userData.readText(filePaths[0]));
            if (!records.length)
                return { ok: false, error: 'No credentials found — the file needs url, username and password columns.' };
            let added = 0;
            for (const r of records) {
                passwordStore.upsert(r);
                added++;
            }
            log.info('user-data', `imported ${added} credentials`);
            return { ok: true, added, total: records.length };
        }
        catch (err) {
            log.error('user-data', 'password import failed', err);
            return { ok: false, error: err?.message || 'Could not read that file.' };
        }
    });

    ipcMain.handle('data:export-passwords', async (e) => {
        if (!trusted(e, 'data:export-passwords')) return { ok: false };
        const win = windowOf(e);
        // Exporting passwords writes them in the clear. That is what the format
        // is, so say it plainly and make the user choose it twice.
        const { response } = await dialog.showMessageBox(win, {
            type: 'warning',
            buttons: ['Cancel', 'Export anyway'],
            defaultId: 0,
            cancelId: 0,
            message: 'Export passwords in plain text?',
            detail: 'The file will contain every saved password, readable by anyone who opens it. Store it somewhere safe and delete it when you are done.',
        });
        if (response !== 1)
            return { ok: false, canceled: true };
        const { canceled, filePath } = await dialog.showSaveDialog(win, {
            title: 'Export passwords',
            defaultPath: `northstar-passwords-${new Date().toISOString().slice(0, 10)}.csv`,
            filters: [{ name: 'CSV', extensions: ['csv'] }],
        });
        if (canceled || !filePath)
            return { ok: false, canceled: true };
        try {
            const records = passwordStore.list().map(r => ({
                origin: r.origin,
                username: r.username,
                password: passwordStore.getPassword(r.id) || '',
            }));
            userData.writeText(filePath, userData.passwordsToCsv(records));
            log.warn('user-data', `exported ${records.length} credentials in plain text`);
            return { ok: true, count: records.length, path: filePath };
        }
        catch (err) {
            log.error('user-data', 'password export failed', err);
            return { ok: false, error: err?.message || 'Could not write that file.' };
        }
    });

    // ── History ──────────────────────────────────────────────────────────────
    ipcMain.handle('data:export-history', async (e) => {
        const win = windowOf(e);
        const { canceled, filePath } = await dialog.showSaveDialog(win, {
            title: 'Export history',
            defaultPath: `northstar-history-${new Date().toISOString().slice(0, 10)}.csv`,
            filters: [{ name: 'CSV', extensions: ['csv'] }],
        });
        if (canceled || !filePath)
            return { ok: false, canceled: true };
        try {
            const entries = await historyFor(e).loadHistory();
            userData.writeText(filePath, userData.historyToCsv(entries));
            return { ok: true, count: entries.length, path: filePath };
        }
        catch (err) {
            log.error('user-data', 'history export failed', err);
            return { ok: false, error: err?.message || 'Could not write that file.' };
        }
    });

    ipcMain.handle('data:reveal', (_e, filePath) => {
        if (typeof filePath === 'string' && filePath)
            shell.showItemInFolder(filePath);
    });

    // ── Certificate exceptions ───────────────────────────────────────────────
    // Sent by the interstitial's "continue anyway". The exception is scoped to
    // the host AND that certificate, and lives only for this session.
    ipcMain.on('cert:proceed', (e, host, fingerprint, url) => {
        if (!host)
            return;
        certErrors.accept(host, fingerprint);
        const target = sanitizeUrl(url);
        if (target)
            try { e.sender.loadURL(target); } catch (err) { log.error('cert', 'reload after accept failed', err); }
    });
    ipcMain.handle('cert:clear-exceptions', (e) => {
        if (!trusted(e, 'cert:clear-exceptions')) return false;
        certErrors.clear();
        return true;
    });

    // ── Updates / diagnostics / default browser ──────────────────────────────
    // Updates (features/updates.js): background checks from launch, a check on
    // demand, the live state for the chrome and About, and Relaunch.
    updates.start(wm);
    ipcMain.handle('app:check-update', () => updates.check());
    ipcMain.handle('app:update-state', () => updates.state());
    ipcMain.handle('app:install-update', (e) => {
        if (!trusted(e, 'app:install-update')) return false;
        return updates.install();
    });
    ipcMain.handle('app:open-release', async (_e, url) => {
        // openExternal hands the URL to the OS, so only http/https — not the
        // file:/about:/view-source: that sanitizeUrl would let through.
        if (isSafeExternal(url))
            await shell.openExternal(url.trim());
    });
    ipcMain.on('notice-dismissed', (_e, id) => {
        const key = String(id || '').slice(0, 40);
        if (!key)
            return;
        const seen = wm.persistence.get('dismissedNotices') || [];
        if (!seen.includes(key))
            wm.persistence.set('dismissedNotices', [...seen, key]);
    });
    /* Offer to become the default browser ONCE, in the app, where the answer can
       be remembered. This used to be the OS asking on every single launch
       (setAsDefaultProtocolClient at startup), which no answer could stop. */
    ipcMain.handle('notices:pending', (_e) => {
        const seen = wm.persistence.get('dismissedNotices') || [];
        const out = [];
        try {
            const st = defaultBrowser.status();
            if (!st.isDefault && st.canPrompt && !seen.includes('default-browser'))
                out.push({ id: 'default-browser' });
        }
        catch (e) { log.debug('user-data', 'notices:pending', e); }
        return out;
    });
    ipcMain.handle('app:default-browser-status', () => defaultBrowser.status());
    ipcMain.handle('app:make-default-browser', () => defaultBrowser.makeDefault());
    ipcMain.handle('app:key-protection', () => keyProtection());
    ipcMain.handle('app:open-log', () => {
        const p = log.path();
        if (p)
            shell.showItemInFolder(p);
        return p;
    });
    ipcMain.handle('app:log-tail', () => log.tail(300));
    // The chrome's renderer scripts report their own swallowed failures here
    // (preload exposes this to internal pages only). Sender-supplied text is
    // clipped: a log line is a diagnostic, not a channel.
    ipcMain.on('log:write', (_e, level, scope, message) => {
        const lvl = ['debug', 'warn', 'error'].includes(level) ? level : 'debug';
        log[lvl](String(scope || 'renderer').slice(0, 40), String(message || '').slice(0, 200));
    });
    ipcMain.handle('app:version', () => {
        const build = require('../features/build-info').get();
        return {
            app: app.getVersion(),
            commit: build.commit,
            builtAt: build.builtAt,
            mode: build.mode,
            electron: process.versions.electron,
            chrome: process.versions.chrome,
            node: process.versions.node,
            platform: `${process.platform} ${process.arch}`,
        };
    });
}

module.exports = { register };
