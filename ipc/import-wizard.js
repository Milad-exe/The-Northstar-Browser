'use strict';
/**
 * Import from another browser — the IPC behind Settings > Import & export.
 *
 * It used to be a frameless popup window over the browser; it is a Settings
 * page now (renderer/Settings: the browsers found on this computer, what to
 * bring over, and the result, inline). This file is the glue: list the
 * detected browsers and run an import into the sender's profile. Detection and
 * reading live in features/import.js.
 *
 * On first launch the page is opened once in a tab (main.js), the way other
 * browsers offer it — but only if there is another browser to import from.
 */
const log = require('../features/log');
const importer = require('../features/import');
const engines = require('../features/search-engines');

let _wm = null;
let _webContents = null;

// The profile the sender's window is in (Settings is a tab in a window).
function profileFor(e) {
    try { return _wm.profileOf(e.sender); } catch (err) { return '1'; }
}
function broadcast(channel, ...args) {
    try {
        for (const wc of _webContents.getAllWebContents()) { try { wc.send(channel, ...args); } catch (e) { /* window gone */ } }
    }
    catch (e) { log.debug('import-wizard', 'broadcast', e); }
}

/** Open Settings > Import & export in `wd` (first run, or a menu entry). */
function open(wd) {
    try { wd?.tabs?.openInternalPage('settings', 'import'); }
    catch (e) { log.warn('import-wizard', 'could not open the import page', e); }
}

function register(ipcMain, deps) {
    _wm = deps.wm;
    _webContents = deps.webContents;

    // The detected browsers, without any on-disk paths.
    ipcMain.handle('import-wizard:sources', () => {
        try { return importer.listSources(); }
        catch (e) { log.debug('import-wizard', 'sources', e); return []; }
    });

    // Import the chosen data types from one source into the sender's profile.
    // `types` ⊆ ['bookmarks','history','engines'].
    ipcMain.handle('import-wizard:run', async (e, id, types) => {
        const pid = profileFor(e);
        try {
            const src = importer.findSource(id);
            if (!src) return { ok: false, error: 'not-found' };
            const want = Array.isArray(types) && types.length ? types : ['bookmarks', 'history'];
            const result = { ok: true, browser: src.browser };
            if (want.includes('bookmarks')) {
                const tree = importer.getBookmarks(src);
                result.bookmarks = await _wm.bookmarksFor(pid).importTree(`Imported from ${src.browser}`, tree);
                broadcast('bookmarks-changed');
            }
            if (want.includes('history')) {
                const entries = importer.getHistory(src, 10000);
                result.history = await _wm.historyFor(pid).importEntries(entries, null);
            }
            if (want.includes('engines')) {
                let n = 0;
                for (const eng of importer.getEngines(src)) { try { engines.upsert(eng); n++; } catch (err) { log.debug('import-wizard', 'skip engine', err); } }
                result.engines = n;
                if (n) broadcast('engines-changed', engines.all());
            }
            return result;
        }
        catch (err) { log.warn('import-wizard', 'run', err); return { ok: false, error: 'read-failed' }; }
    });
}

module.exports = { register, open };
