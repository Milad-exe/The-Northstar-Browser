'use strict';
/**
 * Hang prompt (P2-3) — the "page isn't responding" choice, as a tab-scoped
 * overlay instead of a native message box.
 *
 * One WebContentsView per window, created lazily and reused (registered in
 * overlay-registry.js, so it is raised above the page and resolves to its
 * window). Only the active tab ever shows it (the caller enforces that). The
 * two buttons post back here: "Wait" just dismisses; "Stop page" crashes the
 * hung renderer (the crash handler then shows the recovery page).
 */
const path = require('path');
const { WebContentsView } = require('electron');
const { resolveAppFile } = require('../app-paths');
const log = require('./log');
const { CARD_TOP, SHELL_PAD } = require('./overlay-bounds');
const { signalEnter, playOutThenHide } = require('./overlay-anim');

const WIDTH = 360;
const HEIGHT = 140;

function boundsFor(wd) {
    // Centre over the active page card's top edge. The page view's own bounds
    // are exactly the card region (after the sidebar), so measure from it and
    // fall back to the window content box if it isn't available.
    let area = wd.window.getContentBounds();
    try {
        const pv = wd.tabs?.tabMap?.get(wd.tabs.activeTabIndex);
        const r = pv?.getBounds?.();
        if (r && r.width)
            area = r;
    }
    catch (e) { log.debug('hang-prompt', 'bounds', e); }
    const w = Math.min(WIDTH, Math.max(240, area.width - 2 * SHELL_PAD));
    const x = Math.round(area.x + (area.width - w) / 2);
    const y = Math.round((area.y || 0) + SHELL_PAD) || CARD_TOP;
    return { x, y, width: w, height: HEIGHT };
}

async function ensureView(wd) {
    if (wd.hangPrompt) {
        if (wd.hangPromptReady)
            await wd.hangPromptReady;
        return wd.hangPrompt;
    }
    const view = new WebContentsView({
        webPreferences: {
            preload: path.join(__dirname, '../preload/hang-prompt-preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    view.setBackgroundColor('#00000000');
    view.setVisible(false);
    wd.hangPrompt = view;
    wd.window.contentView.addChildView(view);
    // Buttons post back on this view's own IPC channel (scoped to this view).
    view.webContents.ipc.on('hang:wait', () => hide(wd));
    view.webContents.ipc.on('hang:stop', () => {
        const ctx = wd.hangPromptCtx;
        hide(wd);
        if (!ctx) return;
        const tab = ctx.tabs?.tabMap?.get(ctx.tabIndex);
        if (tab && tab.webContents && !tab.webContents.isDestroyed()) {
            tab._killedForHang = true;
            try { tab.webContents.forcefullyCrashRenderer(); }
            catch (e) { log.error('tabs', 'could not stop the hung page', e); }
        }
    });
    view.webContents.loadFile(resolveAppFile('renderer/HangPrompt/index.html'));
    wd.hangPromptReady = new Promise(res => view.webContents.once('did-finish-load', () => res()));
    await wd.hangPromptReady;
    return view;
}

async function show(wd, tabs, tabIndex, host) {
    if (!wd) return;
    wd.hangPromptCtx = { tabs, tabIndex };
    try {
        const view = await ensureView(wd);
        view.setBounds(boundsFor(wd));
        // Raise above the active tab's view (CLAUDE.md invariant 4).
        try {
            wd.window.contentView.removeChildView(view);
            wd.window.contentView.addChildView(view);
        }
        catch (e) { log.debug('hang-prompt', 'raise', e); }
        view.webContents.send('hang:data', { host });
        view.setVisible(true);
        wd.hangPromptOpen = true;
        signalEnter(view); // P1-6 fade-in
        try { view.webContents.focus(); }
        catch (e) { log.debug('hang-prompt', 'focus', e); }
    }
    catch (e) { log.error('tabs', 'hang prompt show', e); }
}

function hide(wd) {
    if (!wd?.hangPrompt || !wd.hangPromptOpen)
        return;
    wd.hangPromptOpen = false;
    const ctx = wd.hangPromptCtx;
    if (ctx) {
        const tab = ctx.tabs?.tabMap?.get(ctx.tabIndex);
        if (tab) tab._hangPrompt = false;
    }
    playOutThenHide(wd.hangPrompt, () => {
        try { wd.window.webContents.focus(); }
        catch (e) { log.debug('hang-prompt', 'refocus', e); }
    });
}

module.exports = { show, hide };
