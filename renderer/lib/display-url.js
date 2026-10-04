/**
 * displayUrl — how a URL is SHOWN in lists (ui-polish U1-5, principles §4):
 * host + the first path segment, e.g. `youtube.com/watch`. No scheme, no
 * `www.`, no query or fragment; the full URL belongs in a tooltip. Used by the
 * new-tab page, History and the address-bar dropdown so they agree.
 *
 * Non-web URLs (northstar://, file:, data:) and anything unparseable come back
 * unchanged — there is no "host" to show for them.
 *
 * Same UMD-ish wrapper as util.js: pages read window.Northstar.displayUrl,
 * tests/unit.js requires this file directly.
 */
(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports)
        module.exports = api;
    root.Northstar = root.Northstar || {};
    root.Northstar.displayUrl = api.displayUrl;
    root.Northstar.rowText = api.rowText;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    function displayUrl(raw) {
        const s = String(raw == null ? '' : raw).trim();
        if (!s)
            return '';
        let u;
        try { u = new URL(s); }
        catch { return s; }
        if (u.protocol !== 'http:' && u.protocol !== 'https:')
            return s;
        const host = u.host.toLowerCase().replace(/^www\./, '');
        const first = u.pathname.split('/').find(Boolean) || '';
        let seg = first;
        try { seg = decodeURIComponent(first); }
        catch { /* malformed escape: show it as written */ }
        return seg ? `${host}/${seg}` : host;
    }

    /**
     * A list row's two lines from a page's title and URL: the title, then
     * displayUrl. With no real title (missing, or just the URL again) the host
     * is the title and the path the secondary line — a URL is never a title.
     */
    function rowText(title, url) {
        const d = displayUrl(url);
        const t = String(title || '').trim();
        if (t && t !== url && t !== d)
            return { primary: t, secondary: d };
        let host = '';
        try { const u = new URL(url); if (/^https?:$/.test(u.protocol)) host = u.host.toLowerCase().replace(/^www\./, ''); }
        catch { /* not a web URL */ }
        if (!host)
            return { primary: d || String(url || ''), secondary: '' };
        return { primary: host, secondary: d.startsWith(host) ? d.slice(host.length) : d };
    }

    return { displayUrl, rowText };
});
