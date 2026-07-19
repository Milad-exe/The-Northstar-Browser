"use strict";
// IIFE: compiled as a classic <script>; the wrapper keeps this page's
// top-level names out of the shared global scope.
(() => {
    const api = window.miniPlayerApi;
    const fmt = (s) => {
        s = Math.max(0, Math.floor(s || 0));
        const m = Math.floor(s / 60), sec = s % 60;
        return `${m}:${String(sec).padStart(2, '0')}`;
    };
    // Clone shared icon templates into every slot of a kind.
    const setIcon = (cls, tplId) => {
        const tpl = document.getElementById(tplId);
        document.querySelectorAll('.' + cls).forEach(el => {
            el.innerHTML = '';
            el.appendChild(tpl.content.cloneNode(true));
        });
    };
    setIcon('ic-toggle', 'tpl-pause');
    setIcon('ic-mute', 'tpl-vol');
    setIcon('ic-goto', 'tpl-goto');
    let last = { paused: false, muted: false };
    api.onState((s) => {
        last = s;
        const label = s.artist ? `${s.artist} — ${s.title}` : (s.title || 'Playing media…');
        document.getElementById('x-title').textContent = label;
        document.getElementById('x-el').textContent = fmt(s.cur);
        document.getElementById('x-rem').textContent = s.dur > 0 ? '-' + fmt(Math.max(0, s.dur - s.cur)) : '';
        document.getElementById('x-fill').style.width = s.dur > 0 ? `${Math.min(100, (s.cur / s.dur) * 100)}%` : '0%';
        const art = document.getElementById('x-art');
        if (s.art) {
            art.src = s.art;
            art.style.display = '';
        }
        else
            art.style.display = 'none';
        setIcon('ic-toggle', s.paused ? 'tpl-play' : 'tpl-pause');
        setIcon('ic-mute', s.muted ? 'tpl-muted' : 'tpl-vol');
        const vol = document.getElementById('x-vol');
        if (document.activeElement !== vol)
            vol.value = Math.round((s.vol ?? 1) * 100);
    });
    // ── Actions ────────────────────────────────────────────────────────────────
    const on = (id, fn) => document.getElementById(id).addEventListener('click', fn);
    on('x-toggle', () => api.action('toggle'));
    on('x-mute', () => api.action('mute'));
    on('x-goto', () => api.action('goto'));
    on('x-close', () => api.action('close'));
    // Seek: click position on the track = fraction of duration.
    document.getElementById('x-track').addEventListener('click', (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        if (r.width > 0)
            api.action('seek', (e.clientX - r.left) / r.width);
    });
    // Volume: throttle drags to ~6 updates/sec.
    let volTimer = null;
    document.getElementById('x-vol').addEventListener('input', (e) => {
        const v = Number(e.target.value) / 100;
        clearTimeout(volTimer);
        volTimer = setTimeout(() => api.action('volume', v), 150);
    });
})();
