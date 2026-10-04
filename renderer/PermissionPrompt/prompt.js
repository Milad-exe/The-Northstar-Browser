"use strict";
// IIFE: compiled as a classic <script>; the wrapper keeps this page's
// top-level names out of the shared global scope.
(() => {
    (function () {
        // Glyphs live in renderer/lib/permission-icons.js (shared with the chip).
        const ICONS = window.Northstar.permissionIcons;
        const iconEl = document.getElementById('icon');
        const qEl = document.getElementById('q');
        const hostEl = document.getElementById('host');
        const rememberRow = document.getElementById('remember-row');
        const rememberEl = document.getElementById('remember');
        const allowBtn = document.getElementById('allow');
        const blockBtn = document.getElementById('block');
        let current = null;
        function hostOf(origin) {
            try {
                return new URL(origin).host;
            }
            catch {
                return origin || 'This site';
            }
        }
        function reportHeight() {
            requestAnimationFrame(() => {
                /* Report the CARD's height only. The view is grown around it by
                   features/overlay-bounds.js (the shadow gutter) and this page
                   pads to match, so adding the padding here counted it twice. */
                const h = document.getElementById('card').getBoundingClientRect().height;
                try {
                    window.permissionUI.resize(h);
                }
                catch (e) { window.northstarLog?.debug('prompt', 'reportHeight: ' + e); }
            });
        }
        function render(data) {
            current = data;
            iconEl.innerHTML = ICONS[data.iconType] || ICONS.generic;
            // Callers may override the question + button labels (e.g. the isolate
            // doorhanger). Default to the permission "Allow this site to X?" form.
            qEl.textContent = data.title || `Allow this site to ${data.action}?`;
            allowBtn.textContent = data.allowLabel || 'Allow';
            blockBtn.textContent = data.blockLabel || 'Block';
            hostEl.textContent = hostOf(data.origin);
            // The "Remember" checkbox is meaningless in private tabs (nothing persists)
            // and for ask-every-time permissions — hide it there.
            if (data.checkbox === false)
                rememberRow.style.display = 'none';
            else {
                rememberRow.style.display = '';
                rememberEl.checked = true;
            }
            reportHeight();
        }
        // dismissed=true (Esc / click-away) denies this request without recording a
        // decision — the site may ask again. Allow/Block are explicit and stick.
        function decide(allowed, dismissed = false) {
            if (!current)
                return;
            const remember = !dismissed && rememberRow.style.display !== 'none' && rememberEl.checked;
            const id = current.id;
            current = null;
            try {
                window.permissionUI.decide(id, allowed, remember, dismissed);
            }
            catch (e) { window.northstarLog?.debug('prompt', 'decide: ' + e); }
        }
        allowBtn.addEventListener('click', () => decide(true));
        blockBtn.addEventListener('click', () => decide(false));
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape')
                decide(false, true);
            if (e.key === 'Enter')
                decide(true);
        });
        window.permissionUI.onData(render);
    })();
})();
