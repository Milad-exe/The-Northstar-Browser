document.addEventListener('DOMContentLoaded', async () => {
    // ── Load settings ──────────────────────────────────────────────────────
    let settings = {};
    try { settings = await window.northstarSettings.get(); } catch {}

    // ── Sidebar navigation ─────────────────────────────────────────────────
    const navItems = document.querySelectorAll('.nav-item');
    const sections = document.querySelectorAll('.section');

    // Restore last active section
    const savedSection = settings.settingsPage || 'general';
    const savedNavItem = document.querySelector(`.nav-item[data-section="${savedSection}"]`);
    if (savedNavItem) {
        navItems.forEach(n => n.classList.remove('active'));
        sections.forEach(s => s.classList.remove('active'));
        savedNavItem.classList.add('active');
        const savedSectionEl = document.getElementById('section-' + savedSection);
        if (savedSectionEl) savedSectionEl.classList.add('active');
    }

    navItems.forEach(item => {
        item.addEventListener('click', () => {
            navItems.forEach(n => n.classList.remove('active'));
            sections.forEach(s => s.classList.remove('active'));
            item.classList.add('active');
            document.getElementById('section-' + item.dataset.section).classList.add('active');
            save('settingsPage', item.dataset.section);
        });
    });

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
        try { await window.northstarSettings.set(key, value); } catch {}
    }

    // ── General: On startup ────────────────────────────────────────────────
    const startupRadios = document.querySelectorAll('input[name="startup"]');
    const startupVal = settings.persistAllTabs ? 'restore' : 'new-tab';
    startupRadios.forEach(r => { if (r.value === startupVal) r.checked = true; });

    startupRadios.forEach(r => {
        r.addEventListener('change', async () => {
            await save('persistAllTabs', r.value === 'restore');
        });
    });

    // ── General: Search engine ─────────────────────────────────────────────
    const searchEngineSelect = document.getElementById('search-engine');
    searchEngineSelect.value = settings.searchEngine || 'google';

    searchEngineSelect.addEventListener('change', async () => {
        await save('searchEngine', searchEngineSelect.value);
        showToast('Search engine updated');
    });

    // ── General: Performance (tab sleeping) ────────────────────────────────
    const tabSleepToggle = document.getElementById('tabsleep-toggle');
    const tabSleepMins   = document.getElementById('tabsleep-mins');
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

    // ── Appearance: Theme ──────────────────────────────────────────────────
    const themeSelect = document.getElementById('theme-select');
    themeSelect.value = settings.theme || 'default';
    // Migrate retired theme names (chalk/midnight/ember/mist/dusk/sage) → default.
    if (![...themeSelect.options].some(o => o.value === themeSelect.value)) {
        themeSelect.value = 'default';
        save('theme', 'default');
    }

    themeSelect.addEventListener('change', async () => {
        await save('theme', themeSelect.value);
        showToast('Theme updated');
    });

    // ── Appearance: Bookmark bar ───────────────────────────────────────────
    const bookmarkBarToggle = document.getElementById('bookmark-bar-toggle');

    // We track the saved state in settings; the bookmark bar actual visibility
    // is managed by the renderer — toggling fires the same IPC the menu uses.
    bookmarkBarToggle.checked = !!settings.bookmarkBarVisible;

    bookmarkBarToggle.addEventListener('change', async () => {
        await save('bookmarkBarVisible', bookmarkBarToggle.checked);
        try { window.northstarSettings.toggleBookmarkBar(); } catch {}
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
        'pom-work':     { key: 'pomWork',       min: 1, max: 120 },
        'pom-short':    { key: 'pomShortBreak', min: 1, max: 60  },
        'pom-long':     { key: 'pomLongBreak',  min: 1, max: 120 },
        'pom-sessions': { key: 'pomSessions',   min: 1, max: 10  },
    };

    for (const [id, { key, min, max }] of Object.entries(fields)) {
        const input = document.getElementById(id);
        input.value = settings[key] ?? input.min;

        input.addEventListener('change', async () => {
            let v = parseInt(input.value, 10);
            if (isNaN(v)) v = parseInt(input.min, 10);
            v = Math.max(min, Math.min(max, v));
            input.value = v;
            await save(key, v);
            showToast('Timer updated');
        });
    }

    // ── Privacy: Tracking protection ──────────────────────────────────────
    const privacyToggles = [
        { id: 'adblock-toggle',    key: 'adBlockEnabled',         label: 'Ad & tracker blocking' },
        { id: 'thirdparty-toggle', key: 'blockThirdPartyCookies', label: 'Third-party cookie blocking' },
        { id: 'https-toggle',      key: 'httpsUpgrade',           label: 'HTTPS upgrade' },
        { id: 'params-toggle',     key: 'stripTrackingParams',    label: 'Tracking-parameter stripping' },
        { id: 'signals-toggle',    key: 'privacySignals',         label: 'Do Not Track / GPC signals' },
        { id: 'referrer-toggle',   key: 'trimReferrer',           label: 'Referrer minimization' },
    ];
    privacyToggles.forEach(({ id, key, label }) => {
        const el = document.getElementById(id);
        if (!el) return;
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
        } catch {}
    }
    refreshPrivacyStats();
    setInterval(refreshPrivacyStats, 2000);

    // ── Privacy: Clear browsing data ───────────────────────────────────────
    document.getElementById('btn-clear-data')?.addEventListener('click', async () => {
        const types = {
            history:   document.getElementById('cbd-history').checked,
            cookies:   document.getElementById('cbd-cookies').checked,
            cache:     document.getElementById('cbd-cache').checked,
            downloads: document.getElementById('cbd-downloads').checked,
        };
        if (!Object.values(types).some(Boolean)) { showToast('Nothing selected'); return; }
        const range = document.getElementById('cbd-range').value;
        const rangeLabel = document.querySelector('#cbd-range option:checked')?.textContent || '';
        if (!confirm(`Clear the selected data (${rangeLabel})? This cannot be undone.`)) return;
        try {
            const res = await window.northstarSettings.clearBrowsingData({ range, types });
            showToast(res?.ok ? 'Browsing data cleared' : 'Failed to clear data');
        } catch {
            showToast('Failed to clear data');
        }
    });

    // ── Passwords ──────────────────────────────────────────────────────────
    const pwList  = document.getElementById('pw-list');
    const pwEmpty = document.getElementById('pw-empty');

    async function refreshPasswords() {
        let items = [];
        try { items = await window.northstarPasswords.list(); } catch {}
        pwList.innerHTML = '';
        if (pwEmpty) pwEmpty.style.display = items.length ? 'none' : 'block';

        for (const entry of items) {
            const row = document.createElement('div');
            row.className = 'pw-row';

            const info = document.createElement('div');
            info.className = 'pw-info';
            let host = entry.origin;
            try { host = new URL(entry.origin).host; } catch {}
            const site = document.createElement('div');
            site.className = 'pw-site'; site.textContent = host;
            const user = document.createElement('div');
            user.className = 'pw-user'; user.textContent = entry.username || '(no username)';
            info.appendChild(site); info.appendChild(user);

            const secret = document.createElement('input');
            secret.type = 'password'; secret.value = '••••••••'; secret.readOnly = true;
            secret.className = 'pw-secret';

            const reveal = document.createElement('button');
            reveal.className = 'btn btn-sm'; reveal.textContent = 'Show';
            let shown = false;
            reveal.addEventListener('click', async () => {
                shown = !shown;
                if (shown) {
                    const pw = await window.northstarPasswords.reveal(entry.id);
                    secret.type = 'text'; secret.value = pw || ''; reveal.textContent = 'Hide';
                } else {
                    secret.type = 'password'; secret.value = '••••••••'; reveal.textContent = 'Show';
                }
            });

            const del = document.createElement('button');
            del.className = 'btn-danger btn-sm'; del.textContent = 'Remove';
            del.addEventListener('click', async () => {
                if (!confirm(`Remove the saved password for ${host}?`)) return;
                await window.northstarPasswords.remove(entry.id);
            });

            const controls = document.createElement('div');
            controls.className = 'pw-controls';
            controls.appendChild(secret); controls.appendChild(reveal); controls.appendChild(del);
            row.appendChild(info); row.appendChild(controls);
            pwList.appendChild(row);
        }
    }
    window.northstarPasswords?.onChanged(() => refreshPasswords());
    refreshPasswords();

    // ── Extensions ─────────────────────────────────────────────────────────
    const extList  = document.getElementById('ext-list');
    const extEmpty = document.getElementById('ext-empty');
    const extError = document.getElementById('ext-error');

    function extShowError(msg) {
        extError.textContent = msg || '';
        extError.classList.toggle('show', !!msg);
    }

    const extCount = document.getElementById('ext-count');

    async function refreshExtensions() {
        let items = [];
        try { items = await window.northstarExtensions.list(); } catch {}
        extList.innerHTML = '';
        extEmpty.style.display = items.length ? 'none' : 'block';
        if (extCount) extCount.textContent = items.length ? `(${items.length})` : '';

        for (const ext of items) {
            const row = document.createElement('div');
            row.className = 'ext-row' + (ext.enabled ? '' : ' disabled');

            const icon = document.createElement('div');
            icon.className = 'ext-icon';
            if (ext.icon) {
                const img = document.createElement('img');
                img.src = ext.icon;
                img.onerror = () => { icon.textContent = (ext.name || '?').charAt(0).toUpperCase(); };
                icon.appendChild(img);
            } else {
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
            toggle.innerHTML = `<input type="checkbox" ${ext.enabled ? 'checked' : ''}><span class="track"></span>`;
            toggle.querySelector('input').addEventListener('change', (e) => {
                window.northstarExtensions.setEnabled(ext.id, e.target.checked);
            });
            controls.appendChild(toggle);

            const removeBtn = document.createElement('button');
            removeBtn.className = 'btn-danger btn-sm';
            removeBtn.textContent = 'Remove';
            removeBtn.addEventListener('click', async () => {
                if (!confirm(`Remove "${ext.name}"?`)) return;
                await window.northstarExtensions.remove(ext.id);
            });
            controls.appendChild(removeBtn);

            row.appendChild(icon); row.appendChild(info); row.appendChild(controls);
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
            if (res?.canceled) return;
            if (res?.ok) showToast(`Added "${res.name}"`);
            else extShowError(res?.error || 'Failed to add extension');
        } catch (err) {
            extShowError(err.message || 'Failed to add extension');
        } finally { setExtBusy(false); }
    }

    document.getElementById('btn-ext-store')?.addEventListener('click', () => window.northstarExtensions.openStore());
    document.getElementById('btn-ext-unpacked')?.addEventListener('click', () => addExtension('unpacked'));
    document.getElementById('btn-ext-crx')?.addEventListener('click', () => addExtension('crx'));

    const idInput = document.getElementById('ext-id-input');
    const installIdBtn = document.getElementById('btn-ext-install-id');
    installIdBtn?.addEventListener('click', async () => {
        const val = (idInput.value || '').trim();
        if (!val) return;
        extShowError('');
        setExtBusy(true);
        const label = installIdBtn.textContent;
        installIdBtn.textContent = 'Installing…';
        try {
            const res = await window.northstarExtensions.installId(val);
            if (res?.ok) { showToast(`Installed "${res.name}"`); idInput.value = ''; }
            else extShowError(res?.error || 'Install failed');
        } catch (err) { extShowError(err.message || 'Install failed'); }
        finally { setExtBusy(false); installIdBtn.textContent = label; }
    });
    idInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') installIdBtn.click(); });

    window.northstarExtensions?.onChanged(() => refreshExtensions());
    refreshExtensions();

    // ── About: version ────────────────────────────────────────────────────
    if (settings._version) {
        document.getElementById('about-version').textContent = 'Version ' + settings._version;
    }
});
