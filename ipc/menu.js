/**
 * IPC handlers — hamburger menu overlay and click-outside dismissal.
 *
 * The menu is a transparent WebContentsView that slides in from the top-right.
 * It must be dismissed when the user clicks anywhere outside it.
 */
const log = require('../features/log');
const path = require('path');
const { resolveAppFile } = require('../app-paths');
const { WebContentsView } = require('electron');
const { closeWindowMenu, closeFolderDropdown } = require('./utils');
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

function register(ipcMain, { wm }) {
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
        wd.menu.webContents.once('did-finish-load', () => {
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
        const onBlur = () => { if (Date.now() - shownAt >= 250) closeOnce(); };
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
    ipcMain.handle('recently-closed-menu', (_e, rect) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd)
            return false;
        let x = 0, y = 0;
        try {
            const b = wd.menu.getBounds();
            x = b.x + (rect?.left || 0);
            y = b.y + (rect?.top || 0);
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
        if (wd.bookmarkPrompt) {
            wd.window.contentView.removeChildView(wd.bookmarkPrompt);
            wd.bookmarkPrompt = null;
        }
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
                if (outside) {
                    wd.window.contentView.removeChildView(wd.bookmarkPrompt);
                    wd.bookmarkPrompt = null;
                }
            }
            catch {
                wd.window.contentView.removeChildView(wd.bookmarkPrompt);
                wd.bookmarkPrompt = null;
            }
        }
    });
}

module.exports = { register };