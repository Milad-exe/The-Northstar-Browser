/**
 * chrome.identity — OAuth for extensions.
 *
 * launchWebAuthFlow is the part that matters and the part we can do honestly:
 * open the provider's authorization page in a real window and watch for the
 * navigation to the extension's redirect URL, handing back the full URL so the
 * extension can pull the code or token out of it. That is exactly Chrome's
 * contract, so extensions using the standard flow work unchanged.
 *
 * getAuthToken is NOT implemented, and deliberately not faked. It mints a Google
 * token from the browser's own signed-in account via `oauth2.client_id` in the
 * manifest — there is no signed-in browser account here to mint one from, and
 * returning a bogus token would fail deep inside the extension with a confusing
 * error. It rejects with a message naming launchWebAuthFlow instead.
 */
'use strict';
const log = require('./log');
const { BrowserWindow } = require('electron');

const WINDOW_W = 480;
const WINDOW_H = 640;

/** Chrome's redirect URL shape: https://<extension-id>.chromiumapp.org/<path> */
function redirectUrlFor(extensionId, suffix = '') {
    return `https://${extensionId}.chromiumapp.org/${String(suffix || '').replace(/^\/+/, '')}`;
}

/**
 * Open `url`, wait for a navigation to the chromiumapp.org redirect, resolve
 * with that URL. Rejects if the user closes the window first, matching Chrome's
 * "The user did not approve access." behaviour.
 */
function launchWebAuthFlow(extensionId, { url, interactive = true } = {}, parentWindow, session) {
    if (!url)
        return Promise.reject(new Error('url is required'));
    // Sign-in pages are web pages. A file:, data: or javascript: URL here would
    // open local files or run script in a window carrying the space's session.
    let protocol = '';
    try { protocol = new URL(String(url)).protocol; }
    catch { return Promise.reject(new Error('url is not a valid URL')); }
    if (protocol !== 'https:' && protocol !== 'http:')
        return Promise.reject(new Error('url must be an http(s) URL'));
    // A non-interactive flow is meant to complete silently against existing
    // cookies. We have no way to run it headless without showing the window, so
    // report the same failure Chrome gives when silent auth cannot complete.
    if (!interactive)
        return Promise.reject(new Error('User interaction required.'));

    const redirectPrefix = `https://${extensionId}.chromiumapp.org/`;
    return new Promise((resolve, reject) => {
        const win = new BrowserWindow({
            width: WINDOW_W,
            height: WINDOW_H,
            parent: parentWindow || undefined,
            modal: !!parentWindow,
            autoHideMenuBar: true,
            title: 'Sign in',
            webPreferences: {
                ...(session ? { session } : {}),
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
            },
        });
        let settled = false;
        const finish = (fn, arg) => {
            if (settled)
                return;
            settled = true;
            try { win.destroy(); }
            catch (e) { log.debug('ext-identity', 'finish', e); }
            fn(arg);
        };
        // The redirect target does not resolve, so the navigation to it may fail
        // rather than commit — both paths have to be watched.
        const check = (candidate) => {
            if (typeof candidate === 'string' && candidate.startsWith(redirectPrefix))
                finish(resolve, candidate);
        };
        win.webContents.on('will-redirect', (_e, u) => check(u));
        win.webContents.on('will-navigate', (_e, u) => check(u));
        win.webContents.on('did-start-navigation', (_e, u) => check(u));
        win.webContents.on('did-fail-load', (_e, _code, _desc, u) => check(u));
        win.on('closed', () => {
            if (!settled) {
                settled = true;
                reject(new Error('The user did not approve access.'));
            }
        });
        win.loadURL(url).catch(() => { /* the redirect itself often fails to load */ });
    });
}

module.exports = { launchWebAuthFlow, redirectUrlFor };
