/**
 * Password store — credentials encrypted at rest with Electron's safeStorage
 * (OS keychain: macOS Keychain, Windows DPAPI, Linux libsecret). The plaintext
 * password never touches disk unencrypted and is only handed to the page that
 * owns the matching origin (for autofill) or to the passwords settings page on
 * an explicit reveal.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, safeStorage } = require('electron');

class PasswordStore {
    constructor() {
        this.file    = null;
        this.records = [];      // [{ id, origin, username, password, updatedAt }]
        this.never   = [];      // origins the user chose "Never save" for
        this.loaded  = false;
        this.listeners = new Set();
    }

    onChanged(fn) { this.listeners.add(fn); }
    _emit() { for (const fn of this.listeners) { try { fn(); } catch {} } }

    _load() {
        if (this.loaded) return;
        this.file = path.join(app.getPath('userData'), 'passwords.dat');
        try {
            if (fs.existsSync(this.file)) {
                const raw  = fs.readFileSync(this.file);
                const json = safeStorage.isEncryptionAvailable()
                    ? safeStorage.decryptString(raw)
                    : raw.toString('utf-8');
                const obj = JSON.parse(json);
                this.records = Array.isArray(obj.records) ? obj.records : [];
                this.never   = Array.isArray(obj.never)   ? obj.never   : [];
            }
        } catch { this.records = []; this.never = []; }
        this.loaded = true;
    }

    _save() {
        try {
            const json = JSON.stringify({ records: this.records, never: this.never });
            const buf = safeStorage.isEncryptionAvailable()
                ? safeStorage.encryptString(json)
                : Buffer.from(json, 'utf-8');
            fs.writeFileSync(this.file, buf, { mode: 0o600 });
        } catch {}
    }

    // ── Autofill ────────────────────────────────────────────────────────────
    getForOrigin(origin) {
        this._load();
        return this.records
            .filter(r => r.origin === origin)
            .map(r => ({ id: r.id, username: r.username, password: r.password }));
    }

    // ── Save flow ───────────────────────────────────────────────────────────
    // 'exists' (same pw) | 'update' (pw changed) | 'new' | 'never'
    status(origin, username, password) {
        this._load();
        if (this.never.includes(origin)) return 'never';
        const same = this.records.find(r => r.origin === origin && r.username === username);
        if (!same) return 'new';
        return same.password === password ? 'exists' : 'update';
    }

    upsert({ origin, username, password }) {
        this._load();
        const existing = this.records.find(r => r.origin === origin && r.username === username);
        if (existing) { existing.password = password; existing.updatedAt = Date.now(); }
        else this.records.push({ id: crypto.randomUUID(), origin, username, password, updatedAt: Date.now() });
        this._save();
        this._emit();
    }

    addNever(origin) {
        this._load();
        if (!this.never.includes(origin)) { this.never.push(origin); this._save(); this._emit(); }
    }

    // ── Management (settings) ─────────────────────────────────────────────────
    list() {
        this._load();
        return this.records
            .slice()
            .sort((a, b) => (a.origin === b.origin ? 0 : a.origin < b.origin ? -1 : 1))
            .map(r => ({ id: r.id, origin: r.origin, username: r.username, updatedAt: r.updatedAt }));
    }

    getPassword(id) {
        this._load();
        return this.records.find(r => r.id === id)?.password || null;
    }

    delete(id) {
        this._load();
        const i = this.records.findIndex(r => r.id === id);
        if (i === -1) return false;
        this.records.splice(i, 1);
        this._save();
        this._emit();
        return true;
    }
}

module.exports = new PasswordStore();
