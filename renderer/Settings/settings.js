document.addEventListener('DOMContentLoaded', async () => {
    // ── Load settings ──────────────────────────────────────────────────────
    let settings = {};
    try { settings = await window.inkSettings.get(); } catch {}

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
        try { await window.inkSettings.set(key, value); } catch {}
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

    // ── Appearance: Theme ──────────────────────────────────────────────────
    const themeSelect = document.getElementById('theme-select');
    themeSelect.value = settings.theme || 'default';

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
        try { window.inkSettings.toggleBookmarkBar(); } catch {}
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

    // ── Privacy: Ad blocking ──────────────────────────────────────────────
    const adblockToggle = document.getElementById('adblock-toggle');
    adblockToggle.checked = settings.adBlockEnabled !== false; // default on

    adblockToggle.addEventListener('change', async () => {
        await save('adBlockEnabled', adblockToggle.checked);
        showToast(adblockToggle.checked ? 'Ad blocking enabled' : 'Ad blocking disabled');
    });

    // ── Privacy: Clear history ─────────────────────────────────────────────
    document.getElementById('btn-clear-history').addEventListener('click', async () => {
        const confirmed = confirm('Clear all browsing history? This cannot be undone.');
        if (!confirmed) return;
        try {
            await window.inkSettings.clearHistory();
            showToast('Browsing history cleared');
        } catch {
            showToast('Failed to clear history');
        }
    });

    // ── About: version ────────────────────────────────────────────────────
    if (settings._version) {
        document.getElementById('about-version').textContent = 'Version ' + settings._version;
    }
});
