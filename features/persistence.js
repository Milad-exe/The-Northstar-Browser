const log = require('./log');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { encrypt, decrypt, isEncrypted } = require('./encryption');
const DEFAULTS = {
    theme: 'default',
    // User-made themes: [{ id: 'custom:…', name, seed: { mode, base, accent, ink? } }].
    // Seeds, not token sets — features/theme-derive.js turns three decisions
    // into the sixteen tokens, so a stored theme cannot have its elevation
    // upside down or its body text unreadable.
    customThemes: [],
    persistAllTabs: false,
    searchEngine: 'google', // 'google' | 'duckduckgo' | 'bing'
    bookmarkBarVisible: false,
    blockShortform: false,
    adBlockEnabled: true,
    // Privacy / tracking protection (default to maximum protection)
    blockThirdPartyCookies: true,
    httpsUpgrade: true,
    stripTrackingParams: true,
    privacySignals: true,
    trimReferrer: true,
    // Performance: discard renderer processes of long-inactive background tabs
    tabSleepEnabled: true,
    // Spell check for every session (features/spellcheck.js). languages: []
    // means automatic — the OS locale plus English.
    spellcheck: { enabled: true, languages: [] },
    tabSleepMinutes: 30,
    // Mini player overlay for media playing in a background tab
    miniPlayerEnabled: true,
    // An Essential stays on its site: a link leaving it opens as a glance over
    // it rather than navigating it away (a preview floats over the pin instead of navigating it).
    essentialsPeek: true,
    /* Notices the user has said no to, by id. A browser-level notice (be the
       default browser, sign in to this network) must never come back once it
       has been answered — that is the whole difference between a notice and a
       nag. */
    dismissedNotices: [],
    // The first-run card shows once, on a profile that has never had a tab.
    seenWelcome: false,
    // The "import from another browser" wizard is offered once, on first launch.
    importPrompted: false,
    settingsPage: 'general',
    windowBounds: null,
    windowState: null,
    pomWork: 25, // minutes
    pomShortBreak: 5,
    pomLongBreak: 15,
    pomSessions: 4,
    // Toolbar customization: which utility-bar buttons are visible (missing key = shown)
    utilityBar: {},
    // Extension pinning: extension id → false when unpinned from the toolbar
    extPinned: {},
    // One-time hint shown the first time a tab runs in an isolated session
    isolationHintSeen: false,
    // Tab strip placement: 'side' (left sidebar, default) or 'top'
    tabBarSide: 'side',
    // Width of the left tab sidebar (px), drag-resizable.
    sidebarWidth: 256, // Tabs.SIDEBAR_W
    // History retention: age window in days (0 = only the entry cap applies)
    // and a hard ceiling on entries.
    historyDays: 90,
    historyMaxEntries: 50000,
    // Per-origin zoom levels ({ 'https://example.com': 0.5 }) — see features/zoom.js.
    siteZoom: {},
    // User-defined search engines: [{ id, name, keyword, url, suggest }] where
    // `url` contains %s. The built-ins (google/duckduckgo/bing) stay implicit.
    customEngines: [],
    // Session restore fidelity: per-tab back/forward entries + scroll position.
    restoreTabHistory: true,
    // Every window's tabs come back, not just the first window's.
    restoreAllWindows: true,
    // Interface language: 'system' follows the OS, otherwise a locale id from
    // locales/*.json. Web pages are unaffected (Accept-Language is not touched).
    language: 'system',
    // The new-tab page (renderer/NewTab): which sections show (both off = the
    // minimal, field-only page), the user's own shortcut tiles
    // [{ url, title }], and the urls of tiles they removed with ×.
    newTabPage: { shortcuts: true, recent: true, tiles: [], hidden: [] },
};
class Persistence {
    dir; // ~/<userData>/northstar
    settingsPath;
    statePath;
    settings;
    _pendingState; // tab state waiting for the debounced save
    _savingState;
    _quitHooked;
    constructor() {
        const userDir = app.getPath('userData');
        this.dir = path.join(userDir, 'northstar');
        this.statePath = path.join(this.dir, 'tabs-state.json');
        this.settingsPath = path.join(this.dir, 'settings.json');
        this.ensureDir();
        this.settings = this.loadSettings();
    }
    ensureDir() {
        try {
            if (!fs.existsSync(this.dir))
                fs.mkdirSync(this.dir, { recursive: true });
        }
        catch (e) { log.error('persistence', 'profile directory could not be created', e); }
    }
    // ── Encrypted read / write helpers (sync, for startup path) ──────────────
    readEncrypted(filePath) {
        const raw = fs.readFileSync(filePath, 'utf-8');
        if (isEncrypted(raw))
            return decrypt(raw);
        // Legacy plaintext — return as-is; will be re-saved encrypted on next write
        return raw;
    }
    writeEncrypted(filePath, data) {
        fs.writeFileSync(filePath, encrypt(JSON.stringify(data, null, 2)));
    }
    // ── Settings ──────────────────────────────────────────────────────────────
    /**
     * Load settings from disk. Distinguishes THREE cases:
     *  - no file (fresh profile): defaults, and it's safe to write them.
     *  - file present + decrypts: the real settings.
     *  - file present but UNREADABLE (the OS secure store is briefly unavailable
     *    at startup, so the key can't be unwrapped): defaults IN MEMORY, but
     *    `_loadFailed` is set so we never overwrite the good file with them. A
     *    later read/write retries the decrypt once the store is up (_reloadIfFailed).
     * The last case is why the window position (and other settings) used to reset:
     * defaults were written straight over the real file on the next save.
     */
    loadSettings() {
        this._loadFailed = false;
        try {
            if (fs.existsSync(this.settingsPath)) {
                const plaintext = this.readEncrypted(this.settingsPath);
                const obj = JSON.parse(plaintext);
                return { ...DEFAULTS, ...obj };
            }
        }
        catch (e) {
            // The file exists but could not be read/decrypted — do NOT let defaults
            // be persisted over it.
            this._loadFailed = true;
            // Before app 'ready' the OS secure store isn't up yet, so a failure
            // here is EXPECTED and self-heals on the first post-ready access
            // (_reloadIfFailed) — settings load a moment later and are never
            // clobbered. Only make noise if it is STILL failing after ready, which
            // would be a real "secure store unavailable" situation.
            let ready = false;
            try { ready = app.isReady(); } catch (e2) { /* app not ready */ }
            if (ready)
                log.warn('persistence', 'settings unreadable (secure store unavailable) — keeping the file, retrying later', e);
            else
                log.debug('persistence', 'settings not yet readable (secure store not up pre-launch); will retry after ready', e);
        }
        return { ...DEFAULTS };
    }
    /** Retry a failed decrypt (the secure store may be available now). Returns
     *  true once the real settings are in hand. */
    _reloadIfFailed() {
        if (!this._loadFailed)
            return true;
        try {
            if (fs.existsSync(this.settingsPath)) {
                const obj = JSON.parse(this.readEncrypted(this.settingsPath));
                this.settings = { ...DEFAULTS, ...obj };
                this._loadFailed = false;
                return true;
            }
            // File vanished — treat as fresh.
            this._loadFailed = false;
            return true;
        }
        catch (e) {
            log.debug('persistence', '_reloadIfFailed still failing', e);
            return false;
        }
    }
    save() {
        // Never overwrite a settings file we could not read: that is exactly how a
        // transient decrypt failure at startup turned into permanent data loss
        // (defaults written over the real settings). Skip until the reload works.
        if (this._loadFailed && !this._reloadIfFailed())
            return;
        try {
            this.writeEncrypted(this.settingsPath, this.settings);
        }
        catch (e) { log.error('persistence', 'settings could not be written — changes will be lost on restart', e); }
    }
    getAll() { this._reloadIfFailed(); return { ...this.settings }; }
    get(key) { this._reloadIfFailed(); return this.settings[key] ?? DEFAULTS[key]; }
    set(key, value) {
        if (!(key in DEFAULTS))
            return;
        // Adopt the real settings first (if a startup decrypt failed) so this write
        // lands on top of them rather than on defaults.
        this._reloadIfFailed();
        this.settings[key] = value;
        this.save();
    }
    // Legacy API
    getPersistMode() { this._reloadIfFailed(); return !!this.settings.persistAllTabs; }
    setPersistMode(enabled) { this._reloadIfFailed(); this.settings.persistAllTabs = !!enabled; this.save(); }
    // ── Tab State ─────────────────────────────────────────────────────────────
    hasState() {
        try {
            return fs.existsSync(this.statePath);
        }
        catch {
            return false;
        }
    }
    /**
     * Session state. v2 holds one entry PER WINDOW (`{ v: 2, windows: [...] }`);
     * v1 was a single window's worth at the top level and every window
     * overwrote it, so closing the browser with three windows open brought one
     * back. v1 files still load — they read as a one-window session.
     */
    loadState() {
        try {
            if (!fs.existsSync(this.statePath))
                return null;
            const plaintext = this.readEncrypted(this.statePath);
            const obj = JSON.parse(plaintext);
            if (obj && Array.isArray(obj.windows) && obj.windows.length)
                return obj.windows[0];
            if (!obj || !Array.isArray(obj.tabs))
                return null;
            return obj;
        }
        catch {
            return null;
        }
    }
    /** Every saved window, newest layout first. Empty array when there is none. */
    loadAllWindowStates() {
        try {
            if (!fs.existsSync(this.statePath))
                return [];
            const obj = JSON.parse(this.readEncrypted(this.statePath));
            if (obj && Array.isArray(obj.windows))
                return obj.windows.filter(w => w && Array.isArray(w.tabs) && w.tabs.length);
            if (obj && Array.isArray(obj.tabs) && obj.tabs.length)
                return [obj];
            return [];
        }
        catch {
            return [];
        }
    }
    /**
     * Stop accepting session updates. Shutdown tears every window down tab by
     * tab, and each removal used to write a smaller state than the last — so the
     * snapshot taken at quit was immediately overwritten by an emptier one and
     * the session came back with a single tab. The quit snapshot is final.
     */
    freeze() { this._frozen = true; }
    /**
     * Record one window's state and persist the whole set. Keyed by the live
     * window id so a window that closes drops out of the file, and the order
     * follows the order windows were opened.
     */
    saveWindowState(windowId, state) {
        if (this._frozen)
            return;
        if (!this._windowStates)
            this._windowStates = new Map();
        if (state)
            this._windowStates.set(windowId, state);
        else
            this._windowStates.delete(windowId);
        this.saveState(this._composeState());
    }
    forgetWindowState(windowId, { flush = false } = {}) {
        if (this._frozen)
            return;
        if (!this._windowStates?.has(windowId))
            return;
        this._windowStates.delete(windowId);
        const composed = this._composeState();
        if (flush)
            this.saveStateSync(composed);
        else
            this.saveState(composed);
    }
    _composeState() {
        const windows = [...(this._windowStates?.values() || [])];
        // Keep the first window's fields at the top level as well: older builds
        // (and anything reading the file directly) still find what they expect.
        return { v: 2, windows, ...(windows[0] || { tabs: [], activeIndex: 0 }) };
    }
    // Called (debounced) on every tab event during browsing — the encrypted
    // write happens asynchronously so it never blocks the main event loop.
    // Concurrent calls coalesce: while a write is in flight the newest state
    // waits its turn, and a quit hook flushes anything still pending.
    saveState(state) {
        if (this._frozen)
            return;
        this._pendingState = state;
        if (!this._quitHooked) {
            this._quitHooked = true;
            try {
                app.on('before-quit', () => this.flushStateSync());
            }
            catch (e) { log.debug('persistence', 'saveState', e); }
        }
        if (this._savingState)
            return;
        this._savingState = true;
        (async () => {
            while (this._pendingState) {
                const s = this._pendingState;
                this._pendingState = null;
                try {
                    await fs.promises.writeFile(this.statePath, encrypt(JSON.stringify(s)));
                }
                catch (e) { log.error('persistence', 'session state could not be written', e); }
            }
            this._savingState = false;
        })();
    }
    flushStateSync() {
        if (!this._pendingState)
            return;
        const s = this._pendingState;
        this._pendingState = null;
        try {
            fs.writeFileSync(this.statePath, encrypt(JSON.stringify(s)));
        }
        catch (e) { log.error('persistence', 'session state could not be flushed on quit', e); }
    }
    // Durable save for the last-window-close / quit paths: writes synchronously so
    // the file is complete before the process exits. (The async saveState() can be
    // interrupted mid-write by quit, leaving a truncated, unparseable file — which
    // silently drops the whole restore-on-launch state.)
    saveStateSync(state) {
        this._pendingState = state;
        this.flushStateSync();
    }
}

module.exports = Persistence;