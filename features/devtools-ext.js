/**
 * chrome.devtools.* — DevTools-panel extensions (React DevTools, Vue DevTools…).
 *
 * WHAT CHROME DOES: when you open DevTools, Chrome loads the extension's
 * `devtools_page` INSIDE the DevTools frontend. That page calls
 * chrome.devtools.panels.create() and its panel appears as a tab next to
 * Elements/Console.
 *
 * WHAT ELECTRON DOES: nothing. `devtools_page` is ignored entirely and
 * chrome.devtools does not exist, so these extensions install and are simply
 * inert — there is no hook to load a page into Electron's DevTools frontend.
 *
 * WHAT THIS DOES INSTEAD: loads the devtools_page ourselves in a hidden view
 * (tagged with ?__inkDevtools=1 so the preload knows to install the API), lets
 * it register panels, and renders those panels in OUR side panel rather than
 * inside DevTools. inspectedWindow.eval runs against the active tab.
 *
 * WHAT STILL CANNOT WORK, and why it is not faked:
 *   - panels.elements / panels.sources sidebars: they attach to the DevTools
 *     Elements tree, which we have no access to. createSidebarPane() resolves
 *     with an object whose setters are no-ops.
 *   - inspectedWindow.getResources / the Network HAR: these come from the
 *     DevTools backend's resource tracking. getHAR returns an empty log rather
 *     than a fabricated one.
 * A panel that depends on those degrades; one that only needs eval + messaging
 * (which is how React and Vue DevTools mainly work) has what it needs.
 */
'use strict';
const log = require('./log');
const { WebContentsView } = require('electron');

// extension id → { view, panels: [{ id, title, iconPath, pagePath }] }
const hosts = new Map();

/** Extensions in this session that declare a devtools_page. */
function candidates(session) {
    const api = session.extensions || session;
    const out = [];
    try {
        for (const ext of api.getAllExtensions?.() || []) {
            const page = ext.manifest?.devtools_page;
            if (page)
                out.push({ id: ext.id, name: ext.name, page: String(page).replace(/^\/+/, '') });
        }
    }
    catch (e) { log.debug('devtools-ext', 'candidates', e); }
    return out;
}

/**
 * Boot an extension's devtools page so it can register its panels. The view is
 * never shown — it is the equivalent of Chrome's hidden devtools_page context.
 */
async function ensureHost(wd, ext, session) {
    const existing = hosts.get(ext.id);
    if (existing?.view && !existing.view.webContents.isDestroyed())
        return existing;
    const view = new WebContentsView({
        webPreferences: {
            ...(session ? { session } : {}),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    const rec = { view, panels: [], extensionId: ext.id, name: ext.name };
    hosts.set(ext.id, rec);
    // Parented but kept at zero size: it must exist in a window to get a
    // renderer, and must never be visible.
    view.setBounds({ x: -10000, y: -10000, width: 1, height: 1 });
    try { wd.window.contentView.addChildView(view); }
    catch (e) { log.debug('devtools-ext', 'ensureHost', e); }
    const url = `chrome-extension://${ext.id}/${ext.page}?__inkDevtools=1`;
    try { await view.webContents.loadURL(url); }
    catch (e) { console.error(`[devtools] ${ext.id}: ${e.message}`); }
    return rec;
}

/** Called from IPC when a devtools page registers a panel. */
function registerPanel(extensionId, panel) {
    const rec = hosts.get(extensionId);
    if (!rec)
        return null;
    const id = `${extensionId}:${rec.panels.length}`;
    const entry = {
        id,
        title: panel.title || rec.name || 'Panel',
        iconPath: panel.iconPath || null,
        pagePath: String(panel.pagePath || '').replace(/^\/+/, ''),
        extensionId,
    };
    rec.panels.push(entry);
    log.debug('devtools-ext', `${rec.name || extensionId} registered panel "${entry.title}"`);
    return entry;
}

/** Every panel currently registered, across extensions. */
function listPanels() {
    const out = [];
    for (const rec of hosts.values())
        out.push(...rec.panels.map(p => ({ ...p, extensionName: rec.name })));
    return out;
}

/**
 * Load every devtools_page in this window's session, so their panels register.
 * Cheap enough to do on demand (usually zero or one extension).
 */
async function discover(wd) {
    let session = null;
    try {
        const profiles = require('./profiles');
        session = profiles.sessionFor(wd.profileId || '1');
    }
    catch (e) { log.debug('devtools-ext', 'discover', e); }
    const found = candidates(session || require('electron').session.defaultSession);
    for (const ext of found)
        await ensureHost(wd, ext, session);
    return listPanels();
}

/** Show a registered panel in the side panel column. */
async function openPanel(wd, panelId, wm) {
    const panel = listPanels().find(p => p.id === panelId);
    if (!panel)
        throw new Error('no such panel');
    const sidePanel = require('./side-panel');
    sidePanel.setOptions(panel.extensionId, { path: panel.pagePath, enabled: true });
    return sidePanel.open(panel.extensionId, {}, wm);
}

/**
 * True only for a devtools_page view this module loaded. chrome.devtools.* IPC
 * must come from one of these: every extension page and worker can reach the
 * raw bridge, and inspectedWindow.eval runs arbitrary code in a tab.
 */
function isHostSender(sender) {
    if (!sender) return false;
    for (const rec of hosts.values())
        if (rec.view?.webContents === sender && !sender.isDestroyed()) return true;
    return false;
}

/**
 * The tab a devtools page is inspecting — always the active one, and only a
 * web page: never an internal page (Settings, the NTP…), whose preloads carry
 * privileged bridges such as password reveal.
 */
function inspectedTab(wd) {
    try {
        const wc = wd?.tabs?.tabMap?.get(wd.tabs.activeTabIndex)?.webContents || null;
        return wc && /^https?:/i.test(wc.getURL()) ? wc : null;
    }
    catch { return null; }
}

function teardown(wd) {
    for (const [id, rec] of hosts) {
        try { wd?.window?.contentView?.removeChildView(rec.view); }
        catch (e) { log.debug('devtools-ext', 'for', e); }
        try { rec.view.webContents.close(); }
        catch (e) { log.debug('devtools-ext', 'for', e); }
        hosts.delete(id);
    }
}

module.exports = { discover, listPanels, registerPanel, openPanel, inspectedTab, isHostSender, teardown, candidates };
