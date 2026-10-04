'use strict';
/**
 * Overlay enter/exit coordination (P1-6) — the main-process half.
 *
 * Overlays are separate WebContentsViews; setVisible() is instant, so the fade
 * lives in the overlay's own page (renderer/lib/surface-anim.js). This pairs
 * with it: signalEnter() tells a just-shown page to fade in, and
 * playOutThenHide() asks the page to play its close fade, hiding the view only
 * once the page acks — or after a short timeout, so a panel can NEVER get stuck
 * on screen if the ack is dropped.
 */
const log = require('./log');
const HIDE_FALLBACK_MS = 180;

function signalEnter(view) {
    try { view.webContents.send('overlay:enter'); }
    catch (e) { log.debug('overlay-anim', 'signalEnter', e); }
}

function playOutThenHide(view, onHidden) {
    let done = false;
    const hide = () => {
        if (done) return;
        done = true;
        try { view.setVisible(false); }
        catch (e) { log.debug('overlay-anim', 'hide', e); }
        if (onHidden) { try { onHidden(); } catch (e) { log.debug('overlay-anim', 'onHidden', e); } }
    };
    try {
        // Scope the ack to this view; clear any stale one left by a timed-out close.
        view.webContents.ipc.removeAllListeners('overlay:leave-done');
        view.webContents.ipc.once('overlay:leave-done', hide);
        view.webContents.send('overlay:leave');
    }
    catch (e) {
        log.debug('overlay-anim', 'playOut', e);
        hide();
        return;
    }
    setTimeout(hide, HIDE_FALLBACK_MS);
}

module.exports = { signalEnter, playOutThenHide };
