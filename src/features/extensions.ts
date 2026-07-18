/**
 * Chrome extension support, backed by:
 *   - electron-chrome-web-store  (MIT) — install from the Chrome Web Store,
 *     persistence, startup loading, auto-update.
 *   - electron-chrome-extensions (GPL-3.0) — implements the chrome.* APIs
 *     (tabs, windows, action/popups, contextMenus, storage, messaging) so
 *     extensions actually function.  We ship under the library's GPL-3.0
 *     license (declared in the constructor); distributing this build therefore
 *     makes the browser GPL-3.0 unless a separate patron license is obtained.
 *
 * Extensions load into the default session only (not private tabs), matching
 * Chrome's "not allowed in incognito by default" behavior.
 */

'use strict';

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { app } from 'electron';
// Loaded lazily in setup(): these two libraries are the heaviest requires in
// the main process, and setup() only runs AFTER the first window exists — as
// top-level imports they would sit on the startup critical path for nothing.
let ElectronChromeExtensions: any;
let webStore: any;   // { installChromeWebStore, installExtension, uninstallExtension }
function loadLibs() {
    if (!ElectronChromeExtensions) {
        ({ ElectronChromeExtensions } = require('electron-chrome-extensions'));
        webStore = require('electron-chrome-web-store');
    }
}
// Session's extension API surface moved to session.extensions in newer Electron.
const extApi = (session: any) => session.extensions || session;

class Extensions {
    session: any;               // Electron session extensions are loaded into
    wm: any;                    // WindowManager — to resolve windows for popups
    instance: any;              // ElectronChromeExtensions (for tab wiring)
    popups: Set<any>;           // live browser-action PopupViews (closed on tab switch/clicks)
    listeners: Set<any>;        // subscribers to extension-list changes
    disabled: Record<string, { path: string; name: string; version: string; description: string; optionsUrl: string }>;
    disabledFile: string | null;
    unpackedFile: string | null;

    constructor() {
        this.session   = null;
        this.wm        = null;
        this.instance  = null;   // ElectronChromeExtensions (for tab wiring)
        this.unpackedFile = null;
        this.disabledFile = null;
        this.disabled  = {};     // id → { path, name, version, description, optionsUrl } for disabled extensions
        this.listeners = new Set();
        this.popups    = new Set();
    }

    onChanged(fn) { this.listeners.add(fn); }
    _emit() { for (const fn of this.listeners) { try { fn(); } catch {} } }

    /** Call once in app.whenReady, after the session is configured. */
    async setup(session, wm) {
        loadLibs();
        this.session = session;
        this.wm = wm;
        this.unpackedFile = path.join(app.getPath('userData'), 'extensions-unpacked.json');
        this.disabledFile = path.join(app.getPath('userData'), 'extensions-disabled.json');
        try { this.disabled = JSON.parse(fs.readFileSync(this.disabledFile, 'utf-8')) || {}; } catch { this.disabled = {}; }

        // chrome.* API implementation + browser-action UI plumbing.
        // MUST be constructed BEFORE installChromeWebStore loads persisted
        // extensions: the browser-action API only registers extensions from
        // 'extension-loaded' events, so anything loaded earlier would never
        // get a toolbar action button.
        this.instance = new (ElectronChromeExtensions as any)({
            license: 'GPL-3.0',
            session,
            createTab: (details) => this._createTab(details),
            selectTab: (wc) => this._selectTab(wc),
            removeTab: (wc) => this._removeTab(wc),
            createWindow: async () => {
                const wd = this.wm.createWindow();
                return wd.window;
            },
            removeWindow: (win) => { try { win.close(); } catch {} },
        });

        // Track live browser-action popups so the browser can close them the
        // way Firefox does (tab switch, clicking elsewhere) — the library only
        // closes them on window blur, which misses clicks landing on
        // WebContentsViews inside the same window.
        this.instance.on?.('browser-action-popup-created', (popup) => {
            this.popups.add(popup);
            try { popup.browserWindow?.once('closed', () => this.popups.delete(popup)); } catch {}
        });

        // Serve extension icons (crx://extension-icon/...) so the toolbar
        // <browser-action-list> buttons actually render their icons.
        try { ElectronChromeExtensions.handleCRXProtocol(session); } catch (e) { console.error('handleCRXProtocol:', e.message); }

        // Enable Web Store install + load store-installed extensions on startup.
        await webStore.installChromeWebStore({
            session,
            loadExtensions: true,
            allowUnpackedExtensions: true,
            autoUpdate: true,
        }).catch((e) => console.error('installChromeWebStore:', e.message));

        // Reload any persisted unpacked extensions (the web store loader only
        // manages store-installed ones).
        for (const dir of this._readUnpacked()) {
            if (fs.existsSync(path.join(dir, 'manifest.json'))) {
                try { await extApi(session).loadExtension(dir, { allowFileAccess: true }); } catch {}
            }
        }

        // Re-apply "disabled" state: the web store loader enabled everything, so
        // unload the ones the user had disabled (keeping their record to re-enable).
        const api = extApi(session);
        for (const id of Object.keys(this.disabled)) {
            const ext = (api.getAllExtensions?.() || []).find(e => e.id === id);
            if (ext) {
                this.disabled[id] = this._disabledRecord(ext);
                try { api.removeExtension(id); } catch {}
            }
        }
        this._saveDisabled();

        extApi(session).on?.('extension-loaded',   () => this._emit());
        extApi(session).on?.('extension-unloaded', () => this._emit());
        this._emit();
    }

    // ── Tab wiring (called from Tabs) ──────────────────────────────────────────

    addTab(webContents, browserWindow) {
        try { this.instance?.addTab(webContents, browserWindow); } catch {}
    }
    selectTab(webContents) {
        this.closePopups();   // switching tabs dismisses an open action popup (Firefox behavior)
        try { this.instance?.selectTab(webContents); } catch {}
    }

    /** Close any open browser-action popups. */
    closePopups() {
        for (const popup of [...this.popups]) {
            try { popup.destroy(); } catch {}
            this.popups.delete(popup);
        }
    }
    getContextMenuItems(webContents, params) {
        try { return this.instance?.getContextMenuItems(webContents, params) || []; } catch { return []; }
    }

    // ── chrome.tabs.* callbacks ────────────────────────────────────────────────

    _activeWindow() {
        return this.wm.getMostRecentlyFocusedWindow() || this.wm.getPrimaryWindow() || this.wm.getAllWindows()[0] || null;
    }
    _findTab(wc) {
        for (const wd of this.wm.getAllWindows()) {
            for (const [idx, tab] of wd.tabs.tabMap) {
                if (tab?.webContents === wc) return { wd, idx };
            }
        }
        return null;
    }
    async _createTab(details) {
        const wd = this._activeWindow();
        if (!wd) throw new Error('no window');
        const idx = wd.tabs.createTab(null, details.active !== false);
        if (details.url) wd.tabs.loadUrl(idx, details.url);
        return [wd.tabs.tabMap.get(idx).webContents, wd.window];
    }
    _selectTab(wc) {
        const hit = this._findTab(wc);
        if (hit) hit.wd.tabs.showTab(hit.idx);
    }
    _removeTab(wc) {
        const hit = this._findTab(wc);
        if (hit) hit.wd.tabs.removeTab(hit.idx);
    }

    // ── Management API (Settings) ──────────────────────────────────────────────

    // Icon served by the crx:// handler (works for loaded extensions).
    _iconFor(ext) { return `crx://extension-icon/${ext.id}/32/2`; }

    _optionsUrl(ext) {
        const m = ext.manifest || {};
        const page = m.options_page || m.options_ui?.page;
        return page ? `chrome-extension://${ext.id}/${String(page).replace(/^\/+/, '')}` : null;
    }

    _disabledRecord(ext) {
        return {
            path: ext.path,
            name: ext.name,
            version: ext.manifest?.version || '',
            description: ext.manifest?.description || '',
            optionsUrl: this._optionsUrl(ext),
        };
    }

    list() {
        const loaded = extApi(this.session).getAllExtensions?.() || [];
        const rows = loaded.map(e => ({
            id: e.id,
            name: e.name,
            version: e.manifest?.version || '',
            description: e.manifest?.description || '',
            icon: this._iconFor(e),
            optionsUrl: this._optionsUrl(e),
            enabled: true,
        }));
        for (const [id, rec] of Object.entries(this.disabled)) {
            if (rows.some(r => r.id === id)) continue;
            rows.push({
                id, name: rec.name, version: rec.version || '',
                description: rec.description || '', icon: null,
                optionsUrl: rec.optionsUrl || null, enabled: false,
            });
        }
        rows.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        return rows;
    }

    async setEnabled(id, enabled) {
        const api = extApi(this.session);
        if (enabled) {
            const rec = this.disabled[id];
            if (rec?.path) { try { await api.loadExtension(rec.path, { allowFileAccess: true }); } catch {} }
            delete this.disabled[id];
        } else {
            const ext = (api.getAllExtensions?.() || []).find(e => e.id === id);
            if (ext) {
                this.disabled[id] = this._disabledRecord(ext);
                try { api.removeExtension(id); } catch {}
            }
        }
        this._saveDisabled();
        this._emit();
        return true;
    }

    openOptions(id) {
        const ext = (extApi(this.session).getAllExtensions?.() || []).find(e => e.id === id);
        const url = ext ? this._optionsUrl(ext) : null;
        if (!url) return false;
        const wd = this._activeWindow();
        if (wd?.tabs) {
            // Open AND focus — a background tab looks like nothing happened.
            const idx = wd.tabs.createLazyTab(url, ext.name, false, false, true, true);
            try { wd.tabs.showTab(idx); } catch {}
        }
        return true;
    }

    _saveDisabled() { try { fs.writeFileSync(this.disabledFile, JSON.stringify(this.disabled, null, 2)); } catch {} }

    async installById(id) {
        const cleanId = String(id || '').trim().match(/[a-p]{32}/i)?.[0] || String(id || '').trim();
        loadLibs();
        const ext = await webStore.installExtension(cleanId, { session: this.session });
        this._emit();
        return { id: ext.id, name: ext.name };
    }

    async installUnpacked(sourcePath) {
        if (!fs.existsSync(path.join(sourcePath, 'manifest.json'))) {
            throw new Error('Folder has no manifest.json');
        }
        const ext = await extApi(this.session).loadExtension(sourcePath, { allowFileAccess: true });
        this._addUnpacked(sourcePath);
        this._emit();
        return { id: ext.id, name: ext.name };
    }

    async installCrx(crxPath) {
        const dest = path.join(app.getPath('userData'), 'extensions-unpacked', crypto.randomUUID());
        fs.mkdirSync(dest, { recursive: true });
        try { execFileSync('unzip', ['-o', '-qq', crxPath, '-d', dest], { stdio: 'ignore' }); }
        catch { if (!fs.existsSync(path.join(dest, 'manifest.json'))) throw new Error('Could not unpack .crx (needs the `unzip` tool).'); }
        const root = fs.existsSync(path.join(dest, 'manifest.json')) ? dest : this._findManifestRoot(dest);
        if (!root) { fs.rmSync(dest, { recursive: true, force: true }); throw new Error('No manifest.json in the .crx'); }
        return this.installUnpacked(root);
    }

    async remove(id) {
        // A disabled extension isn't loaded, so uninstall would no-op — just drop it.
        if (this.disabled[id]) { delete this.disabled[id]; this._saveDisabled(); this._emit(); return true; }
        try { await webStore.uninstallExtension(id, { session: this.session }); }
        catch { try { extApi(this.session).removeExtension(id); } catch {} }
        this._removeUnpackedById(id);
        this._emit();
        return true;
    }

    // ── Unpacked registry ──────────────────────────────────────────────────────

    _readUnpacked() {
        try { const a = JSON.parse(fs.readFileSync(this.unpackedFile, 'utf-8')); return Array.isArray(a) ? a : []; }
        catch { return []; }
    }
    _writeUnpacked(list) { try { fs.writeFileSync(this.unpackedFile, JSON.stringify(list, null, 2)); } catch {} }
    _addUnpacked(dir) { const l = this._readUnpacked(); if (!l.includes(dir)) { l.push(dir); this._writeUnpacked(l); } }
    _removeUnpackedById(_id?) { /* dirs aren't keyed by id; pruned lazily on next load if missing */ }

    _findManifestRoot(dir) {
        if (fs.existsSync(path.join(dir, 'manifest.json'))) return dir;
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
        const subs = entries.filter(e => e.isDirectory());
        for (const s of subs) {
            const found = this._findManifestRoot(path.join(dir, s.name));
            if (found) return found;
        }
        return null;
    }
}

export default new Extensions();