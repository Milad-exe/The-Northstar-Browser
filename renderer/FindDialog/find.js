"use strict";
// IIFE: compiled as a classic <script>; the wrapper keeps this page's
// top-level names out of the shared global scope.
(() => {
    document.addEventListener('DOMContentLoaded', () => {
        const T = (key, fallback) => {
            try { const v = window.Northstar?.i18n?.t(key); return (v && v !== key) ? v : fallback; }
            catch (e) { return fallback; }
        };
        try {
            window.Northstar.i18n.init(window.northstarI18n?.getSync() || {});
            window.Northstar.i18n.apply(document);
        }
        catch (e) { window.northstarLog?.debug('find', 'i18n: ' + e); }
        const findInput = document.getElementById('find-input');
        const prevBtn = document.getElementById('prev-btn');
        const nextBtn = document.getElementById('next-btn');
        const closeBtn = document.getElementById('close-btn');
        const matchCounter = document.getElementById('match-counter');
        let currentMatchIndex = 0;
        let totalMatches = 0;
        let searchTimeout = null;
        let lastSearched = ''; // the term the current find session is for
        findInput.focus();
        findInput.addEventListener('input', (e) => {
            const searchTerm = e.target.value.trim();
            if (searchTimeout) {
                clearTimeout(searchTimeout);
            }
            if (searchTerm) {
                searchTimeout = setTimeout(() => {
                    searchTimeout = null;
                    lastSearched = searchTerm;
                    window.findAPI.search(searchTerm);
                }, 300);
            }
            else {
                lastSearched = '';
                window.findAPI.clearSearch();
                updateMatchCounter(0, 0);
            }
        });
        findInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (searchTimeout) {
                    clearTimeout(searchTimeout);
                    searchTimeout = null;
                }
                const searchTerm = findInput.value.trim();
                if (!searchTerm)
                    return;
                // A new (or still-debouncing) term starts its search, which
                // lands on the first match. The same term steps through the
                // matches — it used to restart the search on every Enter, so
                // the highlight jumped back to the start before stepping.
                if (searchTerm !== lastSearched) {
                    lastSearched = searchTerm;
                    window.findAPI.search(searchTerm);
                }
                else if (e.shiftKey) {
                    findPrevious();
                }
                else {
                    findNext();
                }
            }
            else if (e.key === 'Escape') {
                closeDialog();
            }
        });
        prevBtn.addEventListener('click', findPrevious);
        nextBtn.addEventListener('click', findNext);
        closeBtn.addEventListener('click', closeDialog);
        function findNext() {
            const searchTerm = findInput.value.trim();
            if (searchTerm) {
                window.findAPI.findNext();
            }
        }
        function findPrevious() {
            const searchTerm = findInput.value.trim();
            if (searchTerm) {
                window.findAPI.findPrevious();
            }
        }
        function closeDialog() {
            if (searchTimeout) {
                clearTimeout(searchTimeout);
                searchTimeout = null;
            }
            window.findAPI.close();
        }
        function updateMatchCounter(current, total) {
            currentMatchIndex = current;
            totalMatches = total;
            if (total === 0) {
                matchCounter.textContent = T('find.none', 'No matches');
                matchCounter.classList.add('none');
                prevBtn.disabled = true;
                nextBtn.disabled = true;
            }
            else {
                matchCounter.textContent = T('find.count', '{current} of {total}')
                    .replace('{current}', current).replace('{total}', total);
                matchCounter.classList.remove('none');
                prevBtn.disabled = false;
                nextBtn.disabled = false;
            }
        }
        if (window.findAPI) {
            window.findAPI.onMatchesUpdated((current, total) => {
                updateMatchCounter(current, total);
            });
        }
    });
})();
