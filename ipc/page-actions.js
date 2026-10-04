/**
 * IPC handlers — the page-actions panel.
 *
 * The utility bar used to carry eight trailing icons, several of them hidden
 * until they applied, so the row changed width as you browsed. They collapse
 * into one button now; this module owns the panel behind it.
 *
 * It deliberately holds NO state. The chrome renderer already tracks which
 * actions apply to the active tab — it is what used to show and hide those
 * icons — so it sends that down on open, and an action press is routed straight
 * back to the chrome, which already has the handler for it. Anything else would
 * be a second copy of "is this page bookmarked?" waiting to disagree with the
 * first.
 */
const log = require('../features/log');
const { signalEnter, playOutThenHide } = require('../features/overlay-anim');
const path = require('path');
const { resolveAppFile } = require('../app-paths');
const { WebContentsView, clipboard } = require('electron');
const { panelBounds, PANEL_RADIUS, W_SM } = require('../features/overlay-bounds');

const PANEL_W = W_SM;
/* Sized to the content: one action row, three rows, a separator pair and the
   security line. */
const PANEL_H = 236;

async function ensurePanel(wd) {
    if (wd.pageActions) {
        if (wd.pageActionsReady)
            await wd.pageActionsReady;
        return wd.pageActions;
    }
    const view = new WebContentsView({
        webPreferences: {
            preload: path.join(__dirname, '../preload/page-actions-preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            transparent: true,
        },
    });
    view.setBackgroundColor('#00000000');
    /* The view is rounded to match the card, and the card fills it exactly.
       This panel briefly carried a shadow gutter — a transparent margin inside
       the view so a drop shadow had somewhere to render. Panels do not have
       drop shadows any more (renderer/styles/surface.css), so that margin was
       just a 12px transparent border swallowing clicks around the panel. */
    try { view.setBorderRadius(PANEL_RADIUS); }
    catch (e) { log.debug('page-actions', 'setBorderRadius', e); }
    view.setVisible(false);
    wd.pageActions = view;
    wd.window.contentView.addChildView(view);
    /* Clicking anywhere else closes it — focus leaving the view is the one signal
       the chrome and the page both produce.

       The grace period is not optional. Showing a WebContentsView and focusing
       it produces a burst of focus churn, and a blur inside that burst closed
       the panel between opening and the user's click landing — so every row
       press did nothing at all. features/permission-ui.js carries the same
       guard for the same reason. */
    view.webContents.on('blur', () => {
        if (Date.now() - (wd.pageActionsShownAt || 0) < 300)
            return;
        if (wd.pageActionsOpen)
            hidePanel(wd);
    });
    view.webContents.loadFile(resolveAppFile('renderer/PageActions/index.html'));
    wd.pageActionsReady = new Promise(res => view.webContents.once('did-finish-load', () => res()));
    await wd.pageActionsReady;
    return view;
}

function hidePanel(wd) {
    if (!wd?.pageActions)
        return false;
    wd.pageActionsOpen = false;
    // Fade the card out (P1-6), then hide the view and hand focus back.
    playOutThenHide(wd.pageActions, () => {
        try { wd.window.webContents.focus(); }
        catch (e) { log.debug('page-actions', 'refocus', e); }
    });
    return true;
}

function register(ipcMain, { wm }) {
    ipcMain.handle('page-actions-toggle', async (_e, anchor, state) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd)
            return false;
        if (wd.pageActionsOpen)
            return hidePanel(wd);
        try {
            const view = await ensurePanel(wd);
            view.setBounds(panelBounds(wd.window, {
                anchor: anchor || null, width: PANEL_W, height: PANEL_H,
            }));
            // Raise above the active tab's view (CLAUDE.md invariant 4).
            try {
                wd.window.contentView.removeChildView(view);
                wd.window.contentView.addChildView(view);
            }
            catch (e) { log.debug('page-actions', 'raise', e); }
            view.setVisible(true);
            wd.pageActionsOpen = true;
            wd.pageActionsShownAt = Date.now();
            try { view.webContents.send('page-actions-state', state || {}); }
            catch (e) { log.debug('page-actions', 'state', e); }
            signalEnter(view); // P1-6 fade-in
            try { view.webContents.focus(); }
            catch (e) { log.debug('page-actions', 'focus', e); }
            return true;
        }
        catch (err) {
            log.warn('page-actions', 'toggle', err);
            return false;
        }
    });

    /* An action press goes back to the CHROME, which already owns every one of
       these behaviours — the panel only says which was pressed.

       `copy-link` is the exception and is done HERE. navigator.clipboard in a
       renderer needs that renderer to be focused, and the panel has just taken
       focus to be clicked at all — so the copy either threw or hung waiting on
       a permission prompt that never came. Electron's clipboard has no such
       requirement. */
    ipcMain.handle('page-actions-run', (_e, action) => {
        for (const wd of wm.getAllWindows()) {
            if (wd.pageActions?.webContents !== _e.sender)
                continue;
            const name = String(action || '');
            if (name === 'copy-link') {
                try {
                    const t = wd.tabs;
                    const url = t && t.tabUrls.get(t.activeTabIndex);
                    if (url && /^https?:/i.test(url))
                        clipboard.writeText(url);
                }
                catch (e) { log.debug('page-actions', 'copy-link', e); }
                return true;
            }
            try { wd.window.webContents.send('page-action', name); }
            catch (e) { log.debug('page-actions', 'run', e); }
            return true;
        }
        return false;
    });

    ipcMain.handle('page-actions-close', (_e) => {
        for (const wd of wm.getAllWindows()) {
            if (wd.pageActions?.webContents === _e.sender)
                return hidePanel(wd);
        }
        return false;
    });
}

module.exports = { register, hidePanel };
