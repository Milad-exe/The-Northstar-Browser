'use strict';

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

let enabled = true;
try {
    const { ipcRenderer } = require('electron');
    const settings = ipcRenderer.sendSync('settings-get-sync');
    enabled = settings?.adBlockEnabled !== false;

    // Live toggle — main process broadcasts when the setting changes.
    ipcRenderer.on('adblock-set-enabled', (_e, value) => {
        if (value) inject();
        else       remove();
    });
} catch {}

if (enabled) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', inject, { once: true });
    } else {
        inject();
    }
}
