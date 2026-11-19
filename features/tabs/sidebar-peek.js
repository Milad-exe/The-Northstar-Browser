'use strict';
/**
 * Compact mode's sidebar peek: push the pointer to the window's left edge and
 * the window goes back to the normal sidebar layout for as long as you use it;
 * move away and compact mode returns.
 *
 * It is a TEMPORARY un-compact, not an overlay. An overlay had to stand a
 * snapshot in for the page (the page is a native view above the chrome) and
 * then covered the toolbar row and cropped the page; here the page really
 * resizes and every bar lays out exactly as it does with compact off, so
 * nothing is covered and every row is where it always is. `sidebarCompact`
 * itself is never touched — getTabBounds() reads isCompactLayout(), which is
 * false while a peek is open — so the setting cannot be lost to a peek.
 *
 * The pointer leaving is watched HERE, from the real cursor, not by the
 * chrome's pointer events: the sidebar and the toolbar are window-drag
 * regions, which Windows hit-tests as title bar, so the chrome stops hearing
 * the pointer over them. Polling runs only while a peek is open.
 *
 * Mixed into Tabs.prototype (features/tabs.js).
 */
const log = require('../log');

const POLL_MS = 50;      // cursor check while open: cheap, and only while open
const LEAVE_GRACE = 250; // outside this long before it goes (a slip past the edge is forgiven)

module.exports = {
    /** The layout in force: compact unless a peek has the sidebar out. */
    isCompactLayout() {
        return !!this.sidebarCompact && !this._peek;
    },

    /** Bring the sidebar back for a moment. False when there is nothing to do. */
    startSidebarPeek() {
        if (this._peek || !this.sidebarCompact || this.isHtmlFullScreen)
            return false;
        if ((this.persistence?.get('tabBarSide') ?? 'side') === 'top')
            return false;
        const p = { poll: null, outsideSince: 0, onBlur: null };
        this._peek = p;
        this.resizeAllTabs(); // the docked layout: the page makes room
        try { this.mainWindow.webContents.send('sidebar-peek', { on: true }); }
        catch (e) { log.debug('sidebar-peek', 'notify start', e); }
        p.poll = setInterval(() => this._peekPoll(p), POLL_MS);
        // Switching apps puts it away. Checked a beat later: opening an
        // overlay can blur the window for a moment.
        p.onBlur = () => setTimeout(() => {
            try {
                if (this._peek === p && !this.mainWindow.isDestroyed() && !this.mainWindow.isFocused())
                    this.endSidebarPeek('window blur');
            }
            catch (e) { log.debug('sidebar-peek', 'blur check', e); }
        }, 60);
        try { this.mainWindow.on('blur', p.onBlur); }
        catch (e) { log.debug('sidebar-peek', 'blur hook', e); }
        return true;
    },

    /**
     * Back to compact (idempotent). `relayout: false` when the caller is about
     * to lay the window out itself (compact being switched off).
     */
    endSidebarPeek(reason = '', { relayout = true } = {}) {
        const p = this._peek;
        if (!p)
            return;
        this._peek = null;
        clearInterval(p.poll);
        if (p.onBlur) {
            try { this.mainWindow.removeListener('blur', p.onBlur); }
            catch (e) { log.debug('sidebar-peek', 'unhook blur', e); }
        }
        if (this.mainWindow.isDestroyed())
            return;
        if (relayout)
            this.resizeAllTabs();
        try { this.mainWindow.webContents.send('sidebar-peek', { on: false, reason }); }
        catch (e) { log.debug('sidebar-peek', 'notify end', e); }
    },

    /** Is the real cursor over the sidebar (or the edge strip that opened it)? */
    _peekPointerInside() {
        const { screen } = require('electron');
        const pt = screen.getCursorScreenPoint();
        const cb = this.mainWindow.getContentBounds();
        const x = pt.x - cb.x, y = pt.y - cb.y;
        const T = this.constructor;
        if (x < -2 || y < -2 || x > cb.width + 2 || y > cb.height + 2)
            return false; // off the window altogether
        if (x < (T.SHELL_PAD || 8))
            return true; // the edge strip, full height
        // The docked sidebar: under the toolbar, to the bottom of the window.
        const top = (T.SHELL_TOP || 6) + (T.UTILITY_BAR_H || 40);
        return x <= this.sidebarWidth && y >= top - 4;
    },

    _peekPoll(p) {
        if (this._peek !== p)
            return;
        let inside = false;
        try { inside = this._peekPointerInside(); }
        catch (e) { log.debug('sidebar-peek', 'cursor check', e); inside = true; } // unsure: keep it
        // A menu or panel opened from the sidebar (right-click a tab, …) is
        // still the sidebar being used.
        if (!inside) {
            try { inside = require('../../ipc/popup-dismiss').anyOpen(this.getWindowData()); }
            catch (e) { log.debug('sidebar-peek', 'popup check', e); }
        }
        if (inside) {
            p.outsideSince = 0;
            return;
        }
        if (!p.outsideSince) {
            p.outsideSince = Date.now();
            return;
        }
        if (Date.now() - p.outsideSince >= LEAVE_GRACE)
            this.endSidebarPeek('pointer left');
    },
};
