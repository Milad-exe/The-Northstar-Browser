/**
 * Ad Blocker — network + cosmetic filtering.
 *
 * Network blocking:  session.webRequest.onBeforeRequest cancels requests
 *                    whose hostname appears in the downloaded blocklist or
 *                    the hardcoded fallback set.
 *
 * Cosmetic hiding:   a preload script (preload/ad-block-cosmetic.js) is
 *                    registered on the session and injects CSS to hide
 *                    residual ad containers.
 *
 * Filter list:  Steven Black's unified hosts file (ads + tracking).
 *               Downloaded once, cached for CACHE_TTL_MS, refreshed
 *               silently in the background on the next launch after expiry.
 *               On first launch the hardcoded fallback covers the gap.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { app, net } = require('electron');

// ── Filter list sources ───────────────────────────────────────────────────────

// Steven Black's unified hosts (ads + tracking only variant, ~160 k domains).
const HOSTS_URL =
    'https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts';

// Cache lifetime before a silent background refresh is triggered.
const CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

// ── Hardcoded fallback — critical ad / tracker networks ──────────────────────
// Active from the first launch before any list is downloaded.

const HARDCODED = [
    // Google ad infrastructure
    'doubleclick.net', 'ad.doubleclick.net', 'cm.g.doubleclick.net',
    'stats.g.doubleclick.net', 'securepubads.g.doubleclick.net',
    'adtrafficquality.google', 'googleadservices.com',
    'googlesyndication.com', 'pagead2.googlesyndication.com',
    'tpc.googlesyndication.com', 'googletagservices.com',
    // Analytics / tracking
    'google-analytics.com', 'analytics.google.com',
    'googletagmanager.com',
    'scorecardresearch.com', 'comscore.com', 'quantserve.com',
    'chartbeat.com', 'chartbeat.net',
    'hotjar.com', 'static.hotjar.com',
    'demdex.net', 'omtrdc.net',
    // Programmatic ad exchanges
    'adnxs.com', 'adnxs.net',
    'pubmatic.com', 'rubiconproject.com', 'openx.net', 'openx.com',
    'casalemedia.com', 'appnexus.com', 'advertising.com',
    'criteo.com', 'criteo.net',
    'amazon-adsystem.com',
    'moatads.com', 'ias.com', 'integral-ds.com',
    'adsafeprotected.com',
    // Content recommendation / native ads
    'taboola.com', 'trc.taboola.com',
    'outbrain.com', 'widgets.outbrain.com',
    'revcontent.com',
    // Social trackers
    'connect.facebook.net',      // Facebook pixel JS
    'tr.snapchat.com',
    'ct.pinterest.com',
    // Misc tracking
    'bluekai.com', 'krxd.net',
    'rlcdn.com', 'crwdcntrl.net',
    'addthis.com', 'sharethis.com',
    'bat.bing.com',              // Microsoft Ads tracking
    'mc.yandex.ru',
];

// ── URL substring patterns ────────────────────────────────────────────────────
// For paths that slip through domain-level blocking (same domain, ad sub-path).

const URL_SUBSTRINGS = [
    '/pagead/js/',
    '/pagead/viewthroughconversion/',
    '/pagead/landing',
    '/adsense/domains/',
    '/api/stats/ads',        // YouTube ad telemetry
    '/ptracking',
    '/pixel.gif',
    '/beacon.gif',
    '/collect?v=',           // Google Analytics collect endpoint
    '/gtag/js',
    '/fbevents.js',          // Facebook pixel
    '/clarity.js',           // Microsoft Clarity
    '/hotjar.com/c/hotjar-',
];

// ── AdBlocker class ───────────────────────────────────────────────────────────

class AdBlocker {
    constructor() {
        this.blockedDomains = new Set(HARDCODED);
        this.initialized    = false;
        this.enabled        = true;
        this._cacheDir      = null;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Load cached filter lists (sync, instant) then kick off a background
     * refresh if the cache is stale.  Call once after app.whenReady().
     */
    async init() {
        this._cacheDir = path.join(app.getPath('userData'), 'ink', 'adblock');
        try { fs.mkdirSync(this._cacheDir, { recursive: true }); } catch {}

        // Load cached list synchronously — fast, available for first requests.
        const cacheFile = path.join(this._cacheDir, 'hosts.txt');
        let cacheLoaded = false;
        try {
            if (fs.existsSync(cacheFile)) {
                this._parseHosts(fs.readFileSync(cacheFile, 'utf-8'));
                cacheLoaded = true;
            }
        } catch {}

        this.initialized = true;

        // Refresh in the background (non-blocking).
        this._maybeRefresh(cacheFile, cacheLoaded).catch(() => {});
    }

    /**
     * Register onBeforeRequest handler on the given Electron session.
     * Call once, after init().
     */
    enableBlockingInSession(sess) {
        sess.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, cb) => {
            if (this.enabled && this._shouldBlock(details.url, details.resourceType)) {
                cb({ cancel: true });
            } else {
                cb({});
            }
        });
    }

    setEnabled(v) { this.enabled = !!v; }

    getStats() {
        return {
            domains:     this.blockedDomains.size,
            enabled:     this.enabled,
            initialized: this.initialized,
        };
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    _shouldBlock(url, resourceType) {
        if (!this.initialized) return false;
        // Never block top-level navigation — only sub-resources.
        if (resourceType === 'mainFrame') return false;

        try {
            const parsed = new URL(url);
            // Skip local / extension URLs.
            if (parsed.protocol === 'file:' ||
                parsed.protocol === 'chrome-extension:' ||
                parsed.protocol === 'devtools:') return false;

            const host = parsed.hostname.toLowerCase().replace(/^www\./, '');

            // Exact domain check.
            if (this.blockedDomains.has(host)) return true;

            // Parent-domain check: sub.ads.example.com → ads.example.com
            const parts = host.split('.');
            for (let i = 1; i < parts.length - 1; i++) {
                if (this.blockedDomains.has(parts.slice(i).join('.'))) return true;
            }

            // URL substring patterns.
            for (const sub of URL_SUBSTRINGS) {
                if (url.includes(sub)) return true;
            }
        } catch {}

        return false;
    }

    _parseHosts(text) {
        const lines = text.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;

            // EasyList "||domain^" format (for future list flexibility).
            if (trimmed.startsWith('||') && trimmed.endsWith('^')) {
                const domain = trimmed.slice(2, -1).toLowerCase();
                if (this._isValidDomain(domain)) {
                    this.blockedDomains.add(domain);
                }
                continue;
            }

            // Hosts file format: "0.0.0.0 domain.com"
            const parts = trimmed.split(/\s+/);
            if (parts.length >= 2 && (parts[0] === '0.0.0.0' || parts[0] === '127.0.0.1')) {
                const domain = parts[1].toLowerCase();
                if (this._isValidDomain(domain)) {
                    this.blockedDomains.add(domain);
                }
            }
        }
    }

    _isValidDomain(domain) {
        return domain &&
               domain !== 'localhost' &&
               domain !== '0.0.0.0' &&
               !domain.startsWith('#') &&
               domain.includes('.') &&
               !domain.includes('/') &&
               !domain.includes('*');
    }

    async _maybeRefresh(cacheFile, cacheLoaded) {
        let needsRefresh = !cacheLoaded;
        if (!needsRefresh) {
            try {
                const stat = fs.statSync(cacheFile);
                needsRefresh = (Date.now() - stat.mtimeMs) > CACHE_TTL_MS;
            } catch {
                needsRefresh = true;
            }
        }

        if (!needsRefresh) return;

        try {
            const text = await this._fetch(HOSTS_URL);
            if (text && text.length > 50_000) {
                fs.writeFileSync(cacheFile, text, 'utf-8');
                this._parseHosts(text);
            }
        } catch (err) {
            // Silently ignore network failures — cached/hardcoded list still works.
        }
    }

    _fetch(url) {
        return new Promise((resolve, reject) => {
            const req = net.request({ url, useSessionCookies: false });
            const chunks = [];
            req.on('response', (res) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }
                res.on('data',  (c) => chunks.push(c));
                res.on('end',   ()  => resolve(Buffer.concat(chunks).toString('utf-8')));
                res.on('error', reject);
            });
            req.on('error', reject);
            req.end();
        });
    }
}

module.exports = new AdBlocker();
