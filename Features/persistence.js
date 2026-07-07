const fs   = require('fs');
const path = require('path');
const { app } = require('electron');
const { encrypt, decrypt, isEncrypted } = require('./encryption');

const DEFAULTS = {
    theme:             'default',
    persistAllTabs:    false,
    searchEngine:      'google',   // 'google' | 'duckduckgo' | 'bing'
    bookmarkBarVisible: false,
    blockShortform:    false,
    adBlockEnabled:    true,
    // Privacy / tracking protection (default to maximum protection)
    blockThirdPartyCookies: true,
    httpsUpgrade:           true,
    stripTrackingParams:    true,
    privacySignals:         true,
    trimReferrer:           true,
    settingsPage:      'general',
    windowBounds:      null,
    windowState:       null,
    pomWork:           25,          // minutes
    pomShortBreak:     5,
    pomLongBreak:      15,
    pomSessions:       4,
};

class Persistence {
    constructor() {
        const userDir     = app.getPath('userData');
        this.dir          = path.join(userDir, 'northstar');
        this.statePath    = path.join(this.dir, 'tabs-state.json');
        this.settingsPath = path.join(this.dir, 'settings.json');
        this.ensureDir();
        this.settings = this.loadSettings();
    }

    ensureDir() {
        try {
            if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
        } catch {}
    }

    // ── Encrypted read / write helpers (sync, for startup path) ──────────────

    readEncrypted(filePath) {
        const raw = fs.readFileSync(filePath, 'utf-8');
        if (isEncrypted(raw)) return decrypt(raw);
        // Legacy plaintext — return as-is; will be re-saved encrypted on next write
        return raw;
    }

    writeEncrypted(filePath, data) {
        fs.writeFileSync(filePath, encrypt(JSON.stringify(data, null, 2)));
    }

    // ── Settings ──────────────────────────────────────────────────────────────

    loadSettings() {
        try {
            if (fs.existsSync(this.settingsPath)) {
                const plaintext = this.readEncrypted(this.settingsPath);
                const obj = JSON.parse(plaintext);
                return { ...DEFAULTS, ...obj };
            }
        } catch {}
        return { ...DEFAULTS };
    }

    save() {
        try { this.writeEncrypted(this.settingsPath, this.settings); } catch {}
    }

    getAll() { return { ...this.settings }; }

    get(key) { return this.settings[key] ?? DEFAULTS[key]; }

    set(key, value) {
        if (!(key in DEFAULTS)) return;
        this.settings[key] = value;
        this.save();
    }

    // Legacy API
    getPersistMode()      { return !!this.settings.persistAllTabs; }
    setPersistMode(enabled) { this.settings.persistAllTabs = !!enabled; this.save(); }

    // ── Tab State ─────────────────────────────────────────────────────────────

    hasState() {
        try { return fs.existsSync(this.statePath); } catch { return false; }
    }

    loadState() {
        try {
            if (!fs.existsSync(this.statePath)) return null;
            const plaintext = this.readEncrypted(this.statePath);
            const obj = JSON.parse(plaintext);
            if (!obj || !Array.isArray(obj.tabs)) return null;
            return obj;
        } catch {
            return null;
        }
    }

    saveState(state) {
        try { this.writeEncrypted(this.statePath, state); } catch {}
    }
}

module.exports = Persistence;
