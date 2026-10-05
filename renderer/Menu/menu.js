"use strict";
// IIFE: compiled as a classic <script>; the wrapper keeps this page's
// top-level names out of the shared global scope.
(() => {
    document.addEventListener('DOMContentLoaded', async () => {
        try {
            window.Northstar.i18n.init(window.northstarI18n?.getSync() || (window.northstarSettings?.getSync() || {}).i18n || {});
            window.Northstar.i18n.apply(document);
        }
        catch (e) { window.northstarLog?.debug('menu', 'i18n: ' + e); }
        const api = window.electronAPI;
        const mac = api.platform === 'darwin';
        // Shortcut hints in the ONE format every menu uses (U1-1):
        // renderer/lib/keys.js formatAccelerator — Ctrl+Shift+N / ⇧⌘N. The
        // markup's data-sc is the key after Cmd/Ctrl, with ⇧/⌥ for Shift/Alt.
        const fmt = (acc) => window.Northstar.keys.formatAccelerator(acc, mac ? 'darwin' : 'win32');
        const accOf = (sc) => 'CmdOrCtrl+' + String(sc).replace(/⇧/g, 'Shift+').replace(/⌥/g, 'Alt+');
        const close = async () => { try {
            await api.closeMenu();
        }
        catch (e) { window.northstarLog?.debug('menu', 'close: ' + e); } };
        const act = (fn) => async () => { try {
            await fn();
        }
        catch (e) { window.northstarLog?.debug('menu', 'act: ' + e); } await close(); };
        // Fill keyboard-shortcut hints (platform-aware).
        document.querySelectorAll('.sc[data-sc]').forEach(el => {
            el.textContent = fmt(accOf(el.dataset.sc));
        });
        const histSc = document.getElementById('sc-history');
        if (histSc)
            histSc.textContent = fmt(mac ? 'Cmd+Y' : 'Ctrl+H');
        const privTabSc = document.getElementById('sc-private-tab');
        if (privTabSc)
            privTabSc.textContent = fmt('CmdOrCtrl+Alt+T');
        // Reflect the bookmark-bar state as a checkmark.
        try {
            const settings = await api.getSettings();
            if (settings && settings.bookmarkBarVisible) {
                document.getElementById('bookmark-bar-check').classList.add('visible');
            }
        }
        catch (e) { window.northstarLog?.debug('menu', 'act: ' + e); }
        // ── Actions ────────────────────────────────────────────────────────────
        document.getElementById('btn-new-tab').addEventListener('click', act(() => api.addTab()));
        document.getElementById('btn-new-private-tab').addEventListener('click', act(() => api.addPrivateTab()));
        document.getElementById('btn-new-window').addEventListener('click', act(() => api.newWindow()));
        document.getElementById('btn-new-private').addEventListener('click', act(() => api.newPrivateWindow()));
        document.getElementById('btn-find').addEventListener('click', act(() => api.find()));
        document.getElementById('btn-save-page').addEventListener('click', act(() => api.savePage()));
        document.getElementById('btn-print').addEventListener('click', act(() => api.print()));
        document.getElementById('btn-history').addEventListener('click', act(() => api.openHistoryTab()));
        document.getElementById('btn-bookmarks').addEventListener('click', act(() => api.openBookmarksTab()));
        // Recently closed: the app menu hands over to a list menu at this row.
        document.getElementById('btn-recently-closed')?.addEventListener('click', async (e) => {
            const r = e.currentTarget.getBoundingClientRect();
            try { await api.openRecentlyClosed({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }); }
            catch (err) { window.northstarLog?.debug('menu', 'recently closed: ' + err); }
        });
        document.getElementById('btn-passwords').addEventListener('click', act(() => api.openSettingsTab('passwords')));
        document.getElementById('btn-extensions').addEventListener('click', act(() => api.openSettingsTab('extensions')));
        document.getElementById('btn-bookmark-bar').addEventListener('click', act(() => api.toggleBookmarkBar()));
        document.getElementById('btn-settings').addEventListener('click', act(() => api.openSettingsTab()));
        // ── Zoom (menu stays open so you can adjust repeatedly) ──────────────────
        const zoomLevel = document.getElementById('zoom-level');
        const setZoom = async (dir) => {
            try {
                const pct = await api.zoom(dir);
                if (typeof pct === 'number')
                    zoomLevel.textContent = pct + '%';
            }
            catch (e) { window.northstarLog?.debug('menu', 'setZoom: ' + e); }
        };
        document.getElementById('zoom-out').addEventListener('click', () => setZoom('out'));
        document.getElementById('zoom-in').addEventListener('click', () => setZoom('in'));
        document.getElementById('zoom-reset').addEventListener('click', () => setZoom('reset'));
        setZoom('get'); // reflect the active tab's current zoom
        // A menu you can only click is half a menu: arrows move, Enter runs,
        // Escape closes, and the first row is focused so the keyboard has
        // somewhere to start.
        document.querySelectorAll('.menu-row').forEach(r => r.setAttribute('role', 'menuitem'));
        // No focusFirst: a mouse-opened menu should not pre-highlight its first row.
        window.Northstar?.keys?.rows(document, { selector: '.menu-row, #zoom-reset', onEscape: close });
        // Tell main the card's real height so the overlay is sized to it and the
        // menu never scrolls. Measured after layout; re-measured if a webfont
        // reflows the rows.
        // Report the WHOLE document height (card + the body's own padding), not
        // just the card — sizing the overlay to only the card left the body's 4px
        // top/bottom padding overflowing the view, which showed as a scrollbar.
        // The menu must never scroll: it opens at its full height.
        // Measure the CARD, not documentElement.scrollHeight: html/body are
        // height:100% with overflow clipped, so scrollHeight only ever reported
        // the view's own (first-guess) height — a card taller than that stayed
        // clipped, its last row cut off (U1-3). Card bottom + the body's bottom
        // padding, rounded UP so fractional display scaling never shaves a pixel.
        const container = document.querySelector('.container');
        const reportHeight = () => {
            try {
                const padBottom = parseFloat(getComputedStyle(document.body).paddingBottom) || 0;
                api.reportHeight?.(Math.ceil(container.getBoundingClientRect().bottom + padBottom));
            }
            catch (e) { window.northstarLog?.debug('menu', 'reportHeight: ' + e); }
        };
        requestAnimationFrame(reportHeight);
        try { document.fonts?.ready?.then(reportHeight); } catch (e) { window.northstarLog?.debug('menu', 'fonts: ' + e); }
        // Rows added or relabelled later (a language change, extension items)
        // re-report too.
        try { new ResizeObserver(reportHeight).observe(container); } catch (e) { window.northstarLog?.debug('menu', 'ResizeObserver: ' + e); }
        // Left/Right work the zoom row from its single stop, the way a slider
        // row behaves in a native menu.
        document.getElementById('zoom-reset').addEventListener('keydown', (e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')
                return;
            e.preventDefault();
            e.stopPropagation();
            setZoom(e.key === 'ArrowLeft' ? 'out' : 'in');
        });
    });
})();
