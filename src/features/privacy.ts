'use strict';
/**
 * Privacy & tracking protection for the default (normal) Electron session.
 *
 * Electron allows exactly ONE listener per webRequest event per session, so
 * this module is the single owner of the default session's request pipeline.
 * It composes several protections into those handlers, each independently
 * toggleable from Settings → Privacy:
 *
 *   onBeforeRequest      ad/tracker network blocking (via ad-blocker),
 *                        HTTPS upgrade, tracking-parameter stripping
 *   onBeforeSendHeaders  UA client-hint alignment, GPC/DNT signals,
 *                        cross-site Referer trimming, third-party cookie blocking
 *   onHeadersReceived    Referrer-Policy tightening, DNS-prefetch off
 *
 * The private session keeps its own hardened setup (Features/private-session.js);
 * this module targets normal browsing so those protections apply everywhere.
 */

import UserAgent from './user-agent';
import adBlocker from './ad-blocker';
import sitePermissions from './site-permissions';
import { parse as parseTld } from 'tldts';
// Live configuration — mirrors the persisted privacy settings. Defaults to the
// most protective state; ipc/settings.js overrides from disk at startup.
const config = {
    adBlockEnabled:          true, // block ads + trackers at the network level
    blockThirdPartyCookies:  true, // drop cookies on cross-site requests
    httpsUpgrade:            true, // upgrade http:// navigations to https://
    stripTrackingParams:     true, // remove utm_*, fbclid, gclid, … from URLs
    privacySignals:          true, // send Sec-GPC + DNT
    trimReferrer:            true, // strip Referer across sites, tighten policy
};

// Known tracking / campaign query parameters, stripped from top-level URLs.
const TRACKING_PARAMS = new Set([
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'utm_id', 'utm_name', 'utm_cid', 'utm_reader', 'utm_referrer',
    'utm_source_platform', 'utm_creative_format', 'utm_marketing_tactic',
    'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'gad_source',
    'fbclid', 'msclkid', 'mc_eid', 'mc_cid', 'yclid', 'twclid', 'ttclid',
    'igshid', 'igsh', 'scid', 'vero_id', 'vero_conv',
    '_openstat', 'oly_anon_id', 'oly_enc_id', 'mkt_tok', 'hsa_cam', 'hsa_grp',
    'ref_src', 'ref_url', 'spm', 'wickedid',
]);

// Request types where stripping a third-party cookie is safe — pure tracking
// beacons. XHR/fetch is deliberately NOT included: video APIs and the Widevine
// DRM license request go over cross-site fetch with credentials, and Chromium
// has already applied SameSite (so anything sent cross-site is intentional).
const BEACON_TYPES = new Set(['ping', 'cspReport']);

// Hosts that must never be force-upgraded to HTTPS (local / dev / non-web).
function isLocalHost(host) {
    return host === 'localhost' ||
           host === '127.0.0.1' ||
           host === '::1' ||
           host.endsWith('.local') ||
           host.endsWith('.localhost') ||
           host.endsWith('.onion');
}

// Memoized host → eTLD+1 — this runs on every network request, and pages fire
// dozens of requests to the same handful of hosts. Bounded, cleared when full.
const ETLD_CACHE = new Map();
function etld1(host) {
    let v = ETLD_CACHE.get(host);
    if (v !== undefined) return v;
    try { v = parseTld(host, { allowPrivateDomains: true }).domain || host; }
    catch { v = host; }
    if (ETLD_CACHE.size > 2000) ETLD_CACHE.clear();
    ETLD_CACHE.set(host, v);
    return v;
}

// Returns a cleaned URL string if any tracking params were removed, else null.
function stripTrackingParams(urlStr) {
    try {
        const u = new URL(urlStr);
        if (![...u.searchParams.keys()].length) return null;
        let changed = false;
        for (const key of [...u.searchParams.keys()]) {
            if (TRACKING_PARAMS.has(key)) { u.searchParams.delete(key); changed = true; }
        }
        return changed ? u.toString() : null;
    } catch { return null; }
}

function setConfig(key, value) {
    if (key in config) config[key] = !!value;
    if (key === 'adBlockEnabled') adBlocker.setEnabled(!!value);
}
function getConfig() { return { ...config }; }

function getStats() {
    const s = adBlocker.getStats();
    return { ...s, config: { ...config } };
}

/**
 * Register the composed handlers on a session. Call once for the default
 * session INSTEAD OF UserAgent.setupSession + adBlocker.enableBlockingInSession.
 */
// The eTLD+1 site of the page a request belongs to: the URL itself for
// top-level navigations, else the referring document. Used for the per-site
// protections shield (lock-icon panel).
function pageSiteOf(details) {
    const src = details.resourceType === 'mainFrame'
        ? details.url
        : (details.referrer || details.url);
    try { return etld1(new URL(src).hostname); } catch { return null; }
}

function setup(sess) {
    sess.setUserAgent(UserAgent.generate());

    // ── onBeforeRequest: block → upgrade → strip params ───────────────────────
    sess.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, cb) => {
        const { url, resourceType } = details;

        // Per-site shield: user turned protections off for this site. Fast path:
        // no URL/eTLD parsing at all while the shield list is empty.
        const shieldOff = sitePermissions.hasAnyProtectionOff() &&
                          sitePermissions.isProtectionOff(pageSiteOf(details));

        // 1. Ad / tracker network blocking.
        if (!shieldOff && config.adBlockEnabled && adBlocker.shouldBlock(url, resourceType)) {
            adBlocker.recordBlock();
            return cb({ cancel: true });
        }
        if (shieldOff) return cb({});

        // Redirect-based rewrites are only safe on GET — redirecting a POST can
        // drop the request body and break form submissions.
        const isGet = !details.method || details.method === 'GET';

        // 2. HTTPS upgrade — only for page/frame navigations. Sub-resource http
        //    on an https page is already stopped by Chromium's mixed-content
        //    policy, and rewriting every asset risks breaking odd endpoints.
        if (isGet && config.httpsUpgrade &&
            url.startsWith('http://') &&
            (resourceType === 'mainFrame' || resourceType === 'subFrame')) {
            try {
                if (!isLocalHost(new URL(url).hostname)) {
                    return cb({ redirectURL: 'https://' + url.slice(7) });
                }
            } catch {}
        }

        // 3. Strip tracking params from top-level navigations.
        if (isGet && config.stripTrackingParams && resourceType === 'mainFrame') {
            const cleaned = stripTrackingParams(url);
            if (cleaned && cleaned !== url) return cb({ redirectURL: cleaned });
        }

        cb({});
    });

    // ── onBeforeSendHeaders: UA hints + signals + referer/cookie hygiene ──────
    sess.webRequest.onBeforeSendHeaders((details, cb) => {
        const headers = { ...details.requestHeaders };

        // Keep client-hints consistent with the Chrome UA (see user-agent.js).
        UserAgent.applyClientHintHeaders(headers);
        if (details.resourceType === 'mainFrame') {
            headers['Accept-Language'] = 'en-US,en;q=0.9';
        }

        // Per-site shield: skip signals and cross-site hygiene entirely.
        if (sitePermissions.hasAnyProtectionOff() &&
            sitePermissions.isProtectionOff(pageSiteOf(details))) {
            return cb({ requestHeaders: headers });
        }

        // Privacy signals — Global Privacy Control (legally meaningful in several
        // US states) plus legacy Do Not Track.
        if (config.privacySignals) {
            headers['Sec-GPC'] = '1';
            headers['DNT']     = '1';
        }

        // Cross-site request hygiene: work out whether this sub-resource is going
        // to a different site than the document that triggered it.
        if (details.resourceType !== 'mainFrame') {
            const referer = headers['Referer'] || headers['referer'] || '';
            const origin  = headers['Origin']  || headers['origin']  || '';
            const context = referer || origin;
            if (context) {
                let crossSite = false;
                try {
                    crossSite = etld1(new URL(context).hostname) !==
                                etld1(new URL(details.url).hostname);
                } catch { crossSite = false; }

                if (crossSite) {
                    // Referer: downgrade to origin-only (scheme://host/) rather than
                    // deleting it. Many image/video CDNs use Referer-based hotlink
                    // protection and reject requests that carry no Referer at all;
                    // origin-only still hides the path and matches the
                    // strict-origin-when-cross-origin policy we set on responses.
                    if (config.trimReferrer && referer) {
                        try {
                            const originOnly = new URL(referer).origin + '/';
                            if ('Referer' in headers) headers['Referer'] = originOnly;
                            if ('referer' in headers) headers['referer'] = originOnly;
                        } catch {}
                    }
                    // Third-party cookies: strip only on pure tracking beacons.
                    // Never touch XHR/fetch/media/etc. — doing so breaks cross-site
                    // authenticated APIs, CDN assets and DRM license requests.
                    if (config.blockThirdPartyCookies && BEACON_TYPES.has(details.resourceType)) {
                        delete headers['Cookie']; delete headers['cookie'];
                    }
                }
            }
        }

        cb({ requestHeaders: headers });
    });

    // ── onHeadersReceived: tighten referrer policy + kill DNS prefetch ────────
    // Setting Referer directly in onBeforeSendHeaders is ignored since Electron 7;
    // injecting a strict Referrer-Policy response header is the supported path.
    // Both headers only mean anything on DOCUMENTS (they govern the page's own
    // behaviour) — skip the header copy for the ~95% of requests that are
    // subresources, where injecting them does nothing.
    sess.webRequest.onHeadersReceived((details, cb) => {
        if (!config.trimReferrer ||
            (details.resourceType !== 'mainFrame' && details.resourceType !== 'subFrame')) {
            return cb({});
        }
        const headers = { ...details.responseHeaders };
        headers['Referrer-Policy']        = ['strict-origin-when-cross-origin'];
        headers['X-DNS-Prefetch-Control'] = ['off'];
        cb({ responseHeaders: headers });
    });
}

export { setup, setConfig, getConfig, getStats };