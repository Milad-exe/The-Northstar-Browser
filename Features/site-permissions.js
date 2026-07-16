'use strict';
/**
 * Per-origin site permissions — backs the lock-icon site-info panel and the
 * permission doorhanger (Features/permission-prompt.js).
 *
 * Stores a small map of { origin: { permission: 'allow' | 'block' } }. Anything
 * not explicitly set is 'ask' — the block-by-default state where the site must
 * prompt before using the resource. Persisted encrypted (Features/encryption.js),
 * like the rest of user data.
 *
 * Emits 'change' (origin, name, value) whenever a stored decision changes so the
 * permission layer can drop stale in-memory (temporary) grants for that origin.
 */

const fs   = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
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

class SitePermissions extends EventEmitter {
    constructor() {
        super();
        this.file = null; this.data = { perms: {}, sitesOff: {} }; this.loaded = false;
        this.MANAGED = MANAGED;
    }

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
        this.emit('change', origin, name, value);
    }

    // Permission list for the panel.
    list(origin) {
        this._load();
        return MANAGED.map(p => ({ name: p.name, label: p.label, state: this.state(origin, p.name) }));
    }

    // ── Per-site protections shield (lock-icon panel) ────────────────────────
    // When a site is "off", the request pipeline skips ad/tracker blocking,
    // param stripping, referer trimming and cookie hygiene for pages on it.
    isProtectionOff(site) { this._load(); return !!(site && this.data.sitesOff[site]); }

    // Cheap gate for the per-request hot path: true only if at least one site
    // has protections disabled (almost always false → zero parsing overhead).
    hasAnyProtectionOff() {
        this._load();
        if (this._anyOff === undefined) this._anyOff = Object.keys(this.data.sitesOff).length > 0;
        return this._anyOff;
    }

    setProtection(site, off) {
        this._load();
        if (!site) return;
        if (off) this.data.sitesOff[site] = true;
        else     delete this.data.sitesOff[site];
        this._anyOff = Object.keys(this.data.sitesOff).length > 0;
        this._save();
    }
}

module.exports = new SitePermissions();
