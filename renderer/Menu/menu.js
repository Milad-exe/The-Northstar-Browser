document.addEventListener('DOMContentLoaded', async () => {
    const api = window.electronAPI;
    const mac = api.platform === 'darwin';
    const MOD = mac ? '⌘' : 'Ctrl ';

    const close = async () => { try { await api.closeMenu(); } catch {} };
    const act = (fn) => async () => { try { await fn(); } catch {} await close(); };

    // Fill keyboard-shortcut hints (platform-aware).
    document.querySelectorAll('.sc[data-sc]').forEach(el => {
        el.textContent = MOD + el.dataset.sc;
    });
    const histSc = document.getElementById('sc-history');
    if (histSc) histSc.textContent = mac ? '⌘Y' : 'Ctrl H';
    const privTabSc = document.getElementById('sc-private-tab');
    if (privTabSc) privTabSc.textContent = mac ? '⌘⌥T' : 'Ctrl Alt T';

    // Reflect the bookmark-bar state as a checkmark.
    try {
        const settings = await api.getSettings();
        if (settings && settings.bookmarkBarVisible) {
            document.getElementById('bookmark-bar-check').classList.add('visible');
        }
    } catch {}

    // ── Actions ────────────────────────────────────────────────────────────
    document.getElementById('btn-new-tab').addEventListener('click', act(() => api.addTab()));
    document.getElementById('btn-new-private-tab').addEventListener('click', act(() => api.addPrivateTab()));
    document.getElementById('btn-new-window').addEventListener('click', act(() => api.newWindow()));
    document.getElementById('btn-new-private').addEventListener('click', act(() => api.newPrivateWindow()));
    document.getElementById('btn-find').addEventListener('click', act(() => api.find()));
    document.getElementById('btn-print').addEventListener('click', act(() => api.print()));
    document.getElementById('btn-history').addEventListener('click', act(() => api.openHistoryTab()));
    document.getElementById('btn-bookmarks').addEventListener('click', act(() => api.openBookmarksTab()));
    document.getElementById('btn-bookmark-bar').addEventListener('click', act(() => api.toggleBookmarkBar()));
    document.getElementById('btn-settings').addEventListener('click', act(() => api.openSettingsTab()));

    // ── Zoom (menu stays open so you can adjust repeatedly) ──────────────────
    const zoomLevel = document.getElementById('zoom-level');
    const setZoom = async (dir) => {
        try { const pct = await api.zoom(dir); if (typeof pct === 'number') zoomLevel.textContent = pct + '%'; } catch {}
    };
    document.getElementById('zoom-out').addEventListener('click', () => setZoom('out'));
    document.getElementById('zoom-in').addEventListener('click', () => setZoom('in'));
    document.getElementById('zoom-reset').addEventListener('click', () => setZoom('reset'));
    setZoom('get'); // reflect the active tab's current zoom
});
