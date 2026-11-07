const log = require('./log');
const { clipboard, shell } = require('electron');
const { sanitizeUrl, isSafeExternal } = require('./url-security');
const downloadManager = require('./download-manager');
/* A text-fragment link (#:~:text=) to `text` on `url`: start,end words for a
   long selection, the whole of a short one. */
function highlightLink(url, text) {
    const enc = (s) => encodeURIComponent(s).replace(/-/g, '%2D');
    const words = String(text || '').trim().split(/\s+/).filter(Boolean);
    const base = String(url).split('#')[0];
    if (!words.length)
        return base;
    const frag = words.length > 8
        ? enc(words.slice(0, 4).join(' ')) + ',' + enc(words.slice(-4).join(' '))
        : enc(words.join(' '));
    return `${base}#:~:text=${frag}`;
}
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
    /* An editing row. `role` is what a NATIVE menu runs; the app's overlay menu
       (features/overlay-menu.js) only ever calls click(), so a role-only row
       was a Copy/Paste/Cut that did nothing — each row carries both. Electron
       ignores click when a role is set, so the native fallback is unchanged. */
    edit(label, role, accelerator, enabled) {
        const wc = this.tab.webContents;
        return {
            label, role, accelerator, enabled: enabled !== false,
            click: () => { try { wc[role](); } catch (e) { log.debug('tab-context-menu', role, e); } },
        };
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
            enabled: this.canStep(-1),
            click: () => this.step(-1),
        }, {
            label: 'Forward',
            accelerator: mac ? 'Cmd+]' : 'Alt+Right',
            enabled: this.canStep(1),
            click: () => this.step(1),
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
            }, ...this.readerItem());
            // No "View page source" row: Inspect element (below) covers it,
            // and the two read as the same item. Ctrl+U still opens the source.
            this.sep();
            this.contextTemplate.push({
                label: 'Copy page URL',
                click: () => clipboard.writeText(currentUrl),
            });
        }
    }
    /* Reader view, offered when the page looks like an article (the same test
       that lights the toolbar's reader button) or is already in it. */
    readerItem() {
        const i = this.tabIndex();
        if (i === null)
            return [];
        const on = this.tabManager.readerMode?.has(i);
        if (!on && !this.tab._readerable)
            return [];
        return [{
            label: on ? 'Exit reader view' : 'Open in reader view',
            accelerator: 'CmdOrCtrl+Alt+R',
            click: () => { try { this.tabManager.toggleReader(i); } catch (e) { log.debug('tab-context-menu', 'reader', e); } },
        }];
    }
    /* The tab's index in its Tabs, or null (a glance view is not a tab). */
    tabIndex() {
        for (const [i, t] of this.tabManager?.tabMap || [])
            if (t === this.tab) return i;
        return null;
    }
    /* Back/Forward go through the tab's own history tree (CLAUDE.md invariant
       9), like the toolbar buttons. Calling the webContents' native goBack()
       here moved the page without moving the tree, so the step was recorded as
       a fresh visit and Back/Forward lost their place afterwards. */
    canStep(dir) {
        const i = this.tabIndex();
        const nav = this.tab.webContents.navigationHistory;
        try {
            if (i === null)
                return dir < 0 ? !!nav?.canGoBack() : !!nav?.canGoForward();
            const h = this.tabManager.navigationHistory;
            return dir < 0 ? !!h.canGoBack(i) : !!h.canGoForward(i);
        }
        catch (e) { log.debug('tab-context-menu', 'canStep', e); return false; }
    }
    step(dir) {
        const i = this.tabIndex();
        try {
            if (i === null) {
                const nav = this.tab.webContents.navigationHistory;
                dir < 0 ? nav.goBack() : nav.goForward();
            }
            else if (dir < 0) this.tabManager.goBack(i);
            else this.tabManager.goForward(i);
        }
        catch (e) { log.debug('tab-context-menu', 'step', e); }
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
        // In a text field the editing rows below carry Copy already — showing
        // it here too gave the menu two Copy rows.
        if (!params.isEditable)
            this.contextTemplate.push(this.edit('Copy', 'copy', 'CmdOrCtrl+C', params.editFlags.canCopy));
        // A link that scrolls to and highlights this text (a text fragment).
        const pageUrl = this.tab.webContents.getURL?.() || '';
        if (!params.isEditable && /^https?:/i.test(pageUrl)) {
            this.contextTemplate.push({
                label: 'Copy link to highlight',
                click: () => clipboard.writeText(highlightLink(pageUrl, params.selectionText)),
            });
        }
        this.contextTemplate.push({
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
            // Into every space's dictionary, not only this tab's session
            // (features/spellcheck.js) — and this session too, private or not.
            click: () => { try {
                require('./spellcheck').addWord(params.misspelledWord, sess);
            }
            catch (e) { log.debug('tab-context-menu', 'addSpellcheckItems', e); } },
        });
    }
    addEditableItems(params) {
        if (!params.isEditable)
            return;
        this.sep();
        const redo = process.platform === 'darwin' ? 'CmdOrCtrl+Shift+Z' : 'CmdOrCtrl+Y';
        const f = params.editFlags || {};
        // The system emoji picker, into this field. The menu took focus, so the
        // page gets it back first or the picker types into nothing.
        if (process.platform !== 'linux') {
            this.contextTemplate.push({
                label: 'Emoji',
                accelerator: process.platform === 'darwin' ? 'Ctrl+Cmd+Space' : 'Super+.',
                click: () => {
                    try { this.tab.webContents.focus(); }
                    catch (e) { log.debug('tab-context-menu', 'emoji focus', e); }
                    setTimeout(() => { try { require('electron').app.showEmojiPanel(); } catch (e) { log.debug('tab-context-menu', 'emoji', e); } }, 60);
                },
            }, { type: 'separator' });
        }
        this.contextTemplate.push(this.edit('Undo', 'undo', 'CmdOrCtrl+Z', f.canUndo), this.edit('Redo', 'redo', redo, f.canRedo), { type: 'separator' }, this.edit('Cut', 'cut', 'CmdOrCtrl+X', f.canCut), this.edit('Copy', 'copy', 'CmdOrCtrl+C', f.canCopy), this.edit('Paste', 'paste', 'CmdOrCtrl+V', f.canPaste), {
            // The clipboard's text without its formatting (Ctrl+Shift+V).
            label: 'Paste as plain text',
            accelerator: 'CmdOrCtrl+Shift+V',
            enabled: f.canPaste !== false,
            click: () => { try { this.tab.webContents.pasteAndMatchStyle(); } catch (e) { log.debug('tab-context-menu', 'paste plain', e); } },
        }, this.edit('Select all', 'selectAll', 'CmdOrCtrl+A', true));
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
        }, ...(params.linkText && params.linkText.trim() ? [{
            label: 'Copy link text',
            click: () => clipboard.writeText(params.linkText.trim()),
        }] : []), {
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
            // The picture itself onto the clipboard, as every browser offers.
            label: 'Copy image',
            click: () => { try { this.tab.webContents.copyImageAt(params.x, params.y); }
                catch (e) { log.warn('tab-context-menu', 'copy image failed', e); } },
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
    /* The video's current frame as an image. Drawn through a canvas in the
       page; a cross-origin video taints that canvas, so then the frame is
       grabbed from the screen instead (what you see, at screen resolution). */
    async videoFrame(params) {
        const { nativeImage } = require('electron');
        const wc = this.tab.webContents;
        const at = JSON.stringify({ x: params.x || 0, y: params.y || 0, src: params.srcURL || '' });
        let res = null;
        try {
            res = await wc.executeJavaScript(`(() => {
                const a = ${at};
                const hit = document.elementFromPoint(a.x, a.y);
                let v = hit && hit.closest && hit.closest('video');
                if (!v) v = Array.from(document.querySelectorAll('video')).find(x => x.currentSrc === a.src || x.src === a.src);
                if (!v) return null;
                const r = v.getBoundingClientRect();
                const rect = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
                try {
                    const c = document.createElement('canvas');
                    c.width = v.videoWidth; c.height = v.videoHeight;
                    c.getContext('2d').drawImage(v, 0, 0);
                    return { data: c.toDataURL('image/png'), rect };
                } catch (e) { return { data: null, rect }; }
            })()`, true);
        }
        catch (e) { log.debug('tab-context-menu', 'video frame', e); }
        if (res?.data && res.data.length > 30)
            return nativeImage.createFromDataURL(res.data);
        if (res?.rect && res.rect.width > 0 && res.rect.height > 0) {
            try { return await wc.capturePage(res.rect); }
            catch (e) { log.warn('tab-context-menu', 'video frame capture failed', e); }
        }
        return null;
    }
    async saveImage(img, name) {
        try {
            const { dialog, app } = require('electron');
            const path = require('path');
            const r = await dialog.showSaveDialog(this.tabManager.mainWindow, {
                defaultPath: path.join(app.getPath('downloads'), name),
                filters: [{ name: 'PNG image', extensions: ['png'] }],
            });
            if (!r.canceled && r.filePath)
                await require('fs').promises.writeFile(r.filePath, img.toPNG());
        }
        catch (e) { log.warn('tab-context-menu', 'save frame failed', e); }
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
                    // Runs IN THE PAGE: no app logger there, so failures come
                    // back through the returned promise and are logged here.
                    this.tab.webContents.executeJavaScript(`(async () => {
                        if (document.pictureInPictureElement) { await document.exitPictureInPicture(); return; }
                        const src = ${src};
                        const vids = Array.from(document.querySelectorAll('video'));
                        let v = vids.find(x => x.currentSrc === src || x.src === src)
                             || vids.filter(x => !x.paused)[0] || vids[0];
                        if (v && v.requestPictureInPicture) await v.requestPictureInPicture();
                    })()`, true).catch((e) => log.debug('tab-context-menu', 'picture in picture', e));
                },
            });
        }
        // Loop and the player's own controls, as every browser offers. Found by
        // the point that was clicked, else by its address.
        const flags = params.mediaFlags || {};
        const toggle = (prop) => {
            const at = JSON.stringify({ x: params.x || 0, y: params.y || 0, src: params.srcURL || '', prop });
            this.tab.webContents.executeJavaScript(`(() => {
                const a = ${at};
                const hit = document.elementFromPoint(a.x, a.y);
                let m = hit && hit.closest && hit.closest('video, audio');
                if (!m) m = Array.from(document.querySelectorAll('video, audio')).find(x => x.currentSrc === a.src || x.src === a.src);
                if (m) m[a.prop] = !m[a.prop];
            })()`, true).catch((e) => log.debug('tab-context-menu', 'media ' + prop, e));
        };
        this.contextTemplate.push({
            label: 'Loop',
            type: 'checkbox',
            checked: !!flags.isLooping,
            click: () => toggle('loop'),
        }, {
            label: 'Show controls',
            type: 'checkbox',
            checked: !!flags.isControlsVisible,
            click: () => toggle('controls'),
        }, { type: 'separator' }, ...(params.mediaType === 'video' ? [{
            label: 'Copy video frame',
            click: () => this.videoFrame(params).then((img) => { if (img) clipboard.writeImage(img); }),
        }, {
            label: 'Save video frame as…',
            click: () => this.videoFrame(params).then((img) => img && this.saveImage(img, 'video-frame.png')),
        }] : []), {
            label: `Open ${label.toLowerCase()} in new tab`,
            click: () => this.openInNewTab(params.srcURL),
        }, {
            label: `Save ${label.toLowerCase()} as…`,
            click: () => downloadManager.saveAs(this.tab.webContents, params.srcURL),
        }, {
            label: `Copy ${label.toLowerCase()} address`,
            click: () => clipboard.writeText(params.srcURL),
        });
    }
}

module.exports = TabContextMenu;