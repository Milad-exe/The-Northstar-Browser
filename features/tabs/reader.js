'use strict';
/**
 * The two ways a page can be shown as something other than itself: reader view
 * and picture-in-picture. Both swap what the tab is displaying without touching
 * its history, which is why they live beside each other and away from
 * navigation.
 */
 /* Mixed into Tabs.prototype at the bottom of features/tabs.js — `this` is the
    Tabs instance and nothing here requires Tabs back. */
const log = require('../log');
const { resolveAppFile } = require('../../app-paths');
// The injected page scripts live in features/reader.js. They used to be reachable
// as top-level consts in features/tabs.js, but this mixin is its own module, so
// import them here — reading them from tabs.js's scope threw "not defined" and
// left reader mode and PiP silently dead.
const { READERABLE_JS, EXTRACT_JS, PIP_JS } = require('../reader');

module.exports = {
    // ── Reader mode ────────────────────────────────────────────────────────────
    // Ask the page whether it looks like an article; tell the chrome to
    // enable/disable the reader button for the active tab.
    detectReaderable(index, tab) {
        if (this.readerMode.has(index))
            return; // reader page itself isn't "readerable"
        const url = (tab.webContents.getURL && tab.webContents.getURL()) || '';
        if (!/^https?:/.test(url)) {
            if (index === this.activeTabIndex) {
                try {
                    this.mainWindow.webContents.send('reader-state', { index, active: false, available: false });
                }
                catch (e) { log.debug('tabs', 'url', e); }
            }
            return;
        }
        tab.webContents.executeJavaScript(READERABLE_JS, true)
            .then((ok) => {
            tab._readerable = !!ok; // the page menu offers reader view from this
            try {
                this.mainWindow.webContents.send('reader-state', { index, active: false, available: !!ok });
            }
            catch (e) { log.debug('tabs', 'url', e); }
        })
            .catch(() => { });
    },
    async toggleReader(index) {
        const tab = this.tabMap.get(index);
        if (!tab)
            return;
        if (this.readerMode.has(index)) {
            // Exit — restore the original page.
            const orig = this.readerOriginal.get(index);
            this.readerMode.delete(index);
            this.readerArticles.delete(index);
            tab.setNavigatingProgrammatically(true);
            if (orig) {
                this.tabUrls.set(index, orig);
                tab.webContents.loadURL(orig);
            }
            else
                tab.webContents.reload();
            return;
        }
        let article = null;
        try {
            article = await tab.webContents.executeJavaScript(EXTRACT_JS, true);
        }
        catch (e) { log.debug('tabs', 'toggleReader', e); }
        if (!article || !article.ok) {
            try {
                this.mainWindow.webContents.send('reader-failed', { index });
            }
            catch (e) { log.debug('tabs', 'toggleReader', e); }
            return;
        }
        this.readerArticles.set(index, article);
        this.readerOriginal.set(index, tab.webContents.getURL());
        this.readerMode.add(index);
        tab.setNavigatingProgrammatically(true);
        tab.webContents.loadFile(resolveAppFile('renderer/Reader/index.html'));
    },
    getReaderArticle(index) {
        return this.readerArticles.get(index) || null;
    },
    // ── Picture-in-Picture ───────────────────────────────────────────────────────
    togglePictureInPicture(index) {
        const tab = this.tabMap.get(index);
        if (!tab || !tab.webContents || tab.webContents.isDestroyed())
            return;
        // userGesture = true so the PiP request counts as user-activated.
        tab.webContents.executeJavaScript(PIP_JS, true).catch(() => { });
    },
};
