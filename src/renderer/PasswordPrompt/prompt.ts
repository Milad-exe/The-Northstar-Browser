// IIFE: compiled as a classic <script>; the wrapper keeps this page's
// top-level names out of the shared global scope.
(() => {
(function () {
    'use strict';
    const siteEl = document.getElementById('site');
    const userEl = document.getElementById('user');

    window.pwPrompt.onData((d) => {
        if (!d) return;
        let host = d.origin;
        try { host = new URL(d.origin).host; } catch {}
        siteEl.textContent = host;
        userEl.textContent = d.username || '(no username)';
    });

    document.getElementById('save').addEventListener('click', () => window.pwPrompt.save());
    document.getElementById('never').addEventListener('click', () => window.pwPrompt.never());
    document.getElementById('close').addEventListener('click', () => window.pwPrompt.close());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.pwPrompt.close(); });
})();
})();
