'use strict';
/**
 * Firefox-style permission doorhanger.
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

const path = require('path');
const { WebContentsView } = require('electron');

const PANEL_W = 330;

let wmRef = null;
let seq   = 0;
const pending = new Map(); // id → { resolve, wd }

function init(wm) { wmRef = wm; }

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
    if (!wmRef) return null;
    for (const wd of wmRef.getAllWindows()) {
        if (wd.permView && wd.permView.webContents === wc) return wd;
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
        wd.permQueue.push({ id, data });
        showNext(wd);
    });
}

async function showNext(wd) {
    if (!wd || wd.window.isDestroyed()) return;
    if (wd.permShowing) return;                       // one at a time
    const item = (wd.permQueue || [])[0];
    if (!item) return;
    wd.permShowing = item.id;

    let anchor = { x: 12, y: 86 };
    try {
        const r = await wd.window.webContents.executeJavaScript(ANCHOR_JS, true);
        if (r && Number.isFinite(r.x) && Number.isFinite(r.y)) anchor = r;
    } catch {}
    if (wd.window.isDestroyed()) return;

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
        wd.permView = view;
        wd.window.contentView.addChildView(view);
        view.webContents.loadFile('renderer/PermissionPrompt/index.html');
        await new Promise(res => view.webContents.once('did-finish-load', res));
        if (wd.window.isDestroyed()) return;

        // Dismiss (deny THIS request, record nothing — the site may re-ask)
        // when the panel or window loses focus — clicking the page or chrome
        // cancels the request, like Firefox.
        const onBlur = () => {
            if (Date.now() - (wd.permShownAt || 0) < 250) return; // ignore focus churn at open
            if (wd.permShowing) decide(wd.permShowing, false, false, true);
        };
        view.webContents.on('blur', onBlur);
        // If the view was recreated (webContents crashed), drop the previous
        // window-blur hook so listeners don't pile up on the BrowserWindow.
        if (wd.permWindowBlur) { try { wd.window.removeListener('blur', wd.permWindowBlur); } catch {} }
        wd.permWindowBlur = onBlur;
        wd.window.on('blur', onBlur);
    } else {
        // Raise above the (possibly newer) tab view.
        try { wd.window.contentView.removeChildView(view); wd.window.contentView.addChildView(view); } catch {}
    }

    const winW = wd.window.getBounds().width;
    const left = Math.max(8, Math.min(Math.round(anchor.x) - 10, winW - PANEL_W - 8));
    const top  = Math.max(2, Math.round(anchor.y) + 4);
    view.setBounds({ x: left, y: top, width: PANEL_W, height: 150 });
    view.setVisible(true);
    wd.permShownAt = Date.now();
    view.webContents.send('permission-data', { id: item.id, ...item.data });
    try { view.webContents.focus(); } catch {}
}

function hide(wd) {
    if (wd && wd.permView && !wd.permView.webContents.isDestroyed()) {
        try { wd.permView.setVisible(false); } catch {}
    }
}

// dismissed=true → the doorhanger was clicked away / Esc'd: the request is
// denied but nothing is recorded, so the site may ask again (Firefox-style).
function decide(id, allowed, remember, dismissed) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    const wd = entry.wd;
    if (wd) {
        wd.permQueue = (wd.permQueue || []).filter(q => q.id !== id);
        if (wd.permShowing === id) { wd.permShowing = null; hide(wd); }
    }
    entry.resolve({ allowed: !!allowed, remember: !!remember, dismissed: !!dismissed });
    if (wd) setTimeout(() => showNext(wd), 0);
}

function register(ipcMain, { wm }) {
    init(wm);

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
                const b = wd.permView.getBounds();
                wd.permView.setBounds({ ...b, height: Math.max(70, Math.min(320, Math.round(height))) });
            } catch {}
        }
        return true;
    });
}

module.exports = { init, request, register };
