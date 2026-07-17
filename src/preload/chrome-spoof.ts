/**
 * chrome-spoof.js
 *
 * Registered via session.registerPreloadScript({ type: 'frame' }) so it runs
 * in every frame's ISOLATED world before page scripts execute. We inject a
 * <script> tag to patch the MAIN world.
 *
 * UA strategy: we present as Chrome in HTTP headers (user-agent.js) because
 * the engine really is Chromium. The JS environment must therefore look like
 * real Chrome, not like Electron:
 *  - navigator.userAgentData → must report Chrome brands (Electron reports
 *    only "Chromium", which Cloudflare/Google treat as a headless signal)
 *  - window.chrome           → must exist with the usual surface (runtime, etc.)
 *  - navigator.plugins       → must be non-empty (empty list = automation signal)
 *  - process                 → must not leak Electron/Node into the page world
 *
 * navigator.webdriver is intentionally left alone: with the
 * `disable-blink-features=AutomationControlled` switch it is already `false`,
 * exactly like real Chrome. Redefining it is itself detectable.
 */

(function () {
    'use strict';

    // Spoof WEB pages only. In chrome-extension:// frames (popups, options
    // pages) and our own file:// UI, Chromium's real extension bindings must
    // install chrome.* themselves — spoofing there makes the native bindings
    // system fail with "Failed to create API on Chrome object".
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    // The Chrome Web Store gets REAL native webstore bindings from Chromium —
    // replacing window.chrome there breaks them the same way.
    if (location.hostname === 'chromewebstore.google.com' ||
        location.hostname === 'chrome.google.com') return;

    const CHROME_MAJOR = (process.versions.chrome || '140.0.0.0').split('.')[0];
    const CHROME_FULL  = `${CHROME_MAJOR}.0.0.0`;

    const uaPlatform = ({
        darwin: 'macOS',
        win32:  'Windows',
    })[process.platform] || 'Linux';

    const uaArch = process.arch === 'arm64' ? 'arm' : 'x86';

    const mainWorldScript = `(function () {
  'use strict';

  // ── 1. navigator.userAgentData → Chrome brands ────────────────────────────
  // Electron's brand list lacks "Google Chrome"; sites cross-check it against
  // the UA string. Present the same brands real Chrome sends.
  try {
    const brands = [
      { brand: 'Chromium',      version: '${CHROME_MAJOR}' },
      { brand: 'Google Chrome', version: '${CHROME_MAJOR}' },
      { brand: 'Not=A?Brand',   version: '24' },
    ];
    const fullVersionList = brands.map(b => ({
      brand: b.brand,
      version: b.brand === 'Not=A?Brand' ? '24.0.0.0' : '${CHROME_FULL}',
    }));
    const uaData = {
      brands,
      mobile: false,
      platform: '${uaPlatform}',
      getHighEntropyValues(hints) {
        const all = {
          architecture:    '${uaArch}',
          bitness:         '64',
          brands,
          fullVersionList,
          mobile:          false,
          model:           '',
          platform:        '${uaPlatform}',
          platformVersion: '${uaPlatform === 'Windows' ? '15.0.0' : '13.0.0'}',
          uaFullVersion:   '${CHROME_FULL}',
          wow64:           false,
        };
        const out = { brands, mobile: false, platform: '${uaPlatform}' };
        (hints || []).forEach(h => { if (h in all) out[h] = all[h]; });
        return Promise.resolve(out);
      },
      toJSON() { return { brands, mobile: false, platform: '${uaPlatform}' }; },
    };
    Object.defineProperty(navigator, 'userAgentData', {
      get: () => uaData,
      configurable: true,
      enumerable: false,
    });
  } catch (_) {}

  // ── 2. window.chrome — must exist like in real Chrome ─────────────────────
  try {
    if (!window.chrome || !window.chrome.runtime) {
      const existing = window.chrome || {};
      const chromeObj = Object.assign({}, existing, {
        app: existing.app || {
          isInstalled: false,
          InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
          RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        },
        runtime: existing.runtime || {},
      });
      Object.defineProperty(window, 'chrome', {
        get: () => chromeObj,
        configurable: true,
        enumerable: true,
      });
    }
  } catch (_) {}

  // ── 3. navigator.plugins — non-empty list ─────────────────────────────────
  // An empty plugins list is a well-known automation/headless signal.
  // Chrome ships its internal PDF viewer plugins, so we mimic that.
  try {
    if (!navigator.plugins || navigator.plugins.length === 0) {
      const plugins = [
        { name: 'PDF Viewer',        filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
        { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
      ];
      Object.defineProperty(navigator, 'plugins', {
        get: () => Object.assign(plugins, {
          item:      (i)    => plugins[i] || null,
          namedItem: (name) => plugins.find(p => p.name === name) || null,
          refresh:   ()     => {},
        }),
        configurable: true,
        enumerable: true,
      });
    }
  } catch (_) {}

  // ── 4. Mask process.versions.electron ─────────────────────────────────────
  try {
    if (typeof process !== 'undefined' && process.versions && process.versions.electron) {
      Object.defineProperty(window, 'process', {
        get: () => undefined,
        configurable: false,
        enumerable: false,
      });
    }
  } catch (_) {}

})();`;

    // webFrame.executeJavaScript runs in the MAIN world and is not subject to
    // the page's CSP — strict sites (Google, Cloudflare) block inline <script>
    // tags, which would silently skip the patch exactly where it matters.
    let injected = false;
    try {
        const { webFrame } = require('electron');
        if (webFrame && typeof webFrame.executeJavaScript === 'function') {
            webFrame.executeJavaScript(mainWorldScript);
            injected = true;
        }
    } catch (_) {}

    if (!injected) {
        try {
            const s = document.createElement('script');
            s.textContent = mainWorldScript;
            (document.head || document.documentElement).appendChild(s);
            s.remove();
        } catch (_) {}
    }
})();
