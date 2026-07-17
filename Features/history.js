const path   = require('path');
const fs     = require('fs').promises;
const fsSync = require('fs');
const { app } = require('electron');
const { encrypt, decrypt, isEncrypted } = require('./encryption');

/**
 * Browsing history — kept in memory, persisted with a write-behind.
 *
 * The old implementation hit the disk for EVERYTHING: every keystroke in the
 * address bar (suggestions search) and every page navigation re-read, decrypted
 * and re-parsed the whole file, then re-encrypted and rewrote it. Now the list
 * loads once, all reads are memory-speed, and mutations schedule one coalesced
 * encrypted write 500 ms later (flushed synchronously on quit so nothing is
 * lost). Privacy-motivated deletions (remove / clear) flush immediately.
 */

const MAX_ENTRIES = 1000;
const WRITE_DELAY_MS = 500;

class History {
    constructor() {
        this.file        = null;
        this.initialized = false;
        this.cache       = null;   // Array — the single source of truth once loaded
        this._writeTimer = null;
        this._quitHooked = false;
        this.initPath();
    }

    initPath() {
        try {
            this.file = path.join(app.getPath('userData'), 'browsing-history.json');
        } catch {
            this.file = path.join(process.cwd(), 'browsing-history.json');
        }
    }

    async ensureFile() {
        if (this.initialized) return true;
        if (!this.file) return false;
        try {
            await fs.stat(this.file);
        } catch {
            // File doesn't exist — write an empty encrypted history
            await fs.writeFile(this.file, encrypt('[]'), 'utf8');
        }
        this.initialized = true;
        return true;
    }

    // ── Load once; every later read is served from memory ────────────────────

    async load() {
        if (this.cache) return this.cache;
        await this.ensureFile();
        try {
            const raw = await fs.readFile(this.file, 'utf8');
            // Plaintext legacy file — migrated to encrypted on next write.
            const plaintext = isEncrypted(raw) ? decrypt(raw) : raw;
            const data = JSON.parse(plaintext);
            this.cache = Array.isArray(data) ? data : [];
        } catch {
            this.cache = [];
        }
        return this.cache;
    }

    // ── Write-behind ──────────────────────────────────────────────────────────

    _scheduleWrite() {
        clearTimeout(this._writeTimer);
        this._writeTimer = setTimeout(() => { this._flush().catch(() => {}); }, WRITE_DELAY_MS);
        if (!this._quitHooked) {
            this._quitHooked = true;
            try { app.on('before-quit', () => this.flushSync()); } catch {}
        }
    }

    async _flush() {
        clearTimeout(this._writeTimer);
        this._writeTimer = null;
        if (!this.cache) return;
        await fs.writeFile(this.file, encrypt(JSON.stringify(this.cache)), 'utf8');
    }

    // Quit path — a pending debounced write must not die with the process.
    flushSync() {
        if (!this._writeTimer || !this.cache) return;
        clearTimeout(this._writeTimer);
        this._writeTimer = null;
        try { fsSync.writeFileSync(this.file, encrypt(JSON.stringify(this.cache)), 'utf8'); } catch {}
    }

    // ── Public API (signatures unchanged) ─────────────────────────────────────

    async loadHistory() {
        return this.load();
    }

    async addToHistory(url, title) {
        if (isSearchResultUrl(url)) return;
        const history = await this.load();
        // Dedup by URL, keep the fresh timestamp at the top.
        const i = history.findIndex(e => e.url === url);
        if (i !== -1) history.splice(i, 1);
        history.unshift({ url, title, timestamp: new Date().toISOString() });
        if (history.length > MAX_ENTRIES) history.length = MAX_ENTRIES;
        this._scheduleWrite();
    }

    async removeFromHistory(url, timestamp) {
        try {
            const history = await this.load();
            this.cache = history.filter(e => !(e.url === url && e.timestamp === timestamp));
            await this._flush();   // deletion is a privacy action — persist now
            return true;
        } catch {
            return false;
        }
    }

    async clearHistory() {
        try {
            await this.ensureFile();
            this.cache = [];
            await this._flush();
            return true;
        } catch {
            return false;
        }
    }

    // Remove entries newer than `sinceMs` (keep older ones). sinceMs = 0 clears all.
    async clearSince(sinceMs) {
        try {
            if (!sinceMs) return this.clearHistory();
            const history = await this.load();
            this.cache = history.filter(e => {
                const t = Date.parse(e.timestamp || 0);
                return isNaN(t) ? true : t < sinceMs;
            });
            await this._flush();
            return true;
        } catch {
            return false;
        }
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isSearchResultUrl(rawUrl) {
    if (!rawUrl) return false;
    try {
        const u      = new URL(rawUrl);
        const host   = u.hostname.toLowerCase();
        const p      = u.pathname.toLowerCase();
        const params = u.searchParams;
        if (host.includes('google.')    && (p.startsWith('/search') || p.startsWith('/url') || params.has('q'))) return true;
        if (host.includes('bing.com')   && (p.startsWith('/search') || params.has('q'))) return true;
        if (host.includes('duckduckgo.com') && params.has('q')) return true;
        if (p.includes('/search') && params.has('q')) return true;
    } catch {}
    return false;
}

module.exports = History;
