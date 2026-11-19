'use strict';
/**
 * Click-outside dismissal for every UI popup, in ONE place.
 *
 * Each popup (app menu, downloads, extensions, theme panel, page actions, site
 * info, bookmark prompt, bookmark-folder dropdown, context menu, permission
 * prompt, save-password prompt) is its own WebContentsView, and an extension's
 * action popup is its own child window, so no single DOM sees every click.
 * The popups used to each guess at dismissal from their own corner — a chrome
 * `click` listener here, a view `blur` there — and every guess had holes: a
 * press on another overlay, the side panel, a drag region or a second app left
 * the popup standing.
 *
 * This watches from main instead, where every surface reports:
 *   - a mouse/touch press in ANY webContents of the window (page, overlay, side
 *     panel, find bar, …) closes every open popup except the one pressed in;
 *   - a press in the chrome itself closes the anchored popups unless it lands
 *     on their own toolbar button (that button toggles; the chrome renderer
 *     handles it). The other popups hold focus, so a chrome press blurs them
 *     and their own blur path closes them;
 *   - the window losing focus (another app, a second window) closes them all -
 *     extension action popups included, which their library deliberately keeps
 *     open when focus leaves the app (unless the popup itself took focus);
 *   - presses the OS keeps for itself (caption, drag regions, resize borders)
 *     arrive through dismissAll() from the window hooks in ipc/menu.js and
 *     features/window-manager.js.
 * The popups' own paths stay as they were; closing twice is a no-op.
 */
const log = require('../features/log');
const { app, webContents } = require('electron');

const inRect = (r, x, y) => !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

// Required lazily: these modules require features/ that may require us back.
const POPUPS = [
    {
        name: 'menu',
        isOpen: wd => !!wd.menu,
        view: wd => wd.menu,
        anchor: wd => wd.menuAnchor,
        close: wd => require('./utils').closeWindowMenu(wd),
    },
    {
        name: 'folder-dropdown',
        isOpen: wd => !!wd.folderDropdown,
        view: wd => wd.folderDropdown,
        close: wd => require('./utils').closeFolderDropdown(wd),
    },
    {
        name: 'bookmark-prompt',
        isOpen: wd => !!wd.bookmarkPrompt,
        view: wd => wd.bookmarkPrompt,
        close: wd => {
            require('./utils').closeBookmarkPrompt(wd);
            try { wd.window.webContents.send('bookmark-prompt-closed'); }
            catch (e) { log.debug('popup-dismiss', 'bookmark-prompt-closed', e); }
        },
    },
    {
        name: 'downloads',
        isOpen: wd => !!wd.downloadsPanelOpen,
        view: wd => wd.downloadsPanel,
        anchor: wd => wd.downloadsPanelAnchor,
        close: wd => require('./downloads').hidePanel(wd),
    },
    {
        name: 'extensions',
        isOpen: wd => !!wd.extensionsPanelOpen,
        view: wd => wd.extensionsPanel,
        anchor: wd => wd.extensionsPanelAnchor,
        close: wd => require('./extensions').hidePanel(wd),
    },
    {
        name: 'theme-panel',
        isOpen: wd => !!wd.themePanelOpen,
        view: wd => wd.themePanel,
        close: wd => require('./theme-panel').hidePanel(wd),
    },
    {
        name: 'page-actions',
        isOpen: wd => !!wd.pageActionsOpen,
        view: wd => wd.pageActions,
        close: wd => require('./page-actions').hidePanel(wd),
    },
    {
        name: 'site-info',
        isOpen: wd => !!wd.siteInfoView,
        view: wd => wd.siteInfoView,
        close: wd => require('./site-info').closePanel(wd),
    },
    {
        name: 'ctxmenu',
        isOpen: wd => !!wd.ctxMenuOpen,
        view: wd => wd.ctxMenu,
        close: wd => require('./ctxmenu').hideMenu(wd),
    },
    {
        // Click-away parks the request behind its chip (Chrome's quiet path);
        // the site's request is not answered.
        name: 'permission-prompt',
        isOpen: wd => !!wd.permShowing && Date.now() - (wd.permShownAt || 0) > 250,
        view: wd => wd.permView,
        close: wd => require('../features/permission-ui').dismiss(wd),
    },
    {
        name: 'password-prompt',
        isOpen: wd => { try { return !!wd.passwordPrompt?.getVisible?.(); } catch { return false; } },
        view: wd => wd.passwordPrompt,
        close: wd => wd.passwordPrompt?.setVisible(false),
    },
    {
        // Extension action popups: child windows, so a press can never land
        // "inside" one from here. No anchor: a chrome press may be the action
        // button opening one, and the renderer owns that strip.
        name: 'action-popups',
        isOpen: wd => actionPopupsOf(wd).length > 0,
        view: () => null,
        close: wd => {
            for (const p of actionPopupsOf(wd)) {
                // Focus moved INTO the popup: it is being used, not left.
                if (p.browserWindow?.isFocused())
                    continue;
                try { p.destroy(); }
                catch (e) { log.debug('popup-dismiss', 'action popup', e); }
            }
        },
    },
];

/** Live extension action popups whose parent is `wd`'s window. */
function actionPopupsOf(wd) {
    let popups;
    try { popups = require('../features/extensions').popups; }
    catch { return []; }
    if (!popups || !popups.size)
        return [];
    return [...popups].filter(p => {
        try { return !p.isDestroyed?.() && p.parent === wd.window; }
        catch { return false; }
    });
}

function viewWc(view) {
    try { return view?.webContents || null; }
    catch { return null; }
}

function closeOne(wd, p) {
    try { p.close(wd); }
    catch (e) { log.warn('popup-dismiss', `close ${p.name}`, e); }
}

/** Close every popup in `wd` (the OS-owned presses and window changes). */
function dismissAll(wd) {
    if (!wd)
        return;
    for (const p of POPUPS)
        if (p.isOpen(wd))
            closeOne(wd, p);
}

const PRESS = new Set(['mouseDown', 'touchStart', 'gestureTapDown']);

const anyOpen = wd => POPUPS.some(p => { try { return p.isOpen(wd); } catch { return false; } });

function onPress(wd, wc, input) {
    if (!wd.window || wd.window.isDestroyed())
        return;
    const fromChrome = wc === wd.window.webContents;
    for (const p of POPUPS) {
        if (!p.isOpen(wd) || viewWc(p.view(wd)) === wc)
            continue; // closed, or the press is inside it
        if (fromChrome) {
            // Only popups with a known toolbar button are judged here: a press
            // on that button is its toggle, and the renderer owns it.
            const anchor = p.anchor?.(wd);
            if (!anchor || inRect(anchor, input.x, input.y))
                continue;
        }
        closeOne(wd, p);
    }
    if (!anyOpen(wd))
        disarm(wd);
}

/*
 * The press listeners are ARMED only while a popup is open. `input-event`
 * hands main every input event of a surface — each mouse move, wheel tick and
 * key — so a listener left on every tab all the time made the whole app lag.
 * Each popup's open path calls arm(wd); the listeners come off as soon as no
 * popup is open (checked on every press, and by a slow sweep for the popups
 * that close by other routes).
 */
let wmRef = null;
const armed = new Map(); // wd -> { wcs: Map<webContents, listener>, sweep }

function arm(wd) {
    if (!wmRef || !wd?.window || wd.window.isDestroyed())
        return;
    let st = armed.get(wd);
    if (!st) {
        st = { wcs: new Map(), sweep: null };
        st.sweep = setInterval(() => {
            try {
                if (wd.window.isDestroyed() || !anyOpen(wd))
                    disarm(wd);
            }
            catch (e) { log.debug('popup-dismiss', 'sweep', e); disarm(wd); }
        }, 500);
        armed.set(wd, st);
    }
    // Every surface of this window — re-collected on each arm, so tabs and
    // overlays created since the last one are covered too.
    for (const wc of webContents.getAllWebContents()) {
        if (st.wcs.has(wc))
            continue;
        try {
            if (wc.isDestroyed() || wmRef.getWindowByWebContents(wc) !== wd)
                continue;
        }
        catch (e) { log.debug('popup-dismiss', 'resolve surface', e); continue; }
        const fn = (_e, input) => {
            if (input && PRESS.has(input.type))
                onPress(wd, wc, input);
        };
        wc.on('input-event', fn);
        st.wcs.set(wc, fn);
    }
}

function disarm(wd) {
    const st = armed.get(wd);
    if (!st)
        return;
    armed.delete(wd);
    clearInterval(st.sweep);
    for (const [wc, fn] of st.wcs) {
        try {
            if (!wc.isDestroyed())
                wc.removeListener('input-event', fn);
        }
        catch (e) { log.debug('popup-dismiss', 'disarm', e); }
    }
}

function watchWindow(wm, win) {
    if (!win || win.__northstarPopupBlur)
        return;
    win.__northstarPopupBlur = true;
    win.on('blur', () => {
        // Opening a focused overlay churns focus and can blur the window for a
        // moment; only a window that is STILL unfocused shortly after has
        // really lost the user.
        setTimeout(() => {
            try {
                if (win.isDestroyed() || win.isFocused())
                    return;
                // A child window taking focus (an extension's action popup)
                // is still this window being used; the action-popups entry
                // keeps a focused popup open.
                dismissAll(wm.getWindowByWebContents(win.webContents));
            }
            catch (e) { log.debug('popup-dismiss', 'window blur', e); }
        }, 60);
    });
}

function register(_ipcMain, { wm }) {
    wmRef = wm;
    const { BrowserWindow } = require('electron');
    for (const w of BrowserWindow.getAllWindows())
        watchWindow(wm, w);
    app.on('browser-window-created', (_e, w) => watchWindow(wm, w));
    // An action popup is the one popup no ipc/ open path arms for.
    try {
        require('../features/extensions').onPopupCreated?.((popup) => {
            try { arm(wm.getWindowByWebContents(popup.parent?.webContents)); }
            catch (e) { log.debug('popup-dismiss', 'arm for action popup', e); }
        });
    }
    catch (e) { log.warn('popup-dismiss', 'could not watch extension popups', e); }
}

module.exports = { register, dismissAll, arm };
