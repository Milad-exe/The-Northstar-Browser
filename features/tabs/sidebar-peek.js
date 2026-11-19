'use strict';
/**
 * Compact mode's sidebar peek: push the pointer to the window's left edge and
 * the sidebar comes up as a floating card over the page; leave it and it goes.
 *
 * The sidebar is chrome DOM, and every page is a native view layered ABOVE the
 * chrome, so the card cannot simply be drawn over the page. Shrinking the page
 * to make room would relayout it on every peek (the stutter the sidebar-resize
 * path already avoids, see applyWidthBlank in ipc/tabs.js). Instead:
 *
 *   1. startSidebarPeek(): capture each visible page view and hand the images
 *      to the chrome, with the page card's bounds.
 *   2. The chrome paints them exactly where the views are, shows the sidebar
 *      card over them, then calls sidebarPeekReady().
 *   3. sidebarPeekReady(): hide the native views. The snapshot underneath is
 *      identical, so the swap does not show — and nothing was resized.
 *   4. endSidebarPeek(): show the views again, then tell the chrome to drop
 *      the card and the snapshot (already covered by the views by then).
 *
 * A peek ends on anything that would make the snapshot stale or draw a native
 * view over the card: a tab switch (showTab), any relayout (resizeAllTabs —
 * window resize, bookmark bar, side panel, tab-bar side), compact turning off,
 * or the window losing focus. The chrome ends it on pointer-leave, a click on
 * the snapshot, or Esc.
 *
 * Mixed into Tabs.prototype (features/tabs.js).
 */
const log = require('../log');

const JPEG_QUALITY = 85; // a snapshot under a moving card; PNG encode cost more than it showed

module.exports = {
    /** Begin a peek. Resolves false when there is nothing to do. */
    async startSidebarPeek() {
        if (this._peek || !this.sidebarCompact || this.isHtmlFullScreen)
            return false;
        if ((this.persistence?.get('tabBarSide') ?? 'side') === 'top')
            return false;
        // A glance floats over the page as its own views; it would sit over
        // the card. It is transient — put it away, as a tab switch does.
        try { this.closeGlance?.(); }
        catch (e) { log.debug('sidebar-peek', 'closeGlance', e); }
        const token = {};
        this._peek = { token, views: [], state: 'capturing', onBlur: null };
        const ids = this.splitPair ? [...this.splitPair] : [this.activeTabIndex];
        const views = ids.map(i => this.tabMap.get(i)).filter((v) => {
            try { return v && !v.webContents.isDestroyed() && v.getVisible?.() !== false; }
            catch { return false; }
        });
        const shots = [];
        for (const v of views) {
            let src = null;
            const b = v.getBounds();
            try {
                const img = await v.webContents.capturePage();
                if (!img.isEmpty())
                    src = 'data:image/jpeg;base64,' + img.toJPEG(JPEG_QUALITY).toString('base64');
            }
            catch (e) { log.debug('sidebar-peek', 'capturePage', e); }
            shots.push({ x: b.x, y: b.y, width: b.width, height: b.height, src });
        }
        // Ended (tab switch, resize, compact off) while capturing.
        if (this._peek?.token !== token)
            return false;
        this._peek.views = views;
        this._peek.state = 'painting';
        // Switching apps puts it away. Checked a beat later: opening an
        // overlay can blur the window for a moment.
        const onBlur = () => setTimeout(() => {
            try {
                if (this._peek?.token === token && !this.mainWindow.isDestroyed() && !this.mainWindow.isFocused())
                    this.endSidebarPeek('window blur');
            }
            catch (e) { log.debug('sidebar-peek', 'blur check', e); }
        }, 60);
        this._peek.onBlur = onBlur;
        try { this.mainWindow.on('blur', onBlur); }
        catch (e) { log.debug('sidebar-peek', 'blur hook', e); }
        try {
            this.mainWindow.webContents.send('sidebar-peek', { on: true, shots, bounds: this.getTabBounds() });
        }
        catch (e) {
            log.warn('sidebar-peek', 'could not reach the chrome', e);
            this.endSidebarPeek('send failed');
            return false;
        }
        return true;
    },

    /** The chrome has painted the snapshot and the card: hide the real views. */
    sidebarPeekReady() {
        const p = this._peek;
        if (!p || p.state !== 'painting')
            return;
        p.state = 'open';
        for (const v of p.views) {
            try {
                if (!v.webContents.isDestroyed())
                    v.setVisible(false);
            }
            catch (e) { log.debug('sidebar-peek', 'hide view', e); }
        }
    },

    /** Put the peek away (idempotent). */
    endSidebarPeek(reason = '') {
        const p = this._peek;
        if (!p)
            return;
        this._peek = null;
        if (p.onBlur) {
            try { this.mainWindow.removeListener('blur', p.onBlur); }
            catch (e) { log.debug('sidebar-peek', 'unhook blur', e); }
        }
        // Re-show only views that should still be on screen: a tab switch
        // during the peek changes which those are (showTab then does the rest).
        const shouldShow = new Set(this.splitPair ? this.splitPair : [this.activeTabIndex]);
        for (const [index, v] of this.tabMap) {
            if (!p.views.includes(v) || !shouldShow.has(index))
                continue;
            try {
                if (!v.webContents.isDestroyed())
                    v.setVisible(true);
            }
            catch (e) { log.debug('sidebar-peek', 'show view', e); }
        }
        try {
            if (!this.mainWindow.isDestroyed())
                this.mainWindow.webContents.send('sidebar-peek', { on: false, reason });
        }
        catch (e) { log.debug('sidebar-peek', 'notify end', e); }
    },
};
