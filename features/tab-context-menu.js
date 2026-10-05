const log = require('./log');
const { clipboard, shell } = require('electron');
const { sanitizeUrl, isSafeExternal } = require('./url-security');
const downloadManager = require('./download-manager');
class TabContextMenu {
    tab; // the TabView the menu was opened on
    tabManager; // Tabs instance
    contextTemplate; // Electron MenuItem template being built
    constructor(tab, params, tabManager) {
        this.tab = tab;
        this.tabManager = tabManager;
        this.contextTemplate = [];
        // Spelling suggestions come first when right-clicking a misspelled word
        this.addSpellcheckItems(params);
        // Context-specific items first (most relevant to what was clicked)
        this.addLinkItems(params);
        this.addImageItems(params);
        this.addMediaItems(params);
        this.addSelectionItems(params);
        this.addEditableItems(params);
        // Page navigation + utilities
        this.addPageItems(params);
        // Inspect always last
        this.addInspect(params);
    }
    getTemplate() {
        return this.contextTemplate;
    }
    sep() {
        const last = this.contextTemplate[this.contextTemplate.length - 1];
        if (last && last.type !== 'separator') {
            this.contextTemplate.push({ type: 'separator' });
        }
    }
    hasHighlightedText(params) {
        return typeof params.selectionText === 'string' && params.selectionText.trim().length > 0;
    }
    openInNewTab(url) {
        const safe = sanitizeUrl(url);
        let title = safe;
        try {
            title = new URL(safe).hostname;
        }
        catch (e) { log.debug('tab-context-menu', 'openInNewTab', e); }
        this.tabManager.createLazyTab(safe, title, false, false, true, true);
    }
    /** Open a link in a NEW Northstar window (optionally a private one). */
    openInWindow(url, makePrivate) {
        const safe = sanitizeUrl(url);
        const wm = this.tabManager.windowManager;
        if (!wm) {
            log.warn('tab-context-menu', 'no window manager; cannot open a window');
            return;
        }
        wm.createWindow(1000, 700, { url: safe, private: !!makePrivate });
    }
    /** The default search engine, or Google if the setting has not loaded. */
    defaultEngine() {
        try {
            const engines = require('./search-engines');
            const id = this.tabManager.persistence?.get('searchEngine') || 'google';
            return engines.byId(id) || engines.byId('google');
        }
        catch (e) {
            log.debug('tab-context-menu', 'defaultEngine', e);
            return { id: 'google', name: 'Google', url: 'https://www.google.com/search?q=%s' };
        }
    }
    addPageItems(params) {
        const wc = this.tab.webContents;
        const currentUrl = wc.getURL ? wc.getURL() : '';
        const isRealPage = currentUrl && !currentUrl.startsWith('file://');
        this.sep();
        // Shortcut hints (U1-1/U1-2): display only — a context menu never
        // registers its accelerators; features/shortcuts.js owns the keys.
        const mac = process.platform === 'darwin';
        this.contextTemplate.push({
            label: 'Back',
            accelerator: mac ? 'Cmd+[' : 'Alt+Left',
            enabled: wc.navigationHistory?.canGoBack() ?? false,
            click: () => { try {
                wc.navigationHistory.goBack();
            }
            catch (e) { log.debug('tab-context-menu', 'addPageItems', e); } },
        }, {
            label: 'Forward',
            accelerator: mac ? 'Cmd+]' : 'Alt+Right',
            enabled: wc.navigationHistory?.canGoForward() ?? false,
            click: () => { try {
                wc.navigationHistory.goForward();
            }
            catch (e) { log.debug('tab-context-menu', 'addPageItems', e); } },
        }, {
            label: 'Reload',
            accelerator: 'CmdOrCtrl+R',
            click: () => wc.reload(),
        });
        if (isRealPage) {
            this.sep();
            this.contextTemplate.push({
                label: 'Save page as…',
                accelerator: 'CmdOrCtrl+S',
                click: () => downloadManager.saveAs(wc, currentUrl),
            }, {
                label: 'Print…',
                accelerator: 'CmdOrCtrl+P',
                click: () => wc.print(),
            }, {
                label: 'View page source',
                accelerator: 'CmdOrCtrl+U',
                click: () => this.openInNewTab(`view-source:${currentUrl}`),
            });
            this.sep();
            this.contextTemplate.push({
                label: 'Copy page URL',
                click: () => clipboard.writeText(currentUrl),
            });
        }
    }
    addInspect(params) {
        // Internal chrome pages (new tab, settings, history, …) are UI, not
        // web content — no devtools there outside a --dev run.
        const url = this.tab.webContents.getURL?.() || '';
        const internal = !/^https?:/i.test(url);
        if (internal && !process.argv.includes('--dev'))
            return;
        this.sep();
        this.contextTemplate.push({
            label: 'Inspect element',
            accelerator: 'CmdOrCtrl+Shift+I',
            click: () => this.tab.webContents.inspectElement(params.x, params.y),
        });
    }
    addSelectionItems(params) {
        if (params.linkURL)
            return;
        if (!this.hasHighlightedText(params))
            return;
        this.sep();
        const truncated = params.selectionText.length > 40
            ? params.selectionText.slice(0, 40) + '…'
            : params.selectionText;
        // The engine the address bar would use — the menu used to say Google
        // and go to Google even when the default was something else.
        const engine = this.defaultEngine();
        this.contextTemplate.push({
            label: 'Copy',
            role: 'copy',
            accelerator: 'CmdOrCtrl+C',
            enabled: params.editFlags.canCopy,
        }, {
            label: `Search ${engine.name} for “${truncated}”`,
            click: () => {
                const { buildUrl } = require('./search-engines');
                this.openInNewTab(buildUrl(engine, params.selectionText));
            },
        });
    }
    addSpellcheckItems(params) {
        if (!params.misspelledWord)
            return;
        const wc = this.tab.webContents;
        const sess = wc.session;
        const suggestions = params.dictionarySuggestions || [];
        if (suggestions.length) {
            suggestions.slice(0, 5).forEach(s => {
                this.contextTemplate.push({ label: s, click: () => wc.replaceMisspelling(s) });
            });
        }
        else {
            this.contextTemplate.push({ label: 'No spelling suggestions', enabled: false });
        }
        this.contextTemplate.push({ type: 'separator' });
        this.contextTemplate.push({
            label: 'Add to dictionary',
            click: () => { try {
                sess.addWordToSpellCheckerDictionary(params.misspelledWord);
            }
            catch (e) { log.debug('tab-context-menu', 'addSpellcheckItems', e); } },
        });
    }
    addEditableItems(params) {
        if (!params.isEditable)
            return;
        this.sep();
        const redo = process.platform === 'darwin' ? 'CmdOrCtrl+Shift+Z' : 'CmdOrCtrl+Y';
        this.contextTemplate.push({ label: 'Undo', role: 'undo', accelerator: 'CmdOrCtrl+Z', enabled: params.editFlags.canUndo }, { label: 'Redo', role: 'redo', accelerator: redo, enabled: params.editFlags.canRedo }, { type: 'separator' }, { label: 'Cut', role: 'cut', accelerator: 'CmdOrCtrl+X', enabled: params.editFlags.canCut }, { label: 'Copy', role: 'copy', accelerator: 'CmdOrCtrl+C', enabled: params.editFlags.canCopy }, { label: 'Paste', role: 'paste', accelerator: 'CmdOrCtrl+V', enabled: params.editFlags.canPaste }, { label: 'Select all', role: 'selectAll', accelerator: 'CmdOrCtrl+A' });
    }
    addLinkItems(params) {
        if (!params.linkURL)
            return;
        this.contextTemplate.push({
            label: 'Open link in new tab',
            click: () => this.openInNewTab(params.linkURL),
        }, {
            // Glance: a floating preview of the link over the current page (Esc to
            // close, ⌘/Ctrl+Enter to open it as a full tab).
            label: 'Glance at link',
            click: () => this.tabManager.openGlance(sanitizeUrl(params.linkURL)),
        }, {
            // Split the link beside the page you are on — the browser has split
            // view, and a link is the most common thing you want beside a page.
            label: 'Open link beside this page',
            click: () => {
                const url = sanitizeUrl(params.linkURL);
                let title = url;
                try { title = new URL(url).hostname; }
                catch (e) { log.debug('tab-context-menu', 'split link', e); }
                // eager: a pane in a split has to be loaded, not lazy.
                this.tabManager.createLazyTab(url, title, false, false, true, true);
                const idx = this.tabManager.nextTabIndex - 1;
                this.tabManager.splitWithActive(idx);
            },
        }, {
            // A NORTHSTAR window. This used to call shell.openExternal, which
            // handed the link to whatever your default browser is — the one
            // place in the app that quietly sent you somewhere else.
            label: 'Open link in new window',
            click: () => this.openInWindow(params.linkURL, false),
        }, {
            label: 'Open link in new private window',
            click: () => this.openInWindow(params.linkURL, true),
        }, {
            label: 'Copy link address',
            click: () => clipboard.writeText(params.linkURL),
        }, {
            // Same tracking-param list the privacy engine strips on navigation,
            // so a copied link matches what the browser would have requested.
            label: 'Copy clean link',
            click: () => {
                const { stripTrackingParams } = require('./privacy');
                clipboard.writeText(stripTrackingParams(params.linkURL) || params.linkURL);
            },
        }, {
            label: 'Save link as…',
            click: () => downloadManager.saveAs(this.tab.webContents, params.linkURL),
        }, {
            label: 'Bookmark link',
            click: async () => {
                try {
                    // Bookmarks are per-space, so it has to be THIS window's
                    // store — the same one the star and the bar write to.
                    const wm = this.tabManager.windowManager;
                    const store = wm?.bookmarksFor(this.tabManager.profileId || '1');
                    if (!store)
                        return;
                    const url = sanitizeUrl(params.linkURL);
                    await store.add(url, params.linkText || url, String(this.tabManager.profileId || '1'));
                    this.tabManager.mainWindow.webContents.send('bookmarks-changed');
                }
                catch (e) { log.warn('tab-context-menu', 'bookmark link failed', e); }
            },
        });
    }
    addImageItems(params) {
        if (!params.srcURL || params.mediaType !== 'image')
            return;
        this.sep();
        this.contextTemplate.push({
            label: 'Save image as…',
            click: () => downloadManager.saveAs(this.tab.webContents, params.srcURL),
        }, {
            label: 'Copy image address',
            click: () => clipboard.writeText(params.srcURL),
        }, {
            label: 'Open image in new tab',
            click: () => this.openInNewTab(params.srcURL),
        }, {
            // Named for what it actually uses: reverse image search by URL is
            // a Lens endpoint, and the other built-in engines have no
            // equivalent, so labelling it with the default engine would lie.
            label: 'Search image with Google Lens',
            click: () => this.openInNewTab(`https://lens.google.com/uploadbyurl?url=${encodeURIComponent(params.srcURL)}`),
        });
    }
    addMediaItems(params) {
        if (!params.srcURL || (params.mediaType !== 'video' && params.mediaType !== 'audio'))
            return;
        const label = params.mediaType === 'video' ? 'Video' : 'Audio';
        this.sep();
        if (params.mediaType === 'video') {
            this.contextTemplate.push({
                label: 'Picture in picture',
                click: () => {
                    const src = JSON.stringify(params.srcURL || '');
                    // userGesture=true so the PiP request counts as user-activated.
                    this.tab.webContents.executeJavaScript(`(() => {
                        try {
                            if (document.pictureInPictureElement) { document.exitPictureInPicture(); return; }
                            const src = ${src};
                            const vids = Array.from(document.querySelectorAll('video'));
                            let v = vids.find(x => x.currentSrc === src || x.src === src)
                                 || vids.filter(x => !x.paused)[0] || vids[0];
                            if (v && v.requestPictureInPicture) v.requestPictureInPicture().catch(()=>{});
                        } catch (e) { log.debug('tab-context-menu', 'addMediaItems', e); }
                    })()`, true).catch(() => { });
                },
            });
        }
        this.contextTemplate.push({
            label: `Open ${label} in new tab`,
            click: () => this.openInNewTab(params.srcURL),
        }, {
            label: `Save ${label} as…`,
            click: () => downloadManager.saveAs(this.tab.webContents, params.srcURL),
        }, {
            label: 'Copy media address',
            click: () => clipboard.writeText(params.srcURL),
        });
    }
}

module.exports = TabContextMenu;