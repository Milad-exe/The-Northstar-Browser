/**
 * chrome-spoof.js
 * Injected to remove navigator.webdriver. 
 * Since we are now spoofing Firefox globally to bypass Google blocks, 
 * we intentionally do NOT inject window.chrome or Chrome-specific navigator properties,
 * as Google will detect the mismatch between Firefox UA and Chrome objects.
 */

(function () {
    'use strict';

<<<<<<< Updated upstream
    // Build the main-world injection as a string so it executes there
=======
    // Extension pages (background, popup, options) need the real window.chrome API.
    // Only spoof on regular web content pages.
    if (typeof location !== 'undefined' && location.protocol === 'chrome-extension:') return;

>>>>>>> Stashed changes
    const mainWorldScript = `(function () {
  'use strict';

  // ── 1. Remove webdriver flag ───────────────────────────────────────────
  try {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
      configurable: true
    });
  } catch (_) {}

})();`;

    // Append a <script> to document.documentElement 
    try {
        const s = document.createElement('script');
        s.textContent = mainWorldScript;
        document.documentElement.appendChild(s);
        s.remove();
    } catch (_) {}
})();
