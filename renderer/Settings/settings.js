"use strict";
// IIFE: compiled as a classic <script>; the wrapper keeps this page's
// top-level names out of the shared global scope.
(() => {
    document.addEventListener('DOMContentLoaded', async () => {
        // ── Load settings ──────────────────────────────────────────────────────
        let settings = {};
        try {
            settings = await window.northstarSettings.get();
        }
        catch (e) { window.northstarLog?.debug('settings', 'settings: ' + e); }
        // ── Sidebar navigation (hash-driven: northstar://settings/<section>) ────
        // The section lives in location.hash so the omnibox can show it as a
        // northstar://settings/<section> url and typing one lands on that section.
        const navItems = document.querySelectorAll('.nav-item');
        const sections = document.querySelectorAll('.section');
        const VALID = ['general', 'appearance', 'focus', 'privacy', 'passwords', 'extensions', 'data', 'import', 'about'];
        function activateSection(section) {
            if (!VALID.includes(section))
                section = 'general';
            navItems.forEach(n => n.classList.toggle('active', n.dataset.section === section));
            sections.forEach(s => s.classList.remove('active'));
            const el = document.getElementById('section-' + section);
            if (el)
                el.classList.add('active');
            save('settingsPage', section);
        }
        function sectionFromHash() {
            const h = (location.hash || '').replace(/^#/, '').toLowerCase();
            return VALID.includes(h) ? h : null;
        }
        // Initial: a typed hash wins, else the last-used section.
        const initial = sectionFromHash() || settings.settingsPage || 'general';
        // 'general' is the bare northstar://settings (no hash); others reflect in
        // the hash so the omnibox shows the section and did-navigate-in-page fires.
        if (initial !== 'general' && (location.hash || '').replace(/^#/, '') !== initial)
            location.hash = initial;
        activateSection(initial);
        navItems.forEach(item => {
            item.addEventListener('click', () => {
                const s = item.dataset.section;
                if (s === 'general') {
                    if (location.hash)
                        location.hash = '';
                    else
                        activateSection('general');
                }
                else
                    location.hash = s;
            });
        });
        window.addEventListener('hashchange', () => activateSection(sectionFromHash() || 'general'));
        // ── Toast helper ───────────────────────────────────────────────────────
        let toastTimer;
        function showToast(msg) {
            const t = document.getElementById('toast');
            t.textContent = msg;
            t.classList.add('show');
            clearTimeout(toastTimer);
            toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
        }
        async function save(key, value) {
            try {
                await window.northstarSettings.set(key, value);
            }
            catch (e) { window.northstarLog?.debug('settings', 'save: ' + e); }
        }
        // ── General: On startup ────────────────────────────────────────────────
        const startupRadios = document.querySelectorAll('input[name="startup"]');
        const startupVal = settings.persistAllTabs ? 'restore' : 'new-tab';
        startupRadios.forEach(r => { if (r.value === startupVal)
            r.checked = true; });
        startupRadios.forEach(r => {
            r.addEventListener('change', async () => {
                await save('persistAllTabs', r.value === 'restore');
            });
        });
        // ── General: Search engines (built-ins + the user's own) ──────────────
        const searchEngineSelect = document.getElementById('search-engine');
        const engineList = document.getElementById('engine-list');
        const engineName = document.getElementById('engine-name');
        const engineKeyword = document.getElementById('engine-keyword');
        const engineUrl = document.getElementById('engine-url');
        const engineSave = document.getElementById('engine-save');
        async function renderEngines() {
            const engines = await window.northstarEngines.list();
            const current = settings.searchEngine || 'google';
            searchEngineSelect.textContent = '';
            for (const e of engines) {
                const opt = document.createElement('option');
                opt.value = e.id;
                opt.textContent = e.name;
                searchEngineSelect.appendChild(opt);
            }
            searchEngineSelect.value = engines.some(e => e.id === current) ? current : 'google';
            engineList.textContent = '';
            for (const e of engines) {
                const row = document.createElement('div');
                row.className = 'engine-row';
                const name = document.createElement('span');
                name.className = 'name';
                name.textContent = e.name;
                row.appendChild(name);
                if (e.keyword) {
                    const kw = document.createElement('span');
                    kw.className = 'kw';
                    kw.textContent = e.keyword;
                    row.appendChild(kw);
                }
                const host = document.createElement('span');
                host.className = 'host';
                try { host.textContent = new URL(e.url.replace('%s', 'q')).hostname; }
                catch { host.textContent = ''; }
                row.appendChild(host);
                const del = document.createElement('button');
                del.className = 'del';
                del.innerHTML = '<svg width="12" height="12" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M208.49,191.51a12,12,0,0,1-17,17L128,145,64.49,208.49a12,12,0,0,1-17-17L111,128,47.51,64.49a12,12,0,0,1,17-17L128,111l63.51-63.52a12,12,0,0,1,17,17L145,128Z"/></svg>';
                del.title = e.builtIn ? 'Built-in engines cannot be removed' : `Remove ${e.name}`;
                del.setAttribute('aria-label', del.title);
                del.disabled = !!e.builtIn;
                del.addEventListener('click', async () => {
                    await window.northstarEngines.remove(e.id);
                    if (searchEngineSelect.value === e.id)
                        await save('searchEngine', 'google');
                    showToast(`Removed ${e.name}`);
                    renderEngines();
                });
                row.appendChild(del);
                engineList.appendChild(row);
            }
        }
        searchEngineSelect.addEventListener('change', async () => {
            settings.searchEngine = searchEngineSelect.value;
            await save('searchEngine', searchEngineSelect.value);
            showToast('Search engine updated');
        });
        engineSave?.addEventListener('click', async () => {
            const res = await window.northstarEngines.save({
                name: engineName.value.trim(),
                keyword: engineKeyword.value.trim(),
                url: engineUrl.value.trim(),
            });
            if (!res?.ok) {
                showToast(res?.error || 'Could not add that engine');
                return;
            }
            engineName.value = engineKeyword.value = engineUrl.value = '';
            showToast('Search engine added');
            renderEngines();
        });
        renderEngines();
        // ── General: Default browser ──────────────────────────────────────────
        const defaultState = document.getElementById('default-browser-state');
        const makeDefaultBtn = document.getElementById('make-default');
        async function refreshDefaultBrowser() {
            try {
                const st = await window.userData.defaultBrowserStatus();
                if (st.isDefault) {
                    defaultState.textContent = 'Northstar is your default browser.';
                    makeDefaultBtn.classList.add('hidden');
                }
                else {
                    defaultState.textContent = 'Links from other apps open in a different browser.';
                    makeDefaultBtn.classList.remove('hidden');
                }
            }
            catch {
                defaultState.textContent = 'Could not read the current default.';
            }
        }
        makeDefaultBtn?.addEventListener('click', async () => {
            const res = await window.userData.makeDefaultBrowser();
            if (res?.openedSettings)
                showToast('Choose Northstar in the Default Apps pane');
            else
                showToast(res?.isDefault ? 'Northstar is now the default browser' : 'The system did not accept the change');
            refreshDefaultBrowser();
        });
        refreshDefaultBrowser();
        // ── Appearance: tab bar position ──────────────────────────────────────
        const tabbarRadios = document.querySelectorAll('input[name="tabbar"]');
        const tabbarVal = (settings.tabBarSide === 'top') ? 'top' : 'side';
        tabbarRadios.forEach(r => { if (r.value === tabbarVal) r.checked = true; });
        tabbarRadios.forEach(r => r.addEventListener('change', async () => {
            if (!r.checked) return;
            await save('tabBarSide', r.value);
            showToast(r.value === 'top' ? 'Tabs moved to the top' : 'Tabs moved to the sidebar');
        }));

        // ── Appearance: Essentials ────────────────────────────────────────────
        const peekToggle = document.getElementById('essentials-peek-toggle');
        if (peekToggle) {
            // Defaults to ON, so an unset value must read as checked — `!== false`
            // rather than a truthiness test.
            peekToggle.checked = settings.essentialsPeek !== false;
            peekToggle.addEventListener('change', async () => {
                await save('essentialsPeek', peekToggle.checked);
                showToast(peekToggle.checked ? 'Links preview over essentials' : 'Links open in the essential');
            });
        }
        // ── General: Performance (tab sleeping) ────────────────────────────────
        const tabSleepToggle = document.getElementById('tabsleep-toggle');
        const tabSleepMins = document.getElementById('tabsleep-mins');
        if (tabSleepToggle) {
            tabSleepToggle.checked = settings.tabSleepEnabled !== false;
            tabSleepToggle.addEventListener('change', async () => {
                await save('tabSleepEnabled', tabSleepToggle.checked);
                showToast(tabSleepToggle.checked ? 'Tab sleeping enabled' : 'Tab sleeping disabled');
            });
        }
        if (tabSleepMins) {
            tabSleepMins.value = Number(settings.tabSleepMinutes) || 30;
            tabSleepMins.addEventListener('change', async () => {
                const v = Math.max(5, Math.min(480, parseInt(tabSleepMins.value, 10) || 30));
                tabSleepMins.value = v;
                await save('tabSleepMinutes', v);
            });
        }
        // ── General: Media (mini player) ───────────────────────────────────────
        const miniPlayerToggle = document.getElementById('miniplayer-toggle');
        if (miniPlayerToggle) {
            miniPlayerToggle.checked = settings.miniPlayerEnabled !== false;
            miniPlayerToggle.addEventListener('change', async () => {
                await save('miniPlayerEnabled', miniPlayerToggle.checked);
                showToast(miniPlayerToggle.checked ? 'Mini player enabled' : 'Mini player disabled');
            });
        }
        // ── Appearance: Language ───────────────────────────────────────────────
        const languageSelect = document.getElementById('language-select');
        const languageNote = document.getElementById('language-note');
        if (languageSelect) {
            (async () => {
                const locales = await window.northstarI18n.locales();
                const opts = [{ id: 'system', name: 'Match system language', coverage: 'full' }, ...locales];
                for (const loc of opts) {
                    const opt = document.createElement('option');
                    opt.value = loc.id;
                    // Say how complete a translation is rather than letting
                    // someone switch into a half-translated interface blind.
                    opt.textContent = loc.coverage === 'partial' ? `${loc.name} (partial)` : loc.name;
                    languageSelect.appendChild(opt);
                }
                languageSelect.value = settings.language || 'system';
                const describe = () => {
                    const chosen = opts.find(o => o.id === languageSelect.value);
                    languageNote.textContent = chosen && chosen.coverage === 'partial'
                        ? 'Parts of the interface that have not been translated yet stay in English.'
                        : '';
                };
                describe();
                languageSelect.addEventListener('change', async () => {
                    await window.northstarI18n.set(languageSelect.value);
                    describe();
                    showToast('Language updated');
                });
            })();
        }
        // ── Appearance: Spell check ────────────────────────────────────────────
        // On/off, the languages words are checked against, and the custom
        // dictionary — for every space's session (features/spellcheck.js).
        const spellApi = window.northstarSpellcheck;
        const spellCard = document.getElementById('spellcheck-card');
        if (spellApi && spellCard) {
            const toggle = document.getElementById('spell-toggle');
            const addLang = document.getElementById('spell-add-lang');
            const langChips = document.getElementById('spell-langs');
            const wordChips = document.getElementById('spell-words');
            const wordForm = document.getElementById('spell-add-word');
            const wordInput = document.getElementById('spell-word');
            const X_ICON = '<svg width="10" height="10" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M208.49,191.51a12,12,0,0,1-17,17L128,145,64.49,208.49a12,12,0,0,1-17-17L111,128,47.51,64.49a12,12,0,0,1,17-17L128,111l63.51-63.52a12,12,0,0,1,17,17L145,128Z"/></svg>';
            // "en-GB" → "English (United Kingdom)", in the interface's language.
            let names = null;
            try { names = new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' }); }
            catch (e) { window.northstarLog?.debug('settings', 'DisplayNames: ' + e); }
            const nameOf = (code) => { try { return (names && names.of(code)) || code; } catch { return code; } };
            const chip = (label, onRemove, removeLabel) => {
                const el = document.createElement('span');
                el.className = 'spell-chip' + (onRemove ? '' : ' auto');
                const t = document.createElement('span');
                t.textContent = label;
                el.appendChild(t);
                if (onRemove) {
                    const b = document.createElement('button');
                    b.type = 'button';
                    b.innerHTML = X_ICON;
                    b.setAttribute('aria-label', removeLabel);
                    b.addEventListener('click', onRemove);
                    el.appendChild(b);
                }
                return el;
            };
            let st = null;
            const renderLangs = () => {
                spellCard.classList.toggle('off', !st.enabled);
                toggle.checked = !!st.enabled;
                // macOS: the system spell checker picks the language itself.
                document.getElementById('spell-langs-row').hidden = st.systemLanguages;
                langChips.hidden = st.systemLanguages;
                langChips.innerHTML = '';
                const chosen = st.automatic ? [] : st.languages;
                if (st.automatic) {
                    langChips.appendChild(chip('Automatic: ' + st.languages.map(nameOf).join(', ')));
                }
                for (const code of chosen) {
                    langChips.appendChild(chip(nameOf(code), async () => {
                        const next = chosen.filter(c => c !== code);
                        st = await spellApi.set({ languages: next });
                        renderLangs();
                        showToast(next.length ? 'Language removed' : 'Spell check is back to automatic');
                    }, 'Remove ' + nameOf(code)));
                }
                addLang.innerHTML = '';
                const first = document.createElement('option');
                first.value = '';
                first.textContent = 'Add a language…';
                addLang.appendChild(first);
                const options = (st.available || [])
                    .filter(c => !chosen.includes(c))
                    .map(c => ({ c, n: nameOf(c) }))
                    .sort((a, b) => a.n.localeCompare(b.n));
                for (const { c, n } of options) {
                    const o = document.createElement('option');
                    o.value = c;
                    o.textContent = n;
                    addLang.appendChild(o);
                }
                addLang.value = '';
            };
            const renderWords = async () => {
                const words = await spellApi.words();
                wordChips.innerHTML = '';
                for (const w of words) {
                    wordChips.appendChild(chip(w, async () => {
                        await spellApi.removeWord(w);
                        renderWords();
                    }, 'Remove ' + w + ' from the dictionary'));
                }
            };
            (async () => {
                st = await spellApi.state();
                if (!st) return;
                renderLangs();
                renderWords();
            })();
            toggle.addEventListener('change', async () => {
                st = await spellApi.set({ enabled: toggle.checked });
                renderLangs();
                showToast(toggle.checked ? 'Spell check on' : 'Spell check off');
            });
            addLang.addEventListener('change', async () => {
                const code = addLang.value;
                if (!code) return;
                // Leaving automatic: start from what automatic was using, so
                // adding one language never silently drops the others.
                const base = st.automatic ? st.languages : st.languages.slice();
                st = await spellApi.set({ languages: [...base, code] });
                renderLangs();
                showToast(nameOf(code) + ' added');
            });
            wordForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const w = wordInput.value.trim();
                if (!w || /\s/.test(w)) {
                    showToast('Add one word at a time');
                    return;
                }
                await spellApi.addWord(w);
                wordInput.value = '';
                renderWords();
            });
        }
        // ── Appearance: Theme ──────────────────────────────────────────────────
        // The picker and editor are one instrument, shared with the popup that
        // opens from the sidebar's context menu — see renderer/lib/theme-editor.js.
        // This page supplies the container and the bridge; everything else is
        // the same code in both places.
        if (window.Northstar?.themeEditor && window.northstarThemes) {
            /* Settings edits the GLOBAL theme — the default a space with no theme
               of its own inherits. Per-SPACE themes are set from the sidebar's
               own theme popup (renderer/ThemePanel), which edits that space's
               slot. Keeping the two apart is what makes the split legible: this
               is "the browser's default look", the popup is "this space's look".
               The global scope edits one slot in place, exactly like a space. */
            window.Northstar.themeEditor.mount({
                picker: document.getElementById('theme-picker'),
                editor: document.getElementById('theme-editor'),
                api: window.northstarThemes,
                slotId: 'custom:global',
                setTheme: (id) => save('theme', id),
                toast: showToast,
                currentTheme: settings.theme || 'default',
            });
        }
        // ── Appearance: Bookmark bar ───────────────────────────────────────────
        // Toolbar customization — one persisted object; every key defaults to true.
        const tbToggles = document.querySelectorAll('.tb-toggle');
        if (tbToggles.length) {
            const tbConfig = Object.assign({}, settings.utilityBar || {});
            tbToggles.forEach((cb) => {
                const key = cb.dataset.key;
                cb.checked = tbConfig[key] !== false;
                cb.addEventListener('change', async () => {
                    tbConfig[key] = cb.checked;
                    await save('utilityBar', tbConfig);
                });
            });
        }
        const bookmarkBarToggle = document.getElementById('bookmark-bar-toggle');
        // We track the saved state in settings; the bookmark bar actual visibility
        // is managed by the renderer — toggling fires the same IPC the menu uses.
        bookmarkBarToggle.checked = !!settings.bookmarkBarVisible;
        bookmarkBarToggle.addEventListener('change', async () => {
            await save('bookmarkBarVisible', bookmarkBarToggle.checked);
            try {
                window.northstarSettings.toggleBookmarkBar();
            }
            catch (e) { window.northstarLog?.debug('settings', 'refreshDefaultBrowser: ' + e); }
        });
        // ── Focus: Distraction blocking ───────────────────────────────────────
        const shortformToggle = document.getElementById('shortform-toggle');
        shortformToggle.checked = !!settings.blockShortform;
        shortformToggle.addEventListener('change', async () => {
            await save('blockShortform', shortformToggle.checked);
            showToast(shortformToggle.checked ? 'Distraction blocking enabled' : 'Distraction blocking disabled');
        });
        // ── Focus: Pomodoro durations ──────────────────────────────────────────
        const fields = {
            'pom-work': { key: 'pomWork', min: 1, max: 120 },
            'pom-short': { key: 'pomShortBreak', min: 1, max: 60 },
            'pom-long': { key: 'pomLongBreak', min: 1, max: 120 },
            'pom-sessions': { key: 'pomSessions', min: 1, max: 10 },
        };
        for (const [id, { key, min, max }] of Object.entries(fields)) {
            const input = document.getElementById(id);
            input.value = settings[key] ?? input.min;
            input.addEventListener('change', async () => {
                let v = parseInt(input.value, 10);
                if (isNaN(v))
                    v = parseInt(input.min, 10);
                v = Math.max(min, Math.min(max, v));
                input.value = v;
                await save(key, v);
                showToast('Timer updated');
            });
        }
        // ── Privacy: Tracking protection ──────────────────────────────────────
        const privacyToggles = [
            { id: 'adblock-toggle', key: 'adBlockEnabled', label: 'Ad & tracker blocking' },
            { id: 'thirdparty-toggle', key: 'blockThirdPartyCookies', label: 'Third-party cookie blocking' },
            { id: 'https-toggle', key: 'httpsUpgrade', label: 'HTTPS upgrade' },
            { id: 'params-toggle', key: 'stripTrackingParams', label: 'Tracking-parameter stripping' },
            { id: 'signals-toggle', key: 'privacySignals', label: 'Do Not Track / GPC signals' },
            { id: 'referrer-toggle', key: 'trimReferrer', label: 'Referrer minimization' },
        ];
        privacyToggles.forEach(({ id, key, label }) => {
            const el = document.getElementById(id);
            if (!el)
                return;
            el.checked = settings[key] !== false; // every layer defaults on
            el.addEventListener('change', async () => {
                await save(key, el.checked);
                showToast(`${label} ${el.checked ? 'on' : 'off'}`);
            });
        });
        // Live "blocked this session" counter.
        const privacyCount = document.getElementById('privacy-count');
        async function refreshPrivacyStats() {
            try {
                const s = await window.northstarSettings.privacyStats();
                if (privacyCount && s && typeof s.blocked === 'number') {
                    privacyCount.textContent = s.blocked.toLocaleString();
                }
            }
            catch (e) { window.northstarLog?.debug('settings', 'refreshPrivacyStats: ' + e); }
        }
        refreshPrivacyStats();
        setInterval(refreshPrivacyStats, 2000);
        // ── Privacy: Clear browsing data ───────────────────────────────────────
        document.getElementById('btn-clear-data')?.addEventListener('click', async () => {
            const types = {
                history: document.getElementById('cbd-history').checked,
                cookies: document.getElementById('cbd-cookies').checked,
                cache: document.getElementById('cbd-cache').checked,
                downloads: document.getElementById('cbd-downloads').checked,
            };
            if (!Object.values(types).some(Boolean)) {
                showToast('Nothing selected');
                return;
            }
            const range = document.getElementById('cbd-range').value;
            const rangeLabel = document.querySelector('#cbd-range option:checked')?.textContent || '';
            if (!confirm(`Clear the selected data (${rangeLabel})? This cannot be undone.`))
                return;
            try {
                const res = await window.northstarSettings.clearBrowsingData({ range, types });
                showToast(res?.ok ? 'Browsing data cleared' : 'Failed to clear data');
            }
            catch {
                showToast('Failed to clear data');
            }
        });
        // ── Passwords ──────────────────────────────────────────────────────────
        const pwList = document.getElementById('pw-list');
        const pwEmpty = document.getElementById('pw-empty');
        async function refreshPasswords() {
            let items = [];
            try {
                items = await window.northstarPasswords.list();
            }
            catch (e) { window.northstarLog?.debug('settings', 'refreshPasswords: ' + e); }
            pwList.innerHTML = '';
            if (pwEmpty)
                pwEmpty.style.display = items.length ? 'none' : 'block';
            for (const entry of items) {
                const row = document.createElement('div');
                row.className = 'pw-row';
                const info = document.createElement('div');
                info.className = 'pw-info';
                let host = entry.origin;
                try {
                    host = new URL(entry.origin).host;
                }
                catch (e) { window.northstarLog?.debug('settings', 'refreshPasswords: ' + e); }
                const site = document.createElement('div');
                site.className = 'pw-site';
                site.textContent = host;
                const user = document.createElement('div');
                user.className = 'pw-user';
                user.textContent = entry.username || '(no username)';
                info.appendChild(site);
                info.appendChild(user);
                const secret = document.createElement('input');
                secret.type = 'password';
                secret.value = '••••••••';
                secret.readOnly = true;
                secret.className = 'pw-secret';
                const reveal = document.createElement('button');
                reveal.className = 'btn btn-sm';
                reveal.textContent = 'Show';
                let shown = false;
                reveal.addEventListener('click', async () => {
                    shown = !shown;
                    if (shown) {
                        const pw = await window.northstarPasswords.reveal(entry.id);
                        secret.type = 'text';
                        secret.value = pw || '';
                        reveal.textContent = 'Hide';
                    }
                    else {
                        secret.type = 'password';
                        secret.value = '••••••••';
                        reveal.textContent = 'Show';
                    }
                });
                const del = document.createElement('button');
                del.className = 'btn btn-danger btn-sm';
                del.textContent = 'Remove';
                del.addEventListener('click', async () => {
                    if (!confirm(`Remove the saved password for ${host}?`))
                        return;
                    await window.northstarPasswords.remove(entry.id);
                });
                const controls = document.createElement('div');
                controls.className = 'pw-controls';
                controls.appendChild(secret);
                controls.appendChild(reveal);
                controls.appendChild(del);
                row.appendChild(info);
                row.appendChild(controls);
                pwList.appendChild(row);
            }
        }
        window.northstarPasswords?.onChanged(() => refreshPasswords());
        refreshPasswords();
        // ── Extensions ─────────────────────────────────────────────────────────
        const extList = document.getElementById('ext-list');
        const extEmpty = document.getElementById('ext-empty');
        const extError = document.getElementById('ext-error');
        function extShowError(msg) {
            extError.textContent = msg || '';
            extError.classList.toggle('show', !!msg);
        }
        const extCount = document.getElementById('ext-count');
        async function refreshExtensions() {
            let items = [];
            try {
                items = await window.northstarExtensions.list();
            }
            catch (e) { window.northstarLog?.debug('settings', 'refreshExtensions: ' + e); }
            extList.innerHTML = '';
            extEmpty.style.display = items.length ? 'none' : 'block';
            if (extCount)
                extCount.textContent = items.length ? `(${items.length})` : '';
            for (const ext of items) {
                const row = document.createElement('div');
                row.className = 'ext-row' + (ext.enabled ? '' : ' disabled');
                const icon = document.createElement('div');
                icon.className = 'ext-icon';
                if (ext.icon) {
                    const img = document.createElement('img');
                    img.alt = '';
                    img.src = ext.icon;
                    img.onerror = () => { icon.textContent = (ext.name || '?').charAt(0).toUpperCase(); };
                    icon.appendChild(img);
                }
                else {
                    icon.textContent = (ext.name || '?').charAt(0).toUpperCase();
                }
                const info = document.createElement('div');
                info.className = 'ext-info';
                const name = document.createElement('div');
                name.className = 'ext-name';
                name.textContent = ext.name;
                const meta = document.createElement('div');
                meta.className = 'ext-meta';
                meta.textContent = (ext.version ? 'v' + ext.version : '') + (ext.enabled ? '' : ' · disabled');
                info.appendChild(name);
                if (ext.description) {
                    const desc = document.createElement('div');
                    desc.className = 'ext-desc';
                    desc.textContent = ext.description;
                    info.appendChild(desc);
                }
                info.appendChild(meta);
                const controls = document.createElement('div');
                controls.className = 'ext-controls';
                if (ext.optionsUrl) {
                    const optBtn = document.createElement('button');
                    optBtn.className = 'btn btn-sm';
                    optBtn.textContent = 'Options';
                    optBtn.disabled = !ext.enabled;
                    optBtn.addEventListener('click', () => window.northstarExtensions.openOptions(ext.id));
                    controls.appendChild(optBtn);
                }
                const toggle = document.createElement('label');
                toggle.className = 'toggle';
                toggle.title = ext.enabled ? 'Disable' : 'Enable';
                toggle.innerHTML = `<input type="checkbox" ${ext.enabled ? 'checked' : ''}><span class="switch-track"></span>`;
                toggle.querySelector('input').addEventListener('change', (e) => {
                    window.northstarExtensions.setEnabled(ext.id, e.target.checked);
                });
                controls.appendChild(toggle);
                const removeBtn = document.createElement('button');
                removeBtn.className = 'btn btn-danger btn-sm';
                removeBtn.textContent = 'Remove';
                removeBtn.addEventListener('click', async () => {
                    if (!confirm(`Remove "${ext.name}"?`))
                        return;
                    await window.northstarExtensions.remove(ext.id);
                });
                controls.appendChild(removeBtn);
                row.appendChild(icon);
                row.appendChild(info);
                row.appendChild(controls);
                extList.appendChild(row);
            }
        }
        // Disable the install controls while an install is running so a slow store
        // download can't be fired twice.
        const extInstallBtns = ['btn-ext-store', 'btn-ext-unpacked', 'btn-ext-crx', 'btn-ext-install-id']
            .map(id => document.getElementById(id)).filter(Boolean);
        function setExtBusy(busy) { extInstallBtns.forEach(b => { b.disabled = busy; }); }
        async function addExtension(mode) {
            extShowError('');
            setExtBusy(true);
            try {
                const res = await window.northstarExtensions.add(mode);
                if (res?.canceled)
                    return;
                if (res?.ok)
                    showToast(`Added "${res.name}"`);
                else
                    extShowError(res?.error || 'Failed to add extension');
            }
            catch (err) {
                extShowError(err.message || 'Failed to add extension');
            }
            finally {
                setExtBusy(false);
            }
        }
        document.getElementById('btn-ext-store')?.addEventListener('click', () => window.northstarExtensions.openStore());
        document.getElementById('btn-ext-unpacked')?.addEventListener('click', () => addExtension('unpacked'));
        document.getElementById('btn-ext-crx')?.addEventListener('click', () => addExtension('crx'));
        const idInput = document.getElementById('ext-id-input');
        const installIdBtn = document.getElementById('btn-ext-install-id');
        installIdBtn?.addEventListener('click', async () => {
            const val = (idInput.value || '').trim();
            if (!val)
                return;
            extShowError('');
            setExtBusy(true);
            const label = installIdBtn.textContent;
            installIdBtn.textContent = 'Installing…';
            try {
                const res = await window.northstarExtensions.installId(val);
                if (res?.ok) {
                    showToast(`Installed "${res.name}"`);
                    idInput.value = '';
                }
                else
                    extShowError(res?.error || 'Install failed');
            }
            catch (err) {
                extShowError(err.message || 'Install failed');
            }
            finally {
                setExtBusy(false);
                installIdBtn.textContent = label;
            }
        });
        idInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter')
            installIdBtn.click(); });
        window.northstarExtensions?.onChanged(() => refreshExtensions());
        refreshExtensions();
        // ── Data: import / export ─────────────────────────────────────────────
        const report = (res, verb, noun) => {
            if (!res || res.canceled)
                return;
            if (!res.ok) {
                showToast(res.error || `Could not ${verb} ${noun}`);
                return;
            }
            const n = res.added ?? res.count ?? 0;
            showToast(`${verb === 'import' ? 'Imported' : 'Exported'} ${n} ${noun}${n === 1 ? '' : 's'}`);
            if (res.path)
                window.userData.reveal(res.path);
        };
        document.getElementById('import-bookmarks')?.addEventListener('click', async () => {
            report(await window.userData.importBookmarks(), 'import', 'bookmark');
        });
        document.getElementById('export-bookmarks')?.addEventListener('click', async () => {
            report(await window.userData.exportBookmarks(), 'export', 'bookmark');
        });
        document.getElementById('import-passwords')?.addEventListener('click', async () => {
            report(await window.userData.importPasswords(), 'import', 'password');
        });
        document.getElementById('export-passwords')?.addEventListener('click', async () => {
            report(await window.userData.exportPasswords(), 'export', 'password');
        });
        document.getElementById('export-history')?.addEventListener('click', async () => {
            report(await window.userData.exportHistory(), 'export', 'history entry');
        });
        // ── Import from another browser (inline; was a popup window) ─────────
        // The browsers found on this computer as a radio list, what to bring
        // over as checkboxes, and the result in a status line. Each browser
        // shows its own app icon when the main process could read it, else a
        // neutral globe (never a bundled brand logo).
        (async () => {
            const api = window.northstarImport;
            const $ = (id) => document.getElementById(id);
            if (!api || !$('imp-card'))
                return;
            const GLOBE = '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M128,20A108,108,0,1,0,236,128,108.12,108.12,0,0,0,128,20Zm0,187a113.4,113.4,0,0,1-20.39-35h40.82a116.94,116.94,0,0,1-10,20.77A108.61,108.61,0,0,1,128,207Zm-26.49-59a135.42,135.42,0,0,1,0-40h53a135.42,135.42,0,0,1,0,40ZM44,128a83.49,83.49,0,0,1,2.43-20H77.25a160.63,160.63,0,0,0,0,40H46.43A83.49,83.49,0,0,1,44,128Zm84-79a113.4,113.4,0,0,1,20.39,35H107.59a116.94,116.94,0,0,1,10-20.77A108.61,108.61,0,0,1,128,49Zm50.73,59h30.82a83.52,83.52,0,0,1,0,40H178.75a160.63,160.63,0,0,0,0-40Zm20.77-24H173.71a140.82,140.82,0,0,0-15.5-34.36A84.51,84.51,0,0,1,199.52,84ZM97.79,49.64A140.82,140.82,0,0,0,82.29,84H56.48A84.51,84.51,0,0,1,97.79,49.64ZM56.48,172H82.29a140.82,140.82,0,0,0,15.5,34.36A84.51,84.51,0,0,1,56.48,172Zm101.73,34.36A140.82,140.82,0,0,0,173.71,172h25.81A84.51,84.51,0,0,1,158.21,206.36Z"/></svg>';
            let sources = [];
            let selected = null;
            const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
            const summary = (src) => {
                const parts = [];
                if (src.bookmarks) parts.push(plural(src.bookmarks, 'bookmark', 'bookmarks'));
                if (src.history) parts.push('history');
                if (src.engines) parts.push('search engines');
                return parts.join(' · ') || 'Nothing to import';
            };
            const types = [['bm', 'bookmarks'], ['hist', 'history'], ['eng', 'engines']];
            const updateRun = () => {
                $('imp-run').disabled = !selected || !types.some(([k]) => { const b = $('imp-t-' + k); return !b.disabled && b.checked; });
            };
            const select = (id) => {
                selected = sources.find(x => x.id === id) || null;
                for (const row of document.querySelectorAll('.imp-row')) {
                    const on = row.dataset.id === id;
                    row.classList.toggle('sel', on);
                    row.setAttribute('aria-checked', String(on));
                }
                $('imp-types').hidden = $('imp-actions').hidden = !selected;
                if (!selected) return;
                const avail = { bm: selected.bookmarks > 0, hist: !!selected.history, eng: !!selected.engines };
                for (const [k] of types) {
                    const box = $('imp-t-' + k);
                    box.disabled = !avail[k];
                    box.checked = avail[k];
                    box.closest('.imp-type').classList.toggle('disabled', !avail[k]);
                }
                $('imp-m-bm').textContent = selected.bookmarks ? String(selected.bookmarks) : 'none';
                $('imp-m-hist').textContent = selected.history ? '' : 'none';
                $('imp-m-eng').textContent = selected.engines ? '' : 'none';
                $('imp-status').textContent = '';
                updateRun();
            };
            for (const [k] of types) $('imp-t-' + k).addEventListener('change', updateRun);
            $('imp-run').addEventListener('click', async () => {
                if (!selected) return;
                const want = types.filter(([k]) => { const b = $('imp-t-' + k); return !b.disabled && b.checked; }).map(([, t]) => t);
                const btn = $('imp-run');
                btn.disabled = true;
                btn.textContent = 'Importing…';
                $('imp-status').textContent = '';
                let res = null;
                try { res = await api.run(selected.id, want); }
                catch (e) { window.northstarLog?.debug('settings', 'import run: ' + e); }
                btn.textContent = 'Import';
                updateRun();
                if (!res || !res.ok) {
                    $('imp-status').textContent = 'Could not read ' + selected.browser + '. Close it and try again.';
                    return;
                }
                const parts = [];
                if (typeof res.bookmarks === 'number') parts.push(plural(res.bookmarks, 'bookmark', 'bookmarks'));
                if (typeof res.history === 'number') parts.push(plural(res.history, 'history entry', 'history entries'));
                if (typeof res.engines === 'number' && res.engines) parts.push(plural(res.engines, 'search engine', 'search engines'));
                $('imp-status').textContent = parts.length ? 'Imported ' + parts.join(', ') + '.' : 'Nothing new to import.';
            });
            try { sources = (await api.sources()) || []; }
            catch (e) { window.northstarLog?.debug('settings', 'import sources: ' + e); }
            $('imp-loading').hidden = true;
            if (!sources.length) { $('imp-empty').hidden = false; return; }
            const list = $('imp-list');
            for (const src of sources) {
                const row = document.createElement('button');
                row.type = 'button';
                row.className = 'imp-row';
                row.setAttribute('role', 'radio');
                row.dataset.id = src.id;
                const icon = document.createElement('span');
                icon.className = 'imp-icon';
                if (src.icon && /^data:image\//.test(src.icon)) {
                    const img = document.createElement('img');
                    img.src = src.icon; img.alt = ''; img.width = 24; img.height = 24;
                    icon.appendChild(img);
                }
                else icon.innerHTML = GLOBE;
                const main = document.createElement('span');
                main.className = 'imp-main';
                const name = document.createElement('span');
                name.className = 'imp-name';
                name.textContent = src.browser + (src.profile ? ' · ' + src.profile : '');
                const meta = document.createElement('span');
                meta.className = 'imp-meta';
                meta.textContent = summary(src);
                main.append(name, meta);
                row.append(icon, main);
                row.addEventListener('click', () => select(src.id));
                list.appendChild(row);
            }
            select(sources[0].id);
        })();
        // How the saved-password key is protected — stated, not assumed.
        (async () => {
            const el = document.getElementById('key-protection');
            if (!el)
                return;
            try {
                const mode = await window.userData.keyProtection();
                if (mode === 'os-keychain') {
                    el.textContent = 'Saved passwords are encrypted with a key held in your operating system\u2019s secure store.';
                    el.classList.remove('notice', 'is-warn');
                }
                else if (mode === 'file') {
                    el.textContent = 'Your operating system\u2019s secure store is unavailable, so the encryption key is protected by file permissions only. Anyone with access to your user account could read saved passwords.';
                    el.classList.add('notice', 'is-warn'); // a warning notice, not red text
                }
                else {
                    el.textContent = 'The encryption key could not be read.';
                    el.classList.add('notice', 'is-warn'); // a warning notice, not red text
                }
            }
            catch {
                el.textContent = '';
            }
        })();
        // History retention
        const historyDays = document.getElementById('history-days');
        if (historyDays) {
            historyDays.value = String(settings.historyDays ?? 90);
            historyDays.addEventListener('change', async () => {
                await save('historyDays', parseInt(historyDays.value, 10) || 0);
                showToast('History retention updated');
            });
        }
        // Session restore fidelity
        const restoreHistoryToggle = document.getElementById('restore-tab-history');
        if (restoreHistoryToggle) {
            restoreHistoryToggle.checked = settings.restoreTabHistory !== false;
            restoreHistoryToggle.addEventListener('change', () => save('restoreTabHistory', restoreHistoryToggle.checked));
        }
        const restoreWindowsToggle = document.getElementById('restore-all-windows');
        if (restoreWindowsToggle) {
            restoreWindowsToggle.checked = settings.restoreAllWindows !== false;
            restoreWindowsToggle.addEventListener('change', () => save('restoreAllWindows', restoreWindowsToggle.checked));
        }
        // Per-site zoom
        const zoomList = document.getElementById('zoom-list');
        async function renderZoom() {
            if (!zoomList)
                return;
            const rows = await window.northstarZoom.list();
            zoomList.textContent = '';
            if (!rows.length) {
                const empty = document.createElement('div');
                empty.className = 'empty-note';
                empty.textContent = 'No sites zoomed yet.';
                zoomList.appendChild(empty);
                return;
            }
            for (const r of rows) {
                const row = document.createElement('div');
                row.className = 'zoom-row';
                const origin = document.createElement('span');
                origin.className = 'origin';
                origin.textContent = r.origin;
                const pct = document.createElement('span');
                pct.className = 'pct';
                pct.textContent = r.percent + '%';
                const del = document.createElement('button');
                del.className = 'del';
                del.innerHTML = '<svg width="12" height="12" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M208.49,191.51a12,12,0,0,1-17,17L128,145,64.49,208.49a12,12,0,0,1-17-17L111,128,47.51,64.49a12,12,0,0,1,17-17L128,111l63.51-63.52a12,12,0,0,1,17,17L145,128Z"/></svg>';
                del.title = `Reset zoom for ${r.origin}`;
                del.addEventListener('click', async () => {
                    await window.northstarZoom.clear(r.origin);
                    renderZoom();
                });
                row.append(origin, pct, del);
                zoomList.appendChild(row);
            }
        }
        document.getElementById('clear-zoom')?.addEventListener('click', async () => {
            await window.northstarZoom.clear(null);
            showToast('Site zoom reset');
            renderZoom();
        });
        document.getElementById('clear-cert')?.addEventListener('click', async () => {
            await window.userData.clearCertExceptions();
            showToast('Certificate exceptions forgotten');
        });
        document.getElementById('open-log')?.addEventListener('click', () => window.userData.openLog());
        renderZoom();
        // ── About: version + updates ──────────────────────────────────────────
        if (settings._version) {
            document.getElementById('about-version').textContent = 'Version ' + settings._version;
        }
        (async () => {
            const grid = document.getElementById('version-grid');
            if (!grid)
                return;
            try {
                const v = await window.userData.versions();
                // Front-and-centre: which build this actually is.
                const av = document.getElementById('about-version');
                if (av && (v.commit || v.mode)) {
                    const bits = ['Version ' + (v.app || settings._version || '')];
                    if (v.commit && v.commit !== 'unknown') bits.push(v.commit);
                    if (v.mode) bits.push(v.mode);
                    av.textContent = bits.join(' · ');
                }
                // Meaning, not data (ui-polish rule 4): readable labels and
                // values, and nothing said twice (a dev build has no build date).
                const OS = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
                const LABELS = {
                    app: ['Version'], commit: ['Commit'],
                    builtAt: ['Built', (x) => (x && x !== 'dev' ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(x)) : null)],
                    mode: ['Build', (x) => (x === 'dev' ? 'Development' : x ? x[0].toUpperCase() + x.slice(1) : null)],
                    electron: ['Electron'], chrome: ['Engine'], node: ['Node.js'],
                    platform: ['Platform', (x) => { const [os, arch] = String(x).split(' '); return (OS[os] || os) + (arch ? ' (' + arch + ')' : ''); }],
                };
                for (const [k, val] of Object.entries(v)) {
                    const [label, fmt] = LABELS[k] || [k];
                    let shown = val;
                    try { shown = fmt ? fmt(val) : val; }
                    catch (e) { window.northstarLog?.debug('settings', 'version label: ' + e); }
                    if (shown == null || shown === '' || shown === 'unknown')
                        continue;
                    const key = document.createElement('span');
                    key.className = 'k';
                    key.textContent = label;
                    const value = document.createElement('span');
                    value.className = 'v';
                    value.textContent = shown;
                    grid.append(key, value);
                }
            }
            catch (e) { window.northstarLog?.debug('settings', 'renderZoom: ' + e); }
        })();
        // ── About: updates (features/updates.js) ───────────────────────────
        // One renderer for every state, fed live by 'update-state'.
        const updateState = document.getElementById('update-state');
        const updateDetail = document.getElementById('update-detail');
        const checkBtn = document.getElementById('check-update');
        const installBtn = document.getElementById('install-update');
        const releaseBtn = document.getElementById('open-release');
        const progress = document.getElementById('update-progress');
        const progressBar = document.getElementById('update-progress-bar');
        const autoToggle = document.getElementById('auto-update');
        let releaseUrl = '';
        const DEFAULT_DETAIL = updateDetail?.textContent || '';
        function renderUpdate(s) {
            if (!s || !updateState) return;
            const show = (el, on) => el?.classList.toggle('hidden', !on);
            releaseUrl = s.url || '';
            show(installBtn, s.status === 'ready');
            show(releaseBtn, s.status === 'available' && !!releaseUrl);
            show(checkBtn, s.status !== 'ready');
            checkBtn.disabled = s.status === 'checking' || s.status === 'downloading';
            show(progress, s.status === 'downloading');
            if (progressBar) progressBar.style.transform = `scaleX(${(s.percent || 0) / 100})`;
            updateDetail.textContent = DEFAULT_DETAIL;
            switch (s.status) {
                case 'checking': updateState.textContent = 'Checking for updates…'; break;
                case 'current': updateState.textContent = `Northstar ${s.current} is up to date.`; break;
                case 'downloading': updateState.textContent = `Downloading Northstar ${s.latest}… ${s.percent || 0}%`; break;
                case 'ready':
                    updateState.textContent = `Northstar ${s.latest} is ready to install.`;
                    updateDetail.textContent = 'Relaunch now, or it installs the next time you quit. Your tabs come back.';
                    break;
                case 'available':
                    updateState.textContent = `Version ${s.latest} is available. You have ${s.current}.`;
                    updateDetail.textContent = 'This build cannot update itself. Download the new version from the release page.';
                    break;
                case 'error': updateState.textContent = s.error || 'Could not check for updates.'; break;
                default: updateState.textContent = `Version ${s.current}.`;
            }
            if (autoToggle) autoToggle.checked = s.auto !== false;
        }
        checkBtn?.addEventListener('click', async () => renderUpdate(await window.userData.checkUpdate(true)));
        installBtn?.addEventListener('click', () => window.userData.installUpdate());
        releaseBtn?.addEventListener('click', () => { if (releaseUrl) window.userData.openRelease(releaseUrl); });
        autoToggle?.addEventListener('change', async () => {
            await save('autoUpdate', autoToggle.checked);
            showToast(autoToggle.checked ? 'Northstar will update automatically' : 'Automatic updates are off');
        });
        window.userData.onUpdateState?.(renderUpdate);
        window.userData.updateState?.().then(renderUpdate).catch((e) => window.northstarLog?.debug('settings', 'update state: ' + e));
    });
})();
