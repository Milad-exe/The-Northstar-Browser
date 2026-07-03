const path = require('path');
const fs   = require('fs').promises;
const { app } = require('electron');
const { encrypt, decrypt, isEncrypted } = require('./encryption');

class History {
    constructor() {
        this.file        = null;
        this.initialized = false;
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

    // ── Low-level read/write (handles encrypt/decrypt + plaintext migration) ──

    async read() {
        await this.ensureFile();
        try {
            const raw = await fs.readFile(this.file, 'utf8');
            let plaintext;
            if (isEncrypted(raw)) {
                plaintext = decrypt(raw);
            } else {
                // Plaintext legacy file — migrate to encrypted on next write
                plaintext = raw;
            }
            const data = JSON.parse(plaintext);
            return Array.isArray(data) ? data : [];
        } catch {
            return [];
        }
    }

    async write(data) {
        try {
            await fs.writeFile(this.file, encrypt(JSON.stringify(data, null, 2)), 'utf8');
        } catch {}
    }

    // ── Public API ──────────────────────────────────────────────────────────

    async loadHistory() {
        return this.read();
    }

    async addToHistory(url, title) {
        await this.ensureFile();
        try {
            const history = await this.read();

            if (isSearchResultUrl(url)) return;

            // Remove existing entry for same URL (dedup, keep fresh timestamp at top)
            const deduped = history.filter(e => e.url !== url);

            deduped.unshift({ url, title, timestamp: new Date().toISOString() });

            await this.write(deduped.slice(0, 1000));
        } catch {}
    }

    async removeFromHistory(url, timestamp) {
        try {
            const history = await this.read();
            await this.write(history.filter(e => !(e.url === url && e.timestamp === timestamp)));
            return true;
        } catch {
            return false;
        }
    }

    async clearHistory() {
        try {
            await this.ensureFile();
            await this.write([]);
            return true;
        } catch {
            return false;
        }
    }

    // Remove entries newer than `sinceMs` (keep older ones). sinceMs = 0 clears all.
    async clearSince(sinceMs) {
        try {
            if (!sinceMs) return this.clearHistory();
            const history = await this.read();
            const kept = history.filter(e => {
                const t = Date.parse(e.timestamp || 0);
                return isNaN(t) ? true : t < sinceMs;
            });
            await this.write(kept);
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
