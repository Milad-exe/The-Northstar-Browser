'use strict';
/**
 * Tab sleeping — Chrome's "memory saver".
 *
 * This is a COLLABORATOR, not a prototype mixin like split/glance/reader. It
 * owns its own state (the scan timer) and holds an explicit reference back to
 * the Tabs instance, rather than being spread onto Tabs.prototype and sharing
 * `this`. That is the difference worth noticing: everything it touches on Tabs
 * is named here in one place (tabMap, activeTabIndex, pinnedTabs, tabUrls,
 * tabLastActive, persistence, mainWindow), so the coupling is visible and the
 * whole thing can be unit-tested against a stub Tabs. New tab subsystems should
 * prefer this shape over a mixin when they own a lifecycle of their own.
 *
 * A slept tab keeps its WebContentsView and navigation history; only the
 * renderer process is discarded. showTab()/loadUrl() revive it with a reload
 * (Tabs.wakeTab delegates here).
 */
const log = require('../log');

const SCAN_INTERVAL_MS = 60_000;
const DEFAULT_MINUTES = 30;

class TabSleeper {
    constructor(tabs) {
        this.tabs = tabs;
        this.timer = null;
    }

    start() {
        if (this.timer)
            return;
        this.timer = setInterval(() => {
            try { this.scan(); }
            catch (e) { log.debug('tab-sleep', 'scan', e); }
        }, SCAN_INTERVAL_MS);
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    /** Put every eligible idle tab to sleep. Never sleeps: the active tab, a
     *  pinned tab, one playing/audible, one with DevTools open, an unloaded lazy
     *  tab, or a non-web page. */
    scan() {
        const t = this.tabs;
        if (!t.mainWindow || t.mainWindow.isDestroyed()) {
            this.stop();
            return;
        }
        const p = t.persistence;
        if (p && p.get('tabSleepEnabled') === false)
            return;
        const mins = Math.max(1, Number(p?.get('tabSleepMinutes')) || DEFAULT_MINUTES);
        const cutoff = Date.now() - mins * 60_000;
        t.tabMap.forEach((tab, i) => {
            if (i === t.activeTabIndex || tab.slept)
                return;
            if (tab.lazyLoaded === false)
                return; // not loaded — nothing to free
            if (t.pinnedTabs.has(i))
                return;
            const url = t.tabUrls.get(i) || '';
            if (!/^https?:/i.test(url))
                return; // only real web pages
            if ((t.tabLastActive.get(i) || 0) > cutoff)
                return;
            // Chrome-parity protections (discard_eligibility_policy.cc), cheapest
            // first and every one failing safe — flags set by the page lifecycle
            // and one cached permission lookup, so scan() stays synchronous.
            if ((tab.lastAudibleAt || 0) > Date.now() - 60_000)
                return; // kRecentlyAudible — just stopped playing sound
            if (tab.inPiP)
                return; // kPictureInPicture — video popped out
            if (tab.capturing && tab.capturing.size)
                return; // kCapturingVideo/Audio/Display — camera/mic/screen live
            if (tab.dirty)
                return; // kFormInteractions/kUserEdits — unsent typing on the page
            const perms = t.sitePermissions;
            if (perms) {
                const origin = perms.originOf(url);
                if (origin && perms.state(origin, 'notifications') === 'allow')
                    return; // kNotificationsEnabled — may push while backgrounded
            }
            try {
                const wc = tab.webContents;
                if (!wc || wc.isDestroyed() || wc.isCrashed())
                    return;
                if (tab.hasPlayingMedia || wc.isCurrentlyAudible())
                    return;
                if (wc.isDevToolsOpened())
                    return;
                tab.slept = true;
                // Tell the chrome so the row shows the slept state (dotted ring,
                // dimmed favicon). Optional-chained so the stub Tabs in the unit
                // tests — which has no real webContents — is unaffected (P1-8).
                try { t.mainWindow.webContents?.send('tab-slept', { index: i }); }
                catch (e) { log.debug('tab-sleep', 'tab-slept', e); }
                wc.forcefullyCrashRenderer(); // frees the whole renderer process
            }
            catch (e) { log.debug('tab-sleep', 'scan tab', e); }
        });
    }

    /**
     * Revive a slept tab: the renderer process is gone, so the page has to be
     * reloaded.
     *
     * Scroll position is restored on wake via the SAME path session-restore uses:
     * the last scrollY the page reported while it was active is still held in
     * Tabs.tabScroll (a background tab fires no scroll events, so it never
     * changed), and the tab's did-finish-load listener scrolls there when
     * `_restoreScroll` is armed. We re-arm it here — to a non-`false` value so the
     * did-navigate handler does NOT drop the stored position before the reload
     * finishes — so a woken tab lands where the user left it, not at the top.
     * (No async read of the dying renderer is needed, so the discard stays
     * unconditional and a hung page can't keep its process alive.)
     */
    wake(tab) {
        if (!tab)
            return;
        tab.slept = false;
        // Arm the did-finish-load scroll restore (no-op if nothing was saved).
        tab._restoreScroll = 'wake';
        try { tab.webContents.reload(); }
        catch (e) { log.debug('tab-sleep', 'wake', e); }
    }
}

module.exports = { TabSleeper };
