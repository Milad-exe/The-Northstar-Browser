'use strict';

/**
 * ExtensionManager
 *
 * Handles the full lifecycle of Chrome extensions inside Ink:
 *  - Loading persisted extensions from disk into the Electron session on startup.
 *  - Downloading + installing a CRX by extension ID (from Chrome Web Store).
 *  - Uninstalling extensions (session + disk).
 *
 * Extensions are stored at:  userData/ink/extensions/<cwsId>/
 *
 * Only the default (non-private) session receives extensions.
 * Private tabs use a separate partition that intentionally has no extensions.
 */

const fs   = require('fs');
const path = require('path');
const { app, net, session } = require('electron');
const { installCrxToDir } = require('./crx-installer');

// Use a real Chrome UA for the CRX download request so Google CDN serves the file.
const CHROME_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

class ExtensionManager {
    constructor() {
        this._dir       = null;
        // cwsId → { electronId, name, version, description, path }
        this._installed = new Map();
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    async init() {
        this._dir = path.join(app.getPath('userData'), 'ink', 'extensions');
        fs.mkdirSync(this._dir, { recursive: true });
    }

    /** Load every extension on disk into the given session. */
    async loadAllIntoSession(sess) {
        let entries;
        try { entries = fs.readdirSync(this._dir, { withFileTypes: true }); }
        catch { return; }

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const extPath = path.join(this._dir, entry.name);
            try {
                const ext = await sess.loadExtension(extPath, { allowFileAccess: true });
                this._track(entry.name, ext, extPath);
            } catch (e) {
                console.error(`[extensions] Could not load ${entry.name}:`, e.message);
            }
        }
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Download and install a Chrome extension by its CWS ID.
     * Returns { id, name } on success, throws on failure.
     */
    async installFromId(cwsId) {
        if (!/^[a-p]{32}$/.test(cwsId)) throw new Error('Invalid extension ID');

        const crxUrl = `https://clients2.google.com/service/update2/crx` +
            `?response=redirect&prodversion=130.0.0.0` +
            `&x=id%3D${cwsId}%26uc&acceptformat=crx3`;

        const crxBuffer = await this._fetchBuffer(crxUrl);

        const extDir  = path.join(this._dir, cwsId);
        const manifest = await installCrxToDir(crxBuffer, extDir);

        const sess = session.defaultSession;
        const ext  = await sess.loadExtension(extDir, { allowFileAccess: true });
        this._track(cwsId, ext, extDir);

        return { id: ext.id, name: manifest.name || cwsId };
    }

    /** Remove an extension by CWS ID or Electron ID. */
    async uninstall(cwsId) {
        const entry = this._installed.get(cwsId);
        if (!entry) throw new Error('Extension not installed');

        try { session.defaultSession.removeExtension(entry.electronId); } catch {}
        this._installed.delete(cwsId);

        try { fs.rmSync(entry.path, { recursive: true, force: true }); } catch {}
        return true;
    }

    isInstalled(cwsId) {
        return this._installed.has(cwsId);
    }

    getAll() {
        return [...this._installed.entries()].map(([cwsId, e]) => ({
            cwsId,
            id:          e.electronId,
            name:        e.name,
            version:     e.version,
            description: e.description,
        }));
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    _track(cwsId, electronExt, extPath) {
        this._installed.set(cwsId, {
            electronId:  electronExt.id,
            name:        electronExt.name        || cwsId,
            version:     electronExt.version     || '',
            description: electronExt.description || '',
            path:        extPath,
        });
    }

    /** Fetch a URL as a Buffer, following up to 10 redirects. */
    _fetchBuffer(url, hops = 10) {
        return new Promise((resolve, reject) => {
            if (hops <= 0) return reject(new Error('Too many redirects'));

            const req = net.request({ url, useSessionCookies: false });
            req.setHeader('User-Agent', CHROME_UA);
            req.setHeader('Accept', '*/*');

            req.on('response', (res) => {
                const loc = res.headers['location'];
                if ([301, 302, 307, 308].includes(res.statusCode) && loc) {
                    resolve(this._fetchBuffer(loc, hops - 1));
                    return;
                }
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }
                const chunks = [];
                res.on('data',  c  => chunks.push(c));
                res.on('end',   () => resolve(Buffer.concat(chunks)));
                res.on('error', reject);
            });
            req.on('error', reject);
            req.end();
        });
    }
}

module.exports = new ExtensionManager();
