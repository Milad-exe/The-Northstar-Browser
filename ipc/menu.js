/**
 * IPC handlers — hamburger menu overlay and click-outside dismissal.
 *
 * The menu is a transparent WebContentsView that slides in from the top-right.
 * It must be dismissed when the user clicks anywhere outside it.
 */
const log = require('../features/log');
const path = require('path');
const { resolveAppFile } = require('../app-paths');
const { WebContentsView, webContents, app, BrowserWindow } = require('electron');
const { closeWindowMenu, closeFolderDropdown, closeBookmarkPrompt } = require('./utils');
const { panelBounds, PANEL_RADIUS, W_MD } = require('../features/overlay-bounds');
// W_MD (340): at W_SM "New private window" + its Ctrl+Shift+N hint truncated,
// and a menu label never truncates (U1-3).
const MENU_WIDTH = W_MD;
// Rows (12 x --row-h) + the zoom row + four separators + the card's own
// padding. Measured from the rendered card rather than guessed: an oversized
// menu window is invisible but still swallows clicks below the card.
const MENU_HEIGHT = 520; // 12 rows + the zoom row + separators, at --row-h
// (12 rows + zoom + separators; adding a row without raising this clips the menu)

// The menu CARD carries a 4px transparent margin — body padding in
// renderer/Menu/styles.css — so its drop shadow has room inside the view.
// overlay-bounds aligns the VIEW's outer edge to the page card's edge, but that
// margin then pushed the visible card 4px in (and 4px down), which read as the
// menu sitting slightly off the tab view. Re-anchoring the view by the bleed
// lands the card itself — not the view — flush with the page card's top and
// right edges. Keep in step with the body padding in Menu/styles.css.
const CARD_BLEED = 4;
const alignCard = (rect) => ({ ...rect, x: rect.x + CARD_BLEED, y: rect.y - CARD_BLEED });

// Win32: the frameless window's resize borders are hit-tested by Windows. A
// press there reaches no page and moves no focus, so neither the click-outside
// path nor the menu's blur sees it — the menu just stayed open. The press lands
// on Chromium's child HWND, not this window, so its WM_NC*BUTTONDOWN never
// reaches a hook here; what does is the size/move loop Windows enters on that
// press (even with no movement after it). The NC button messages still cover
// a caption press that does land on the top-level window.
const WM_NCLBUTTONDOWN = 0x00A1;
const WM_NCRBUTTONDOWN = 0x00A4;
const WM_ENTERSIZEMOVE = 0x0231;
// Window changes that leave a popup menu stranded (Win+Up, Aero Snap, a drag
// on the border): a native menu closes on all of them.
const DISMISS_EVENTS = ['will-move', 'will-resize', 'maximize', 'unmaximize', 'minimize', 'enter-full-screen', 'leave-full-screen'];

/** Close the window's drop-down menus (app menu, bookmark folder). */
function dismissMenus(wd) {
    if (!wd)
        return;
    if (wd.menu)
        closeWindowMenu(wd);
    if (wd.folderDropdown)
        closeFolderDropdown(wd);
}

function watchWindow(win, wm) {
    if (!win || win.isDestroyed() || win.__northstarMenuWatch)
        return;
    win.__northstarMenuWatch = true;
    const dismiss = () => {
        try {
            if (win.isDestroyed())
                return;
            const wd = wm.getWindowByWebContents(win.webContents);
            if (wd && (wd.menu || wd.folderDropdown))
                dismissMenus(wd);
        }
        catch (e) { log.debug('menu', 'window dismiss', e); }
    };
    for (const ev of DISMISS_EVENTS)
        win.on(ev, dismiss);
    if (process.platform === 'win32') {
        // Deferred: the hook runs inside the window procedure.
        const later = () => setImmediate(dismiss);
        try {
            win.hookWindowMessage(WM_NCLBUTTONDOWN, later);
            win.hookWindowMessage(WM_NCRBUTTONDOWN, later);
            win.hookWindowMessage(WM_ENTERSIZEMOVE, later);
        }
        catch (e) { log.debug('menu', 'hookWindowMessage', e); }
    }
}

function register(ipcMain, { wm }) {
    // Every window, present and future (devtools and other non-browser windows
    // resolve to no window data and are left alone).
    for (const w of BrowserWindow.getAllWindows())
        watchWindow(w, wm);
    app.on('browser-window-created', (_e, w) => watchWindow(w, wm));
    // ── Open ─────────────────────────────────────────────────────────────────
    ipcMain.handle('open', (_e, anchor) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd)
            return;
        // Clicking the hamburger while the menu is up TOGGLES it shut. And when
        // that click closed it via the blur path below, the very same click also
        // arrives here as 'open' — so ignore an open that lands right after a
        // close, or the menu would flicker shut and straight back open.
        if (wd.menu || (Date.now() - (wd._menuClosedAt || 0) < 250)) {
            closeWindowMenu(wd);
            return;
        }
        // Anchor to the hamburger button so the panel drops from it (a toolbar
        // anchor still aligns to the page card's right edge — overlay-bounds.js).
        wd.menuAnchor = anchor || null;
        wd.menu = new WebContentsView({
            webPreferences: {
                preload: path.join(__dirname, '../preload/menu-preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
            },
        });
        wd.menu.setBackgroundColor('#00000000');
        try { wd.menu.setBorderRadius(PANEL_RADIUS); } catch (e) { log.debug('menu', 'open', e); }
        wd.window.contentView.addChildView(wd.menu);
        // While it is open, the strip's drag regions stand down (as for the
        // right-click menus, ctxmenu.js): a click there is then a click the
        // chrome sees, and "click outside" closes the menu.
        try { wd.window.webContents.send('menu-capture', true); }
        catch (e) { log.debug('menu', 'menu-capture on', e); }
        wd.menu.webContents.loadFile(resolveAppFile('renderer/Menu/index.html'));
        wd.menu.setBounds(alignCard(panelBounds(wd.window, { anchor: wd.menuAnchor, width: MENU_WIDTH, height: MENU_HEIGHT })));
        const cleanups = [];
        let fired = false;
        const closeOnce = () => {
            if (fired)
                return;
            fired = true;
            closeWindowMenu(wd);
        };
        // FOCUS the view once it has loaded: the keyboard (arrows / Enter /
        // Escape, wired in the renderer) needs it, and a click anywhere else then
        // BLURS it — the one dismiss signal that fires no matter where the click
        // lands (a page's native view never reported clicks reliably, so the menu
        // "wouldn't go away"). A short grace ignores the focus churn of opening.
        const shownAt = Date.now();
        const menuView = wd.menu;
        wd.menu.webContents.once('did-finish-load', () => {
            if (wd.menu !== menuView)
                return; // closed (or replaced) while it loaded
            // The press that opened the menu put focus on the chrome. If focus
            // is somewhere else by now, the user already clicked on (a page, an
            // embedded frame) while the menu was still loading — that click was
            // the dismissal, and focusing the menu here would steal focus back
            // and leave it open with nothing left to close it.
            try {
                const focused = webContents.getFocusedWebContents();
                if (focused && focused !== wd.window.webContents && focused !== menuView.webContents) {
                    closeOnce();
                    return;
                }
            }
            catch (e) { log.debug('menu', 'focus check', e); }
            // Belt-and-suspenders theme: hand the menu its space's theme directly
            // (the same id the runtime injects the sheet for), so a freshly built
            // view is never left wearing the default palette.
            try {
                const tr = require('../features/theme-runtime');
                wd.menu.webContents.send('theme-changed', tr.themeFor(wd.menu.webContents));
            }
            catch (e) { log.debug('menu', 'theme', e); }
            try { wd.menu.webContents.focus(); }
            catch (e) { log.debug('menu', 'focus', e); }
        });
        // A blur inside the opening grace is the focus churn of opening — but it
        // can also be a real click elsewhere. Look again once the grace is over
        // instead of dropping it: if the menu still doesn't hold focus, close.
        let graceCheck = null;
        const onBlur = () => {
            const age = Date.now() - shownAt;
            if (age >= 250) {
                closeOnce();
                return;
            }
            clearTimeout(graceCheck);
            graceCheck = setTimeout(() => {
                try {
                    if (wd.menu === menuView && !menuView.webContents.isDestroyed() && !menuView.webContents.isFocused())
                        closeOnce();
                }
                catch (e) { log.debug('menu', 'grace check', e); }
            }, 250 - age + 30);
        };
        cleanups.push(() => clearTimeout(graceCheck));
        wd.menu.webContents.on('blur', onBlur);
        cleanups.push(() => { try { wd.menu?.webContents.removeListener('blur', onBlur); } catch (e) { log.debug('menu', 'cleanup', e); } });
        wd.window.once('blur', closeOnce);
        cleanups.push(() => wd.window.removeListener('blur', closeOnce));
        wd.menuCleanups = cleanups;
    });
    // Size the overlay to the menu card's real height so nothing is clipped into
    // a scroll. panelBounds still trims it to the window, so a short window falls
    // back to scrolling — but a normal one shows every row. MENU_HEIGHT is just
    // the first-paint guess before this arrives.
    ipcMain.on('menu-report-height', (_e, h) => {
        const height = Math.max(0, Math.ceil(h || 0)); // up, never down: a lost pixel clips the last row
        if (!height)
            return;
        for (const wd of wm.getAllWindows()) {
            if (wd.menu?.webContents === _e.sender) {
                try { wd.menu.setBounds(alignCard(panelBounds(wd.window, { anchor: wd.menuAnchor || null, width: MENU_WIDTH, height }))); }
                catch (e) { log.debug('menu', 'report-height', e); }
                return;
            }
        }
    });
    // ── Recently closed ───────────────────────────────────────────────────────
    // The app menu's "Recently closed" row: close the app menu and open the
    // list (features/recently-closed.js) as a menu at that row.
    ipcMain.handle('recently-closed-menu', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd)
            return false;
        // Open where the app menu was — its top, against its right edge (the
        // overlay clamps the list into the window, so it lines up with the
        // menu's right side). At the clicked row it hung halfway down the
        // window, detached from the button that opened it.
        let x = 0, y = 0;
        try {
            const b = wd.menu.getBounds();
            x = b.x + b.width;
            y = b.y;
        }
        catch (e) { log.debug('menu', 'recently-closed anchor', e); }
        closeWindowMenu(wd);
        const tpl = require('../features/recently-closed').template(wd, wm);
        return require('../features/overlay-menu').popup(wd, tpl, x, y);
    });
    // ── Close ─────────────────────────────────────────────────────────────────
    ipcMain.handle('close-menu', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        closeWindowMenu(wd);
    });
    // ── Click-outside detection ───────────────────────────────────────────────
    // Any mousedown in a tab or floating WebContentsView sends this.
    // Close the menu, dismiss the bookmark prompt, and close the folder dropdown.
    ipcMain.on('content-view-click', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd)
            return;
        // The page was clicked, so the page is what the keyboard should be
        // aimed at — otherwise the chrome keeps focus and the NEXT press in
        // the page pays for the handover.
        try {
            if (!_e.sender.isDestroyed())
                _e.sender.focus();
        }
        catch (e) { log.debug('menu', 'content-view-click focus', e); }
        if (wd.menu)
            closeWindowMenu(wd);
        if (wd.bookmarkPrompt)
            closeBookmarkPrompt(wd);
        if (wd.folderDropdown)
            closeFolderDropdown(wd);
        // Forward click to chrome renderer only when it came from a child view
        // (e.g. a tab), not from the chrome renderer itself.
        if (_e.sender !== wd.window.webContents) {
            wd.window.webContents.send('content-clicked');
        }
    });
    // Click coordinates from the chrome renderer — close floating panels
    // if the click landed outside their bounds.
    // The overflow menu's New Tab opens the new-tab page, like every other
    // user-facing new-tab entry point.
    ipcMain.handle('menu-new-tab', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        // New tab → the new-tab page (P2 pivot: replaces the Palette).
        try { return wd.tabs ? wd.tabs.openInternalPage('home') : false; }
        catch { return false; }
    });
    // ── In-chrome menu bar (the Firefox-style Alt bar on frameless Windows) ─────
    // The bar's labels and every dropdown come from features/menu-bar.js, which
    // is the same eight menus the native bar uses on mac/Linux — see there.
    ipcMain.handle('menubar:labels', (_e) => {
        try { return require('../features/menu-bar').items(); }
        catch { return []; }
    });
    ipcMain.handle('menubar:open', (_e, index, anchor) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        try { return require('../features/menu-bar').openDropdown(wd, Number(index) || 0, anchor); }
        catch { return false; }
    });
    // The chrome reports when the bar opens/closes, so Shortcuts (which sees every
    // keystroke via before-input-event, regardless of which surface holds focus)
    // can drive the bar's mnemonics and arrows even while a page holds OS focus.
    ipcMain.on('menubar:state', (_e, open) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd) wd.menuBarOpen = !!open;
    });
    ipcMain.on('window-click', (_e, pos) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd)
            return;
        if (wd.menu) {
            try {
                const b = wd.menu.getBounds();
                const outside = pos.x < b.x || pos.x > b.x + b.width ||
                    pos.y < b.y || pos.y > b.y + b.height;
                if (outside)
                    closeWindowMenu(wd);
            }
            catch {
                closeWindowMenu(wd);
            }
        }
        if (wd.bookmarkPrompt) {
            try {
                const b = wd.bookmarkPrompt.getBounds();
                const outside = pos.x < b.x || pos.x > b.x + b.width ||
                    pos.y < b.y || pos.y > b.y + b.height;
                if (outside)
                    closeBookmarkPrompt(wd);
            }
            catch (e) {
                log.debug('menu', 'window-click prompt bounds', e);
                closeBookmarkPrompt(wd);
            }
        }
    });
}

module.exports = { register, dismissMenus };