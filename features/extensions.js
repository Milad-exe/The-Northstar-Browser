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
const log = require('./log');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { app } = require('electron');

// A .crx is a ZIP archive behind a signing header. crx-verify checks that
// signature and says where the ZIP starts; slicing in pure JS (vs. shelling out
// to `unzip`) keeps .crx install working on Windows, which has no `unzip`.
const { verifyCrx, reconcileManifestKey } = require('./crx-verify');
// Extensions never get file:// access. Chrome keeps it off until the user
// turns it on per extension; here the app's own UI (the chrome, Settings,
// every internal page) is file://, so an extension with file access could
// inject script into the browser itself.
const LOAD_OPTIONS = Object.freeze({ allowFileAccess: false });
/**
 * What an install prompt tells the user the extension can do, worst first.
 * Pure (manifest in, sentences out) so the unit tests can pin it.
 */
const PERMISSION_WARNINGS = [
    ['debugger', 'Read and change everything on every site, including your passwords'],
    ['proxy', 'Route all of your traffic through a server it chooses'],
    ['history', 'Read and change your browsing history'],
    ['tabs', 'Read the address and title of every tab'],
    ['bookmarks', 'Read and change your bookmarks'],
    ['tabCapture', 'Capture the contents of a tab you invoke it on'],
    ['desktopCapture', 'Capture your screen'],
    ['cookies', 'Read and change cookies for the sites it can access'],
    ['downloads', 'Manage your downloads'],
    ['management', 'Manage your other extensions'],
    ['identity', 'Sign you in to services through a web page'],
    ['nativeMessaging', 'Talk to programs installed on your computer'],
    ['clipboardRead', 'Read what you copy'],
    ['geolocation', 'Know your location'],
    ['notifications', 'Show notifications'],
    ['declarativeNetRequest', 'Block or change network requests'],
    ['declarativeNetRequestWithHostAccess', 'Block or change network requests'],
];
function describePermissions(manifest) {
    const perms = new Set(Array.isArray(manifest?.permissions) ? manifest.permissions : []);
    const hosts = [...(Array.isArray(manifest?.host_permissions) ? manifest.host_permissions : []),
        ...[...perms].filter(p => typeof p === 'string' && (p === '<all_urls>' || p.includes('://')))];
    for (const cs of Array.isArray(manifest?.content_scripts) ? manifest.content_scripts : [])
        for (const m of Array.isArray(cs?.matches) ? cs.matches : [])
            hosts.push(m);
    const out = [];
    const everywhere = hosts.some(h => h === '<all_urls>' || /^(\*|https?):\/\/\*\//.test(h));
    if (everywhere)
        out.push('Read and change your data on every website');
    else if (hosts.length) {
        const names = [...new Set(hosts.map(h => String(h).replace(/^[^:]+:\/\//, '').replace(/\/.*$/, '')))];
        out.push('Read and change your data on ' + (names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more sites` : names.join(', ')));
    }
    const seen = new Set();
    for (const [perm, text] of PERMISSION_WARNINGS)
        if (perms.has(perm) && !seen.has(text)) {
            seen.add(text);
            out.push(text);
        }
    return out;
}
// Loaded lazily in setup(): these two libraries are the heaviest requires in
// the main process, and setup() only runs AFTER the first window exists — as
// top-level imports they would sit on the startup critical path for nothing.
let ElectronChromeExtensions;
let webStore; // { installChromeWebStore, installExtension, uninstallExtension }
function loadLibs() {
    if (!ElectronChromeExtensions) {
        ({ ElectronChromeExtensions } = require('electron-chrome-extensions'));
        webStore = require('electron-chrome-web-store');
    }
}
// Session's extension API surface moved to session.extensions in newer Electron.
const extApi = (session) => session.extensions || session;
class Extensions {
    session; // Electron session extensions are loaded into
    wm; // WindowManager — to resolve windows for popups
    instance; // ElectronChromeExtensions (for tab wiring)
    popups; // live browser-action PopupViews (closed on tab switch/clicks)
    listeners; // subscribers to extension-list changes
    disabled;
    disabledFile;
    unpackedFile;
    constructor() {
        this.session = null;
        this.wm = null;
        this.instance = null; // default-session ElectronChromeExtensions
        // A host is per SESSION, so every space (and container) needs its own or
        // its tabs are invisible to chrome.* — which is why extensions only ever
        // worked in the default space.
        this.hosts = new Map(); // Electron session → ElectronChromeExtensions
        this.unpackedFile = null;
        this.disabledFile = null;
        this.disabled = {}; // id → { path, name, version, description, optionsUrl } for disabled extensions
        this.listeners = new Set();
        this.popups = new Set();
    }
    /** Build a chrome.* host bound to one session. */
    _makeHost(session) {
        const host = new ElectronChromeExtensions({
            license: 'GPL-3.0',
            session,
            createTab: (details) => this._createTab(details),
            selectTab: (wc) => this._selectTab(wc),
            removeTab: (wc) => this._removeTab(wc),
            createWindow: async () => {
                const wd = this.wm.createWindow();
                return wd.window;
            },
            removeWindow: (win) => { try {
                win.close();
            }
            catch (e) { log.debug('extensions', '_makeHost', e); } },
        });
        host.on?.('browser-action-popup-created', (popup) => {
            this.popups.add(popup);
            try { popup.browserWindow?.once('closed', () => this.popups.delete(popup)); }
            catch (e) { log.debug('extensions', '_makeHost', e); }
        });
        this._trackActionClicks(host);
        try { ElectronChromeExtensions.handleCRXProtocol(session); }
        catch (e) { log.debug('extensions', '_makeHost', e); }
        this._registerPolyfill(session);
        this._wireDnr(session);
        // An extension that is disabled, removed or reloaded stops steering
        // this session's traffic; the user's own proxy comes back.
        extApi(session).on?.('extension-unloaded', (_e, ext) => {
            if (!ext?.id)
                return;
            require('./ext-proxy').clear(ext.id, session)
                .catch((e) => log.debug('extensions', 'proxy cleanup', e));
        });
        return host;
    }
    /**
     * Ask before a Web Store install, naming what the extension will be able
     * to do — the library installs on the page's say-so otherwise.
     */
    async _confirmInstall({ localizedName, manifest, browserWindow } = {}) {
        const lines = describePermissions(manifest);
        const name = localizedName || manifest?.name || 'this extension';
        try {
            const { dialog } = require('electron');
            const opts = {
                type: 'question',
                buttons: ['Add extension', 'Cancel'],
                defaultId: 1,
                cancelId: 1,
                noLink: true,
                message: `Add “${name}”?`,
                detail: lines.length
                    ? 'It will be able to:\n' + lines.map(l => '•  ' + l).join('\n')
                    : 'It asks for no special permissions.',
            };
            const { response } = browserWindow && !browserWindow.isDestroyed()
                ? await dialog.showMessageBox(browserWindow, opts)
                : await dialog.showMessageBox(opts);
            return { action: response === 0 ? 'allow' : 'deny' };
        }
        catch (e) {
            log.warn('extensions', 'install prompt failed; not installing', e);
            return { action: 'deny' };
        }
    }

    /**
     * Record "the user clicked this extension's toolbar button on this tab" —
     * the grant chrome.tabCapture needs (features/ext-permissions.js).
     *
     * The library funnels both a real click and the extension's own
     * chrome.action.openPopup() through activateClick; only the click comes
     * from the <browser-action-list> element, which always sends an
     * `alignment` key. openPopup never does, so it grants nothing.
     */
    _trackActionClicks(host) {
        const ba = host?.api?.browserAction;
        if (!ba || typeof ba.activateClick !== 'function')
            return;
        const original = ba.activateClick;
        ba.activateClick = (details = {}) => {
            if (details && 'alignment' in details && details.extensionId) {
                try {
                    const { webContents } = require('electron');
                    let tab = details.tabId >= 0 ? webContents.fromId(Number(details.tabId)) : null;
                    if (!tab) {
                        const wd = this._activeWindow();
                        tab = wd?.tabs?.tabMap?.get(wd.tabs.activeTabIndex)?.webContents || null;
                    }
                    require('./ext-permissions').grantActionClick(details.extensionId, tab);
                }
                catch (e) { log.debug('extensions', '_trackActionClicks', e); }
            }
            return original.call(ba, details);
        };
    }
    /**
     * Feed extension rulesets to the declarativeNetRequest engine. Rules are
     * keyed by extension id and shared across sessions, so registering the same
     * extension from several sessions is idempotent — but only the default
     * session may UNregister, or unloading a space would strip rules the other
     * spaces are still using.
     */
    _wireDnr(session) {
        const dnr = require('./dnr');
        const api = extApi(session);
        try {
            for (const ext of api.getAllExtensions?.() || [])
                dnr.registerExtension(ext);
        }
        catch (e) { log.debug('extensions', '_wireDnr', e); }
        api.on?.('extension-loaded', (_e, ext) => {
            try { dnr.registerExtension(ext); }
            catch (e) { log.debug('extensions', '_wireDnr', e); }
        });
        api.on?.('extension-unloaded', (_e, ext) => {
            if (session === this.session && ext?.id)
                dnr.unregisterExtension(ext.id);
        });
    }
    /**
     * Fill the chrome.* gaps in extension service workers. Registered per
     * session, since each space hosts its own extension processes.
     */
    _registerPolyfill(session) {
        try {
            session.registerPreloadScript({
                type: 'service-worker',
                id: 'northstar-ext-polyfill',
                filePath: path.join(__dirname, '../preload/ext-polyfill.js'),
            });
            // Extension PAGES need the same APIs — a content blocker's popup
            // toggles per-site rules through declarativeNetRequest. The script
            // bails on any non-chrome-extension:// origin.
            session.registerPreloadScript({
                type: 'frame',
                id: 'northstar-ext-polyfill-frame',
                filePath: path.join(__dirname, '../preload/ext-polyfill.js'),
            });
            // A service worker's IPC does NOT go through the global ipcMain — each
            // worker has its own router — so the gap layer's handlers have to be
            // attached to every worker as it starts.
            session.serviceWorkers.on('running-status-changed', ({ versionId, runningStatus }) => {
                if (runningStatus !== 'running')
                    return;
                let sw = null;
                try { sw = session.serviceWorkers.getWorkerFromVersionID(versionId); }
                catch (e) { log.debug('extensions', '_registerPolyfill', e); }
                if (!sw || sw._inkGapWired)
                    return;
                sw._inkGapWired = true;
                /* The gap layer lives in ipc/, which is a LAYER ABOVE this one.
                   Fetching it from here inverted that — features reaching up
                   into ipc — and was the single edge every circular dependency
                   in this tree routed through. ipc/extensions hands it down at
                   register() time instead. */
                try { this._gapHandlers && this._gapHandlers(sw, this.wm); }
                catch (e) { log.error('extensions', 'extension gap handlers', e); }
            });
        }
        catch (e) {
            console.error('extension polyfill registration:', e.message);
        }
    }
    /**
     * Who wires the chrome.* gap layer onto a new service worker. Injected by
     * ipc/extensions at registration rather than required from here, so this
     * module never depends on the layer above it.
     */
    setGapHandlers(fn) {
        this._gapHandlers = typeof fn === 'function' ? fn : null;
    }
    /**
     * The host for a session, created on first use. Spaces and containers get
     * their own sessions, so each loads the same installed extensions with its
     * own storage — the way Chrome profiles work.
     */
    ensureForSession(session) {
        if (!session || !this.instance)
            return null; // setup() has not run yet; nothing to attach to
        const existing = this.hosts.get(session);
        if (existing)
            return existing;
        let host = null;
        try {
            loadLibs();
            host = this._makeHost(session);
            this.hosts.set(session, host);
            // Load the same installed set into this session, and keep it updated.
            webStore.installChromeWebStore({
                session,
                loadExtensions: true,
                allowUnpackedExtensions: true,
                autoUpdate: false, // the default session's host owns updating
                beforeInstall: (d) => this._confirmInstall(d),
            }).catch((e) => console.error('extensions for session:', e.message));
        }
        catch (e) {
            console.error('ensureForSession:', e.message);
        }
        return host;
    }
    /** The host that owns a webContents, by its session. */
    _hostFor(webContents) {
        try { return this.hosts.get(webContents.session) || this.ensureForSession(webContents.session); }
        catch { return null; }
    }
    onChanged(fn) { this.listeners.add(fn); }
    _emit() { for (const fn of this.listeners) {
        try {
            fn();
        }
        catch (e) { log.debug('extensions', '_emit', e); }
    } }
    /** Call once in app.whenReady, after the session is configured. */
    async setup(session, wm) {
        loadLibs();
        this.session = session;
        this.wm = wm;
        this.unpackedFile = path.join(app.getPath('userData'), 'extensions-unpacked.json');
        this.disabledFile = path.join(app.getPath('userData'), 'extensions-disabled.json');
        try {
            this.disabled = JSON.parse(fs.readFileSync(this.disabledFile, 'utf-8')) || {};
        }
        catch {
            this.disabled = {};
        }
        // chrome.* API implementation + browser-action UI plumbing.
        // MUST be constructed BEFORE installChromeWebStore loads persisted
        // extensions: the browser-action API only registers extensions from
        // 'extension-loaded' events, so anything loaded earlier would never
        // get a toolbar action button.
        this.instance = this._makeHost(session);
        this.hosts.set(session, this.instance);
        // Track live browser-action popups so the browser can close them the
        // way browsers do (tab switch, clicking elsewhere) — the library only
        // closes them on window blur, which misses clicks landing on
        // WebContentsViews inside the same window.
        this.instance.on?.('browser-action-popup-created', (popup) => {
            this.popups.add(popup);
            try {
                popup.browserWindow?.once('closed', () => this.popups.delete(popup));
            }
            catch (e) { log.debug('extensions', 'setup', e); }
        });
        // Serve extension icons (crx://extension-icon/...) so the toolbar
        // <browser-action-list> buttons actually render their icons.
        try {
            ElectronChromeExtensions.handleCRXProtocol(session);
        }
        catch (e) {
            console.error('handleCRXProtocol:', e.message);
        }
        // Enable Web Store install + load store-installed extensions on startup.
        await webStore.installChromeWebStore({
            session,
            loadExtensions: true,
            allowUnpackedExtensions: true,
            autoUpdate: true,
            beforeInstall: (d) => this._confirmInstall(d),
        }).catch((e) => console.error('installChromeWebStore:', e.message));
        // Reload any persisted unpacked extensions (the web store loader only
        // manages store-installed ones).
        for (const dir of this._readUnpacked()) {
            if (fs.existsSync(path.join(dir, 'manifest.json'))) {
                try {
                    await extApi(session).loadExtension(dir, LOAD_OPTIONS);
                }
                catch (e) { log.debug('extensions', 'setup', e); }
            }
        }
        // Re-apply "disabled" state: the web store loader enabled everything, so
        // unload the ones the user had disabled (keeping their record to re-enable).
        const api = extApi(session);
        for (const id of Object.keys(this.disabled)) {
            const ext = (api.getAllExtensions?.() || []).find(e => e.id === id);
            if (ext) {
                this.disabled[id] = this._disabledRecord(ext);
                try {
                    api.removeExtension(id);
                }
                catch (e) { log.debug('extensions', 'ext', e); }
            }
        }
        this._saveDisabled();
        extApi(session).on?.('extension-loaded', () => this._emit());
        extApi(session).on?.('extension-unloaded', () => this._emit());
        // NOTE: devtools_page loading is deliberately NOT done here. It used to
        // be, and that ran before any tab existed, so chrome.devtools.
        // inspectedWindow.tabId resolved to -1 — which breaks React DevTools,
        // since it uses that id to connect its backend. Discovery is lazy
        // instead (ipc/extensions.js 'devtools-panels-list'), by which point
        // there is a real tab to inspect.
        this._emit();
    }
    // ── Tab wiring (called from Tabs) ──────────────────────────────────────────
    addTab(webContents, browserWindow) {
        try {
            // Route to the host owning this tab's session — a tab registered with
            // the wrong host is invisible to chrome.tabs, which is what broke
            // tab-specific extensions outside the default space.
            this._hostFor(webContents)?.addTab(webContents, browserWindow);
        }
        catch (e) { log.debug('extensions', 'addTab', e); }
    }
    selectTab(webContents) {
        this.closePopups(); // switching tabs dismisses an open action popup
        try {
            this._hostFor(webContents)?.selectTab(webContents);
        }
        catch (e) { log.debug('extensions', 'selectTab', e); }
    }
    /** Close any open browser-action popups. */
    closePopups() {
        for (const popup of [...this.popups]) {
            try {
                popup.destroy();
            }
            catch (e) { log.debug('extensions', 'closePopups', e); }
            this.popups.delete(popup);
        }
    }
    getContextMenuItems(webContents, params) {
        try {
            return this.instance?.getContextMenuItems(webContents, params) || [];
        }
        catch {
            return [];
        }
    }
    // ── chrome.tabs.* callbacks ────────────────────────────────────────────────
    _activeWindow() {
        return this.wm.getMostRecentlyFocusedWindow() || this.wm.getPrimaryWindow() || this.wm.getAllWindows()[0] || null;
    }
    _findTab(wc) {
        for (const wd of this.wm.getAllWindows()) {
            for (const [idx, tab] of wd.tabs.tabMap) {
                if (tab?.webContents === wc)
                    return { wd, idx };
            }
        }
        return null;
    }
    async _createTab(details) {
        const wd = this._activeWindow();
        if (!wd)
            throw new Error('no window');
        const idx = wd.tabs.createTab(null, details.active !== false);
        if (details.url)
            wd.tabs.loadUrl(idx, details.url);
        return [wd.tabs.tabMap.get(idx).webContents, wd.window];
    }
    _selectTab(wc) {
        const hit = this._findTab(wc);
        if (hit)
            hit.wd.tabs.showTab(hit.idx);
    }
    _removeTab(wc) {
        const hit = this._findTab(wc);
        if (hit)
            hit.wd.tabs.removeTab(hit.idx);
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
            if (rows.some(r => r.id === id))
                continue;
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
            if (rec?.path) {
                try {
                    await api.loadExtension(rec.path, LOAD_OPTIONS);
                }
                catch (e) { log.debug('extensions', 'setEnabled', e); }
            }
            delete this.disabled[id];
        }
        else {
            const ext = (api.getAllExtensions?.() || []).find(e => e.id === id);
            if (ext) {
                this.disabled[id] = this._disabledRecord(ext);
                try {
                    api.removeExtension(id);
                }
                catch (e) { log.debug('extensions', 'ext', e); }
            }
        }
        this._saveDisabled();
        this._emit();
        return true;
    }
    openOptions(id) {
        const ext = (extApi(this.session).getAllExtensions?.() || []).find(e => e.id === id);
        const url = ext ? this._optionsUrl(ext) : null;
        if (!url)
            return false;
        const wd = this._activeWindow();
        if (wd?.tabs) {
            // Open AND focus — a background tab looks like nothing happened.
            const idx = wd.tabs.createLazyTab(url, ext.name, false, false, true, true);
            try {
                wd.tabs.showTab(idx);
            }
            catch (e) { log.debug('extensions', 'ext', e); }
        }
        return true;
    }
    _saveDisabled() { try {
        fs.writeFileSync(this.disabledFile, JSON.stringify(this.disabled, null, 2));
    }
    catch (e) { log.debug('extensions', '_saveDisabled', e); } }
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
        const ext = await extApi(this.session).loadExtension(sourcePath, LOAD_OPTIONS);
        this._addUnpacked(sourcePath);
        this._emit();
        return { id: ext.id, name: ext.name };
    }
    async installCrx(crxPath) {
        const dest = path.join(app.getPath('userData'), 'extensions-unpacked', crypto.randomUUID());
        const buf = fs.readFileSync(crxPath);
        let verdict;
        try { verdict = verifyCrx(buf); }
        catch (e) { throw new Error('Refused .crx: ' + (e && e.message ? e.message : e)); }
        fs.mkdirSync(dest, { recursive: true });
        try {
            new AdmZip(buf.subarray(verdict.zipOffset)).extractAllTo(dest, true);
        }
        catch (e) {
            fs.rmSync(dest, { recursive: true, force: true });
            throw new Error('Could not unpack .crx: ' + (e && e.message ? e.message : e));
        }
        const root = fs.existsSync(path.join(dest, 'manifest.json')) ? dest : this._findManifestRoot(dest);
        if (!root) {
            fs.rmSync(dest, { recursive: true, force: true });
            throw new Error('No manifest.json in the .crx');
        }
        // The id must be the one the archive was signed with, not whatever
        // the manifest claims (crx-verify.js).
        try {
            const file = path.join(root, 'manifest.json');
            const { manifest, changed, warning } = reconcileManifestKey(JSON.parse(fs.readFileSync(file, 'utf-8')), verdict);
            if (warning)
                log.warn('extensions', `${path.basename(crxPath)}: ${warning}`);
            if (changed)
                fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
        }
        catch (e) {
            fs.rmSync(dest, { recursive: true, force: true });
            throw new Error('Refused .crx: ' + (e && e.message ? e.message : e));
        }
        return this.installUnpacked(root);
    }
    async remove(id) {
        // Note where it lives first: once unloaded, the path is gone with it.
        const loaded = (extApi(this.session).getAllExtensions?.() || []).find(e => e.id === id);
        const extPath = loaded?.path || this.disabled[id]?.path || null;
        try { require('./ext-proxy').clear(id); }
        catch (e) { log.debug('extensions', 'remove', e); }
        require('./ext-permissions').revokeAll(id);
        // A disabled extension isn't loaded, so uninstall would no-op — just drop it.
        if (this.disabled[id]) {
            this._removeUnpackedById(id, extPath);
            delete this.disabled[id];
            this._saveDisabled();
            this._emit();
            return true;
        }
        try {
            await webStore.uninstallExtension(id, { session: this.session });
        }
        catch {
            try {
                extApi(this.session).removeExtension(id);
            }
            catch (e) { log.debug('extensions', 'remove', e); }
        }
        this._removeUnpackedById(id, extPath);
        this._emit();
        return true;
    }
    // ── Unpacked registry ──────────────────────────────────────────────────────
    _readUnpacked() {
        try {
            const a = JSON.parse(fs.readFileSync(this.unpackedFile, 'utf-8'));
            return Array.isArray(a) ? a : [];
        }
        catch {
            return [];
        }
    }
    _writeUnpacked(list) { try {
        fs.writeFileSync(this.unpackedFile, JSON.stringify(list, null, 2));
    }
    catch (e) { log.debug('extensions', '_writeUnpacked', e); } }
    _addUnpacked(dir) { const l = this._readUnpacked(); if (!l.includes(dir)) {
        l.push(dir);
        this._writeUnpacked(l);
    } }
    /**
     * Forget an unpacked extension so it does not come back on the next start.
     * A folder the user picked is left on disk (it is theirs); the copy we
     * extracted from a .crx into userData is ours, so it goes.
     */
    _removeUnpackedById(id, extPath) {
        if (!extPath)
            return;
        const norm = (p) => {
            const r = path.resolve(String(p));
            return process.platform === 'win32' ? r.toLowerCase() : r;
        };
        const target = norm(extPath);
        const list = this._readUnpacked();
        const kept = list.filter(dir => norm(dir) !== target);
        if (kept.length !== list.length)
            this._writeUnpacked(kept);
        const crxRoot = norm(path.join(app.getPath('userData'), 'extensions-unpacked')) + path.sep;
        if (target.startsWith(crxRoot)) {
            // Remove the whole extraction folder, not just a nested manifest root.
            const top = path.join(app.getPath('userData'), 'extensions-unpacked', target.slice(crxRoot.length).split(path.sep)[0]);
            try { fs.rmSync(top, { recursive: true, force: true }); }
            catch (e) { log.warn('extensions', `could not delete ${id}'s files`, e); }
        }
    }
    _findManifestRoot(dir) {
        if (fs.existsSync(path.join(dir, 'manifest.json')))
            return dir;
        let entries = [];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return null;
        }
        const subs = entries.filter(e => e.isDirectory());
        for (const s of subs) {
            const found = this._findManifestRoot(path.join(dir, s.name));
            if (found)
                return found;
        }
        return null;
    }
}

module.exports = new Extensions();
module.exports.describePermissions = describePermissions;