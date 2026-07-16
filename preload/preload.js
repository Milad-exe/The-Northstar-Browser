const { contextBridge, ipcRenderer } = require('electron');

// Enable the <browser-action-list> element for extension toolbar buttons.
// This preload is shared by the chrome window and by tabs, so only inject the
// element into the browser chrome page — not arbitrary web pages.
try {
    const isFile = location.protocol === 'file:';
    const isChrome    = isFile && /\/Browser\/index\.html$/.test(location.pathname);
    // Chrome + internal pages paint translucently over the window vibrancy.
    const isFrostable = isFile && /\/(Browser|NewTab|Settings|History|Bookmarks)\/(index|private)\.html$/.test(location.pathname);

    // macOS frosted-glass: flag frostable pages so their CSS goes translucent.
    if (process.platform === 'darwin' && isFrostable) {
        const mark = () => document.documentElement.setAttribute('data-vibrancy', 'true');
        if (document.documentElement) mark();
        else document.addEventListener('DOMContentLoaded', mark);
    }

    if (isChrome) {
        // Require by absolute file path — Electron's (non-sandboxed) preload
        // require can't resolve this package by name (its "exports" map isn't
        // honored here). The chrome window runs with sandbox:false so this works.
        const p = require('path');
        const baPath = p.join(__dirname, '..', 'node_modules', 'electron-chrome-extensions', 'dist', 'cjs', 'browser-action.js');
        require(baPath).injectBrowserAction();
    }
} catch (e) {}

try {
    const settings = ipcRenderer.sendSync('settings-get-sync');
    if (settings && settings.theme && settings.theme !== 'default') {
        const applyTheme = () => document.documentElement.setAttribute('data-theme', settings.theme);
        if (document.documentElement) applyTheme();
        else document.addEventListener('DOMContentLoaded', applyTheme);
    }
} catch (e) {}

ipcRenderer.on('theme-changed', (_e, theme) => {
    if (theme && theme !== 'default') {
        document.documentElement.setAttribute('data-theme', theme);
    } else {
        document.documentElement.removeAttribute('data-theme');
    }
});

function findAnchorInEventPath(event) {
    try {
        if (event && typeof event.composedPath === 'function') {
            const path = event.composedPath();
            for (const node of path) {
                if (node && node.nodeType === 1 && node.tagName === 'A' && node.href) return node;
            }
        }
    } catch {}

    let el = event ? event.target : null;
    while (el && el.nodeType === 1) {
        if (el.tagName === 'A' && el.href) return el;
        el = el.parentElement;
    }
    return null;
}

function clearDocumentSelection() {
    try {
        const sel = window.getSelection && window.getSelection();
        if (sel && sel.rangeCount > 0) sel.removeAllRanges();
    } catch {}

    try {
        const active = document.activeElement;
        if (!active) return;
        if (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') {
            const end = typeof active.selectionEnd === 'number' ? active.selectionEnd : 0;
            active.setSelectionRange(end, end);
        }
    } catch {}
}

let suppressLinkSelection = false;
let suppressLinkSelectionTimer = null;

function ensureSuppressSelectionStyle() {
    const styleId = 'ink-suppress-link-selection-style';
    if (document.getElementById(styleId)) return;
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
html.ink-suppress-link-selection,
html.ink-suppress-link-selection * {
    -webkit-user-select: none !important;
    user-select: none !important;
}
html.ink-suppress-link-selection ::selection {
    background: transparent !important;
    color: inherit !important;
}
`;
    const host = document.head || document.documentElement;
    if (host) host.appendChild(style);
}

function enableLinkSelectionSuppression() {
    ensureSuppressSelectionStyle();
    suppressLinkSelection = true;
    if (suppressLinkSelectionTimer) {
        clearTimeout(suppressLinkSelectionTimer);
        suppressLinkSelectionTimer = null;
    }
    try { document.documentElement.classList.add('ink-suppress-link-selection'); } catch {}
    clearDocumentSelection();
}

function disableLinkSelectionSuppression(delay = 120) {
    if (suppressLinkSelectionTimer) clearTimeout(suppressLinkSelectionTimer);
    suppressLinkSelectionTimer = setTimeout(() => {
        suppressLinkSelection = false;
        try { document.documentElement.classList.remove('ink-suppress-link-selection'); } catch {}
        clearDocumentSelection();
        suppressLinkSelectionTimer = null;
    }, delay);
}

// Right-clicking links should not create or retain text highlighting.
const onLinkRightMouseDown = (event) => {
    if (!event || event.button !== 2) return;
    if (!findAnchorInEventPath(event)) return;
    enableLinkSelectionSuppression();
    event.preventDefault();
};

document.addEventListener('pointerdown', onLinkRightMouseDown, true);
document.addEventListener('mousedown', onLinkRightMouseDown, true);

document.addEventListener('selectstart', (event) => {
    if (!suppressLinkSelection) return;
    event.preventDefault();
}, true);

document.addEventListener('contextmenu', (event) => {
    if (!findAnchorInEventPath(event) && !suppressLinkSelection) return;
    enableLinkSelectionSuppression();
    disableLinkSelectionSuppression();
}, true);

document.addEventListener('mouseup', (event) => {
    if (!suppressLinkSelection) return;
    if (!event || event.button !== 2) return;
    disableLinkSelectionSuppression();
}, true);

window.addEventListener('blur', () => {
    if (!suppressLinkSelection) return;
    disableLinkSelectionSuppression(0);
}, true);

contextBridge.exposeInMainWorld(
    "tab", {
        add: () => ipcRenderer.invoke("addTab"),
        addPrivate: () => ipcRenderer.invoke("addPrivateTab"),
        addLazy: (url) => ipcRenderer.invoke("addTabLazy", url),
        remove: (index) => ipcRenderer.invoke("removeTab", index),
        switch: (index) => ipcRenderer.invoke("switchTab", index),
        loadUrl: (index, url) => ipcRenderer.invoke("loadUrl", index, url),
        goBack: (index) => ipcRenderer.invoke("goBack", index),
        goForward: (index) => ipcRenderer.invoke("goForward", index),
        showNavHistoryMenu: (index, x, y) => ipcRenderer.invoke("show-nav-history-menu", index, x, y),
        reload: (index) => ipcRenderer.invoke("reload", index),
        stop: (index) => ipcRenderer.invoke("stopTab", index),
        getTabUrl: (index) => ipcRenderer.invoke("getTabUrl", index),
        getButton: (index) => ipcRenderer.invoke("getTabButton", index),
        pin: (index) => ipcRenderer.invoke("pinTab", index),
    reorder: (order) => ipcRenderer.invoke('reorderTabs', order),
    onTabCreated: (callback) => ipcRenderer.on('tab-created', callback),
        onTabRemoved: (callback) => ipcRenderer.on('tab-removed', callback),
        onTabSwitched: (callback) => ipcRenderer.on('tab-switched', callback),
        onUrlUpdated: (callback) => ipcRenderer.on('url-updated', callback),
        onNavigationUpdated: (callback) => ipcRenderer.on('navigation-updated', callback),
        onTabLoading: (callback) => ipcRenderer.on('tab-loading', callback)
    }
);

contextBridge.exposeInMainWorld('northstarPrivate', {
    newPrivateWindow: () => ipcRenderer.invoke('newPrivateWindow'),
    isPrivateWindow:  () => ipcRenderer.invoke('isPrivateWindow'),
    // Synchronous variant — lets the renderer finish setup in one tick so tab
    // IPC can't arrive mid-initialization (see renderer.js init comment).
    isPrivateWindowSync: () => { try { return ipcRenderer.sendSync('is-private-window-sync'); } catch { return false; } },
    onSetPrivateWindow: (cb) => ipcRenderer.on('set-private-window', (_e, v) => cb(v)),
});

// Bridge for UI events emitted from main (via Tabs.pinTab -> 'pin-tab')
contextBridge.exposeInMainWorld('tabsUI', {
    onPinTab: (handler) => ipcRenderer.on('pin-tab', (_e, { index }) => handler(index)),
});

// Reader mode + Picture-in-Picture
contextBridge.exposeInMainWorld('reader', {
    toggle:   (index) => ipcRenderer.invoke('reader-toggle', index),
    onState:  (cb) => ipcRenderer.on('reader-state',  (_e, d) => cb(d)),
    onFailed: (cb) => ipcRenderer.on('reader-failed', (_e, d) => cb(d)),
});
contextBridge.exposeInMainWorld('pip', {
    toggle:       (index) => ipcRenderer.invoke('toggle-pip', index),
    onMediaState: (cb) => ipcRenderer.on('media-state', (_e, d) => cb(d)),
});


// Exposed to the Reader view (which loads inside a tab). getArticle() returns
// null unless the tab is actually in reader mode, and exit() is a guarded no-op
// otherwise — safe to expose to ordinary pages.
contextBridge.exposeInMainWorld('northstarReader', {
    getArticle: () => ipcRenderer.invoke('reader-get-article'),
    exit:       () => ipcRenderer.invoke('reader-exit'),
});

// Persistence controls
contextBridge.exposeInMainWorld('persist', {
    getMode: () => ipcRenderer.invoke('getPersistMode'),
    setMode: (enabled) => ipcRenderer.invoke('setPersistMode', enabled),
});

contextBridge.exposeInMainWorld(
    "dragdrop", {
        getWindowAtPoint: (screenX, screenY) => ipcRenderer.invoke('get-window-at-point', screenX, screenY),
        getThisWindowId: () => ipcRenderer.invoke('get-this-window-id'),
        moveTabToWindow: (fromWindowId, tabIndex, targetWindowId, url) => ipcRenderer.invoke('move-tab-to-window', fromWindowId, tabIndex, targetWindowId, url),
        detachToNewWindow: (tabIndex, screenX, screenY, url) => ipcRenderer.invoke('detach-to-new-window', tabIndex, screenX, screenY, url),
        dragTrack: (on) => ipcRenderer.send('tab-drag-track', !!on),
        drop: (tabIndex, url) => ipcRenderer.invoke('tab-drag-drop', tabIndex, url),
        onMergeHover: (fn) => ipcRenderer.on('tab-merge-hover', (_e, v) => fn(v))
    }
);

contextBridge.exposeInMainWorld(
    "menu", {
        open: () => ipcRenderer.invoke('open'),
        close: () => ipcRenderer.invoke('close-menu'),
        onClosed: (callback) => ipcRenderer.on('menu-closed', callback)
    }
);

contextBridge.exposeInMainWorld(
    "browserHistory", {
        get: () => ipcRenderer.invoke('history-get'),
        search: (query, limit) => ipcRenderer.invoke('history-search', query, limit),
        remove: (url, timestamp) => ipcRenderer.invoke('remove-history-entry', url, timestamp)
    }
);

// Suggestions overlay controls from the main renderer
contextBridge.exposeInMainWorld('suggestions', {
    warm: () => ipcRenderer.invoke('suggestions-warm'),
    open: (bounds, items, activeIndex, query, engine) => ipcRenderer.invoke('suggestions-open', { bounds, items, activeIndex, query, engine }),
    update: (bounds, items, activeIndex, query, engine) => ipcRenderer.invoke('suggestions-update', { bounds, items, activeIndex, query, engine }),
    close: () => ipcRenderer.invoke('suggestions-close'),
    onSelected:   (handler) => ipcRenderer.on('suggestion-selected',   (_e, item) => handler(item)),
    onPointerDown:(handler) => ipcRenderer.on('suggestions-pointer-down', () => handler()),
    onCreated:    (handler) => ipcRenderer.on('suggestions-created',    () => handler())
});

contextBridge.exposeInMainWorld("electronAPI", {
  windowClick: (pos) => ipcRenderer.send("window-click", pos),
  onShowFindInPage: (callback) => ipcRenderer.on('show-find-in-page', callback),
  onFocusAddressBar: (callback) => ipcRenderer.on('focus-address-bar', () => callback()),
  openHistoryTab: () => ipcRenderer.invoke('open-history-tab'),
  openBookmarksTab: () => ipcRenderer.invoke('open-bookmarks-tab'),
  navigateActiveTab: (url) => ipcRenderer.invoke('navigate-active-tab', url),
  activeTabGoBack: () => ipcRenderer.invoke('active-tab-go-back'),
  onToggleBookmarkBar:     (handler) => ipcRenderer.on('toggle-bookmark-bar',     () => handler()),
  onBookmarkPromptClosed:  (handler) => ipcRenderer.on('bookmark-prompt-closed',  () => handler()),
  onBookmarkAddPrompt:       (handler) => ipcRenderer.on('bookmark-add-from-bar',       () => handler()),
  onBookmarkEditPrompt:      (handler) => ipcRenderer.on('bookmark-edit-prompt',          (_e, d) => handler(d)),
  onBookmarkFolderRename:    (handler) => ipcRenderer.on('bookmark-folder-rename',        (_e, d) => handler(d)),
  onBookmarkNewFolderPrompt: (handler) => ipcRenderer.on('bookmark-new-folder-prompt',    () => handler()),
  reportChromeHeight: (height) => ipcRenderer.send('chrome-height-changed', height),
  openBookmarkPrompt: (bounds, url, title, hasObj, id, mode) => ipcRenderer.invoke('bookmark-prompt-open', bounds, url, title, hasObj, id, mode),
  openFolderDropdown:  (anchorRect, folderData) => ipcRenderer.invoke('folder-dropdown-open', anchorRect, folderData),
  closeFolderDropdown: () => ipcRenderer.send('folder-dropdown-close'),
  onExternBookmarkDragStart:    (cb) => ipcRenderer.on('extern-bookmark-drag-start',    (_e, id, folderId) => cb(id, folderId)),
  onExternBookmarkDragEnd:      (cb) => ipcRenderer.on('extern-bookmark-drag-end',      () => cb()),
  onExternBookmarkDragPosition: (cb) => ipcRenderer.on('extern-bookmark-drag-position', (_e, x, y) => cb(x, y)),
  externBookmarkDrop:           (x, y) => ipcRenderer.send('extern-bookmark-drop', x, y),
});

contextBridge.exposeInMainWorld('focusMode', {
  toggle: () => ipcRenderer.invoke('focus-mode-toggle'),
  getState: () => ipcRenderer.invoke('focus-mode-get'),
  onChanged: (handler) => ipcRenderer.on('focus-mode-changed', (_e, active) => handler(active)),
  overlayOpen: () => ipcRenderer.send('overlay-open'),
  overlayClose: () => ipcRenderer.send('overlay-close'),
});

contextBridge.exposeInMainWorld('browserBookmarks', {
  getAll:       ()               => ipcRenderer.invoke('bookmarks-get'),
  add:          (url, title)     => ipcRenderer.invoke('bookmarks-add', url, title),
  remove:       (url)            => ipcRenderer.invoke('bookmarks-remove', url),
  removeById:   (id)             => ipcRenderer.invoke('bookmarks-remove-by-id', id),
  has:          (url)            => ipcRenderer.invoke('bookmarks-has', url),
  reorder:           (ids)                         => ipcRenderer.invoke('bookmarks-reorder', ids),
  reorderInFolder:   (folderId, ids)               => ipcRenderer.invoke('bookmarks-reorder-in-folder', folderId, ids),
  addFolder:         (title)                       => ipcRenderer.invoke('bookmarks-add-folder', title),
  addDivider:        ()                            => ipcRenderer.invoke('bookmarks-add-divider'),
  moveIntoFolder:    (itemId, folderId, beforeId)  => ipcRenderer.invoke('bookmarks-move-into-folder', itemId, folderId, beforeId ?? null),
  moveOutOfFolder:   (itemId, folderId, beforeId)  => ipcRenderer.invoke('bookmarks-move-out-of-folder', itemId, folderId, beforeId),
  updateById:   (id, updates)    => ipcRenderer.invoke('bookmarks-update-by-id', id, updates),
  onChanged:    (handler)        => ipcRenderer.on('bookmarks-changed', () => handler()),
  showContextMenu:  (url)        => ipcRenderer.send('show-bookmark-context-menu', url),
  showBarContextMenu: (item)     => ipcRenderer.send('show-bookmark-bar-context-menu', item),
  openInNewTab: (url, switchToTab) => ipcRenderer.invoke('open-url-in-new-tab', url, switchToTab),
});

// Any click anywhere in this webContents should close the settings menu
document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    try { ipcRenderer.send('content-view-click'); } catch {}
}, true);

contextBridge.exposeInMainWorld('contentInteraction', {
    onClicked: (fn) => ipcRenderer.on('content-clicked', () => fn())
});

contextBridge.exposeInMainWorld('siteInfo', {
    open: (anchor) => ipcRenderer.invoke('open-site-info', anchor),
});

contextBridge.exposeInMainWorld('windowControls', {
  platform:         process.platform,
  minimize:         ()  => ipcRenderer.invoke('window-minimize'),
  maximize:         ()  => ipcRenderer.invoke('window-maximize'),
  close:            ()  => ipcRenderer.invoke('window-close'),
  isMaximized:      ()  => ipcRenderer.invoke('window-is-maximized'),
  onMaximizeChanged:(fn) => ipcRenderer.on('window-maximize-changed', (_e, v) => fn(v)),
});

contextBridge.exposeInMainWorld('northstarSettings', {
  get:               ()         => ipcRenderer.invoke('settings-get'),
  getSync:           ()         => { try { return ipcRenderer.sendSync('settings-get-sync') || {}; } catch { return {}; } },
  set:               (key, val) => ipcRenderer.invoke('settings-set', key, val),
  clearHistory:      ()         => ipcRenderer.invoke('settings-clear-history'),
  toggleBookmarkBar: ()         => ipcRenderer.send('toggle-bookmark-bar'),
  loginGoogle:       (clientId, clientSecret) => ipcRenderer.invoke('google-login', clientId, clientSecret),
});

contextBridge.exposeInMainWorld('downloads', {
    getAll:        ()       => ipcRenderer.invoke('downloads-get'),
    togglePanel:   (anchor) => ipcRenderer.invoke('downloads-panel-toggle', anchor),
    closePanel:    ()       => ipcRenderer.invoke('downloads-panel-close'),
    onChanged:     (fn)     => ipcRenderer.on('downloads-changed',     (_e, item) => fn(item)),
    onPanelClosed: (fn)     => ipcRenderer.on('downloads-panel-closed', ()        => fn()),
});

// ── Password autofill + save detection (runs in web-page tabs) ────────────────
// The preload shares the page DOM, so we read/fill fields here and talk to the
// main process for stored credentials. The origin is derived from the sender in
// main, so a page can only ever touch its own credentials.
(function passwordManager() {
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;

    const setVal = (el, v) => {
        try {
            const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
            if (desc && desc.set) desc.set.call(el, v); else el.value = v;
            el.dispatchEvent(new Event('input',  { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        } catch { try { el.value = v; } catch {} }
    };
    const findUser = (scope) => scope && scope.querySelector(
        'input[autocomplete="username"],input[type="email"],input[name*="user" i],' +
        'input[name*="email" i],input[id*="user" i],input[id*="email" i],input[type="text"]'
    );

    function autofill() {
        ipcRenderer.invoke('passwords-get-for-origin').then((creds) => {
            if (!Array.isArray(creds) || creds.length !== 1) return; // skip when ambiguous
            const pw = document.querySelector('input[type="password"]:not([disabled])');
            if (!pw) return;
            const cred = creds[0];
            const user = pw.form ? findUser(pw.form) : findUser(document);
            if (user && cred.username && !user.value) setVal(user, cred.username);
            if (!pw.value) setVal(pw, cred.password);
        }).catch(() => {});
    }

    function capture(form) {
        const pw = form && form.querySelector && form.querySelector('input[type="password"]');
        if (!pw || !pw.value) return;
        const user = findUser(form);
        ipcRenderer.invoke('passwords-offer', { username: user ? user.value : '', password: pw.value }).catch(() => {});
    }

    document.addEventListener('submit', (e) => { try { capture(e.target); } catch {} }, true);
    // SPA logins that never fire 'submit': capture on click of a likely submit control.
    document.addEventListener('click', (e) => {
        try {
            const btn = e.target.closest && e.target.closest('button,[type="submit"],[role="button"]');
            const form = btn && btn.closest('form');
            if (form && form.querySelector('input[type="password"]')) setTimeout(() => capture(form), 0);
        } catch {}
    }, true);

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autofill);
    else autofill();
    setTimeout(autofill, 1200); // catch late-rendered login forms
})();

contextBridge.exposeInMainWorld('urlUtils', {
    getDomain: (url) => {
        try {
            return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
        } catch { return ''; }
    }
});

// ── Hover preconnect ──────────────────────────────────────────────────────────
// Warm DNS + TCP + TLS to a link's origin the moment the user hovers it
// (instant.page / Chrome-predictor style) so the eventual click starts on a hot
// connection. Origin-level only, deduped, capped per page — no request bodies,
// no prefetching of content.
(() => {
    if (location.protocol !== 'http:' && location.protocol !== 'https:' &&
        location.protocol !== 'file:') return;
    const seen = new Set();
    let lastSent = 0;
    document.addEventListener('mouseover', (e) => {
        const t = e.target;
        const a = t && t.closest ? t.closest('a[href]') : null;
        if (!a) return;
        let origin;
        try {
            const u = new URL(a.href, location.href);
            if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
            origin = u.origin;
        } catch { return; }
        if (origin === location.origin && location.protocol !== 'file:') return; // already connected
        if (seen.has(origin) || seen.size >= 40) return;
        const now = Date.now();
        if (now - lastSent < 100) return; // rate-limit sweep-over bursts
        lastSent = now;
        seen.add(origin);
        try { ipcRenderer.send('link-preconnect', origin); } catch {}
    }, { passive: true, capture: true });
})();
