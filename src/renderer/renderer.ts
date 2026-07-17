// IIFE: compiled as a classic <script>; the wrapper keeps this page's
// top-level names out of the shared global scope.
(() => {
/**
 * Browser chrome renderer — tab bar, address bar, bookmark bar, focus mode,
 * Pomodoro timer, and window controls.
 *
 * Everything runs inside a single DOMContentLoaded callback that owns all
 * shared state. Init functions below are defined with `function` declarations
 * (hoisted) and called in order at the top of the callback.
 *
 * Module-level helpers (pure utilities, no DOM/state access) live above the
 * DOMContentLoaded listener.
 */

// ── Module-level utilities ────────────────────────────────────────────────────

/** Sanitize an HTML string using DOMPurify when available. */
const sanitizeHtml = (typeof DOMPurify !== 'undefined')
    ? (html) => DOMPurify.sanitize(html, { FORCE_BODY: false })
    : (html) => html;

/** Returns a debounced wrapper around `fn` with a `.cancel()` method. */
function debounce(fn, delay = 150) {
    let t;
    const db = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), delay); };
    db.cancel = () => clearTimeout(t);
    return db;
}

/** Build a Google favicon URL for a given page URL. Returns '' on failure. */
function faviconFor(url) {
    try { return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}`; }
    catch { return ''; }
}

/** Folder SVG markup (Material Design folder shape). */
const FOLDER_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="11" viewBox="0 0 24 20" fill="currentColor"><path d="M10,4H4C2.89,4 2,4.89 2,6V18A2,2 0 0,0 4,20H20A2,2 0 0,0 22,18V8C22,6.89 21.1,6 20,6H12L10,4Z"/></svg>';

/** Create a `<span>` containing the folder SVG. */
function makeFolderIcon(cls) {
    const span = document.createElement('span');
    span.className = cls || 'bookmark-folder-icon';
    span.innerHTML = FOLDER_SVG;
    return span;
}

// ── Entry point ───────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {

    // ── Fully synchronous startup ─────────────────────────────────────────────
    // The main process sends tab-created / tab-switched / url-updated /
    // navigation-updated from its did-finish-load handler, which fires after
    // this callback. IF this callback were async, those IPC handlers could run
    // during an await — before the const DOM refs (searchBar, backBtn, …) and
    // the suggestion state below are initialized — throwing "Cannot access X
    // before initialization" and leaving the address bar/nav buttons dead.
    // Loading settings synchronously keeps the entire setup in one tick, so no
    // IPC is processed until every declaration and init function has run.

    let tabs           = new Map(); // tabIndex → <div.tab-button>
    let tabUrls        = new Map(); // tabIndex → url string
    let tabPrivate     = new Map(); // tabIndex → boolean (private flag)
    let tabLoading     = new Set(); // tabIndexes currently loading
    let activeTabIndex = 0;
    let currentTabUrl   = '';
    let currentTabTitle = '';

    // ── Settings (synchronous) ────────────────────────────────────────────────
    let settings: any = {};
    try { settings = window.northstarSettings.getSync() || {}; } catch {}

    const getSearchEngine  = () => settings.searchEngine || 'google';
    const getPomSetting    = (key, def) => (typeof settings[key] === 'number' ? settings[key] : def);

    // ── Private window detection (synchronous) ────────────────────────────────
    let isPrivateWindow = false;
    try { isPrivateWindow = window.northstarPrivate?.isPrivateWindowSync?.() ?? false; } catch {}
    if (isPrivateWindow) {
        document.documentElement.setAttribute('data-private-window', 'true');
    }
    window.northstarPrivate?.onSetPrivateWindow?.((v) => {
        if (v) document.documentElement.setAttribute('data-private-window', 'true');
        else document.documentElement.removeAttribute('data-private-window');
    });

    // ── Shared state ──────────────────────────────────────────────────────────

    let menuOpen = false;

    // ── Bookmark bar state (must be declared before initBookmarkBar() is called) ──
    let bookmarkBarVisible = !!settings.bookmarkBarVisible;
    let hasBookmarks       = false;
    let renamingFolderId   = null;
    let refreshSeq         = 0;
    let openDropdownId     = null; // id of the anchor button whose dropdown is open
    let dropdownCleanup    = null;

    // ── DOM references ─────────────────────────────────────────────────────────

    const tabBar        = document.getElementById('tab-bar');
    const tabsContainer = document.getElementById('tabs-container');
    const searchBar        = document.getElementById('searchBar');
    const backBtn          = document.getElementById('back-btn');
    const forwardBtn       = document.getElementById('forward-btn');
    const reloadBtn        = document.getElementById('reload-btn');
    const omnibox          = document.querySelector('.omnibox');
    const omniIcon         = document.getElementById('omni-icon');
    const urlDisplay       = document.getElementById('url-display');
    const menuBtn          = document.getElementById('menu-btn');
    const addBtn           = document.getElementById('new-tab-btn');
    const tabDragSpacer    = document.getElementById('tab-drag-spacer');
    const bookmarkBtn      = document.getElementById('bookmark-btn');
    const bookmarkBar      = document.getElementById('bookmark-bar');
    const bookmarkBarItems = document.getElementById('bookmark-bar-items');

    // ── Init sequence ─────────────────────────────────────────────────────────

    initTabBar(); // registers all tab IPC listeners
    initWindowControls();
    initNavButtons();
    initAddressBar();
    initBookmarkBar();
    initFocusModeAndPomodoro();
    initMenu();
    initDownloads();
    initReaderAndPip();

    // ─────────────────────────────────────────────────────────────────────────
    // Window controls
    // ─────────────────────────────────────────────────────────────────────────

    function initWindowControls() {
        const container = document.getElementById('window-controls');
        if (!container || !window.windowControls) return;

        if (window.windowControls.platform === 'darwin') {
            container.style.width = '72px'; // space for native traffic lights
            container.classList.add('wc-mac');
            return;
        }

        // Windows / Linux: render our own controls on the right side
        container.innerHTML = `
            <button class="wc-btn wc-minimize" id="wc-minimize" title="Minimize">
              <svg viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor"/></svg>
            </button>
            <button class="wc-btn wc-maximize" id="wc-maximize" title="Maximize">
              <svg viewBox="0 0 10 10" fill="none"><rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor"/></svg>
            </button>
            <button class="wc-btn wc-close" id="wc-close" title="Close">
              <svg viewBox="0 0 10 10"><line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" stroke-width="1.2"/><line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" stroke-width="1.2"/></svg>
            </button>`;
        container.classList.add('wc-win');

        document.getElementById('wc-close')?.addEventListener('click',    () => window.windowControls.close());
        document.getElementById('wc-minimize')?.addEventListener('click', () => window.windowControls.minimize());
        document.getElementById('wc-maximize')?.addEventListener('click', () => window.windowControls.maximize());

        window.windowControls.onMaximizeChanged((isMax) => {
            const btn = document.getElementById('wc-maximize');
            if (!btn) return;
            btn.title     = isMax ? 'Restore' : 'Maximize';
            btn.innerHTML = isMax
                ? `<svg viewBox="0 0 10 10" fill="none"><rect x="2" y="0" width="8" height="8" stroke="currentColor"/><rect x="0" y="2" width="8" height="8" stroke="currentColor" fill="var(--surface-container-lowest)"/></svg>`
                : `<svg viewBox="0 0 10 10" fill="none"><rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor"/></svg>`;
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Navigation buttons (back / forward / reload)
    // ─────────────────────────────────────────────────────────────────────────

    function initNavButtons() {
        setupNavButton(backBtn,    () => window.tab.goBack(activeTabIndex));
        setupNavButton(forwardBtn, () => window.tab.goForward(activeTabIndex));
        reloadBtn.addEventListener('click', () => {
            if (tabLoading.has(activeTabIndex)) window.tab.stop(activeTabIndex);
            else                                window.tab.reload(activeTabIndex);
        });
        addBtn.addEventListener('click',    () => window.tab.add());

        window.addEventListener('click', (e) => {
            if (menuOpen) window.electronAPI.windowClick({ x: e.clientX, y: e.clientY });
        });
        window.menu.onClosed(() => { menuOpen = false; });
    }

    /**
     * Back/forward buttons — click navigates one step; holding the button
     * (or right-clicking it) shows the tab's history list, Firefox-style.
     */
    function setupNavButton(btn, action) {
        let pressTimer = null;
        let menuShown  = false;

        const showHistoryMenu = () => {
            const r = btn.getBoundingClientRect();
            window.tab.showNavHistoryMenu(activeTabIndex, Math.round(r.left), Math.round(r.bottom + 2));
        };

        btn.addEventListener('mousedown', (e) => {
            if (e.button !== 0 || btn.disabled) return;
            menuShown = false;
            clearTimeout(pressTimer);
            pressTimer = setTimeout(() => { menuShown = true; showHistoryMenu(); }, 400);
        });
        btn.addEventListener('mouseup',    () => clearTimeout(pressTimer));
        btn.addEventListener('mouseleave', () => clearTimeout(pressTimer));
        btn.addEventListener('click', () => {
            if (menuShown) { menuShown = false; return; } // long-press already handled
            action();
        });
        btn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (!btn.disabled) showHistoryMenu();
        });
    }

    function updateNavigationButtons(canGoBack, canGoForward) {
        backBtn.disabled    = !canGoBack;
        forwardBtn.disabled = !canGoForward;
        backBtn.style.opacity    = canGoBack    ? '1' : '0.5';
        forwardBtn.style.opacity = canGoForward ? '1' : '0.5';
        backBtn.style.cursor     = canGoBack    ? 'pointer' : 'not-allowed';
        forwardBtn.style.cursor  = canGoForward ? 'pointer' : 'not-allowed';
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Address bar + URL suggestions overlay
    // ─────────────────────────────────────────────────────────────────────────

    function initAddressBar() {
        // Pre-warm the suggestions overlay so its first load doesn't steal
        // focus (and a keystroke) once the user starts typing — but NOT during
        // startup: spawning that renderer competed with the chrome's own first
        // paint. Warm on first address-bar focus, or once startup has settled.
        let suggestionsWarmed = false;
        const warmSuggestions = () => {
            if (suggestionsWarmed) return;
            suggestionsWarmed = true;
            window.suggestions.warm?.().catch?.(() => {});
        };
        searchBar.addEventListener('focus', warmSuggestions, { once: true });
        setTimeout(warmSuggestions, 2500);

        searchBar.addEventListener('input', (e) => {
            userTyping = true;
            barEdited  = true;
            // Only autocomplete on insertions — autofilling right after the user
            // deletes text would "bring back" the URL they just erased.
            lastInputWasInsert = !!(e.inputType && e.inputType.startsWith('insert'));
            updateSuggestions();
        });
        searchBar.addEventListener('focus', () => {
            updateUrlDisplay();
            updateOmniboxIcon();
            if (userTyping) {
                if (searchBar.value.trim()) updateSuggestions();
            } else if (barEdited) {
                // Refocusing with an uncommitted edit — keep the typed text
                // (Firefox preserves it until you actually navigate).
                searchBar.select();
            } else {
                if (currentTabUrl && searchBar.value !== currentTabUrl) searchBar.value = currentTabUrl;
                searchBar.select();
            }
        });
        searchBar.addEventListener('blur', () => {
            // Uncommitted typed text stays in the bar (Firefox); otherwise rest
            // on the full URL with the host emphasised (url-display overlay).
            if (!barEdited && currentTabUrl) searchBar.value = restingValueFor(currentTabUrl);
            updateUrlDisplay();
            updateOmniboxIcon();
            setTimeout(() => {
                if (overlayPointerDown) return;
                if (document.activeElement === searchBar) return;
                hideSuggestions();
            }, 400);
        });
        searchBar.addEventListener('keydown', onSearchKeyDown);

        // Lock / security icon → Firefox-style site-info panel (connection,
        // permissions, clear data). Only meaningful on real http(s) pages.
        omniIcon?.addEventListener('mousedown', (e) => {
            const kind = omnibox?.dataset.omni;
            if (kind !== 'secure' && kind !== 'insecure') return;
            e.preventDefault();
            e.stopPropagation();
            const r = omniIcon.getBoundingClientRect();
            try { window.siteInfo.open({ x: Math.round(r.left), y: Math.round(r.bottom) }); } catch {}
        });

        // Overlay view was (re)created — restore focus to the address bar, but
        // only if the user was actually typing (the overlay is also pre-warmed
        // at startup, which must not grab focus or fake a typing session).
        window.suggestions.onCreated(() => { if (userTyping) { try { searchBar.focus(); } catch {} } });
        window.suggestions.onSelected(onSuggestionSelected);
        window.suggestions.onPointerDown(() => {
            overlayPointerDown = true;
            setTimeout(() => { overlayPointerDown = false; }, 350);
        });

        if (window.contentInteraction) {
            window.contentInteraction.onClicked(() => { hideSuggestions(); searchBar.blur(); });
        }

        // New blank tab (main process) → focus + select the address bar so the
        // user can immediately type a URL. This fires more than once per new
        // tab (the page load can steal focus back) — don't clobber text the
        // user already started typing.
        window.electronAPI.onFocusAddressBar?.(() => {
            if (userTyping && document.activeElement === searchBar) return;
            try { searchBar.focus(); searchBar.select(); } catch {}
        });

        window.addEventListener('resize', positionSuggestions);
        window.addEventListener('scroll', positionSuggestions, true);
    }

    // ── Suggestion state ──────────────────────────────────────────────────────

    let currentSuggestions    = [];
    let activeSuggestionIndex = -1;
    let overlayPointerDown    = false;
    let userTyping           = false;
    let lastInputWasInsert   = false;
    let currentQuery         = '';   // the user's typed text, for match highlighting
    let barEdited            = false; // uncommitted typed text in the bar (survives blur)

    function getSuggestionsBounds() {
        const r = searchBar.getBoundingClientRect();
        return { left: r.left, top: r.bottom + 4, width: r.width };
    }

    function positionSuggestions() {
        if (!currentSuggestions.length) return;
        window.suggestions.update(getSuggestionsBounds(), currentSuggestions, activeSuggestionIndex, currentQuery, getSearchEngine());
    }

    function hideSuggestions() {
        userTyping = false;
        updateSuggestions.cancel();
        window.suggestions.close();
        currentSuggestions    = [];
        activeSuggestionIndex = -1;
    }

    function renderSuggestions(list) {
        if (!userTyping) return;
        currentSuggestions    = list;
        activeSuggestionIndex = list.length ? 0 : -1;
        if (!list.length) { hideSuggestions(); return; }
        window.suggestions.open(getSuggestionsBounds(), currentSuggestions, activeSuggestionIndex, currentQuery, getSearchEngine()).catch(() => {});
    }

    function setActiveSuggestion(newIndex) {
        if (!currentSuggestions.length) return;
        if (newIndex < 0)                           newIndex = currentSuggestions.length - 1;
        if (newIndex >= currentSuggestions.length)  newIndex = 0;
        activeSuggestionIndex = newIndex;
        const item = currentSuggestions[newIndex];
        if (item) searchBar.value = item.url || item.query || '';
        window.suggestions.update(getSuggestionsBounds(), currentSuggestions, activeSuggestionIndex, currentQuery, getSearchEngine());
    }

    /**
     * Commit an address-bar navigation: load the URL, close the popup, and
     * move focus off the bar so it falls back to its resting display —
     * exactly what Firefox does on Enter / suggestion click.
     */
    function commitNavigation(value) {
        barEdited  = false;
        userTyping = false;
        const formatted = loadUrlInActiveTab(value);
        if (formatted) currentTabUrl = formatted; // optimistic; url-updated confirms
        hideSuggestions();
        searchBar.blur();
        updateOmniboxIcon();
    }

    function handleSuggestionSelect(index) {
        const item = currentSuggestions[index];
        if (!item) return;
        if (item.type === 'switch-tab') {
            hideSuggestions(); searchBar.blur();
            window.tab.switch(item.tabIndex);
        } else if ((item.type === 'history' || item.type === 'bookmark') && item.url) {
            searchBar.value = item.url;
            commitNavigation(item.url);
        } else if (item.query) {
            searchBar.value = item.query;
            commitNavigation(item.query);
        }
    }

    function onSuggestionSelected(item) {
        if (!item) return;
        // The click landed in the overlay view — reclaim OS focus for the
        // chrome view first so the blur below lands on a focused bar.
        try { searchBar.focus(); } catch {}
        if (item.type === 'switch-tab') {
            hideSuggestions(); searchBar.blur();
            window.tab.switch(item.tabIndex);
            return;
        }
        if ((item.type === 'history' || item.type === 'bookmark') && item.url) {
            searchBar.value = item.url; commitNavigation(item.url);
        } else if (item.query) {
            searchBar.value = item.query; commitNavigation(item.query);
        } else {
            hideSuggestions();
        }
    }

    function onSearchKeyDown(e) {
        // Firefox: Ctrl/Cmd+Enter wraps a bare term in www. … .com; anything
        // that already looks like a URL just navigates normally.
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            const v = searchBar.value.trim();
            if (!v) return;
            searchBar.value = /[\s./:]/.test(v) ? v : `www.${v}.com`;
            commitNavigation(searchBar.value);
            return;
        }
        if (currentSuggestions.length) {
            if (e.key === 'ArrowDown')  { e.preventDefault(); setActiveSuggestion(activeSuggestionIndex + 1); return; }
            if (e.key === 'ArrowUp')    { e.preventDefault(); setActiveSuggestion(activeSuggestionIndex - 1); return; }
            if (e.key === 'Tab')        { e.preventDefault(); setActiveSuggestion(activeSuggestionIndex + (e.shiftKey ? -1 : 1)); return; }
            if (e.key === 'Escape')     { e.preventDefault(); hideSuggestions(); return; }
            if (e.key === 'Enter' && activeSuggestionIndex >= 0) {
                e.preventDefault();
                const item = currentSuggestions[activeSuggestionIndex];
                // The action/navigate row's query is the raw typed prefix — use
                // the live bar value so inline domain autofill is what loads.
                if (item?.type === 'action' || item?.type === 'navigate') {
                    const url = searchBar.value.trim();
                    if (url) commitNavigation(url);
                    return;
                }
                handleSuggestionSelect(activeSuggestionIndex); return;
            }
        } else if (e.key === 'Escape') {
            // Popup already closed: a second Escape reverts the bar to the
            // page URL, keeping focus (Firefox behaviour).
            e.preventDefault();
            barEdited = false; userTyping = false;
            searchBar.value = currentTabUrl || '';
            searchBar.select();
            updateOmniboxIcon();
            return;
        }
        if (e.key === 'Enter') {
            const url = searchBar.value.trim();
            if (url) commitNavigation(url);
        }
    }

    // ── Suggestion data sources ───────────────────────────────────────────────

    function getOpenTabSuggestions(q) {
        const ql = q.toLowerCase();
        const results = [];
        tabs.forEach((btn, index) => {
            if (index === activeTabIndex) return;
            const url   = tabUrls.get(index) || '';
            const title = btn.querySelector('.tab-title')?.textContent || '';
            if (!url || url === 'newtab' || url.startsWith('file://')) return;
            if (!url.toLowerCase().includes(ql) && !title.toLowerCase().includes(ql)) return;
            results.push({ type: 'switch-tab', tabIndex: index, title: title || url, url, favicon: faviconFor(url) });
        });
        return results;
    }

    async function getBookmarkSuggestions(q, limit = 3) {
        try {
            const entries = await window.browserBookmarks.getAll();
            if (!Array.isArray(entries) || !q) return [];
            const ql      = q.toLowerCase();
            const results = [];
            for (const e of entries) {
                if (!e.url) continue;
                if (!e.url.toLowerCase().includes(ql) && !(e.title || '').toLowerCase().includes(ql)) continue;
                results.push({ type: 'bookmark', title: e.title || e.url, url: e.url, favicon: faviconFor(e.url) });
                if (results.length >= limit) break;
            }
            return results;
        } catch { return []; }
    }

    async function getHistorySuggestions(q, limit = 5) {
        try {
            const entries = await (window.browserHistory.search
                ? window.browserHistory.search(q, limit * 3)
                : window.browserHistory.get());
            if (!Array.isArray(entries) || !q) return [];
            const results = [];
            const seen    = new Set();
            for (const e of entries) {
                if (!e.url) continue;
                const key = normalizeUrl(e.url);
                if (seen.has(key)) continue;
                seen.add(key);
                results.push({ type: 'history', title: e.title || e.url, url: e.url, favicon: faviconFor(e.url) });
                if (results.length >= limit) break;
            }
            return results;
        } catch { return []; }
    }

    async function getSearchSuggestions(q, limit = 6) {
        if (!q) return [];
        // Firefox disables remote search suggestions in private browsing —
        // never leak keystrokes for a private window or private tab.
        if (isPrivateWindow || tabPrivate.get(activeTabIndex)) return [];
        const engine     = getSearchEngine();
        const suggestMap = {
            google:     `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(q)}`,
            duckduckgo: `https://duckduckgo.com/ac/?q=${encodeURIComponent(q)}&type=list`,
            bing:       `https://api.bing.com/osjson.aspx?query=${encodeURIComponent(q)}`,
        };
        try {
            const res  = await fetch(suggestMap[engine] || suggestMap.google, { cache: 'no-store' });
            const data = await res.json();
            const arr  = Array.isArray(data) && Array.isArray(data[1]) ? data[1] : [];
            return arr.slice(0, limit).map(s => ({ type: engine, query: s }));
        } catch { return []; }
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
        } catch { host = (item.url || '').toLowerCase(); }

        if (host.startsWith(ql)) return 0;                                    // youtube.com for "you"
        if (host.split('.').some(l => l.startsWith(ql))) return 1;            // sub-label: m.youtube.com
        if (title.split(/[\s\-–—_/|:.()]+/).some(w => w.startsWith(ql))) return 2; // title word start
        if (ql.length >= 3 && (host.includes(ql) || title.includes(ql) || path.includes(ql))) return 3;
        return -1;
    }

    /**
     * Firefox surfaces clean, high-frecency pages — not OAuth/sign-in redirects
     * or giant tracking URLs. We lack visit counts, so approximate: a weak match
     * (title/substring only, score ≥ 2) that lands on a login redirect or a long
     * param-heavy URL is almost never what the user wants. Strong host matches
     * (score < 2, e.g. youtube.com/watch?v=…) are always kept.
     */
    function isLowValueMatch(url, score) {
        if (score < 2) return false;
        const u = url || '';
        if (u.length > 90) return true;
        if (/[?&](continue|dsh|ifkv|flowName|flowEntry|checkConnection|gclid|gclsrc|gad_)/i.test(u)) return true;
        if (/\/(signin|oauth2?|auth|login|challenge)\b/i.test(u)) return true;
        return false;
    }

    /** Lower = cleaner: short URLs with a real title sort ahead of long/untitled ones. */
    function cleanliness(item) {
        const hasTitle = item.title && item.title !== item.url;
        return (item.url || '').length + (hasTitle ? 0 : 40);
    }

    /**
     * Firefox-style inline autocomplete: if the top domain match extends what
     * the user typed, return the completed host (e.g. "you" → "youtube.com").
     * Returns null when it isn't safe to autofill (caret not at end, user is
     * deleting, query has spaces, etc.). Caller applies it to the input.
     */
    function computeAutofill(q, url) {
        if (!lastInputWasInsert || !userTyping) return null;
        if (document.activeElement !== searchBar) return null;
        if (searchBar.value !== q) return null;                  // user typed more since
        if (q.includes(' ') || /^https?:\/\//i.test(q)) return null;
        if (searchBar.selectionStart !== q.length ||
            searchBar.selectionEnd   !== q.length) return null;  // caret must be at the end

        const ql = q.toLowerCase();
        let host;
        try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
        const bare  = host.replace(/^www\./, '');
        const match = bare.startsWith(ql) ? bare : (host.startsWith(ql) ? host : null);
        return (match && match.length > q.length) ? match : null;
    }

    /** Does the typed text look like a URL/domain rather than a search? */
    function looksLikeUrl(q) {
        if (/^https?:\/\//i.test(q)) return true;
        if (/\s/.test(q)) return false;
        // bare domain / host[:port][/path] — needs a dot with a TLD-ish tail
        return /^[^\s/]+\.[a-z]{2,}([:/].*)?$/i.test(q) || /^localhost([:/].*)?$/i.test(q);
    }

    const updateSuggestions = debounce(async () => {
        const q = searchBar.value.trim();
        if (!q) { hideSuggestions(); return; }
        const ql = q.toLowerCase();
        currentQuery = q; // typed text drives the bold-completion highlighting

        // Immediate feedback while async sources load
        renderSuggestions([looksLikeUrl(q) ? { type: 'navigate', query: q } : { type: 'action', query: q }]);

        try {
            // Over-fetch links so relevance scoring (below) has enough
            // candidates to find good matches before we truncate the list.
            const openTabs                 = getOpenTabSuggestions(q);
            const [bookmarks, hist, search] = await Promise.all([
                getBookmarkSuggestions(q, 12),
                getHistorySuggestions(q, 20),
                getSearchSuggestions(q, 6),
            ]);

            // Score each link/tab; drop irrelevant and low-value (auth/redirect)
            // matches. Bookmarks slightly outrank history at the same tier.
            const scored = [];
            const consider = (item, bias) => {
                const s = linkScore(item, ql);
                if (s < 0 || isLowValueMatch(item.url, s)) return;
                scored.push({ item, score: s + bias, clean: cleanliness(item) });
            };
            for (const b of bookmarks) consider(b, -0.1);
            for (const h of hist)      consider(h,  0);
            for (const t of openTabs)  consider(t, -0.2);
            // Sort by relevance tier, then by cleanliness (short, titled URLs first).
            scored.sort((a, b) => (a.score - b.score) || (a.clean - b.clean));

            // Dedup by normalized host+path (ignoring www), keeping the best entry.
            const rankedLinks = [];
            const seenLinks   = new Set();
            for (const { item } of scored) {
                const key = normalizeUrl(item.url);
                if (seenLinks.has(key)) continue;
                seenLinks.add(key);
                rankedLinks.push(item);
            }

            // Inline-autofill from the top domain-prefix match, and make the
            // first row match what's now in the address bar so Enter is obvious.
            const topDomain = rankedLinks.find(x => linkScore(x, ql) === 0);
            const completed = topDomain ? computeAutofill(q, topDomain.url) : null;
            if (completed) {
                searchBar.value = q + completed.slice(q.length);
                searchBar.setSelectionRange(q.length, searchBar.value.length);
            }

            const base = completed
                ? { type: 'navigate', query: completed }
                : (looksLikeUrl(q) ? { type: 'navigate', query: q } : { type: 'action', query: q });

            // The heuristic already represents the autofilled domain — don't
            // repeat it as a history row right underneath (Firefox collapses this).
            const heuristicKey = completed ? normalizeUrl('https://' + completed) : null;

            const merged    = [base];
            const seenQuery = new Set([String(base.query).toLowerCase()]);

            // Search suggestions right under the heuristic row (max 3); skip
            // base-query dupes. Firefox's default order shows suggestions
            // ahead of history/bookmarks.
            let searchCount = 0;
            for (const s of search) {
                const k = (s.query || '').toLowerCase();
                if (k && !seenQuery.has(k)) { merged.push(s); seenQuery.add(k); if (++searchCount >= 3) break; }
            }

            // History / bookmarks / open tabs — tight cap like Firefox (max 4).
            // Caps keep the whole list (base + ≤3 search + ≤4 links = ≤8) visible
            // without scrolling — see MAX_HEIGHT in ipc/suggestions.js.
            let linkCount = 0;
            for (const link of rankedLinks) {
                if (heuristicKey && normalizeUrl(link.url) === heuristicKey) continue;
                merged.push(link);
                if (++linkCount >= 4) break;
            }

            renderSuggestions(merged);
        } catch { /* keep base rendered */ }
    }, 120);

    // Normalize for dedup: host (without www) + path, lowercased, no trailing slash.
    function normalizeUrl(u) {
        try {
            const n = new URL(u);
            return (n.hostname.replace(/^www\./, '') + n.pathname).toLowerCase().replace(/\/$/, '');
        } catch { return (u || '').toLowerCase(); }
    }

    // ── URL loading ───────────────────────────────────────────────────────────

    function loadUrlInActiveTab(url) {
        let formatted = url;
        if (!/^https?:\/\//i.test(url)) {
            if (url.includes('.') && !url.includes(' ')) {
                formatted = 'https://' + url;
            } else {
                const engines = {
                    google:     'https://www.google.com/search?q=',
                    duckduckgo: 'https://duckduckgo.com/?q=',
                    bing:       'https://www.bing.com/search?q=',
                };
                formatted = (engines[getSearchEngine()] || engines.google) + encodeURIComponent(url);
            }
        }
        window.tab.loadUrl(activeTabIndex, formatted);
        return formatted;
    }

    function getDomainDisplay(url) {
        if (!url || url === 'newtab' || url.startsWith('file://')) return url || '';
        return window.urlUtils?.getDomain(url) || url;
    }

    // ── Firefox-style resting URL display ─────────────────────────────────────
    // While the bar is unfocused the full URL stays visible, painted into the
    // #url-display overlay: host in full text colour, scheme and path dimmed.
    // The input underneath keeps the complete URL (transparent text) so focus
    // and select-all behave normally.

    // Parse `url` into [dimmed prefix, host, dimmed rest]; null if it isn't a
    // plain displayable http(s) URL.
    function urlDisplayParts(url) {
        let u;
        try { u = new URL(url); } catch { return null; }
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
        if (!url.startsWith(u.origin)) return null; // credentials or odd forms: show plain
        return [u.protocol + '//', u.host, url.slice(u.origin.length)];
    }

    // Resting input value: the full URL for http(s) pages, the legacy domain
    // fallback for internal pages (newtab, file://).
    function restingValueFor(url) {
        return urlDisplayParts(url) ? url : getDomainDisplay(url);
    }

    function updateUrlDisplay() {
        const parts = currentTabUrl ? urlDisplayParts(currentTabUrl) : null;
        const resting = document.activeElement !== searchBar && !barEdited &&
                        !!parts && searchBar.value === currentTabUrl;
        if (resting) {
            const [pre, host, rest] = parts;
            urlDisplay.textContent = '';
            const hostEl = document.createElement('span');
            hostEl.className = 'host';
            hostEl.textContent = host;
            urlDisplay.append(pre, hostEl, rest);
        }
        omnibox?.classList.toggle('showing-url', resting);
    }

    function updateSearchBarUrl(url) {
        // Never clobber the address bar while the user is typing in it — page
        // events (redirects, title/favicon updates) kept re-inserting the old
        // URL over freshly typed text.
        if (document.activeElement === searchBar && userTyping) return;
        // Uncommitted typed text survives same-page updates (title / favicon
        // refreshes); only a real navigation replaces it, like Firefox.
        if (barEdited && url === currentTabUrl) return;
        barEdited = false;
        currentTabUrl = url || ''; // callers re-assign right after; needed here so the display check is coherent
        if (document.activeElement !== searchBar) {
            searchBar.value = restingValueFor(url);
        } else {
            searchBar.value = url;
        }
        updateUrlDisplay();
        updateOmniboxIcon();
        hideSuggestions();
    }

    // Context-aware address-bar icon: a lock on HTTPS, a "not secure" glyph on
    // HTTP, and the search glyph while typing or on internal / new-tab pages.
    function updateOmniboxIcon() {
        if (!omnibox) return;
        if (document.activeElement === searchBar) { omnibox.dataset.omni = 'search'; return; }
        const url = currentTabUrl || '';
        if      (/^https:\/\//i.test(url)) omnibox.dataset.omni = 'secure';
        else if (/^http:\/\//i.test(url))  omnibox.dataset.omni = 'insecure';
        else                               omnibox.dataset.omni = 'search';
    }

    // Loading state → tab spinner + reload/stop button toggle.
    function setTabLoading(index, loading) {
        if (loading) tabLoading.add(index); else tabLoading.delete(index);
        tabs.get(index)?.classList.toggle('loading', !!loading);
        if (index === activeTabIndex) updateReloadButton();
    }

    function updateReloadButton() {
        const loading = tabLoading.has(activeTabIndex);
        reloadBtn.classList.toggle('loading', loading);
        reloadBtn.title = loading ? 'Stop' : 'Reload';
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Bookmark bar
    // ─────────────────────────────────────────────────────────────────────────

    // ── Dropdown (overflow + folder sub-panels) ──────────────────────────────

    function closeDropdown() {
        document.getElementById('bm-dropdown')?.remove();
        document.getElementById('bm-subdropdown')?.remove();
        if (dropdownCleanup) { dropdownCleanup(); dropdownCleanup = null; }
        openDropdownId = null;
    }

    function openDropdown(anchorBtn, anchorId, buildFn) {
        if (openDropdownId === anchorId) { closeDropdown(); return; }
        closeDropdown();
        openDropdownId = anchorId;

        const panel = document.createElement('div');
        panel.id        = 'bm-dropdown';
        panel.className = 'bookmark-overflow-dropdown';
        buildFn(panel);
        document.body.appendChild(panel);

        const rect    = anchorBtn.getBoundingClientRect();
        const panelW  = 200;
        panel.style.left = Math.min(rect.left, window.innerWidth - panelW - 4) + 'px';
        panel.style.top  = rect.bottom + 'px';

        const handler = (e) => {
            if (!panel.contains(e.target) && e.target !== anchorBtn) {
                closeDropdown();
                document.removeEventListener('mousedown', handler, true);
            }
        };
        document.addEventListener('mousedown', handler, true);
        dropdownCleanup = () => document.removeEventListener('mousedown', handler, true);
    }

    // ── Dropdown item builder ─────────────────────────────────────────────────

    function makeDropdownItem(entry, parentFolderId) {
        if (entry.type === 'divider') {
            const sep = document.createElement('div');
            sep.className = 'bookmark-overflow-sep';
            return sep;
        }

        const item = document.createElement('button');
        item.className = 'bookmark-overflow-item';
        item.dataset.id = entry.id;
        item.dataset.parentFolderId = parentFolderId || '';

        if (parentFolderId) {
            item.draggable = true;
            item.addEventListener('dragstart', (e) => {
                dragSrcId = entry.id; dragSrcFolderId = parentFolderId; bmDragActive = true;
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', entry.id);
                closeDropdown();
            });
            item.addEventListener('dragend', () => {
                dragSrcId = null; dragSrcFolderId = null; bmDragActive = false;
                clearDragClasses(); clearSpring(true);
            });
        }

        if (entry.type === 'folder') {
            item.classList.add('bookmark-overflow-folder-item');
            item.appendChild(makeFolderIcon('bookmark-overflow-folder-icon'));
            const lbl   = document.createElement('span');
            lbl.textContent = entry.title || 'Folder';
            item.appendChild(lbl);
            const arrow = document.createElement('span');
            arrow.className  = 'bookmark-overflow-submenu-arrow';
            arrow.textContent = '▶';
            item.appendChild(arrow);

            // Hover to open (Firefox-style)
            item.addEventListener('mouseenter', () => {
                clearTimeout(overflowCloseTimer);
                clearTimeout(overflowHoverTimer);
                overflowHoverTimer = setTimeout(() => openFolderSubPanel(item, entry), 220);
            });
            item.addEventListener('mouseleave', (e) => {
                clearTimeout(overflowHoverTimer);
                const sub = document.getElementById('bm-subdropdown');
                if (sub && (e.relatedTarget === sub || sub.contains(e.relatedTarget))) return;
                overflowCloseTimer = setTimeout(() => {
                    document.getElementById('bm-subdropdown')?.remove();
                    document.querySelectorAll('#bm-dropdown .has-submenu-open')
                        .forEach(el => el.classList.remove('has-submenu-open'));
                }, 220);
            });
            // Click also opens (fallback)
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                clearTimeout(overflowHoverTimer);
                const existing = document.getElementById('bm-subdropdown');
                if (existing && existing.dataset.forId === entry.id) {
                    existing.remove(); item.classList.remove('has-submenu-open');
                } else {
                    openFolderSubPanel(item, entry);
                }
            });
        } else {
            const fav = faviconFor(entry.url);
            if (fav) {
                const img = document.createElement('img');
                img.className = 'bookmark-bar-favicon'; img.src = fav;
                img.onerror = () => img.remove();
                item.appendChild(img);
            }
            const lbl = document.createElement('span');
            try { lbl.textContent = entry.title || new URL(entry.url).hostname; }
            catch { lbl.textContent = entry.url; }
            item.appendChild(lbl);

            item.addEventListener('click', () => { closeDropdown(); window.tab.loadUrl(activeTabIndex, entry.url); });
            item.addEventListener('auxclick', (e) => {
                if (e.button !== 1) return;
                e.preventDefault(); closeDropdown();
                window.browserBookmarks.openInNewTab(entry.url, false);
            });
        }

        item.addEventListener('contextmenu', (e) => {
            e.preventDefault(); e.stopPropagation();
            window.browserBookmarks.showBarContextMenu({ type: entry.type, id: entry.id, url: entry.url, title: entry.title });
        });
        return item;
    }

    // ── Folder bar click → floating folder WebContentsView ───────────────────
    async function openFolderPanel(btn, entry) {
        const rect = btn.getBoundingClientRect();
        closeDropdown();
        try {
            await window.electronAPI.openFolderDropdown(
                { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
                entry,
            );
        } catch {}
    }

    /**
     * Fill a panel div with the items of a folder entry.
     * Each folder item shows a ▶ arrow; hovering over it for 300ms opens a
     * side-panel (same pattern as the overflow subfolder).
     * Drag from any item sets dragSrcId/FolderId and closes the panel.
     */
    function buildFolderPanelItems(panel, folderEntry) {
        const folderId = folderEntry.id;
        const children = folderEntry.children || [];

        if (!children.length) {
            const empty = document.createElement('div');
            empty.className   = 'bookmark-overflow-empty';
            empty.textContent = '(empty)';
            panel.appendChild(empty);
            return;
        }

        // Local spring state for subfolders within this panel
        let panelSpringTimer = null;
        let panelSpringRow   = null;
        function clearPanelSpring() {
            if (panelSpringTimer) { clearTimeout(panelSpringTimer); panelSpringTimer = null; }
            panelSpringRow = null;
        }

        children.forEach(child => {
            if (child.type === 'divider') {
                const sep = document.createElement('div');
                sep.className = 'bookmark-overflow-sep';
                panel.appendChild(sep);
                return;
            }

            const row = document.createElement('button');
            row.className              = 'bookmark-overflow-item';
            row.dataset.id             = child.id;
            row.dataset.parentFolderId = folderId;

            if (child.type === 'folder') {
                row.classList.add('bookmark-overflow-folder-item');
                row.appendChild(makeFolderIcon('bookmark-overflow-folder-icon'));
                const lbl = document.createElement('span');
                lbl.textContent = child.title || 'Folder';
                row.appendChild(lbl);
                const arr = document.createElement('span');
                arr.className   = 'bookmark-overflow-submenu-arrow';
                arr.textContent = '▶';
                row.appendChild(arr);

                // Click drills in: rebuild the panel contents for the subfolder
                row.addEventListener('click', (e) => {
                    e.stopPropagation();
                    // Clear current contents down to the header+sep then refill
                    const panelEl = document.getElementById('bm-dropdown');
                    if (!panelEl) return;
                    // Remove everything after the separator
                    while (panelEl.children.length > 2) panelEl.removeChild(panelEl.lastChild);
                    // Update header text
                    const hdr = panelEl.querySelector('.bookmark-folder-panel-header');
                    if (hdr) hdr.textContent = child.title || 'Folder';
                    buildFolderPanelItems(panelEl, child);
                });
            } else {
                const fav = faviconFor(child.url);
                if (fav) {
                    const img = document.createElement('img');
                    img.className = 'bookmark-bar-favicon'; img.src = fav;
                    img.onerror   = () => img.remove();
                    row.appendChild(img);
                }
                const lbl = document.createElement('span');
                try { lbl.textContent = child.title || new URL(child.url).hostname; }
                catch { lbl.textContent = child.url; }
                row.appendChild(lbl);

                row.addEventListener('click', () => {
                    closeDropdown();
                    window.tab.loadUrl(activeTabIndex, child.url);
                });
                row.addEventListener('auxclick', (e) => {
                    if (e.button !== 1) return;
                    e.preventDefault();
                    closeDropdown();
                    window.browserBookmarks.openInNewTab(child.url, false);
                });
            }

            // Drag — same pattern as makeDropdownItem
            row.draggable = true;
            row.addEventListener('dragstart', (e) => {
                dragSrcId = child.id; dragSrcFolderId = folderId; bmDragActive = true;
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', child.id);
                closeDropdown();
            });
            row.addEventListener('dragend', () => {
                dragSrcId = null; dragSrcFolderId = null; bmDragActive = false;
                clearDragClasses(); clearSpring(true);
            });

            // Drag-over target: spring into subfolder, or show drop-before line
            row.addEventListener('dragenter', (e) => {
                if (!bmDragActive || dragSrcId === child.id) return;
                e.preventDefault();
                if (panelSpringRow === row) return;
                clearDragClasses(); clearPanelSpring();
                if (child.type === 'folder') {
                    row.classList.add('drag-into');
                    panelSpringRow   = row;
                    panelSpringTimer = setTimeout(() => {
                        if (panelSpringRow !== row) return;
                        panelSpringRow = null; panelSpringTimer = null;
                        const panelEl = document.getElementById('bm-dropdown');
                        if (!panelEl) return;
                        while (panelEl.children.length > 2) panelEl.removeChild(panelEl.lastChild);
                        const hdr = panelEl.querySelector('.bookmark-folder-panel-header');
                        if (hdr) hdr.textContent = child.title || 'Folder';
                        buildFolderPanelItems(panelEl, child);
                    }, 500);
                } else {
                    row.classList.add('drop-before');
                }
            });
            row.addEventListener('dragover', (e) => {
                if (!bmDragActive || dragSrcId === child.id) return;
                e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move';
            });
            row.addEventListener('dragleave', (e) => {
                if (row.contains(e.relatedTarget)) return;
                const moved = e.relatedTarget?.closest?.('.bookmark-overflow-item');
                if (moved && moved !== row) {
                    if (panelSpringRow === row) clearPanelSpring();
                    row.classList.remove('drop-before', 'drag-into');
                }
            });
            row.addEventListener('drop', async (e) => {
                if (!dragSrcId || dragSrcId === child.id) return;
                e.preventDefault(); e.stopPropagation();
                row.classList.remove('drop-before', 'drag-into');
                clearSpring(true); clearPanelSpring();
                if (child.type === 'folder') {
                    await window.browserBookmarks.moveIntoFolder(dragSrcId, child.id, null);
                } else {
                    await window.browserBookmarks.moveIntoFolder(dragSrcId, folderId, child.id);
                }
            });

            row.addEventListener('contextmenu', (e) => {
                e.preventDefault(); e.stopPropagation();
                window.browserBookmarks.showBarContextMenu({
                    type: child.type, id: child.id, url: child.url, title: child.title,
                });
            });

            panel.appendChild(row);
        });

        // Drop on empty space within the panel → append to folder end
        panel.addEventListener('dragover', (e) => {
            if (!bmDragActive || e.target.closest('.bookmark-overflow-item, .bookmark-overflow-sep')) return;
            e.preventDefault(); e.dataTransfer.dropEffect = 'move';
        });
        panel.addEventListener('drop', async (e) => {
            if (!dragSrcId || e.target.closest('.bookmark-overflow-item, .bookmark-overflow-sep')) return;
            e.preventDefault(); clearSpring(true);
            await window.browserBookmarks.moveIntoFolder(dragSrcId, folderId, null);
        });
    }

    function openFolderSubPanel(anchorItem, entry) {
        document.querySelectorAll('#bm-dropdown .has-submenu-open')
            .forEach(el => el.classList.remove('has-submenu-open'));
        document.getElementById('bm-subdropdown')?.remove();

        const sub = document.createElement('div');
        sub.id            = 'bm-subdropdown';
        sub.className     = 'bookmark-overflow-dropdown';
        sub.dataset.forId = entry.id;

        if (!entry.children?.length) {
            const empty = document.createElement('div');
            empty.className   = 'bookmark-overflow-empty';
            empty.textContent = '(empty)';
            sub.appendChild(empty);
        } else {
            entry.children.forEach(child => sub.appendChild(makeDropdownItem(child, entry.id)));
        }

        document.body.appendChild(sub);
        const r = anchorItem.getBoundingClientRect();
        // Flip left if sub would overflow the right edge
        const subW = 200;
        const spaceRight = window.innerWidth - r.right;
        sub.style.left = (spaceRight >= subW ? r.right : r.left - subW) + 'px';
        sub.style.top  = r.top + 'px';
        anchorItem.classList.add('has-submenu-open');

        // Keep sub open while cursor is inside it
        sub.addEventListener('mouseenter', () => clearTimeout(overflowCloseTimer));
        sub.addEventListener('mouseleave', (e) => {
            if (e.relatedTarget === anchorItem || anchorItem.contains(e.relatedTarget)) return;
            overflowCloseTimer = setTimeout(() => {
                sub.remove();
                anchorItem.classList.remove('has-submenu-open');
            }, 220);
        });
    }

    // ── Drag and drop ─────────────────────────────────────────────────────────

    let dragSrcId       = null;
    let dragSrcFolderId = null;
    let bmDragActive    = false;
    let externDragId    = null;
    let externLastTarget = null;

    // Spring-load state — folder opens after a hover delay during drag
    let springTimer    = null;
    let springFolderId = null;
    let springOpen     = false;

    // Overflow dropdown subfolder hover-open state
    let overflowHoverTimer = null;
    let overflowCloseTimer = null;

    function clearDragClasses() {
        document.querySelectorAll('.drag-into, .drop-before')
            .forEach(el => el.classList.remove('drag-into', 'drop-before'));
    }

    function clearSpring(closePanel = false) {
        if (springTimer) { clearTimeout(springTimer); springTimer = null; }
        springFolderId = null;
        if (closePanel && springOpen) {
            closeDropdown();
            window.electronAPI.closeFolderDropdown();
            springOpen = false;
        }
    }

    // Prevent bookmark drags from bubbling to the tab bar's own dragover handler
    document.addEventListener('dragover', (e) => {
        if (!bmDragActive) return;
        const inBar      = !!e.target.closest('#bookmark-bar');
        const inDropdown = !!e.target.closest('#bm-dropdown');
        if (!inBar && !inDropdown) e.stopPropagation();
    }, true);

    function makeDraggable(el, item, getAllFn) {
        el.draggable = true;

        el.addEventListener('dragstart', (e) => {
            dragSrcId = item.id; dragSrcFolderId = null; bmDragActive = true;
            el.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', item.id);
        });

        el.addEventListener('dragend', () => {
            dragSrcId = null; dragSrcFolderId = null; bmDragActive = false;
            el.classList.remove('dragging');
            clearDragClasses(); clearSpring(true);
        });

        el.addEventListener('dragover', (e) => {
            if (!bmDragActive) return;
            e.preventDefault(); e.dataTransfer.dropEffect = 'move';
            clearDragClasses();

            if (item.type === 'folder') {
                if (springOpen && springFolderId === item.id) {
                    el.classList.add('drag-into');
                } else {
                    el.classList.add('drop-before');
                    if (springFolderId !== item.id) {
                        clearSpring(false);
                        springFolderId = item.id;
                        springTimer = setTimeout(async () => {
                            springOpen = true;
                            el.classList.remove('drop-before');
                            el.classList.add('drag-into');
                            const rect = el.getBoundingClientRect();
                            closeDropdown();
                            try {
                                await window.electronAPI.openFolderDropdown(
                                    { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
                                    item,
                                );
                            } catch {}
                        }, 500);
                    }
                }
            } else {
                el.classList.add('drop-before');
            }
        });

        el.addEventListener('dragleave', (e) => {
            clearDragClasses();
            if (item.type === 'folder' && springFolderId === item.id) {
                const dropdown = document.getElementById('bm-dropdown');
                if (dropdown?.contains(e.relatedTarget)) return;
                clearSpring(false);
            }
        });

        el.addEventListener('drop', async (e) => {
            e.preventDefault(); clearDragClasses();
            const wasSpringOpen = springOpen;
            clearSpring(true);
            if (!dragSrcId || dragSrcId === item.id) return;

            if (dragSrcFolderId) {
                await window.browserBookmarks.moveOutOfFolder(dragSrcId, dragSrcFolderId, item.id);
            } else if (item.type === 'folder' && wasSpringOpen) {
                await window.browserBookmarks.moveIntoFolder(dragSrcId, item.id);
            } else {
                const all  = getAllFn();
                const ids  = all.map(b => b.id);
                const from = ids.indexOf(dragSrcId);
                const to   = ids.indexOf(item.id);
                if (from === -1 || to === -1) return;
                ids.splice(from, 1); ids.splice(to, 0, dragSrcId);
                await window.browserBookmarks.reorder(ids);
            }
        });
    }

    /** Build a spring-loaded folder panel where every row is a drop target. */
    function buildSpringPanel(panel, folderEntry) {
        const children = folderEntry.children || [];

        function makeDropRow(child) {
            const row = makeDropdownItem(child, folderEntry.id);

            row.addEventListener('dragenter', (e) => {
                if (!bmDragActive || dragSrcId === child.id) return;
                e.preventDefault();
                clearDragClasses();
                // Show drop target. Folders get drag-into (drop inside), bookmarks get drop-before.
                // No sub-spring: rebuilding the panel DOM during a live drag causes macOS to
                // fire spurious dragleave/dragend. Drop onto a folder moves into it directly.
                row.classList.add(child.type === 'folder' ? 'drag-into' : 'drop-before');
            });

            row.addEventListener('dragover', (e) => {
                if (!bmDragActive || dragSrcId === child.id) return;
                e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move';
            });

            row.addEventListener('dragleave', (e) => {
                if (row.contains(e.relatedTarget)) return;
                row.classList.remove('drop-before', 'drag-into');
            });

            row.addEventListener('drop', async (e) => {
                if (!dragSrcId || dragSrcId === child.id) return;
                e.preventDefault(); e.stopPropagation();
                row.classList.remove('drop-before', 'drag-into');
                clearSpring(true);
                if (child.type === 'folder') {
                    await window.browserBookmarks.moveIntoFolder(dragSrcId, child.id, null);
                } else {
                    await window.browserBookmarks.moveIntoFolder(dragSrcId, folderEntry.id, child.id);
                }
            });
            return row;
        }

        if (!children.length) {
            const empty = document.createElement('div');
            empty.className   = 'bookmark-overflow-empty';
            empty.textContent = '(empty)';
            panel.appendChild(empty);
        } else {
            children.forEach(child => panel.appendChild(makeDropRow(child)));
        }

        panel.addEventListener('dragover', (e) => {
            if (!bmDragActive || e.target.closest('.bookmark-overflow-item, .bookmark-overflow-sep')) return;
            e.preventDefault(); e.dataTransfer.dropEffect = 'move';
        });
        panel.addEventListener('drop', async (e) => {
            if (!dragSrcId || e.target.closest('.bookmark-overflow-item, .bookmark-overflow-sep')) return;
            e.preventDefault(); clearSpring(true);
            await window.browserBookmarks.moveIntoFolder(dragSrcId, folderEntry.id, null);
        });
    }

    // ── Extern drag (from folder dropdown to bookmark bar) ────────────────────

    window.electronAPI.onExternBookmarkDragStart((id, folderId) => {
        dragSrcId = id; dragSrcFolderId = folderId;
        bmDragActive = true; externDragId = id; externLastTarget = null;
    });

    window.electronAPI.onExternBookmarkDragPosition((x, y) => {
        if (!externDragId) return;
        clearDragClasses();
        const el           = document.elementFromPoint(x, y);
        const barItem      = el?.closest('.bookmark-bar-item, .bookmark-bar-divider');
        const overflowItem = el?.closest('.bookmark-overflow-item');

        if (barItem) {
            externLastTarget = barItem;
            barItem.classList.add(barItem.classList.contains('bookmark-bar-folder') ? 'drag-into' : 'drop-before');
        } else if (overflowItem && overflowItem.dataset.id && overflowItem.dataset.id !== externDragId) {
            externLastTarget = overflowItem;
            overflowItem.classList.add(
                overflowItem.classList.contains('bookmark-overflow-folder-item') ? 'drag-into' : 'drop-before'
            );
        } else {
            externLastTarget = null;
        }
    });

    window.electronAPI.onExternBookmarkDragEnd(async () => {
        if (!externDragId) return;
        const srcId   = dragSrcId, srcFolder = dragSrcFolderId, target = externLastTarget;
        dragSrcId = null; dragSrcFolderId = null; bmDragActive = false;
        externDragId = null; externLastTarget = null;
        clearDragClasses(); clearSpring(true);

        if (!target || !srcId) return;
        const targetId = target.dataset.id;
        if (!targetId || targetId === srcId) return;

        // Target is inside a spring-opened overflow panel (subfolder)
        if (target.classList.contains('bookmark-overflow-item')) {
            const parentFolderId = target.dataset.parentFolderId;
            if (target.classList.contains('bookmark-overflow-folder-item')) {
                // Drop onto a folder → append to its end
                await window.browserBookmarks.moveIntoFolder(srcId, targetId, null);
            } else if (parentFolderId) {
                // Drop before a bookmark inside the spring folder
                await window.browserBookmarks.moveIntoFolder(srcId, parentFolderId, targetId);
            }
            return;
        }

        // Target is a bar item
        if (target.classList.contains('bookmark-bar-folder')) {
            await window.browserBookmarks.moveIntoFolder(srcId, targetId);
        } else if (srcFolder) {
            await window.browserBookmarks.moveOutOfFolder(srcId, srcFolder, targetId);
        } else {
            const all  = await window.browserBookmarks.getAll();
            const ids  = all.map(b => b.id);
            const from = ids.indexOf(srcId), to = ids.indexOf(targetId);
            if (from !== -1 && to !== -1) {
                ids.splice(from, 1); ids.splice(to, 0, srcId);
                await window.browserBookmarks.reorder(ids);
            }
        }
    });

    // ── Bar item builder ──────────────────────────────────────────────────────

    function makeBarElement(entry, bookmarks) {
        if (entry.type === 'divider') {
            const el = document.createElement('div');
            el.className = 'bookmark-bar-divider'; el.dataset.id = entry.id;
            makeDraggable(el, entry, () => bookmarks);
            el.addEventListener('contextmenu', (e) => {
                e.preventDefault(); e.stopPropagation();
                window.browserBookmarks.showBarContextMenu({ type: 'divider', id: entry.id });
            });
            return el;
        }

        const btn = document.createElement('button');
        btn.dataset.id = entry.id;

        if (entry.type === 'folder') {
            btn.className = 'bookmark-bar-item bookmark-bar-folder';
            btn.title     = entry.title || 'Folder';
            btn.appendChild(makeFolderIcon('bookmark-folder-icon'));
            const lbl = document.createElement('span');
            lbl.className   = 'bookmark-bar-label';
            lbl.textContent = entry.title || 'Folder';
            btn.appendChild(lbl);
            btn.addEventListener('click', () => openFolderPanel(btn, entry));
        } else {
            btn.className = 'bookmark-bar-item';
            btn.title     = entry.title || entry.url;
            const fav = faviconFor(entry.url);
            if (fav) {
                const img = document.createElement('img');
                img.className = 'bookmark-bar-favicon'; img.src = fav;
                img.onerror = () => img.remove();
                btn.appendChild(img);
            }
            const lbl = document.createElement('span');
            lbl.className = 'bookmark-bar-label';
            try { lbl.textContent = entry.title || new URL(entry.url).hostname; }
            catch { lbl.textContent = entry.url; }
            btn.appendChild(lbl);
            btn.addEventListener('click', () => window.tab.loadUrl(activeTabIndex, entry.url));
            btn.addEventListener('auxclick', (e) => {
                if (e.button !== 1) return;
                e.preventDefault();
                window.browserBookmarks.openInNewTab(entry.url, false);
            });
        }

        btn.addEventListener('contextmenu', (e) => {
            e.preventDefault(); e.stopPropagation();
            window.browserBookmarks.showBarContextMenu({ type: entry.type, id: entry.id, url: entry.url, title: entry.title });
        });
        makeDraggable(btn, entry, () => bookmarks);
        return btn;
    }

    // ── Bar render ────────────────────────────────────────────────────────────

    function reportChromeHeight() {
        const showBar = bookmarkBarVisible && hasBookmarks;
        bookmarkBar.classList.toggle('hidden', !showBar);
        window.electronAPI.reportChromeHeight(showBar ? 30 : 0);  /* must match .bookmark-bar height */
    }
    reportChromeHeight();

    async function refreshBookmarkBar() {
        if (renamingFolderId) return;
        closeDropdown();
        bookmarkBarItems.innerHTML = '';
        if (!bookmarkBarVisible) { hasBookmarks = false; reportChromeHeight(); return; }

        const seq = ++refreshSeq;
        let bookmarks = [];
        try { bookmarks = await window.browserBookmarks.getAll(); } catch {}
        if (seq !== refreshSeq) return; // stale — a newer refresh started

        hasBookmarks = bookmarks.length > 0;
        reportChromeHeight();
        if (!hasBookmarks) return;

        const rendered = [];
        bookmarks.forEach(entry => {
            const el = makeBarElement(entry, bookmarks);
            bookmarkBarItems.appendChild(el);
            rendered.push({ el, entry });
        });

        // Overflow detection: hide items that don't fit and add a "» N" button
        requestAnimationFrame(() => {
            const barRight    = bookmarkBarItems.getBoundingClientRect().right;
            const OVERFLOW_W  = 40;
            const anyOverflow = rendered.some(r => r.el.getBoundingClientRect().right > barRight);
            if (!anyOverflow) return;

            let overflowStart = -1;
            for (let i = 0; i < rendered.length; i++) {
                if (rendered[i].el.getBoundingClientRect().right > barRight - OVERFLOW_W) {
                    overflowStart = i; break;
                }
            }
            if (overflowStart !== -1) {
                for (let i = overflowStart; i < rendered.length; i++) rendered[i].el.style.display = 'none';
                const hidden = rendered.slice(overflowStart).map(r => r.entry);
                const count  = hidden.filter(e => e.type !== 'divider').length;
                const more   = document.createElement('button');
                more.className   = 'bookmark-bar-item bookmark-bar-more';
                more.textContent = `» ${count}`;
                more.title       = `${count} more`;
                more.addEventListener('click', (e) => {
                    e.stopPropagation();
                    openDropdown(more, '__overflow__', (panel) => {
                        // Pass '__root__' as parentFolderId so drag handlers are attached
                        hidden.forEach(entry => panel.appendChild(makeDropdownItem(entry, '__root__')));
                    });
                });
                bookmarkBarItems.appendChild(more);
            }
        });
    }

    // ── Bar context menu events ───────────────────────────────────────────────

    bookmarkBar.addEventListener('contextmenu', (e) => {
        if (e.target.closest('.bookmark-bar-item, .bookmark-bar-divider')) return;
        e.preventDefault();
        window.browserBookmarks.showBarContextMenu({ type: 'bar-bg', bookmarkBarVisible });
    });

    bookmarkBar.addEventListener('dragover', (e) => {
        if (!bmDragActive || !dragSrcFolderId) return;
        if (e.target.closest('.bookmark-bar-item, .bookmark-bar-divider')) return;
        e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    });
    bookmarkBar.addEventListener('drop', async (e) => {
        if (!dragSrcId || !dragSrcFolderId) return;
        if (e.target.closest('.bookmark-bar-item, .bookmark-bar-divider')) return;
        e.preventDefault();
        await window.browserBookmarks.moveOutOfFolder(dragSrcId, dragSrcFolderId, null);
    });

    new ResizeObserver(() => { if (bookmarkBarVisible && hasBookmarks) refreshBookmarkBar(); })
        .observe(bookmarkBarItems);

    // ── Bookmark ★ button ─────────────────────────────────────────────────────

    async function updateBookmarkBtn(url) {
        if (!url || url === 'newtab' || url.startsWith('file://')) {
            bookmarkBtn.classList.remove('bookmarked'); return;
        }
        try {
            const has = await window.browserBookmarks.has(url);
            bookmarkBtn.classList.toggle('bookmarked', has);
        } catch {}
    }

    bookmarkBtn.addEventListener('click', async () => {
        if (!currentTabUrl || currentTabUrl === 'newtab' || currentTabUrl.startsWith('file://')) return;
        const rect = bookmarkBtn.getBoundingClientRect();
        let hasObj = false, bkmkTitle = currentTabTitle || currentTabUrl, bkmkId = null;
        try {
            const all = await window.browserBookmarks.getAll();
            const existing = all.find(b => b.type === 'bookmark' && b.url === currentTabUrl);
            if (existing) { hasObj = true; bkmkTitle = existing.title || existing.url; bkmkId = existing.id; }
        } catch {}
        await window.electronAPI.openBookmarkPrompt(
            { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
            currentTabUrl, bkmkTitle, hasObj, bkmkId,
        );
    });

    // ── Bookmark bar event wiring ─────────────────────────────────────────────

    function initBookmarkBar() {
        window.electronAPI.onBookmarkAddPrompt(() => {
            if (!currentTabUrl || currentTabUrl === 'newtab' || currentTabUrl.startsWith('file://')) return;
            const rect = bookmarkBtn.getBoundingClientRect();
            window.electronAPI.openBookmarkPrompt(
                { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
                currentTabUrl, currentTabTitle, false, null,
            );
        });

        window.electronAPI.onBookmarkEditPrompt(({ id, url, title }) => {
            const rect = bookmarkBtn.getBoundingClientRect();
            window.electronAPI.openBookmarkPrompt(
                { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
                url, title, true, id,
            );
        });

        window.electronAPI.onBookmarkFolderRename(({ id, title }) => {
            const rect = bookmarkBtn.getBoundingClientRect();
            window.electronAPI.openBookmarkPrompt(
                { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
                null, title, true, id, 'folder-rename',
            );
        });

        window.electronAPI.onBookmarkNewFolderPrompt(async () => {
            window.electronAPI.closeFolderDropdown();
            const id = await window.browserBookmarks.addFolder('New Folder');
            await refreshBookmarkBar();
            startInlineBarRename(id, 'New Folder');
        });

        window.electronAPI.onToggleBookmarkBar(() => {
            bookmarkBarVisible = !bookmarkBarVisible;
            window.northstarSettings.set('bookmarkBarVisible', bookmarkBarVisible);
            refreshBookmarkBar();
        });

        window.browserBookmarks.onChanged(() => { refreshBookmarkBar(); updateBookmarkBtn(currentTabUrl); });
        window.electronAPI.onBookmarkPromptClosed(() => updateBookmarkBtn(currentTabUrl));

        refreshBookmarkBar();
    }

    /** Inline rename for a folder label directly in the bookmark bar. */
    function startInlineBarRename(folderId, defaultName) {
        const btn = bookmarkBarItems.querySelector(`[data-id="${folderId}"]`);
        if (!btn) return;
        const lbl = btn.querySelector('.bookmark-bar-label');
        if (!lbl) return;

        renamingFolderId = folderId;
        lbl.style.display = 'none';

        const input = document.createElement('input');
        input.className = 'bookmark-bar-rename-input';
        input.value     = defaultName || '';
        input.size      = Math.max((defaultName || '').length, 8);
        btn.appendChild(input);

        btn.addEventListener('click', (e) => e.stopPropagation(), { capture: true, once: true });
        requestAnimationFrame(() => { input.focus(); input.select(); });

        let done = false;

        async function commit() {
            if (done) return; done = true;
            const name = input.value.trim() || 'New Folder';
            renamingFolderId = null;
            await window.browserBookmarks.updateById(folderId, { title: name });
        }

        function cancel() {
            if (done) return; done = true;
            renamingFolderId = null;
            input.removeEventListener('blur', commit);
            refreshBookmarkBar();
        }

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter')  { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        });
        input.addEventListener('blur', commit, { once: true });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Tab bar
    // ─────────────────────────────────────────────────────────────────────────

    function initTabBar() {
        // Another window's torn-off tab is hovering over our strip → light up.
        window.dragdrop.onMergeHover?.((v) => tabBar.classList.toggle('merge-target', !!v));
        window.pinActiveTab = () => window.tab.pin(activeTabIndex);

        // ── IPC events from main process ──────────────────────────────────────

        window.tab.onTabCreated((_e, data) => {
            tabPrivate.set(data.index, !!data.private);
            createTabButton(data.index, data.title, data.afterIndex ?? null, data.active !== false, !!data.private);
            setTimeout(() => { updateTabWidths(data.totalTabs); updateScrollShadows(); }, 10);
        });

        // Speaker on audible tabs; mic/camera in danger colour while recording.
        window.tab.onMediaIndicator?.((_e, d) => updateTabIndicator(d.index, d));

        window.tab.onTabRemoved((_e, data) => {
            tabUrls.delete(data.index);
            tabPrivate.delete(data.index);
            tabLoading.delete(data.index);
            removeTabButton(data.index);
            hideSuggestions();
            setTimeout(() => { updateTabWidths(data.totalTabs); updateScrollShadows(); }, 10);
        });

        window.tab.onTabSwitched((_e, data) => {
            activeTabIndex = data.index;
            if (data.url) tabUrls.set(data.index, data.url);
            setActiveTab(data.index);
            updateReloadButton();
            updateSearchBarUrl(data.url || '');
            currentTabUrl = data.url || '';
            updateBookmarkBtn(currentTabUrl);
            tabs.get(data.index)?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
            updateScrollShadows();
            // Show per-tab private indicator on address bar (only in non-private windows)
            if (!isPrivateWindow) {
                if (tabPrivate.get(data.index)) {
                    document.documentElement.setAttribute('data-private-tab', 'true');
                } else {
                    document.documentElement.removeAttribute('data-private-tab');
                }
            }
        });

        window.tab.onUrlUpdated((_e, data) => {
            if (data.url) tabUrls.set(data.index, data.url);
            if (data.private !== undefined) tabPrivate.set(data.index, !!data.private);
            if (data.index === activeTabIndex) {
                updateSearchBarUrl(data.url);
                currentTabUrl   = data.url   || '';
                currentTabTitle = data.title || '';
                updateBookmarkBtn(currentTabUrl);
                // Sync private-tab attribute
                if (!isPrivateWindow) {
                    if (tabPrivate.get(data.index)) {
                        document.documentElement.setAttribute('data-private-tab', 'true');
                    } else {
                        document.documentElement.removeAttribute('data-private-tab');
                    }
                }
            }
            updateTabTitle(data.index, data.title || data.url, data.favicon);
        });

        window.tab.onNavigationUpdated((_e, data) => {
            if (data.index === activeTabIndex) updateNavigationButtons(data.canGoBack, data.canGoForward);
        });

        window.tab.onTabLoading((_e, data) => {
            setTabLoading(data.index, data.loading);
        });

        window.tabsUI?.onPinTab((index) => {
            const btn = document.querySelector(`#tabs-container .tab-button[data-index="${index}"]`);
            if (!btn) return;
            const isPinned    = btn.classList.toggle('pinned');
            btn.dataset.pinned = isPinned ? '1' : '';
            // Firefox keeps pinned tabs in a block at the start of the strip:
            // pinning moves the tab to the end of that block, unpinning drops
            // it right after the block.
            const firstUnpinned = [...tabsContainer.querySelectorAll('.tab-button')]
                .find(b => b !== btn && !b.classList.contains('pinned'));
            tabsContainer.insertBefore(btn, firstUnpinned || null);
            const ordered = [...tabsContainer.querySelectorAll('.tab-button')].map(el => parseInt(el.dataset.index));
            if (ordered.length) window.tab.reorder(ordered);
            updateTabWidths(tabs.size);
            updateScrollShadows();
        });

        // Called by the main process (executeJavaScript) when a tab dragged
        // from ANOTHER window drops on our strip: x (px from our left edge) →
        // where to insert it. Returns the data-index of the tab to insert
        // after, -1 for "at the front", or null to append at the end.
        window.__tabDropIndex = (x) => {
            const btns = [...tabsContainer.querySelectorAll('.tab-button')];
            if (!btns.length) return null;
            let after = null; // null → before the first tab
            for (const b of btns) {
                const r = b.getBoundingClientRect();
                if (x >= r.left + r.width / 2) after = b;
                else break;
            }
            // Incoming tabs are unpinned — clamp them past the pinned block.
            const lastPinned = btns.filter(b => b.classList.contains('pinned')).pop();
            if (lastPinned && (!after || after.classList.contains('pinned'))) after = lastPinned;
            if (!after) return -1;
            return parseInt(after.dataset.index);
        };

        // ── Drop text / URLs onto the tab bar to open a new tab ──────────────

        function extractDropUrl(dt) {
            const uriList = dt.getData('text/uri-list');
            if (uriList) {
                const first = uriList.split(/\r?\n/).map(s => s.trim()).find(s => s && !s.startsWith('#'));
                if (first) return first;
            }
            const text = dt.getData('text/plain');
            if (text && text.trim() && isNaN(text.trim())) return text.trim();
            return null;
        }

        tabBar.addEventListener('dragover', (e) => {
            // Only accept external drops (not tab-reorder drags which carry numeric plain text)
            const types = e.dataTransfer.types;
            if (types.includes('text/uri-list') || types.includes('text/plain') || types.includes('text/html')) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
            }
        });

        tabBar.addEventListener('drop', async (e) => {
            const url = extractDropUrl(e.dataTransfer);
            if (!url) return;
            e.preventDefault();
            e.stopPropagation();
            await window.tab.addLazy(url);
        });

        // ── Scroll controls ───────────────────────────────────────────────────

        const tabScrollLeft  = document.getElementById('tab-scroll-left');
        const tabScrollRight = document.getElementById('tab-scroll-right');
        let   scrollInterval = null;

        const scrollBy = (amt) => tabsContainer.scrollBy({ left: amt, behavior: 'smooth' });
        const startScroll = (amt) => { scrollBy(amt); scrollInterval = setInterval(() => scrollBy(amt), 200); };
        const stopScroll  = ()    => { clearInterval(scrollInterval); scrollInterval = null; };

        tabScrollLeft.addEventListener('mousedown', () => startScroll(-160));
        tabScrollRight.addEventListener('mousedown',() => startScroll(160));
        tabScrollLeft.addEventListener('click',  () => scrollBy(-160));
        tabScrollRight.addEventListener('click', () => scrollBy(160));
        document.addEventListener('mouseup', stopScroll);

        tabsContainer.addEventListener('wheel', (e) => {
            e.preventDefault();
            tabsContainer.scrollBy({ left: e.deltaY !== 0 ? e.deltaY : e.deltaX, behavior: 'smooth' });
        }, { passive: false });

        tabsContainer.addEventListener('scroll', updateScrollShadows);
        window.addEventListener('resize', () => setTimeout(() => { updateTabWidths(tabs.size); updateScrollShadows(); }, 100));

        setTimeout(() => { if (tabs.size > 0) { updateTabWidths(tabs.size); updateScrollShadows(); } }, 100);
    }

    // ── Tab DOM helpers ───────────────────────────────────────────────────────

    function createTabButton(index, title, afterIndex = null, shouldActivate = true, isPrivate = false) {
        if (tabs.has(index)) return;

        const btn = document.createElement('div');
        btn.className      = 'tab-button';
        btn.dataset.index  = index;
        btn.draggable      = false;  // pointer-tracked drag below, not HTML5 DnD
        // Not keyboard-focusable: the tab strip should never be a Tab-key stop.
        btn.tabIndex       = -1;
        if (isPrivate) btn.dataset.private = 'true';

        const titleSpan   = document.createElement('span');
        titleSpan.className   = 'tab-title';
        titleSpan.textContent = title || `Tab ${index + 1}`;

        const closeBtn = document.createElement('button');
        closeBtn.className = 'tab-close';
        closeBtn.tabIndex  = -1;
        closeBtn.innerHTML = '×';
        closeBtn.onclick   = (e) => { e.stopPropagation(); window.tab.remove(parseInt(index)); };

        if (isPrivate) {
            const shield = document.createElement('span');
            shield.className = 'tab-private-icon';
            shield.title = 'Private tab';
            shield.innerHTML = '<svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor"><path d="M8 1L2 3.5V8c0 3.3 2.5 5.7 6 7 3.5-1.3 6-3.7 6-7V3.5L8 1zm0 6.5h4c-.3 2.2-1.8 4-4 5.1V7.5H4V5l4-1.7V7.5z"/></svg>';
            btn.appendChild(shield);
        }
        btn.appendChild(titleSpan);
        btn.appendChild(closeBtn);

        btn.addEventListener('mousedown', (e) => {
            if (e.button !== 1) return;
            e.preventDefault();
        });
        btn.addEventListener('auxclick', (e) => {
            if (e.button !== 1) return;
            e.preventDefault();
            e.stopPropagation();
            window.tab.remove(parseInt(index));
        });

        // Firefox-style tab drag: pointer-tracked, and NOTHING moves until the
        // button is released.
        //  - inside the strip → live reorder preview
        //  - outside the strip → the tab ghosts; on RELEASE it either moves
        //    into the window under the cursor (dropped on its tab strip, at
        //    the drop position) or detaches into a new window there
        //  - Escape aborts the whole gesture and restores the original order
        const TEAR_MARGIN = 34;
        btn.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 || e.target.closest('.tab-close')) return;
            // Firefox selects a tab on mousedown, not on click-release — so a
            // drag always moves the tab you're looking at.
            if (parseInt(index) !== activeTabIndex) window.tab.switch(parseInt(index));
            const startX = e.clientX, startY = e.clientY;
            let mode = 'idle';           // idle → drag
            let outside = false;         // pointer currently beyond the strip
            let savedOrder = null;       // DOM order at drag start, for cancel

            const restoreOrder = () => {
                if (!savedOrder) return;
                // Skip buttons whose tab was closed mid-drag — re-appending a
                // detached node would resurrect a dead tab in the strip.
                for (const el of savedOrder) if (el.isConnected) tabsContainer.appendChild(el);
            };

            const onMove = (ev) => {
                if (mode === 'idle' && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 5) {
                    mode = 'drag';
                    savedOrder = [...tabsContainer.querySelectorAll('.tab-button')];
                    btn.classList.add('dragging');
                    document.documentElement.classList.add('tab-dragging'); // kills text selection
                    window.dragdrop.dragTrack?.(true);   // main raises windows under the cursor
                }
                if (mode !== 'drag') return;

                // Leaving the strip vertically OR the window horizontally both
                // count as "outside" (Firefox tears off / merges either way).
                const barR = tabBar.getBoundingClientRect();
                const out = ev.clientY < barR.top - TEAR_MARGIN || ev.clientY > barR.bottom + TEAR_MARGIN
                         || ev.clientX < -TEAR_MARGIN || ev.clientX > window.innerWidth + TEAR_MARGIN;
                if (out !== outside) {
                    outside = out;
                    btn.classList.toggle('drag-outside', out);
                }
                if (out) { stopEdgeScroll(); return; }
                edgeAutoScroll(ev.clientX);
                placeDraggedTab(btn, ev.clientX);
            };

            const cleanup = () => {
                document.removeEventListener('pointermove', onMove);
                document.removeEventListener('pointerup', onUp);
                document.removeEventListener('pointercancel', onCancel);
                document.removeEventListener('keydown', onKey, true);
                document.documentElement.classList.remove('tab-dragging');
                btn.classList.remove('dragging', 'drag-outside');
                stopEdgeScroll();
                window.dragdrop.dragTrack?.(false);
            };

            const finish = async (drop) => {
                const wasMode = mode, wasOutside = outside;
                cleanup();
                if (wasMode !== 'drag') return;
                if (!drop) { restoreOrder(); return; }                    // aborted
                if (!wasOutside) {                                        // reorder commit
                    const ordered = [...tabsContainer.querySelectorAll('.tab-button')].map(el => parseInt(el.dataset.index));
                    if (ordered.length) window.tab.reorder(ordered);
                    return;
                }
                // Released outside the strip → main decides: move into the
                // window under the cursor, or detach into a new one.
                const url = await window.tab.getTabUrl(index);
                const res = await window.dragdrop.drop(index, url);
                if (res === 'none' || res === 'window-moved') restoreOrder();
            };
            const onUp     = () => finish(true);
            const onCancel = () => finish(false);
            const onKey    = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); finish(false); } };

            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp);
            document.addEventListener('pointercancel', onCancel);
            document.addEventListener('keydown', onKey, true);
        });

        // afterIndex: tab index to insert after, -1 for the front, null → end
        const afterBtn = (afterIndex !== null && afterIndex !== -1) ? tabs.get(afterIndex) : null;
        if (afterIndex === -1) {
            tabsContainer.insertBefore(btn, tabsContainer.firstChild);
        } else if (afterBtn) {
            tabsContainer.insertBefore(btn, afterBtn.nextSibling);
        } else {
            tabsContainer.appendChild(btn);
        }
        tabs.set(index, btn);
        if (shouldActivate) {
            setActiveTab(index);
        }
        updateScrollShadows();
    }

    function removeTabButton(index) {
        const btn = tabs.get(index);
        if (btn) { btn.remove(); tabs.delete(index); }
    }

    function setActiveTab(index) {
        tabs.forEach(tab => tab.classList.remove('active'));
        const active = tabs.get(index);
        if (active) active.classList.add('active');
        activeTabIndex = index;
    }

    // ── Tab media indicator: audible/muted speaker, recording mic/camera ─────
    const INDICATOR_SVG = {
        audio:  '<svg viewBox="0 0 20 20" width="11" height="11" fill="currentColor"><path d="M3.5 7.5v5H7l4 3.5v-12L7 7.5H3.5z"/><path d="M13.5 7a4 4 0 010 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
        muted:  '<svg viewBox="0 0 20 20" width="11" height="11" fill="currentColor"><path d="M3.5 7.5v5H7l4 3.5v-12L7 7.5H3.5z"/><path d="M13 8l4 4M17 8l-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
        mic:    '<svg viewBox="0 0 20 20" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="7.5" y="2.5" width="5" height="9" rx="2.5"/><path d="M4.5 9.5a5.5 5.5 0 0011 0M10 15v2.5"/></svg>',
        camera: '<svg viewBox="0 0 20 20" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5.5" width="11" height="9" rx="1.5"/><path d="M13 9l5-2.5v7L13 11"/></svg>',
    };
    const INDICATOR_TITLE = {
        audio:  'Playing audio — click to mute',
        muted:  'Muted — click to unmute',
        mic:    'Using your microphone',
        camera: 'Using your camera',
    };

    function updateTabIndicator(index, d) {
        const btn = tabs.get(index);
        if (!btn) return;
        let el = btn.querySelector('.tab-indicator');
        // Recording outranks audio: you must always see that a tab has your mic.
        // A muted tab keeps its (crossed) speaker while media plays, so there's
        // always something to click to unmute.
        const kind = d.capture === 'camera' ? 'camera'
                   : d.capture === 'mic'    ? 'mic'
                   : d.muted && d.playing   ? 'muted'
                   : d.audible              ? 'audio'
                   : null;
        if (!kind) { el?.remove(); return; }
        if (!el) {
            el = document.createElement('span');
            el.className = 'tab-indicator';
            // The speaker is a button: click toggles the tab's audio without
            // switching to it.
            el.addEventListener('click', (e) => {
                if (el.dataset.kind !== 'audio' && el.dataset.kind !== 'muted') return;
                e.stopPropagation();
                window.tab.toggleMute(index);
            });
            el.addEventListener('mousedown', (e) => e.stopPropagation());
            btn.insertBefore(el, btn.querySelector('.tab-title'));
        }
        if (el.dataset.kind !== kind) {
            el.dataset.kind = kind;
            el.innerHTML = INDICATOR_SVG[kind];
            el.classList.toggle('rec', kind === 'mic' || kind === 'camera');
            el.classList.toggle('clickable', kind === 'audio' || kind === 'muted');
            el.title = INDICATOR_TITLE[kind];
        }
    }

    function updateTabTitle(index, title, faviconUrl) {
        const btn = tabs.get(index);
        if (!btn) return;
        const span = btn.querySelector('.tab-title');
        if (span) { span.textContent = title || `Tab ${index + 1}`; btn.title = span.textContent; }

        let faviconEl = btn.querySelector('.tab-favicon');
        if (faviconUrl) {
            if (!faviconEl) {
                faviconEl = document.createElement('img');
                faviconEl.className = 'tab-favicon';
                btn.insertBefore(faviconEl, span);
            }
            faviconEl.src     = faviconUrl;
            faviconEl.alt     = '';
            faviconEl.onerror = () => setFaviconFallback(faviconEl, faviconUrl);
        } else if (faviconEl) {
            faviconEl.remove();
        }
    }

    function setFaviconFallback(el, url) {
        const div = document.createElement('div');
        div.className = 'tab-favicon default';
        try { div.textContent = url ? new URL(url).hostname.charAt(0).toUpperCase() : '◉'; }
        catch { div.textContent = '◉'; }
        el.replaceWith(div);
    }

    function updateTabWidths(_total?: number) {
        const count = tabs.size;
        if (!count) return;
        requestAnimationFrame(() => {
            // The container is content-sized now, so its own width isn't the
            // space available for tabs. container + spacer is the full slack
            // (invariant to tab widths); reserve a strip of it for dragging the
            // window so the tabs never consume every last pixel.
            const DRAG_RESERVE = 46;
            const avail        = tabsContainer.offsetWidth + (tabDragSpacer?.offsetWidth || 0);
            const barW         = Math.max(200, (avail || tabBar.offsetWidth) - DRAG_RESERVE);
            const PINNED_W     = 34;
            const MIN_W        = 120;   // comfortable resting minimum
            const COMFY_W      = 200;   // preferred width when there's room to spare
            const allTabs      = [...tabs.values()];
            const pinned       = allTabs.filter(t => t.classList.contains('pinned'));
            const unpinned     = allTabs.filter(t => !t.classList.contains('pinned'));

            pinned.forEach(t => Object.assign(t.style, { width: `${PINNED_W}px`, minWidth: `${PINNED_W}px`, maxWidth: `${PINNED_W}px`, flex: '0 0 auto' }));

            if (!unpinned.length) {
                tabBar.classList.add('only-pinned');
                tabsContainer.style.overflowX = 'hidden';
                return;
            }
            tabBar.classList.remove('only-pinned');

            const remaining = barW - pinned.length * PINNED_W;
            const ideal     = Math.floor(Math.max(0, remaining) / unpinned.length);

            // Tabs sit at a comfortable fixed width (COMFY_W), left-packed. With
            // many tabs they shrink evenly to share the bar, down to MIN_W, after
            // which the strip scrolls. This keeps a couple of tabs substantial
            // instead of tiny chips, without stretching them across the whole bar.
            const finalW = Math.max(MIN_W, Math.min(COMFY_W, ideal));
            tabsContainer.style.overflowX = ideal < MIN_W ? 'auto' : 'hidden';
            unpinned.forEach(t => Object.assign(t.style, { width: `${finalW}px`, minWidth: `${finalW}px`, maxWidth: `${finalW}px`, flex: '0 0 auto' }));
        });
    }

    function updateScrollShadows() {
        if (!tabsContainer) return;
        const max   = tabsContainer.scrollWidth - tabsContainer.clientWidth;
        const left  = tabsContainer.scrollLeft;
        tabBar.classList.toggle('scrollable-left',  left > 2);
        tabBar.classList.toggle('scrollable-right', max - left > 2);
    }

    function getDragAfterElement(container, x, pinned = false) {
        // Only consider tabs in the dragged tab's own group — pinned tabs
        // reorder within the pinned block, unpinned within the rest.
        const sel = pinned ? '.tab-button.pinned:not(.dragging)'
                           : '.tab-button:not(.pinned):not(.dragging)';
        return [...container.querySelectorAll(sel)].reduce((closest, child) => {
            const offset = x - child.getBoundingClientRect().left - child.getBoundingClientRect().width / 2;
            return (offset < 0 && offset > closest.offset) ? { offset, element: child } : closest;
        }, { offset: Number.NEGATIVE_INFINITY }).element;
    }

    /** Reorder preview: place the dragged tab under the cursor, keeping the
     *  pinned block intact at the start of the strip (Firefox behaviour). */
    function placeDraggedTab(btn, x) {
        const pinned = btn.classList.contains('pinned');
        const after  = getDragAfterElement(tabsContainer, x, pinned);
        if (pinned) {
            const firstUnpinned = [...tabsContainer.querySelectorAll('.tab-button')]
                .find(b => b !== btn && !b.classList.contains('pinned'));
            tabsContainer.insertBefore(btn, after ?? firstUnpinned ?? null);
        } else if (after == null) {
            tabsContainer.appendChild(btn);
        } else {
            tabsContainer.insertBefore(btn, after);
        }
    }

    // Auto-scroll the strip while a tab is dragged near its edges — without
    // this a tab can't be moved from one end of an overflowing strip to the
    // other in a single gesture.
    let edgeScrollDir   = 0;
    let edgeScrollTimer = null;
    function edgeAutoScroll(x) {
        const r   = tabsContainer.getBoundingClientRect();
        const dir = x < r.left + 24 ? -1 : (x > r.right - 24 ? 1 : 0);
        if (dir === edgeScrollDir) return;
        edgeScrollDir = dir;
        clearInterval(edgeScrollTimer); edgeScrollTimer = null;
        if (dir) edgeScrollTimer = setInterval(() => { tabsContainer.scrollLeft += dir * 12; }, 16);
    }
    function stopEdgeScroll() {
        edgeScrollDir = 0;
        clearInterval(edgeScrollTimer); edgeScrollTimer = null;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Focus mode + Pomodoro timer
    // ─────────────────────────────────────────────────────────────────────────

    function initFocusModeAndPomodoro() {
        const focusBtn      = document.getElementById('focus-btn');
        const utilityBar    = document.getElementById('utility-bar');
        const pomPill       = document.getElementById('pomodoro-pill');
        const pillTime      = document.getElementById('pill-time');
        const pillRingFill  = document.getElementById('pill-ring-fill');
        const pillPhaseDot  = document.getElementById('pill-phase-dot');
        const pomOverlay    = document.getElementById('pomodoro-overlay');
        const pomPhase      = document.getElementById('pomodoro-phase');
        const pomTime       = document.getElementById('pomodoro-time');
        const pomStartBtn   = document.getElementById('pomodoro-start');
        const pomSkipBtn    = document.getElementById('pomodoro-skip');
        const pomResetBtn   = document.getElementById('pomodoro-reset');
        const pomSessions   = document.getElementById('pomodoro-sessions');
        const pomCloseBtn   = document.getElementById('pomodoro-close');

        // Config from settings (seconds)
        const POM_FOCUS    = getPomSetting('pomWork',       25) * 60;
        const POM_SHORT    = getPomSetting('pomShortBreak',  5) * 60;
        const POM_LONG     = getPomSetting('pomLongBreak',  15) * 60;
        const POM_SESSIONS = getPomSetting('pomSessions',    4);
        const RING_CIRC    = 2 * Math.PI * 11; // pill ring r=11

        let pom = {
            phase: 'focus', running: false, elapsed: 0,
            total: POM_FOCUS, sessionsDone: 0, timer: null, shown: false,
        };

        function pomShowPill() {
            if (pom.shown) return;
            pom.shown = true;
            pomPill.classList.remove('hidden');
            utilityBar.classList.add('pomodoro-active');
        }

        function pomHidePill() {
            pom.shown = false;
            pomPill.classList.add('hidden');
            utilityBar.classList.remove('pomodoro-active');
        }

        function pomUpdateUI() {
            const remaining  = Math.max(0, pom.total - pom.elapsed);
            const mins       = String(Math.floor(remaining / 60)).padStart(2, '0');
            const secs       = String(remaining % 60).padStart(2, '0');
            const timeStr    = `${mins}:${secs}`;
            const isFocus    = pom.phase === 'focus';
            const phaseLabel = isFocus
                ? 'Focus'
                : (pom.sessionsDone % POM_SESSIONS === 0 ? 'Long Break' : 'Short Break');

            pillTime.textContent              = timeStr;
            pillRingFill.style.strokeDashoffset = String(RING_CIRC * (pom.elapsed / pom.total));
            // SVG elements: className is read-only (throws in strict mode) — use setAttribute.
            pillRingFill.setAttribute('class', 'pill-ring-fill' + (isFocus ? '' : ' break'));
            pillPhaseDot.setAttribute('class', 'pill-phase-dot' + (isFocus ? '' : ' break'));
            pomTime.textContent               = timeStr;
            pomPhase.textContent              = phaseLabel;
            pomPhase.className                = 'pomodoro-phase' + (isFocus ? '' : ' break');
            pomStartBtn.textContent           = pom.running ? 'Pause' : 'Start';

            pomSessions.innerHTML = '';
            for (let i = 0; i < POM_SESSIONS; i++) {
                const dot = document.createElement('div');
                dot.className = 'pom-session-dot' + (i < (pom.sessionsDone % POM_SESSIONS) ? ' done' : '');
                pomSessions.appendChild(dot);
            }
        }

        async function pomSetFocusActive(active) {
            const current = await window.focusMode.getState();
            if (current !== active) await window.focusMode.toggle();
            focusBtn.classList.toggle('active', active);
        }

        async function pomAdvancePhase() {
            if (pom.phase === 'focus') {
                pom.sessionsDone++;
                pom.phase = 'break';
                pom.total = (pom.sessionsDone % POM_SESSIONS === 0) ? POM_LONG : POM_SHORT;
                await pomSetFocusActive(false);
            } else {
                pom.phase = 'focus'; pom.total = POM_FOCUS;
                await pomSetFocusActive(true);
            }
            pom.elapsed = 0; pom.running = true;
            pomUpdateUI();
        }

        function pomTick() {
            pom.elapsed++;
            if (pom.elapsed >= pom.total) {
                clearInterval(pom.timer); pom.timer = null; pom.running = false;
                pomAdvancePhase().then(() => {
                    if (pom.running) pom.timer = setInterval(pomTick, 1000);
                });
            } else {
                pomUpdateUI();
            }
        }

        function pomOpenOverlay()  { pomUpdateUI(); pomOverlay.classList.remove('hidden'); window.focusMode.overlayOpen(); }
        function pomCloseOverlay() { pomOverlay.classList.add('hidden'); window.focusMode.overlayClose(); }

        pomStartBtn.addEventListener('click', () => {
            if (pom.running) { clearInterval(pom.timer); pom.timer = null; pom.running = false; }
            else { pom.running = true; pom.timer = setInterval(pomTick, 1000); }
            pomUpdateUI();
        });

        pomSkipBtn.addEventListener('click', () => {
            clearInterval(pom.timer); pom.timer = null; pom.running = false;
            pomAdvancePhase().then(() => { if (pom.running) pom.timer = setInterval(pomTick, 1000); });
        });

        pomResetBtn.addEventListener('click', async () => {
            clearInterval(pom.timer);
            Object.assign(pom, { timer: null, running: false, elapsed: 0, phase: 'focus', total: POM_FOCUS, sessionsDone: 0 });
            pomUpdateUI(); pomCloseOverlay(); pomHidePill();
            if (await window.focusMode.getState()) { await window.focusMode.toggle(); focusBtn.classList.remove('active'); }
        });

        pomCloseBtn.addEventListener('click', pomCloseOverlay);
        pomPill.addEventListener('click', pomOpenOverlay);

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !pomOverlay.classList.contains('hidden')) pomCloseOverlay();
        });

        focusBtn.addEventListener('click', async () => {
            const active = await window.focusMode.toggle();
            focusBtn.classList.toggle('active', active);
            if (active) {
                pomShowPill();
                if (!pom.running) { pom.running = true; pom.timer = setInterval(pomTick, 1000); }
                pomUpdateUI();
            } else {
                clearInterval(pom.timer);
                Object.assign(pom, { timer: null, running: false, elapsed: 0, phase: 'focus', total: POM_FOCUS, sessionsDone: 0 });
                pomHidePill(); pomUpdateUI();
            }
        });

        window.focusMode.onChanged((active) => focusBtn.classList.toggle('active', active));
        window.focusMode.getState().then(active => focusBtn.classList.toggle('active', active));

        pomUpdateUI();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Downloads button + panel
    // ─────────────────────────────────────────────────────────────────────────

    function initDownloads() {
        const btn = document.getElementById('downloads-btn');
        if (!btn || !window.downloads) return;

        let panelOpen   = false;
        let activeCount = 0;

        function syncButton(items) {
            activeCount = items.filter(i => i.state === 'progressing').length;
            btn.classList.toggle('hidden', items.length === 0);
            btn.classList.toggle('downloading', activeCount > 0);
            btn.title = activeCount > 0 ? `Downloads — ${activeCount} in progress` : 'Downloads';
        }

        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const r = btn.getBoundingClientRect();
            panelOpen = await window.downloads.togglePanel(
                { left: r.left, right: r.right, top: r.top, bottom: r.bottom });
            btn.classList.toggle('active', panelOpen);
            if (panelOpen) btn.classList.remove('has-new');
        });

        window.downloads.onPanelClosed(() => {
            panelOpen = false;
            btn.classList.remove('active');
        });

        window.downloads.onChanged(async (item) => {
            const items = await window.downloads.getAll();
            syncButton(items);
            // Pulse ends → mark completion so the user notices the finished file
            if (item && item.state === 'completed' && !panelOpen) btn.classList.add('has-new');
        });

        // Close the panel on clicks outside the button (chrome or page content)
        window.addEventListener('click', (e) => {
            if (panelOpen && !btn.contains(e.target)) window.downloads.closePanel();
        });
        if (window.contentInteraction) {
            window.contentInteraction.onClicked(() => { if (panelOpen) window.downloads.closePanel(); });
        }

        // Restore button state for downloads started earlier in the session
        window.downloads.getAll().then(syncButton).catch(() => {});
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Reader mode + Picture-in-Picture buttons
    // ─────────────────────────────────────────────────────────────────────────

    function initReaderAndPip() {
        const readerBtn = document.getElementById('reader-btn');
        const pipBtn    = document.getElementById('pip-btn');

        if (readerBtn && window.reader) {
            readerBtn.addEventListener('click', () => window.reader.toggle(activeTabIndex));
            // Main pushes { index, active, available } as pages load / tabs switch.
            window.reader.onState((d) => {
                if (!d || d.index !== activeTabIndex) return;
                readerBtn.classList.toggle('hidden', !(d.available || d.active));
                readerBtn.classList.toggle('active', !!d.active);
                readerBtn.title = d.active ? 'Exit Reader View' : 'Reader View';
            });
            window.reader.onFailed((d) => {
                if (!d || d.index !== activeTabIndex) return;
                // quiet feedback that extraction failed — no motion
                readerBtn.title = 'No article found on this page';
                setTimeout(() => { readerBtn.title = 'Reader View'; }, 1600);
            });
        }

        if (pipBtn && window.pip) {
            pipBtn.addEventListener('click', () => window.pip.toggle(activeTabIndex));
            window.pip.onMediaState((d) => {
                if (!d || d.index !== activeTabIndex) return;
                pipBtn.classList.toggle('hidden', !d.playing);
            });
        }

        // Reset both when switching tabs; the main process re-sends the correct
        // state for the newly active tab immediately after.
        window.tab.onTabSwitched(() => {
            readerBtn?.classList.add('hidden');
            readerBtn?.classList.remove('active');
            pipBtn?.classList.add('hidden');
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Hamburger menu button
    // ─────────────────────────────────────────────────────────────────────────

    function initMenu() {
        menuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            window.menu.open();
            menuOpen = true;
        });
    }

});
})();
