'use strict';
/**
 * standard permission doorhanger.
 *
 * Instead of a native modal dialog (which greys out and blocks the whole tab),
 * permission prompts render as a small panel anchored just below the address-bar
 * lock icon — the page stays visible and interactive. Features/permission-prompt.js
 * calls request() from its session permission handler; this module shows the
 * panel on the window that owns the requesting tab and resolves with the user's
 * choice. Only one panel shows at a time per window; extra requests queue.
 *
 * The panel is a WebContentsView overlay (same technique as the site-info panel)
 * so it draws above the tab's WebContentsView.
 */
const log = require('./log');
const { panelBounds, PANEL_RADIUS, W_MD } = require('./overlay-bounds');
const path = require('path');
const { resolveAppFile } = require('../app-paths');
const { WebContentsView } = require('electron');
const PANEL_W = W_MD;
let wmRef = null;
let seq = 0;
const pending = new Map(); // id → { resolve, wd }
function init(wm) { wmRef = wm; }
/* The permission chip in the address field (chrome-ux P2-2). The chrome draws
   it; main says which tab it belongs to and what state it is in:
     pending  — a doorhanger is up for this tab's request
     parked   — the doorhanger was dismissed; the request waits (Chrome's quiet
                path) and clicking the chip reopens it
     decided  — allowed / blocked: the chip confirms, then collapses
     clear    — nothing to show */
function tabIndexOf(wd, wc) {
    try {
        for (const [i, t] of wd.tabs?.tabMap || [])
            if (t.webContents === wc) return i;
    }
    catch (e) { log.debug('permission-ui', 'tabIndexOf', e); }
    return null;
}
function chip(wd, payload) {
    try { if (wd && !wd.window.isDestroyed()) wd.window.webContents.send('perm-chip', payload); }
    catch (e) { log.debug('permission-ui', 'chip', e); }
}
// Read the on-screen rect of the lock icon from the chrome renderer so the
// panel points at it. Falls back to a sensible top-left position.
const ANCHOR_JS = `(() => {
    const el = document.getElementById('omni-icon')
            || document.querySelector('.omnibox')
            || document.getElementById('searchBar');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.bottom) };
})()`;
function findWdByOverlay(wc) {
    if (!wmRef)
        return null;
    for (const wd of wmRef.getAllWindows()) {
        if (wd.permView && wd.permView.webContents === wc)
            return wd;
    }
    return null;
}
/**
 * Show a permission doorhanger for the tab that owns `wc`.
 * data: { origin, action, iconType, checkbox }
 * Resolves { allowed, remember }. Resolves denied if there's no window.
 */
function request(wc, data) {
    const wd = wmRef && wmRef.getWindowByWebContents(wc);
    if (!wd || !wd.window || wd.window.isDestroyed()) {
        return Promise.resolve({ allowed: false, remember: false });
    }
    return new Promise((resolve) => {
        const id = ++seq;
        pending.set(id, { resolve, wd });
        wd.permQueue = wd.permQueue || [];
        wd.permQueue.push({ id, data, wc, tab: tabIndexOf(wd, wc) });
        showNext(wd);
    });
}
async function showNext(wd) {
    if (!wd || wd.window.isDestroyed())
        return;
    if (wd.permShowing)
        return; // one at a time
    const item = (wd.permQueue || [])[0];
    if (!item)
        return;
    wd.permShowing = item.id;
    let anchor = { x: 12, y: 86 };
    try {
        const r = await wd.window.webContents.executeJavaScript(ANCHOR_JS, true);
        if (r && Number.isFinite(r.x) && Number.isFinite(r.y))
            anchor = r;
    }
    catch (e) { log.debug('permission-ui', 'item', e); }
    if (wd.window.isDestroyed())
        return;
    let view = wd.permView;
    if (!view || view.webContents.isDestroyed()) {
        view = new WebContentsView({
            webPreferences: {
                preload: path.join(__dirname, '../preload/permission-prompt-preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
            },
        });
        view.setBackgroundColor('#00000000');
        /* The card fills the view now that it has no shadow to leave room for,
           so the view carries the same radius as every other flush panel. */
        try { view.setBorderRadius(PANEL_RADIUS) } catch (e) { log.debug('permission-ui', 'setBorderRadius', e); }
        wd.permView = view;
        wd.window.contentView.addChildView(view);
        view.webContents.loadFile(resolveAppFile('renderer/PermissionPrompt/index.html'));
        await new Promise(res => view.webContents.once('did-finish-load', res));
        if (wd.window.isDestroyed())
            return;
        // Dismiss (deny THIS request, record nothing — the site may re-ask)
        // when the panel or window loses focus — clicking the page or chrome
        // cancels the request.
        const onBlur = () => {
            if (Date.now() - (wd.permShownAt || 0) < 250)
                return; // ignore focus churn at open
            if (wd.permShowing)
                decide(wd.permShowing, false, false, true);
        };
        view.webContents.on('blur', onBlur);
        // If the view was recreated (webContents crashed), drop the previous
        // window-blur hook so listeners don't pile up on the BrowserWindow.
        if (wd.permWindowBlur) {
            try {
                wd.window.removeListener('blur', wd.permWindowBlur);
            }
            catch (e) { log.debug('permission-ui', 'onBlur', e); }
        }
        wd.permWindowBlur = onBlur;
        wd.window.on('blur', onBlur);
    }
    else {
        // Raise above the (possibly newer) tab view.
        try {
            wd.window.contentView.removeChildView(view);
            wd.window.contentView.addChildView(view);
        }
        catch (e) { log.debug('permission-ui', 'onBlur', e); }
    }
    // Hangs from the address field, like the site-info panel it sits beside.
    wd.permAnchor = { left: Math.round(anchor.x), bottom: Math.round(anchor.y) };
    // A first guess only; the page measures itself and calls back below.
    view.setBounds(panelBounds(wd.window, { anchor: wd.permAnchor, align: 'left', width: PANEL_W, height: 150 }));
    view.setVisible(true);
    wd.permShownAt = Date.now();
    view.webContents.send('permission-data', { id: item.id, ...item.data });
    chip(wd, { tab: item.tab, state: 'pending', iconType: item.data.iconType || 'generic' });
    try {
        view.webContents.focus();
    }
    catch (e) { log.debug('permission-ui', 'onBlur', e); }
}
function hide(wd) {
    if (wd && wd.permView && !wd.permView.webContents.isDestroyed()) {
        try {
            wd.permView.setVisible(false);
        }
        catch (e) { log.debug('permission-ui', 'hide', e); }
    }
}
// dismissed=true → the doorhanger was clicked away / Esc'd: the request is
// denied but nothing is recorded, so the site may ask again.
function decide(id, allowed, remember, dismissed) {
    const entry = pending.get(id);
    if (!entry)
        return;
    const wd = entry.wd;
    const item = wd && (wd.permQueue || []).find(q => q.id === id);
    if (wd) {
        wd.permQueue = (wd.permQueue || []).filter(q => q.id !== id);
        if (wd.permShowing === id) {
            wd.permShowing = null;
            hide(wd);
        }
    }
    // Dismissed (Esc / click-away): Chrome's quiet path. The request is NOT
    // answered — it waits, parked behind a chip, until the chip is clicked
    // (doorhanger again), the page navigates, or the tab closes (then denied,
    // nothing recorded).
    if (dismissed && item && item.tab != null && item.wc && !item.wc.isDestroyed()) {
        park(wd, item);
        setTimeout(() => showNext(wd), 0);
        return;
    }
    pending.delete(id);
    entry.resolve({ allowed: !!allowed, remember: !!remember, dismissed: !!dismissed });
    if (item && item.tab != null)
        chip(wd, dismissed ? { tab: item.tab, state: 'clear' }
            : { tab: item.tab, state: 'decided', allowed: !!allowed, iconType: item.data.iconType || 'generic' });
    if (wd)
        setTimeout(() => showNext(wd), 0);
}
function park(wd, item) {
    wd.permParked = wd.permParked || new Map();
    const prev = wd.permParked.get(item.tab);
    if (prev && prev.id !== item.id)
        settleParked(wd, prev); // one parked request per tab; the older one is denied
    wd.permParked.set(item.tab, item);
    // Leaving the page (or closing the tab) answers it: denied, nothing recorded.
    const onNav = (_e, _url, isInPlace, isMainFrame) => { if (isMainFrame && !isInPlace) settleParked(wd, item); };
    const onGone = () => settleParked(wd, item);
    item.unhook = () => {
        try { item.wc.removeListener('did-start-navigation', onNav); item.wc.removeListener('destroyed', onGone); }
        catch (e) { log.debug('permission-ui', 'unhook', e); }
    };
    item.wc.on('did-start-navigation', onNav);
    item.wc.once('destroyed', onGone);
    chip(wd, { tab: item.tab, state: 'parked', iconType: item.data.iconType || 'generic' });
}
function settleParked(wd, item) {
    if (wd.permParked?.get(item.tab) === item)
        wd.permParked.delete(item.tab);
    item.unhook?.();
    const entry = pending.get(item.id);
    if (!entry)
        return;
    pending.delete(item.id);
    entry.resolve({ allowed: false, remember: false, dismissed: true });
    chip(wd, { tab: item.tab, state: 'clear' });
}
/** The chip was clicked: bring a parked request's doorhanger back. */
function reopen(wd, tab) {
    const item = wd?.permParked?.get(tab);
    if (!item)
        return false;
    wd.permParked.delete(tab);
    item.unhook?.();
    wd.permQueue = wd.permQueue || [];
    wd.permQueue.unshift(item);
    showNext(wd);
    return true;
}
function register(ipcMain, { wm }) {
    init(wm);
    ipcMain.handle('permission-chip-click', (e) => {
        const wd = wm.getWindowByWebContents(e.sender);
        return wd ? reopen(wd, wd.tabs?.activeTabIndex) : false;
    });
    ipcMain.handle('permission-decide', (_e, payload) => {
        const { id, allowed, remember, dismissed } = payload || {};
        decide(id, !!allowed, !!remember, !!dismissed);
        return true;
    });
    // Panel reports its content height so we can size the overlay snugly.
    ipcMain.handle('permission-ui-resize', (e, height) => {
        const wd = findWdByOverlay(e.sender);
        if (wd && wd.permView && !wd.permView.webContents.isDestroyed()) {
            try {
                /* The reported height is the CARD's. It used to be clamped to
                   320, so a prompt with a long host or a longer translation was
                   simply cut off and grew a scrollbar; panelBounds already trims
                   to the window, which is the only ceiling that means anything. */
                wd.permView.setBounds(panelBounds(wd.window, {
                    anchor: wd.permAnchor, align: 'left', width: PANEL_W,
                    height: Math.max(70, Math.round(height)),
                }));
            }
            catch (e) { log.debug('permission-ui', 'permission-ui-resize', e); }
        }
        return true;
    });
}

module.exports = { init, request, register };