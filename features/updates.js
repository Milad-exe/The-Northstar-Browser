/**
 * Northstar — updates
 *
 * A browser that can't update itself can't ship a security fix. This works the
 * way the native browsers do: it checks GitHub Releases shortly after launch
 * and every few hours, downloads a newer version in the background, and then
 * says so — a notice in the window, a dot on the menu button, and a Relaunch
 * button on Settings › About. If you never press it, the update installs when
 * you quit, so the next launch is the new version either way.
 *
 * The mechanics are electron-updater reading the release's latest.yml, which
 * `npm run release` (scripts/dist.js --publish) uploads alongside the
 * installers. Installed self-updating needs a packaged build on a platform it
 * supports (Windows NSIS, Linux AppImage, a signed macOS app). Anywhere else —
 * a source run, an unsigned Mac, a .deb — it falls back to checking the
 * release feed and offering the release page, which is the honest version.
 *
 * Checks never run in the background when "Update automatically" is off
 * (Settings › About); the button still works.
 */
'use strict';
const { app, net, webContents } = require('electron');
const log = require('./log');

const REPO = 'Milad-exe/The-Northstar-Browser';
const FEED = `https://api.github.com/repos/${REPO}/releases/latest`;
const TIMEOUT_MS = 8000;
const FIRST_CHECK_MS = 15 * 1000;        // after launch, once the window is up
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

let wm = null;
let updater = null;
let timer = null;
/* status: idle | checking | current | downloading | ready | available | error
   ('available' = a newer release we can only point at, not install). */
let state = { status: 'idle' };

/** "v1.2.10" / "1.2.10-beta.1" → [1,2,10] (pre-release suffix ignored) */
function parseVersion(v) {
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** 1 if a > b, -1 if a < b, 0 if equal or unparseable. */
function compareVersions(a, b) {
    const x = parseVersion(a), y = parseVersion(b);
    if (!x || !y)
        return 0;
    for (let i = 0; i < 3; i++) {
        if (x[i] !== y[i])
            return x[i] > y[i] ? 1 : -1;
    }
    return 0;
}

function snapshot() {
    return { ...state, current: app.getVersion(), canInstall: canSelfUpdate(), auto: autoEnabled() };
}
function setState(next) {
    state = { ...next };
    const s = snapshot();
    for (const wc of webContents.getAllWebContents()) {
        try { wc.send('update-state', s); }
        catch (e) { log.debug('updates', 'broadcast', e); }
    }
}
function autoEnabled() {
    try { return wm?.persistence?.get('autoUpdate') !== false; }
    catch (e) { return true; }
}

/* Where electron-updater can actually replace the app. macOS refuses to apply
   an update to an unsigned app, so a Mac build only self-updates when signed
   (CSC_LINK set at build time); until then it uses the release-page path. */
function canSelfUpdate() {
    // NORTHSTAR_UPDATE_FEED: rehearse an update against a local feed (see
    // getUpdater) from a source run — the one exception to "packaged only".
    if (process.env.NORTHSTAR_UPDATE_FEED)
        return true;
    if (!app.isPackaged || process.env.NORTHSTAR_TEST)
        return false;
    if (process.platform === 'win32')
        return true;
    if (process.platform === 'linux')
        return !!process.env.APPIMAGE;
    if (process.platform === 'darwin')
        return !state.macUnsigned;
    return false;
}

function getUpdater() {
    if (updater)
        return updater;
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;          // fetch in the background, like Chrome
    autoUpdater.autoInstallOnAppQuit = true;  // never pressed Relaunch? next launch is new anyway
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    /* Rehearsal: NORTHSTAR_UPDATE_FEED=http://host/dir serves a latest.yml and
       the installer it names (electron-builder's "generic" layout), so the whole
       check → download → Relaunch flow can be tried before a real release. */
    if (process.env.NORTHSTAR_UPDATE_FEED) {
        // A source run reads its feed from a dev config file; write one into the
        // profile rather than the project.
        const cfg = require('path').join(app.getPath('userData'), 'dev-app-update.yml');
        require('fs').writeFileSync(cfg, `provider: generic
url: ${process.env.NORTHSTAR_UPDATE_FEED}
updaterCacheDirName: northstar-updater-dev
`);
        autoUpdater.forceDevUpdateConfig = true;
        autoUpdater.updateConfigPath = cfg;
    }
    autoUpdater.logger = {
        info: (m) => log.debug('updates', String(m)),
        warn: (m) => log.warn('updates', String(m)),
        error: (m) => log.warn('updates', String(m)),
        debug: (m) => log.debug('updates', String(m)),
    };
    const notes = (info) => {
        const n = info?.releaseNotes;
        if (typeof n === 'string') return n.replace(/<[^>]+>/g, '').slice(0, 2000);
        if (Array.isArray(n)) return n.map(x => x?.note || '').join('\n').replace(/<[^>]+>/g, '').slice(0, 2000);
        return '';
    };
    autoUpdater.on('checking-for-update', () => setState({ status: 'checking' }));
    autoUpdater.on('update-not-available', () => setState({ status: 'current', checkedAt: Date.now() }));
    autoUpdater.on('update-available', (info) => setState({ status: 'downloading', latest: info?.version, percent: 0, notes: notes(info) }));
    autoUpdater.on('download-progress', (p) => setState({ ...state, status: 'downloading', percent: Math.round(p?.percent || 0) }));
    autoUpdater.on('update-downloaded', (info) => {
        log.info('updates', `downloaded ${info?.version}; installs on relaunch or quit`);
        setState({ status: 'ready', latest: info?.version, notes: notes(info) });
    });
    autoUpdater.on('error', (e) => {
        const msg = e?.message || String(e);
        // An unsigned Mac app cannot apply updates; stop trying and point at
        // the release page instead.
        if (process.platform === 'darwin' && /code signature|not signed|Could not get code signature/i.test(msg))
            state.macUnsigned = true;
        log.warn('updates', 'update failed', e);
        setState({ status: 'error', error: 'The update could not be downloaded. Try again later.' });
    });
    updater = autoUpdater;
    return updater;
}

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
        const request = net.request({ url, method: 'GET' });
        request.setHeader('Accept', 'application/vnd.github+json');
        request.setHeader('User-Agent', `Northstar/${app.getVersion()}`);
        const t = setTimeout(() => {
            done(reject, new Error('update check timed out'));
            try { request.abort(); } catch (e) { log.debug('updates', 'abort', e); }
        }, TIMEOUT_MS);
        request.on('response', (response) => {
            const chunks = [];
            response.on('data', (c) => chunks.push(c));
            response.on('end', () => {
                clearTimeout(t);
                if (response.statusCode === 404) return done(reject, new Error('no releases published'));
                if (response.statusCode >= 400) return done(reject, new Error(`update feed returned ${response.statusCode}`));
                try { done(resolve, JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
                catch (e) { done(reject, e); }
            });
        });
        request.on('error', (e) => { clearTimeout(t); done(reject, e); });
        request.end();
    });
}

/* The release-page path: read the latest release and say whether it is newer. */
async function checkFeed() {
    const current = app.getVersion();
    setState({ status: 'checking' });
    try {
        const release = await fetchJson(FEED);
        const latest = String(release?.tag_name || release?.name || '').replace(/^v/i, '');
        if (!parseVersion(latest)) {
            setState({ status: 'error', error: 'Could not read the latest version.' });
            return snapshot();
        }
        const newer = compareVersions(latest, current) > 0;
        log.info('updates', `checked: running ${current}, latest ${latest}`);
        setState(newer
            ? { status: 'available', latest, url: release?.html_url || `https://github.com/${REPO}/releases`, notes: typeof release?.body === 'string' ? release.body.slice(0, 2000) : '' }
            : { status: 'current', checkedAt: Date.now() });
    }
    catch (e) {
        log.warn('updates', 'update check failed', e);
        setState({ status: 'error', error: 'Could not reach the update server. Check your connection and try again.' });
    }
    return snapshot();
}

/**
 * Check now. Self-updating builds check-and-download; others read the feed.
 * A check while a download is under way or ready is a no-op.
 */
async function check() {
    if (state.status === 'downloading' || state.status === 'ready' || state.status === 'checking')
        return snapshot();
    if (!canSelfUpdate())
        return checkFeed();
    try { await getUpdater().checkForUpdates(); }
    catch (e) {
        log.warn('updates', 'check failed', e);
        setState({ status: 'error', error: 'Could not reach the update server. Check your connection and try again.' });
    }
    return snapshot();
}

/** Relaunch into the downloaded update (silent install, then reopen). */
function install() {
    if (state.status !== 'ready' || !updater)
        return false;
    log.info('updates', `relaunching to install ${state.latest}`);
    // Let the session be saved by the normal quit path first.
    setImmediate(() => {
        try { updater.quitAndInstall(true, true); }
        catch (e) { log.error('updates', 'could not install the update', e); setState({ status: 'error', error: 'The update could not be installed.' }); }
    });
    return true;
}

/** Called once at startup: background checks while "Update automatically" is on. */
function start(windowManager) {
    wm = windowManager;
    if (timer) return;
    const tick = () => { if (autoEnabled()) check().catch((e) => log.debug('updates', 'tick', e)); };
    setTimeout(tick, FIRST_CHECK_MS);
    timer = setInterval(tick, CHECK_EVERY_MS);
    if (timer.unref) timer.unref();
}

module.exports = { start, check, install, state: snapshot, compareVersions, parseVersion, REPO };
