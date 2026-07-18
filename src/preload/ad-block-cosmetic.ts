'use strict';

// Wrapped in an IIFE so the early return below is valid in a module-less script.
(() => {

// Skip our own renderer pages.
if (location.protocol === 'file:') return;

const SELECTORS = [
    'ins.adsbygoogle', '.adsbygoogle', '[data-ad-client]', '[data-ad-slot]', '[data-ad-format]',
    '[id^="div-gpt-ad"]', '[id*="google_ads_iframe"]', '.GoogleActiveViewElement',
    '[id^="taboola-"]', '[class*="taboola"]', '.trc_related_container',
    '.OUTBRAIN', '[id^="outbrain"]', '[class*="ob-widget"]',
    '[id="ad"]', '[id="ads"]', '[id="advertisement"]', '[id="ad-container"]',
    '[id="ad-banner"]', '[id="ad-wrapper"]', '[id="ad-slot"]', '[id="ad-unit"]',
    '[id="ad-top"]', '[id="ad-bottom"]', '[id="ad-sidebar"]',
    '[class~="advertisement"]', '[class~="ad-container"]', '[class~="ad-wrapper"]',
    '[class~="ad-banner"]', '[class~="ad-slot"]', '[class~="ad-unit"]',
    '[class~="ad-block"]', '[class~="ad-sidebar"]', '[class~="ad-leaderboard"]',
    '[class~="ad-box"]', '[class~="sponsored-content"]', '[class~="sponsored-widget"]',
    '[data-google-query-id]', '[data-ad-comet-preview]',
    '[aria-label="Sponsored"]', '[data-testid="promoted"]',
    '[id^="amzn_assoc"]',
].join(',');

const CSS = SELECTORS + ' { display: none !important; visibility: hidden !important; }';

function inject() {
    if (document.getElementById('__ink-adblock')) return;
    const s = document.createElement('style');
    s.id = '__ink-adblock';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
}

function remove() {
    document.getElementById('__ink-adblock')?.remove();
}

// ── Check setting at page load ────────────────────────────────────────────────
// Optimistic: inject immediately (blocking is on by default), then confirm with
// ONE async round trip and undo if the user disabled blocking or shielded this
// site. The old version made two SYNC IPC calls here — every frame of every
// page blocked its document-start on main-process round trips.

try {
    const { ipcRenderer } = require('electron');

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', inject, { once: true });
    } else {
        inject();
    }

    ipcRenderer.invoke('cosmetic-filter-state', location.hostname)
        .then((on) => { if (on === false) remove(); })
        .catch(() => {});

    // Live toggle — main process broadcasts when the setting changes.
    ipcRenderer.on('adblock-set-enabled', (_e, value) => {
        if (value) inject();
        else       remove();
    });
} catch {}
})();
