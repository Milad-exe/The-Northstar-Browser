const os = require('os');
/**
 * User agent strategy.
 *
 * Northstar runs on Chromium (Electron), so we present as Chrome — matching the
 * engine that sites actually observe. Spoofing Firefox here breaks Cloudflare
 * Turnstile, Google sign-in and YouTube playback: those services compare the
 * UA string against JS/TLS/client-hint fingerprints and a "Firefox" UA on a
 * Chromium engine reads as a bot.
 *
 * The Chrome version is derived from the bundled Chromium
 * (process.versions.chrome) so it stays truthful across Electron upgrades.
 * Only the Electron/app tokens are removed from the default UA.
 */
const CHROME_MAJOR = (process.versions.chrome || '140.0.0.0').split('.')[0];
const CHROME_VERSION = `${CHROME_MAJOR}.0.0.0`; // Chrome reports zeroed minor versions in its UA
class UserAgent {
    static generate() {
        return `Mozilla/5.0 (${platformString()}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`;
    }
    static chromeMajor() { return CHROME_MAJOR; }
    /**
     * Set the UA on a single tab.
     * All header interception is handled once at the session level via setupSession().
     */
    static setupTab(tab) {
        tab.webContents.setUserAgent(this.generate());
    }
    /**
     * Rewrite (never strip) Chromium client-hint headers so they match the
     * Chrome UA. Chromium sends "Chromium" only; real Chrome also sends a
     * "Google Chrome" brand. Stripping them entirely is a Firefox signal that
     * contradicts the engine and trips Cloudflare.
     */
    static applyClientHintHeaders(headers) {
        for (const key of Object.keys(headers)) {
            const k = key.toLowerCase();
            if (k === 'sec-ch-ua') {
                headers[key] = `"Chromium";v="${CHROME_MAJOR}", "Google Chrome";v="${CHROME_MAJOR}", "Not=A?Brand";v="24"`;
            }
            else if (k === 'sec-ch-ua-platform') {
                headers[key] = secChUaPlatform();
            }
            else if (k === 'sec-ch-ua-mobile') {
                headers[key] = '?0';
            }
        }
    }
    /**
     * Call ONCE in app.whenReady(), before any window is created.
     */
    static setupSession(session) {
        session.setUserAgent(this.generate());
        session.webRequest.onBeforeSendHeaders((details, callback) => {
            const headers = { ...details.requestHeaders };
            UserAgent.applyClientHintHeaders(headers);
            // Normalize language on top-level navigations only. (No DNT header:
            // Chrome doesn't send one by default, and it's a fingerprint signal
            // that contradicts the Chrome UA.)
            if (details.resourceType === 'mainFrame') {
                headers['Accept-Language'] = 'en-US,en;q=0.9';
            }
            callback({ requestHeaders: headers });
        });
    }
    static getPlatformInfo() {
        return { platform: os.platform(), arch: os.arch(), release: os.release(), type: os.type() };
    }
}
// ── Helpers ──────────────────────────────────────────────────────────────────
function platformString() {
    switch (os.platform()) {
        // Chrome freezes the macOS version at 10_15_7 in its UA
        case 'darwin': return 'Macintosh; Intel Mac OS X 10_15_7';
        case 'win32': return 'Windows NT 10.0; Win64; x64';
        case 'linux': return os.arch() === 'arm64' ? 'X11; Linux aarch64' : 'X11; Linux x86_64';
        default: return 'X11; Linux x86_64';
    }
}
function secChUaPlatform() {
    switch (os.platform()) {
        case 'darwin': return '"macOS"';
        case 'win32': return '"Windows"';
        default: return '"Linux"';
    }
}

module.exports = UserAgent;