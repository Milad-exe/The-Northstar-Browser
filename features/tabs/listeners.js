'use strict';
/**
 * Everything a tab's webContents can tell us.
 *
 * Lifted out of features/tabs.js, where setupTabListeners was a single 521-line
 * method — a fifth of that file — wiring every did-navigate, favicon, title,
 * media, download, permission and crash signal in one place. It is one method
 * still, because the listeners genuinely are one unit of work (they all close
 * over the same tab and index), but it is no longer sitting on top of the tab
 * manager's own logic.
 *
 * Mixed into Tabs.prototype at the bottom of features/tabs.js, so `this` is the
 * Tabs instance and nothing here requires Tabs back — the same seam split.js,
 * glance.js, organize.js and essentials.js use.
 */
const path = require('path');
const hangPrompt = require('../hang-prompt');
const { resolveAppFile } = require('../../app-paths');
const captivePortal = require('../captive-portal');
const containers = require('../containers');
const faviconStore = require('../favicon-store');
const focusMode = require('../focus-mode');
const i18n = require('../i18n');
const log = require('../log');
const miniPlayer = require('../mini-player');
const zoom = require('../zoom');
const { internalTokenFor } = require('./internal-page');

module.exports = {
    setupTabListeners(tabIndex, tab) {
        let isNavigatingProgrammatically = false;
        let lastAddedUrl = null;
        if (this.shortcuts) {
            this.shortcuts.onTabCreated(tab);
        }
        // Block dangerous protocol navigations (javascript:, data:, vbscript:) initiated
        // by page scripts or injected links.
        const blockDangerousNav = (event, url) => {
            try {
                const proto = new URL(url).protocol;
                if (proto === 'javascript:' || proto === 'data:' || proto === 'vbscript:') {
                    event.preventDefault();
                }
            }
            catch (e) { log.debug('tabs', 'blockDangerousNav', e); }
        };
        tab.webContents.on('will-navigate', blockDangerousNav);
        tab.webContents.on('will-redirect', blockDangerousNav);
        /* An Essential stays on its site. A link that would take it somewhere
           else opens as a glance OVER it instead — the browsers this design
           follows do the same, precisely so the one tab you keep pointing at
           a site is still pointing at it an hour later. Sign-in hand-offs and a
           tab that has already been sent elsewhere deliberately are left alone
           (features/tabs/essential-rules.js). */
        tab.webContents.on('will-navigate', (event, url) => {
            try {
                if (!this._essentialPeek(tabIndex, url))
                    return;
                event.preventDefault();
                this.openGlance(url);
            }
            catch (e) { log.debug('tabs', 'essential peek', e); }
        });
        tab.webContents.on('did-navigate', (event, url) => {
            // Keep the view backing in sync: frosted (transparent) for internal
            // pages, opaque for web content so vibrancy doesn't bleed through.
            this._applyTabBackground(tab, url);
            this._markColorSchemeRendered(tab);
            // Restore the zoom this site was last read at. Chromium resets the
            // level per navigation, so this has to run on every one.
            zoom.apply(tab.webContents, url);
            // Navigating away invalidates the restored reading position.
            if (tab._restoreScroll === false)
                this.tabScroll.delete(tabIndex);
            // Reader view loaded — keep the address bar showing the real page URL
            // and the article title instead of the internal file:// path.
            if (url.includes('/Reader/index.html')) {
                const orig = this.readerOriginal.get(tabIndex) || '';
                const art = this.readerArticles.get(tabIndex);
                this.tabUrls.set(tabIndex, orig || 'reader');
                lastAddedUrl = orig;
                this.sendTabUpdate(tabIndex, tab, orig, art?.title || 'Reader View');
                this.sendNavigationUpdate(tabIndex);
                try {
                    this.mainWindow.webContents.send('reader-state', { index: tabIndex, active: true, available: true });
                }
                catch (e) { log.debug('tabs', 'blockDangerousNav', e); }
                isNavigatingProgrammatically = false;
                return;
            }
            // Any other navigation exits reader mode for this tab.
            if (this.readerMode.has(tabIndex)) {
                this.readerMode.delete(tabIndex);
                this.readerArticles.delete(tabIndex);
                try {
                    this.mainWindow.webContents.send('reader-state', { index: tabIndex, active: false });
                }
                catch (e) { log.debug('tabs', 'blockDangerousNav', e); }
            }
            if (url === 'about:blank') {
                // The blank tab. It carries the 'newtab' token so the omnibox
                // stays empty and the tab still reads as blank.
                this.tabUrls.set(tabIndex, 'newtab');
                lastAddedUrl = 'newtab';
                this.sendTabUpdate(tabIndex, tab, 'newtab');
                this.sendNavigationUpdate(tabIndex);
                return;
            }
            if (!url.startsWith('file://') && !isNavigatingProgrammatically) {
                if (lastAddedUrl !== url) {
                    this.tabUrls.set(tabIndex, url);
                    this.navigationHistory.addEntry(tabIndex, url);
                    lastAddedUrl = url;
                    this.sendTabUpdate(tabIndex, tab, url);
                    this.sendNavigationUpdate(tabIndex);
                    if (!this.privateTabs.has(tabIndex)) {
                        this.addToHistory(url, tab.webContents.getTitle(), this.tabContainers.get(tabIndex) || null);
                    }
                    this.saveStateDebounced();
                }
            }
            else if (url.startsWith('file://')) {
                // Internal page → a northstar:// token (e.g. 'settings/appearance'),
                // else the plain new-tab page.
                const token = internalTokenFor(url) || 'newtab';
                const base = token.split('/')[0];
                this.tabUrls.set(tabIndex, token);
                lastAddedUrl = token;
                let title = i18n.t('tab.untitled');
                if (base === 'settings')
                    title = 'Settings';
                else if (base === 'bookmarks')
                    title = 'Bookmarks';
                else if (base === 'history')
                    title = 'History';
                else if (base === 'home')
                    title = i18n.t('chrome.newTab');
                this.sendTabUpdate(tabIndex, tab, token, title);
                this.sendNavigationUpdate(tabIndex);
            }
            const windowData = this.getWindowData();
            if (windowData)
                focusMode.applyToTab(windowData, tab.webContents, url);
            this.applyYouTubeSpaceFix(tab, url);
            isNavigatingProgrammatically = false;
        });
        // window.open / target="_blank" handling.
        //
        // target="_blank" links and plain window.open() calls open as a new tab in
        // the same window — never a stray BrowserWindow.
        //
        // BUT genuine popups (a window.open() with a features string, or a popup
        // disposition) MUST be allowed to open as a real popup window with the
        // window.opener link intact. OAuth sign-in flows ("Sign in with Google",
        // Facebook/Discord/Twitch login), payment sheets, and pop-out web games
        // depend on that opener relationship — the popup posts its result back to
        // the opener (postMessage) and closes itself (window.close()). Forcing
        // those into a tab silently breaks login and leaves an orphaned tab that
        // the page can never close.
        /* A popup has no chrome — no address bar, no lock — so the ONLY thing
           identifying it is its title bar, and by default that shows whatever
           title the page gives itself. A window that can name itself
           "Sign in — Google" while being served from somewhere else is a
           phishing surface, which is why real browsers show the ORIGIN in a
           popup and refuse to let the page override it. So do we: the title is
           the origin, it follows navigation, and page-title-updated is
           suppressed. */
        tab.webContents.on('did-create-window', (win, details) => {
            try {
                const originOf = (u) => {
                    try { return new URL(u).origin.replace(/^https:\/\//, ''); }
                    catch (e) { return u || ''; }
                };
                const paint = (u) => {
                    if (win.isDestroyed())
                        return;
                    try { win.setTitle(originOf(u)); }
                    catch (e) { log.debug('tabs', 'popup title', e); }
                };
                paint(details?.url || win.webContents.getURL());
                win.webContents.on('page-title-updated', (e) => {
                    e.preventDefault();
                    paint(win.webContents.getURL());
                });
                win.webContents.on('did-navigate', (_e, u) => paint(u));
                win.webContents.on('did-navigate-in-page', (_e, u) => paint(u));
            }
            catch (e) { log.debug('tabs', 'did-create-window', e); }
        });
        tab.webContents.setWindowOpenHandler(({ url, disposition, features }) => {
            // Block dangerous protocols outright, whatever the disposition.
            try {
                const proto = new URL(url).protocol;
                if (proto === 'javascript:' || proto === 'data:' || proto === 'vbscript:') {
                    return { action: 'deny' };
                }
            }
            catch {
                return { action: 'deny' };
            }
            const isPopup = disposition === 'new-popup' ||
                (typeof features === 'string' && features.trim().length > 0);
            if (isPopup) {
                // Let Chromium open a real popup. It inherits the opener's session
                // (so a private tab's popup stays in the private session), and the
                // session-level permission/privacy handlers still apply.
                return {
                    action: 'allow',
                    overrideBrowserWindowOptions: {
                        autoHideMenuBar: true,
                        webPreferences: {
                            contextIsolation: true,
                            nodeIntegration: false,
                            sandbox: true,
                        },
                    },
                };
            }
            setImmediate(async () => {
                const isPriv = this.privateTabs.has(tabIndex);
                const srcContainer = this.tabContainers.get(tabIndex) || null;
                const r = this.resolveIsolation(tabIndex, url, srcContainer);
                if (r.mode === 'isolate') {
                    this.openInContainer(url, containers.instanceForHost(url, this.profileId).id, tabIndex);
                    return;
                }
                if (r.mode === 'ask') {
                    const decision = await this._promptIsolate(this.tabMap.get(tabIndex)?.webContents, url);
                    if (decision === 'isolate') {
                        this.openInContainer(url, containers.instanceForHost(url, this.profileId).id, tabIndex);
                        return;
                    }
                    const ni = this.createTab(tabIndex, false, isPriv);
                    this.loadUrl(ni, url);
                    return;
                }
                // 'keep' carries the opener's instance; 'default' → default session.
                const newIndex = this.createTab(tabIndex, false, isPriv, srcContainer);
                this.loadUrl(newIndex, url);
            });
            return { action: 'deny' };
        });
        // Links opened from DevTools — middle-click / Ctrl-click a URL, or pick
        // "Open in new tab" on one in the Console / Network / Elements / Sources
        // panels. Electron surfaces these through 'devtools-open-url' (the
        // DevTools frontend is a separate webContents, so they never reach the
        // window-open handler above). Route them into a new tab like any link.
        tab.webContents.on('devtools-open-url', (_event, url) => {
            try {
                const proto = new URL(url).protocol;
                if (proto === 'javascript:' || proto === 'data:' || proto === 'vbscript:')
                    return;
            }
            catch {
                return;
            }
            setImmediate(() => {
                const isPriv = this.privateTabs.has(tabIndex);
                const newIndex = this.createTab(tabIndex, false, isPriv);
                this.loadUrl(newIndex, url);
            });
        });
        tab.webContents.on('did-navigate-in-page', (event, url) => {
            if (url === 'about:blank') {
                // The blank tab. It carries the 'newtab' token so the omnibox
                // stays empty and the tab still reads as blank.
                this.tabUrls.set(tabIndex, 'newtab');
                lastAddedUrl = 'newtab';
                this.sendTabUpdate(tabIndex, tab, 'newtab');
                this.sendNavigationUpdate(tabIndex);
                return;
            }
            if (!url.startsWith('file://') && !isNavigatingProgrammatically) {
                const currentUrl = this.tabUrls.get(tabIndex);
                if (currentUrl !== url && lastAddedUrl !== url) {
                    this.tabUrls.set(tabIndex, url);
                    this.navigationHistory.addEntry(tabIndex, url);
                    lastAddedUrl = url;
                    this.sendTabUpdate(tabIndex, tab, url);
                    this.sendNavigationUpdate(tabIndex);
                    if (!this.privateTabs.has(tabIndex)) {
                        this.addToHistory(url, tab.webContents.getTitle(), this.tabContainers.get(tabIndex) || null);
                    }
                    this.saveStateDebounced();
                }
            }
            else if (url.startsWith('file://')) {
                // Settings section changes drive location.hash → recompute the
                // northstar://settings/<section> token so the omnibox stays live.
                const token = internalTokenFor(url);
                if (token && this.tabUrls.get(tabIndex) !== token) {
                    this.tabUrls.set(tabIndex, token);
                    lastAddedUrl = token;
                    this.sendTabUpdate(tabIndex, tab, token);
                    this.sendNavigationUpdate(tabIndex);
                }
            }
            const windowData = this.getWindowData();
            if (windowData)
                focusMode.applyToTab(windowData, tab.webContents, url);
            this.applyYouTubeSpaceFix(tab, url);
            // Clear the programmatic-nav guard here too (did-navigate already
            // does): a native back/forward that resolves as a same-document
            // history navigation (SPA hash/pushState routes) fires only this
            // event, and a stuck flag would suppress the NEXT real entry.
            isNavigatingProgrammatically = false;
        });
        tab.isNavigatingProgrammatically = () => isNavigatingProgrammatically;
        tab.setNavigatingProgrammatically = (value) => { isNavigatingProgrammatically = value; };
        // HTML5 Fullscreen (e.g. YouTube videos)
        tab.webContents.on('enter-html-full-screen', () => {
            this.isHtmlFullScreen = true;
            this.htmlFullScreenRequested = !this.userFullScreenActive;
            if (this.htmlFullScreenRequested && !this.mainWindow.isFullScreen()) {
                this.mainWindow.setFullScreen(true);
            }
            this.resizeAllTabs();
        });
        tab.webContents.on('leave-html-full-screen', () => {
            if (this.htmlFullScreenRequested && this.mainWindow.isFullScreen()) {
                // OS fullscreen will exit next. Keep isHtmlFullScreen = true so
                // getTabBounds() returns full-window bounds during the macOS exit
                // animation — avoids a corrupted intermediate state (full-window size
                // minus the 88px toolbar offset) that visually sticks until a mouse
                // event triggers a repaint. leave-full-screen clears the flag and does
                // the final resize once the animation is done.
                // Also keep htmlFullScreenRequested = true so leave-full-screen knows
                // NOT to call applyYouTubeExitFullscreen (which would race the animation
                // and double-toggle back into fullscreen on macOS).
                setTimeout(() => {
                    try {
                        if (this.mainWindow && !this.mainWindow.isDestroyed() && this.mainWindow.isFullScreen()) {
                            this.mainWindow.setFullScreen(false);
                        }
                    }
                    catch (e) { log.debug('tabs', 'blockDangerousNav', e); }
                }, 0);
            }
            else {
                // No OS fullscreen exit pending — clean up immediately.
                this.isHtmlFullScreen = false;
                this.htmlFullScreenRequested = false;
                // Do NOT call applyYouTubeExitFullscreen here — YouTube cleans up its own
                // CSS state (.ytp-fullscreen) when HTML5 fullscreen exits. Clicking the button
                // here causes a double-toggle and also fires spuriously when DevTools opens.
                this.resizeAllTabs();
            }
        });
        // ── Crash + hang recovery ────────────────────────────────────────────
        // Without these a crashed renderer leaves a blank rectangle the user can
        // only fix by closing the tab, and a page stuck in a loop can't be
        // stopped from the UI at all.
        tab.webContents.on('render-process-gone', (_event, details) => {
            // 'clean-exit' is the sleep scan discarding an idle tab on purpose.
            if (details?.reason === 'clean-exit' || tab.slept || tab._unloading)
                return;
            const url = this.tabUrls.get(tabIndex) || '';
            log.error('tabs', `renderer gone for tab ${tabIndex}: ${details?.reason} (exit ${details?.exitCode})`);
            // Mark the row crashed (warning glyph, dimmed title); cleared by the
            // next load the user starts (P1-8). Sent once the crash PAGE has
            // loaded: sent before it, that page's own load cleared the mark at
            // once and the glyph never showed.
            const markCrashed = () => {
                try { this.mainWindow.webContents.send('tab-crashed', { index: tabIndex }); }
                catch (e) { log.debug('tabs', 'tab-crashed', e); }
            };
            try { tab.webContents.once('did-stop-loading', markCrashed); }
            catch (e) { log.debug('tabs', 'tab-crashed wait', e); markCrashed(); }
            const params = new URLSearchParams({
                url: url && url !== 'newtab' ? url : '',
                reason: details?.reason || 'crashed',
                killed: tab._killedForHang ? '1' : '',
            });
            tab._killedForHang = false;
            try {
                tab.webContents.loadFile(resolveAppFile('renderer/Crashed/index.html'), { search: '?' + params.toString() });
            }
            catch (e) {
                log.error('tabs', 'could not show the crash page', e);
            }
        });
        // A page pinning its main thread: offer to wait or stop it, the way
        // every other browser does. Only for the tab the user is looking at —
        // a background tab churning is not worth a modal.
        tab.webContents.on('unresponsive', () => {
            if (this.activeTabIndex !== tabIndex || tab._hangPrompt)
                return;
            tab._hangPrompt = true;
            const host = (() => {
                try { return new URL(this.tabUrls.get(tabIndex) || '').host; }
                catch { return 'This page'; }
            })();
            // A tab-scoped overlay (P2-3), not a native message box: it matches
            // the chrome, is anchored to this page's card, and auto-dismisses
            // when the page recovers (responsive, below).
            hangPrompt.show(this.getWindowData(), this, tabIndex, host);
        });
        tab.webContents.on('responsive', () => {
            tab._hangPrompt = false;
            try { hangPrompt.hide(this.getWindowData()); }
            catch (e) { log.debug('tabs', 'hang prompt hide', e); }
        });
        // Error page — skip aborts (e.g. navigating away mid-load) and sub-frame errors
        tab.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
            if (!isMainFrame)
                return;
            if (errorCode === -3)
                return; // ERR_ABORTED — e.g. the user hit stop.
            const params = new URLSearchParams({
                url: validatedURL || '',
                code: String(errorCode),
                desc: errorDescription || '',
            });
            isNavigatingProgrammatically = true;
            tab.webContents.loadFile(resolveAppFile('renderer/Error/index.html'), { search: '?' + params.toString() });
            // A failed http(s) load may mean a captive portal intercepted us
            // (redirect / TLS block) — probe and, if so, auto-open its sign-in page.
            if ((validatedURL || '').startsWith('http'))
                captivePortal.check((loginUrl) => this.openCaptivePortalSignIn(loginUrl));
        });
        tab.webContents.on('found-in-page', (event, result) => {
            if (this.findDialog) {
                this.findDialog.handleFindResult(result);
            }
        });
        tab.webContents.on('page-title-updated', (event, title) => {
            if (tab._unloading)
                return; // discarding: keep the row's own title
            tab.lazyTitle = title;
            this.navigationHistory.setCurrentTitle(tabIndex, title);
            const currentUrl = this.tabUrls.get(tabIndex) || '';
            // The visit was recorded at navigation, before the document had a
            // title. This is where the real one shows up, so this is where
            // history learns it — otherwise every row keeps the URL-shaped
            // placeholder getTitle() returned at commit time.
            if (!this.privateTabs.has(tabIndex))
                this.updateHistoryTitle(currentUrl, title, this.tabContainers.get(tabIndex) || null);
            if (currentUrl !== 'newtab' && currentUrl !== 'history' && !currentUrl.startsWith('file://')) {
                this.sendTabUpdate(tabIndex, tab, currentUrl, title);
            }
        });
        tab.webContents.on('page-favicon-updated', (event, favicons) => {
            const currentUrl = this.tabUrls.get(tabIndex) || '';
            if (currentUrl !== 'newtab' && currentUrl !== 'history' && !currentUrl.startsWith('file://')) {
                const favicon = favicons && favicons.length > 0 ? favicons[0] : null;
                this.sendTabUpdate(tabIndex, tab, currentUrl, tab.webContents.getTitle(), favicon);
                // Cache this visited site's favicon by host so suggestions/bookmarks
                // can show it later with no network fetch (features/favicon-store.js).
                if (!this.privateTabs.has(tabIndex))
                    faviconStore.remember(currentUrl, favicon);
            }
        });
        tab.webContents.on('did-start-loading', () => {
            clearTimeout(tab._loadingCapTimer);
            this.sendLoadingState(tabIndex, true, 'waiting');
        });
        // DOMContentLoaded: the page is parsed and usable. Many sites then keep
        // the network "loading" for 10-20s+ on non-essential third-party junk —
        // "Sign in with Google" (accounts.google.com/gsi/client), reCAPTCHA, ad
        // exchanges, error-tracker beacons — none of which affect the visible
        // page. Don't leave the tab spinning that whole time: clear the loading
        // indicator a short grace after dom-ready (unless did-stop-loading beat
        // us to it). Matches when the page actually feels loaded.
        tab.webContents.on('dom-ready', () => {
            clearTimeout(tab._loadingCapTimer);
            tab._loadingCapTimer = setTimeout(() => {
                try {
                    if (!tab.webContents.isDestroyed() && tab.webContents.isLoading()) {
                        this.sendLoadingState(tabIndex, false);
                    }
                }
                catch(e){}
            }, 3000);
        });
        tab.webContents.on('did-finish-load', () => {
            this.sendNavigationUpdate(tabIndex);
            this.detectReaderable(tabIndex, tab);
            // A tab restored from the last session opens where it was left. Once
            // only: after this the page owns its own scrolling. Deferred a beat
            // so late-laying-out pages don't snap back to the top.
            const y = this.tabScroll.get(tabIndex);
            if (y > 0 && tab._restoreScroll !== false) {
                tab._restoreScroll = false;
                setTimeout(() => {
                    try {
                        tab.webContents.executeJavaScript(`window.scrollTo(0, ${Number(y) || 0})`, true).catch(() => { });
                    }
                    catch(e){}
                }, 220);
            }
        });
        tab.webContents.on('did-stop-loading', () => {
            clearTimeout(tab._loadingCapTimer);
            this.sendNavigationUpdate(tabIndex);
            this.sendLoadingState(tabIndex, false);
        });
        // Picture-in-Picture is only offered while media is actually playing.
        // Track a per-tab flag and tell the chrome to show/hide the PiP button.
        tab.webContents.on('media-started-playing', () => {
            // A background-opened tab the user hasn't viewed yet must not play
            // media on its own — muted autoplay, or user-activation inherited from
            // the click that opened the tab, can otherwise start a video in the
            // background. Pause it and don't mark it as playing; showTab clears the
            // hold, so it plays normally once the user actually opens the tab.
            if (tab.bgHoldMedia && tabIndex !== this.activeTabIndex) {
                try {
                    tab.webContents.executeJavaScript("(()=>{try{document.querySelectorAll('video,audio').forEach(m=>{try{m.pause();}catch(e){}});}catch(e){}})()", true).catch(() => { });
                }
                catch(e){}
                return;
            }
            tab.hasPlayingMedia = true;
            if (tabIndex === this.activeTabIndex) {
                try {
                    this.mainWindow.webContents.send('media-state', { index: tabIndex, playing: true });
                }
                catch(e){}
            }
            // Mini player: media playing in a background tab shows the overlay.
            try {
                miniPlayer.onMediaState(this.getWindowData(), tabIndex, true);
            }
            catch(e){}
            this.sendMediaIndicators(tabIndex, tab); // muted tabs stay marked while playing
        });
        tab.webContents.on('media-paused', () => {
            tab.hasPlayingMedia = false;
            if (tabIndex === this.activeTabIndex) {
                try {
                    this.mainWindow.webContents.send('media-state', { index: tabIndex, playing: false });
                }
                catch(e){}
            }
            try {
                miniPlayer.onMediaState(this.getWindowData(), tabIndex, false);
            }
            catch(e){}
            this.sendMediaIndicators(tabIndex, tab);
        });
        // ── Tab-strip media indicators ────────────────────────────────────────
        // Speaker on audible tabs; mic/camera (recording) from the permission
        // layer's custom event — a granted getUserMedia is when capture starts.
        // Chromium gives no stream-ended signal, so recording clears on
        // navigation (the temp permission grants clear there too).
        tab.webContents.on('audio-state-changed', (e) => {
            tab.isAudible = !!e.audible;
            // Recently-audible sleep protection (P0-5): stamp the moment of any
            // transition — on start it just became audible, and on stop it was
            // audible up to this instant — so the 60 s grace is measured from
            // when sound actually ended, not from when it began.
            tab.lastAudibleAt = Date.now();
            this.sendMediaIndicators(tabIndex, tab);
        });
        // Page lifecycle signals for sleep eligibility (P0-5). These come from
        // the page's own preload over IPC (not a `window.` flag — with
        // contextIsolation the preload's world is invisible to executeJavaScript),
        // and are read synchronously by the sleeper. Both clear on navigation.
        tab.webContents.ipc.on('page-dirty', () => { tab.dirty = true; });
        tab.webContents.ipc.on('page-pip', (_e, active) => { tab.inPiP = !!active; });
        tab.webContents.on('media-capture-started', (names) => {
            if (!tab.capturing)
                tab.capturing = new Set();
            (Array.isArray(names) ? names : []).forEach(n => tab.capturing.add(n));
            this.sendMediaIndicators(tabIndex, tab);
        });
        tab.webContents.on('did-navigate', () => {
            // The response committed — move the throbber from waiting (grey) to
            // loading (accent + favicon), but only while the page is still
            // fetching, so a cached/instant load doesn't re-arm a finished tab.
            try {
                if (!tab.webContents.isDestroyed() && tab.webContents.isLoading())
                    this.sendLoadingState(tabIndex, true, 'loading');
            }
            catch (e) { log.debug('tabs', 'did-navigate loading phase', e); }
            if (tab.capturing && tab.capturing.size) {
                tab.capturing.clear();
                this.sendMediaIndicators(tabIndex, tab);
            }
            // A new document starts clean: drop the form-dirty and PiP flags so a
            // page left dirty before navigating away becomes sleep-eligible again
            // (the preload re-runs and re-reports if the new page earns them).
            tab.dirty = false;
            tab.inPiP = false;
        });
    },
};
