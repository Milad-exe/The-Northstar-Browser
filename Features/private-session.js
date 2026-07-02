'use strict';
/**
 * Network-level privacy hardening for the private Electron session.
 *
 * Call setup(sess) INSTEAD OF UserAgent.setupSession(sess) for the private
 * partition.  Electron allows only ONE listener per webRequest event per
 * session — registering both would silently drop whichever was first.
 */

const UserAgent = require('./user-agent');

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
        headers['DNT']             = '1';
        headers['Sec-GPC']         = '1'; // Global Privacy Control (legally significant in CA, CO, etc.)
        headers['Accept-Language'] = 'en-US,en;q=0.9';

        // Strip cross-origin Referer on sub-resources
        if (details.resourceType !== 'mainFrame') {
            const referer = headers['Referer'] || '';
            if (referer) {
                try {
                    const reqOrigin = new URL(details.url).origin;
                    const refOrigin = new URL(referer).origin;
                    if (refOrigin !== reqOrigin) delete headers['Referer'];
                } catch { delete headers['Referer']; }
            }
        }

        callback({ requestHeaders: headers });
    });

    // ── Response-side privacy headers ─────────────────────────────────────────
    // Injecting Referrer-Policy here is the correct approach — setting Referer
    // directly in onBeforeSendHeaders is silently ignored since Electron 7.
    sess.webRequest.onHeadersReceived((details, callback) => {
        const headers = { ...details.responseHeaders };
        headers['Referrer-Policy']        = ['strict-origin-when-cross-origin'];
        headers['X-DNS-Prefetch-Control'] = ['off'];
        callback({ responseHeaders: headers });
    });

    // ── Permission handler ────────────────────────────────────────────────────
    // Allow normal permissions (camera, mic, notifications) but block
    // storage-access which can re-link identity across first/third-party contexts.
    sess.setPermissionRequestHandler((_wc, permission, cb) => {
        if (permission === 'storage-access') return cb(false);
        cb(true);
    });

    sess.setPermissionCheckHandler((_wc, permission) => {
        if (permission === 'storage-access') return false;
        return true;
    });
}

module.exports = { setup };
