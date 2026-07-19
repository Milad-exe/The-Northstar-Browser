"use strict";
// IIFE: compiled as a classic <script>; the wrapper keeps this page's
// top-level names out of the shared global scope.
(() => {
    (function () {
        'use strict';
        const root = document.documentElement;
        const PREFS_KEY = 'ink-reader-prefs';
        const FONT_SIZES = [16, 18, 20, 22, 24, 28, 32];
        const WIDTHS = { narrow: '34rem', medium: '42rem', wide: '52rem' };
        const prefs = Object.assign({ fontIndex: 2, face: 'sans', width: 'medium', theme: 'light' }, loadPrefs());
        function loadPrefs() {
            try {
                return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
            }
            catch {
                return {};
            }
        }
        function savePrefs() {
            try {
                localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
            }
            catch { }
        }
        function applyPrefs() {
            root.style.setProperty('--rd-font', FONT_SIZES[prefs.fontIndex] + 'px');
            root.style.setProperty('--rd-width', WIDTHS[prefs.width] || WIDTHS.medium);
            root.setAttribute('data-rd-face', prefs.face);
            root.setAttribute('data-rd-theme', prefs.theme);
            markActive('#rd-typeface', 'face', prefs.face);
            markActive('#rd-width', 'width', prefs.width);
            markActive('#rd-theme', 'theme', prefs.theme);
        }
        function markActive(groupSel, attr, value) {
            document.querySelectorAll(`${groupSel} .rd-seg`).forEach(b => {
                b.classList.toggle('active', b.dataset[attr] === value);
            });
        }
        // ── Controls ──────────────────────────────────────────────────────────────
        document.getElementById('rd-font-dec').addEventListener('click', () => {
            prefs.fontIndex = Math.max(0, prefs.fontIndex - 1);
            applyPrefs();
            savePrefs();
        });
        document.getElementById('rd-font-inc').addEventListener('click', () => {
            prefs.fontIndex = Math.min(FONT_SIZES.length - 1, prefs.fontIndex + 1);
            applyPrefs();
            savePrefs();
        });
        document.querySelectorAll('#rd-typeface .rd-seg').forEach(b => b.addEventListener('click', () => { prefs.face = b.dataset.face; applyPrefs(); savePrefs(); }));
        document.querySelectorAll('#rd-width .rd-seg').forEach(b => b.addEventListener('click', () => { prefs.width = b.dataset.width; applyPrefs(); savePrefs(); }));
        document.querySelectorAll('#rd-theme .rd-seg').forEach(b => b.addEventListener('click', () => { prefs.theme = b.dataset.theme; applyPrefs(); savePrefs(); }));
        document.getElementById('rd-close').addEventListener('click', () => window.northstarReader.exit());
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape')
            window.northstarReader.exit(); });
        // ── Load the article ──────────────────────────────────────────────────────
        applyPrefs();
        window.northstarReader.getArticle().then((article) => {
            if (!article || !article.ok) {
                document.getElementById('reader-content').classList.add('hidden');
                document.getElementById('rd-error').classList.remove('hidden');
                return;
            }
            document.title = article.title || 'Reader View';
            document.getElementById('rd-title').textContent = article.title || '';
            document.getElementById('rd-site').textContent = article.siteName || '';
            document.getElementById('rd-byline').textContent = article.byline || '';
            if (!article.byline)
                document.getElementById('rd-byline').remove();
            const clean = (typeof DOMPurify !== 'undefined')
                ? DOMPurify.sanitize(article.html, { ADD_ATTR: ['target'], FORBID_TAGS: ['style'] })
                : article.html;
            const art = document.getElementById('rd-article');
            art.setAttribute('dir', article.dir || 'ltr');
            art.innerHTML = clean;
        }).catch(() => {
            document.getElementById('reader-content').classList.add('hidden');
            document.getElementById('rd-error').classList.remove('hidden');
        });
    })();
})();
