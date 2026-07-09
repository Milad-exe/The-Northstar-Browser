'use strict';
/**
 * Per-origin site permissions — backs the lock-icon site-info panel.
 *
 * Stores a small map of { origin: { permission: 'allow' | 'block' } }. Anything
 * not explicitly set is treated as the default (allow), preserving the browser's
 * existing allow-by-default behaviour; the panel lets the user Block a site.
 * Persisted encrypted (Features/encryption.js), like the rest of user data.
 */

const fs   = require('fs');
const path = require('path');
const { app } = require('electron');
const { encrypt, decrypt, isEncrypted } = require('./encryption');

// Permissions surfaced in the panel, with friendly labels.
const MANAGED = [
    { name: 'location',      label: 'Location' },
    { name: 'camera',        label: 'Camera' },
    { name: 'microphone',    label: 'Microphone' },
    { name: 'notifications', label: 'Notifications' },
];
const MANAGED_NAMES = new Set(MANAGED.map(p => p.name));

const { parse: parseTld } = require('tldts');

class SitePermissions {
    constructor() { this.file = null; this.data = { perms: {}, sitesOff: {} }; this.loaded = false; }

    _load() {
        if (this.loaded) return;
        this.file = path.join(app.getPath('userData'), 'site-permissions.dat');
        try {
            if (fs.existsSync(this.file)) {
                const raw = fs.readFileSync(this.file, 'utf-8');
                const obj = JSON.parse(isEncrypted(raw) ? decrypt(raw) : raw) || {};
                // Migrate the original flat shape ({origin: {perm: val}}).
                this.data = obj.perms || obj.sitesOff
                    ? { perms: obj.perms || {}, sitesOff: obj.sitesOff || {} }
                    : { perms: obj, sitesOff: {} };
            }
        } catch { this.data = { perms: {}, sitesOff: {} }; }
        this.loaded = true;
    }

    _save() {
        try { fs.writeFileSync(this.file, encrypt(JSON.stringify(this.data)), { mode: 0o600 }); } catch {}
    }

    originOf(url) { try { return new URL(url).origin; } catch { return null; } }

    // eTLD+1 "site" for a URL or bare hostname (protection is scoped per site).
    siteOf(urlOrHost) {
        try {
            const host = urlOrHost.includes('://') ? new URL(urlOrHost).hostname : urlOrHost;
            return parseTld(host, { allowPrivateDomains: true }).domain || host;
        } catch { return null; }
    }

    // 'allow' | 'block' | 'ask' (ask = default/unset)
    state(origin, name) { this._load(); return (this.data.perms[origin] && this.data.perms[origin][name]) || 'ask'; }

    set(origin, name, value) {
        this._load();
        if (!origin || !MANAGED_NAMES.has(name)) return;
        if (!this.data.perms[origin]) this.data.perms[origin] = {};
        if (value === 'allow' || value === 'block') this.data.perms[origin][name] = value;
        else delete this.data.perms[origin][name]; // 'ask' / anything else clears it
        if (Object.keys(this.data.perms[origin]).length === 0) delete this.data.perms[origin];
        this._save();
    }

    // Permission list for the panel.
    list(origin) {
        this._load();
        return MANAGED.map(p => ({ name: p.name, label: p.label, state: this.state(origin, p.name) }));
    }

    // Grant decision: allow unless the user explicitly blocked it.
    decide(origin, name) { return this.state(origin, name) !== 'block'; }

    // ── Per-site protections shield (lock-icon panel) ────────────────────────
    // When a site is "off", the request pipeline skips ad/tracker blocking,
    // param stripping, referer trimming and cookie hygiene for pages on it.
    isProtectionOff(site) { this._load(); return !!(site && this.data.sitesOff[site]); }

    setProtection(site, off) {
        this._load();
        if (!site) return;
        if (off) this.data.sitesOff[site] = true;
        else     delete this.data.sitesOff[site];
        this._save();
    }
}

module.exports = new SitePermissions();
