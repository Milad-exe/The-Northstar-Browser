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
const fs = require('fs');
const path = require('path');
const { app, net } = require('electron');
const { parse: parseTld } = require('tldts');
// ── Filter list sources ───────────────────────────────────────────────────────
// Steven Black's unified hosts (ads + tracking only variant, ~160 k domains).
const HOSTS_URL = 'https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts';
// EasyList — primary ABP-format filter list (~80 k rules).
const EASYLIST_URL = 'https://easylist.to/easylist/easylist.txt';
// EasyPrivacy — dedicated tracker / analytics / beacon blocklist. This is the
// list that turns the ad-blocker into real tracking protection.
const EASYPRIVACY_URL = 'https://easylist.to/easylist/easyprivacy.txt';
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
    'connect.facebook.net', // Facebook pixel JS
    'tr.snapchat.com',
    'ct.pinterest.com',
    // Misc tracking
    'bluekai.com', 'krxd.net',
    'rlcdn.com', 'crwdcntrl.net',
    'addthis.com', 'sharethis.com',
    'bat.bing.com', // Microsoft Ads tracking
    'mc.yandex.ru',
];
// ── Never-block allowlist ─────────────────────────────────────────────────────
// Domains that must never be blocked regardless of what the filter lists say.
// These are video / media delivery or core authentication infrastructure whose
// absence breaks entire sites rather than just removing ads.
const NEVER_BLOCK = new Set([
    // YouTube core
    'youtube.com', 'youtu.be', 'youtube-nocookie.com',
    'googlevideo.com', // video streaming CDN
    'ytimg.com', // thumbnails & image sprites
    'yt3.ggpht.com', // channel avatars / thumbnails
    'gstatic.com', // Google static assets (fonts, icons)
    // Google sign-in (needed for YouTube login)
    'accounts.google.com',
    'accounts.youtube.com',
    'googleusercontent.com', // account avatars, Drive/Photos content
    // Cloudflare bot-check infrastructure — blocking these makes every
    // Cloudflare-protected site loop forever on the challenge page.
    'challenges.cloudflare.com',
    'hcaptcha.com',
    'recaptcha.net',
    // Video-player licensing — filter lists block the whole host, but this one
    // also serves the Bitmovin player's license endpoint (/licensing). Blocking
    // it stops playback on Crunchyroll and other Bitmovin-based players.
    'licensing.bitmovin.com',
]);
// ── URL substring patterns ────────────────────────────────────────────────────
// For paths that slip through domain-level blocking (same domain, ad sub-path).
const URL_SUBSTRINGS = [
    '/pagead/js/',
    '/pagead/viewthroughconversion/',
    '/pagead/landing',
    '/adsense/domains/',
    '/api/stats/ads', // YouTube ad telemetry
    '/ptracking',
    '/pixel.gif',
    '/beacon.gif',
    '/collect?v=', // Google Analytics collect endpoint
    '/gtag/js',
    '/fbevents.js', // Facebook pixel
    '/clarity.js', // Microsoft Clarity
    '/hotjar.com/c/hotjar-',
];
// Host → eTLD+1 memo. Bounded; cleared wholesale when full (simple + cheap).
const ETLD_CACHE = new Map();
// ── AdBlocker class ───────────────────────────────────────────────────────────
class AdBlocker {
    enabled;
    initialized;
    blockedCount; // running tally of blocked requests this session
    blockedDomains;
    _cacheDir;
    constructor() {
        this.blockedDomains = new Set(HARDCODED);
        this.initialized = false;
        this.enabled = true;
        this.blockedCount = 0; // running tally of blocked requests this session
        this._cacheDir = null;
    }
    // ── Public API ────────────────────────────────────────────────────────────
    /**
     * Load cached filter lists (sync, instant) then kick off a background
     * refresh if the cache is stale.  Call once after app.whenReady().
     */
    async init() {
        this._cacheDir = path.join(app.getPath('userData'), 'northstar', 'adblock');
        try {
            fs.mkdirSync(this._cacheDir, { recursive: true });
        }
        catch { }
        const hostsFile = path.join(this._cacheDir, 'hosts.txt');
        const easylistFile = path.join(this._cacheDir, 'easylist.txt');
        const easyprivacyFile = path.join(this._cacheDir, 'easyprivacy.txt');
        // Load caches asynchronously and yield between files so the ~250k-rule
        // parse never blocks the event loop during startup. init() is no longer
        // awaited before window creation — until it finishes, shouldBlock()
        // simply returns false (a few hundred ms of unfiltered requests).
        const readIf = async (f) => { try {
            return await fs.promises.readFile(f, 'utf-8');
        }
        catch {
            return null;
        } };
        const breathe = () => new Promise(r => setImmediate(r));
        const hostsTxt = await readIf(hostsFile);
        const hostsCached = !!hostsTxt;
        if (hostsTxt) {
            try {
                this._parseHosts(hostsTxt);
            }
            catch { }
        }
        await breathe();
        const easylistTxt = await readIf(easylistFile);
        const easylistCached = !!easylistTxt;
        if (easylistTxt) {
            try {
                this._parseEasyList(easylistTxt);
            }
            catch { }
        }
        await breathe();
        const easyprivacyTxt = await readIf(easyprivacyFile);
        const easyprivacyCached = !!easyprivacyTxt;
        if (easyprivacyTxt) {
            try {
                this._parseEasyList(easyprivacyTxt);
            }
            catch { }
        }
        this.initialized = true;
        // Refresh stale or missing lists in the background (non-blocking).
        this._maybeRefresh([
            { url: HOSTS_URL, file: hostsFile, loaded: hostsCached, parse: t => this._parseHosts(t), minSize: 50_000 },
            { url: EASYLIST_URL, file: easylistFile, loaded: easylistCached, parse: t => this._parseEasyList(t), minSize: 100_000 },
            { url: EASYPRIVACY_URL, file: easyprivacyFile, loaded: easyprivacyCached, parse: t => this._parseEasyList(t), minSize: 50_000 },
        ]).catch(() => { });
    }
    /**
     * Register onBeforeRequest handler on the given Electron session.
     * Call once, after init().
     */
    enableBlockingInSession(sess) {
        // Lazy require to avoid a load-order cycle (site-permissions ⇄ features).
        const sitePermissions = require('./site-permissions').default;
        sess.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, cb) => {
            // Per-site protections shield (lock-icon panel). Fast path: skip the
            // URL/eTLD parsing entirely while no site has protections disabled.
            if (sitePermissions.hasAnyProtectionOff()) {
                const src = details.resourceType === 'mainFrame' ? details.url : (details.referrer || details.url);
                if (sitePermissions.isProtectionOff(sitePermissions.siteOf(src)))
                    return cb({});
            }
            if (this.enabled && this._shouldBlock(details.url, details.resourceType)) {
                this.blockedCount++;
                cb({ cancel: true });
            }
            else {
                cb({});
            }
        });
    }
    // Public block check — used by the privacy orchestrator, which owns the
    // default session's single onBeforeRequest handler.
    shouldBlock(url, resourceType) { return this._shouldBlock(url, resourceType); }
    recordBlock() { this.blockedCount++; }
    setEnabled(v) { this.enabled = !!v; }
    getStats() {
        return {
            domains: this.blockedDomains.size,
            enabled: this.enabled,
            initialized: this.initialized,
            blocked: this.blockedCount,
        };
    }
    // ── Internal ──────────────────────────────────────────────────────────────
    _shouldBlock(url, resourceType) {
        if (!this.initialized)
            return false;
        // Never block top-level navigation — only sub-resources.
        if (resourceType === 'mainFrame')
            return false;
        try {
            const parsed = new URL(url);
            // Skip local / extension URLs.
            if (parsed.protocol === 'file:' ||
                parsed.protocol === 'chrome-extension:' ||
                parsed.protocol === 'devtools:')
                return false;
            const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
            // Always allow core infrastructure regardless of filter lists.
            if (NEVER_BLOCK.has(host))
                return false;
            // Exact hostname check.
            if (this.blockedDomains.has(host))
                return true;
            // eTLD+1 check via tldts — correctly handles compound public suffixes
            // (.co.uk, .com.au, etc.) that naive dot-splitting gets wrong.
            // Memoized: pages fire dozens of requests to the same few hosts.
            let etld1 = ETLD_CACHE.get(host);
            if (etld1 === undefined) {
                etld1 = parseTld(host, { allowPrivateDomains: true }).domain || null;
                if (ETLD_CACHE.size > 2000)
                    ETLD_CACHE.clear();
                ETLD_CACHE.set(host, etld1);
            }
            if (etld1 && etld1 !== host && this.blockedDomains.has(etld1))
                return true;
            // URL substring patterns.
            for (const sub of URL_SUBSTRINGS) {
                if (url.includes(sub))
                    return true;
            }
        }
        catch { }
        return false;
    }
    _parseHosts(text) {
        const lines = text.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#'))
                continue;
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
    // sources: [{ url, file, loaded, parse, minSize }]
    async _maybeRefresh(sources) {
        const fetches = sources
            .filter(s => !s.loaded || this._isStale(s.file))
            .map(s => this._fetch(s.url)
            .then((text) => {
            if (text && text.length > s.minSize) {
                fs.writeFileSync(s.file, text, 'utf-8');
                s.parse(text);
            }
        })
            .catch(() => { }));
        await Promise.allSettled(fetches);
    }
    _isStale(file) {
        try {
            return (Date.now() - fs.statSync(file).mtimeMs) > CACHE_TTL_MS;
        }
        catch {
            return true;
        }
    }
    // Parse ABP/EasyList network rules. Only extracts PURE whole-host blocks:
    //   ||domain^            →  block the whole host
    //   ||domain^$third-party →  block the whole host (generic options kept)
    //
    // Rules with a path/wildcard after the host (||host^*/x.js) or a site scope
    // (||host^...$domain=other.com) are NOT whole-host blocks and are skipped —
    // otherwise a rule that only targets one script on one site would blanket-
    // block a shared CDN everywhere (this is what was hiding Shopify images).
    _parseEasyList(text) {
        for (const line of text.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed ||
                trimmed.startsWith('!') ||
                trimmed.startsWith('@') ||
                trimmed.includes('#'))
                continue;
            if (!trimmed.startsWith('||'))
                continue;
            const afterPipes = trimmed.slice(2);
            // Split off ABP options ($...). A site-scoped rule ($domain=...) is
            // not a global block, so skip it entirely.
            const dollarIdx = afterPipes.indexOf('$');
            const pattern = dollarIdx === -1 ? afterPipes : afterPipes.slice(0, dollarIdx);
            const options = dollarIdx === -1 ? '' : afterPipes.slice(dollarIdx + 1);
            if (/(^|,)domain=/.test(options))
                continue;
            // Accept only "domain" or "domain^" with nothing after it. Any path
            // or wildcard means the rule targets a specific URL, not the host.
            const m = pattern.match(/^([a-z0-9][a-z0-9.-]*\.[a-z0-9.-]+)\^?$/i);
            if (!m)
                continue;
            const domain = m[1].toLowerCase();
            if (this._isValidDomain(domain))
                this.blockedDomains.add(domain);
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
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
                res.on('error', reject);
            });
            req.on('error', reject);
            req.end();
        });
    }
}

module.exports = new AdBlocker();