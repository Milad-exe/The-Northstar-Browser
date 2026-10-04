"use strict";
// IIFE: compiled as a classic <script>; the wrapper keeps this page's
// top-level names out of the shared global scope.
(() => {
    (function () {
        const listEl = document.getElementById('list');
        // Row glyphs live in renderer/lib/row-icons.js, shared with the new-tab page.
        const ICONS = window.Northstar.rowIcons;
        const SVG_SEARCH = ICONS.search;
        const SVG_GLOBE = ICONS.globe;
        const SVG_BKMK = ICONS.bkmk;
        const SVG_HIST = ICONS.hist;
        const SVG_TAB = ICONS.tab;
        const ENGINE_NAME = { google: 'Google', duckduckgo: 'DuckDuckGo', bing: 'Bing' };
        const isSearchType = (t) => t === 'action' || t === 'google' || t === 'duckduckgo' || t === 'bing';
        /**
         * Bold what matters (renderer/lib/display-url.js emphasis): on a search
         * row, what the suggestion adds to your text; on a page row, the
         * characters you typed. Shared with the new-tab page's suggestions.
         */
        function highlight(text, query, cls, mode) {
            const frag = document.createDocumentFragment();
            for (const seg of window.Northstar.emphasis(text, query, mode || 'match')) {
                const s = document.createElement('span');
                s.className = (seg.strong ? 'strong' : 'thin') + (cls ? ' ' + cls : '');
                s.textContent = seg.text;
                frag.appendChild(s);
            }
            return frag;
        }
        // Favicons come from the local cache (sites you've visited) only — never a
        // network fetch from the suggestions overlay. hostOf() derives the lookup
        // key for a suggestion.
        function hostOf(item) {
            try {
                if (item.url)
                    return new URL(item.url).host;
            }
            catch (e) { window.northstarLog?.debug('suggestions', 'hostOf: ' + e); }
            if (item.type === 'navigate' && item.query) {
                const h = String(item.query).replace(/^https?:\/\//, '').split(/[/?#]/)[0];
                if (/\.[a-z]{2,}$/i.test(h))
                    return h;
            }
            return '';
        }
        function render(payload) {
            const { items = [], activeIndex = -1, query = '', engine = 'google' } = payload || {};
            listEl.innerHTML = '';
            items.forEach((item, idx) => {
                const el = document.createElement('div');
                el.className = 'item' + (idx === activeIndex ? ' active' : '');
                const search = isSearchType(item.type);
                // ── Icon ──────────────────────────────────────────────────────────────
                const icon = document.createElement('img');
                icon.className = 'fav';
                icon.alt = '';
                let fallback = SVG_GLOBE;
                if (search)
                    fallback = SVG_SEARCH;
                else if (item.type === 'history')
                    fallback = SVG_HIST;
                else if (item.type === 'bookmark')
                    fallback = SVG_BKMK;
                else if (item.type === 'switch-tab')
                    fallback = SVG_TAB;
                // Placeholder first, then fill from the local favicon cache (visited
                // sites) — no network fetch here, so typing can't ping every domain.
                icon.src = search ? SVG_SEARCH : fallback;
                if (!search) {
                    if (item.favicon && /^data:/.test(item.favicon)) {
                        icon.src = item.favicon;
                    }
                    else {
                        const host = hostOf(item);
                        if (host && window.overlaySuggestions.cachedFavicon) {
                            window.overlaySuggestions.cachedFavicon(host)
                                .then(d => {
                                    if (d) { icon.src = d; return; }
                                    // Not visited before — pull the domain's favicon from the
                                    // engine's service (Chrome/Firefox-style), if allowed.
                                    if (window.overlaySuggestions.remoteFavicon)
                                        window.overlaySuggestions.remoteFavicon(host)
                                            .then(rd => { if (rd) icon.src = rd; })
                                            .catch(() => { });
                                })
                                .catch(() => { });
                        }
                    }
                }
                el.appendChild(icon);
                // ── Label: primary (highlighted) + dim secondary ──────────────────────
                const main = document.createElement('span');
                main.className = 'main-label';
                const primary = document.createElement('span');
                primary.className = 'primary';
                const addSecondary = (text, opts) => {
                    const sep = document.createElement('span');
                    sep.className = 'sep';
                    sep.textContent = ' — ';
                    main.appendChild(sep);
                    const sec = document.createElement('span');
                    sec.className = 'secondary';
                    if (opts && opts.url)
                        sec.appendChild(highlight(text, query, 'url'));
                    else
                        sec.textContent = text;
                    main.appendChild(sec);
                };
                if (search) {
                    primary.appendChild(highlight(item.query || '', query, '', 'completion'));
                    main.appendChild(primary);
                    if (item.type === 'action')
                        addSecondary('Search with ' + (ENGINE_NAME[engine] || 'Google'));
                }
                else if (item.type === 'navigate') {
                    primary.appendChild(highlight(item.query || '', query));
                    main.appendChild(primary);
                    addSecondary('Visit');
                }
                else {
                    // history / bookmark / switch-tab — "Title — url"
                    const title = item.title && item.title !== item.url ? item.title : item.url;
                    primary.appendChild(highlight(title || '', query));
                    main.appendChild(primary);
                    if (item.type === 'switch-tab')
                        addSecondary('Switch to tab');
                    else if (item.url)
                        addSecondary(window.Northstar.displayUrl(item.url), { url: true });
                    el.title = item.url || '';
                }
                el.appendChild(main);
                // Hover moves the ONE selection to this row (accent), so mouse and
                // keyboard never show two highlights, and Enter after hovering goes
                // where the pointer is — matching Chrome/Firefox.
                el.addEventListener('mouseenter', () => {
                    for (const c of listEl.children)
                        c.classList.toggle('active', c === el);
                    try { window.overlaySuggestions.hover && window.overlaySuggestions.hover(idx); }
                    catch (e) { window.northstarLog?.debug('suggestions', 'hover: ' + e); }
                });
                el.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    try {
                        window.overlaySuggestions.pointerDown && window.overlaySuggestions.pointerDown();
                    }
                    catch (e) { window.northstarLog?.debug('suggestions', 'addSecondary: ' + e); }
                    window.overlaySuggestions.select(item);
                });
                listEl.appendChild(el);
            });
        }
        window.overlaySuggestions.onData(render);
    })();
})();
