const { clipboard, shell } = require('electron');
const { sanitizeUrl, isSafeExternal } = require('./url-security');
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
        catch { }
        this.tabManager.createLazyTab(safe, title, false, false, true, true);
    }
    addPageItems(params) {
        const wc = this.tab.webContents;
        const currentUrl = wc.getURL ? wc.getURL() : '';
        const isRealPage = currentUrl && !currentUrl.startsWith('file://');
        this.sep();
        this.contextTemplate.push({
            label: 'Back',
            enabled: wc.navigationHistory?.canGoBack() ?? false,
            click: () => { try {
                wc.navigationHistory.goBack();
            }
            catch { } },
        }, {
            label: 'Forward',
            enabled: wc.navigationHistory?.canGoForward() ?? false,
            click: () => { try {
                wc.navigationHistory.goForward();
            }
            catch { } },
        }, {
            label: 'Reload',
            click: () => wc.reload(),
        });
        if (isRealPage) {
            this.sep();
            this.contextTemplate.push({
                label: 'Save Page As…',
                click: () => wc.downloadURL(currentUrl),
            }, {
                label: 'Print…',
                click: () => wc.print(),
            }, {
                label: 'View Page Source',
                click: () => this.openInNewTab(`view-source:${currentUrl}`),
            });
            this.sep();
            this.contextTemplate.push({
                label: 'Copy Page URL',
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
            label: 'Inspect Element',
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
        this.contextTemplate.push({
            label: 'Copy',
            role: 'copy',
            enabled: params.editFlags.canCopy,
        }, {
            label: `Search Google for "${truncated}"`,
            click: () => this.openInNewTab(`https://www.google.com/search?q=${encodeURIComponent(params.selectionText)}`),
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
            label: 'Add to Dictionary',
            click: () => { try {
                sess.addWordToSpellCheckerDictionary(params.misspelledWord);
            }
            catch { } },
        });
    }
    addEditableItems(params) {
        if (!params.isEditable)
            return;
        this.sep();
        this.contextTemplate.push({ label: 'Undo', role: 'undo', enabled: params.editFlags.canUndo }, { label: 'Redo', role: 'redo', enabled: params.editFlags.canRedo }, { type: 'separator' }, { label: 'Cut', role: 'cut', enabled: params.editFlags.canCut }, { label: 'Copy', role: 'copy', enabled: params.editFlags.canCopy }, { label: 'Paste', role: 'paste', enabled: params.editFlags.canPaste }, { label: 'Select All', role: 'selectAll' });
    }
    addLinkItems(params) {
        if (!params.linkURL)
            return;
        this.contextTemplate.push({
            label: 'Open Link in New Tab',
            click: () => this.openInNewTab(params.linkURL),
        }, {
            label: 'Open Link in New Window',
            click: () => { if (isSafeExternal(params.linkURL))
                shell.openExternal(params.linkURL); },
        }, {
            label: 'Copy Link Address',
            click: () => clipboard.writeText(params.linkURL),
        }, {
            label: 'Save Link As…',
            click: () => this.tab.webContents.downloadURL(params.linkURL),
        });
    }
    addImageItems(params) {
        if (!params.srcURL || params.mediaType !== 'image')
            return;
        this.sep();
        this.contextTemplate.push({
            label: 'Save Image As…',
            click: () => this.tab.webContents.downloadURL(params.srcURL),
        }, {
            label: 'Copy Image Address',
            click: () => clipboard.writeText(params.srcURL),
        }, {
            label: 'Open Image in New Tab',
            click: () => this.openInNewTab(params.srcURL),
        }, {
            label: 'Search Google for Image',
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
                label: 'Picture-in-Picture',
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
                        } catch (e) {}
                    })()`, true).catch(() => { });
                },
            });
        }
        this.contextTemplate.push({
            label: `Open ${label} in New Tab`,
            click: () => this.openInNewTab(params.srcURL),
        }, {
            label: `Save ${label} As…`,
            click: () => this.tab.webContents.downloadURL(params.srcURL),
        }, {
            label: 'Copy Media Address',
            click: () => clipboard.writeText(params.srcURL),
        });
    }
}

module.exports = TabContextMenu;