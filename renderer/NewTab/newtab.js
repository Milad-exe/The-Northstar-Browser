'use strict';
// The new-tab page (P2 pivot: replaces the Palette). An internal file:// page,
// so it has the internal bridges (northstarSettings, tab, essentials, bookmarks,
// history) and ../lib/util for the shared resolver. It behaves like Chrome's:
// typing shows local suggestions under the field — open tabs ("Switch to tab",
// which is where tab search lives), bookmarks, history — and Enter navigates
// THIS tab. Tiles are your own (add/edit/remove), then Essentials, topped up
// with most-visited sites; Customise toggles sections or the minimal page.
// Ctrl/middle-click opens in a background tab, Shift-click in a new active one.
// A private tab loads it with #private: no history is shown.
(() => {
    const util = window.Northstar.util;
    const T = (k, f) => {
        try { const v = window.Northstar?.i18n?.t(k); return (v && v !== k) ? v : f; }
        catch (e) { return f; }
    };
    try {
        window.Northstar.i18n.init(window.northstarI18n?.getSync()
            || (window.northstarSettings?.getSync() || {}).i18n || {});
        window.Northstar.i18n.apply(document);
    }
    catch (e) { /* labels fall back to the English in the markup */ }

    // Hash flags set by main (Tabs._loadNewTabPage): `private` shows no
    // history; `tabs` is Ctrl+Shift+A's tab-search mode — the field lists this
    // space's open tabs, Enter jumps, Esc returns, and the page closes itself.
    const FLAGS = location.hash.replace(/^#/, '').split(',');
    const PRIVATE = FLAGS.includes('private');
    const TABS = FLAGS.includes('tabs');
    const settings = (() => { try { return window.northstarSettings?.getSync() || {}; } catch (e) { return {}; } })();
    const engines = Array.isArray(settings.engines) ? settings.engines : [];
    const defEngine = settings.searchEngine || 'google';
    const log = (msg) => { try { window.northstarLog?.debug('newtab', msg); } catch (e) { /* no logger */ } };

    // ── Opening things ────────────────────────────────────────────────────────
    // Plain → this tab. Ctrl/Cmd or middle → background tab. Shift → new tab, shown.
    function open(url, ev) {
        if (!url)
            return;
        const bg = ev && (ev.ctrlKey || ev.metaKey || ev.button === 1);
        const fg = ev && ev.shiftKey;
        if ((bg || fg) && window.browserBookmarks?.openInNewTab) {
            window.browserBookmarks.openInNewTab(url, !!fg && !bg);
            return;
        }
        // northstar:// is not a scheme the page can load itself; main resolves it.
        if (/^northstar:/i.test(url) && window.electronAPI?.navigateActiveTab) {
            window.electronAPI.navigateActiveTab(url);
            return;
        }
        window.location.assign(url);
    }
    // Make a row/tile open on click, middle-click and Enter.
    function openable(el, url) {
        el.addEventListener('click', (e) => open(url, e));
        el.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); open(url, e); } });
        el.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); }); // no autoscroll
    }

    const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };
    function favicon(url) {
        const host = hostOf(url);
        const fav = document.createElement('span');
        fav.className = 'ntp-fav';
        fav.textContent = host ? host.charAt(0).toUpperCase() : '·';
        if (host && window.faviconCache?.get) {
            window.faviconCache.get(host).then((data) => {
                if (!data) return;
                const img = document.createElement('img');
                img.className = 'ntp-fav ntp-fav-img';
                img.alt = '';
                img.src = data;
                fav.replaceWith(img);
            }).catch((e) => log('favicon: ' + e));
        }
        return fav;
    }

    // A suggestion row's icon: the address bar's glyph for the row type
    // (renderer/lib/row-icons.js), swapped for the site's cached favicon.
    function rowIcon(r) {
        const img = document.createElement('img');
        img.className = 'ntp-glyph';
        img.alt = '';
        const icons = window.Northstar.rowIcons || {};
        img.src = r.kind === 'tab' ? icons.tab : r.kind === 'bookmark' ? icons.bkmk : r.kind === 'history' ? icons.hist : icons.globe;
        const host = hostOf(r.url);
        if (host && window.faviconCache?.get) {
            window.faviconCache.get(host).then((data) => { if (data) img.src = data; })
                .catch((e) => log('favicon: ' + e));
        }
        return img;
    }

    // ── Data ──────────────────────────────────────────────────────────────────
    const flatBookmarks = (items, out = []) => {
        for (const it of items || []) {
            if (!it) continue;
            if (it.url) out.push({ url: it.url, title: it.title || '' });
            if (Array.isArray(it.children)) flatBookmarks(it.children, out);
        }
        return out;
    };
    let bookmarks = [];
    let openTabs = [];
    async function loadBookmarks() {
        try { bookmarks = flatBookmarks(await window.browserBookmarks?.getAll?.()); }
        catch (e) { log('bookmarks: ' + e); bookmarks = []; }
    }
    async function loadOpenTabs() {
        try { openTabs = (await window.tab?.listOpen?.()) || []; }
        catch (e) { log('open tabs: ' + e); openTabs = []; }
    }

    // ── The field + suggestions ───────────────────────────────────────────────
    const input = document.getElementById('q');
    const form = document.getElementById('omni');
    const box = document.getElementById('suggest');
    let rows = [];          // current suggestion rows
    let activeKey = null;   // selection held by identity (rowKey), not index
    // A tab row is its tab (two tabs can share a url); anything else, its url.
    const rowKey = (r) => (r.kind === 'tab' ? 'tab:' + r.index : r.url);
    let seq = 0;            // guards the async history merge against stale replies

    const KIND_LABEL = {
        tab: () => T('ntp.switchTab', 'Switch to tab'),
        bookmark: () => T('ntp.bookmark', 'Bookmark'),
        history: () => T('ntp.history', 'History'),
    };
    function activeIndex() {
        return rows.findIndex(r => rowKey(r) === activeKey);
    }
    function render() {
        box.innerHTML = '';
        if (!rows.length) {
            box.hidden = true;
            input.setAttribute('aria-expanded', 'false');
            input.removeAttribute('aria-activedescendant');
            return;
        }
        rows.forEach((r, i) => {
            const el = document.createElement('div');
            el.className = 'ntp-sug';
            el.id = 'sug-' + i;
            el.setAttribute('role', 'option');
            const on = rowKey(r) === activeKey;
            el.classList.toggle('active', on);
            el.setAttribute('aria-selected', on ? 'true' : 'false');
            // Same anatomy as the address-bar dropdown (ui-polish U1-4):
            // icon · title — secondary. A tab row's secondary says what Enter
            // does; any other row's is its displayUrl (no scheme, www. or query).
            const text = window.Northstar.rowText(r.title, r.url);
            const main = document.createElement('span');
            main.className = 'ntp-sug-main';
            const title = document.createElement('span');
            title.className = 'ntp-sug-title';
            title.textContent = text.primary;
            main.appendChild(title);
            const secondary = r.kind === 'tab' ? KIND_LABEL.tab() : text.secondary;
            if (secondary) {
                const sep = document.createElement('span');
                sep.className = 'ntp-sug-sep';
                sep.textContent = '—';
                const url = document.createElement('span');
                url.className = 'ntp-sug-url';
                url.textContent = secondary;
                main.append(sep, url);
            }
            el.title = r.url;
            el.append(rowIcon(r), main);
            el.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the field
            el.addEventListener('click', (e) => choose(r, e));
            el.addEventListener('auxclick', (e) => { if (e.button === 1) choose(r, e); });
            el.addEventListener('mousemove', () => { if (activeKey !== rowKey(r)) { activeKey = rowKey(r); render(); } });
            box.appendChild(el);
        });
        box.hidden = false;
        input.setAttribute('aria-expanded', 'true');
        const ai = activeIndex();
        if (ai >= 0) input.setAttribute('aria-activedescendant', 'sug-' + ai);
        else input.removeAttribute('aria-activedescendant');
    }
    function choose(r, ev) {
        if (TABS) {
            window.tab?.searchDone?.(r.index);
            return;
        }
        if (r.kind === 'tab' && !(ev && (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button === 1))) {
            window.tab?.switch?.(r.index);
            clearField();
            return;
        }
        open(r.url, ev);
    }
    function clearField() {
        input.value = '';
        rows = [];
        activeKey = null;
        render();
    }
    // Local rows render on the keystroke; history (an IPC round trip) merges in
    // when it lands, sequence-guarded, without moving the selection.
    function update() {
        const q = input.value;
        const mine = ++seq;
        if (TABS) {
            // Every tab before you type; the top row is always ready for Enter.
            rows = util.tabSearchRows(q, openTabs, 12);
            if (!rows.some(r => rowKey(r) === activeKey)) activeKey = rows[0] ? rowKey(rows[0]) : null;
            render();
            return;
        }
        const local = util.ntpSuggestions(q, { tabs: openTabs, bookmarks, history: [] }, 6);
        rows = local;
        if (!rows.some(r => rowKey(r) === activeKey)) activeKey = null;
        render();
        if (!q.trim() || PRIVATE || !window.browserHistory?.search)
            return;
        window.browserHistory.search(q.trim(), 12).then((hist) => {
            if (mine !== seq) return; // a newer keystroke owns the list
            rows = util.ntpSuggestions(q, { tabs: openTabs, bookmarks, history: hist || [] }, 6);
            if (!rows.some(r => rowKey(r) === activeKey)) activeKey = null;
            render();
        }).catch((e) => log('history search: ' + e));
    }
    input.addEventListener('input', update);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            if (!rows.length) return;
            e.preventDefault();
            const i = activeIndex();
            const n = rows.length;
            if (TABS) { // no typed-text slot: the selection just wraps
                const next = ((i < 0 ? 0 : i) + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
                activeKey = rowKey(rows[next]);
                render();
                return;
            }
            const next = e.key === 'ArrowDown' ? (i + 1) % (n + 1) : (i < 0 ? n - 1 : i - 1);
            activeKey = (next >= 0 && next < n) ? rowKey(rows[next]) : null; // n / -1 = back to the typed text
            render();
        }
        else if (e.key === 'Escape') {
            if (TABS) { // dismiss: back to the tab the search was opened from
                e.preventDefault();
                window.tab?.searchDone?.(null);
                return;
            }
            if (rows.length || input.value) {
                e.preventDefault();
                clearField();
            }
        }
    });
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const sel = rows[activeIndex()];
        if (sel) {
            choose(sel, null);
            return;
        }
        if (TABS)
            return; // tab search never navigates
        const v = input.value.trim();
        if (v) open(util.toNavigableUrl(v, engines, defEngine), null);
    });
    if (!TABS) // the tab list IS the tab-search page; it stays up
        input.addEventListener('blur', () => { setTimeout(() => { if (document.activeElement !== input) { rows = []; render(); } }, 0); });
    input.addEventListener('focus', () => { if (TABS || input.value.trim()) update(); });
    if (TABS) {
        document.body.classList.add('ntp-tabsearch');
        document.getElementById('customise').hidden = true;
        input.placeholder = T('ntp.searchTabs', 'Search open tabs');
        input.setAttribute('aria-label', input.placeholder);
        document.title = T('ntp.searchTabs', 'Search open tabs');
    }

    // ── Settings: sections + the user's own tiles ────────────────────────────
    // Persisted as `newTabPage` (features/persistence.js DEFAULTS). Both
    // sections off is the minimal, field-only page.
    const NTP_DEFAULTS = { shortcuts: true, recent: true, tiles: [], hidden: [] };
    function readCfg() {
        let v = {};
        try { v = (window.northstarSettings?.getSync() || {}).newTabPage || {}; }
        catch (e) { log('settings: ' + e); }
        return {
            ...NTP_DEFAULTS, ...v,
            tiles: Array.isArray(v.tiles) ? v.tiles.filter(t => t && t.url) : [],
            hidden: Array.isArray(v.hidden) ? v.hidden.filter(Boolean) : [],
        };
    }
    let cfg = readCfg();
    function saveCfg(next) {
        cfg = next;
        try { window.northstarSettings?.set?.('newTabPage', cfg); }
        catch (e) { log('save settings: ' + e); }
        applySections();
        renderTiles();
        syncPanel();
    }

    // ── Tiles: your own, then Essentials, then most-visited ──────────────────
    const grid = document.getElementById('links-grid');
    const linksSection = document.getElementById('links');
    const MAX_TILES = 10;
    let lastHistory = [];
    let lastEssentials = [];
    function iconButton(cls, label, glyph, onClick) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ntp-tile-act ' + cls;
        b.title = label;
        b.setAttribute('aria-label', label);
        b.textContent = glyph;
        b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
        return b;
    }
    function tile(t) {
        const wrap = document.createElement('div');
        wrap.className = 'ntp-tile-wrap';
        const b = document.createElement('button');
        b.className = 'ntp-tile';
        b.title = t.url;
        const label = document.createElement('span');
        label.className = 'ntp-tile-label';
        label.textContent = t.title || hostOf(t.url) || t.url;
        b.append(favicon(t.url), label);
        openable(b, t.url);
        wrap.appendChild(b);
        if (t.source === 'custom') {
            wrap.appendChild(iconButton('is-edit', T('ntp.editShortcut', 'Edit shortcut'), '\u270E', () => openTileDialog(t)));
            wrap.appendChild(iconButton('is-remove', T('ntp.remove', 'Remove'), '\u00D7', () =>
                saveCfg({ ...cfg, tiles: cfg.tiles.filter(x => x.url !== t.url) })));
        }
        else {
            // Not yours to delete (an Essential, a frequent site) — just stop showing it.
            wrap.appendChild(iconButton('is-remove', T('ntp.hide', 'Don\u2019t show'), '\u00D7', () =>
                saveCfg({ ...cfg, hidden: [...cfg.hidden.filter(u => u !== t.url), t.url].slice(-200) })));
        }
        return wrap;
    }
    function addTile() {
        const b = document.createElement('button');
        b.className = 'ntp-tile ntp-tile-add';
        const plus = document.createElement('span');
        plus.className = 'ntp-fav ntp-fav-add';
        plus.textContent = '+';
        const label = document.createElement('span');
        label.className = 'ntp-tile-label';
        label.textContent = T('ntp.addShortcut', 'Add shortcut');
        b.append(plus, label);
        b.addEventListener('click', () => openTileDialog(null));
        return b;
    }
    function renderTiles() {
        const items = util.ntpTiles(cfg, {
            essentials: lastEssentials,
            frequent: util.mostVisited(lastHistory, MAX_TILES * 2),
        }, MAX_TILES);
        grid.innerHTML = '';
        for (const it of items) grid.appendChild(tile(it));
        if (cfg.tiles.length < MAX_TILES) grid.appendChild(addTile());
        linksSection.hidden = !cfg.shortcuts;
    }
    async function loadLinks(history) {
        lastHistory = history || [];
        try { lastEssentials = ((await window.essentials?.list?.()) || []).filter(e => e && e.url); }
        catch (e) { log('essentials: ' + e); lastEssentials = []; }
        renderTiles();
    }

    // Add / edit a tile of your own.
    const dlg = document.getElementById('tile-dialog');
    const dlgForm = document.getElementById('tile-form');
    const dlgName = document.getElementById('tile-name');
    const dlgUrl = document.getElementById('tile-url');
    const dlgErr = document.getElementById('tile-err');
    const dlgTitle = document.getElementById('tile-title');
    let editing = null; // the tile being edited, or null when adding
    function openTileDialog(t) {
        editing = t;
        dlgTitle.textContent = t ? T('ntp.editShortcut', 'Edit shortcut') : T('ntp.addShortcut', 'Add shortcut');
        dlgName.value = t ? (t.title || '') : '';
        dlgUrl.value = t ? t.url : '';
        dlgErr.hidden = true;
        try { dlg.showModal(); }
        catch (e) { log('dialog: ' + e); return; }
        (t ? dlgName : dlgUrl).focus();
    }
    document.getElementById('tile-cancel').addEventListener('click', () => dlg.close());
    dlgForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const url = util.tileUrl(dlgUrl.value);
        if (!url) {
            dlgErr.hidden = false;
            dlgUrl.focus();
            return;
        }
        const tileObj = { url, title: dlgName.value.trim() || hostOf(url) };
        const others = cfg.tiles.filter(x => x.url !== url && (!editing || x.url !== editing.url));
        let tiles;
        if (editing) {
            // Keep an edited tile where it was.
            const at = cfg.tiles.findIndex(x => x.url === editing.url);
            tiles = [...others];
            tiles.splice(at < 0 ? tiles.length : Math.min(at, tiles.length), 0, tileObj);
        }
        else {
            tiles = [...others, tileObj];
        }
        dlg.close();
        saveCfg({ ...cfg, tiles: tiles.slice(0, MAX_TILES), hidden: cfg.hidden.filter(u => u !== url) });
    });

    // ── Customise ─────────────────────────────────────────────────────────────
    const custBtn = document.getElementById('customise');
    const panel = document.getElementById('custom-panel');
    const optShortcuts = document.getElementById('opt-shortcuts');
    const optRecent = document.getElementById('opt-recent');
    const optMinimal = document.getElementById('opt-minimal');
    const restoreBtn = document.getElementById('opt-restore');
    function syncPanel() {
        optShortcuts.checked = !!cfg.shortcuts;
        optRecent.checked = !!cfg.recent;
        optMinimal.checked = !cfg.shortcuts && !cfg.recent;
        restoreBtn.hidden = cfg.hidden.length === 0;
    }
    function setPanel(open) {
        panel.hidden = !open;
        custBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) syncPanel();
    }
    custBtn.addEventListener('click', (e) => { e.stopPropagation(); setPanel(panel.hidden); });
    panel.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', () => { if (!panel.hidden) setPanel(false); });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !panel.hidden) { setPanel(false); custBtn.focus(); }
    });
    optShortcuts.addEventListener('change', () => saveCfg({ ...cfg, shortcuts: optShortcuts.checked }));
    optRecent.addEventListener('change', () => saveCfg({ ...cfg, recent: optRecent.checked }));
    // Minimal = both sections off; turning it off brings both back.
    optMinimal.addEventListener('change', () => {
        const full = !optMinimal.checked;
        saveCfg({ ...cfg, shortcuts: full, recent: full });
    });
    restoreBtn.addEventListener('click', () => saveCfg({ ...cfg, hidden: [] }));
    function applySections() {
        linksSection.hidden = !cfg.shortcuts;
        recentSection.hidden = !cfg.recent || PRIVATE || recentList.children.length === 0;
        document.body.classList.toggle('ntp-minimal', !cfg.shortcuts && !cfg.recent);
    }

    // ── Recent pages ──────────────────────────────────────────────────────────
    const recentList = document.getElementById('recent-list');
    const recentSection = document.getElementById('recent');
    function loadRecent(history) {
        const seen = new Set();
        recentList.innerHTML = '';
        let n = 0;
        for (const h of history) {
            if (!h?.url || !/^https?:/i.test(h.url) || seen.has(h.url)) continue;
            seen.add(h.url);
            const row = document.createElement('button');
            row.className = 'ntp-recent-row';
            row.title = h.url;
            const text = window.Northstar.rowText(h.title, h.url);
            const t = document.createElement('span');
            t.className = 'ntp-recent-title';
            t.textContent = text.primary;
            const u = document.createElement('span');
            u.className = 'ntp-recent-url';
            u.textContent = text.secondary;
            row.append(favicon(h.url), t, u);
            openable(row, h.url);
            recentList.appendChild(row);
            if (++n >= 8) break;
        }
        recentSection.hidden = n === 0 || !cfg.recent;
    }

    async function loadAll() {
        if (TABS) { // tab search shows only the tab list — no tiles, no recent
            await loadOpenTabs();
            update();
            return;
        }
        cfg = readCfg(); // another NTP may have changed it
        let history = [];
        if (!PRIVATE) {
            try { history = (await window.browserHistory?.get?.()) || []; }
            catch (e) { log('history: ' + e); }
        }
        await Promise.all([loadBookmarks(), loadOpenTabs()]);
        await loadLinks(history);
        loadRecent(history);
        applySections();
    }
    loadAll();
    // Coming back to a kept-open NTP: its tiles and tab list may be stale.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) loadAll(); });
    window.addEventListener('focus', () => { loadOpenTabs(); });
    try { window.browserBookmarks?.onChanged?.(() => loadAll()); } catch (e) { log('bookmarks onChanged: ' + e); }
    try { window.essentials?.onChanged?.(() => loadAll()); } catch (e) { log('essentials onChanged: ' + e); }
    setTimeout(() => { try { input.focus(); } catch (e) { log('focus: ' + e); } }, 0);
})();
