'use strict';
/**
 * Private tab sessions — one fully isolated in-memory session PER TAB.
 *
 * createTabSession() builds a unique, never-reused partition (no 'persist:'
 * prefix → nothing touches disk, cache disabled) with the full hardening
 * stack: UA/header privacy (setup), ad blocking, download handling, the
 * private preload scripts, and block-by-default permission prompts. Because
 * every private tab gets its own partition, cookies / storage / cache never
 * carry over to ANY other tab — private or not.
 *
 * destroyTabSession() wipes a tab's session the moment the tab closes;
 * wipeAll() is the belt-and-braces sweep on app quit.
 *
 * setup(sess) applies the network-level hardening only. Call it INSTEAD OF
 * UserAgent.setupSession — Electron allows only ONE listener per webRequest
 * event per session; registering both would silently drop whichever was first.
 */
const path = require('path');
const UserAgent = require('./user-agent');
const adBlocker = require('./ad-blocker');
const downloadManager = require('./download-manager');
const permissionPrompt = require('./permission-prompt');
function setup(sess) {
    const ua = UserAgent.generate();
    sess.setUserAgent(ua);
    // ── Single combined outbound-header handler ───────────────────────────────
    sess.webRequest.onBeforeSendHeaders((details, callback) => {
        const headers = { ...details.requestHeaders };
        // Align client-hint headers with the Chrome UA (stripping them entirely
        // contradicts the Chromium engine and trips bot detection)
        UserAgent.applyClientHintHeaders(headers);
        // Privacy signal headers
        headers['DNT'] = '1';
        headers['Sec-GPC'] = '1'; // Global Privacy Control (legally significant in CA, CO, etc.)
        headers['Accept-Language'] = 'en-US,en;q=0.9';
        // Downgrade cross-origin Referer to origin-only on sub-resources (rather
        // than deleting it — hotlink-protected image/video CDNs need the host).
        if (details.resourceType !== 'mainFrame') {
            const referer = headers['Referer'] || '';
            if (referer) {
                try {
                    const reqOrigin = new URL(details.url).origin;
                    const refOrigin = new URL(referer).origin;
                    if (refOrigin !== reqOrigin)
                        headers['Referer'] = refOrigin + '/';
                }
                catch { }
            }
        }
        callback({ requestHeaders: headers });
    });
    // ── Response-side privacy headers ─────────────────────────────────────────
    // Injecting Referrer-Policy here is the correct approach — setting Referer
    // directly in onBeforeSendHeaders is silently ignored since Electron 7.
    // Documents only: these headers govern the page's own behaviour and do
    // nothing on subresources, so skip the per-request header copy there.
    sess.webRequest.onHeadersReceived((details, callback) => {
        if (details.resourceType !== 'mainFrame' && details.resourceType !== 'subFrame') {
            return callback({});
        }
        const headers = { ...details.responseHeaders };
        headers['Referrer-Policy'] = ['strict-origin-when-cross-origin'];
        headers['X-DNS-Prefetch-Control'] = ['off'];
        callback({ responseHeaders: headers });
    });
    // ── Permissions ───────────────────────────────────────────────────────────
    // Block-by-default with a user prompt for camera/mic/location/notifications
    // — same as normal tabs. High-risk resources are NEVER auto-granted.
    // persist:false → a private tab's decision is never written to disk and
    // stored site decisions are never consulted, so each private tab decides
    // independently and nothing carries over.
    permissionPrompt.attach(sess, { persist: false });
}
// ── Per-tab isolated sessions ─────────────────────────────────────────────────
let seq = 0;
const liveSessions = new Set();
function createTabSession() {
    const { session } = require('electron');
    // Unique in-memory partition, never reused — nothing leaks between tabs.
    const sess = session.fromPartition(`private-tab-${process.pid}-${++seq}`, { cache: false });
    setup(sess);
    try {
        adBlocker.enableBlockingInSession(sess);
    }
    catch { }
    try {
        downloadManager.attach(sess, { private: true });
    }
    catch { }
    for (const [id, file] of [
        ['chrome-spoof-private', 'chrome-spoof.js'],
        ['adblock-cosmetic-private', 'ad-block-cosmetic.js'],
        ['private-hardening', 'private-hardening.js'],
    ]) {
        try {
            sess.registerPreloadScript({ type: 'frame', id, filePath: path.join(__dirname, '../preload', file) });
        }
        catch { }
    }
    liveSessions.add(sess);
    return sess;
}
function destroyTabSession(sess) {
    if (!sess)
        return;
    liveSessions.delete(sess);
    try {
        permissionPrompt.detach(sess);
    }
    catch { } // drop temp grants / panel overrides
    try {
        sess.clearStorageData(); // cookies, localStorage, IndexedDB, …
        sess.clearCache(); // in-memory HTTP cache
        sess.clearHostResolverCache(); // DNS cache
        sess.clearAuthCache(); // HTTP auth credentials
    }
    catch { }
}
function wipeAll() {
    for (const s of [...liveSessions])
        destroyTabSession(s);
}

module.exports = { setup, createTabSession, destroyTabSession, wipeAll };