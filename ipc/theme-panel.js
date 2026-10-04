/**
 * IPC handlers — the theme popup.
 *
 * The same instrument as the Appearance section of Settings, hosted in a
 * WebContentsView so it can be raised over the chrome from the sidebar's
 * context menu. All of its behaviour lives in renderer/lib/theme-editor.js;
 * this module only owns the view, its bounds and its visibility.
 *
 * It opts into the shadow gutter (features/overlay-bounds.js): the view is
 * grown on every side and the page insets its card by the same amount, so the
 * card's own shadow renders instead of being clipped at the view's bounds.
 */
const log = require('../features/log');
const path = require('path');
const { resolveAppFile } = require('../app-paths');
const { WebContentsView } = require('electron');
const { panelBounds, PANEL_RADIUS, W_MD } = require('../features/overlay-bounds');
const { signalEnter, playOutThenHide } = require('../features/overlay-anim');

const PANEL_W = W_MD;
/* Sized to hold the WHOLE instrument without an inner scroll: the mode toggle,
   the gradient field (a 3:2 canvas, the tall part), the colour palette, the
   roles+tools row, the three sliders and the foot. Measured at PANEL_W the
   content is ~510px; 520 leaves the last control clear of the foot. The old 430
   cut the sliders off and made the panel scroll. panelBounds() still trims and
   slides this to fit a short window. */
const PANEL_H = 520;

async function ensurePanel(wd) {
    if (wd.themePanel) {
        if (wd.themePanelReady)
            await wd.themePanelReady;
        return wd.themePanel;
    }
    const view = new WebContentsView({
        webPreferences: {
            preload: path.join(__dirname, '../preload/theme-panel-preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            transparent: true,
        },
    });
    view.setBackgroundColor('#00000000');
    view.setVisible(false);
    wd.themePanel = view;
    wd.window.contentView.addChildView(view);
    /* Clicking anywhere else closes it. The panel is a WebContentsView, so a
       click outside lands in the chrome or in the page — neither of which knows
       about this panel — but focus leaves the view either way, and that is the
       one signal both paths share. */
    /* Same open-time grace as the page-actions panel and the permission prompt:
       showing and focusing a view produces focus churn, and a blur inside it
       closes the panel before the first click can land. */
    view.webContents.on('blur', () => {
        if (Date.now() - (wd.themePanelShownAt || 0) < 300)
            return;
        if (wd.themePanelOpen)
            hidePanel(wd);
    });
    view.webContents.loadFile(resolveAppFile('renderer/ThemePanel/index.html'));
    wd.themePanelReady = new Promise(res => view.webContents.once('did-finish-load', () => res()));
    await wd.themePanelReady;
    return view;
}

function hidePanel(wd) {
    if (!wd?.themePanel)
        return false;
    wd.themePanelOpen = false;
    // Fade the card out (P1-6), then hide the view and restore keyboard focus —
    // otherwise the window is left with nothing focused and the next accelerator
    // beeps.
    playOutThenHide(wd.themePanel, () => {
        try { wd.window.webContents.focus(); }
        catch (e) { log.debug('theme-panel', 'refocus', e); }
    });
    return true;
}

function register(ipcMain, { wm }) {
    /* `scope` is which theme the panel edits: a space id, or null for the
       global setting. It is handed to the page rather than inferred there —
       the panel has no idea which space you right-clicked. */
    ipcMain.handle('theme-panel-toggle', async (_e, anchor, scope = null) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd)
            return false;
        if (wd.themePanelOpen)
            return hidePanel(wd);
        wd.themePanelScope = scope || null;
        try {
            const view = await ensurePanel(wd);
            view.setBounds(panelBounds(wd.window, {
                anchor: anchor || null, width: PANEL_W, height: PANEL_H,
                align: 'left',
            }));
            // Raise above the active tab's view — the panel is created once and
            // otherwise sinks behind a tab added after it (CLAUDE.md invariant 4).
            try {
                wd.window.contentView.removeChildView(view);
                wd.window.contentView.addChildView(view);
            }
            catch (e) { log.debug('theme-panel', 'raise', e); }
            view.setVisible(true);
            wd.themePanelOpen = true;
            wd.themePanelShownAt = Date.now();
            try { view.webContents.send('theme-panel-scope', wd.themePanelScope); }
            catch (e) { log.debug('theme-panel', 'scope', e); }
            signalEnter(view); // P1-6 fade-in
            try { view.webContents.focus(); }
            catch (e) { log.debug('theme-panel', 'focus', e); }
            return true;
        }
        catch (err) {
            log.warn('theme-panel', 'toggle', err);
            return false;
        }
    });

    /* The panel asks what it is editing on load — the scope message is sent when
       the panel opens, and a panel reused from a previous open may already be
       past that point. */
    ipcMain.handle('theme-panel-context', (_e) => {
        for (const wd of wm.getAllWindows()) {
            if (wd.themePanel?.webContents === _e.sender)
                return { scope: wd.themePanelScope || null };
        }
        return { scope: null };
    });

    ipcMain.handle('theme-panel-close', (_e) => {
        // The request comes FROM the panel, so resolve the window by the panel's
        // own webContents rather than by the sender being the chrome.
        for (const wd of wm.getAllWindows()) {
            if (wd.themePanel?.webContents === _e.sender)
                return hidePanel(wd);
        }
        const wd = wm.getWindowByWebContents(_e.sender);
        return wd ? hidePanel(wd) : false;
    });
}

module.exports = { register, hidePanel };
