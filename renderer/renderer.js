"use strict";
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
    /**
     * Translate, with the English already in the source as the fallback.
     * `Northstar.i18n.t` returns the KEY for an unknown string, which would paint
     * "chrome.newTab" into a menu — this returns the fallback instead. Declared
     * up here because the init sequence runs near the top of the file (a const
     * declared below it would be in its TDZ when the chrome first paints).
     */
    const T = (key, fallback) => {
        try {
            const v = window.Northstar?.i18n?.t(key);
            return (v && v !== key) ? v : fallback;
        }
        catch (e) { return fallback; }
    };
    /** Sanitize an HTML string using DOMPurify when available. */
    const sanitizeHtml = (typeof DOMPurify !== 'undefined')
        ? (html) => DOMPurify.sanitize(html, { FORCE_BODY: false })
        : (html) => html;
    /** Returns a debounced wrapper around `fn` with a `.cancel()` method. */
    function paintCachedFavicon(imgEl, url) {
        let host = '';
        try {
            host = new URL(url).host;
        }
        catch (e) { window.northstarLog?.debug('renderer', 'paintCachedFavicon: ' + e); }
        if (!host || !window.tab?.cachedFavicon) {
            imgEl.remove();
            return;
        }
        window.tab.cachedFavicon(host).then((d) => {
            if (d)
                imgEl.src = d;
            else
                imgEl.remove();
        }).catch(() => imgEl.remove());
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
        let tabs = new Map(); // tabIndex → <div.tab-button>
        let splitPair = null; // [idxA, idxB] when split view is active
        // Hover a tab this long mid-drag and the drop splits with it instead of
        // reordering. Long enough that dragging past a tab never arms it.
        const SPLIT_DWELL_MS = 420;
        let activeTabDrag = null; // { cancel } while a tab drag is in flight
        let folderState = { folders: [], assign: new Map() }; // tab folders
        let tabUrls = new Map(); // tabIndex → url string
        let tabPrivate = new Map(); // tabIndex → boolean (private flag)
        let tabLoading = new Set(); // tabIndexes currently loading
        // Top-strip close freeze (P1-3): while the pointer is still over the strip
        // after a mouse close, keep every tab its current width so the NEXT tab's
        // ✕ slides under the cursor — repeated clicks close consecutive tabs. The
        // strip re-lays out once, animated, on mouseleave. Keyboard/programmatic
        // closes never set this (Chrome's CloseTabSource::kFromNonUIEvent).
        let closingFreeze = false;
        function freezeTopStripClose() { if (!sideTabs()) closingFreeze = true; }
        // While frozen, each closed tab's width is given back as trailing padding
        // on the strip, so its scrollable width never shrinks: in an overflowing
        // (scrolled) strip a shrink clamps scrollLeft and shifts every tab
        // sideways, and the next ✕ would no longer be under the cursor.
        let frozenPad = 0;
        // Tab insert/remove motion (P1-2). The enter animation is skipped for the
        // burst of rows created while the window boots (session restore) — a stagger
        // of fade-ins there just competes with first paint.
        const chromeBootAt = Date.now();
        const prefersReducedMotion = () => {
            try { return matchMedia('(prefers-reduced-motion: reduce)').matches; }
            catch (e) { return false; }
        };
        // Only the active workspace's tabs are shown in the strip.
        function filterTabsByWorkspace() {
            for (const [idx, btn] of tabs) {
                const ws = btn.dataset.ws || '1';
                btn.classList.toggle('ws-hidden', ws !== activeWorkspace);
            }
        }
        let activeTabIndex = 0;
        let currentTabUrl = '';
        // True once the user (click) or Cmd+L/Cmd+K intentionally focuses the
        // omnibox — lets the startup focus guard tell an intended focus from the
        // native focus-restore that pulls the bar on launch / new window.
        let omniFocusIntent = false;
        let currentTabTitle = '';
        // ── Shared helpers (renderer/lib/util.js) ─────────────────────────────────
        // Bound here, above the init sequence: anything declared after it is TDZ
        // while init runs (see CLAUDE.md invariant 2).
        const { debounce, throttle, looksLikeUrl, normalizeUrl, linkScore, isLowValueMatch,
                cleanliness, urlDisplayParts, reindexActive, preconnectOrigin } = window.Northstar.util;
        // ── Settings (synchronous) ────────────────────────────────────────────────
        let settings = {};
        try {
            settings = window.northstarSettings.getSync() || {};
        }
        catch (e) { window.northstarLog?.debug('renderer', 'filterTabsByWorkspace: ' + e); }
        // ── Localisation (renderer/lib/i18n.js) ───────────────────────────────────
        // The catalogue rides along in the settings payload, so labels can be
        // resolved before the first paint. Language changes re-apply live.
        const i18n = window.Northstar.i18n;
        i18n.init(settings.i18n || {});
        i18n.apply(document);
        try {
            window.tabsUI?.onLanguageChanged?.((payload) => {
                i18n.init(payload);
                i18n.apply(document);
            });
        }
        catch (e) { window.northstarLog?.debug('renderer', 'language listener: ' + e); }
        const getSearchEngine = () => settings.searchEngine || 'google';
        // Engines come from the main process (features/search-engines.js) so the
        // built-ins have one definition; `engines-changed` keeps this fresh when
        // the user edits them in Settings.
        let engineList = Array.isArray(settings.engines) && settings.engines.length
            ? settings.engines
            : [{ id: 'google', name: 'Google', keyword: 'g', url: 'https://www.google.com/search?q=%s' }];
        try { window.tabsUI?.onEnginesChanged?.((list) => { if (Array.isArray(list) && list.length) engineList = list; }); }
        catch (e) { window.northstarLog?.debug('renderer', 'getSearchEngine: ' + e); }
        const engineById = (id) => engineList.find(e => e.id === id) || engineList[0];
        /** Search URL for typed text, honouring a leading engine keyword. */
        const searchUrlFor = (text) => window.Northstar.util.searchUrl(text, engineList, getSearchEngine());
        const getPomSetting = (key, def) => (typeof settings[key] === 'number' ? settings[key] : def);
        // ── Private window detection (synchronous) ────────────────────────────────
        let isPrivateWindow = false;
        try {
            isPrivateWindow = window.northstarPrivate?.isPrivateWindowSync?.() ?? false;
        }
        catch (e) { window.northstarLog?.debug('renderer', 'getPomSetting: ' + e); }
        if (isPrivateWindow) {
            document.documentElement.setAttribute('data-private-window', 'true');
        }
        window.northstarPrivate?.onSetPrivateWindow?.((v) => {
            if (v)
                document.documentElement.setAttribute('data-private-window', 'true');
            else
                document.documentElement.removeAttribute('data-private-window');
        });
        // ── Shared state ──────────────────────────────────────────────────────────
        let menuOpen = false;
        /**
         * Ask for one line of text. Used by anything that edits a single value
         * (an Essential's page, …) so those actions do not each grow their own
         * dialog. Resolves through `onSave` only when the user commits.
         */
        function promptForText(title, value, onSave) {
            const modal = document.getElementById('text-prompt');
            const input = document.getElementById('tp-input');
            const titleEl = document.getElementById('tp-title');
            if (!modal || !input)
                return;
            titleEl.textContent = title;
            input.value = value || '';
            modal.classList.remove('hidden');
            // The page is a native view painted OVER the chrome, so it has to
            // stand aside while a modal is up (same as the profile modal).
            try { window.focusMode.overlayOpen(); }
            catch (e) { window.northstarLog?.debug('renderer', 'promptForText: ' + e); }
            input.focus();
            input.select();
            const close = () => {
                modal.classList.add('hidden');
                try { window.focusMode.overlayClose(); }
                catch (e) { window.northstarLog?.debug('renderer', 'promptForText: ' + e); }
                document.getElementById('tp-save').removeEventListener('click', save);
                document.getElementById('tp-cancel').removeEventListener('click', close);
                input.removeEventListener('keydown', onKey);
            };
            const save = () => { const v = input.value.trim(); close(); if (v) onSave(v); };
            const onKey = (e) => {
                if (e.key === 'Enter') { e.preventDefault(); save(); }
                if (e.key === 'Escape') { e.preventDefault(); close(); }
            };
            document.getElementById('tp-save').addEventListener('click', save);
            document.getElementById('tp-cancel').addEventListener('click', close);
            input.addEventListener('keydown', onKey);
        }
        // Assigned by initProfiles(); declared HERE, above the init sequence,
        // because spaceContextMenu() — shared by the space pill and the foot
        // avatars — is defined at module level and calls them, and a binding
        // declared further down the file is in the temporal dead zone when
        // init runs (see CLAUDE.md, invariant 2).
        let openProfileModal = () => {};
        let openCreateSpace = () => {};
        // ── DOM references ─────────────────────────────────────────────────────────
        const tabBar = document.getElementById('tab-bar');
        const tabsContainer = document.getElementById('tabs-container');
        const searchBar = document.getElementById('searchBar');
        const backBtn = document.getElementById('back-btn');
        const forwardBtn = document.getElementById('forward-btn');
        const reloadBtn = document.getElementById('reload-btn');
        const omnibox = document.querySelector('.omnibox');
        const omniIcon = document.getElementById('omni-icon');
        const urlDisplay = document.getElementById('url-display');
        const omniGhost = document.getElementById('omni-ghost');
        const menuBtn = document.getElementById('menu-btn');
        const addBtn = document.getElementById('new-tab-btn');
        const tabDragSpacer = document.getElementById('tab-drag-spacer');
        const bookmarkBtn = document.getElementById('bookmark-btn');
        const bookmarkBar = document.getElementById('bookmark-bar');
        const bookmarkBarItems = document.getElementById('bookmark-bar-items');
        // ── Bookmark bar (renderer/lib/bookmark-bar.js) ───────────────────────────
        // Constructed BEFORE the init sequence below: `initBookmarkBar` is a const,
        // so calling it from the init calls while this line sits further down the
        // file is a TDZ throw (CLAUDE.md invariant 2 — it bit exactly here).
        const bookmarks = window.Northstar.createBookmarkBar({
            bar: bookmarkBar,
            items: bookmarkBarItems,
            button: bookmarkBtn,
            initiallyVisible: !!settings.bookmarkBarVisible,
            currentUrl: () => currentTabUrl,
            currentTitle: () => currentTabTitle,
            activeTabIndex: () => activeTabIndex,
            paintCachedFavicon,
            makeFolderIcon,
        });
        const initBookmarkBar = bookmarks.init;
        /* ── Notice bar ────────────────────────────────────────────────────
           Browser-level messages, one at a time, every one dismissible. Declared
           HERE rather than further down the file because the init sequence below
           reaches it (CLAUDE.md invariant 2 — a const declared after those calls
           is TDZ when they run, and it has bitten in exactly this spot). */
        const noticeBar = document.getElementById('notice-bar');
        const noticeText = document.getElementById('notice-text');
        const noticePrimary = document.getElementById('notice-primary');
        const noticeDismiss = document.getElementById('notice-dismiss');
        let noticeCurrent = null;

        function hideNotice(remember) {
            if (remember && noticeCurrent?.id) {
                try { window.electronAPI.dismissNotice(noticeCurrent.id); }
                catch (e) { window.northstarLog?.debug('renderer', 'dismissNotice: ' + e); }
            }
            noticeCurrent = null;
            noticeBar?.classList.add('hidden');
            bookmarks.reportHeight();
        }
        /* showNotice({ id, text, action, onAction }) — `id` is what a dismissal
           is remembered against, so a notice the user has said no to never comes
           back. A notice with no action is just a statement and shows only the
           dismiss button. */
        function showNotice(n) {
            if (!noticeBar || !n || !n.text)
                return;
            noticeCurrent = n;
            noticeText.textContent = n.text;
            const hasAction = !!(n.action && typeof n.onAction === 'function');
            noticePrimary.textContent = n.action || '';
            noticePrimary.hidden = !hasAction;
            noticeBar.classList.remove('hidden');
            bookmarks.reportHeight();
        }
        noticePrimary?.addEventListener('click', () => {
            const n = noticeCurrent;
            // Acting on it settles the question, so it does not come back either.
            hideNotice(true);
            try { n?.onAction?.(); }
            catch (e) { window.northstarLog?.debug('renderer', 'notice action: ' + e); }
        });
        noticeDismiss?.addEventListener('click', () => hideNotice(true));

        /* What the main process already knows we should be asking. Pulled once
           at startup rather than pushed, so a window opened later does not race
           the check. */
        const T_NOTICE = (k, fallback) => {
            const v = window.Northstar?.i18n?.t(k);
            return (!v || v === k) ? fallback : v;
        };
        /* #ext-actions is <browser-action-list>, whose buttons live in a SHADOW
           root — so CSS cannot tell whether it holds anything (:empty only sees
           light-DOM children, and matched even with extensions installed, which
           hid every extension button in the bar). Watch the shadow root and say
           so with a class. */
        function initExtActionsGap() {
            const el = document.getElementById('ext-actions');
            if (!el)
                return;
            const sync = () => {
                const root = el.shadowRoot;
                // No shadow root yet = the element has not upgraded; assume it
                // will have content rather than hiding it pre-emptively.
                const count = root ? root.querySelectorAll('*').length : 1;
                el.classList.toggle('is-empty', count === 0);
            };
            sync();
            try {
                if (el.shadowRoot)
                    new MutationObserver(sync).observe(el.shadowRoot, { childList: true, subtree: true });
                else
                    setTimeout(initExtActionsGap, 600); // wait for the upgrade
            }
            catch (e) { window.northstarLog?.debug('renderer', 'extActions: ' + e); }
        }

        function initNotices() {
            try {
                window.electronAPI.pendingNotices?.().then((list) => {
                    const n = (list || [])[0];
                    if (n?.id === 'default-browser') {
                        showNotice({
                            id: 'default-browser',
                            text: T_NOTICE('notice.defaultBrowser', 'Make Northstar your default browser?'),
                            action: T_NOTICE('notice.makeDefault', 'Make default'),
                            onAction: () => window.electronAPI.makeDefaultBrowser?.(),
                        });
                    }
                }).catch(() => { });
            }
            catch (e) { window.northstarLog?.debug('renderer', 'initNotices: ' + e); }
            /* A captive portal opens its sign-in page on its own; this says WHY
               a tab just appeared. Not dismissible-forever — the next network
               is a different question — so it carries no id. */
            try {
                window.electronAPI.onNotice?.((n) => {
                    if (!n) return;
                    showNotice({ text: n.text, action: n.action || '', onAction: n.onAction });
                });
            }
            catch (e) { window.northstarLog?.debug('renderer', 'onNotice: ' + e); }
        }

        const updateBookmarkBtn = bookmarks.updateButton;
        // ── Init sequence ─────────────────────────────────────────────────────────
        initTabBarSide(); // set side/top layout BEFORE anything measures the strip
        initTabBar(); // registers all tab IPC listeners
        initWindowControls();
        initNavButtons();
        initAddressBar();
        initBookmarkBar();
        initFocusModeAndPomodoro();
        initPageActions();
        initNotices();
        initExtActionsGap();
        initMenu();
        initMenuBar();
        initDownloads();
        initExtensions();
        initUtilityBarConfig();
        initReaderAndPip();
        initProfiles();
        initEssentials();
        initHoverLabel();
        initPermissionChip();
        // ─────────────────────────────────────────────────────────────────────────
        // Hover label (ui-polish U1-7) — the chrome's own tooltip, replacing OS
        // tooltips (renderer/lib/hover-label.js). Tabs get title + host, but
        // only where the title can be cut short: the top strip and compact mode
        // (sidebar rows already show it in full). Everything else shows its
        // former `title`. It never lands on the page card (a native view drawn
        // over the chrome would hide it).
        // ─────────────────────────────────────────────────────────────────────────
        // ─────────────────────────────────────────────────────────────────────────
        // Permission chip (chrome-ux P2-2). Main reports, per tab, a request that
        // is pending / parked (doorhanger dismissed: click to reopen) or a decision
        // to confirm ("Camera allowed" for 2.5 s, then it collapses away).
        // ─────────────────────────────────────────────────────────────────────────
        function initPermissionChip() {
            const el = document.getElementById('omni-perm');
            const api = window.permissionChip;
            const icons = window.Northstar?.permissionIcons;
            if (!el || !api || !icons) return;
            const iconEl = el.querySelector('.omni-perm-icon');
            const textEl = el.querySelector('.omni-perm-text');
            const byTab = new Map(); // tab index → { state, iconType, allowed }
            let collapseTimer = null;
            const CONFIRM_MS = 2500;
            const label = (st) => {
                const name = T('perm.n.' + st.iconType, icons.NOUNS[st.iconType] || icons.NOUNS.generic);
                const key = st.allowed ? 'perm.allowed' : 'perm.blocked';
                const fallback = icons.chipText(st.iconType, st.allowed);
                try {
                    const v = window.Northstar?.i18n?.t(key, { name });
                    return (v && v !== key) ? v : fallback;
                }
                catch { return fallback; }
            };
            function render() {
                clearTimeout(collapseTimer);
                const st = byTab.get(activeTabIndex);
                if (!st) {
                    el.hidden = true;
                    el.classList.remove('expanded', 'collapsing');
                    return;
                }
                el.hidden = false;
                el.dataset.state = st.state;
                iconEl.innerHTML = icons[st.iconType] || icons.generic;
                const waiting = st.state === 'pending' || st.state === 'parked';
                el.disabled = st.state !== 'parked';
                const what = T('perm.n.' + st.iconType, icons.NOUNS[st.iconType] || icons.NOUNS.generic);
                el.setAttribute('aria-label', waiting ? T('perm.waiting', what + ' request') : label(st));
                if (st.state === 'decided') {
                    textEl.textContent = label(st);
                    el.classList.remove('collapsing');
                    el.classList.add('expanded');
                    collapseTimer = setTimeout(() => {
                        el.classList.add('collapsing');
                        el.classList.remove('expanded');
                        // Gone once the collapse has played.
                        collapseTimer = setTimeout(() => { byTab.delete(activeTabIndex); render(); }, 260);
                    }, CONFIRM_MS);
                }
                else {
                    textEl.textContent = '';
                    el.classList.remove('expanded', 'collapsing');
                }
            }
            api.onUpdate((d) => {
                if (d.tab == null) return;
                if (d.state === 'clear') byTab.delete(d.tab);
                else byTab.set(d.tab, { state: d.state, iconType: d.iconType || 'generic', allowed: !!d.allowed });
                if (d.tab === activeTabIndex) render();
            });
            el.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus where it was
            el.addEventListener('click', () => { if (byTab.get(activeTabIndex)?.state === 'parked') api.click(); });
            window.tab.onTabSwitched(() => setTimeout(render, 0));
            window.tab.onTabRemoved?.((_e, d) => { if (d && d.index != null) byTab.delete(d.index); });
        }
        function initHoverLabel() {
            const hl = window.Northstar?.hoverLabel;
            if (!hl) return;
            const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
            hl.init({
                content(el) {
                    const tab = el.closest('#tabs-container .tab-button');
                    if (!tab || el.closest('.tab-close, .tab-indicator')) return undefined; // controls inside a tab: their own tip
                    const de = document.documentElement;
                    if (de.dataset.tabbar !== 'top' && de.dataset.compact !== 'on') return null;
                    const title = tab.querySelector('.tab-title')?.textContent || '';
                    const url = String(tabUrls.get(parseInt(tab.dataset.index, 10)) || '');
                    return [title, /^https?:/i.test(url) ? hostOf(url) : ''];
                },
                avoid: () => {
                    const r = document.getElementById('content-area')?.getBoundingClientRect();
                    return r && r.width && r.height ? r : null;
                },
            });
        }
        // ─────────────────────────────────────────────────────────────────────────
        // Window controls
        // ─────────────────────────────────────────────────────────────────────────
        // Windows/Linux draw their own min/max/close. In TOP mode they live in the
        // tab strip (the topmost row); in SIDE mode that row is the sidebar, so they
        // move into the top utility bar instead — otherwise there are no controls at
        // all on Windows in side mode. macOS uses native traffic lights, untouched.
        function placeWindowControls() {
            const wc = document.getElementById('window-controls');
            if (!wc || !window.windowControls || window.windowControls.platform === 'darwin')
                return;
            const side = document.documentElement.dataset.tabbar !== 'top';
            const host = document.getElementById(side ? 'utility-bar' : 'tab-bar');
            if (host && wc.parentElement !== host)
                host.appendChild(wc);
        }
        function initWindowControls() {
            const container = document.getElementById('window-controls');
            if (!container || !window.windowControls)
                return;
            // Marks the root so layout can key off the platform (mac reserves room
            // for the native traffic lights; win/linux pin our controls top-right).
            document.documentElement.dataset.platform = window.windowControls.platform;
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
            document.getElementById('wc-close')?.addEventListener('click', () => window.windowControls.close());
            document.getElementById('wc-minimize')?.addEventListener('click', () => window.windowControls.minimize());
            document.getElementById('wc-maximize')?.addEventListener('click', () => window.windowControls.maximize());
            window.windowControls.onMaximizeChanged((isMax) => {
                const btn = document.getElementById('wc-maximize');
                if (!btn)
                    return;
                btn.title = isMax ? 'Restore' : 'Maximize';
                btn.innerHTML = isMax
                    ? `<svg viewBox="0 0 10 10" fill="none"><rect x="2" y="0" width="8" height="8" stroke="currentColor"/><rect x="0" y="2" width="8" height="8" stroke="currentColor" fill="var(--surface-container-lowest)"/></svg>`
                    : `<svg viewBox="0 0 10 10" fill="none"><rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor"/></svg>`;
            });
            placeWindowControls();
        }
        // ─────────────────────────────────────────────────────────────────────────
        // Navigation buttons (back / forward / reload)
        // ─────────────────────────────────────────────────────────────────────────
        function initNavButtons() {
            setupNavButton(backBtn, () => window.tab.goBack(activeTabIndex));
            setupNavButton(forwardBtn, () => window.tab.goForward(activeTabIndex));
            reloadBtn.addEventListener('click', () => {
                if (tabLoading.has(activeTabIndex))
                    window.tab.stop(activeTabIndex);
                else
                    window.tab.reload(activeTabIndex);
                releaseFocusToPage(reloadBtn);
            });
            addBtn.addEventListener('click', () => window.tab.newPage());
            window.addEventListener('click', (e) => {
                if (menuOpen)
                    window.electronAPI.windowClick({ x: e.clientX, y: e.clientY });
            });
            // Whatever had focus before, a press in the chrome means the chrome
            // is what you are using — take focus on the way DOWN so the click
            // itself lands on the control rather than paying for the focus.
            window.addEventListener('pointerdown', (e) => {
                try { window.tabsUI?.focusChrome?.(); }
                catch (err) { window.northstarLog?.debug('renderer', 'focusChrome: ' + err); }
                // A press outside the address field gives it up AT ONCE. The
                // field used to hold on for 400ms while the suggestions faded,
                // which made that first press read as "nothing happened".
                if (document.activeElement !== searchBar)
                    return;
                if (e.target.closest?.('.omnibox'))
                    return;
                hideSuggestions();
                searchBar.blur();
            }, true);
            window.menu.onClosed(() => { menuOpen = false; });
        }
        /**
         * Back/forward buttons — click navigates one step; holding the button
         * (or right-clicking it) shows the tab's history list.
         */
        /**
         * Drop the focus ring a toolbar click leaves behind.
         *
         * This used to hand OS focus to the page view as well, which is what a
         * single-process browser does — but the chrome and the page are
         * SEPARATE WebContentsViews here, and a view that does not hold focus
         * spends the next click getting it. That is the "first click on the
         * sidebar does nothing" bug: reload stole focus, and the rail had to
         * buy it back. The chrome keeps focus; clicking the page gives the page
         * focus, which is the same gesture that would have typed into it.
         */
        function releaseFocusToPage(btn) {
            try { btn?.blur(); }
            catch (e) { window.northstarLog?.debug('renderer', 'releaseFocusToPage: ' + e); }
        }
        function setupNavButton(btn, action) {
            let pressTimer = null;
            let menuShown = false;
            const showHistoryMenu = () => {
                const r = btn.getBoundingClientRect();
                window.tab.showNavHistoryMenu(activeTabIndex, Math.round(r.left), Math.round(r.bottom + 2));
            };
            btn.addEventListener('mousedown', (e) => {
                if (e.button !== 0 || btn.disabled)
                    return;
                menuShown = false;
                clearTimeout(pressTimer);
                pressTimer = setTimeout(() => { menuShown = true; showHistoryMenu(); }, 400);
            });
            btn.addEventListener('mouseup', () => clearTimeout(pressTimer));
            btn.addEventListener('mouseleave', () => clearTimeout(pressTimer));
            btn.addEventListener('click', () => {
                if (menuShown) {
                    menuShown = false;
                    return;
                } // long-press already handled
                action();
                // Clicking a toolbar button focuses it. Every browser hands the
                // keyboard back to the page afterwards; without this, the next
                // keystroke went to the chrome and did nothing.
                releaseFocusToPage(btn);
            });
            btn.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                if (!btn.disabled)
                    showHistoryMenu();
            });
        }
        function updateNavigationButtons(canGoBack, canGoForward) {
            backBtn.disabled = !canGoBack;
            forwardBtn.disabled = !canGoForward;
            backBtn.style.opacity = canGoBack ? '1' : '0.5';
            forwardBtn.style.opacity = canGoForward ? '1' : '0.5';
            backBtn.style.cursor = canGoBack ? 'pointer' : 'not-allowed';
            forwardBtn.style.cursor = canGoForward ? 'pointer' : 'not-allowed';
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
                if (suggestionsWarmed)
                    return;
                suggestionsWarmed = true;
                window.suggestions.warm?.().catch?.(() => { });
            };
            searchBar.addEventListener('focus', warmSuggestions, { once: true });
            setTimeout(warmSuggestions, 2500);
            searchBar.addEventListener('input', (e) => {
                userTyping = true;
                barEdited = true;
                // Only autocomplete on insertions — autofilling right after the user
                // deletes text would "bring back" the URL they just erased.
                lastInputWasInsert = !!(e.inputType && e.inputType.startsWith('insert'));
                ghostAccepted = null;
                if (lastInputWasInsert)
                    applyInlineAutofill(searchBar.value);
                else
                    clearGhost();
                updateSuggestions();
            });
            searchBar.addEventListener('focus', () => {
                clearGhost();
                updateUrlDisplay();
                updateOmniboxIcon();
                preconnectEngine(); // (P0-4) warm the search engine on focus

                if (userTyping) {
                    if (searchBar.value.trim())
                        updateSuggestions();
                }
                else if (barEdited) {
                    // Refocusing with an uncommitted edit — keep the typed text
                    // (it is preserved until you actually navigate).
                    searchBar.select();
                }
                else {
                    // On the new-tab page (or a blank tab) the bar stays empty and
                    // ready; otherwise focus shows the current URL, selected (P2).
                    const blank = !currentTabUrl || currentTabUrl === 'newtab' || currentTabUrl === 'home';
                    if (!blank && searchBar.value !== currentTabUrl)
                        searchBar.value = currentTabUrl;
                    searchBar.select();
                }
            });
            searchBar.addEventListener('blur', () => {
                clearGhost();
                ghostAccepted = null;
                // Uncommitted typed text stays in the bar; otherwise rest
                // on the full URL with the host emphasised (url-display overlay).
                if (!barEdited && currentTabUrl)
                    searchBar.value = restingValueFor(currentTabUrl);
                updateUrlDisplay();
                updateOmniboxIcon();
                setTimeout(() => {
                    if (overlayPointerDown)
                        return;
                    if (document.activeElement === searchBar)
                        return;
                    hideSuggestions();
                }, 400);
            });
            searchBar.addEventListener('keydown', onSearchKeyDown);
            // Moving the caret invalidates a completion that was drawn for the end
            // of the text.
            searchBar.addEventListener('mouseup', () => setTimeout(clearGhost, 0));
            // Lock / security icon → standard site-info panel (connection,
            // permissions, clear data). Only meaningful on real http(s) pages.
            omniIcon?.addEventListener('mousedown', (e) => {
                const kind = omnibox?.dataset.omni;
                if (kind !== 'secure' && kind !== 'insecure')
                    return;
                e.preventDefault();
                e.stopPropagation();
                const r = omniIcon.getBoundingClientRect();
                try {
                    window.siteInfo.open({ x: Math.round(r.left), y: Math.round(r.bottom) });
                }
                catch (e) { window.northstarLog?.debug('renderer', 'warmSuggestions: ' + e); }
            });
            // Overlay view was (re)created — restore focus to the address bar, but
            // only if the user was actually typing (the overlay is also pre-warmed
            // at startup, which must not grab focus or fake a typing session).
            window.suggestions.onCreated(() => { if (userTyping) {
                try {
                    searchBar.focus();
                }
                catch (e) { window.northstarLog?.debug('renderer', 'warmSuggestions: ' + e); }
            } });
            window.suggestions.onSelected(onSuggestionSelected);
            window.suggestions.onPointerDown(() => {
                overlayPointerDown = true;
                setTimeout(() => { overlayPointerDown = false; }, 350);
            });
            // Hovering a row in the overlay moves the keyboard selection to match,
            // so Enter goes to the hovered row. The overlay already repainted the
            // highlight, so this only updates the index (no re-render).
            window.suggestions.onHover?.((index) => {
                if (typeof index === 'number' && index >= 0 && index < currentSuggestions.length)
                    activeSuggestionIndex = index;
            });
            if (window.contentInteraction) {
                window.contentInteraction.onClicked(() => { hideSuggestions(); searchBar.blur(); });
            }
            // New blank tab (main process) → focus + select the address bar so the
            // user can immediately type a URL. This fires more than once per new
            // tab (the page load can steal focus back) — don't clobber text the
            // user already started typing.
            window.electronAPI.onFocusAddressBar?.(() => {
                omniFocusIntent = true; // Cmd+L / Cmd+K is an intentional focus
                if (userTyping && document.activeElement === searchBar)
                    return;
                try {
                    searchBar.focus();
                    searchBar.select();
                }
                catch (e) { window.northstarLog?.debug('renderer', 'warmSuggestions: ' + e); }
            });
            window.addEventListener('resize', positionSuggestions);
            window.addEventListener('scroll', positionSuggestions, true);
        }
        // Alt-tab return: a native tab view doesn't regain focus on window
        // activation on its own, so the page you were reading came back unfocused
        // (no scrolling/typing until a click). Hand focus back to the active page —
        // unless it was in a chrome field (the address bar, a rename box), which
        // keeps its DOM focus across the switch and should stay put.
        window.addEventListener('focus', () => {
            const ae = document.activeElement;
            const inField = !!(ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable));
            if (!inField) {
                try { window.tabsUI.focusPage(); }
                catch (e) { window.northstarLog?.debug('renderer', 'refocus page: ' + e); }
            }
        });
        // ── Suggestion state ──────────────────────────────────────────────────────
        let currentSuggestions = [];
        let activeSuggestionIndex = -1;
        // Declared HERE, above updateSuggestions/renderSuggestions which read them
        // (CLAUDE.md invariant 2 — a `let` below its reader is in the TDZ during
        // init). suggestSeq guards stale async renders; suggestAbort cancels the
        // in-flight remote suggest when a newer keystroke supersedes it.
        let suggestSeq = 0;
        let suggestAbort = null;
        // P0-2 — split passes. The LOCAL pass (open tabs/bookmarks/history) runs
        // un-throttled on every keystroke; the REMOTE pass (search suggest) is
        // throttled so a fast burst hits the network once, not per key. Remote
        // rows are kept across keystrokes so the list doesn't lose height while a
        // new request is in flight, and expire 500 ms after typing stops if not
        // refreshed. `syncResult` carries the local half so the remote pass can
        // re-merge without recomputing it. All declared above their readers
        // (invariant 2); `remoteThrottle` is assigned after fetchRemote exists.
        let keptRemote = { q: '', rows: [] };
        let remoteExpire = null;
        let syncResult = null;
        let remoteThrottle = null;
        // Omnibox a11y (P0-7): the live region is read here (above its readers,
        // invariant 2). `announce` writes the polite region; empty strings clear it.
        const omniLive = document.getElementById('omni-live');
        const announce = (msg) => { if (omniLive) omniLive.textContent = msg || ''; };
        let overlayPointerDown = false;
        let userTyping = false;
        let lastInputWasInsert = false;
        // Hosts seen in history, kept here so inline completion can be applied on
        // the keystroke itself. It used to run inside the debounced, awaited
        // suggestion fetch, so the address bar rewrote itself a beat AFTER you
        // stopped typing — a delayed, unasked-for edit of your own text, which
        // is what made it feel wrong. browsers complete synchronously.
        let hostCache = [];
        const rememberHosts = (items) => {
            for (const it of items || []) {
                try {
                    const h = new URL(it.url).hostname.toLowerCase();
                    if (h && !hostCache.includes(h))
                        hostCache.push(h);
                }
                catch (e) { window.northstarLog?.debug('renderer', 'rememberHosts: ' + e); }
            }
            if (hostCache.length > 400)
                hostCache = hostCache.slice(-400);
        };
        // ── Inline completion (ghost text) ────────────────────────────────────────
        // The remainder is painted dim after the caret rather than written into
        // the input. Tab / → make it real text, Shift+Tab takes that back.
        // Enter goes to the completion, Chrome-style (chrome-ux P2-5, decided by
        // Milad 2026-10-04): the top dropdown row becomes the completed address so
        // the highlighted row is always what Enter runs. Shift+Enter searches the
        // literal typed text instead (the search row sits right below).
        let ghostRest = ''; // the un-accepted remainder currently painted
        let ghostAccepted = null; // { typed, full } for Shift+Tab undo
        function clearGhost() {
            ghostRest = '';
            if (!omniGhost)
                return;
            omniGhost.querySelector('.typed').textContent = '';
            omniGhost.querySelector('.rest').textContent = '';
            omnibox?.classList.remove('has-ghost');
        }
        function setGhost(typed, rest) {
            if (!omniGhost || !rest) {
                clearGhost();
                return;
            }
            ghostRest = rest;
            omniGhost.querySelector('.typed').textContent = typed;
            omniGhost.querySelector('.rest').textContent = rest;
            omnibox?.classList.add('has-ghost');
            // Long text scrolls the input, which would leave the ghost floating
            // over the wrong glyphs — drop it rather than lie about the position.
            if (searchBar.scrollWidth > searchBar.clientWidth + 1 || searchBar.scrollLeft > 0)
                clearGhost();
        }
        /** Accept the painted completion into the bar. */
        function acceptGhost() {
            if (!ghostRest)
                return false;
            const typed = searchBar.value;
            searchBar.value = typed + ghostRest;
            clearGhost();
            ghostAccepted = { typed, full: searchBar.value };
            searchBar.setSelectionRange(searchBar.value.length, searchBar.value.length);
            updateSuggestions();
            return true;
        }
        /** Undo the last acceptance, putting the remainder back as ghost text. */
        function unacceptGhost() {
            if (!ghostAccepted || searchBar.value !== ghostAccepted.full)
                return false;
            const { typed, full } = ghostAccepted;
            ghostAccepted = null;
            searchBar.value = typed;
            searchBar.setSelectionRange(typed.length, typed.length);
            setGhost(typed, full.slice(typed.length));
            updateSuggestions();
            return true;
        }
        /** Best host in the local cache that extends `typed`; '' if none. */
        const ghostFromHistory = (typed) => {
            if (!typed || typed.includes(' ') || /^[a-z]+:/i.test(typed))
                return '';
            if (document.activeElement !== searchBar)
                return '';
            if (searchBar.selectionStart !== typed.length || searchBar.selectionEnd !== typed.length)
                return '';
            const ql = typed.toLowerCase();
            let best = null;
            for (const h of hostCache) {
                const bare = h.replace(/^www\./, '');
                const cand = bare.startsWith(ql) ? bare : (h.startsWith(ql) ? h : null);
                if (!cand || cand.length <= typed.length)
                    continue;
                if (!best || cand.length < best.length)
                    best = cand;
            }
            return best ? best.slice(typed.length) : '';
        };
        const applyInlineAutofill = (typed) => {
            const rest = ghostFromHistory(typed);
            if (rest)
                setGhost(typed, rest);
            else
                clearGhost();
        };
        let currentQuery = ''; // the user's typed text, for match highlighting
        let barEdited = false; // uncommitted typed text in the bar (survives blur)
        function getSuggestionsBounds() {
            /* Measure the FIELD, not the <input> inside it. The input starts
               after the lock/search glyph and stops short of the right padding,
               so anchoring to it hung the dropdown ~39px in from the field's
               left edge and 51px narrower — a panel that lined up with the text
               rather than with the control it belongs to. */
            const field = searchBar.closest('.omnibox') || searchBar;
            const r = field.getBoundingClientRect();
            return { left: r.left, top: r.bottom + 4, width: r.width };
        }
        function positionSuggestions() {
            if (!currentSuggestions.length)
                return;
            window.suggestions.update(getSuggestionsBounds(), currentSuggestions, activeSuggestionIndex, currentQuery, getSearchEngine());
        }
        function hideSuggestions() {
            userTyping = false;
            clearGhost();
            updateSuggestions.cancel();
            window.suggestions.close();
            currentSuggestions = [];
            activeSuggestionIndex = -1;
            searchBar.setAttribute('aria-expanded', 'false'); // (P0-7)
            announce(''); // nothing stale left in the live region once it's closed
        }
        // Pre-warm the connection to a highlighted suggestion's origin so Enter
        // starts hot. The decision of WHAT to warm is the pure preconnectOrigin
        // (renderer/lib/util.js): a url/navigate row → its own origin, a search
        // row → the engine's origin — never a tab switch, a container row, or a
        // non-web scheme, and only the ORIGIN, so no path or query leaves the
        // machine before the user commits. Deduped per origin; skipped entirely
        // in a private window or on a private tab so nothing leaks there.
        const searchEngineOrigin = () => {
            try { return new URL(searchUrlFor('a')).origin; }
            catch { return null; }
        };
        let lastPreconnected = '';
        function preconnect(origin) {
            if (!origin || origin === lastPreconnected)
                return;
            if (isPrivateWindow || tabPrivate.get(activeTabIndex))
                return;
            lastPreconnected = origin;
            window.suggestions.preconnect?.(origin);
        }
        function preconnectSuggestion(item) {
            try { preconnect(preconnectOrigin(item, searchEngineOrigin())); }
            catch (e) { window.northstarLog?.debug('renderer', 'preconnectSuggestion: ' + e); }
        }
        // On focus, before any suggestion exists, warm the default engine — the
        // most likely Enter target for a fresh query.
        function preconnectEngine() {
            try { preconnect(searchEngineOrigin()); }
            catch (e) { window.northstarLog?.debug('renderer', 'preconnectEngine: ' + e); }
        }
        function renderSuggestions(list) {
            if (!userTyping)
                return;
            // Keep the highlighted row by identity across re-renders (P0-3): when
            // async rows merge in, the selection follows the same row rather than
            // snapping back to the top. The base row is always index 0.
            activeSuggestionIndex = reindexActive(currentSuggestions, activeSuggestionIndex, list);
            currentSuggestions = list;
            if (!list.length) {
                hideSuggestions();
                return;
            }
            preconnectSuggestion(currentSuggestions[activeSuggestionIndex] || list[0]);
            window.suggestions.open(getSuggestionsBounds(), currentSuggestions, activeSuggestionIndex, currentQuery, getSearchEngine()).catch(() => { });
            // A11y (P0-7): the dropdown is open, and announce how many rows it has.
            searchBar.setAttribute('aria-expanded', 'true');
            announce(`${list.length} suggestion${list.length === 1 ? '' : 's'}`);
        }
        function setActiveSuggestion(newIndex) {
            if (!currentSuggestions.length)
                return;
            if (newIndex < 0)
                newIndex = currentSuggestions.length - 1;
            if (newIndex >= currentSuggestions.length)
                newIndex = 0;
            activeSuggestionIndex = newIndex;
            const item = currentSuggestions[newIndex];
            if (item) {
                clearGhost();
                searchBar.value = item.url || item.query || '';
                preconnectSuggestion(item);
                // A11y (P0-7): announce the row the arrow landed on.
                const title = item.title || item.query || item.url || '';
                const loc = item.url && item.url !== title ? `, ${item.url}` : '';
                announce(`${title}${loc}, ${newIndex + 1} of ${currentSuggestions.length}`);
            }
            window.suggestions.update(getSuggestionsBounds(), currentSuggestions, activeSuggestionIndex, currentQuery, getSearchEngine());
        }
        /**
         * Commit an address-bar navigation: load the URL, close the popup, and
         * move focus off the bar so it falls back to its resting display —
         * the expected behaviour on Enter or a suggestion click.
         */
        function commitNavigation(value) {
            barEdited = false;
            userTyping = false;
            ghostAccepted = null;
            const formatted = loadUrlInActiveTab(value);
            if (formatted)
                currentTabUrl = formatted; // optimistic; url-updated confirms
            hideSuggestions();
            searchBar.blur();
            updateOmniboxIcon();
        }
        function handleSuggestionSelect(index) {
            const item = currentSuggestions[index];
            if (!item)
                return;
            if (item.type === 'switch-tab') {
                hideSuggestions();
                searchBar.blur();
                window.tab.switch(item.tabIndex);
            }
            else if ((item.type === 'history' || item.type === 'bookmark') && item.url) {
                if (item.profile) { hideSuggestions(); searchBar.blur(); window.tab.openInContainer(item.profile, item.url); return; }
                searchBar.value = item.url;
                commitNavigation(item.url);
            }
            else if (item.query) {
                searchBar.value = item.query;
                commitNavigation(item.query);
            }
        }
        function onSuggestionSelected(item) {
            if (!item)
                return;
            // The click landed in the overlay view — reclaim OS focus for the
            // chrome view first so the blur below lands on a focused bar.
            try {
                searchBar.focus();
            }
            catch (e) { window.northstarLog?.debug('renderer', 'onSuggestionSelected: ' + e); }
            if (item.type === 'switch-tab') {
                hideSuggestions();
                searchBar.blur();
                window.tab.switch(item.tabIndex);
                return;
            }
            if ((item.type === 'history' || item.type === 'bookmark') && item.url) {
                if (item.profile) { hideSuggestions(); searchBar.blur(); window.tab.openInContainer(item.profile, item.url); return; }
                searchBar.value = item.url;
                commitNavigation(item.url);
            }
            else if (item.query) {
                searchBar.value = item.query;
                commitNavigation(item.query);
            }
            else {
                hideSuggestions();
            }
        }
        function onSearchKeyDown(e) {
            // Inline completion first: Tab (or → / End with the caret at the end)
            // turns the dim remainder into real text, Shift+Tab takes it back.
            // Only when there is something to act on — otherwise Tab keeps cycling
            // the suggestion list.
            if (e.key === 'Tab' && !e.shiftKey && ghostRest) {
                e.preventDefault();
                acceptGhost();
                return;
            }
            if (e.key === 'Tab' && e.shiftKey && ghostAccepted && searchBar.value === ghostAccepted.full) {
                e.preventDefault();
                unacceptGhost();
                return;
            }
            if ((e.key === 'ArrowRight' || e.key === 'End') && ghostRest
                && searchBar.selectionStart === searchBar.value.length
                && searchBar.selectionEnd === searchBar.value.length) {
                e.preventDefault();
                acceptGhost();
                return;
            }
            if (e.key === 'ArrowLeft' || e.key === 'Home')
                clearGhost();
            // Shift+Enter with a completion painted searches exactly what was
            // typed, ignoring the completion (P2-5). Only on the top row(s): an
            // arrowed-to history row keeps its own meaning.
            if (e.key === 'Enter' && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && ghostRest) {
                const item = currentSuggestions[activeSuggestionIndex];
                if (!item || item.completion) {
                    e.preventDefault();
                    const typed = searchBar.value.trim();
                    if (typed)
                        commitNavigation(searchUrlFor(typed));
                    return;
                }
            }
            // Alt+Enter opens the target in a NEW tab rather than the current one
            // (P0-8), as in Chrome/Firefox. A highlighted url row uses its url;
            // otherwise the bar text is resolved the same way a normal commit is.
            if (e.key === 'Enter' && e.altKey) {
                e.preventDefault();
                const item = activeSuggestionIndex >= 0 ? currentSuggestions[activeSuggestionIndex] : null;
                const target = (item && item.url) ? item.url : formatToUrl(searchBar.value);
                if (target) {
                    try { window.browserBookmarks.openInNewTab(target, true); }
                    catch (err) { window.northstarLog?.debug('renderer', 'alt-enter new tab: ' + err); }
                    hideSuggestions();
                }
                return;
            }
            // Ctrl/Cmd+Enter wraps a bare term in www. … .com; anything
            // that already looks like a URL just navigates normally.
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                const v = searchBar.value.trim();
                if (!v)
                    return;
                searchBar.value = /[\s./:]/.test(v) ? v : `www.${v}.com`;
                commitNavigation(searchBar.value);
                return;
            }
            if (currentSuggestions.length) {
                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setActiveSuggestion(activeSuggestionIndex + 1);
                    return;
                }
                if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setActiveSuggestion(activeSuggestionIndex - 1);
                    return;
                }
                if (e.key === 'Tab') {
                    e.preventDefault();
                    setActiveSuggestion(activeSuggestionIndex + (e.shiftKey ? -1 : 1));
                    return;
                }
                if (e.key === 'Escape') {
                    e.preventDefault();
                    hideSuggestions();
                    return;
                }
                // Shift+Delete forgets a history suggestion, as in Chrome/Firefox.
                // Only history (bookmarks/open tabs/search aren't "history").
                if (e.key === 'Delete' && e.shiftKey && activeSuggestionIndex >= 0) {
                    const item = currentSuggestions[activeSuggestionIndex];
                    if (item && item.type === 'history' && item.url) {
                        e.preventDefault();
                        try { window.browserHistory.remove(item.url); }
                        catch (err) { window.northstarLog?.debug('renderer', 'forget suggestion: ' + err); }
                        currentSuggestions.splice(activeSuggestionIndex, 1);
                        if (activeSuggestionIndex >= currentSuggestions.length)
                            activeSuggestionIndex = currentSuggestions.length - 1;
                        if (currentSuggestions.length)
                            window.suggestions.update(getSuggestionsBounds(), currentSuggestions, activeSuggestionIndex, currentQuery, getSearchEngine());
                        else
                            hideSuggestions();
                        return;
                    }
                }
                if (e.key === 'Enter' && activeSuggestionIndex >= 0) {
                    e.preventDefault();
                    const item = currentSuggestions[activeSuggestionIndex];
                    // The completion row loads the completed address (P2-5); the
                    // typed row loads exactly what is in the bar.
                    if (item?.type === 'action' || item?.type === 'navigate') {
                        const url = item.completion ? item.query : searchBar.value.trim();
                        if (url)
                            commitNavigation(url);
                        return;
                    }
                    handleSuggestionSelect(activeSuggestionIndex);
                    return;
                }
            }
            else if (e.key === 'Escape') {
                // Popup already closed: a second Escape reverts the bar to the
                // page URL, keeping focus.
                e.preventDefault();
                barEdited = false;
                userTyping = false;
                clearGhost();
                ghostAccepted = null;
                searchBar.value = currentTabUrl || '';
                searchBar.select();
                updateOmniboxIcon();
                return;
            }
            if (e.key === 'Enter') {
                const url = (searchBar.value + (ghostRest || '')).trim();
                if (url)
                    commitNavigation(url);
            }
        }
        // ── Suggestion data sources ───────────────────────────────────────────────
        function getOpenTabSuggestions(q) {
            const ql = q.toLowerCase();
            const results = [];
            tabs.forEach((btn, index) => {
                if (index === activeTabIndex)
                    return;
                const url = tabUrls.get(index) || '';
                const title = btn.querySelector('.tab-title')?.textContent || '';
                if (!url || url === 'newtab' || url.startsWith('file://'))
                    return;
                if (!url.toLowerCase().includes(ql) && !title.toLowerCase().includes(ql))
                    return;
                results.push({ type: 'switch-tab', tabIndex: index, title: title || url, url });
            });
            return results;
        }
        async function getBookmarkSuggestions(q, limit = 3) {
            try {
                const entries = await window.browserBookmarks.getAll();
                if (!Array.isArray(entries) || !q)
                    return [];
                const ql = q.toLowerCase();
                const results = [];
                for (const e of entries) {
                    if (!e.url)
                        continue;
                    if (!e.url.toLowerCase().includes(ql) && !(e.title || '').toLowerCase().includes(ql))
                        continue;
                    const base = e.title || e.url;
                    const pName = null;
                    results.push({ type: 'bookmark', url: e.url, title: pName ? `${base}  ·  ${pName}` : base, profile: e.profile || null });
                    if (results.length >= limit)
                        break;
                }
                return results;
            }
            catch {
                return [];
            }
        }
        async function getHistorySuggestions(q, limit = 5) {
            try {
                const entries = await (window.browserHistory.search
                    ? window.browserHistory.search(q, limit * 3)
                    : window.browserHistory.get());
                if (!Array.isArray(entries) || !q)
                    return [];
                const results = [];
                const seen = new Set();
                for (const e of entries) {
                    if (!e.url)
                        continue;
                    // Key by URL *and profile* so the same page under two containers
                    // stays as two distinct suggestions.
                    const key = normalizeUrl(e.url) + '|' + (e.profile || '');
                    if (seen.has(key))
                        continue;
                    seen.add(key);
                    const base = e.title || e.url;
                    const pName = null;
                    results.push({
                        type: 'history', url: e.url,
                        title: pName ? `${base}  ·  ${pName}` : base,
                        profile: e.profile || null,
                    });
                    if (results.length >= limit)
                        break;
                }
                return results;
            }
            catch {
                return [];
            }
        }
        async function getSearchSuggestions(q, limit = 6, signal = undefined) {
            if (!q)
                return [];
            // Firefox disables remote search suggestions in private browsing —
            // never leak keystrokes for a private window or private tab.
            if (isPrivateWindow || tabPrivate.get(activeTabIndex))
                return [];
            const engine = getSearchEngine();
            const suggestMap = {
                google: `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(q)}`,
                duckduckgo: `https://duckduckgo.com/ac/?q=${encodeURIComponent(q)}&type=list`,
                bing: `https://api.bing.com/osjson.aspx?query=${encodeURIComponent(q)}`,
            };
            try {
                const res = await fetch(suggestMap[engine] || suggestMap.google, { cache: 'no-store', signal });
                const data = await res.json();
                const arr = Array.isArray(data) && Array.isArray(data[1]) ? data[1] : [];
                return arr.slice(0, limit).map(s => ({ type: engine, query: s }));
            }
            catch {
                return [];
            }
        }
        /**
         * standard inline autocomplete: if the top domain match extends what
         * the user typed, return the completed host (e.g. "you" → "youtube.com").
         * Returns null when it isn't safe to complete (caret not at end, user is
         * deleting, query has spaces, etc.). Caller paints it as ghost text.
         */
        function computeAutofill(q, url) {
            if (!lastInputWasInsert || !userTyping)
                return null;
            if (document.activeElement !== searchBar)
                return null;
            if (searchBar.value !== q)
                return null; // user typed more since
            if (q.includes(' ') || /^https?:\/\//i.test(q))
                return null;
            if (searchBar.selectionStart !== q.length ||
                searchBar.selectionEnd !== q.length)
                return null; // caret must be at the end
            const ql = q.toLowerCase();
            let host;
            try {
                host = new URL(url).hostname.toLowerCase();
            }
            catch {
                return null;
            }
            const bare = host.replace(/^www\./, '');
            const match = bare.startsWith(ql) ? bare : (host.startsWith(ql) ? host : null);
            return (match && match.length > q.length) ? match : null;
        }
        // Assemble the final list from the local half (base + ghost domain +
        // ranked links) and whatever remote search rows we currently hold. Shared
        // by both passes so the ordering/caps (base → ghost → ≤3 search → ≤4
        // links = ≤8, see MAX_HEIGHT in ipc/suggestions.js) are identical however
        // the list was triggered.
        function assembleSuggestions(local, remoteRows) {
            const { base, typedRow, ghostKey, topDomain, rankedLinks } = local;
            const merged = [base];
            const seenQuery = new Set([String(base.query).toLowerCase()]);
            if (base.completion) {
                // The completion row is first; the typed text (search) is second.
                merged.push(typedRow);
                seenQuery.add(String(typedRow.query).toLowerCase());
            }
            else if (ghostKey) {
                // A match whose ghost could not be painted (e.g. the text
                // overflows) stays reachable as its own row.
                merged.push(topDomain);
            }
            // Search suggestions right under the heuristic row (max 3); skip
            // base-query dupes. Suggestions show ahead of history/bookmarks.
            let searchCount = 0;
            for (const s of remoteRows || []) {
                const k = (s.query || '').toLowerCase();
                if (k && !seenQuery.has(k)) {
                    merged.push(s);
                    seenQuery.add(k);
                    if (++searchCount >= 3)
                        break;
                }
            }
            // History / bookmarks / open tabs — tight cap (max 4).
            let linkCount = 0;
            for (const link of rankedLinks) {
                if (ghostKey && normalizeUrl(link.url) === ghostKey)
                    continue;
                merged.push(link);
                if (++linkCount >= 4)
                    break;
            }
            return merged;
        }
        // The REMOTE pass: fetch search suggestions and merge them in. Throttled
        // (leading edge, ≥100 ms) so a fast keystroke burst hits the network once.
        // Reads the query fresh at fire time — on a trailing call that is the
        // latest keystroke, not the one that scheduled it. Seq-guarded + aborted
        // so a slow earlier response can never overwrite a newer render (P0-1).
        async function fetchRemote() {
            const q = searchBar.value.trim();
            if (!q || !syncResult || syncResult.q !== q)
                return; // local pass hasn't caught up to this query yet
            const seq = suggestSeq;
            try { suggestAbort?.abort(); } catch (e) { /* already settled */ }
            suggestAbort = new AbortController();
            try {
                const rows = await getSearchSuggestions(q, 6, suggestAbort.signal);
                if (seq !== suggestSeq)
                    return; // a newer keystroke superseded this request
                keptRemote = { q, rows };
                if (userTyping && syncResult && syncResult.q === q)
                    renderSuggestions(assembleSuggestions(syncResult, rows));
            }
            catch { /* keep whatever is rendered */ }
        }
        remoteThrottle = throttle(fetchRemote, 100);
        // The LOCAL pass, run on every keystroke with NO debounce: open tabs are
        // in-memory and bookmarks/history are local IPC, so their rows render as
        // soon as they resolve rather than 120 ms after you stop typing. Previous
        // remote rows are carried through (assembleSuggestions) so the list keeps
        // its height while the throttled remote pass catches up.
        function updateSuggestions() {
            const q = searchBar.value.trim();
            // This keystroke's number — the remote pass checks it before landing.
            const seq = ++suggestSeq;
            // Arm the expiry: 500 ms after the last keystroke, drop remote rows
            // that were never refreshed so a stale search list doesn't linger.
            clearTimeout(remoteExpire);
            remoteExpire = setTimeout(() => {
                if (keptRemote.rows.length) {
                    keptRemote = { q: '', rows: [] };
                    if (userTyping && syncResult)
                        renderSuggestions(assembleSuggestions(syncResult, []));
                }
            }, 500);
            if (!q) {
                hideSuggestions();
                return;
            }
            const ql = q.toLowerCase();
            currentQuery = q; // typed text drives the bold-completion highlighting
            // Immediate feedback before the local IPC resolves.
            // A ghost already painted from the host cache is the top row (P2-5).
            const typedNow = looksLikeUrl(q) ? { type: 'navigate', query: q } : { type: 'action', query: q };
            renderSuggestions(ghostRest && searchBar.value === q
                ? [{ type: 'navigate', query: q + ghostRest, completion: true }, typedNow]
                : [typedNow]);
            (async () => {
                try {
                    // Over-fetch links so relevance scoring has enough candidates
                    // to find good matches before we truncate the list.
                    const openTabs = getOpenTabSuggestions(q);
                    const [bookmarks, hist] = await Promise.all([
                        getBookmarkSuggestions(q, 12),
                        getHistorySuggestions(q, 20),
                    ]);
                    // A newer keystroke has already run — drop these stale results.
                    if (seq !== suggestSeq)
                        return;
                    // Score each link/tab; drop irrelevant and low-value
                    // (auth/redirect) matches. Bookmarks slightly outrank history.
                    const scored = [];
                    const consider = (item, bias) => {
                        const s = linkScore(item, ql);
                        if (s < 0 || isLowValueMatch(item.url, s))
                            return;
                        scored.push({ item, score: s + bias, clean: cleanliness(item) });
                    };
                    for (const b of bookmarks)
                        consider(b, -0.1);
                    for (const h of hist)
                        consider(h, 0);
                    rememberHosts(hist);
                    for (const t of openTabs)
                        consider(t, -0.2);
                    // Sort by relevance tier, then cleanliness (short, titled first).
                    scored.sort((a, b) => (a.score - b.score) || (a.clean - b.clean));
                    // Dedup by normalized host+path (ignoring www), keep the best.
                    const rankedLinks = [];
                    const seenLinks = new Set();
                    for (const { item } of scored) {
                        const key = normalizeUrl(item.url);
                        if (seenLinks.has(key))
                            continue;
                        seenLinks.add(key);
                        rankedLinks.push(item);
                    }
                    // Ghost-complete from the top domain-prefix match. The bar keeps
                    // exactly what was typed — the completion is only painted — so
                    // the first row (what Enter runs) stays the typed query, and the
                    // completed domain stays reachable as its own row below.
                    const topDomain = rankedLinks.find(x => linkScore(x, ql) === 0);
                    const completed = topDomain ? computeAutofill(q, topDomain.url) : null;
                    if (completed && searchBar.value === q)
                        setGhost(q, completed.slice(q.length));
                    // A painted completion (from this match or the host cache)
                    // is what Enter runs, so it is the top row; the literal
                    // search follows it (P2-5).
                    const typedRow = looksLikeUrl(q)
                        ? { type: 'navigate', query: q }
                        : { type: 'action', query: q };
                    const base = ghostRest && searchBar.value === q
                        ? { type: 'navigate', query: q + ghostRest, completion: true }
                        : typedRow;
                    const ghostKey = completed ? normalizeUrl(topDomain.url) : null;
                    // Carry remote rows through only while they match this query;
                    // otherwise they belong to an older keystroke and are dropped.
                    syncResult = { q, ql, base, typedRow, ghostKey, topDomain, rankedLinks };
                    const remoteRows = keptRemote.q === q ? keptRemote.rows : [];
                    renderSuggestions(assembleSuggestions(syncResult, remoteRows));
                    // Kick the throttled remote pass (private tabs fetch nothing).
                    remoteThrottle();
                }
                catch { /* keep base rendered */ }
            })();
        }
        // hideSuggestions() calls this: stop the throttle and expiry, abort any
        // in-flight remote request, and forget carried-over rows.
        updateSuggestions.cancel = () => {
            remoteThrottle?.cancel();
            clearTimeout(remoteExpire);
            try { suggestAbort?.abort(); } catch (e) { /* already settled */ }
            keptRemote = { q: '', rows: [] };
            syncResult = null;
        };
        /* The theme editor opens as a popup over the chrome, not as a trip to
           Settings: you are choosing a colour for the thing you are looking
           at, and the answer should appear next to it. Same instrument
           either way (renderer/lib/theme-editor.js). */
        /* Where the last context menu was opened. Row handlers are invoked with
           no arguments, so an action that needs to know where the user clicked
           — the theme panel hangs off that point — has nowhere else to read it
           from. Declared HERE, above its reader: a `let` further down the file
           is in the temporal dead zone while the init sequence runs (CLAUDE.md
           invariant 2). */
        let lastCtxPoint = null;

        function openThemePanel(spaceId = null) {
            /* At the cursor. The panel is about the space you just clicked, so it
               opens where the click was — not pinned to the sidebar's right edge,
               which drifts far from the pointer once the sidebar is widened.
               panelBounds() (align:left) puts the panel's left/top at this point
               and clamps it on-screen, so it reads as coming from the click the
               way the context menu it was launched from did. */
            let anchor = null;
            try {
                const p = lastCtxPoint;
                if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
                    const x = Math.round(p.x), y = Math.round(p.y);
                    anchor = { left: x, right: x, top: y, bottom: y };
                }
                else {
                    // No click point (opened from a non-menu path): fall back to
                    // beside the sidebar, level with its top.
                    const rail = document.getElementById('tab-bar')?.getBoundingClientRect();
                    if (rail) {
                        const edge = Math.round(rail.right), mid = Math.round(rail.top + 40);
                        anchor = { left: edge, right: edge, top: mid, bottom: mid };
                    }
                }
            }
            catch (e) { window.northstarLog?.debug('renderer', 'openThemePanel: ' + e); }
            try { window.themePanel?.toggle(anchor, spaceId ? String(spaceId) : null); }
            catch (e) { window.northstarLog?.debug('renderer', 'openThemePanel: ' + e); }
        }

        /* ── Page actions ──────────────────────────────────────────────────
           One button in the bar, a panel behind it. The panel holds no state and
           reimplements nothing: it reports which action was pressed and the
           chrome presses the button that already does it. The state it renders
           is read off those same buttons, so "is this bookmarked?" has exactly
           one answer and it is the one the toolbar already had. */
        function pageActionsState() {
            const shown = (id) => {
                const b = document.getElementById(id);
                return !!b && !b.classList.contains('hidden');
            };
            const available = [];
            if (shown('reader-btn')) available.push('reader');
            if (shown('pip-btn')) available.push('pip');
            /* Downloads is always offered. Reader and PiP genuinely depend on
               what the page contains, but the downloads list is browser-level:
               the toolbar icon hid itself when the list was empty because an
               icon that is always there says nothing, whereas a PANEL row that
               is dead until you have downloaded something is just a dead row —
               and its panel already has an empty state to show. */
            available.push('downloads');
            const url = String(tabUrls.get(activeTabIndex) || '');
            const internal = !!northstarDisplay(url) || !/^https?:/i.test(url);
            let host = '';
            try { host = url && /^https?:/i.test(url) ? new URL(url).hostname.replace(/^www\./, '') : ''; }
            catch (e) { window.northstarLog?.debug('renderer', 'pageActionsState: ' + e); }
            return {
                available,
                bookmarked: !!document.getElementById('bookmark-btn')?.classList.contains('active'),
                focus: !!document.getElementById('focus-btn')?.classList.contains('active'),
                secure: /^https:/i.test(url),
                internal,
                host,
            };
        }

        function initPageActions() {
            const btn = document.getElementById('page-actions-btn');
            btn?.addEventListener('click', (e) => {
                const r = e.currentTarget.getBoundingClientRect();
                try {
                    window.pageActions?.toggle(
                        { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
                        pageActionsState());
                }
                catch (err) { window.northstarLog?.debug('renderer', 'pageActions: ' + err); }
            });
            // The panel presses the button that already owns the behaviour.
            try {
                window.pageActions?.onAction((action) => {
                    const target = {
                        reader: 'reader-btn', pip: 'pip-btn', downloads: 'downloads-btn',
                        bookmark: 'bookmark-btn', focus: 'focus-btn', extensions: 'extensions-btn',
                    }[action];
                    if (target) {
                        document.getElementById(target)?.click();
                        return;
                    }
                    if (action === 'site-info') {
                        document.getElementById('omni-icon')?.click();
                        return;
                    }
                    // `copy-link` never reaches here — ipc/page-actions.js does it in
                    // the main process, where the clipboard does not depend on which
                    // renderer happens to be focused.
                });
            }
            catch (e) { window.northstarLog?.debug('renderer', 'pageActions wiring: ' + e); }
        }

        // ── URL loading ───────────────────────────────────────────────────────────
        // Turn omnibox / dropped input into a loadable URL: pass through real
        // URLs, http-ify bare domains, and send anything else to the search engine.
        function formatToUrl(input) {
            // Shared with the new-tab page via renderer/lib/util.toNavigableUrl, so
            // the two entry surfaces resolve typed text identically.
            return window.Northstar.util.toNavigableUrl(input, engineList, getSearchEngine());
        }
        function loadUrlInActiveTab(url) {
            const formatted = formatToUrl(url);
            window.tab.loadUrl(activeTabIndex, formatted);
            return formatted;
        }
        function getDomainDisplay(url) {
            if (!url || url === 'newtab' || url.startsWith('file://'))
                return url || '';
            return window.urlUtils?.getDomain(url) || url;
        }
        // Internal-page tokens ('settings', 'settings/appearance', 'history',
        // 'bookmarks') display as northstar:// urls in the omnibox. Accepts a bare
        // token or an already-formed northstar:// url; null for anything else.
        function northstarDisplay(token) {
            if (!token)
                return null;
            if (/^northstar:\/\//i.test(token))
                return token;
            const base = String(token).split('/')[0];
            if (['settings', 'history', 'bookmarks'].includes(base))
                return 'northstar://' + token;
            return null;
        }
        // ── standard resting URL display ─────────────────────────────────────
        // While the bar is unfocused the full URL stays visible, painted into the
        // #url-display overlay: host in full text colour, scheme and path dimmed.
        // The input underneath keeps the complete URL (transparent text) so focus
        // and select-all behave normally.
        // Resting input value: the full URL for http(s) pages, the legacy domain
        // fallback for internal pages (newtab, file://).
        function restingValueFor(url) {
            // The new-tab page (and a blank tab) rest with an EMPTY, ready bar —
            // you type, you go. 'home' is the NTP token (P2).
            if (!url || url === 'newtab' || url === 'home')
                return '';
            const ns = northstarDisplay(url);
            if (ns)
                return ns;
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
            if (document.activeElement === searchBar && userTyping)
                return;
            // Uncommitted typed text survives same-page updates (title / favicon
            // refreshes); only a real navigation replaces it.
            if (barEdited && url === currentTabUrl)
                return;
            barEdited = false;
            currentTabUrl = url || ''; // callers re-assign right after; needed here so the display check is coherent
            if (document.activeElement !== searchBar) {
                searchBar.value = restingValueFor(url);
            }
            else {
                searchBar.value = url;
            }
            updateUrlDisplay();
            updateOmniboxIcon();
            hideSuggestions();
        }
        // Context-aware address-bar icon: a lock on HTTPS, a "not secure" glyph on
        // HTTP, and the search glyph while typing or on internal / new-tab pages.
        function updateOmniboxIcon() {
            if (!omnibox)
                return;
            if (document.activeElement === searchBar) {
                omnibox.dataset.omni = 'search';
                return;
            }
            const url = currentTabUrl || '';
            if (/^https:\/\//i.test(url))
                omnibox.dataset.omni = 'secure';
            else if (/^http:\/\//i.test(url))
                omnibox.dataset.omni = 'insecure';
            else if (/^(northstar|file|about|data|blob|chrome):/i.test(url))
                omnibox.dataset.omni = 'internal'; // app page, not a web origin (P2-1)
            else
                omnibox.dataset.omni = 'search';    // blank / new tab
        }
        // Loading state → tab spinner + reload/stop button toggle.
        // Inline SVG throbber (P1-1). Built lazily per tab and removed when the
        // load ends, so idle rows carry no extra DOM. One <circle r=7> (C≈44, the
        // dasharray the CSS animates); colour (wait grey vs load accent) and the
        // favicon handoff are pure CSS off the waiting/loading classes.
        const THROBBER_SVG = '<svg class="tab-throbber" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7"/></svg>';
        function setTabLoading(index, loading, phase = 'loading') {
            if (loading)
                tabLoading.add(index);
            else
                tabLoading.delete(index);
            const btn = tabs.get(index);
            if (btn) {
                btn.classList.toggle('loading', !!loading);
                // 'waiting' only before the response commits; 'loading' replaces it.
                btn.classList.toggle('waiting', !!loading && phase === 'waiting');
                // Loading starting clears the slept/crashed row states (P1-8): a
                // woken tab reloads, and a reloaded crashed tab is live again.
                if (loading)
                    btn.classList.remove('slept', 'crashed');
                let throbber = btn.querySelector('.tab-throbber');
                if (loading && !throbber) {
                    btn.insertAdjacentHTML('afterbegin', THROBBER_SVG);
                }
                else if (!loading && throbber) {
                    throbber.remove(); // load done → favicon pops to full (CSS)
                }
            }
            if (index === activeTabIndex)
                updateReloadButton();
        }
        function updateReloadButton() {
            const loading = tabLoading.has(activeTabIndex);
            reloadBtn.classList.toggle('loading', loading);
            reloadBtn.title = loading ? 'Stop' : 'Reload';
        }
        // ─────────────────────────────────────────────────────────────────────────
        // ─────────────────────────────────────────────────────────────────────────
        // Tab bar
        // ─────────────────────────────────────────────────────────────────────────
        function initTabBar() {
            // Release the close-freeze (P1-3) when the pointer leaves the strip:
            // the survivors have held their widths through a run of closes; now
            // re-lay-out once, animated by the tab-button width transition.
            tabBar.addEventListener('mouseleave', () => {
                if (!closingFreeze)
                    return;
                closingFreeze = false;
                frozenPad = 0;
                tabsContainer.style.paddingRight = '';
                tabBar.classList.add('relayout-anim');
                updateTabWidths(tabs.size);
                updateScrollShadows();
                // Drop the transition class once the move has played, so later
                // width changes (resize, drag) stay instant.
                setTimeout(() => tabBar.classList.remove('relayout-anim'), 240);
            });
            // Another window's torn-off tab is hovering over our strip → light up.
            window.dragdrop.onMergeHover?.((v) => tabBar.classList.toggle('merge-target', !!v));
            // Released over the page card: the drop sheet there handled it, and
            // this side never saw a pointerup — drop the gesture.
            window.dragdrop.onDragEnded?.(() => { try { activeTabDrag?.cancel(); } catch (e) { window.northstarLog?.debug('renderer', 'initTabBar: ' + e); } });
            window.pinActiveTab = () => window.tab.pin(activeTabIndex);
            // ── IPC events from main process ──────────────────────────────────────
            window.tab.onTabCreated((_e, data) => {
                tabPrivate.set(data.index, !!data.private);
                createTabButton(data.index, data.title, data.afterIndex ?? null, data.active !== false, !!data.private, !!data.container, data.workspace || '1', !!data.essential);
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
            // A new-tab page has no favicon of its own; the row shows the app's
            // mark instead of an empty icon column (as a native browser does).
            const markHomeTab = (index, url) => {
                const btn = tabs.get(index);
                if (btn)
                    btn.dataset.home = (url === 'home' || url === 'newtab') ? '1' : '';
            };
            window.tab.onTabSwitched((_e, data) => {
                activeTabIndex = data.index;
                if (data.url) {
                    tabUrls.set(data.index, data.url);
                    markHomeTab(data.index, data.url);
                }
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
                    }
                    else {
                        document.documentElement.removeAttribute('data-private-tab');
                    }
                }
            });
            window.tab.onUrlUpdated((_e, data) => {
                if (data.url) {
                    tabUrls.set(data.index, data.url);
                    markHomeTab(data.index, data.url);
                }
                if (data.private !== undefined)
                    tabPrivate.set(data.index, !!data.private);
                if (data.index === activeTabIndex) {
                    updateSearchBarUrl(data.url);
                    currentTabUrl = data.url || '';
                    currentTabTitle = data.title || '';
                    updateBookmarkBtn(currentTabUrl);
                    // Sync private-tab attribute
                    if (!isPrivateWindow) {
                        if (tabPrivate.get(data.index)) {
                            document.documentElement.setAttribute('data-private-tab', 'true');
                        }
                        else {
                            document.documentElement.removeAttribute('data-private-tab');
                        }
                    }
                }
                updateTabTitle(data.index, data.title || data.url, data.favicon);
                const _b = tabs.get(data.index);
                if (_b) _b.dataset.customLabel = data.hasCustomLabel ? '1' : '';
            });
            window.tab.onNavigationUpdated((_e, data) => {
                if (data.index === activeTabIndex)
                    updateNavigationButtons(data.canGoBack, data.canGoForward);
            });
            window.tab.onTabLoading((_e, data) => {
                setTabLoading(data.index, data.loading, data.phase);
            });
            // Slept / crashed row states (P1-8). Cleared by setTabLoading when the
            // tab next starts loading (wake reloads; a reloaded crash is live).
            window.tab.onTabSlept?.((_e, data) => tabs.get(data.index)?.classList.add('slept'));
            window.tab.onTabCrashed?.((_e, data) => tabs.get(data.index)?.classList.add('crashed'));
            try { window.tab.onIconChanged(({ index, icon }) => applyCustomTabIcon(Number(index), icon)); }
            catch (e) { window.northstarLog?.debug('renderer', 'initTabBar: ' + e); }
            window.tabsUI?.onPinTab((index) => {
                const btn = document.querySelector(`#tabs-container .tab-button[data-index="${index}"]`);
                if (!btn)
                    return;
                const isPinned = btn.classList.toggle('pinned');
                btn.dataset.pinned = isPinned ? '1' : '';
                // Placement is layoutFolders' job — it is the only thing that
                // knows the full panel order (pinned, folders, New Tab, tabs).
                // Hand-placing here is what let pinned tabs land in the wrong spot.
                layoutFolders();
                const ordered = [...tabsContainer.querySelectorAll('.tab-button')].map(el => parseInt(el.dataset.index));
                if (ordered.length)
                    window.tab.reorder(ordered);
                updateTabWidths(tabs.size);
                updateScrollShadows();
                });
            // Split view: mark the two tabs that are on screen together so the strip
            // shows the pairing (the focused one keeps the normal active highlight).
            try {
                window.tabsUI?.onSplitChanged((pair) => {
                    splitPair = (Array.isArray(pair) && pair.length === 2) ? pair.map(Number) : null;
                    applySplitMarks();
                });
            }
            catch (e) { window.northstarLog?.debug('renderer', 'initTabBar: ' + e); }
            // Folders: main sends the active workspace's folders + tab assignments.
            try {
                const applyFolders = (data) => {
                    folderState.folders = Array.isArray(data?.folders) ? data.folders : [];
                    folderState.assign = new Map((data?.assignments || []).map(([i, f]) => [Number(i), f]));
                    layoutFolders();
                };
                window.folders?.onChanged(applyFolders);
                // A folder moved to another space takes its tabs with it, so re-tag
                // them here or they'd stay visible in the space they just left.
                window.folders?.onTabsMoved(({ indices, workspace }) => {
                    for (const i of indices || []) {
                        const btn = tabs.get(Number(i));
                        if (btn) btn.dataset.ws = String(workspace);
                    }
                    filterTabsByWorkspace();
                });
                // Pull the current folders (restored ones exist before this listener).
                // The session restore assigns folders and the active workspace on
                // the main side at its own pace, so this first fetch can land on
                // the pre-restore workspace and come back empty — re-fetch once
                // shortly after rather than depend on main winning the race.
                const pullFolders = () => window.folders?.list().then(applyFolders).catch(() => { });
                pullFolders();
                setTimeout(pullFolders, 600);
            }
            catch (e) { window.northstarLog?.debug('renderer', 'pullFolders: ' + e); }
            // Called by the main process (executeJavaScript) when a tab dragged
            // from ANOTHER window drops on our strip: x (px from our left edge) →
            // where to insert it. Returns the data-index of the tab to insert
            // after, -1 for "at the front", or null to append at the end.
            window.__tabDropIndex = (x) => {
                const btns = [...tabsContainer.querySelectorAll('.tab-button')];
                if (!btns.length)
                    return null;
                let after = null; // null → before the first tab
                for (const b of btns) {
                    const r = b.getBoundingClientRect();
                    if (x >= r.left + r.width / 2)
                        after = b;
                    else
                        break;
                }
                // Incoming tabs are unpinned — clamp them past the pinned block.
                const lastPinned = btns.filter(b => b.classList.contains('pinned')).pop();
                if (lastPinned && (!after || after.classList.contains('pinned')))
                    after = lastPinned;
                if (!after)
                    return -1;
                return parseInt(after.dataset.index);
            };
            // ── Drop links / images / files / text onto the tab bar → new tab(s) ──
            // : a dropped URL or image opens in a new tab, OS files
            // open as file://, and anything else (selected text/phrases) runs as a
            // search in a new tab.
            async function openDrop(dt) {
                // 1) OS files (Explorer / Finder) → open each as a file:// URL.
                const files = dt.files;
                if (files && files.length) {
                    let opened = 0;
                    for (const f of files) {
                        const p = window.urlUtils?.getPathForFile?.(f) || '';
                        if (!p)
                            continue;
                        const norm = p.replace(/\\/g, '/').replace(/^\/+/, '');
                        await window.tab.addLazy('file:///' + encodeURI(norm));
                        opened++;
                    }
                    if (opened)
                        return;
                }
                // 2) A dragged URL — link, image, address-bar text, or file:// URI.
                const uriList = dt.getData('text/uri-list');
                if (uriList) {
                    const first = uriList.split(/\r?\n/).map(s => s.trim()).find(s => s && !s.startsWith('#'));
                    if (first) {
                        await window.tab.addLazy(formatToUrl(first));
                        return;
                    }
                }
                // 3) Plain text — a URL opens, any other text searches.
                const text = (dt.getData('text/plain') || '').trim();
                if (text && isNaN(text))
                    await window.tab.addLazy(formatToUrl(text));
            }
            tabBar.addEventListener('dragover', (e) => {
                // Accept external content drops. (Tab reordering is pointer-tracked,
                // not HTML5 drag-and-drop, so it never reaches here.)
                const types = e.dataTransfer.types;
                if (types.includes('Files') || types.includes('text/uri-list') ||
                    types.includes('text/plain') || types.includes('text/html')) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'copy';
                }
            });
            tabBar.addEventListener('drop', async (e) => {
                const dt = e.dataTransfer;
                const plain = (dt.getData('text/plain') || '').trim();
                // Only handle genuine external content; a numeric-only payload is a
                // stray id (e.g. a bookmark drag) — let it fall through untouched.
                const hasContent = (dt.files && dt.files.length) ||
                    dt.types.includes('text/uri-list') || (plain && isNaN(plain));
                if (!hasContent)
                    return;
                e.preventDefault();
                e.stopPropagation();
                await openDrop(dt);
            });
            // ── Scroll controls ───────────────────────────────────────────────────
            const tabScrollLeft = document.getElementById('tab-scroll-left');
            const tabScrollRight = document.getElementById('tab-scroll-right');
            let scrollInterval = null;
            const scrollBy = (amt) => tabsContainer.scrollBy({ left: amt, behavior: 'smooth' });
            const startScroll = (amt) => { scrollBy(amt); scrollInterval = setInterval(() => scrollBy(amt), 200); };
            const stopScroll = () => { clearInterval(scrollInterval); scrollInterval = null; };
            tabScrollLeft.addEventListener('mousedown', () => startScroll(-160));
            tabScrollRight.addEventListener('mousedown', () => startScroll(160));
            tabScrollLeft.addEventListener('click', () => scrollBy(-160));
            tabScrollRight.addEventListener('click', () => scrollBy(160));
            document.addEventListener('mouseup', stopScroll);
            tabsContainer.addEventListener('wheel', (e) => {
                e.preventDefault();
                tabsContainer.scrollBy({ left: e.deltaY !== 0 ? e.deltaY : e.deltaX, behavior: 'smooth' });
            }, { passive: false });
            tabsContainer.addEventListener('scroll', updateScrollShadows);
            // Right-click the empty part of the tab list → a custom menu.
            const emptyAreaMenu = (e) => {
                // Anything with its own menu handles itself.
                if (e.target.closest('.tab-button') || e.target.closest('.folder-header')
                    || e.target.closest('.sidebar-foot') || e.target.closest('#space-header')
                    || e.target.closest('.essential-tile'))
                    return;
                e.preventDefault(); e.stopPropagation();
                // Grouped as in the reference design doc. Only actions with a real
                // implementation are listed — no placeholder rows.
                const rows = [];
                // Compact collapses the sidebar rail to icons; top mode has no
                // rail, so the toggle did nothing there. Offer it only in side
                // mode. (Compact is a single on/off state, so it is one row, not
                // a submenu that only ever held one child.)
                if (document.documentElement.dataset.tabbar !== 'top')
                    rows.push(['Toggle compact mode', () => window.tabsUI.toggleCompact()]);
                // Switch the tab strip between the left sidebar and the top bar.
                const sideNow = document.documentElement.dataset.tabbar !== 'top';
                rows.push([sideNow ? 'Tabs on top' : 'Tabs on side',
                    () => window.northstarSettings.set('tabBarSide', sideNow ? 'top' : 'side')]);
                rows.push(
                    [T('chrome.newTab', 'New tab'), () => window.tab.newPage(), '', { accelerator: 'CmdOrCtrl+T' }],
                    ['New folder', newFolderInline],
                    ['sep'],
                    ['Select all tabs', () => selectAllTabs()],
                    ['Reload selected tab', () => window.tab.reload(activeTabIndex), '', { accelerator: 'CmdOrCtrl+R' }],
                    ['Bookmark selected tab…', () => {
                        const btn = tabs.get(activeTabIndex);
                        const title = btn?.querySelector('.tab-title')?.textContent || '';
                        if (currentTabUrl) window.browserBookmarks.add(currentTabUrl, title);
                    }, '', { accelerator: 'CmdOrCtrl+D' }],
                    ['Reopen closed tab', () => window.tabsUI.reopenClosed(), '', { accelerator: 'CmdOrCtrl+Shift+T' }],
                    ['sep'],
                    /* The sidebar you right-clicked belongs to a space, so this
                       edits THAT space's theme — same as the space menu. Passing
                       nothing meant this one entry quietly edited the global
                       setting instead, which is indistinguishable from per-space
                       theming being broken. */
                    ['Edit theme…', () => openThemePanel(activeWorkspace)],
                );
                openCtxMenu(e.clientX, e.clientY, rows);
            };
            tabsContainer.addEventListener('contextmenu', emptyAreaMenu);
            // The spacer fills the rest of the column in side mode, so a
            // right-click below the last tab lands there, not on the list.
            document.getElementById('tab-drag-spacer')?.addEventListener('contextmenu', emptyAreaMenu);
            // …and the rail itself, so the whole background answers. Only the
            // list and the spacer did, which left the column's own padding, the
            // gap under the space pill and the strip beside the rows silently
            // dead — and "New folder" lives in this menu, so it read as if the
            // browser had no way to make one.
            tabBar?.addEventListener('contextmenu', emptyAreaMenu);
            window.addEventListener('resize', () => setTimeout(() => { updateTabWidths(tabs.size); updateScrollShadows(); }, 100));
            setTimeout(() => { if (tabs.size > 0) {
                updateTabWidths(tabs.size);
                updateScrollShadows();
            } }, 100);
        }
        // First time an isolated tab ever appears, explain the dot once, then
        // remember (persisted) so it never shows again.
        let isoHintShownThisSession = false;
        function maybeShowIsolationHint() {
            if (isoHintShownThisSession)
                return;
            let seen = true;
            try { seen = !!(window.northstarSettings.getSync() || {}).isolationHintSeen; }
            catch (e) { window.northstarLog?.debug('renderer', 'maybeShowIsolationHint: ' + e); }
            if (seen)
                return;
            isoHintShownThisSession = true;
            try { window.northstarSettings.set('isolationHintSeen', true); }
            catch (e) { window.northstarLog?.debug('renderer', 'maybeShowIsolationHint: ' + e); }
            const el = document.getElementById('iso-hint');
            if (!el)
                return;
            el.classList.remove('hidden');
            let timer = null;
            const dismiss = () => { el.classList.add('hidden'); clearTimeout(timer); };
            el.querySelector('.iso-hint-close')?.addEventListener('click', dismiss, { once: true });
            timer = setTimeout(dismiss, 7000);
        }
        function sideTabs() { return document.documentElement.dataset.tabbar !== 'top'; }
        function initTabBarSide() {
            let mode = 'side', width = 256;
            try {
                const s = window.northstarSettings.getSync();
                mode = (s.tabBarSide ?? 'side');
                width = snapSidebar(Number(s.sidebarWidth) || 256);
            }
            catch (e) { window.northstarLog?.debug('renderer', 'initTabBarSide: ' + e); }
            document.documentElement.dataset.tabbar = mode === 'top' ? 'top' : 'side';
            placeWindowControls();
            applySidebarWidth(width);
            initSidebarResizer();
            try { window.tabsUI.onCloseMenus(() => { _closeCtxMenu?.(); }); }
            catch (e) { window.northstarLog?.debug('renderer', 'initTabBarSide: ' + e); }
            // While an overlay menu is open, drop the window-drag regions so a click
            // on the tab strip / sidebar reaches the overlay and dismisses it (on
            // Windows a drag region otherwise eats the click as a caption press).
            try { window.tabsUI.onMenuCapture((on) => document.documentElement.classList.toggle('menu-capturing', on)); }
            catch (e) { window.northstarLog?.debug('renderer', 'initTabBarSide: ' + e); }
            try { window.tabsUI.onSidebarWidth((w) => applySidebarWidth(w)); }
            catch (e) { window.northstarLog?.debug('renderer', 'initTabBarSide: ' + e); }
            try {
                window.tabsUI.onTabBarSide((v) => {
                    document.documentElement.dataset.tabbar = v === 'top' ? 'top' : 'side';
                    placeWindowControls();
                    updateTabWidths(tabs.size);
                    updateScrollShadows();
                });
            }
            catch (e) { window.northstarLog?.debug('renderer', 'initTabBarSide: ' + e); }
            // Compact mode: collapse the sidebar (page full-bleed).
            try {
                window.tabsUI.onCompact((on) => {
                    document.documentElement.dataset.compact = on ? 'on' : '';
                    updateTabWidths(tabs.size);
                });
            }
            catch (e) { window.northstarLog?.debug('renderer', 'initTabBarSide: ' + e); }
        }
        // Drag the right edge of the sidebar to resize it (side mode). Live-resizes
        // the page view; persists (globally) on release.
        // ONE clamp, shared with main (renderer/lib/util.js). This used to snap
        // to a 56px rail below 132 while main refused to go under its minimum,
        // so dragging narrow kept shrinking the sidebar on screen after the
        // page had already stopped moving.
        function snapSidebar(px) {
            return Northstar.util.clampSidebarWidth(px, window.innerWidth);
        }
        function applySidebarWidth(w) {
            document.documentElement.style.setProperty('--sidebar-w', w + 'px');
            document.documentElement.dataset.rail = w <= 56 ? 'on' : '';
        }
        function initSidebarResizer() {
            const handle = document.getElementById('sidebar-resizer');
            if (!handle)
                return;
            let dragging = false, raf = null, pending = 256, pid = null;
            const clamp = snapSidebar;
            handle.addEventListener('pointerdown', (e) => {
                if (sideTabs() === false)
                    return;
                dragging = true;
                pid = e.pointerId;
                handle.setPointerCapture(e.pointerId);
                document.documentElement.classList.add('sidebar-resizing');
                try { window.tabsUI.startSidebarResize(); } catch (e) { window.northstarLog?.debug('renderer', 'initSidebarResizer: ' + e); }
                e.preventDefault();
            });
            handle.addEventListener('pointermove', (e) => {
                if (!dragging)
                    return;
                pending = clamp(e.clientX);
                applySidebarWidth(pending);
                if (!raf)
                    raf = requestAnimationFrame(() => { raf = null; window.tabsUI.resizeSidebar(pending); });
            });
            // Drop the drag. `commit` false when the main process already ended it
            // (release landed on the page view; its mouseUp finished + persisted).
            const stop = (commit) => {
                if (!dragging)
                    return;
                dragging = false;
                try { if (pid != null) handle.releasePointerCapture(pid); } catch (e) { window.northstarLog?.debug('renderer', 'stop: ' + e); }
                document.documentElement.classList.remove('sidebar-resizing');
                if (commit)
                    window.tabsUI.commitSidebarWidth(pending);
            };
            handle.addEventListener('pointerup', () => stop(true));
            // NOTE: no `pointercancel` or `blur` end here. When a tab is active the
            // page is a native view layered over the chrome; the moment the drag
            // crosses onto it the view SEIZES the captured pointer, which fires
            // `pointercancel` on the handle (and `blur` on the window as focus
            // follows). Ending on those killed the drag on frame one — before a
            // single poll tick — which is exactly why resize "did nothing" WITH an
            // active tab but worked without one (no page view to seize it). That
            // seam-crossing is precisely what the main-process poll takes over, so
            // the drag must SURVIVE it, not end. Main is authoritative for the end
            // (page/chrome mouseUp via input-event, or the 480ms cursor-idle
            // backstop) and always calls back on `sidebar-resize-ended` below.
            // A genuine release over the chrome, and Escape, still end it here.
            window.addEventListener('pointerup', () => stop(true));
            document.addEventListener('keydown', (e) => { if (e.key === 'Escape') stop(true); });
            // Main fires this when the release happened over the page view.
            try { window.tabsUI.onSidebarResizeEnded((w) => { pending = clamp(w); stop(false); }); } catch (e) { window.northstarLog?.debug('renderer', 'stop: ' + e); }
            // THE missing half of the resize. The page is a native view layered
            // OVER this chrome, so the instant the cursor crosses onto it the
            // handle's pointermove stops firing and the MAIN process takes over,
            // driving the drag from the real OS cursor (ipc/tabs.js poll) and
            // broadcasting the width back on 'sidebar-width-changed'. Nothing here
            // was listening, so the page view moved while the sidebar DOM stayed
            // frozen at its start width — you dragged the divider and the sidebar
            // didn't follow, which is exactly "resize doesn't work". Reflect
            // main's authoritative width onto the sidebar (this also keeps other
            // windows in step, since the width is a global setting).
            try {
                window.tabsUI.onSidebarWidth((w) => {
                    const cw = clamp(w);
                    pending = cw;
                    applySidebarWidth(cw);
                });
            } catch (e) { window.northstarLog?.debug('renderer', 'onSidebarWidth: ' + e); }
        }
        // ── Essentials (pinned favourites; sidebar top, per profile) ──────────────
        function initEssentials() {
            const grid = document.getElementById('essentials');
            if (!grid)
                return;
            const render = async () => {
                let items = [];
                try { items = (await window.essentials.list()) || []; }
                catch (e) { window.northstarLog?.debug('renderer', 'render: ' + e); }
                grid.innerHTML = '';
                for (const it of items) {
                    const tile = document.createElement('button');
                    tile.className = 'essential-tile';
                    tile.dataset.key = `${it.url}|${it.profile || ''}`;
                    tile.title = it.title || it.url;
                    let letter = '•';
                    try { letter = new URL(it.url).hostname.replace(/^www\./, '').charAt(0).toUpperCase(); }
                    catch (e) { window.northstarLog?.debug('renderer', 'render: ' + e); }
                    const fb = document.createElement('span');
                    fb.className = 'ess-fallback';
                    fb.textContent = letter;
                    if (it.icon) {
                        // A pinned icon overrides the site's favicon and never
                        // changes when the site's does.
                        fb.textContent = it.icon;
                        fb.classList.add('ess-icon');
                        tile.appendChild(fb);
                    }
                    else {
                        const img = document.createElement('img');
                        img.style.display = 'none';
                        img.addEventListener('load', () => { img.style.display = ''; fb.style.display = 'none'; });
                        paintCachedFavicon(img, it.url);
                        tile.appendChild(img);
                        tile.appendChild(fb);
                    }
                    const rm = document.createElement('button');
                    rm.className = 'ess-remove';
                    rm.textContent = '×';
                    rm.title = 'Remove from Essentials';
                    rm.addEventListener('click', (e) => { e.stopPropagation(); window.essentials.remove(it.url, it.profile || null); });
                    tile.appendChild(rm);
                    // Click: focus an already-open tab of this site, else open one
                    // (profile-bound essentials reopen in their profile).
                    // An Essential IS a tab. Clicking it lands you in its tab —
                    // wherever you had browsed to inside it — and opens that tab
                    // only if it does not have one yet. It used to hunt for any
                    // tab on the same ORIGIN and otherwise spawn a new tab, so
                    // an Essential you had browsed away from opened a second
                    // copy of itself.
                    tile.addEventListener('click', () => {
                        window.essentials.open(it.url, it.profile || null);
                    });
                    // Essentials get their own menu — "Remove from Essentials"
                    // rather than the tab strip's unpin.
                    tile.addEventListener('contextmenu', (ev) => {
                        ev.preventDefault(); ev.stopPropagation();
                        let homeHost = it.home || it.url;
                        try { homeHost = new URL(it.home || it.url).hostname.replace(/^www\./, ''); }
                        catch (e) { window.northstarLog?.debug('renderer', 'essential menu: ' + e); }
                        openCtxMenu(ev.clientX, ev.clientY, [
                            [`Go back to ${homeHost}`, () => window.essentials.goHome(it.url, it.profile || null)],
                            ['Use this page as its page', () => window.essentials.setHome(it.url, it.profile || null, null)],
                            ['Set its page…', () => {
                                const current = it.home || it.url;
                                promptForText('Page to go back to', current, (v) => {
                                    if (v && v !== current)
                                        window.essentials.setHome(it.url, it.profile || null, v);
                                });
                            }],
                            ['sep'],
                            ['Open in a new tab', () => window.browserBookmarks.openInNewTab(it.url, true)],
                            /* Renaming is cosmetic — the url stays the identity key, so
                               a tile can be called "Mail" without re-pointing it or
                               orphaning the tab it owns. */
                            ['Rename…', () => {
                                const current = it.title || it.url;
                                promptForText('Name for this essential', current, (v) => {
                                    if (v != null && v !== current)
                                        window.essentials.rename(it.url, it.profile || null, v);
                                });
                            }],
                            ['Change icon…', () => openEmojiPicker(ev.clientX, ev.clientY,
                                (emo) => window.essentials.setIcon(it.url, it.profile || null, emo), true)],
                            ['Bookmark…', () => window.browserBookmarks.add(it.url, it.title || '')],
                            ['sep'],
                            ['Remove from essentials', () => window.essentials.remove(it.url, it.profile || null)], // re-addable: neutral
                        ]);
                    });
                    grid.appendChild(tile);
                }
            };
            render();
            // Main says which Essentials currently own a tab, and which one you
            // are looking at — the tile is the tab, so it shows its own state.
            try {
                window.essentials.onTabs?.((live) => {
                    const byKey = new Map((live || []).map(x => [x.key, x]));
                    for (const tile of grid.querySelectorAll('.essential-tile')) {
                        const state = byKey.get(tile.dataset.key || '');
                        tile.classList.toggle('has-tab', !!state);
                        tile.classList.toggle('is-active', !!state?.active);
                    }
                    /* An Essential IS its tile — it does not also get a row in
                       the strip below. Two entries for one thing meant the strip
                       filled with the pages you had pinned precisely so they
                       would stop taking up room in it, and closing the row left
                       a tile claiming a tab that was gone. The view is a real
                       tab in every other respect; the tile is how you reach it. */
                    const owned = new Set((live || []).map(x => x.index));
                    for (const [index, btn] of tabs)
                        btn.classList.toggle('is-essential', owned.has(index));
                });
            }
            catch (e) { window.northstarLog?.debug('renderer', 'essential tabs: ' + e); }
            try { window.essentials.onChanged(render); }
            catch (e) { window.northstarLog?.debug('renderer', 'render: ' + e); }
        }
        // ── Profiles ──────────────────────────────────────────────────────────────
        // The toolbar badge shows this window's profile (coloured initial); click
        // opens the native switcher menu (built in ipc/tabs.js). Rename via modal.
        let activeWorkspace = '1';
        // Multi-select: Cmd/Ctrl-click toggles a tab, Shift-click takes the range
        // from the last click. Bulk actions in the tab menu act on this set when
        // it holds more than one tab.
        const selectedTabs = new Set();
        let lastClickedTab = null;
        function paintSelection() {
            for (const [idx, btn] of tabs)
                btn.classList.toggle('multi-selected', selectedTabs.has(idx));
        }
        function clearSelection() {
            if (!selectedTabs.size) return;
            selectedTabs.clear();
            paintSelection();
        }
        function selectAllTabs() {
            selectedTabs.clear();
            for (const b of document.querySelectorAll('#tabs-container .tab-button:not(.ws-hidden)'))
                selectedTabs.add(parseInt(b.dataset.index));
            paintSelection();
        }
        // The set is what a bulk action applies to; a lone tab falls back to idx.
        function selectionFor(idx) {
            return selectedTabs.size > 1 && selectedTabs.has(idx) ? [...selectedTabs] : [idx];
        }
        let _spacesCache = [];
        let _containersCache = []; // named containers, for the Set Profile menus
        try {
            const pullContainers = () => window.containers?.listNamed()
                .then((c) => { _containersCache = c || []; }).catch(() => { });
            pullContainers();
            setTimeout(pullContainers, 800);
        }
        catch (e) { window.northstarLog?.debug('renderer', 'pullContainers: ' + e); }
        /* The foot's space row shows AS MANY AS FIT, then how many it could
           not. It used to be a horizontal scroller with its scrollbar hidden,
           which meant that with nine spaces you saw four and reached the rest
           by dragging a 162px strip sideways with no scrollbar to grab — the
           worst way to do the thing the row exists for.

           The overflow chip opens the same list the space pill in the head
           opens, so every space is one click away instead of an unknown amount
           of scrolling. The ACTIVE space is always in the visible set, even if
           it would not have fitted, because the row's first job is showing
           where you are. */
        function fitSpaceRow(row, openList) {
            if (!row)
                return;
            const chip = row.querySelector('.sb-ws-more');
            const avatars = [...row.querySelectorAll('.sb-ws')];
            if (!avatars.length)
                return;
            // Measure with everything shown, or a previous run's hiding sticks.
            for (const a of avatars) a.style.display = '';
            if (chip) chip.style.display = 'none';
            const room = row.clientWidth;
            const step = avatars[0].getBoundingClientRect().width + 4; // + gap
            if (!room || !step)
                return;
            let fit = Math.floor((room + 4) / step);
            if (fit >= avatars.length) {
                row.classList.remove('has-more');
                return;
            }
            // One slot goes to the chip.
            fit = Math.max(1, fit - 1);
            const activeIdx = avatars.findIndex(a => a.classList.contains('active'));
            const shown = new Set();
            for (let i = 0; i < fit; i++) shown.add(i);
            if (activeIdx >= 0 && !shown.has(activeIdx)) {
                shown.delete(Math.max(...shown));   // drop the last to make room
                shown.add(activeIdx);
            }
            avatars.forEach((a, i) => { a.style.display = shown.has(i) ? '' : 'none'; });
            const hidden = avatars.length - shown.size;
            if (chip) {
                chip.style.display = '';
                chip.textContent = '+' + hidden;
                chip.title = hidden + (hidden === 1 ? ' more space' : ' more spaces');
                chip.onclick = (e) => { e.stopPropagation(); openList(chip); };
            }
            row.classList.add('has-more');
        }

        /* Re-fit when the row's width changes. Without this the row kept
           whatever count it computed on the last render, so dragging the
           sidebar narrower left three avatars in an 84px row — overflowing a
           container with overflow:hidden, which clips them away and reads as
           the foot losing its contents. The scroller this replaced had a
           ResizeObserver; dropping it was the regression. */
        function watchSpaceRow(row, openList) {
            if (!row || row.dataset.fitBound)
                return;
            row.dataset.fitBound = '1';
            try {
                new ResizeObserver(() => fitSpaceRow(row, openList)).observe(row);
            }
            catch (e) { window.northstarLog?.debug('renderer', 'watchSpaceRow: ' + e); }
        }

        function initProfiles() {
            const btn = document.getElementById('profile-btn');
            const badge = document.getElementById('profile-badge');
            const wsRow = document.getElementById('sb-workspaces');
            // The foot row holds every space, so it runs out of width. Long-press
            // expands it into a wrapping reorder grid (drag to set the order) and
            // scrolling over the row switches spaces — both as upstream does.
            function initSpaceRowGestures() {
                const row = document.getElementById('sb-workspaces');
                if (!row) return;
                let pressTimer = null;
                const armDrag = (on) => {
                    for (const b of row.querySelectorAll('.sb-ws'))
                        b.draggable = on;
                };
                row.addEventListener('pointerdown', () => {
                    clearTimeout(pressTimer);
                    pressTimer = setTimeout(() => {
                        row.classList.add('reordering');
                        armDrag(true);
                    }, 450);
                });
                for (const ev of ['pointerup', 'pointerleave', 'pointercancel'])
                    row.addEventListener(ev, () => clearTimeout(pressTimer));
                // Click-away leaves the reorder grid.
                document.addEventListener('pointerdown', (e) => {
                    if (row.classList.contains('reordering') && !row.contains(e.target)) {
                        row.classList.remove('reordering');
                        armDrag(false);
                    }
                }, true);
                let wheelLock = 0;
                row.addEventListener('wheel', (e) => {
                    e.preventDefault();
                    const now = Date.now();
                    if (now - wheelLock < 320) return;
                    wheelLock = now;
                    const ids = [..._spacesCache].map(p => p.id);
                    const at = ids.indexOf(String(activeWorkspace));
                    if (at < 0 || ids.length < 2) return;
                    const next = ids[(at + (e.deltaY > 0 ? 1 : -1) + ids.length) % ids.length];
                    window.profiles.switch(next);
                }, { passive: false });
                // Drag to reorder while the grid is open.
                let dragId = null;
                row.addEventListener('dragstart', (e) => {
                    const b = e.target.closest('.sb-ws');
                    if (!b || !row.classList.contains('reordering')) return;
                    dragId = b.dataset.space;
                    e.dataTransfer.effectAllowed = 'move';
                });
                row.addEventListener('dragover', (e) => {
                    if (!dragId) return;
                    e.preventDefault();
                    const over = e.target.closest('.sb-ws');
                    const dragged = row.querySelector(`.sb-ws[data-space="${CSS.escape(dragId)}"]`);
                    if (!over || !dragged || over === dragged) return;
                    const rect = over.getBoundingClientRect();
                    row.insertBefore(dragged, (e.clientX < rect.left + rect.width / 2) ? over : over.nextSibling);
                });
                row.addEventListener('drop', (e) => {
                    e.preventDefault();
                    if (!dragId) return;
                    dragId = null;
                    window.profiles.reorder([...row.querySelectorAll('.sb-ws')].map(b => b.dataset.space));
                });
            }
            // (openProfileModal / openCreateSpace are declared at module scope —
            // spaceContextMenu() needs them and lives outside this function.)
            // Create a Space: an in-sidebar form (reference) rather than a modal.
            // The space is created only on submit, so cancelling leaves nothing behind.
            function initCreateSpace() {
                const panel = document.getElementById('space-create');
                const bar = document.getElementById('tab-bar');
                if (!panel || !bar) return;
                const nameEl = document.getElementById('sc-name');
                const emojiEl = document.getElementById('sc-emoji');
                const pickerEl = document.getElementById('sc-emoji-picker');
                let chosen = '';
                const setEmoji = (e) => {
                    chosen = e || '';
                    emojiEl.textContent = chosen;
                    emojiEl.classList.toggle('has-emoji', !!chosen);
                };
                const close = () => {
                    panel.classList.add('hidden');
                    bar.classList.remove('creating-space');
                    pickerEl?.classList.add('hidden');
                };
                openCreateSpace = () => {
                    setEmoji('');
                    setContainer(null, 'Own');
                    nameEl.value = '';
                    panel.classList.remove('hidden');
                    bar.classList.add('creating-space');
                    try { window.tabsUI.focusChrome(); } catch (e) { window.northstarLog?.debug('renderer', 'close: ' + e); }
                    nameEl.focus();
                };
                emojiEl.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const r = emojiEl.getBoundingClientRect();
                    openEmojiPicker(r.left, r.bottom + 4, setEmoji);
                });
                /* Theming a space you are creating happens HERE, not on a trip
                   to Settings — the whole point of a space's theme is that you
                   pick it while you are deciding what the space is. The panel
                   is scoped to the space being edited; while CREATING one there
                   is no id yet, so it edits the global theme and the new space
                   inherits it. */
                document.getElementById('sc-theme')?.addEventListener('click', (e) => {
                    /* ONE rule: the theme panel always edits a space. There is no
                       id for the space being created yet, so this edits the one
                       you are in — the alternative was editing the global
                       setting from a per-space UI, which is the inconsistency
                       that made per-space theming look broken everywhere else. */
                    const r = e.currentTarget.getBoundingClientRect();
                    lastCtxPoint = { x: r.right, y: r.top };
                    openThemePanel(activeWorkspace);
                });
                // null = this space keeps its own jar; 'default' = shared session;
                // otherwise a named container id shared with other spaces.
                let container = null;
                const valEl = document.getElementById('sc-profile-val');
                const setContainer = (id, label) => { container = id; valEl.textContent = label; };
                document.getElementById('sc-profile')?.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    // currentTarget is cleared once dispatch ends — read the rect
                    // before the first await or it is null by the time we need it.
                    const r = e.currentTarget.getBoundingClientRect();
                    let named = [];
                    try { named = (await window.containers.listNamed()) || []; } catch (e) { window.northstarLog?.debug('renderer', 'setContainer: ' + e); }
                    const rows = [
                        ['Own (isolated)', () => setContainer(null, 'Own')],
                        ['Default (shared)', () => setContainer('default', 'Default')],
                    ];
                    if (named.length) rows.push(['sep']);
                    for (const c of named) rows.push([c.name, () => setContainer(c.id, c.name)]);
                    rows.push(['sep'], ['New container…', async () => {
                        const nm = (nameEl.value.trim() || 'Container');
                        const c = await window.containers.createNamed(nm);
                        if (c?.id) setContainer(c.id, c.name);
                    }]);
                    openCtxMenu(r.right - 8, r.bottom + 4, rows);
                });
                const create = async () => {
                    const name = nameEl.value.trim();
                    const p = await window.profiles.create();
                    if (p?.id && (name || chosen || container)) {
                        const patch = {};
                        if (name) patch.name = name;
                        if (chosen) patch.emoji = chosen;
                        if (container) patch.container = container;
                        try { await window.profiles.update(p.id, patch); } catch (e) { window.northstarLog?.debug('renderer', 'create: ' + e); }
                    }
                    close();
                    if (p?.id) window.profiles.switch(p.id);
                };
                document.getElementById('sc-create')?.addEventListener('click', create);
                document.getElementById('sc-cancel')?.addEventListener('click', close);
                nameEl.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') create();
                    if (e.key === 'Escape') close();
                });
            }
            const refresh = async () => {
                let cur = null, all = [];
                try { cur = await window.profiles.current(); }
                catch (e) { window.northstarLog?.debug('renderer', 'refresh: ' + e); }
                try { all = (await window.profiles.list()) || []; }
                catch (e) { window.northstarLog?.debug('renderer', 'refresh: ' + e); }
                _spacesCache = all; // menus need the space list without awaiting
                if (cur) {
                    // Restored tabs are tagged and filtered before this resolves, so
                    // they get measured against the default workspace and all end up
                    // hidden. Re-filter once the real one is known.
                    const wsChanged = activeWorkspace !== cur.id;
                    activeWorkspace = cur.id;
                    if (wsChanged) filterTabsByWorkspace();
                    if (badge) {
                        badge.classList.toggle('has-emoji', !!cur.emoji);
                        badge.classList.toggle('is-dot', !cur.emoji);
                        badge.textContent = cur.emoji || (cur.name || 'P').charAt(0);
                        badge.style.setProperty('--pf-color', cur.color || '');
                    }
                    if (btn)
                        btn.title = `Workspace: ${cur.name}`;
                    const sh = document.getElementById('space-header');
                    if (sh) {
                        const nameEl = document.getElementById('space-name');
                        if (nameEl)
                            nameEl.textContent = cur.name || 'Space';
                        const badgeEl = document.getElementById('space-badge');
                        if (badgeEl) {
                            badgeEl.classList.toggle('has-emoji', !!cur.emoji);
                            badgeEl.classList.toggle('is-dot', !cur.emoji);
                            badgeEl.textContent = cur.emoji || '';
                            badgeEl.style.setProperty('--pf-color', cur.color || '');
                        }
                        sh.title = cur.name || 'Space';
                    }
                }
                // Avatar row: one per workspace, active one labelled.
                if (wsRow) {
                    /* Keep the "+N" chip: innerHTML = '' would delete it and
                       fitSpaceRow would then have nothing to show the overflow
                       with. It is re-appended after the avatars below. */
                    const moreChip = wsRow.querySelector('.sb-ws-more');
                    wsRow.innerHTML = '';
                    for (const p of all) {
                        const b = document.createElement('button');
                        b.className = 'sb-ws' + (p.id === activeWorkspace ? ' active' : '');
                        b.dataset.space = p.id;
                        /* NOT draggable by default. It was unconditionally
                           draggable, so any click that moved a pixel started an
                           HTML5 drag — ghost image and all — on a control whose
                           job is to switch spaces. Dragging is armed only while
                           the long-press reorder grid is open (see
                           initSpaceRowGestures), which is the only time it means
                           anything. */
                        b.draggable = false;
                        b.title = p.name; // native hover label (survives foot overflow-scroll)
                        // Every space keeps its emoji; inactive ones are greyed
                        // out (CSS) rather than reduced to a dot.
                        const av = document.createElement('span');
                        av.className = 'profile-badge' + (p.emoji ? ' has-emoji' : ' is-dot');
                        av.style.setProperty('--pf-color', p.color || '');
                        if (p.emoji)
                            av.textContent = p.emoji;
                        b.appendChild(av);
                        b.addEventListener('click', () => { if (p.id !== activeWorkspace) window.profiles.switch(p.id); });
                        b.addEventListener('dblclick', (e) => { e.preventDefault(); openProfileModal(p.id); });
                        b.addEventListener('contextmenu', (e) => {
                            e.preventDefault();
                            spaceContextMenu(e.clientX, e.clientY, p.id);
                        });
                        wsRow.appendChild(b);
                    }
                    if (moreChip)
                        wsRow.appendChild(moreChip);
                    // Fit after layout — clientWidth is 0 until the row is laid out.
                    const openList = (chip) => openSpaceList(chip, false);
                    requestAnimationFrame(() => fitSpaceRow(wsRow, openList));
                    watchSpaceRow(wsRow, openList);
                }
            };
            initSpaceRowGestures();
            initCreateSpace();
            refresh();
            try { window.profiles.onChanged(refresh); }
            catch (e) { window.northstarLog?.debug('renderer', 'refresh: ' + e); }
            try { window.profiles.onForceSwitch((id) => window.profiles.switch(id)); }
            catch (e) { window.northstarLog?.debug('renderer', 'refresh: ' + e); }
            try {
                window.profiles.onSwitched((id) => {
                    activeWorkspace = String(id);
                    filterTabsByWorkspace();
                    refresh();
                    // Essentials + bookmark bar reload via their own change events,
                    // which main re-emits on switch (they're per-workspace now).
                });
            }
            catch (e) { window.northstarLog?.debug('renderer', 'refresh: ' + e); }
            if (btn) {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const r = btn.getBoundingClientRect();
                    window.profiles.menu(r.left, r.bottom + 4);
                });
            }
            // The space pill at the top of the rail: switch spaces, or make one.
            // The same list the foot avatars offer, but named — which is what
            // you want when you have more spaces than you can recognise by icon.
            /* Every space, as a list. The head pill opens it downwards; the
               foot's "+N" overflow chip opens the same list upwards, so the two
               places that switch spaces answer identically. */
            function openSpaceList(btn, below = true) {
                const r = btn.getBoundingClientRect();
                const rows = [];
                for (const p of (_spacesCache || [])) {
                    // The active space carries a trailing check ICON (the
                    // overlay draws it), not a "  ✓" glued onto the name.
                    // Emoji in the icon column, the space's number as its
                    // Ctrl+Alt+N switch shortcut (P2-6) for the first nine.
                    const n = (_spacesCache || []).indexOf(p) + 1;
                    rows.push([p.name,
                        () => { if (p.id !== activeWorkspace) window.profiles.switch(p.id); },
                        '', { checked: p.id === activeWorkspace, icon: p.emoji || '', accelerator: (n >= 1 && n <= 9 && p.id !== activeWorkspace) ? `CmdOrCtrl+Alt+${n}` : undefined }]);
                }
                if (rows.length)
                    rows.push(['sep']);
                rows.push(['Rename this space…', () => openProfileModal(activeWorkspace)]);
                rows.push(['New space…', () => openCreateSpace()]);
                openCtxMenu(r.left, below ? r.bottom + 4 : r.top - 8, rows);
            }
            document.getElementById('space-header')?.addEventListener('click', (e) => {
                const btn = e.currentTarget;
                btn.setAttribute('aria-expanded', 'true');
                openSpaceList(btn, true);
            });
            // Ctrl+Shift+M (P2-7): main routes the space-switcher shortcut here.
            try {
                window.profiles.onOpenSwitcher?.(() => {
                    const btn = document.getElementById('space-header');
                    if (btn) {
                        btn.setAttribute('aria-expanded', 'true');
                        openSpaceList(btn, true);
                    }
                });
            }
            catch (e) { window.northstarLog?.debug('renderer', 'onOpenSwitcher: ' + e); }
            // Right-click it and you get what you get on the space's avatar in
            // the foot — the pill is the space, so both surfaces of it answer
            // the same way.
            document.getElementById('space-header')?.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                spaceContextMenu(e.clientX, e.clientY, activeWorkspace);
            });
            // The foot "+" opens a menu rather than creating a space outright —
            // it's the create-anything affordance in the reference.
            document.getElementById('sb-add-ws')?.addEventListener('click', (e) => {
                const r = e.currentTarget.getBoundingClientRect();
                openCtxMenu(r.left, r.top - 8, [
                    ['New space…', () => openCreateSpace()],
                    ['New folder', () => newFolderInline()],
                    ['sep'],
                    [T('chrome.newTab', 'New tab'), () => window.tab.newPage(), '', { accelerator: 'CmdOrCtrl+T' }],
                ]);
            });
            document.getElementById('sb-settings')?.addEventListener('click', () => {
                window.electronAPI.openSettingsTab();
            });
            // The sidebar-foot downloads button (#sb-downloads) is wired by
            // initDownloads alongside the toolbar one — see there. Keeping both in
            // one owner is what lets the auto-open / 5 s auto-close / progress ring
            // behave identically whichever button the layout is showing (P1-4).
            // Edit-profile modal (name + emoji)
            const modal = document.getElementById('profile-rename-modal');
            const input = document.getElementById('prf-input');
            const emojiBtn = document.getElementById('prf-emoji');
            const picker = document.getElementById('prf-emoji-picker');
            if (!modal || !input)
                return;
            // Render the chosen emoji (or a dot when opted out) onto the field.
            const setEmojiField = (val) => {
                emojiBtn.dataset.emoji = val || '';
                emojiBtn.textContent = val || '';
                emojiBtn.classList.toggle('is-dot', !val);
            };
            // Build the picker grid once: a "dot" (no emoji) option, then a palette.
            if (picker && !picker.dataset.built) {
                picker.dataset.built = '1';
                const PALETTE = ['🏠', '💼', '🎨', '🚀', '🎮', '🎧', '📚', '💡', '🔧', '🧪', '🛒', '💰', '✈️', '🌍', '🌙', '🔥', '🌈', '🍀', '🌸', '🌊', '⭐', '⚡', '🐱', '🐶', '🦊', '🐢', '🐝', '🦉', '🙂', '😎', '🤓', '👤', '❤️', '💙', '💚', '💜', '🧡', '🎬', '🎵', '⚽', '🏀', '🍕', '☕', '🛰️', '🔬', '📷', '🗂️', '🎯'];
                const none = document.createElement('button');
                none.type = 'button'; none.className = 'emoji-opt emoji-none';
                none.title = 'No emoji (dot)'; none.tabIndex = -1;
                none.addEventListener('click', () => { setEmojiField(''); picker.classList.add('hidden'); });
                picker.appendChild(none);
                for (const e of PALETTE) {
                    const b = document.createElement('button');
                    b.type = 'button'; b.className = 'emoji-opt'; b.textContent = e; b.tabIndex = -1;
                    b.addEventListener('click', () => { setEmojiField(e); picker.classList.add('hidden'); });
                    picker.appendChild(b);
                }
                // One tab stop for the whole grid; arrows move within it, so a
                // keyboard can pick an icon instead of the grid being a
                // mouse-only feature.
                window.Northstar?.keys?.rows(picker, {
                    selector: '.emoji-opt',
                    typeahead: false,
                    onEscape: () => picker.classList.add('hidden'),
                });
            }
            emojiBtn?.addEventListener('click', (e) => { e.stopPropagation(); picker?.classList.toggle('hidden'); });
            const close = () => {
                modal.classList.add('hidden');
                picker?.classList.add('hidden');
                modal.dataset.editId = '';
                // Bring the page (native view) back up from behind the chrome.
                try { window.focusMode.overlayClose(); }
                catch (e) { window.northstarLog?.debug('renderer', 'close: ' + e); }
            };
            const save = async () => {
                const id = modal.dataset.editId;
                if (id)
                    await window.profiles.update(id, {
                        name: input.value.trim(),
                        emoji: emojiBtn?.dataset.emoji || '', // empty → coloured dot
                    });
                close();
            };
            // Reused by double-click on an avatar and the context-menu "Rename".
            openProfileModal = async (id) => {
                modal.dataset.editId = String(id);
                let p = null;
                try { p = ((await window.profiles.list()) || []).find(x => x.id === String(id)); }
                catch (e) { window.northstarLog?.debug('renderer', 'save: ' + e); }
                input.value = p?.name || '';
                setEmojiField(p?.emoji || '');
                picker?.classList.add('hidden');
                modal.classList.remove('hidden');
                // The page is a native view that paints OVER the chrome DOM, so
                // collapse it while the modal is up or the modal hides behind it.
                try { window.focusMode.overlayOpen(); }
                catch (e) { window.northstarLog?.debug('renderer', 'save: ' + e); }
                input.focus(); input.select();
            };
            try { window.profiles.onRename((id) => openProfileModal(id)); }
            catch (e) { window.northstarLog?.debug('renderer', 'save: ' + e); }
            document.getElementById('prf-save')?.addEventListener('click', save);
            document.getElementById('prf-cancel')?.addEventListener('click', close);
            input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') close(); });
            modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
            // Any click in the card that isn't the emoji field or the picker dismisses it.
            modal.querySelector('.ri-card')?.addEventListener('click', (e) => {
                if (e.target !== emojiBtn && !e.target.closest('#prf-emoji-picker'))
                    picker?.classList.add('hidden');
            });
        }
        // ── Tab DOM helpers ───────────────────────────────────────────────────────
        // Isolation is invisible except a small dot on tabs running in their own
        // isolated (per-tenant) session — see .tab-button[data-container] in CSS.
        function createTabButton(index, title, afterIndex = null, shouldActivate = true, isPrivate = false, isolated = false, workspace = '1', essential = false) {
            if (tabs.has(index))
                return;
            const btn = document.createElement('div');
            /* An Essential's row is hidden from the FIRST frame. The binding
               that marks it arrives a message later, so applying it there meant
               a "New tab" row appeared and vanished on every tile click. */
            btn.className = 'tab-button' + (essential ? ' is-essential' : '');
            btn.dataset.index = index;
            btn.dataset.ws = String(workspace);
            if (String(workspace) !== activeWorkspace)
                btn.classList.add('ws-hidden');
            btn.draggable = false; // pointer-tracked drag below, not HTML5 DnD
            // The strip is ONE tab stop, not one per tab: Tab reaches the tab
            // list, then the arrows move within it (the toolbar pattern every
            // browser and every OS uses — twenty open tabs should not mean
            // twenty presses to reach the address bar). The active tab carries
            // the stop; setActiveTab keeps that in sync.
            btn.tabIndex = -1;
            btn.setAttribute('role', 'tab');
            btn.setAttribute('aria-label', title || `Tab ${index + 1}`);
            btn.setAttribute('aria-selected', 'false');
            btn.addEventListener('keydown', (e) => {
                const NEXT = sideTabs() ? 'ArrowDown' : 'ArrowRight';
                const PREV = sideTabs() ? 'ArrowUp' : 'ArrowLeft';
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    window.tab.switch(parseInt(btn.dataset.index));
                }
                else if (e.key === 'Delete' || e.key === 'Backspace') {
                    e.preventDefault();
                    window.tab.remove(parseInt(btn.dataset.index));
                }
                else if (e.key === NEXT || e.key === PREV || e.key === 'Home' || e.key === 'End') {
                    e.preventDefault();
                    moveTabFocus(btn, e.key === NEXT ? 1 : e.key === PREV ? -1 : e.key);
                }
            });
            if (isPrivate)
                btn.dataset.private = 'true';
            if (isolated) {
                btn.dataset.container = 'true';
                btn.title = 'Separate login for this site';
            }
            const titleSpan = document.createElement('span');
            titleSpan.className = 'tab-title';
            titleSpan.textContent = title || `Tab ${index + 1}`;
            const closeBtn = document.createElement('button');
            closeBtn.className = 'tab-close';
            closeBtn.tabIndex = -1;
            // A drawn X (Phosphor), not the × character: the glyph sat off-centre
            // and changed weight with the font.
            closeBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M208.49,191.51a12,12,0,0,1-17,17L128,145,64.49,208.49a12,12,0,0,1-17-17L111,128,47.51,64.49a12,12,0,0,1,17-17L128,111l63.51-63.52a12,12,0,0,1,17,17L145,128Z"/></svg>';
            closeBtn.setAttribute('aria-label', 'Close tab');
            // mousedown (not click) so the freeze is set before the removal's
            // relayout runs; the pointer is still over the strip (P1-3).
            closeBtn.addEventListener('mousedown', (e) => { if (e.button === 0) freezeTopStripClose(); });
            closeBtn.onclick = (e) => { e.stopPropagation(); window.tab.remove(parseInt(index)); };
            if (isPrivate) {
                const shield = document.createElement('span');
                shield.className = 'tab-private-icon';
                shield.title = 'Private tab';
                shield.innerHTML = '<svg width="10" height="10" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M208,36H48A20,20,0,0,0,28,56v56c0,54.29,26.32,87.22,48.4,105.29,23.71,19.39,47.44,26,48.44,26.29a12.1,12.1,0,0,0,6.32,0c1-.28,24.73-6.9,48.44-26.29,22.08-18.07,48.4-51,48.4-105.29V56A20,20,0,0,0,208,36Zm-4,76c0,35.71-13.09,64.69-38.91,86.15A126.28,126.28,0,0,1,128,219.38a126.14,126.14,0,0,1-37.09-21.23C65.09,176.69,52,147.71,52,112V60H204ZM79.51,144.49a12,12,0,1,1,17-17L112,143l47.51-47.52a12,12,0,0,1,17,17l-56,56a12,12,0,0,1-17,0Z"/></svg>';
                btn.appendChild(shield);
            }
            btn.appendChild(titleSpan);
            btn.appendChild(closeBtn);
            btn.addEventListener('mousedown', (e) => {
                if (e.button !== 1)
                    return;
                e.preventDefault();
            });
            btn.addEventListener('auxclick', (e) => {
                if (e.button !== 1)
                    return;
                e.preventDefault();
                e.stopPropagation();
                freezeTopStripClose(); // middle-click is a mouse close too (P1-3)
                window.tab.remove(parseInt(index));
            });
            // Right-click a sidebar tab → a custom menu (pin, folder, close, …).
            btn.addEventListener('dblclick', (e) => {
                if (e.target.closest('.tab-close')) return;
                e.preventDefault();
                startTabRename(btn, parseInt(index));
            });
            btn.addEventListener('contextmenu', (e) => {
                if (e.target.closest('.tab-close')) return;
                e.preventDefault(); e.stopPropagation();
                const idx = parseInt(index);
                const isPinned = btn.classList.contains('pinned');
                const curFolder = folderState.assign.get(idx) || null;
                /* ui-polish U1-2: 19 top-level rows → 11, with submenus.
                     New tab
                     ── Reload · Duplicate · Pin · Mute
                     ── Add to essentials · Move to ▸ · Open in ▸ · Customise ▸
                     ── Close · Close others ▸
                   Bookmark tab… is Ctrl+D / the star; Select all tabs stays on the
                   tab-bar background menu and Ctrl/Shift-click. Hints show the
                   shortcut for the same action (they act on the active tab). */
                const sel = selectionFor(idx);
                const tabUrl = () => window.tab.getTabUrl(idx);
                // Move to ▸ — folders, position, a window of its own.
                const moveSub = [];
                if (!isPinned) {
                    for (const f of folderState.folders.filter(f => f.id !== curFolder))
                        moveSub.push([f.name || 'Folder', () => window.folders.assign(idx, f.id)]);
                    if (curFolder) moveSub.push(['Remove from folder', () => window.folders.assign(idx, null)]);
                    if (moveSub.length) moveSub.push(['sep']);
                    moveSub.push(
                        ['Move to top', () => {
                            const first = [...tabsContainer.querySelectorAll('.tab-button:not(.pinned):not(.in-folder)')][0];
                            if (first && first !== btn) tabsContainer.insertBefore(btn, first);
                            window.tab.reorder([...tabsContainer.querySelectorAll('.tab-button')].map(el => +el.dataset.index));
                            reportTabOrder();
                        }],
                        ['Move to bottom', () => {
                            tabsContainer.appendChild(btn);
                            window.tab.reorder([...tabsContainer.querySelectorAll('.tab-button')].map(el => +el.dataset.index));
                            reportTabOrder();
                        }],
                        ['sep'],
                    );
                }
                moveSub.push(['New window', async () => {
                    const url = await tabUrl();
                    window.dragdrop.detachToNewWindow(idx, e.screenX, e.screenY, url);
                }]);
                // Open in ▸ — a container, or split view.
                const openInC = async (containerId) => {
                    const url = await tabUrl();
                    if (/^https?:/i.test(url || '')) window.tab.openInContainer(containerId, url);
                };
                const openSub = (_containersCache || []).map(c => [c.name, () => openInC(c.id)]);
                /* Always offer to make one — an empty flyout looked broken.
                   Creating a container here opens the tab in it straight away. */
                openSub.push(['New container…', () => {
                    promptForText('Name the container', '', async (name) => {
                        const nm = (name || '').trim();
                        if (!nm) return;
                        const c = await window.containers.createNamed(nm);
                        if (c?.id) openInC(c.id);
                    });
                }]);
                if (splitPair && splitPair.includes(idx))
                    openSub.push(['sep'], ['Close split view', () => window.tabsUI.closeSplit()]);
                else if (idx !== activeTabIndex)
                    openSub.push(['sep'], ['Split with the active tab', () => window.tabsUI.split(idx)]);
                // Customise ▸ — label, icon, pinned home, unload.
                const customSub = [
                    ['Change label…', () => startTabRename(btn, idx)],
                    ['Change icon…', () => openEmojiPicker(e.clientX, e.clientY,
                        (emo) => window.tab.setIcon(idx, emo), true)],
                    ...(btn.dataset.customLabel ? [['Reset label', () => window.tab.setLabel(idx, '')]] : []),
                    ...(btn.dataset.customIcon ? [['Reset icon', () => window.tab.setIcon(idx, '')]] : []),
                    ...(isPinned ? [
                        ['sep'],
                        ['Edit pinned URL…', async () => {
                            const cur = await window.tab.getHome(idx);
                            startInlineEdit(btn, cur, (v) => window.tab.setHome(idx, v));
                        }],
                        ['Reset pinned tab', () => window.tab.resetPinned(idx)],
                    ] : []),
                    ['sep'],
                    ['Unload tab', () => window.tab.unload(idx)],
                ];
                // Pinned tabs are workspace-scoped; promoting one to an Essential
                // makes it global, so the pin is dropped with it. An essential's
                // row is normally display:none (it lives as a tile), but "Add" on
                // a tab that already is one would be a lie.
                const essentialRow = btn.classList.contains('is-essential')
                    ? ['Remove from essentials', async () => {
                        const url = await tabUrl();
                        if (/^https?:/i.test(url || '')) window.essentials.remove(url, null);
                    }]
                    : [isPinned ? 'Move to essentials' : 'Add to essentials', async () => {
                        const url = await tabUrl();
                        const title = btn.querySelector('.tab-title')?.textContent || '';
                        if (!/^https?:/i.test(url || '')) return;
                        const ok = await window.essentials.add(url, title, null);
                        if (ok && isPinned) window.tab.pin(idx);
                    }];
                const rows = [
                    [T('chrome.newTab', 'New tab'), () => window.tab.newPage(), '', { accelerator: 'CmdOrCtrl+T' }],
                    ['sep'],
                    ['Reload', () => window.tab.reload(idx), '', { accelerator: 'CmdOrCtrl+R' }],
                    ['Duplicate', async () => {
                        const url = await tabUrl();
                        const ni = await window.tab.add();
                        if (typeof ni !== 'number') return;
                        // tabUrls holds TOKENS for internal pages, which are not
                        // loadable URLs; northstarUrlFor maps them.
                        const target = northstarUrlFor(url);
                        if (target) window.tab.loadUrl(ni, target);
                    }, '', { accelerator: 'CmdOrCtrl+Shift+K' }],
                    [isPinned ? 'Unpin' : 'Pin', () => window.tab.pin(idx), '', { accelerator: 'CmdOrCtrl+Shift+L' }],
                    [btn.dataset.muted ? 'Unmute tab' : 'Mute tab', () => window.tab.toggleMute(idx)],
                    ['sep'],
                    essentialRow,
                    ['Move to', moveSub],
                    ['Open in', openSub],
                    ['Customise', customSub],
                    ['sep'],
                    // Neutral, not red: a closed tab comes back with Ctrl+Shift+T.
                    [sel.length > 1 ? `Close ${sel.length} tabs` : 'Close',
                        () => { for (const i of sel) window.tab.remove(i); clearSelection(); },
                        '', sel.length > 1 ? {} : { accelerator: 'CmdOrCtrl+W' }],
                    ['Close others', [
                        ['Close duplicate tabs', async () => {
                            const all = [...document.querySelectorAll('#tabs-container .tab-button:not(.ws-hidden)')];
                            const seen = new Set();
                            for (const b of all) {
                                const u = await window.tab.getTabUrl(+b.dataset.index);
                                if (!u || u === 'newtab') continue;
                                if (seen.has(u)) window.tab.remove(+b.dataset.index);
                                else seen.add(u);
                            }
                        }],
                        ['Close tabs below', () => {
                            const all = [...document.querySelectorAll('#tabs-container .tab-button:not(.ws-hidden):not(.pinned)')];
                            const at = all.findIndex(b => +b.dataset.index === idx);
                            if (at >= 0) for (const b of all.slice(at + 1)) window.tab.remove(+b.dataset.index);
                        }],
                        ['Close all but this', () => {
                            for (const b of [...document.querySelectorAll('#tabs-container .tab-button:not(.ws-hidden):not(.pinned)')])
                                if (+b.dataset.index !== idx) window.tab.remove(+b.dataset.index);
                        }],
                    ]],
                ];
                openCtxMenu(e.clientX, e.clientY, rows);
            });
            // standard tab drag: pointer-tracked, and NOTHING moves until the
            // button is released.
            //  - inside the strip → live reorder preview
            //  - outside the strip → the tab ghosts; on RELEASE it either moves
            //    into the window under the cursor (dropped on its tab strip, at
            //    the drop position) or detaches into a new window there
            //  - Escape aborts the whole gesture and restores the original order
            const TEAR_MARGIN = 34;
            btn.addEventListener('pointerdown', (e) => {
                if (e.button !== 0 || e.target.closest('.tab-close'))
                    return;
                // A tab is selected on mousedown, not on click-release — so a
                // drag always moves the tab you're looking at.
                // Pinned sidebar tiles peek in a Glance on a plain click instead of
                // switching — the switch is skipped here and the glance fires on
                // release (below), so a drag still reorders them.
                const idxNum = parseInt(index);
                if (e.metaKey || e.ctrlKey) {
                    // Toggle this tab in the selection without switching to it.
                    if (selectedTabs.has(idxNum)) selectedTabs.delete(idxNum);
                    else selectedTabs.add(idxNum);
                    lastClickedTab = idxNum;
                    paintSelection();
                    return;
                }
                if (e.shiftKey && lastClickedTab !== null) {
                    const order = [...document.querySelectorAll('#tabs-container .tab-button:not(.ws-hidden)')]
                        .map(b => parseInt(b.dataset.index));
                    const a = order.indexOf(lastClickedTab), b2 = order.indexOf(idxNum);
                    if (a >= 0 && b2 >= 0) {
                        selectedTabs.clear();
                        for (const i of order.slice(Math.min(a, b2), Math.max(a, b2) + 1)) selectedTabs.add(i);
                        paintSelection();
                        return;
                    }
                }
                clearSelection();
                lastClickedTab = idxNum;
                const pinnedGlance = sideTabs() && btn.classList.contains('pinned');
                if (idxNum !== activeTabIndex && !pinnedGlance)
                    window.tab.switch(idxNum);
                const startX = e.clientX, startY = e.clientY;
                let mode = 'idle'; // idle → drag
                let outside = false; // pointer currently beyond the strip
                let savedOrder = null; // DOM order at drag start, for cancel
                let dropFolder = undefined; // folder id under the cursor (null = ungrouped, undefined = untracked)
                let splitTarget = null; // tab dwelt on long enough to split with
                let frozen = false; // reorder preview paused while the pointer rests
                let lastMoveAt = Date.now(), lastPX = e.clientX, lastPY = e.clientY;
                let dwellTimer = null;
                let springId = null, springTimer = null; // dwell over a collapsed folder → it opens
                const clearSplitTarget = () => {
                    splitTarget = null;
                    tabsContainer.querySelectorAll('.tab-button.split-target')
                        .forEach(b => b.classList.remove('split-target'));
                };
                const restoreOrder = () => {
                    if (!savedOrder)
                        return;
                    // Skip buttons whose tab was closed mid-drag — re-appending a
                    // detached node would resurrect a dead tab in the strip.
                    for (const el of savedOrder)
                        if (el.isConnected)
                            tabsContainer.appendChild(el);
                };
                // Hover-to-split. The reorder preview keeps the dragged tab under
                // the cursor, so there is never another tab to hit-test while the
                // pointer is moving. Holding still is the gesture: the strip
                // settles back to its real order and whatever tab is under the
                // cursor arms as the split partner. Any movement resumes the
                // reorder.
                const onDwell = () => {
                    if (mode !== 'drag' || outside || Date.now() - lastMoveAt < SPLIT_DWELL_MS)
                        return;
                    if (!frozen) {
                        frozen = true;
                        restoreOrder();
                    }
                    const over = document.elementFromPoint(lastPX, lastPY)?.closest?.('.tab-button');
                    const idx = (over && over !== btn && !over.classList.contains('ws-hidden'))
                        ? parseInt(over.dataset.index) : null;
                    if (idx === splitTarget)
                        return;
                    clearSplitTarget();
                    if (idx !== null) {
                        splitTarget = idx;
                        over.classList.add('split-target');
                    }
                };
                const onMove = (ev) => {
                    if (mode === 'drag' && Math.hypot(ev.clientX - lastPX, ev.clientY - lastPY) > 3) {
                        lastMoveAt = Date.now();
                        if (frozen || splitTarget !== null) {
                            frozen = false;
                            clearSplitTarget();
                        }
                    }
                    lastPX = ev.clientX;
                    lastPY = ev.clientY;
                    if (mode === 'idle' && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 5) {
                        mode = 'drag';
                        savedOrder = [...tabsContainer.querySelectorAll('.tab-button')];
                        btn.classList.add('dragging');
                        document.documentElement.classList.add('tab-dragging'); // kills text selection
                        // Main raises windows under the cursor, and puts the
                        // split drop-zone sheet over the page card.
                        window.dragdrop.dragTrack?.(true, idxNum);
                        activeTabDrag = { cancel: () => finish(false, true) };
                        dwellTimer = setInterval(onDwell, 90);
                    }
                    if (mode !== 'drag')
                        return;
                    // Leaving the strip vertically OR the window horizontally both
                    // count as "outside" (a tear-off or a merge either way).
                    const barR = tabBar.getBoundingClientRect();
                    const out = ev.clientY < barR.top - TEAR_MARGIN || ev.clientY > barR.bottom + TEAR_MARGIN
                        || ev.clientX < -TEAR_MARGIN || ev.clientX > window.innerWidth + TEAR_MARGIN;
                    if (out !== outside) {
                        outside = out;
                        btn.classList.toggle('drag-outside', out);
                    }
                    if (out) {
                        stopEdgeScroll();
                        clearSplitTarget();
                        return;
                    }
                    edgeAutoScroll(ev.clientX, ev.clientY);
                    placeDraggedTab(btn, sideTabs() ? ev.clientY : ev.clientX);
                    // Which folder (if any) is the tab hovering over? (drop target).
                    // Both layouts: elementFromPoint finds the chip or a member tile
                    // under the cursor (the dragged tab is pointer-events:none).
                    if (!btn.classList.contains('pinned')) {
                        const el = document.elementFromPoint(ev.clientX, ev.clientY);
                        const fh = el?.closest?.('.folder-header');
                        const mem = el?.closest?.('.tab-button.in-folder');
                        dropFolder = fh ? fh.dataset.folder
                            : (mem && mem !== btn) ? (folderState.assign.get(+mem.dataset.index) || null)
                            : null;
                        tabsContainer.querySelectorAll('.folder-header.drop-target').forEach(h => h.classList.remove('drop-target'));
                        if (dropFolder) tabsContainer.querySelector(`.folder-header[data-folder="${CSS.escape(dropFolder)}"]`)?.classList.add('drop-target');
                        // Spring-load: hold over a COLLAPSED folder and it opens, so a
                        // tab can be dropped among its tabs (Finder-style spring-loading).
                        const overFolder = fh?.dataset.folder || null;
                        if (overFolder !== springId) {
                            springId = overFolder;
                            clearTimeout(springTimer); springTimer = null;
                            const f = overFolder && folderState.folders.find(x => x.id === overFolder);
                            if (f && f.collapsed)
                                springTimer = setTimeout(() => {
                                    if (springId === overFolder) window.folders.toggle(overFolder);
                                }, 550);
                        }
                    }
                };
                const cleanup = () => {
                    document.removeEventListener('pointermove', onMove);
                    document.removeEventListener('pointerup', onUp);
                    document.removeEventListener('pointercancel', onCancel);
                    document.removeEventListener('keydown', onKey, true);
                    document.documentElement.classList.remove('tab-dragging');
                    btn.classList.remove('dragging', 'drag-outside');
                    clearSplitTarget();
                    clearInterval(dwellTimer);
                    clearTimeout(springTimer);
                    stopEdgeScroll();
                    activeTabDrag = null;
                    window.dragdrop.dragTrack?.(false);
                };
                // `handled` — the drop already landed somewhere else (the split
                // drop sheet over the page), so this side only stands down.
                const finish = async (drop, handled) => {
                    const wasMode = mode, wasOutside = outside, wasSplit = splitTarget;
                    cleanup();
                    if (handled) {
                        if (wasMode === 'drag')
                            restoreOrder();
                        return;
                    }
                    if (wasMode === 'drag' && wasSplit !== null && drop) {
                        restoreOrder(); // a split is not a reorder
                        window.tabsUI.split(wasSplit, 'right');
                        return;
                    }
                    if (wasMode !== 'drag') {
                        if (pinnedGlance) {
                            const u = tabUrls.get(parseInt(index)) || await window.tab.getTabUrl(index);
                            if (u) { try { window.glance.open(u); } catch (e) { window.northstarLog?.debug('renderer', 'finish: ' + e); } }
                        }
                        return;
                    }
                    if (!drop) {
                        restoreOrder();
                        return;
                    } // aborted
                    if (!wasOutside) { // reorder commit
                        // The drag preview places the tab by hand; re-compose so
                        // it settles into the right section before we persist.
                        layoutFolders();
                        const ordered = [...tabsContainer.querySelectorAll('.tab-button')].map(el => parseInt(el.dataset.index));
                        if (ordered.length)
                            window.tab.reorder(ordered);
                        // Apply folder membership from where it was dropped.
                        tabsContainer.querySelectorAll('.folder-header.drop-target').forEach(h => h.classList.remove('drop-target'));
                        if (dropFolder !== undefined) {
                            const cur = folderState.assign.get(parseInt(index)) || null;
                            const next = dropFolder || null;
                            if (cur !== next) { try { window.folders.assign(parseInt(index), next); } catch (e) { window.northstarLog?.debug('renderer', 'finish: ' + e); } }
                        }
                        return;
                    }
                    // Released outside the strip → main decides: split into a page
                    // card (this window's or another's), move into the window
                    // under the cursor, or detach into a new one.
                    const url = await window.tab.getTabUrl(index);
                    const res = await window.dragdrop.drop(index, url);
                    if (res === 'none' || res === 'window-moved' || res === 'split')
                        restoreOrder();
                };
                const onUp = () => finish(true);
                const onCancel = () => finish(false);
                const onKey = (ev) => { if (ev.key === 'Escape') {
                    ev.stopPropagation();
                    finish(false);
                } };
                document.addEventListener('pointermove', onMove);
                document.addEventListener('pointerup', onUp);
                document.addEventListener('pointercancel', onCancel);
                document.addEventListener('keydown', onKey, true);
            });
            // afterIndex: tab index to insert after, -1 for the front, null → end
            const afterBtn = (afterIndex !== null && afterIndex !== -1) ? tabs.get(afterIndex) : null;
            if (afterIndex === -1) {
                tabsContainer.insertBefore(btn, tabsContainer.firstChild);
            }
            else if (afterBtn) {
                tabsContainer.insertBefore(btn, afterBtn.nextSibling);
            }
            else if (document.documentElement.dataset.tabbar === 'top') {
                // Top strip (Chrome-like): a new tab appends at the END of the row.
                tabsContainer.appendChild(btn);
            }
            else {
                // Sidebar: new tabs land at the TOP of the loose-tab section — after
                // the pinned block and any folders, before the existing tabs.
                const firstLoose = [...tabsContainer.querySelectorAll('.tab-button')]
                    .find(b => b !== btn && !b.classList.contains('pinned') && !b.classList.contains('in-folder'));
                if (firstLoose)
                    tabsContainer.insertBefore(btn, firstLoose);
                else
                    tabsContainer.appendChild(btn);
            }
            tabs.set(index, btn);
            layoutFolders(); // keep the new tab in the composed order
            applySplitMarks();
            if (folderState.folders.length) layoutFolders();
            if (shouldActivate) {
                setActiveTab(index);
            }
            animateTabEnter(btn); // P1-2 — grow the new row in
            updateScrollShadows();
        }
        // Grow a newly-inserted row in (P1-2). Transform only, so siblings don't
        // jump and the top strip's inline widths are untouched. Two rAFs so the
        // start state paints before the transition runs.
        function animateTabEnter(btn) {
            if (prefersReducedMotion() || Date.now() - chromeBootAt < 1200)
                return; // instant during boot / reduced motion
            btn.classList.add('tab-enter');
            requestAnimationFrame(() => requestAnimationFrame(() => {
                if (!btn.isConnected) { btn.classList.remove('tab-enter'); return; }
                btn.classList.add('tab-enter-active');
                btn.classList.remove('tab-enter');
                let done = false;
                const end = () => {
                    if (done) return;
                    done = true;
                    btn.classList.remove('tab-enter-active');
                    btn.removeEventListener('transitionend', end);
                };
                btn.addEventListener('transitionend', end);
                setTimeout(end, 400);
            }));
        }
        // Collapse a closing row out, then drop the node (P1-2). Size is measured
        // and animated inline (height in the sidebar, width in the top strip), so
        // the row below slides up / the next ✕ slides under the cursor.
        function animateTabLeave(btn, remove) {
            const side = sideTabs();
            const prop = side ? 'height' : 'width';
            const size = side ? btn.offsetHeight : btn.offsetWidth;
            btn.style[prop] = size + 'px';
            btn.style.transition =
                `${prop} var(--dur-2) var(--ease-accel), opacity var(--dur-2) var(--ease-accel), ` +
                `margin var(--dur-2) var(--ease-accel), padding var(--dur-2) var(--ease-accel)`;
            void btn.offsetWidth; // flush the start size before animating to 0
            requestAnimationFrame(() => {
                btn.style[prop] = '0px';
                btn.style.opacity = '0';
                btn.style.margin = '0';
                btn.style.padding = '0';
                btn.style.minWidth = btn.style.minHeight = '0';
            });
            let done = false;
            const end = () => {
                if (done) return;
                done = true;
                btn.removeEventListener('transitionend', end);
                remove();
            };
            btn.addEventListener('transitionend', end);
            setTimeout(end, 400); // fallback if transitionend never fires
        }
        function removeTabButton(index) {
            const btn = tabs.get(index);
            if (!btn)
                return;
            // Drop it from the map now so all logic treats the tab as gone; only
            // the DOM node lingers for the collapse animation.
            tabs.delete(index);
            if (closingFreeze && !sideTabs() && btn.isConnected) {
                const gap = parseFloat(getComputedStyle(tabsContainer).columnGap) || 0;
                frozenPad += btn.offsetWidth + gap;
                tabsContainer.style.paddingRight = frozenPad + 'px';
            }
            if (prefersReducedMotion()) {
                btn.remove();
                return;
            }
            btn.classList.add('leaving');
            animateTabLeave(btn, () => btn.remove());
        }
        // Toggle .in-split on the two tabs currently sharing the screen (split view).
        function applySplitMarks() {
            for (const [idx, btn] of tabs)
                btn.classList.toggle('in-split', !!(splitPair && splitPair.includes(idx)));
        }
        function setActiveTab(index) {
            tabs.forEach(tab => {
                tab.classList.remove('active');
                tab.tabIndex = -1;
                tab.setAttribute('aria-selected', 'false');
            });
            const active = tabs.get(index);
            if (active) {
                active.classList.add('active');
                // The active tab is the strip's tab stop (roving tabindex).
                active.tabIndex = 0;
                active.setAttribute('aria-selected', 'true');
            }
            activeTabIndex = index;
            applySplitMarks();
            // Top strip: the active tab's folder chip lights up (its members are
            // otherwise tucked in the flyout). CSS already shows/hides the active
            // member itself; this keeps the chip in sync without a full re-layout.
            if (!sideTabs()) {
                const activeFolder = folderState.assign?.get(index);
                tabsContainer.querySelectorAll('.folder-header').forEach(h => {
                    h.classList.toggle('has-active-member', !!activeFolder && h.dataset.folder === activeFolder);
                });
            }
        }
        /**
         * Move keyboard focus within the tab strip. `step` is +1/-1, or the
         * literal 'Home'/'End'. Focus moves without switching tabs — Enter
         * commits — which is how a tablist is expected to behave.
         */
        function moveTabFocus(from, step) {
            const visible = [...document.querySelectorAll('.tab-button')]
                .filter(el => el.offsetParent !== null);
            if (!visible.length)
                return;
            let next;
            if (step === 'Home')
                next = visible[0];
            else if (step === 'End')
                next = visible[visible.length - 1];
            else {
                const i = visible.indexOf(from);
                next = visible[(i + step + visible.length) % visible.length];
            }
            if (!next)
                return;
            for (const el of visible)
                el.tabIndex = -1;
            next.tabIndex = 0;
            next.focus();
        }
        // ── Folders (tab groups): render a header per folder and slot its member
        //    tabs indented beneath it; collapsed folders hide their members. ────────
        // Folder glyph (open / closed), matching the reference. A user-set emoji
        // via Change Icon still wins over it.
        // A folder with a body and a lid, lit from the top-left: the gradient
        // and the highlight along the lid are what make a 17px glyph read as a
        // volume rather than as an outline. `--folder-fill` / `--folder-sheen`
        // come from the stylesheet, so it follows the theme.
        const FOLDER_DEFS =
            '<defs><linearGradient id="fg" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0" stop-color="var(--folder-sheen)"/>' +
            '<stop offset="1" stop-color="var(--folder-fill)"/></linearGradient></defs>';
        const FOLDER_GLYPH = {
            closed: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round">' + FOLDER_DEFS +
                '<path d="M2.5 6.2A1.7 1.7 0 0 1 4.2 4.5h3.1l1.6 1.9h7A1.7 1.7 0 0 1 17.5 8v6.3a1.7 1.7 0 0 1-1.7 1.7H4.2a1.7 1.7 0 0 1-1.7-1.7z" fill="url(#fg)"/>' +
                '<path d="M3.6 8.4h12.8" stroke="var(--folder-sheen)" stroke-width="1.25" stroke-linecap="round" opacity="0.7"/></svg>',
            open: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round">' + FOLDER_DEFS +
                '<path d="M2.5 6.2A1.7 1.7 0 0 1 4.2 4.5h3.1l1.6 1.9h7A1.7 1.7 0 0 1 17.5 8v1.2H5.6z" fill="url(#fg)"/>' +
                '<path d="M2.5 6.6l1.3 7.9a1.7 1.7 0 0 0 1.7 1.5h10.3a1.7 1.7 0 0 0 1.7-1.5l1-5.2H5.6z" fill="url(#fg)"/>' +
                '<path d="M5.9 10.1h11.3" stroke="var(--folder-sheen)" stroke-width="1.25" stroke-linecap="round" opacity="0.55"/></svg>',
        };
        function setFolderIcon(el, f) {
            if (f.icon) { el.innerHTML = ''; el.textContent = f.icon; return; }
            el.textContent = '';
            el.innerHTML = f.collapsed ? FOLDER_GLYPH.closed : FOLDER_GLYPH.open;
        }
        function makeFolderHeader(f) {
            const h = document.createElement('div');
            h.className = 'folder-header';
            h.dataset.folder = f.id;
            // Keyboard-reachable, like the tab rows it groups.
            h.tabIndex = 0;
            h.setAttribute('role', 'button');
            h.setAttribute('aria-expanded', String(!f.collapsed));
            h.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    window.folders.toggle(f.id);
                }
                else if (e.key === 'F2') {
                    e.preventDefault();
                    startFolderRename(h, f.id);
                }
            });
            h.innerHTML = '<span class="folder-icon">📁</span><span class="folder-name"></span><span class="folder-count" aria-hidden="true"></span><button class="folder-del" title="Delete folder">×</button>';
            h.addEventListener('click', (e) => {
                if (h.classList.contains('renaming') || e.target.closest('.folder-del')) return;
                if (h.dataset.suppressClick) return; // a drag just ended here
                // Both modes: left-click collapses the folder in place. Its tabs
                // are grouped inline like pinned tabs and fold away into the chip.
                window.folders.toggle(f.id);
            });
            h.addEventListener('dblclick', (e) => { e.preventDefault(); startFolderRename(h, f.id); });
            h.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); showFolderMenu(e.clientX, e.clientY, f.id); });
            // Drag to reorder. Nothing moves until the pointer passes a small
            // threshold, so a plain click still toggles the folder.
            h.addEventListener('pointerdown', (e) => {
                if (e.button !== 0 || h.classList.contains('renaming') || e.target.closest('.folder-del')) return;
                const startY = e.clientY, startX = e.clientX;
                const original = folderState.folders.map(x => x.id);
                let dragging = false;
                // Drop a folder ONTO another and hold to nest it inside; drop between
                // folders to reorder. Reorder commits on RELEASE (no live shuffle), so a
                // folder never slides out from under the cursor mid-dwell. The nest
                // target is tracked by id so any re-render can't reset the dwell.
                let nestId = null, nestTimer = null, nestOverId = null;
                let lastX = e.clientX, lastY = e.clientY;
                const vertical = sideTabs();
                const clearNest = () => {
                    nestId = null; nestOverId = null;
                    clearTimeout(nestTimer); nestTimer = null;
                    tabsContainer.querySelectorAll('.folder-header.drop-target').forEach(x => x.classList.remove('drop-target'));
                };
                const onMove = (ev) => {
                    lastX = ev.clientX; lastY = ev.clientY;
                    if (!dragging) {
                        // Distance, not just Y, so a horizontal drag in the top strip
                        // arms the same as a vertical one in the sidebar.
                        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
                        dragging = true;
                        h.classList.add('folder-dragging');
                        document.documentElement.classList.add('tab-dragging');
                    }
                    const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.folder-header');
                    const overId = (over && over.dataset.folder !== f.id) ? over.dataset.folder : null;
                    if (overId) {
                        if (overId !== nestOverId) {
                            clearNest();
                            nestOverId = overId;
                            nestTimer = setTimeout(() => {
                                nestId = overId;
                                document.querySelector(`.folder-header[data-folder="${CSS.escape(overId)}"]`)?.classList.add('drop-target');
                            }, 400);
                        }
                    }
                    else clearNest();
                };
                const finish = (commit) => {
                    document.removeEventListener('pointermove', onMove);
                    document.removeEventListener('pointerup', onUp);
                    document.removeEventListener('keydown', onKey, true);
                    document.documentElement.classList.remove('tab-dragging');
                    h.classList.remove('folder-dragging');
                    const nestTarget = (commit && dragging && nestId && nestId !== f.id) ? nestId : null;
                    clearNest();
                    if (!dragging) return; // a plain click still toggles the folder
                    if (commit && nestTarget) {
                        try { window.folders.reparent(f.id, nestTarget); }
                        catch (e) { window.northstarLog?.debug('renderer', 'reparent: ' + e); }
                    }
                    else if (commit) {
                        // Reorder to where the cursor was released: order the visible
                        // siblings by position and drop the dragged folder in.
                        const sibs = [...tabsContainer.querySelectorAll('.folder-header')]
                            .filter(el => el.dataset.folder !== f.id);
                        let beforeId = null;
                        for (const el of sibs) {
                            const r = el.getBoundingClientRect();
                            const mid = vertical ? r.top + r.height / 2 : r.left + r.width / 2;
                            if ((vertical ? lastY : lastX) < mid) { beforeId = el.dataset.folder; break; }
                        }
                        const ids = folderState.folders.map(x => x.id).filter(id => id !== f.id);
                        ids.splice(beforeId ? ids.indexOf(beforeId) : ids.length, 0, f.id);
                        if (ids.join() !== original.join()) window.folders.reorder(ids);
                    }
                    // Suppress the click that follows a real drag.
                    h.dataset.suppressClick = '1';
                    setTimeout(() => { delete h.dataset.suppressClick; }, 0);
                };
                const onUp = () => finish(true);
                const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); finish(false); } };
                document.addEventListener('pointermove', onMove);
                document.addEventListener('pointerup', onUp);
                document.addEventListener('keydown', onKey, true);
            });
            h.querySelector('.folder-del').addEventListener('click', (e) => { e.stopPropagation(); window.folders.remove(f.id); });
            return h;
        }
        // Reusable dark context menu. rows: [label, fn, className?] | ['sep'].
        let _closeCtxMenu = null;
        let _ctxPending = null; // resolves the overlay's pick for the open menu
        try {
            window.ctxMenu?.onPicked((result) => {
                const fn = _ctxPending;
                _ctxPending = null;
                _closeCtxMenu = null;
                document.getElementById('space-header')?.setAttribute('aria-expanded', 'false');
                if (fn) fn(result);
            });
        }
        catch (e) { window.northstarLog?.debug('renderer', 'onKey: ' + e); }
        // rows: ['Label', fn, className?] | ['Label', [subRows], className?] | ['sep'].
        // The menu itself is rendered by the CtxMenu overlay view — chrome DOM
        // cannot paint above the page's native view. Handlers can't cross IPC, so
        // rows go out as labels and a picked PATH of indices comes back here.
        // tabUrls stores internal pages as tokens; map one to something loadable
        // (null when the fresh tab already shows it, i.e. 'newtab').
        function northstarUrlFor(url) {
            if (!url || url === 'newtab') return null;
            if (/^(settings|history|bookmarks)(\/[a-z]+)?$/i.test(url)) return 'northstar://' + url;
            return /^[a-z]+:/i.test(url) ? url : null;
        }
        function openCtxMenu(x, y, rows) {
            lastCtxPoint = { x, y };
            const serialize = (rs) => rs.map((r) => {
                if (r[0] === 'sep') return { sep: true };
                const sub = Array.isArray(r[1]) ? r[1] : null;
                // r[3] is optional row flags: { checked } draws a trailing check,
                // { accelerator } a shortcut hint, { icon } an emoji in the icon column.
                const f = r[3] || {};
                return {
                    label: r[0], cls: r[2] || '',
                    ...(f.checked ? { checked: true } : {}),
                    ...(typeof f.accelerator === 'string' ? { accelerator: f.accelerator } : {}),
                    ...(typeof f.icon === 'string' && f.icon ? { icon: f.icon } : {}),
                    ...(sub ? { sub: serialize(sub) } : {}),
                };
            });
            const resolve = (rs, path) => {
                let cur = rs;
                for (let i = 0; i < path.length; i++) {
                    const row = cur[path[i]];
                    if (!row) return null;
                    if (i === path.length - 1) return typeof row[1] === 'function' ? row[1] : null;
                    cur = Array.isArray(row[1]) ? row[1] : [];
                }
                return null;
            };
            _ctxPending = (result) => {
                if (!Array.isArray(result)) return;
                const fn = resolve(rows, result);
                if (fn) fn();
            };
            _closeCtxMenu = () => { _ctxPending = null; };
            try { window.ctxMenu.open({ kind: 'menu', x, y, rows: serialize(rows) }); }
            catch (e) { window.northstarLog?.debug('renderer', 'resolve: ' + e); }
        }
        // Shared emoji set with search keywords, rendered by the overlay. A
        // function declaration so every scope sees it regardless of init order.
        function emojiSet() {
            return [
                ['📁', 'folder file'], ['📂', 'folder open file'], ['🗂️', 'folder tabs files'], ['🗃️', 'box files archive'],
                ['💼', 'work briefcase business job'], ['🏠', 'home house'], ['🏢', 'office building work'], ['🏦', 'bank money'],
                ['🎨', 'art design paint creative'], ['🚀', 'rocket launch ship space'], ['🎮', 'game gaming play'], ['🎧', 'music audio headphones'],
                ['📚', 'books study read library'], ['📖', 'book read'], ['💡', 'idea light bulb'], ['🔧', 'tools fix wrench settings'],
                ['🔨', 'hammer build tools'], ['⚙️', 'settings gear config'], ['🧪', 'science lab test experiment'], ['🔬', 'science microscope research'],
                ['🛒', 'shopping cart buy store'], ['💰', 'money finance cash bank'], ['💳', 'card payment money'], ['📈', 'chart growth stats finance'],
                ['📊', 'chart stats data'], ['✈️', 'travel plane flight'], ['🌍', 'world earth globe travel'], ['🗺️', 'map travel'],
                ['🏝️', 'island beach holiday travel'], ['🌙', 'moon night dark sleep'], ['☀️', 'sun day light'], ['🔥', 'fire hot trending'],
                ['🌈', 'rainbow pride color'], ['🍀', 'luck clover green'], ['🌸', 'flower blossom spring'], ['🌊', 'wave water sea ocean'],
                ['🌲', 'tree nature forest'], ['⭐', 'star favorite'], ['✨', 'sparkles magic new'], ['⚡', 'lightning fast power energy'],
                ['❄️', 'snow cold winter'], ['🐱', 'cat pet animal'], ['🐶', 'dog pet animal'], ['🦊', 'fox animal'],
                ['🐢', 'turtle animal slow'], ['🐝', 'bee animal busy'], ['🦉', 'owl animal night bird'], ['🐧', 'penguin animal bird'],
                ['🙂', 'face smile happy'], ['😎', 'cool face sunglasses'], ['🤓', 'nerd face study geek'], ['🥳', 'party face celebrate'],
                ['👤', 'person user profile'], ['👥', 'people users team group'], ['🧑‍💻', 'developer coding work person'], ['🫀', 'heart organ health'],
                ['❤️', 'heart love red'], ['💙', 'heart blue'], ['💚', 'heart green'], ['💜', 'heart purple'],
                ['🧡', 'heart orange'], ['🖤', 'heart black'], ['🎬', 'movie film video'], ['📺', 'tv video watch'],
                ['🎵', 'music note song'], ['🎸', 'guitar music'], ['⚽', 'football soccer sport'], ['🏀', 'basketball sport'],
                ['🏃', 'run sport fitness'], ['🧘', 'yoga calm meditate health'], ['🍕', 'pizza food'], ['🍔', 'burger food'],
                ['🍎', 'apple fruit food health'], ['☕', 'coffee drink cafe'], ['🍺', 'beer drink'], ['🎂', 'cake birthday'],
                ['🛰️', 'satellite space tech'], ['📷', 'camera photo'], ['🖥️', 'computer desktop work'], ['📱', 'phone mobile'],
                ['⌨️', 'keyboard typing work'], ['🖨️', 'printer office'], ['💾', 'save disk storage'], ['🗄️', 'archive cabinet files'],
                ['📝', 'note write notes'], ['📌', 'pin pinned'], ['🔖', 'bookmark tag'], ['🏷️', 'label tag'],
                ['🔒', 'lock private secure'], ['🔑', 'key password secure'], ['🛡️', 'shield security safe'], ['🕵️', 'private detective spy'],
                ['🎯', 'target goal focus'], ['🧭', 'compass explore navigate'], ['⏰', 'clock time alarm'], ['📅', 'calendar date'],
                ['✅', 'check done complete task'], ['📮', 'mail post inbox'], ['✉️', 'mail email message'], ['💬', 'chat message talk'],
            ];
        }
        function openEmojiPicker(x, y, onPick, allowNone) {
            _ctxPending = (result) => {
                if (result && typeof result.emoji === 'string') onPick(result.emoji);
            };
            _closeCtxMenu = () => { _ctxPending = null; };
            try { window.ctxMenu.open({ kind: 'emoji', x, y, emojis: emojiSet(), allowNone: !!allowNone }); }
            catch (e) { window.northstarLog?.debug('renderer', 'openEmojiPicker: ' + e); }
        }
        /**
         * Everything you can do to a space. Used by BOTH the pill at the top of
         * the rail and the avatar in the foot — they are two views of the same
         * thing, so a right-click on either has to offer the same actions.
         */
        function spaceContextMenu(x, y, id) {
            const p = (_spacesCache || []).find(s => String(s.id) === String(id));
            if (!p)
                return;
            const rows = [];
            if (p.id !== activeWorkspace)
                rows.push(['Switch to this space', () => window.profiles.switch(p.id)], ['sep']);
            rows.push(
                ['Change name…', () => openProfileModal(p.id)],
                ['Change icon…', () => openProfileModal(p.id)],
                ['Edit theme…', () => openThemePanel(p.id)],
                ['Unload space', () => window.tab.unloadWorkspace(p.id)],
                ['Set profile', [
                    ['Own (isolated)', () => window.profiles.update(p.id, { container: null })],
                    ['Default (shared)', () => window.profiles.update(p.id, { container: 'default' })],
                    ['sep'],
                    ...(_containersCache || []).map(c => [c.name, () => window.profiles.update(p.id, { container: c.id })]),
                    ...(_containersCache.length ? [['sep'], ['Manage containers',
                        _containersCache.map(c => [c.name, [
                            [`Delete “${c.name}”`, async () => {
                                await window.containers.remove(c.id);
                                _containersCache = (await window.containers.listNamed()) || [];
                            }, 'danger'],
                        ]]),
                    ]] : []),
                ]],
                ['sep'],
                ['New folder', () => newFolderInline()],
                ['New space…', () => openCreateSpace()],
                ...(_spacesCache.length > 1 && String(p.id) !== '1' ? [['sep'], ['Delete space', [
                    // Wipes the space's logins and closes its tabs, so it asks
                    // rather than acting on one click.
                    [`Delete “${p.name}” and its data`, () => window.profiles.remove(p.id), 'danger'],
                ]]] : []),
            );
            openCtxMenu(x, y, rows);
        }
        function showFolderMenu(x, y, id) {
            // Spaces other than the current one; the folder and its tabs move together.
            const spaceRows = (_spacesCache || [])
                .filter(p => String(p.id) !== String(activeWorkspace))
                .map(p => [`${p.emoji ? p.emoji + '  ' : ''}${p.name}`, () => window.folders.move(id, p.id)]);
            openCtxMenu(x, y, [
                ['Rename folder…', () => { const h = tabsContainer.querySelector(`.folder-header[data-folder="${CSS.escape(id)}"]`); if (h) startFolderRename(h, id); }],
                ['Change icon…', () => { const h = tabsContainer.querySelector(`.folder-header[data-folder="${CSS.escape(id)}"]`); const r = h ? h.getBoundingClientRect() : { right: x, top: y }; openEmojiPicker(r.right + 4, r.top, (e) => window.folders.icon(id, e)); }],
                ['sep'],
                ['New subfolder…', async () => {
                    const sub = await window.folders.create('New Folder', id);
                    if (sub) setTimeout(() => {
                        const h = tabsContainer.querySelector(`.folder-header[data-folder="${CSS.escape(sub)}"]`);
                        if (h) startFolderRename(h, sub);
                    }, 160);
                }],
                ['Unload all tabs', () => {
                    for (const [i, fid] of folderState.assign.entries())
                        if (fid === id) window.tab.unload(i);
                }],
                ['sep'],
                ...(spaceRows.length ? [['Change space', spaceRows], ['sep']] : []),
                ['Unpack folder', () => window.folders.remove(id)],
                ['Delete folder', () => {
                    const members = [...folderState.assign.entries()].filter(([, fid]) => fid === id).map(([i]) => i);
                    for (const i of members) { try { window.tab.remove(i); } catch (e) { window.northstarLog?.debug('renderer', 'spaceRows: ' + e); } }
                    window.folders.remove(id);
                }, 'danger'],
            ]);
        }
        // Shared by the tab-list menu and the foot "+" — a function declaration so
        // both scopes see it regardless of init order.
        async function newFolderInline() {
            let id = null;
            try { id = await window.folders.create('New Folder'); } catch (e) { window.northstarLog?.debug('renderer', 'newFolderInline: ' + e); }
            if (id) setTimeout(() => { const h = tabsContainer.querySelector(`.folder-header[data-folder="${CSS.escape(id)}"]`); if (h) startFolderRename(h, id); }, 140);
        }
        // Inline rename for a tab row — double-click or the Change Label item.
        // Generic inline editor on a tab row: swaps the title for an input,
        // commits on Enter/blur, cancels on Escape.
        function startInlineEdit(btn, initial, commit) {
            const label = btn.querySelector('.tab-title');
            if (!label || btn.classList.contains('renaming'))
                return;
            btn.classList.add('renaming');
            const input = document.createElement('input');
            input.className = 'folder-rename-input';
            input.value = initial || '';
            input.maxLength = 300;
            label.replaceWith(input);
            try { window.tabsUI.focusChrome(); } catch (e) { window.northstarLog?.debug('renderer', 'startInlineEdit: ' + e); }
            input.focus(); input.select();
            const done = (save) => {
                if (!btn.classList.contains('renaming'))
                    return;
                btn.classList.remove('renaming');
                const val = input.value;
                input.replaceWith(label);
                if (save) commit(val);
            };
            input.addEventListener('keydown', (e) => {
                e.stopPropagation();
                if (e.key === 'Enter') done(true);
                if (e.key === 'Escape') done(false);
            });
            input.addEventListener('blur', () => done(true));
        }
        function startTabRename(btn, idx) {
            const label = btn.querySelector('.tab-title');
            if (!label || btn.classList.contains('renaming'))
                return;
            btn.classList.add('renaming');
            const input = document.createElement('input');
            input.className = 'folder-rename-input';
            input.value = label.textContent;
            input.maxLength = 60;
            label.replaceWith(input);
            try { window.tabsUI.focusChrome(); } catch (e) { window.northstarLog?.debug('renderer', 'startTabRename: ' + e); }
            input.focus(); input.select();
            const done = (save) => {
                if (!btn.classList.contains('renaming'))
                    return;
                btn.classList.remove('renaming');
                const val = input.value;
                input.replaceWith(label);
                if (save) window.tab.setLabel(idx, val);
            };
            input.addEventListener('keydown', (e) => {
                e.stopPropagation();
                if (e.key === 'Enter') done(true);
                if (e.key === 'Escape') done(false);
            });
            input.addEventListener('blur', () => done(true));
        }
        function startFolderRename(h, id) {
            const name = h.querySelector('.folder-name');
            if (!name || h.classList.contains('renaming')) return;
            h.classList.add('renaming');
            const cur = name.textContent;
            const input = document.createElement('input');
            input.className = 'folder-rename-input'; input.value = cur; input.maxLength = 40;
            name.replaceWith(input);
            // Pull keyboard focus to the chrome first, else the caret shows but
            // every keystroke goes to the page view that still owns focus.
            try { window.tabsUI.focusChrome(); } catch (e) { window.northstarLog?.debug('renderer', 'startFolderRename: ' + e); }
            input.focus(); input.select();
            const done = (save) => {
                if (!h.classList.contains('renaming')) return;
                h.classList.remove('renaming');
                const span = document.createElement('span'); span.className = 'folder-name';
                const val = input.value.trim();
                span.textContent = (save && val) ? val : cur;
                input.replaceWith(span);
                if (save && val && val !== cur) window.folders.rename(id, val);
            };
            input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
            input.addEventListener('blur', () => done(true));
        }
        function layoutFolders() {
            if (!tabsContainer) return;
            const folders = folderState.folders;
            const validIds = new Set(folders.map(f => f.id));
            tabsContainer.querySelectorAll('.folder-header').forEach(h => { if (!validIds.has(h.dataset.folder)) h.remove(); });
            tabsContainer.querySelectorAll('.tab-button.in-folder').forEach(b => b.classList.remove('in-folder', 'folder-collapsed'));
            const pinned = [...tabsContainer.querySelectorAll('.tab-button.pinned')];
            const normal = [...tabsContainer.querySelectorAll('.tab-button:not(.pinned)')];
            const grouped = new Set();
            // Panel order is composed here in full — pinned tiles, folders and
            // their members, the New Tab row, then loose tabs — and appending the
            // fragment MOVES the existing nodes, so the result is deterministic.
            const frag = document.createDocumentFragment();
            for (const btn of pinned) frag.appendChild(btn);
            // Folders nest: walk parents first so a child sits directly under
            // its parent, indented, and inherits any ancestor's collapse.
            const childrenOf = (pid) => folders.filter(f => (f.parent || null) === pid);
            const walk = (parentId, depth, hidden) => {
                for (const f of childrenOf(parentId)) {
                    let header = tabsContainer.querySelector(`.folder-header[data-folder="${CSS.escape(f.id)}"]`) || makeFolderHeader(f);
                    header.classList.toggle('collapsed', !!f.collapsed);
                    header.classList.toggle('folder-collapsed', hidden);
                    header.style.setProperty('--depth', String(depth));
                    setFolderIcon(header.querySelector('.folder-icon'), f);
                    if (!header.classList.contains('renaming')) header.querySelector('.folder-name').textContent = f.name || 'Folder';
                    frag.appendChild(header);
                    let count = 0;
                    let anyActive = false;
                    for (const btn of normal) {
                        if (folderState.assign.get(+btn.dataset.index) !== f.id) continue;
                        btn.classList.add('in-folder');
                        btn.style.setProperty('--depth', String(depth + 1));
                        if (hidden || f.collapsed) btn.classList.add('folder-collapsed');
                        if (btn.classList.contains('active')) anyActive = true;
                        frag.appendChild(btn);
                        grouped.add(btn);
                        count++;
                    }
                    // Top strip only: light the chip when you're inside one of its
                    // tabs (that active tab is the one member still shown in-strip).
                    header.classList.toggle('has-active-member', anyActive);
                    // How many tabs are in there — the one thing a collapsed
                    // folder cannot tell you by looking at it.
                    const countEl = header.querySelector('.folder-count');
                    if (countEl) {
                        countEl.textContent = count ? String(count) : '';
                        countEl.classList.toggle('hidden', !count);
                    }
                    walk(f.id, depth + 1, hidden || !!f.collapsed);
                }
            };
            walk(null, 0, false);
            const actions = document.getElementById('tab-actions');
            if (actions) {
                if (sideTabs()) {
                    // Sidebar: "+ New tab" is a row after the pinned/folder block
                    //. The divider above it appears whenever anything
                    // precedes it — folders or pinned tiles.
                    actions.classList.toggle('after-folders', folders.length > 0 || pinned.length > 0);
                    frag.appendChild(actions);
                } else {
                    // Top strip: the + is pinned after the scrolling tab list and
                    // stays visible (every browser keeps it there). It must NOT ride
                    // inside #tabs-container or it scrolls off the right past a full
                    // strip — it lives between the container and the drag spacer.
                    actions.classList.remove('after-folders');
                    const spacer = document.getElementById('tab-drag-spacer');
                    if (actions.parentElement !== tabBar || actions.nextElementSibling !== spacer)
                        tabBar.insertBefore(actions, spacer);
                }
            }
            for (const btn of normal) if (!grouped.has(btn)) frag.appendChild(btn);
            tabsContainer.appendChild(frag);
            reportTabOrder();
            // Membership/collapse just changed which tiles are compact (favicon
            // width) and how wide the rest are, so recompute widths, then re-check
            // the overflow indicators once that has applied.
            updateTabWidths(tabs.size);
            setTimeout(updateScrollShadows, 20);
        }
        // Tell main the order the tabs are DRAWN in, top to bottom — Ctrl+1–9
        // and Ctrl+Tab follow it (a new sidebar tab lands at the top of the loose
        // tabs, which main's own tabOrder doesn't know).
        function reportTabOrder() {
            try {
                const order = [...tabsContainer.querySelectorAll('.tab-button')].map(el => parseInt(el.dataset.index, 10));
                window.tab.reportVisualOrder?.(order);
            }
            catch (e) { window.northstarLog?.debug('renderer', 'reportTabOrder: ' + e); }
        }
        // ── Tab media indicator: audible/muted speaker, recording mic/camera ─────
        const INDICATOR_SVG = {
            audio: '<svg width="11" height="11" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M157.27,21.22a12,12,0,0,0-12.64,1.31L75.88,76H32A20,20,0,0,0,12,96v64a20,20,0,0,0,20,20H75.88l68.75,53.47A12,12,0,0,0,164,224V32A12,12,0,0,0,157.27,21.22ZM36,100H68v56H36Zm104,99.46L92,162.13V93.87l48-37.33ZM212,128a44,44,0,0,1-11,29.11,12,12,0,1,1-18-15.88,20,20,0,0,0,0-26.43,12,12,0,0,1,18-15.86A43.94,43.94,0,0,1,212,128Zm40,0a83.87,83.87,0,0,1-21.39,56,12,12,0,0,1-17.89-16,60,60,0,0,0,0-80,12,12,0,1,1,17.88-16A83.87,83.87,0,0,1,252,128Z"/></svg>',
            muted: '<svg width="11" height="11" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M157.27,21.22a12,12,0,0,0-12.64,1.31L75.88,76H32A20,20,0,0,0,12,96v64a20,20,0,0,0,20,20H75.88l68.75,53.47A12,12,0,0,0,164,224V32A12,12,0,0,0,157.27,21.22ZM36,100H68v56H36Zm104,99.47L92,162.12V93.88l48-37.34Zm108.49-55.95a12,12,0,0,1-17,17L216,145l-15.51,15.52a12,12,0,0,1-17-17L199,128l-15.52-15.51a12,12,0,0,1,17-17L216,111l15.51-15.51a12,12,0,0,1,17,17L233,128Z"/></svg>',
            mic: '<svg width="11" height="11" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M128,180a52.06,52.06,0,0,0,52-52V64A52,52,0,0,0,76,64v64A52.06,52.06,0,0,0,128,180ZM100,64a28,28,0,0,1,56,0v64a28,28,0,0,1-56,0Zm40,155.22V240a12,12,0,0,1-24,0V219.22A92.14,92.14,0,0,1,36,128a12,12,0,0,1,24,0,68,68,0,0,0,136,0,12,12,0,0,1,24,0A92.14,92.14,0,0,1,140,219.22Z"/></svg>',
            camera: '<svg width="11" height="11" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M249.45,69.31a12,12,0,0,0-12.51,1L212,88.43V72a20,20,0,0,0-20-20H32A20,20,0,0,0,12,72V184a20,20,0,0,0,20,20H192a20,20,0,0,0,20-20V167.57l24.94,18.14A12,12,0,0,0,256,176V80A12,12,0,0,0,249.45,69.31ZM188,180H36V76H188Zm44-27.57-20-14.54V118.11l20-14.54Z"/></svg>',
        };
        const INDICATOR_TITLE = {
            audio: 'Playing audio — click to mute',
            muted: 'Muted — click to unmute',
            mic: 'Using your microphone',
            camera: 'Using your camera',
        };
        function updateTabIndicator(index, d) {
            const btn = tabs.get(index);
            if (!btn)
                return;
            // So the tab menu can say "Unmute tab" on a muted tab. Tracked here
            // because this is the one event that carries the muted flag.
            btn.dataset.muted = d.muted ? '1' : '';
            let el = btn.querySelector('.tab-indicator');
            // Recording outranks audio: you must always see that a tab has your mic.
            // A muted tab keeps its (crossed) speaker while media plays, so there's
            // always something to click to unmute.
            // Keep the speaker while media is PLAYING, not only while it's audible
            // this instant — otherwise a quiet passage (between songs, a pause in
            // dialogue) drops the icon and it flickers back when sound returns.
            const kind = d.capture === 'camera' ? 'camera'
                : d.capture === 'mic' ? 'mic'
                    : d.muted && d.playing ? 'muted'
                        : (d.audible || d.playing) ? 'audio'
                            : null;
            btn.classList.toggle('has-indicator', !!kind);
            if (!kind) {
                el?.remove();
                return;
            }
            if (!el) {
                el = document.createElement('span');
                el.className = 'tab-indicator';
                // The speaker is a button: click toggles the tab's audio without
                // switching to it.
                el.addEventListener('click', (e) => {
                    if (el.dataset.kind !== 'audio' && el.dataset.kind !== 'muted')
                        return;
                    e.stopPropagation();
                    window.tab.toggleMute(index);
                });
                el.addEventListener('mousedown', (e) => e.stopPropagation());
                // TRAILING, just before ✕, so every title in the list starts at
                // the same x (ui-polish U0-4). Inserting it before the title
                // indented a playing tab's title past its neighbours'.
                btn.insertBefore(el, btn.querySelector('.tab-close'));
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
            if (!btn)
                return;
            const span = btn.querySelector('.tab-title');
            if (span) {
                span.textContent = title || `Tab ${index + 1}`;
                btn.title = span.textContent;
            }
            let faviconEl = btn.querySelector('.tab-favicon');
            if (faviconUrl) {
                if (!faviconEl || faviconEl.tagName !== 'IMG') {
                    const img = document.createElement('img');
                    img.className = 'tab-favicon';
                    if (faviconEl)
                        faviconEl.replaceWith(img);
                    else
                        btn.insertBefore(img, span);
                    faviconEl = img;
                }
                // Only (re)load when the source actually changes — avoids re-fetch
                // flicker on the many url-updated events a single page fires.
                if (faviconEl.dataset.srcKey !== faviconUrl) {
                    faviconEl.dataset.srcKey = faviconUrl;
                    delete faviconEl.dataset.faviconRetried;
                    faviconEl.alt = '';
                    // A remote favicon <img> can HANG (e.g. Google's rate-limited s2
                    // service) — it neither loads nor fires onerror, so the icon would
                    // stay hidden forever. Time out and route to the reliable main-
                    // process fetch, which also tries the site's own /favicon.ico.
                    const guard = setTimeout(() => {
                        if (faviconEl.tagName === 'IMG' && !faviconEl.dataset.faviconRetried && !faviconEl.complete) {
                            onFaviconError(index, faviconEl, faviconUrl);
                        }
                    }, 3000);
                    faviconEl.onload = () => { clearTimeout(guard); markFaviconResolved(index); };
                    faviconEl.onerror = () => { clearTimeout(guard); onFaviconError(index, faviconEl, faviconUrl); };
                    faviconEl.src = faviconUrl;
                }
            }
            else if (faviconEl) {
                faviconEl.remove();
                btn.classList.remove('has-favicon');
            }
        }
        // Reveal the favicon the instant it resolves. `has-favicon` lets the tab show
        // its icon even while the page is still fetching slow tail-end resources —
        // otherwise the CSS spinner keeps the icon hidden until did-stop-loading,
        // which on some sites waits 20 s+ after the page is already usable (that was
        // the "favicon sometimes doesn't show up" + "feels slow" bug).
        function markFaviconResolved(index) {
            tabs.get(index)?.classList.add('has-favicon');
        }
        // A remote favicon <img> failed to load. Before giving up to the letter
        // placeholder, ask the main process to fetch it over the app's network stack
        // and hand back a data: URL — this rescues tab icons on setups where the
        // chrome's file:// origin can't load the remote image directly (Windows).
        async function onFaviconError(index, el, url) {
            if (!el || !url || el.dataset.faviconRetried)
                return setFaviconFallback(index, el);
            el.dataset.faviconRetried = '1';
            let dataUrl = '';
            try {
                dataUrl = await window.tab.fetchFavicon?.(url);
            }
            catch (e) { window.northstarLog?.debug('renderer', 'onFaviconError: ' + e); }
            if (dataUrl && el.isConnected) {
                el.onload = () => markFaviconResolved(index);
                el.onerror = () => setFaviconFallback(index, el); // data URL shouldn't fail, but be safe
                el.src = dataUrl;
            }
            else {
                setFaviconFallback(index, el);
            }
        }
        // Placeholder for a page with no usable favicon: a neutral globe, as a
        // native browser draws. (It was the host's initial in a grey tile, which
        // read as a missing asset rather than as "this site has no icon".)
        // A user-set icon replaces the favicon entirely and is re-applied after
        // any favicon update, so navigation cannot overwrite it.
        function applyCustomTabIcon(index, icon) {
            const btn = tabs.get(index);
            if (!btn) return;
            const cur = btn.querySelector('.tab-favicon');
            if (!icon) {
                // Clearing must put an icon back, or the tab keeps the old emoji.
                btn.dataset.customIcon = '';
                setFaviconFallback(index, cur);
                return;
            }
            btn.dataset.customIcon = icon;
            const div = document.createElement('div');
            div.className = 'tab-favicon default custom-icon';
            div.textContent = icon;
            if (cur) cur.replaceWith(div);
            btn.classList.add('has-favicon');
        }
        function setFaviconFallback(index, el) {
            const div = document.createElement('div');
            div.className = 'tab-favicon default globe';
            div.setAttribute('aria-hidden', 'true');
            const custom = tabs.get(index)?.dataset.customIcon;
            if (custom) return applyCustomTabIcon(index, custom);
            if (el && el.isConnected)
                el.replaceWith(div);
            else {
                const b = tabs.get(index);
                b?.querySelector('.tab-favicon')?.replaceWith(div);
            }
            tabs.get(index)?.classList.add('has-favicon'); // a letter is still a resolved icon
        }
        function updateTabWidths(_total) {
            const count = tabs.size;
            if (!count)
                return;
            // Sidebar mode: tabs are full-width rows — clear any inline widths the
            // top-strip layout applied and let CSS drive.
            if (sideTabs()) {
                for (const t of tabs.values()) {
                    t.style.width = t.style.minWidth = t.style.maxWidth = '';
                    t.style.flex = '';
                }
                tabsContainer.style.overflowX = '';
                return;
            }
            // Held after a mouse close until the pointer leaves the strip (P1-3):
            // the removed node is gone but the survivors keep their widths, so the
            // next ✕ lands under the cursor.
            if (closingFreeze)
                return;
            requestAnimationFrame(() => {
                // Bail if we've switched to side mode since this frame was
                // scheduled: the side path above already cleared the inline
                // widths, and applying the top-strip's compact (favicon-width)
                // sizing now would leave folder members and pinned tabs stuck as
                // labelless favicon tiles in the sidebar until the next resize.
                if (sideTabs())
                    return;
                // The container is content-sized now, so its own width isn't the
                // space available for tabs. container + spacer is the full slack
                // (invariant to tab widths); reserve a strip of it for dragging the
                // window so the tabs never consume every last pixel.
                const DRAG_RESERVE = 46;
                const avail = tabsContainer.offsetWidth + (tabDragSpacer?.offsetWidth || 0);
                const barW = Math.max(200, (avail || tabBar.offsetWidth) - DRAG_RESERVE);
                const PINNED_W = 34;
                const MIN_W = 120; // comfortable resting minimum
                const COMFY_W = 200; // preferred width when there's room to spare
                const allTabs = [...tabs.values()];
                // Pinned tabs AND a folder's member tabs render as compact favicon
                // tiles (PINNED_W); everything else is a full-width tab.
                const isCompact = t => t.classList.contains('pinned') || t.classList.contains('in-folder');
                const compact = allTabs.filter(isCompact);
                const unpinned = allTabs.filter(t => !isCompact(t));
                compact.forEach(t => Object.assign(t.style, { width: `${PINNED_W}px`, minWidth: `${PINNED_W}px`, maxWidth: `${PINNED_W}px`, flex: '0 0 auto' }));
                if (!unpinned.length) {
                    tabBar.classList.add('only-pinned');
                    tabsContainer.style.overflowX = 'hidden';
                    return;
                }
                tabBar.classList.remove('only-pinned');
                // Only tiles actually on screen claim width — a collapsed folder's
                // members are display:none and reserve nothing.
                const shownCompact = compact.filter(t => !t.classList.contains('folder-collapsed')).length;
                const remaining = barW - shownCompact * PINNED_W;
                const ideal = Math.floor(Math.max(0, remaining) / unpinned.length);
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
            if (!tabsContainer)
                return;
            if (sideTabs()) {
                tabBar.classList.remove('scrollable-left', 'scrollable-right');
                return;
            }
            const max = tabsContainer.scrollWidth - tabsContainer.clientWidth;
            const left = tabsContainer.scrollLeft;
            tabBar.classList.toggle('scrollable-left', left > 2);
            tabBar.classList.toggle('scrollable-right', max - left > 2);
        }
        function getDragAfterElement(container, coord, pinned = false) {
            // Only consider tabs in the dragged tab's own group — pinned tabs
            // reorder within the pinned block, unpinned within the rest.
            // `coord` is x in the top strip, y in the sidebar (vertical list).
            const sel = pinned ? '.tab-button.pinned:not(.dragging)'
                : '.tab-button:not(.pinned):not(.dragging)';
            const vertical = sideTabs();
            return [...container.querySelectorAll(sel)].reduce((closest, child) => {
                const r = child.getBoundingClientRect();
                const offset = vertical ? coord - r.top - r.height / 2 : coord - r.left - r.width / 2;
                return (offset < 0 && offset > closest.offset) ? { offset, element: child } : closest;
            }, { offset: Number.NEGATIVE_INFINITY }).element;
        }
        /** Reorder preview: place the dragged tab under the cursor, keeping the
         *  pinned block intact at the start of the strip. */
        function placeDraggedTab(btn, x) {
            const pinned = btn.classList.contains('pinned');
            const after = getDragAfterElement(tabsContainer, x, pinned);
            if (pinned) {
                const firstUnpinned = [...tabsContainer.querySelectorAll('.tab-button')]
                    .find(b => b !== btn && !b.classList.contains('pinned'));
                tabsContainer.insertBefore(btn, after ?? firstUnpinned ?? null);
            }
            else if (after == null) {
                tabsContainer.appendChild(btn);
            }
            else {
                tabsContainer.insertBefore(btn, after);
            }
        }
        // Auto-scroll the strip while a tab is dragged near its edges — without
        // this a tab can't be moved from one end of an overflowing strip to the
        // other in a single gesture.
        let edgeScrollDir = 0;
        let edgeScrollTimer = null;
        function edgeAutoScroll(x, y = null) {
            const r = tabsContainer.getBoundingClientRect();
            const vertical = sideTabs();
            const c = vertical ? (y ?? x) : x;
            const dir = vertical
                ? (c < r.top + 24 ? -1 : (c > r.bottom - 24 ? 1 : 0))
                : (c < r.left + 24 ? -1 : (c > r.right - 24 ? 1 : 0));
            if (dir === edgeScrollDir)
                return;
            edgeScrollDir = dir;
            clearInterval(edgeScrollTimer);
            edgeScrollTimer = null;
            if (dir)
                edgeScrollTimer = setInterval(() => {
                    if (sideTabs())
                        tabsContainer.scrollTop += dir * 12;
                    else
                        tabsContainer.scrollLeft += dir * 12;
                }, 16);
        }
        function stopEdgeScroll() {
            edgeScrollDir = 0;
            clearInterval(edgeScrollTimer);
            edgeScrollTimer = null;
        }
        // ─────────────────────────────────────────────────────────────────────────
        // Focus mode + Pomodoro timer
        // ─────────────────────────────────────────────────────────────────────────
        function initFocusModeAndPomodoro() {
            document.getElementById('compact-btn')?.addEventListener('click', (e) => {
                try { window.tabsUI.toggleCompact(); } catch (err) { window.northstarLog?.debug('renderer', 'initFocusModeAndPomodoro: ' + err); }
                releaseFocusToPage(e.currentTarget);
            });
            const focusBtn = document.getElementById('focus-btn');
            const utilityBar = document.getElementById('utility-bar');
            const pomPill = document.getElementById('pomodoro-pill');
            const pillTime = document.getElementById('pill-time');
            const pillRingFill = document.getElementById('pill-ring-fill');
            const pillPhaseDot = document.getElementById('pill-phase-dot');
            const pomOverlay = document.getElementById('pomodoro-overlay');
            const pomPhase = document.getElementById('pomodoro-phase');
            const pomTime = document.getElementById('pomodoro-time');
            const pomStartBtn = document.getElementById('pomodoro-start');
            const pomSkipBtn = document.getElementById('pomodoro-skip');
            const pomResetBtn = document.getElementById('pomodoro-reset');
            const pomSessions = document.getElementById('pomodoro-sessions');
            const pomCloseBtn = document.getElementById('pomodoro-close');
            // Config from settings (seconds)
            const POM_FOCUS = getPomSetting('pomWork', 25) * 60;
            const POM_SHORT = getPomSetting('pomShortBreak', 5) * 60;
            const POM_LONG = getPomSetting('pomLongBreak', 15) * 60;
            const POM_SESSIONS = getPomSetting('pomSessions', 4);
            const RING_CIRC = 2 * Math.PI * 11; // pill ring r=11
            let pom = {
                phase: 'focus', running: false, elapsed: 0,
                total: POM_FOCUS, sessionsDone: 0, timer: null, shown: false,
            };
            function pomShowPill() {
                if (pom.shown)
                    return;
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
                const remaining = Math.max(0, pom.total - pom.elapsed);
                const mins = String(Math.floor(remaining / 60)).padStart(2, '0');
                const secs = String(remaining % 60).padStart(2, '0');
                const timeStr = `${mins}:${secs}`;
                const isFocus = pom.phase === 'focus';
                const phaseLabel = isFocus
                    ? 'Focus'
                    : (pom.sessionsDone % POM_SESSIONS === 0 ? 'Long Break' : 'Short Break');
                pillTime.textContent = timeStr;
                pillRingFill.style.strokeDashoffset = String(RING_CIRC * (pom.elapsed / pom.total));
                // SVG elements: className is read-only (throws in strict mode) — use setAttribute.
                pillRingFill.setAttribute('class', 'pill-ring-fill' + (isFocus ? '' : ' break'));
                pillPhaseDot.setAttribute('class', 'pill-phase-dot' + (isFocus ? '' : ' break'));
                pomTime.textContent = timeStr;
                pomPhase.textContent = phaseLabel;
                pomPhase.className = 'pomodoro-phase' + (isFocus ? '' : ' break');
                pomStartBtn.textContent = pom.running ? 'Pause' : 'Start';
                pomSessions.innerHTML = '';
                for (let i = 0; i < POM_SESSIONS; i++) {
                    const dot = document.createElement('div');
                    dot.className = 'pom-session-dot' + (i < (pom.sessionsDone % POM_SESSIONS) ? ' done' : '');
                    pomSessions.appendChild(dot);
                }
            }
            async function pomSetFocusActive(active) {
                const current = await window.focusMode.getState();
                if (current !== active)
                    await window.focusMode.toggle();
                focusBtn.classList.toggle('active', active);
            }
            async function pomAdvancePhase() {
                if (pom.phase === 'focus') {
                    pom.sessionsDone++;
                    pom.phase = 'break';
                    pom.total = (pom.sessionsDone % POM_SESSIONS === 0) ? POM_LONG : POM_SHORT;
                    await pomSetFocusActive(false);
                }
                else {
                    pom.phase = 'focus';
                    pom.total = POM_FOCUS;
                    await pomSetFocusActive(true);
                }
                pom.elapsed = 0;
                pom.running = true;
                pomUpdateUI();
            }
            function pomTick() {
                pom.elapsed++;
                if (pom.elapsed >= pom.total) {
                    clearInterval(pom.timer);
                    pom.timer = null;
                    pom.running = false;
                    pomAdvancePhase().then(() => {
                        if (pom.running)
                            pom.timer = setInterval(pomTick, 1000);
                    });
                }
                else {
                    pomUpdateUI();
                }
            }
            function pomOpenOverlay() { pomUpdateUI(); pomOverlay.classList.remove('hidden'); window.focusMode.overlayOpen(); }
            function pomCloseOverlay() { pomOverlay.classList.add('hidden'); window.focusMode.overlayClose(); }
            pomStartBtn.addEventListener('click', () => {
                if (pom.running) {
                    clearInterval(pom.timer);
                    pom.timer = null;
                    pom.running = false;
                }
                else {
                    pom.running = true;
                    pom.timer = setInterval(pomTick, 1000);
                }
                pomUpdateUI();
            });
            pomSkipBtn.addEventListener('click', () => {
                clearInterval(pom.timer);
                pom.timer = null;
                pom.running = false;
                pomAdvancePhase().then(() => { if (pom.running)
                    pom.timer = setInterval(pomTick, 1000); });
            });
            pomResetBtn.addEventListener('click', async () => {
                clearInterval(pom.timer);
                Object.assign(pom, { timer: null, running: false, elapsed: 0, phase: 'focus', total: POM_FOCUS, sessionsDone: 0 });
                pomUpdateUI();
                pomCloseOverlay();
                pomHidePill();
                if (await window.focusMode.getState()) {
                    await window.focusMode.toggle();
                    focusBtn.classList.remove('active');
                }
            });
            pomCloseBtn.addEventListener('click', pomCloseOverlay);
            pomPill.addEventListener('click', pomOpenOverlay);
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && !pomOverlay.classList.contains('hidden'))
                    pomCloseOverlay();
            });
            focusBtn.addEventListener('click', async () => {
                const active = await window.focusMode.toggle();
                focusBtn.classList.toggle('active', active);
                if (active) {
                    pomShowPill();
                    if (!pom.running) {
                        pom.running = true;
                        pom.timer = setInterval(pomTick, 1000);
                    }
                    pomUpdateUI();
                }
                else {
                    clearInterval(pom.timer);
                    Object.assign(pom, { timer: null, running: false, elapsed: 0, phase: 'focus', total: POM_FOCUS, sessionsDone: 0 });
                    pomHidePill();
                    pomUpdateUI();
                }
            });
            window.focusMode.onChanged((active) => focusBtn.classList.toggle('active', active));
            window.focusMode.getState().then(active => focusBtn.classList.toggle('active', active));
            pomUpdateUI();
        }
        // ─────────────────────────────────────────────────────────────────────────
        // Utility-bar customization — Settings → Appearance → Toolbar decides which
        // buttons exist. 'user-hidden' (display:none !important) layers on top of
        // the dynamic '.hidden' logic (reader/pip/downloads still self-hide when
        // not applicable), so both must clear for a button to show.
        // ─────────────────────────────────────────────────────────────────────────
        function applyUtilityBarConfig(cfg) {
            // Inside the function: the init sequence at the top of the file runs
            // before top-level consts down here would be initialized (TDZ).
            const UTILITY_BAR_ITEMS = {
                extensions: 'extensions-btn',
                downloads: 'downloads-btn',
                bookmark: 'bookmark-btn',
                reader: 'reader-btn',
                pip: 'pip-btn',
                focus: 'focus-btn',
                pomodoro: 'pomodoro-pill',
            };
            const conf = cfg || {};
            for (const [key, id] of Object.entries(UTILITY_BAR_ITEMS)) {
                const el = document.getElementById(id);
                if (el)
                    el.classList.toggle('user-hidden', conf[key] === false);
            }
        }
        function initUtilityBarConfig() {
            applyUtilityBarConfig(settings.utilityBar);
            if (window.northstarSettings?.onUtilityBarChanged) {
                window.northstarSettings.onUtilityBarChanged((cfg) => {
                    settings.utilityBar = cfg;
                    applyUtilityBarConfig(cfg);
                });
            }
        }
        // ─────────────────────────────────────────────────────────────────────────
        // Extensions button + panel (puzzle icon → installed list + Web Store link)
        // ─────────────────────────────────────────────────────────────────────────
        function initExtensions() {
            const btn = document.getElementById('extensions-btn');
            if (!btn || !window.extensionsUI)
                return;
            let panelOpen = false;
            // ── standard pinning ────────────────────────────────────────────
            // Unpinned actions stay rendered (so a panel activation can still click
            // them and anchor their popup to the toolbar) but are lifted out of the
            // strip: absolutely positioned at the list origin and invisible.
            const actionList = () => document.querySelector('browser-action-list');
            function applyPinned(map) {
                const list = actionList();
                const root = list && list.shadowRoot;
                if (!root)
                    return;
                let style = root.getElementById('northstar-pin-style');
                if (!style) {
                    style = document.createElement('style');
                    style.id = 'northstar-pin-style';
                    root.appendChild(style);
                }
                const unpinned = Object.keys(map || {}).filter(id => map[id] === false);
                // :host{position:relative} makes the collapsed nodes anchor at the
                // list's own origin (right side of the toolbar) — so a popup opened
                // from the panel appears under the toolbar, not at the viewport corner.
                style.textContent = ':host{position:relative}\n' + unpinned.map(id => `#${CSS.escape(id)}{position:absolute;left:0;top:0;visibility:hidden;pointer-events:none;}`).join('\n');
            }
            let pinnedMap = (settings.extPinned || {});
            // The custom element upgrades asynchronously — retry until its shadow
            // root exists, then keep the style asserted across re-renders.
            const pinInit = setInterval(() => {
                const list = actionList();
                if (!list || !list.shadowRoot)
                    return;
                clearInterval(pinInit);
                applyPinned(pinnedMap);
                new MutationObserver(() => {
                    if (!list.shadowRoot.getElementById('northstar-pin-style'))
                        applyPinned(pinnedMap);
                }).observe(list.shadowRoot, { childList: true });
            }, 250);
            window.extensionsUI.onPinnedChanged((map) => {
                pinnedMap = map || {};
                applyPinned(pinnedMap);
            });
            // ── chrome.sidePanel on action click ─────────────────────────────
            // An extension that called setPanelBehavior({openPanelOnActionClick})
            // gets its side panel instead of a popup. The decision must be
            // synchronous to beat the library's own handler inside the custom
            // element, so the id set is kept here and refreshed from main.
            let sidePanelIds = new Set();
            const refreshSidePanelIds = (ids) => { sidePanelIds = new Set(ids || []); };
            if (window.extensionsUI.sidePanelBehavior)
                window.extensionsUI.sidePanelBehavior().then(refreshSidePanelIds).catch(() => { });
            if (window.extensionsUI.onSidePanelBehavior)
                window.extensionsUI.onSidePanelBehavior(refreshSidePanelIds);
            // Capture phase on the host element: the library listens inside the
            // shadow root, so this runs first and can stop the event.
            const extIdFromEvent = (e) => {
                const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
                for (const n of path) {
                    if (n && n.id && sidePanelIds.has(n.id))
                        return n.id;
                }
                return null;
            };
            document.addEventListener('click', (e) => {
                if (!sidePanelIds.size)
                    return;
                const list = actionList();
                if (!list || !e.composedPath || !e.composedPath().includes(list))
                    return;
                const id = extIdFromEvent(e);
                if (!id)
                    return;
                e.preventDefault();
                e.stopPropagation();
                window.extensionsUI.openSidePanel(id);
            }, true);
            // Panel row click → click the real action button so the extension's
            // popup opens (or its onClicked fires), anchored to the toolbar.
            window.extensionsUI.onActivate((id) => {
                if (sidePanelIds.has(id)) {
                    window.extensionsUI.openSidePanel(id);
                    return;
                }
                const list = actionList();
                const node = list && list.shadowRoot && list.shadowRoot.getElementById(id);
                if (node)
                    node.click();
            });
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const r = btn.getBoundingClientRect();
                panelOpen = await window.extensionsUI.togglePanel({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
                btn.classList.toggle('active', panelOpen);
            });
            window.extensionsUI.onPanelClosed(() => {
                panelOpen = false;
                btn.classList.remove('active');
            });
            // Close the panel AND any open action popup on clicks outside
            // (chrome or page content) — mirrors the usual dismissal behaviour.
            // Clicks inside the action strip (or our synthetic activation clicks)
            // are the ones OPENING a popup — those must not dismiss it.
            window.addEventListener('click', (e) => {
                if (panelOpen && !btn.contains(e.target))
                    window.extensionsUI.closePanel();
                const insideActionStrip = typeof e.composedPath === 'function' &&
                    e.composedPath().some((n) => n && n.tagName === 'BROWSER-ACTION-LIST');
                if (!insideActionStrip)
                    window.extensionsUI.closeActionPopup();
            });
            if (window.contentInteraction) {
                window.contentInteraction.onClicked(() => {
                    if (panelOpen)
                        window.extensionsUI.closePanel();
                    window.extensionsUI.closeActionPopup();
                });
            }
        }
        // ─────────────────────────────────────────────────────────────────────────
        // Downloads button + panel
        // ─────────────────────────────────────────────────────────────────────────
        function initDownloads() {
            // One owner for BOTH download buttons — the toolbar one (top mode) and
            // the sidebar-foot one (side mode, the default). Whichever the layout
            // shows is where the panel anchors (P1-4).
            const btns = ['downloads-btn', 'sb-downloads']
                .map(id => document.getElementById(id)).filter(Boolean);
            if (!btns.length || !window.downloads)
                return;
            let panelOpen = false;
            // A partial panel (auto-opened by a new download) closes itself after
            // 5 s; a full panel (opened by a click / Ctrl+J) never does.
            let autoCloseArmed = false;
            let autoCloseTimer = null;
            let pointerOverButton = false;
            let panelHovered = false;
            const seen = new Set(); // download ids seen → a new id means "auto-open"
            // A screen reader must never have the panel yanked out from under it
            // (Chrome's rule for any accessibility mode). Read once at startup.
            let a11yOn = false;
            try { a11yOn = !!window.downloads.a11y?.(); }
            catch (e) { a11yOn = false; }
            const AUTO_CLOSE_MS = 5000;
            const visibleBtn = () => btns.find(b => b.offsetParent !== null) || btns[0];
            const panelAnchor = () => {
                const r = visibleBtn().getBoundingClientRect();
                return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
            };
            // Progress ring: determinate from aggregate bytes, indeterminate (a
            // spinning arc) when any in-flight item has no content-length.
            function ringFor(b, prog) {
                if (!prog.length) {
                    b.classList.remove('dl-active', 'dl-indeterminate');
                    b.style.removeProperty('--dl-progress');
                    return;
                }
                const indeterminate = prog.some(i => !(i.totalBytes > 0));
                b.classList.add('dl-active');
                b.classList.toggle('dl-indeterminate', indeterminate);
                if (!indeterminate) {
                    const recv = prog.reduce((s, i) => s + (i.receivedBytes || 0), 0);
                    const tot = prog.reduce((s, i) => s + (i.totalBytes || 0), 0);
                    b.style.setProperty('--dl-progress', tot ? Math.min(1, recv / tot) : 0);
                }
            }
            function syncButton(items) {
                const prog = items.filter(i => i.state === 'progressing');
                for (const b of btns) {
                    b.classList.toggle('hidden', items.length === 0);
                    b.classList.toggle('downloading', prog.length > 0);
                    b.title = prog.length > 0 ? `Downloads — ${prog.length} in progress` : 'Downloads';
                    ringFor(b, prog);
                }
            }
            function armAutoClose() {
                clearTimeout(autoCloseTimer);
                // Never while a screen reader is on, or while the pointer is over a
                // button or the panel — the partial panel waits for you to leave.
                if (!autoCloseArmed || a11yOn || pointerOverButton || panelHovered)
                    return;
                autoCloseTimer = setTimeout(() => {
                    if (panelOpen && autoCloseArmed)
                        window.downloads.closePanel();
                }, AUTO_CLOSE_MS);
            }
            async function togglePanel({ auto = false } = {}) {
                const open = await window.downloads.togglePanel(panelAnchor());
                panelOpen = open;
                for (const b of btns) {
                    b.classList.toggle('active', open);
                    if (open)
                        b.classList.remove('has-new');
                }
                autoCloseArmed = open && auto;
                if (open)
                    armAutoClose();
                else
                    clearTimeout(autoCloseTimer);
            }
            // A click / Ctrl+J opens full mode (all session downloads), which never
            // auto-closes. The button is hidden until the first download.
            async function openManual() {
                if (btns.every(b => b.classList.contains('hidden')))
                    return;
                if (panelOpen && !autoCloseArmed)
                    return; // already up in full mode → the click is a toggle-close handled below
                await togglePanel({ auto: false });
            }
            // A new download pops the partial panel and starts the 5 s countdown.
            async function openPartial() {
                if (btns.every(b => b.classList.contains('hidden')))
                    return;
                if (panelOpen) { autoCloseArmed = true; armAutoClose(); return; }
                await togglePanel({ auto: true });
            }
            for (const b of btns) {
                b.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (panelOpen) { window.downloads.closePanel(); return; }
                    togglePanel({ auto: false });
                });
                b.addEventListener('mouseenter', () => { pointerOverButton = true; clearTimeout(autoCloseTimer); });
                b.addEventListener('mouseleave', () => { pointerOverButton = false; armAutoClose(); });
            }
            window.downloads.onShortcut?.(() => openManual());
            // The panel view reports its own hover (it is a separate WebContentsView,
            // so the chrome can't see the pointer enter it) — pauses the countdown.
            window.downloads.onPanelHover?.((hovered) => {
                panelHovered = !!hovered;
                if (panelHovered)
                    clearTimeout(autoCloseTimer);
                else
                    armAutoClose();
            });
            window.downloads.onPanelClosed(() => {
                panelOpen = false;
                autoCloseArmed = false;
                clearTimeout(autoCloseTimer);
                for (const b of btns)
                    b.classList.remove('active');
            });
            window.downloads.onChanged(async (item) => {
                const items = await window.downloads.getAll();
                syncButton(items);
                // Pulse ends → mark completion so the user notices the finished file
                if (item && item.state === 'completed' && !panelOpen)
                    for (const b of btns)
                        b.classList.add('has-new');
                // A newly-started download opens the partial panel within this tick,
                // right after syncButton reveals the button (P1-4, box 28).
                if (item && item.state === 'progressing' && !seen.has(item.id)) {
                    seen.add(item.id);
                    openPartial();
                }
            });
            // Close the panel on clicks outside either button (chrome or page).
            window.addEventListener('click', (e) => {
                if (panelOpen && !btns.some(b => b.contains(e.target)))
                    window.downloads.closePanel();
            });
            if (window.contentInteraction) {
                window.contentInteraction.onClicked(() => { if (panelOpen)
                    window.downloads.closePanel(); });
            }
            // Restore button state for downloads started earlier in the session.
            window.downloads.getAll().then((items) => {
                for (const it of items) seen.add(it.id); // don't auto-open on restore
                syncButton(items);
            }).catch(() => { });
        }
        // ─────────────────────────────────────────────────────────────────────────
        // Reader mode + Picture-in-Picture buttons
        // ─────────────────────────────────────────────────────────────────────────
        function initReaderAndPip() {
            const readerBtn = document.getElementById('reader-btn');
            const pipBtn = document.getElementById('pip-btn');
            if (readerBtn && window.reader) {
                readerBtn.addEventListener('click', (e) => {
                    window.reader.toggle(activeTabIndex);
                    releaseFocusToPage(e.currentTarget);
                });
                // Main pushes { index, active, available } as pages load / tabs switch.
                window.reader.onState((d) => {
                    if (!d || d.index !== activeTabIndex)
                        return;
                    readerBtn.classList.toggle('hidden', !(d.available || d.active));
                    readerBtn.classList.toggle('active', !!d.active);
                    readerBtn.title = d.active ? T('chrome.readerExit', 'Exit reader view') : T('chrome.reader', 'Reader view');
                });
                window.reader.onFailed((d) => {
                    if (!d || d.index !== activeTabIndex)
                        return;
                    // quiet feedback that extraction failed — no motion
                    readerBtn.title = 'No article found on this page';
                    setTimeout(() => { readerBtn.title = T('chrome.reader', 'Reader view'); }, 1600);
                });
            }
            if (pipBtn && window.pip) {
                pipBtn.addEventListener('click', () => window.pip.toggle(activeTabIndex));
                window.pip.onMediaState((d) => {
                    if (!d || d.index !== activeTabIndex)
                        return;
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
                let anchor = null;
                try {
                    const r = menuBtn.getBoundingClientRect();
                    anchor = { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) };
                }
                catch (err) { window.northstarLog?.debug('renderer', 'menu anchor: ' + err); }
                window.menu.open(anchor);
                menuOpen = true;
            });
        }
        // ─────────────────────────────────────────────────────────────────────────
        // Menu bar — the Firefox-style File/Edit/… strip that drops from the top
        // when Alt is tapped. Windows only: mac has the system menu bar and Linux
        // the native (framed) one, so main only ever sends 'menubar-toggle' there
        // (features/menu-bar.js). The bar's rows come from the same eight menus as
        // the native bar; clicking one opens its dropdown through the themed
        // overlay menu, anchored under the label.
        // ─────────────────────────────────────────────────────────────────────────
        function initMenuBar() {
            const bar = document.getElementById('menu-bar');
            if (!bar || !window.appMenuBar)
                return;
            let built = false;
            let selected = 0; // index the arrow keys act on
            const isShown = () => !bar.classList.contains('hidden');
            const items = () => Array.from(bar.querySelectorAll('.menu-bar-item'));
            async function build() {
                // Item specs come from main (menu-bar.js) — the SAME source that
                // matches keypresses — so the underlined letter and the key that
                // fires always agree. Each spec is { label, keyIndex, key }.
                let specs = [];
                try { specs = await window.appMenuBar.labels(); }
                catch (e) { window.northstarLog?.debug('renderer', 'menubar labels: ' + e); }
                bar.innerHTML = '';
                specs.forEach((spec, index) => {
                    const label = (spec && spec.label) || '';
                    const ki = (spec && Number.isInteger(spec.keyIndex)) ? spec.keyIndex : -1;
                    const btn = document.createElement('button');
                    btn.className = 'menu-bar-item';
                    btn.type = 'button';
                    btn.setAttribute('aria-haspopup', 'menu');
                    btn.dataset.index = String(index);
                    if (ki >= 0) {
                        btn.dataset.key = label[ki].toLowerCase();
                        // The mnemonic letter, underlined — built from text nodes so
                        // the label is never treated as markup.
                        if (ki > 0) btn.appendChild(document.createTextNode(label.slice(0, ki)));
                        const u = document.createElement('u');
                        u.textContent = label[ki];
                        btn.appendChild(u);
                        btn.appendChild(document.createTextNode(label.slice(ki + 1)));
                    }
                    else {
                        btn.textContent = label;
                    }
                    btn.addEventListener('click', (e) => { e.stopPropagation(); openMenu(index); });
                    bar.appendChild(btn);
                });
                built = true;
            }
            function openMenu(index) {
                const btn = items()[index];
                if (!btn)
                    return;
                selected = index;
                items().forEach(el => el.setAttribute('aria-expanded', el === btn ? 'true' : 'false'));
                let anchor = null;
                try {
                    const r = btn.getBoundingClientRect();
                    anchor = { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) };
                }
                catch (e) { window.northstarLog?.debug('renderer', 'menubar anchor: ' + e); }
                try { window.appMenuBar.open(index, anchor); }
                catch (e) { window.northstarLog?.debug('renderer', 'menubar open: ' + e); }
            }
            function clearExpanded() {
                bar.querySelectorAll('.menu-bar-item[aria-expanded="true"]').forEach(el => el.setAttribute('aria-expanded', 'false'));
            }
            function highlight(i) {
                const list = items();
                if (!list.length)
                    return;
                selected = (i + list.length) % list.length;
                // Selection is a class only — never DOM focus. Moving focus to bar
                // items (or the chrome) left stray focus rings on toolbar buttons
                // and tabs ("random stuff selected"). The keyboard is driven from
                // main (before-input-event), so no element needs real focus here.
                list.forEach((el, n) => el.classList.toggle('is-selected', n === selected));
            }
            async function show() {
                if (!built)
                    await build();
                bar.classList.remove('hidden');
                // Gate the layout change (the extra top grid row in side mode) to
                // while the bar is actually open, so the default chrome layout is
                // never touched — see styles.css [data-menubar].
                document.documentElement.dataset.menubar = 'on';
                bookmarks.reportHeight();
                // Tell main the bar is open so it can drive the keyboard (mnemonics
                // and arrows) from before-input-event, which reaches it regardless of
                // which surface holds OS focus — no need to move OS focus here.
                try { window.appMenuBar.setOpen(true); }
                catch (e) { window.northstarLog?.debug('renderer', 'menubar setOpen: ' + e); }
                // No pre-selection: opening the bar should not highlight an item.
                // -1 means "nothing yet"; the first arrow lands on an end, and
                // mnemonics don't need a selection at all.
                selected = -1;
            }
            function hide() {
                clearExpanded();
                bar.querySelectorAll('.is-selected').forEach(el => el.classList.remove('is-selected'));
                if (!isShown())
                    return;
                bar.classList.add('hidden');
                document.documentElement.dataset.menubar = 'off';
                bookmarks.reportHeight();
                try { window.appMenuBar.setOpen(false); }
                catch (e) { window.northstarLog?.debug('renderer', 'menubar setOpen: ' + e); }
            }
            window.appMenuBar.onToggle(() => { isShown() ? hide() : show(); });
            // The dropdown closed: un-press its top-level item. If an item was
            // actually chosen the whole bar goes away (the action is done); a plain
            // dismiss keeps the bar so another menu can be opened.
            window.appMenuBar.onClosed((info) => {
                clearExpanded();
                if (info && info.picked)
                    hide();
                else if (isShown() && info && Number.isInteger(info.index))
                    highlight(info.index);
            });
            // Keyboard, driven from main (Shortcuts._routeMenuBarKey) so it works
            // even when a page's native view holds OS focus.
            window.appMenuBar.onKey((msg) => {
                if (!isShown() || !msg)
                    return;
                switch (msg.action) {
                    case 'hide': hide(); break;
                    case 'open': if (Number.isInteger(msg.index)) openMenu(msg.index); break;
                    case 'ArrowRight': highlight(selected + 1); break;
                    case 'ArrowLeft': highlight(selected - 1); break;
                    case 'ArrowDown': case 'ArrowUp': case 'Enter': openMenu(selected); break;
                }
            });
            // Clicking a page (its native view) dismisses the bar, like any menu.
            try { window.contentInteraction.onClicked(() => hide()); }
            catch (e) { window.northstarLog?.debug('renderer', 'menubar onClicked: ' + e); }
            // A press anywhere in the chrome outside the bar dismisses it too. (While
            // a dropdown is open the full-window overlay is what receives clicks, so
            // this only fires for the bar-shown-but-no-dropdown case.)
            document.addEventListener('mousedown', (e) => {
                if (isShown() && !e.target.closest('#menu-bar'))
                    hide();
            }, true);
        }
    });
})();
