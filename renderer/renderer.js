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

document.addEventListener('DOMContentLoaded', async () => {

    // ── Settings ──────────────────────────────────────────────────────────────

    let settings = {};
    try { settings = await window.inkSettings.get(); } catch {}

    const getSearchEngine  = () => settings.searchEngine || 'google';
    const getPomSetting    = (key, def) => (typeof settings[key] === 'number' ? settings[key] : def);

    // ── Private window detection ──────────────────────────────────────────────

    const isPrivateWindow = await window.inkPrivate?.isPrivateWindow?.() ?? false;
    if (isPrivateWindow) {
        document.documentElement.setAttribute('data-private-window', 'true');
    }
    window.inkPrivate?.onSetPrivateWindow?.((v) => {
        if (v) document.documentElement.setAttribute('data-private-window', 'true');
        else document.documentElement.removeAttribute('data-private-window');
    });

    // ── Shared state ──────────────────────────────────────────────────────────

    let tabs           = new Map(); // tabIndex → <div.tab-button>
    let tabUrls        = new Map(); // tabIndex → url string
    let tabPrivate     = new Map(); // tabIndex → boolean (private flag)
    let activeTabIndex = 0;
    let menuOpen       = false;
    let currentTabUrl   = '';
    let currentTabTitle = '';

    // ── Bookmark bar state (must be declared before initBookmarkBar() is called) ──
    let bookmarkBarVisible = !!settings.bookmarkBarVisible;
    let hasBookmarks       = false;
    let renamingFolderId   = null;
    let refreshSeq         = 0;
    let openDropdownId     = null; // id of the anchor button whose dropdown is open
    let dropdownCleanup    = null;

    // ── DOM references ─────────────────────────────────────────────────────────

    const searchBar        = document.getElementById('searchBar');
    const backBtn          = document.getElementById('back-btn');
    const forwardBtn       = document.getElementById('forward-btn');
    const reloadBtn        = document.getElementById('reload-btn');
    const menuBtn          = document.getElementById('menu-btn');
    const addBtn           = document.getElementById('new-tab-btn');
    const tabBar           = document.getElementById('tab-bar');
    const tabsContainer    = document.getElementById('tabs-container');
    const bookmarkBtn      = document.getElementById('bookmark-btn');
    const bookmarkBar      = document.getElementById('bookmark-bar');
    const bookmarkBarItems = document.getElementById('bookmark-bar-items');

    // ── Init sequence ─────────────────────────────────────────────────────────

    initWindowControls();
    initNavButtons();
    initAddressBar();
    initBookmarkBar();
    initTabBar();
    initFocusModeAndPomodoro();
    initBrunoAndMenu();

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
        backBtn.addEventListener('click',   () => window.tab.goBack(activeTabIndex));
        forwardBtn.addEventListener('click',() => window.tab.goForward(activeTabIndex));
        reloadBtn.addEventListener('click', () => window.tab.reload(activeTabIndex));
        addBtn.addEventListener('click',    () => window.tab.add());

        window.addEventListener('click', (e) => {
            if (menuOpen) window.electronAPI.windowClick({ x: e.clientX, y: e.clientY });
        });
        window.menu.onClosed(() => { menuOpen = false; });
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
        searchBar.addEventListener('input',   () => { userTyping = true; updateSuggestions(); });
        searchBar.addEventListener('focus',   () => { if (userTyping && searchBar.value.trim()) updateSuggestions(); });
        searchBar.addEventListener('blur',    () => {
            setTimeout(() => {
                if (overlayPointerDown) return;
                if (document.activeElement === searchBar) return;
                hideSuggestions();
            }, 400);
        });
        searchBar.addEventListener('keydown', onSearchKeyDown);

        window.suggestions.onCreated(() => { userTyping = true; try { searchBar.focus(); } catch {} });
        window.suggestions.onSelected(onSuggestionSelected);
        window.suggestions.onPointerDown(() => {
            overlayPointerDown = true;
            setTimeout(() => { overlayPointerDown = false; }, 350);
        });

        if (window.contentInteraction) {
            window.contentInteraction.onClicked(() => { hideSuggestions(); searchBar.blur(); });
        }

        window.addEventListener('resize', positionSuggestions);
        window.addEventListener('scroll', positionSuggestions, true);
    }

    // ── Suggestion state ──────────────────────────────────────────────────────

    let currentSuggestions    = [];
    let activeSuggestionIndex = -1;
    let overlayPointerDown    = false;
    let userTyping           = false;

    function getSuggestionsBounds() {
        const r = searchBar.getBoundingClientRect();
        return { left: r.left, top: r.bottom + 4, width: r.width };
    }

    function positionSuggestions() {
        if (!currentSuggestions.length) return;
        window.suggestions.update(getSuggestionsBounds(), currentSuggestions, activeSuggestionIndex);
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
        window.suggestions.open(getSuggestionsBounds(), currentSuggestions, activeSuggestionIndex).catch(() => {});
    }

    function setActiveSuggestion(newIndex) {
        if (!currentSuggestions.length) return;
        if (newIndex < 0)                           newIndex = currentSuggestions.length - 1;
        if (newIndex >= currentSuggestions.length)  newIndex = 0;
        activeSuggestionIndex = newIndex;
        const item = currentSuggestions[newIndex];
        if (item) searchBar.value = item.url || item.query || '';
        window.suggestions.update(getSuggestionsBounds(), currentSuggestions, activeSuggestionIndex);
    }

    function handleSuggestionSelect(index) {
        const item = currentSuggestions[index];
        if (!item) return;
        if (item.type === 'switch-tab') {
            window.tab.switch(item.tabIndex);
            hideSuggestions(); searchBar.blur();
        } else if ((item.type === 'history' || item.type === 'bookmark') && item.url) {
            searchBar.value = item.url;
            loadUrlInActiveTab(item.url); hideSuggestions();
        } else if (item.query) {
            searchBar.value = item.query;
            loadUrlInActiveTab(item.query); hideSuggestions();
        }
    }

    function onSuggestionSelected(item) {
        if (!item) return;
        if ((item.type === 'history' || item.type === 'bookmark') && item.url) {
            searchBar.value = item.url; loadUrlInActiveTab(item.url);
        } else if (item.query) {
            searchBar.value = item.query; loadUrlInActiveTab(item.query);
        }
        hideSuggestions();
        try { searchBar.focus(); } catch {}
    }

    function onSearchKeyDown(e) {
        if (currentSuggestions.length) {
            if (e.key === 'ArrowDown')  { e.preventDefault(); setActiveSuggestion(activeSuggestionIndex + 1); return; }
            if (e.key === 'ArrowUp')    { e.preventDefault(); setActiveSuggestion(activeSuggestionIndex - 1); return; }
            if (e.key === 'Escape')     { e.preventDefault(); hideSuggestions(); return; }
            if (e.key === 'Enter' && activeSuggestionIndex >= 0) {
                e.preventDefault(); handleSuggestionSelect(activeSuggestionIndex); return;
            }
        }
        if (e.key === 'Enter') {
            const url = searchBar.value.trim();
            if (url) loadUrlInActiveTab(url);
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

    const updateSuggestions = debounce(async () => {
        const q = searchBar.value.trim();
        if (!q) { hideSuggestions(); return; }

        const base = [{ type: 'action', query: q }];
        renderSuggestions(base); // immediate feedback

        try {
            const openTabs                 = getOpenTabSuggestions(q);
            const [bookmarks, hist, search] = await Promise.all([
                getBookmarkSuggestions(q, 3),
                getHistorySuggestions(q, 5),
                getSearchSuggestions(q, 6),
            ]);

            const merged    = [];
            const seenUrls  = new Set();
            const seenQuery = new Set();

            // Action (what you typed) always first so pressing Enter is predictable
            merged.push(...base);
            for (const x of base) { if (x.query) seenQuery.add(x.query); }
            // Then open tabs, bookmarks, history — URL matches above search suggestions
            for (const t of openTabs)   { merged.push(t); seenUrls.add(t.url); }
            for (const b of bookmarks)  { if (!seenUrls.has(b.url)) { merged.push(b); seenUrls.add(b.url); } }
            for (const h of hist)       { if (!seenUrls.has(h.url))   { merged.push(h); seenUrls.add(h.url); } }
            for (const s of search)     { if (!seenQuery.has(s.query)) { merged.push(s); seenQuery.add(s.query); } }

            renderSuggestions(merged);
        } catch { /* keep base rendered */ }
    }, 120);

    function normalizeUrl(u) {
        try { const n = new URL(u); return (n.hostname + n.pathname).toLowerCase().replace(/\/$/, ''); }
        catch { return u.toLowerCase(); }
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
    }

    function updateSearchBarUrl(url) {
        searchBar.value = url;
        hideSuggestions();
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
        window.electronAPI.reportChromeHeight(showBar ? 28 : 0);
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
            window.inkSettings.set('bookmarkBarVisible', bookmarkBarVisible);
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
        window.pinActiveTab = () => window.tab.pin(activeTabIndex);

        // ── IPC events from main process ──────────────────────────────────────

        window.tab.onTabCreated((_e, data) => {
            console.log('[tab-created] index:', data.index, 'afterIndex:', data.afterIndex, 'type:', typeof data.afterIndex);
            tabPrivate.set(data.index, !!data.private);
            createTabButton(data.index, data.title, data.afterIndex ?? null, data.active !== false, !!data.private);
            setTimeout(() => { updateTabWidths(data.totalTabs); updateScrollShadows(); }, 10);
        });

        window.tab.onTabRemoved((_e, data) => {
            tabUrls.delete(data.index);
            tabPrivate.delete(data.index);
            removeTabButton(data.index);
            hideSuggestions();
            setTimeout(() => { updateTabWidths(data.totalTabs); updateScrollShadows(); }, 10);
        });

        window.tab.onTabSwitched((_e, data) => {
            activeTabIndex = data.index;
            if (data.url) tabUrls.set(data.index, data.url);
            setActiveTab(data.index);
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

        window.tabsUI?.onPinTab((index) => {
            const btn = document.querySelector(`#tabs-container .tab-button[data-index="${index}"]`);
            if (!btn) return;
            const isPinned    = btn.classList.toggle('pinned');
            btn.dataset.pinned = isPinned ? '1' : '';
            updateTabWidths(tabs.size);
            updateScrollShadows();
        });

        // ── In-window tab reorder (dragover + insert visual) ──────────────────

        tabsContainer.addEventListener('dragover', (e) => {
            e.preventDefault(); e.dataTransfer.dropEffect = 'move';
            const dragging = document.querySelector('.dragging');
            if (!dragging) return;
            const after = getDragAfterElement(tabsContainer, e.clientX);
            if (after == null) tabsContainer.appendChild(dragging);
            else               tabsContainer.insertBefore(dragging, after);
        });

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

        // Private tab button (hidden in private windows via CSS)
        const addPrivateBtn = document.getElementById('new-private-tab-btn');
        if (addPrivateBtn) addPrivateBtn.addEventListener('click', () => window.tab.addPrivate());
    }

    // ── Tab DOM helpers ───────────────────────────────────────────────────────

    function createTabButton(index, title, afterIndex = null, shouldActivate = true, isPrivate = false) {
        if (tabs.has(index)) return;

        const btn = document.createElement('div');
        btn.className      = 'tab-button';
        btn.dataset.index  = index;
        btn.draggable      = true;
        btn.tabIndex       = 0;
        btn.role           = 'button';
        if (isPrivate) btn.dataset.private = 'true';

        const titleSpan   = document.createElement('span');
        titleSpan.className   = 'tab-title';
        titleSpan.textContent = title || `Tab ${index + 1}`;

        const closeBtn = document.createElement('button');
        closeBtn.className = 'tab-close';
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

        btn.addEventListener('click', () => window.tab.switch(parseInt(index)));
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
        btn.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault(); window.tab.switch(parseInt(index));
            } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault();
                const all  = [...tabsContainer.querySelectorAll('.tab-button')];
                const next = all[(all.indexOf(btn) + 1) % all.length];
                if (next) next.focus();
            } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault();
                const all  = [...tabsContainer.querySelectorAll('.tab-button')];
                const prev = all[(all.indexOf(btn) - 1 + all.length) % all.length];
                if (prev) prev.focus();
            }
        });

        // Drag to reorder or detach to another window
        btn.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', String(index));
            e.dataTransfer.effectAllowed = 'move';
            btn.classList.add('dragging');
        });
        btn.addEventListener('dragend', async (e) => {
            btn.classList.remove('dragging');
            const targetWin   = await window.dragdrop.getWindowAtPoint(e.screenX, e.screenY);
            const thisWinId   = await window.dragdrop.getThisWindowId();
            if (!targetWin) {
                const url = await window.tab.getTabUrl(index);
                await window.dragdrop.detachToNewWindow(index, e.screenX, e.screenY, url);
            } else if (targetWin.id !== thisWinId) {
                const url = await window.tab.getTabUrl(index);
                await window.dragdrop.moveTabToWindow(thisWinId, index, targetWin.id, url);
            } else {
                const ordered = [...tabsContainer.querySelectorAll('.tab-button')].map(el => parseInt(el.dataset.index));
                if (ordered.length) window.tab.reorder(ordered);
            }
        });

        const afterBtn = afterIndex !== null ? tabs.get(afterIndex) : null;
        console.log('[createTabButton] index:', index, 'afterIndex:', afterIndex, 'afterBtn found:', !!afterBtn, 'nextSibling:', afterBtn?.nextSibling?.dataset?.index);
        if (afterBtn && afterBtn.nextSibling) {
            tabsContainer.insertBefore(btn, afterBtn.nextSibling);
        } else if (afterBtn) {
            tabsContainer.appendChild(btn);
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

    function updateTabWidths() {
        const count = tabs.size;
        if (!count) return;
        requestAnimationFrame(() => {
            const barW         = tabsContainer.offsetWidth || tabBar.offsetWidth;
            const PINNED_W     = 36;
            const MIN_W        = 80;
            const MAX_W        = 240;
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
            const finalW    = Math.max(MIN_W, Math.min(MAX_W, ideal));
            tabsContainer.style.overflowX = ideal < MIN_W ? 'auto' : 'hidden';
            unpinned.forEach(t => Object.assign(t.style, { width: `${finalW}px`, minWidth: `${MIN_W}px`, maxWidth: `${MAX_W}px`, flex: '0 0 auto' }));
        });
    }

    function updateScrollShadows() {
        if (!tabsContainer) return;
        const max   = tabsContainer.scrollWidth - tabsContainer.clientWidth;
        const left  = tabsContainer.scrollLeft;
        tabBar.classList.toggle('scrollable-left',  left > 2);
        tabBar.classList.toggle('scrollable-right', max - left > 2);
    }

    function getDragAfterElement(container, x) {
        return [...container.querySelectorAll('.tab-button:not(.dragging)')].reduce((closest, child) => {
            const offset = x - child.getBoundingClientRect().left - child.getBoundingClientRect().width / 2;
            return (offset < 0 && offset > closest.offset) ? { offset, element: child } : closest;
        }, { offset: Number.NEGATIVE_INFINITY }).element;
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
            pillRingFill.style.strokeDashoffset = RING_CIRC * (pom.elapsed / pom.total);
            pillRingFill.className            = 'pill-ring-fill' + (isFocus ? '' : ' break');
            pillPhaseDot.className            = 'pill-phase-dot' + (isFocus ? '' : ' break');
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
    // Bruno panel + hamburger menu button
    // ─────────────────────────────────────────────────────────────────────────

    function initBrunoAndMenu() {
        const brunoBtn = document.getElementById('bruno-btn');
        let brunoOpen  = false;

        brunoBtn.addEventListener('click', () => {
            if (brunoOpen) { window.bruno.close(); brunoOpen = false; brunoBtn.classList.remove('active'); }
            else           { window.bruno.open();  brunoOpen = true;  brunoBtn.classList.add('active'); }
        });

        menuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            window.menu.open();
            menuOpen = true;
        });
    }

});
