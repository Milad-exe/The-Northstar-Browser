"use strict";
// IIFE: compiled as a classic <script>; the wrapper keeps this page's
// top-level names out of the shared global scope.
(() => {
    (function () {
        const listEl = document.getElementById('list');
        // Inline SVGs (neutral gray so they read on light + dark themes)
        const G = '%23888';
        const SVG_SEARCH = `data:image/svg+xml;utf8,<svg viewBox="0 0 24 24" fill="none" stroke="${G}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`;
        const SVG_GLOBE = `data:image/svg+xml;utf8,<svg viewBox="0 0 24 24" fill="none" stroke="${G}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>`;
        const SVG_BKMK = `data:image/svg+xml;utf8,<svg viewBox="0 0 24 24" fill="none" stroke="${G}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>`;
        const SVG_HIST = `data:image/svg+xml;utf8,<svg viewBox="0 0 24 24" fill="none" stroke="${G}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`;
        const SVG_TAB = `data:image/svg+xml;utf8,<svg viewBox="0 0 24 24" fill="none" stroke="${G}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M3 9h18"></path></svg>`;
        const ENGINE_NAME = { google: 'Google', duckduckgo: 'DuckDuckGo', bing: 'Bing' };
        const isSearchType = (t) => t === 'action' || t === 'google' || t === 'duckduckgo' || t === 'bing';
        /**
         * Firefox-style emphasis: the part of the text matching what the user typed is
         * de-emphasized (thin), and the rest — the completion — is bold. Makes it
         * obvious at a glance what each suggestion adds to your query.
         */
        function highlight(text, query, cls) {
            const frag = document.createDocumentFragment();
            text = text || '';
            const q = (query || '').toLowerCase();
            const i = q ? text.toLowerCase().indexOf(q) : -1;
            const push = (t, strong) => {
                if (!t)
                    return;
                const s = document.createElement('span');
                s.className = (strong ? 'strong' : 'thin') + (cls ? ' ' + cls : '');
                s.textContent = t;
                frag.appendChild(s);
            };
            if (i === -1) {
                push(text, true);
                return frag;
            }
            push(text.slice(0, i), true);
            push(text.slice(i, i + q.length), false);
            push(text.slice(i + q.length), true);
            return frag;
        }
        function faviconFor(url) {
            try {
                const u = new URL(url);
                if (u.protocol === 'http:' || u.protocol === 'https:')
                    return `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=32`;
            }
            catch { }
            return null;
        }
        function faviconForDomain(q) {
            const host = String(q || '').replace(/^https?:\/\//, '').split(/[/?#]/)[0];
            return /\.[a-z]{2,}$/i.test(host) ? `https://www.google.com/s2/favicons?domain=${host}&sz=32` : null;
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
                const fav = item.favicon
                    || (item.url ? faviconFor(item.url) : (item.type === 'navigate' ? faviconForDomain(item.query) : null));
                icon.src = search ? SVG_SEARCH : (fav || fallback);
                icon.onerror = () => { icon.onerror = null; icon.src = fallback; };
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
                    primary.appendChild(highlight(item.query || '', query));
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
                        addSecondary('Switch to Tab');
                    else if (item.url)
                        addSecondary(item.url, { url: true });
                    el.title = item.url || '';
                }
                el.appendChild(main);
                el.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    try {
                        window.overlaySuggestions.pointerDown && window.overlaySuggestions.pointerDown();
                    }
                    catch { }
                    window.overlaySuggestions.select(item);
                });
                listEl.appendChild(el);
            });
        }
        window.overlaySuggestions.onData(render);
    })();
})();
