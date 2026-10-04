/**
 * Browser chrome — pure helpers.
 *
 * Split out of renderer/renderer.js: these are the parts with no DOM and no
 * shared state, which is exactly what makes them testable (tests/unit.js
 * requires this file directly — hence the UMD-ish wrapper).
 *
 * The omnibox ranking rules live here rather than in the address-bar code
 * because they encode judgements — "is this typed text a URL or a search",
 * "is this history hit worth showing" — that are much easier to argue about
 * against a list of examples than by driving the UI.
 */
(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports)
        module.exports = api;
    root.Northstar = root.Northstar || {};
    root.Northstar.util = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    /** Trailing-edge debounce with a .cancel(). */
    function debounce(fn, delay = 150) {
        let timer = null;
        const wrapped = (...args) => {
            clearTimeout(timer);
            timer = setTimeout(() => fn(...args), delay);
        };
        wrapped.cancel = () => clearTimeout(timer);
        return wrapped;
    }

    /**
     * Leading-edge throttle with a coalescing trailing call and a .cancel().
     * The first call runs immediately; further calls inside `interval` ms don't
     * run then — the latest one runs once the window elapses. Used for the
     * omnibox remote-suggest pass (P0-2): type fast and the network is hit on
     * the first keystroke, then at most once per `interval`, never per key —
     * while the local pass stays un-throttled and renders every keystroke.
     */
    function throttle(fn, interval = 100) {
        let last = 0;      // timestamp of the last real invocation
        let timer = null;  // pending trailing call
        let lastArgs = null;
        const run = (args) => { last = Date.now(); fn(...args); };
        const wrapped = (...args) => {
            lastArgs = args;
            const remaining = interval - (Date.now() - last);
            if (remaining <= 0) {
                clearTimeout(timer);
                timer = null;
                run(args);
            }
            else if (!timer) {
                timer = setTimeout(() => { timer = null; run(lastArgs); }, remaining);
            }
        };
        wrapped.cancel = () => {
            clearTimeout(timer);
            timer = null;
            last = 0;
            lastArgs = null;
        };
        return wrapped;
    }

    /** Does the typed text look like a URL/domain rather than a search? */
    function looksLikeUrl(q) {
        if (/^https?:\/\//i.test(q))
            return true;
        if (/\s/.test(q))
            return false;
        // bare domain / host[:port][/path] — needs a dot with a TLD-ish tail
        return /^[^\s/]+\.[a-z]{2,}([:/].*)?$/i.test(q) || /^localhost([:/].*)?$/i.test(q);
    }

    /** Dedup key: host (without www) + path, lowercased, no trailing slash. */
    function normalizeUrl(u) {
        try {
            const n = new URL(u);
            return (n.hostname.replace(/^www\./, '') + n.pathname).toLowerCase().replace(/\/$/, '');
        }
        catch {
            return (u || '').toLowerCase();
        }
    }

    /**
     * Relevance rank for a history/bookmark/tab entry against the query.
     * Lower is better; -1 means "not relevant enough, hide it".
     *
     * This is what stops noise like `gymshark.com` / `spotify.com` showing for
     * "y" just because the letter appears somewhere inside them — a bare
     * substring only counts once the query is at least 3 chars long.
     */
    function linkScore(item, ql) {
        let host = '', path = '';
        const title = (item.title || '').toLowerCase();
        try {
            const u = new URL(item.url);
            host = u.hostname.replace(/^www\./, '').toLowerCase();
            path = (u.pathname + u.search).toLowerCase();
        }
        catch {
            host = (item.url || '').toLowerCase();
        }
        if (host.startsWith(ql))
            return 0; // youtube.com for "you"
        if (host.split('.').some(l => l.startsWith(ql)))
            return 1; // sub-label: m.youtube.com
        if (title.split(/[\s\-–—_/|:.()]+/).some(w => w.startsWith(ql)))
            return 2; // title word start
        if (ql.length >= 3 && (host.includes(ql) || title.includes(ql) || path.includes(ql)))
            return 3;
        return -1;
    }

    /**
     * we surface clean, high-frecency pages — not OAuth/sign-in redirects
     * or giant tracking URLs. We lack visit counts, so approximate: a weak match
     * (title/substring only, score ≥ 2) that lands on a login redirect or a long
     * param-heavy URL is almost never what the user wants. Strong host matches
     * (score < 2, e.g. youtube.com/watch?v=…) are always kept.
     */
    function isLowValueMatch(url, score) {
        if (score < 2)
            return false;
        const u = url || '';
        if (u.length > 90)
            return true;
        if (/[?&](continue|dsh|ifkv|flowName|flowEntry|checkConnection|gclid|gclsrc|gad_)/i.test(u))
            return true;
        if (/\/(signin|oauth2?|auth|login|challenge)\b/i.test(u))
            return true;
        return false;
    }

    /** Lower = cleaner: short URLs with a real title sort ahead of long/untitled ones. */
    function cleanliness(item) {
        const hasTitle = item.title && item.title !== item.url;
        return (item.url || '').length + (hasTitle ? 0 : 40);
    }

    /**
     * Parse `url` into [dimmed prefix, host, dimmed rest] for the resting
     * address-bar display; null if it isn't a plain displayable http(s) URL.
     *
     * Splits the RAW string, not the parsed origin — IDN hosts, uppercase
     * schemes and credential forms would otherwise fall back to domain-only and
     * make the rest of the URL vanish from the bar.
     */
    function urlDisplayParts(url) {
        let u;
        try {
            u = new URL(url);
        }
        catch {
            return null;
        }
        if (u.protocol !== 'https:' && u.protocol !== 'http:')
            return null;
        const m = String(url).match(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^/?#@]*@)?)([^/?#]+)([\s\S]*)$/);
        return m ? [m[1], m[2], m[3]] : null;
    }

    /**
     * The engine a leading keyword selects (`w electron` → the Wikipedia
     * engine), or null. A bare keyword with no query is just a search for that
     * word, so it does not match.
     */
    function keywordEngine(text, engines) {
        const raw = String(text || '');
        const i = raw.indexOf(' ');
        if (i <= 0 || !raw.slice(i + 1).trim())
            return null;
        const head = raw.slice(0, i).toLowerCase();
        return (engines || []).find(e => e.keyword && e.keyword === head) || null;
    }

    /** Search URL for typed text, honouring a leading engine keyword. */
    function searchUrl(text, engines, defaultId) {
        const list = (engines && engines.length) ? engines : [];
        const raw = String(text || '').trim();
        const via = keywordEngine(raw, list);
        const engine = via || list.find(e => e.id === defaultId) || list[0];
        if (!engine)
            return '';
        const query = via ? raw.slice(raw.indexOf(' ') + 1).trim() : raw;
        return String(engine.url).replace(/%s/g, encodeURIComponent(query));
    }

    /**
     * Turn typed omnibox / new-tab-page input into a loadable URL: pass real
     * URLs through, http-ify a bare domain, keep internal/file schemes, and send
     * anything else to the search engine. Lifted out of renderer formatToUrl so
     * the new-tab page (renderer/NewTab) and the omnibox resolve identically.
     */
    function toNavigableUrl(text, engines, defaultId) {
        const t = String(text || '').trim();
        if (!t)
            return '';
        if (/^https?:\/\//i.test(t))
            return t;
        if (/^northstar:\/\//i.test(t))
            return t; // internal-page scheme
        if (/^(file|about|data|blob):/i.test(t))
            return t; // dropped file:// etc.
        if (t.includes('.') && !/\s/.test(t))
            return 'https://' + t;
        return searchUrl(t, engines, defaultId);
    }

    /**
     * How wide the sidebar is allowed to be, for a window of `winW`.
     *
     * The limits scale with the window (measured off the reference: ~10.5% at
     * its narrowest, ~29.6% at its widest) with absolute floors so it stays
     * usable on a small screen.
     */
    function sidebarLimits(winW) {
        const w = Number(winW) || 0;
        if (!w)
            return { min: 180, max: 460 };
        return {
            min: Math.max(178, Math.round(w * 0.105)),
            max: Math.max(320, Math.round(w * 0.296)),
        };
    }

    /**
     * The width the sidebar should actually take for a pointer at `px`.
     *
     * ONE rule, used by the drag in the chrome AND by the main process when the
     * pointer crosses over the page view mid-drag. They used to disagree — the
     * chrome collapsed to a 56px rail below 132 while main refused to go under
     * its minimum — so dragging narrow kept shrinking the sidebar visually past
     * the point where the page stopped moving.
     */
    function clampSidebarWidth(px, winW) {
        const { min, max } = sidebarLimits(winW);
        const w = Math.round(Number(px) || min);
        return Math.max(min, Math.min(max, w));
    }

    /**
     * The stable identity of a suggestion row — its URL, or for a query row (a
     * search action or an engine suggestion) its type + query. Used to keep the
     * highlighted row fixed across a re-render by identity rather than by
     * position, which jumps when async rows merge into the list.
     */
    function suggestionKey(item) {
        if (!item)
            return '';
        return item.url || `${item.type || ''}:${item.query || ''}`;
    }

    /**
     * After the suggestion list is rebuilt, where did the active row go? Returns
     * the index in `nextList` of the row that was active in `prevList` (matched
     * by suggestionKey). Falls back to 0 — the base row is always first — when
     * the active row is gone or nothing was active, and -1 for an empty list.
     */
    function reindexActive(prevList, prevIndex, nextList) {
        if (!Array.isArray(nextList) || !nextList.length)
            return -1;
        const prev = Array.isArray(prevList) ? prevList[prevIndex] : null;
        if (!prev)
            return 0;
        const key = suggestionKey(prev);
        const i = nextList.findIndex(it => suggestionKey(it) === key);
        return i >= 0 ? i : 0;
    }

    /**
     * The origin to pre-connect for a highlighted suggestion row, or null when
     * there is nothing safe to warm. A `url` row → its http(s) origin; a
     * `navigate` row → the origin its typed query resolves to (https); an
     * `action` (search) row → the engine's origin, passed in. A tab switch, a
     * container-scoped row, or a non-web scheme warms nothing — only the ORIGIN
     * ever leaves the machine, never a path or query.
     */
    function preconnectOrigin(item, engineOrigin) {
        if (!item || item.type === 'switch-tab' || item.profile)
            return null;
        if (item.url) {
            try {
                const u = new URL(item.url);
                return (u.protocol === 'http:' || u.protocol === 'https:') ? u.origin : null;
            }
            catch { return null; }
        }
        if (item.type === 'navigate' && item.query) {
            const q = item.query.trim();
            try { return new URL(/^https?:\/\//i.test(q) ? q : 'https://' + q).origin; }
            catch { return null; }
        }
        if (item.type === 'action')
            return engineOrigin || null;
        return null;
    }

    /**
     * Rows under the new-tab page's field: open tabs (switch to them — this is
     * where tab search lives), then bookmarks, then history, each matched on
     * title or url and deduped by url so a page shows once, in its best kind.
     * Local only; the NTP never waits on the network.
     * sources = { tabs:[{index,url,title}], bookmarks:[{url,title}], history:[{url,title}] }
     */
    function ntpSuggestions(query, sources, limit = 6) {
        const q = String(query || '').trim().toLowerCase();
        if (!q)
            return [];
        const out = [];
        const seen = new Set();
        const add = (kind, it) => {
            if (out.length >= limit || !it || !it.url || seen.has(it.url))
                return;
            if (!(String(it.title || '').toLowerCase().includes(q) || String(it.url).toLowerCase().includes(q)))
                return;
            seen.add(it.url);
            out.push(kind === 'tab'
                ? { kind, url: it.url, title: it.title || '', index: it.index }
                : { kind, url: it.url, title: it.title || '' });
        };
        for (const t of (sources && sources.tabs) || []) add('tab', t);
        for (const b of (sources && sources.bookmarks) || []) add('bookmark', b);
        for (const h of (sources && sources.history) || []) add('history', h);
        return out;
    }

    /**
     * Rows for the NTP's tab-search mode (Ctrl+Shift+A): every open tab before
     * anything is typed, then those whose title or url contains the query. Not
     * deduped by url — two tabs on one page are two places to jump to.
     */
    function tabSearchRows(query, tabs, limit = 12) {
        const q = String(query || '').trim().toLowerCase();
        const out = [];
        for (const t of tabs || []) {
            if (out.length >= limit)
                break;
            if (!t || t.index == null)
                continue;
            if (q && !(String(t.title || '').toLowerCase().includes(q) || String(t.url || '').toLowerCase().includes(q)))
                continue;
            out.push({ kind: 'tab', url: t.url || '', title: t.title || '', index: t.index });
        }
        return out;
    }

    /**
     * The new-tab page's shortcut tiles: the user's own tiles first (always
     * shown — you added them), then the space's Essentials, then most-visited
     * to fill up to `max`. `hidden` urls (tiles you removed with ×) are left out
     * of the last two. Deduped by url; each tile says where it came from.
     * cfg = { tiles:[{url,title}], hidden:[url] }; sources = { essentials, frequent }
     */
    function ntpTiles(cfg, sources, max = 10) {
        const hidden = new Set((cfg && cfg.hidden) || []);
        const seen = new Set();
        const out = [];
        const add = (source, it, honourHidden) => {
            if (out.length >= max || !it || !it.url || seen.has(it.url))
                return;
            if (honourHidden && hidden.has(it.url))
                return;
            seen.add(it.url);
            out.push({ source, url: it.url, title: it.title || '' });
        };
        for (const t of (cfg && cfg.tiles) || []) add('custom', t, false);
        for (const e of (sources && sources.essentials) || []) add('essential', e, true);
        for (const f of (sources && sources.frequent) || []) add('frequent', f, true);
        return out;
    }

    /**
     * Normalise what was typed into the "Add shortcut" form into a tile url:
     * an http(s) address (a bare domain gets https), or '' when it is a search,
     * not an address, or any other scheme.
     */
    function tileUrl(text) {
        const t = String(text || '').trim();
        if (!t)
            return '';
        let candidate = t;
        if (!/^[a-z][a-z0-9+.-]*:/i.test(t)) {
            if (/\s/.test(t) || !t.includes('.'))
                return '';
            candidate = 'https://' + t;
        }
        try {
            const u = new URL(candidate);
            return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname ? u.href : '';
        }
        catch { return ''; }
    }

    /**
     * Apply a reorder of SOME tabs to the full order: the slots `partial`'s
     * members occupy in `full` are refilled in `partial`'s order, and every
     * other tab (another space's, an Essential's) stays exactly where it was.
     * Indices not in `full`, and repeats, are ignored.
     */
    function mergeOrder(full, partial) {
        const inFull = new Set(full);
        const seen = new Set();
        const wanted = [];
        for (const i of partial || []) {
            if (inFull.has(i) && !seen.has(i)) {
                seen.add(i);
                wanted.push(i);
            }
        }
        let k = 0;
        return full.map(i => (seen.has(i) ? wanted[k++] : i));
    }

    /**
     * The new-tab page's most-visited tiles from newest-first history (one entry
     * per visit): count visits per url, ties broken by recency, search-result
     * pages skipped (they are queries, not places), `exclude` urls left out.
     */
    function mostVisited(history, n = 8, exclude = null) {
        const stats = new Map();
        (history || []).forEach((e, i) => {
            if (!e || !/^https?:/i.test(e.url || ''))
                return;
            if (exclude && exclude.has(e.url))
                return;
            try {
                const u = new URL(e.url);
                if (/\/search$/.test(u.pathname) && u.searchParams.has('q'))
                    return;
            }
            catch { return; }
            const s = stats.get(e.url);
            if (s)
                s.count++;
            else
                stats.set(e.url, { url: e.url, title: e.title || '', count: 1, first: i });
        });
        return [...stats.values()]
            .sort((a, b) => (b.count - a.count) || (a.first - b.first))
            .slice(0, n)
            .map(({ url, title }) => ({ url, title }));
    }

    return {
        debounce, throttle, looksLikeUrl, normalizeUrl, linkScore, isLowValueMatch,
        cleanliness, urlDisplayParts, keywordEngine, searchUrl, toNavigableUrl,
        sidebarLimits, clampSidebarWidth, suggestionKey, reindexActive, preconnectOrigin,
        ntpSuggestions, mostVisited, tabSearchRows, ntpTiles, tileUrl, mergeOrder,
    };
});
