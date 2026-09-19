const { contextBridge, ipcRenderer, webUtils } = require('electron');
// This preload is shared by the browser chrome and by every tab — including
// arbitrary WEB pages. The window.* bridges below (tabs, bookmarks, history,
// settings, downloads, …) are for the chrome and internal file:// pages ONLY:
// exposing them to web content would let any website read bookmarks/history,
// flip settings and drive tabs. Web pages get only the inert page behaviours
// (link-selection suppression, click forwarding, password autofill) — which
// also skips ~20 bridge setups and a sync IPC on every page load.
const INTERNAL = location.protocol === 'file:';
const exposeInternal = (name, api) => { if (INTERNAL)
    contextBridge.exposeInMainWorld(name, api); };
// Enable the <browser-action-list> element for extension toolbar buttons.
// This preload is shared by the chrome window and by tabs, so only inject the
// element into the browser chrome page — not arbitrary web pages.
try {
    const isFile = location.protocol === 'file:';
    const isChrome = isFile && /\/Browser\/index\.html$/.test(location.pathname);
    // Chrome + internal pages paint translucently over the window's native
    // material. macOS has vibrancy; Windows 11 (build 22000+) has Mica — both let
    // the same translucent-shell CSS ([data-vibrancy]) show the material through.
    const isFrostable = isFile && /\/(Browser|Settings|History|Bookmarks)\/index\.html$/.test(location.pathname);
    const win11 = process.platform === 'win32'
        && parseInt((require('os').release().split('.')[2] || '0'), 10) >= 22000;
    if ((process.platform === 'darwin' || win11) && isFrostable) {
        const mark = () => document.documentElement.setAttribute('data-vibrancy', 'true');
        if (document.documentElement)
            mark();
        else
            document.addEventListener('DOMContentLoaded', mark);
    }
    if (isChrome) {
        // Require by absolute file path — Electron's (non-sandboxed) preload
        // require can't resolve this package by name (its "exports" map isn't
        // honored here). The chrome window runs with sandbox:false so this works.
        const p = require('path');
        // __dirname is <root>/preload — node_modules sits one level up, next to
        // package.json (same relative location in dev and in the packaged asar).
        const baPath = p.join(__dirname, '..', 'node_modules', 'electron-chrome-extensions', 'dist', 'cjs', 'browser-action.js');
        require(baPath).injectBrowserAction();
    }
}
catch (e) {
    // Surface loudly: if this breaks, extension toolbar buttons silently vanish.
    console.error('[preload] browser-action injection failed:', e);
}
// Theme attribute only matters on internal pages (they style via themes.css).
// Web pages skip it — that sync IPC used to block every page's document-start.
if (INTERNAL) {
    try {
        const settings = ipcRenderer.sendSync('settings-get-sync');
        if (settings && settings.theme && settings.theme !== 'default') {
            const applyTheme = () => document.documentElement.setAttribute('data-theme', settings.theme);
            if (document.documentElement)
                applyTheme();
            else
                document.addEventListener('DOMContentLoaded', applyTheme);
        }
    }
    catch (e) { }
    ipcRenderer.on('theme-changed', (_e, theme) => {
        if (theme && theme !== 'default') {
            document.documentElement.setAttribute('data-theme', theme);
        }
        else {
            document.documentElement.removeAttribute('data-theme');
        }
    });
}
function findAnchorInEventPath(event) {
    try {
        if (event && typeof event.composedPath === 'function') {
            const path = event.composedPath();
            for (const node of path) {
                if (node && node.nodeType === 1 && node.tagName === 'A' && node.href)
                    return node;
            }
        }
    }
    catch { }
    let el = event ? event.target : null;
    while (el && el.nodeType === 1) {
        if (el.tagName === 'A' && el.href)
            return el;
        el = el.parentElement;
    }
    return null;
}
function clearDocumentSelection() {
    try {
        const sel = window.getSelection && window.getSelection();
        if (sel && sel.rangeCount > 0)
            sel.removeAllRanges();
    }
    catch { }
    try {
        const active = document.activeElement;
        if (!active)
            return;
        if (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') {
            const end = typeof active.selectionEnd === 'number' ? active.selectionEnd : 0;
            active.setSelectionRange(end, end);
        }
    }
    catch { }
}
let suppressLinkSelection = false;
let suppressLinkSelectionTimer = null;
function ensureSuppressSelectionStyle() {
    const styleId = 'northstar-suppress-link-selection-style';
    if (document.getElementById(styleId))
        return;
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
html.northstar-suppress-link-selection,
html.northstar-suppress-link-selection * {
    -webkit-user-select: none !important;
    user-select: none !important;
}
html.northstar-suppress-link-selection ::selection {
    background: transparent !important;
    color: inherit !important;
}
`;
    const host = document.head || document.documentElement;
    if (host)
        host.appendChild(style);
}
function enableLinkSelectionSuppression() {
    ensureSuppressSelectionStyle();
    suppressLinkSelection = true;
    if (suppressLinkSelectionTimer) {
        clearTimeout(suppressLinkSelectionTimer);
        suppressLinkSelectionTimer = null;
    }
    try {
        document.documentElement.classList.add('northstar-suppress-link-selection');
    }
    catch { }
    clearDocumentSelection();
}
function disableLinkSelectionSuppression(delay = 120) {
    if (suppressLinkSelectionTimer)
        clearTimeout(suppressLinkSelectionTimer);
    suppressLinkSelectionTimer = setTimeout(() => {
        suppressLinkSelection = false;
        try {
            document.documentElement.classList.remove('northstar-suppress-link-selection');
        }
        catch { }
        clearDocumentSelection();
        suppressLinkSelectionTimer = null;
    }, delay);
}
// Right-clicking links should not create or retain text highlighting.
const onLinkRightMouseDown = (event) => {
    if (!event || event.button !== 2)
        return;
    if (!findAnchorInEventPath(event))
        return;
    enableLinkSelectionSuppression();
    event.preventDefault();
};
document.addEventListener('pointerdown', onLinkRightMouseDown, true);
document.addEventListener('mousedown', onLinkRightMouseDown, true);
// Mouse thumb buttons: back = button 3, forward = button 4. Over a page these
// never reach the window's app-command handler (the page's native view consumes
// WM_APPCOMMAND), so forward them to the app's own tab navigation. isTrusted
// stops a web page from faking them.
document.addEventListener('mousedown', (event) => {
    if (!event || !event.isTrusted)
        return;
    if (event.button === 3) { event.preventDefault(); try { ipcRenderer.send('nav:mouse', 'back'); } catch (e) { } }
    else if (event.button === 4) { event.preventDefault(); try { ipcRenderer.send('nav:mouse', 'forward'); } catch (e) { } }
}, true);
document.addEventListener('selectstart', (event) => {
    if (!suppressLinkSelection)
        return;
    event.preventDefault();
}, true);
document.addEventListener('contextmenu', (event) => {
    if (!findAnchorInEventPath(event) && !suppressLinkSelection)
        return;
    enableLinkSelectionSuppression();
    disableLinkSelectionSuppression();
}, true);
document.addEventListener('mouseup', (event) => {
    if (!suppressLinkSelection)
        return;
    if (!event || event.button !== 2)
        return;
    disableLinkSelectionSuppression();
}, true);
window.addEventListener('blur', () => {
    if (!suppressLinkSelection)
        return;
    disableLinkSelectionSuppression(0);
}, true);
// Alt+click a link opens it in a Glance preview over the current page rather
// than navigating. Registered for every page, not just internal ones.
document.addEventListener('click', (event) => {
    if (!event.altKey || event.button !== 0 || event.defaultPrevented)
        return;
    const a = findAnchorInEventPath(event);
    if (!a || !/^https?:/i.test(a.href || ''))
        return;
    event.preventDefault();
    event.stopPropagation();
    try { ipcRenderer.send('glance:from-page', a.href); }
    catch { }
}, true);
exposeInternal("tab", {
    add: () => ipcRenderer.invoke("addTab"),
    addPrivate: () => ipcRenderer.invoke("addPrivateTab"),
    addLazy: (url) => ipcRenderer.invoke("addTabLazy", url),
    remove: (index) => ipcRenderer.invoke("removeTab", index),
    switch: (index) => ipcRenderer.invoke("switchTab", index),
    loadUrl: (index, url) => ipcRenderer.invoke("loadUrl", index, url),
    openInContainer: (containerId, url) => ipcRenderer.invoke('tab:openInContainer', containerId, url),
    goBack: (index) => ipcRenderer.invoke("goBack", index),
    goForward: (index) => ipcRenderer.invoke("goForward", index),
    showNavHistoryMenu: (index, x, y) => ipcRenderer.invoke("show-nav-history-menu", index, x, y),
    reload: (index) => ipcRenderer.invoke("reload", index),
    stop: (index) => ipcRenderer.invoke("stopTab", index),
    getTabUrl: (index) => ipcRenderer.invoke("getTabUrl", index),
    pin: (index) => ipcRenderer.invoke("pinTab", index),
    setLabel: (index, label) => ipcRenderer.invoke('tab:setLabel', index, label),
    setIcon: (index, icon) => ipcRenderer.invoke('tab:setIcon', index, icon),
    unload: (index) => ipcRenderer.invoke('tab:unload', index),
    setHome: (index, url) => ipcRenderer.invoke('tab:setHome', index, url),
    getHome: (index) => ipcRenderer.invoke('tab:getHome', index),
    resetPinned: (index) => ipcRenderer.invoke('tab:resetPinned', index),
    unloadWorkspace: (ws) => ipcRenderer.invoke('tab:unloadWorkspace', ws),
    onIconChanged: (cb) => ipcRenderer.on('tab-icon-changed', (_e, d) => cb(d)),
    toggleMute: (index) => ipcRenderer.invoke("muteTab", index),
    fetchFavicon: (url) => ipcRenderer.invoke('favicon-fetch', url),
    cachedFavicon: (host) => ipcRenderer.invoke('favicon-cached', host),
    reorder: (order) => ipcRenderer.invoke('reorderTabs', order),
    onTabCreated: (callback) => ipcRenderer.on('tab-created', callback),
    onTabRemoved: (callback) => ipcRenderer.on('tab-removed', callback),
    onTabSwitched: (callback) => ipcRenderer.on('tab-switched', callback),
    onUrlUpdated: (callback) => ipcRenderer.on('url-updated', callback),
    onNavigationUpdated: (callback) => ipcRenderer.on('navigation-updated', callback),
    onTabLoading: (callback) => ipcRenderer.on('tab-loading', callback),
    onMediaIndicator: (callback) => ipcRenderer.on('tab-media-indicator', callback)
});
// Essentials — pinned favourites at the top of the tab sidebar.
exposeInternal('essentials', {
    list: () => ipcRenderer.invoke('essentials:list'),
    add: (url, title, profile) => ipcRenderer.invoke('essentials:add', url, title, profile),
    remove: (url, profile) => ipcRenderer.invoke('essentials:remove', url, profile),
    setIcon: (url, profile, icon) => ipcRenderer.invoke('essentials:icon', url, profile, icon),
    rename: (url, profile, title) => ipcRenderer.invoke('essentials:rename', url, profile, title),
    // An Essential is a tab: open (or return to) the one it owns.
    open: (url, profile) => ipcRenderer.invoke('essentials:open', url, profile),
    goHome: (url, profile) => ipcRenderer.invoke('essentials:goHome', url, profile),
    setHome: (url, profile, home) => ipcRenderer.invoke('essentials:setHome', url, profile, home),
    onTabs: (cb) => ipcRenderer.on('essential-tabs', (_e, live) => cb(live)),
    onChanged: (cb) => ipcRenderer.on('essentials-changed', () => cb()),
});
// Glance — floating page preview over the current tab.
exposeInternal('glance', {
    open: (url) => ipcRenderer.invoke('glance:open', url),
    close: () => ipcRenderer.invoke('glance:close'),
});
// Folders — tab groups within a workspace.
exposeInternal('folders', {
    create: (name, parent) => ipcRenderer.invoke('folders:create', name, parent),
    rename: (id, name) => ipcRenderer.invoke('folders:rename', id, name),
    remove: (id) => ipcRenderer.invoke('folders:delete', id),
    toggle: (id, collapsed) => ipcRenderer.invoke('folders:toggle', id, collapsed),
    icon: (id, icon) => ipcRenderer.invoke('folders:icon', id, icon),
    assign: (index, folderId) => ipcRenderer.invoke('folders:assign', index, folderId),
    move: (id, workspace) => ipcRenderer.invoke('folders:move', id, workspace),
    reparent: (id, parent) => ipcRenderer.invoke('folders:reparent', id, parent),
    reorder: (ids) => ipcRenderer.invoke('folders:reorder', ids),
    list: () => ipcRenderer.invoke('folders:list'),
    onChanged: (cb) => ipcRenderer.on('folders-changed', (_e, data) => cb(data)),
    onTabsMoved: (cb) => ipcRenderer.on('tabs-workspace-changed', (_e, data) => cb(data)),
});
// Profiles — browsing selves; each window belongs to one.
exposeInternal('profiles', {
    current: () => ipcRenderer.invoke('profiles:current'),
    list: () => ipcRenderer.invoke('profiles:list'),
    menu: (x, y, id) => ipcRenderer.send('profiles:menu', x, y, id),
    rename: (id, name) => ipcRenderer.invoke('profiles:rename', id, name),
    update: (id, patch) => ipcRenderer.invoke('profiles:update', id, patch),
    switch: (id) => ipcRenderer.invoke('workspaces:switch', id),
    create: () => ipcRenderer.invoke('workspaces:create'),
    remove: (id) => ipcRenderer.invoke('workspaces:delete', id),
    reorder: (ids) => ipcRenderer.invoke('workspaces:reorder', ids),
    onChanged: (cb) => ipcRenderer.on('profiles:changed', () => cb()),
    onSwitched: (cb) => ipcRenderer.on('workspace-switched', (_e, id) => cb(id)),
    // Main asks the renderer to switch workspaces (e.g. the active workspace's
    // last tab was closed but another workspace still has tabs).
    onForceSwitch: (cb) => ipcRenderer.on('switch-to-workspace', (_e, id) => cb(id)),
    onRename: (cb) => ipcRenderer.on('rename-profile', (_e, id) => cb(id)),
});
// Personas — optional rename + live id→name map for labelling history/suggestions.
// Named containers — a Space's "Profile": whose cookie jar its tabs use.
// Context-menu overlay: menus live in their own view so they paint above the page.
exposeInternal('ctxMenu', {
    open: (data) => ipcRenderer.invoke('ctxmenu:open', data),
    onPicked: (cb) => ipcRenderer.on('ctxmenu:picked', (_e, result) => cb(result)),
});
// Command palette — opens in place of creating a blank tab.
exposeInternal('palette', {
    open: () => ipcRenderer.invoke('palette:open'),
});
/* The theme popup, opened from the sidebar's context menu. It carries the
   trigger's rect so features/overlay-bounds.js can hang the panel off it. */
/* The page-actions panel: the toolbar's page-scoped controls behind one button.
   `state` is what the chrome already knows about the active tab. */
exposeInternal('pageActions', {
    toggle: (anchor, state) => ipcRenderer.invoke('page-actions-toggle', anchor, state),
    onAction: (fn) => ipcRenderer.on('page-action', (_e, action) => fn(action)),
});
exposeInternal('themePanel', {
    // `scope` is a space id, or null to edit the global theme.
    toggle: (anchor, scope) => ipcRenderer.invoke('theme-panel-toggle', anchor, scope || null),
});
exposeInternal('containers', {
    listNamed: () => ipcRenderer.invoke('containers:listNamed'),
    createNamed: (name) => ipcRenderer.invoke('containers:createNamed', name),
    remove: (id) => ipcRenderer.invoke('containers:remove', id),
});
exposeInternal('northstarPrivate', {
    newPrivateWindow: () => ipcRenderer.invoke('newPrivateWindow'),
    isPrivateWindow: () => ipcRenderer.invoke('isPrivateWindow'),
    // Synchronous variant — lets the renderer finish setup in one tick so tab
    // IPC can't arrive mid-initialization (see renderer.js init comment).
    isPrivateWindowSync: () => { try {
        return ipcRenderer.sendSync('is-private-window-sync');
    }
    catch {
        return false;
    } },
    onSetPrivateWindow: (cb) => ipcRenderer.on('set-private-window', (_e, v) => cb(v)),
});
// Bridge for UI events emitted from main (via Tabs.pinTab -> 'pin-tab')
exposeInternal('tabsUI', {
    onPinTab: (handler) => ipcRenderer.on('pin-tab', (_e, { index }) => handler(index)),
    onSplitChanged: (handler) => ipcRenderer.on('split-changed', (_e, pair) => handler(pair)),
    // Split view: from the sidebar tab menu, or by dropping a dragged tab onto
    // another tab. `position` places the ACTIVE tab ('right'|'left'|'top'|'bottom').
    split: (index, position) => ipcRenderer.invoke('tab:split', index, position),
    closeSplit: () => ipcRenderer.invoke('tab:closeSplit'),
    reopenClosed: () => ipcRenderer.invoke('tab:reopenClosed'),
    toggleCompact: () => ipcRenderer.invoke('sidebar:toggleCompact'),
    onTabBarSide: (handler) => ipcRenderer.on('tabbar-side-changed', (_e, v) => handler(v)),
    onCompact: (handler) => ipcRenderer.on('sidebar-compact-changed', (_e, v) => handler(v)),
    focusChrome: () => ipcRenderer.send('chrome:focus'),
    focusPage: () => ipcRenderer.send('page:focus'),
    menuOpened: () => ipcRenderer.send('chrome-menu-open'),
    menuClosed: () => ipcRenderer.send('chrome-menu-close'),
    onCloseMenus: (handler) => ipcRenderer.on('close-chrome-menus', () => handler()),
    // While an overlay menu is up, the chrome neutralises its window-drag regions
    // so a click on them reaches the full-window overlay (which dismisses) instead
    // of being eaten by the OS as a title-bar caption press — the Windows bug where
    // right/left-clicking the tab strip or sidebar left the menu stuck open.
    onMenuCapture: (handler) => ipcRenderer.on('menu-capture', (_e, on) => handler(!!on)),
    startSidebarResize: () => ipcRenderer.invoke('sidebar:resize-start'),
    resizeSidebar: (w) => ipcRenderer.invoke('sidebar:resize', w),
    commitSidebarWidth: (w) => ipcRenderer.invoke('sidebar:resize-commit', w),
    onSidebarWidth: (handler) => ipcRenderer.on('sidebar-width-changed', (_e, w) => handler(w)),
    // Search engines were edited in Settings — the omnibox resolves typed text
    // synchronously, so it keeps its own copy of the list.
    onEnginesChanged: (handler) => ipcRenderer.on('engines-changed', (_e, list) => handler(list)),
    // Interface language changed in Settings — the chrome re-labels itself.
    onLanguageChanged: (handler) => ipcRenderer.on('language-changed', (_e, payload) => handler(payload)),
    onSidebarResizeEnded: (handler) => ipcRenderer.on('sidebar-resize-ended', (_e, w) => handler(w)),
});
// Reader mode + Picture-in-Picture
exposeInternal('reader', {
    toggle: (index) => ipcRenderer.invoke('reader-toggle', index),
    onState: (cb) => ipcRenderer.on('reader-state', (_e, d) => cb(d)),
    onFailed: (cb) => ipcRenderer.on('reader-failed', (_e, d) => cb(d)),
});
exposeInternal('pip', {
    toggle: (index) => ipcRenderer.invoke('toggle-pip', index),
    onMediaState: (cb) => ipcRenderer.on('media-state', (_e, d) => cb(d)),
});
// Exposed to the Reader view (which loads inside a tab). getArticle() returns
// null unless the tab is actually in reader mode, and exit() is a guarded no-op
// otherwise — safe to expose to ordinary pages.
exposeInternal('northstarReader', {
    getArticle: () => ipcRenderer.invoke('reader-get-article'),
    exit: () => ipcRenderer.invoke('reader-exit'),
});
// Diagnostics bridge for the chrome's own scripts. Internal pages only: a web
// page must never be able to write to the browser's log, and page-context
// failures are not ours to record.
exposeInternal('northstarLog', {
    debug: (scope, message) => ipcRenderer.send('log:write', 'debug', scope, message),
    warn: (scope, message) => ipcRenderer.send('log:write', 'warn', scope, message),
    error: (scope, message) => ipcRenderer.send('log:write', 'error', scope, message),
});
// Import / export, update checks, diagnostics — Settings → Data.
exposeInternal('userData', {
    importBookmarks: () => ipcRenderer.invoke('data:import-bookmarks'),
    exportBookmarks: () => ipcRenderer.invoke('data:export-bookmarks'),
    importPasswords: () => ipcRenderer.invoke('data:import-passwords'),
    exportPasswords: () => ipcRenderer.invoke('data:export-passwords'),
    exportHistory: () => ipcRenderer.invoke('data:export-history'),
    reveal: (p) => ipcRenderer.invoke('data:reveal', p),
    clearCertExceptions: () => ipcRenderer.invoke('cert:clear-exceptions'),
    checkUpdate: (force) => ipcRenderer.invoke('app:check-update', force),
    openRelease: (url) => ipcRenderer.invoke('app:open-release', url),
    defaultBrowserStatus: () => ipcRenderer.invoke('app:default-browser-status'),
    makeDefaultBrowser: () => ipcRenderer.invoke('app:make-default-browser'),
    keyProtection: () => ipcRenderer.invoke('app:key-protection'),
    openLog: () => ipcRenderer.invoke('app:open-log'),
    logTail: () => ipcRenderer.invoke('app:log-tail'),
    versions: () => ipcRenderer.invoke('app:version'),
});
// The certificate interstitial's "continue anyway" — internal pages only, so a
// web page can never grant itself an exception.
exposeInternal('certWarning', {
    proceed: (host, fingerprint, url) => ipcRenderer.send('cert:proceed', host, fingerprint, url),
});
// Persistence controls
exposeInternal('persist', {
    getMode: () => ipcRenderer.invoke('getPersistMode'),
    setMode: (enabled) => ipcRenderer.invoke('setPersistMode', enabled),
});
exposeInternal("dragdrop", {
    getWindowAtPoint: (screenX, screenY) => ipcRenderer.invoke('get-window-at-point', screenX, screenY),
    getThisWindowId: () => ipcRenderer.invoke('get-this-window-id'),
    moveTabToWindow: (fromWindowId, tabIndex, targetWindowId, url) => ipcRenderer.invoke('move-tab-to-window', fromWindowId, tabIndex, targetWindowId, url),
    detachToNewWindow: (tabIndex, screenX, screenY, url) => ipcRenderer.invoke('detach-to-new-window', tabIndex, screenX, screenY, url),
    dragTrack: (on, tabIndex) => ipcRenderer.send('tab-drag-track', !!on, tabIndex),
    drop: (tabIndex, url) => ipcRenderer.invoke('tab-drag-drop', tabIndex, url),
    onMergeHover: (fn) => ipcRenderer.on('tab-merge-hover', (_e, v) => fn(v)),
    // The drag was released over the page card, so the chrome never saw the
    // pointerup — main tells it to stand down.
    onDragEnded: (fn) => ipcRenderer.on('tab-drag-ended', () => fn())
});
exposeInternal("menu", {
    open: (anchor) => ipcRenderer.invoke('open', anchor),
    close: () => ipcRenderer.invoke('close-menu'),
    onClosed: (callback) => ipcRenderer.on('menu-closed', callback)
});
// The Firefox-style Alt menu bar (frameless Windows — see features/menu-bar.js).
// NB: the key is `appMenuBar`, NOT `menubar` — `window.menubar` is a standard
// read-only BarProp, and contextBridge.exposeInMainWorld throws when the key
// already exists on window, which aborted the whole preload.
exposeInternal("appMenuBar", {
    labels: () => ipcRenderer.invoke('menubar:labels'),
    open: (index, anchor) => ipcRenderer.invoke('menubar:open', index, anchor),
    onToggle: (callback) => ipcRenderer.on('menubar-toggle', () => callback()),
    onClosed: (callback) => ipcRenderer.on('menubar-closed', (_e, info) => callback(info || {})),
    // Keyboard while the bar is open is driven from main (see Shortcuts) so it
    // works even when a page holds OS focus.
    onKey: (callback) => ipcRenderer.on('menubar-key', (_e, msg) => callback(msg || {})),
    setOpen: (open) => ipcRenderer.send('menubar:state', !!open),
});
exposeInternal("browserHistory", {
    get: () => ipcRenderer.invoke('history-get'),
    search: (query, limit) => ipcRenderer.invoke('history-search', query, limit),
    remove: (url, timestamp) => ipcRenderer.invoke('remove-history-entry', url, timestamp),
    // The history page's "Clear history" — same handler Settings uses.
    clear: () => ipcRenderer.invoke('settings-clear-history'),
});
// Cached favicons for the internal list pages (History, Bookmarks): the letter
// block shows until this resolves, and stays for sites that have none.
exposeInternal('faviconCache', {
    get: (host) => ipcRenderer.invoke('favicon-cached', host),
});
// Suggestions overlay controls from the main renderer
exposeInternal('suggestions', {
    warm: () => ipcRenderer.invoke('suggestions-warm'),
    // Pre-warm DNS+TCP+TLS to the highlighted suggestion's origin so pressing
    // Enter starts on a hot connection. Origin-only (never a path or query), and
    // main preconnects on the ACTIVE tab's session and skips private tabs.
    preconnect: (origin) => ipcRenderer.send('omnibox-preconnect', origin),
    open: (bounds, items, activeIndex, query, engine) => ipcRenderer.invoke('suggestions-open', { bounds, items, activeIndex, query, engine }),
    update: (bounds, items, activeIndex, query, engine) => ipcRenderer.invoke('suggestions-update', { bounds, items, activeIndex, query, engine }),
    close: () => ipcRenderer.invoke('suggestions-close'),
    onSelected: (handler) => ipcRenderer.on('suggestion-selected', (_e, item) => handler(item)),
    onPointerDown: (handler) => ipcRenderer.on('suggestions-pointer-down', () => handler()),
    onCreated: (handler) => ipcRenderer.on('suggestions-created', () => handler()),
    onHover: (handler) => ipcRenderer.on('suggestion-hover', (_e, index) => handler(index))
});
exposeInternal("electronAPI", {
    windowClick: (pos) => ipcRenderer.send("window-click", pos),
    onShowFindInPage: (callback) => ipcRenderer.on('show-find-in-page', callback),
    onFocusAddressBar: (callback) => ipcRenderer.on('focus-address-bar', () => callback()),
    openHistoryTab: () => ipcRenderer.invoke('open-history-tab'),
    openBookmarksTab: () => ipcRenderer.invoke('open-bookmarks-tab'),
    // section is optional ('appearance', 'privacy', …). Use this rather than
    // loadUrl('northstar://settings') — that is the typed-url path and
    // replaces the tab you are on.
    openSettingsTab: (section) => ipcRenderer.invoke('open-settings-tab', section),
    navigateActiveTab: (url) => ipcRenderer.invoke('navigate-active-tab', url),
    activeTabGoBack: () => ipcRenderer.invoke('active-tab-go-back'),
    onToggleBookmarkBar: (handler) => ipcRenderer.on('toggle-bookmark-bar', () => handler()),
    onBookmarkPromptClosed: (handler) => ipcRenderer.on('bookmark-prompt-closed', () => handler()),
    onBookmarkAddPrompt: (handler) => ipcRenderer.on('bookmark-add-from-bar', () => handler()),
    onBookmarkEditPrompt: (handler) => ipcRenderer.on('bookmark-edit-prompt', (_e, d) => handler(d)),
    onBookmarkFolderRename: (handler) => ipcRenderer.on('bookmark-folder-rename', (_e, d) => handler(d)),
    onBookmarkNewFolderPrompt: (handler) => ipcRenderer.on('bookmark-new-folder-prompt', () => handler()),
    reportChromeHeight: (height) => ipcRenderer.send('chrome-height-changed', height),
    dismissNotice: (id) => ipcRenderer.send('notice-dismissed', id),
    pendingNotices: () => ipcRenderer.invoke('notices:pending'),
    onNotice: (cb) => ipcRenderer.on('notice', (_e, n) => cb(n)),
    makeDefaultBrowser: () => ipcRenderer.invoke('app:make-default-browser'),
    openBookmarkPrompt: (bounds, url, title, hasObj, id, mode) => ipcRenderer.invoke('bookmark-prompt-open', bounds, url, title, hasObj, id, mode),
    openFolderDropdown: (anchorRect, folderData) => ipcRenderer.invoke('folder-dropdown-open', anchorRect, folderData),
    closeFolderDropdown: () => ipcRenderer.send('folder-dropdown-close'),
    onExternBookmarkDragStart: (cb) => ipcRenderer.on('extern-bookmark-drag-start', (_e, id, folderId) => cb(id, folderId)),
    onExternBookmarkDragEnd: (cb) => ipcRenderer.on('extern-bookmark-drag-end', () => cb()),
    onExternBookmarkDragPosition: (cb) => ipcRenderer.on('extern-bookmark-drag-position', (_e, x, y) => cb(x, y)),
    externBookmarkDrop: (x, y) => ipcRenderer.send('extern-bookmark-drop', x, y),
});
exposeInternal('focusMode', {
    toggle: () => ipcRenderer.invoke('focus-mode-toggle'),
    getState: () => ipcRenderer.invoke('focus-mode-get'),
    onChanged: (handler) => ipcRenderer.on('focus-mode-changed', (_e, active) => handler(active)),
    overlayOpen: () => ipcRenderer.send('overlay-open'),
    overlayClose: () => ipcRenderer.send('overlay-close'),
});
exposeInternal('browserBookmarks', {
    getAll: () => ipcRenderer.invoke('bookmarks-get'),
    add: (url, title) => ipcRenderer.invoke('bookmarks-add', url, title),
    remove: (url) => ipcRenderer.invoke('bookmarks-remove', url),
    removeById: (id) => ipcRenderer.invoke('bookmarks-remove-by-id', id),
    has: (url) => ipcRenderer.invoke('bookmarks-has', url),
    reorder: (ids) => ipcRenderer.invoke('bookmarks-reorder', ids),
    reorderInFolder: (folderId, ids) => ipcRenderer.invoke('bookmarks-reorder-in-folder', folderId, ids),
    addFolder: (title) => ipcRenderer.invoke('bookmarks-add-folder', title),
    addDivider: () => ipcRenderer.invoke('bookmarks-add-divider'),
    moveIntoFolder: (itemId, folderId, beforeId) => ipcRenderer.invoke('bookmarks-move-into-folder', itemId, folderId, beforeId ?? null),
    moveOutOfFolder: (itemId, folderId, beforeId) => ipcRenderer.invoke('bookmarks-move-out-of-folder', itemId, folderId, beforeId),
    updateById: (id, updates) => ipcRenderer.invoke('bookmarks-update-by-id', id, updates),
    onChanged: (handler) => ipcRenderer.on('bookmarks-changed', () => handler()),
    showContextMenu: (url) => ipcRenderer.send('show-bookmark-context-menu', url),
    showBarContextMenu: (item) => ipcRenderer.send('show-bookmark-bar-context-menu', item),
    openInNewTab: (url, switchToTab) => ipcRenderer.invoke('open-url-in-new-tab', url, switchToTab),
});
// Reading position, reported so a restored session opens the page where the
// user left it. Throttled hard (a scroll handler runs on every frame otherwise)
// and only for real web pages — internal pages have nothing worth restoring.
// Also fires once on unload so a fast close still records the final position.
if (!INTERNAL && /^https?:$/.test(location.protocol)) {
    let lastSent = 0;
    let pending = null;
    const report = () => {
        const y = Math.round(window.scrollY || 0);
        if (y === lastSent)
            return;
        lastSent = y;
        try { ipcRenderer.send('page:scroll', y); }
        catch { }
    };
    window.addEventListener('scroll', () => {
        if (pending)
            return;
        pending = setTimeout(() => { pending = null; report(); }, 500);
    }, { passive: true });
    window.addEventListener('pagehide', report);
}
// Any click anywhere in this webContents should close the settings menu
document.addEventListener('mousedown', (e) => {
    if (e.button !== 0)
        return;
    try {
        ipcRenderer.send('content-view-click');
    }
    catch { }
}, true);
exposeInternal('contentInteraction', {
    onClicked: (fn) => ipcRenderer.on('content-clicked', () => fn())
});
exposeInternal('siteInfo', {
    open: (anchor) => ipcRenderer.invoke('open-site-info', anchor),
});
exposeInternal('windowControls', {
    platform: process.platform,
    minimize: () => ipcRenderer.invoke('window-minimize'),
    maximize: () => ipcRenderer.invoke('window-maximize'),
    close: () => ipcRenderer.invoke('window-close'),
    isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
    onMaximizeChanged: (fn) => ipcRenderer.on('window-maximize-changed', (_e, v) => fn(v)),
});
exposeInternal('northstarSettings', {
    get: () => ipcRenderer.invoke('settings-get'),
    getSync: () => { try {
        return ipcRenderer.sendSync('settings-get-sync') || {};
    }
    catch {
        return {};
    } },
    set: (key, val) => ipcRenderer.invoke('settings-set', key, val),
    clearHistory: () => ipcRenderer.invoke('settings-clear-history'),
    toggleBookmarkBar: () => ipcRenderer.send('toggle-bookmark-bar'),
    loginGoogle: (clientId, clientSecret) => ipcRenderer.invoke('google-login', clientId, clientSecret),
    onUtilityBarChanged: (fn) => ipcRenderer.on('utility-bar-changed', (_e, cfg) => fn(cfg)),
});
exposeInternal('extensionsUI', {
    togglePanel: (anchor) => ipcRenderer.invoke('extensions-panel-toggle', anchor),
    closePanel: () => ipcRenderer.invoke('extensions-panel-close'),
    onChanged: (fn) => ipcRenderer.on('extensions-changed', () => fn()),
    onPanelClosed: (fn) => ipcRenderer.on('extensions-panel-closed', () => fn()),
    // standard pinning: unpinned actions collapse out of the toolbar strip.
    onPinnedChanged: (fn) => ipcRenderer.on('ext-pinned-changed', (_e, map) => fn(map)),
    closeActionPopup: () => ipcRenderer.invoke('extensions-close-action-popup'),
    onActivate: (fn) => ipcRenderer.on('ext-activate-action', (_e, id) => fn(id)),
    // chrome.sidePanel: which extensions open a panel on action click, and the
    // call to actually open one.
    sidePanelBehavior: () => ipcRenderer.invoke('side-panel-behavior-get'),
    onSidePanelBehavior: (fn) => ipcRenderer.on('ext-sidepanel-behavior', (_e, ids) => fn(ids)),
    openSidePanel: (id) => ipcRenderer.invoke('side-panel-open-for', id),
    devtoolsPanels: () => ipcRenderer.invoke('devtools-panels-list'),
    openDevtoolsPanel: (panelId) => ipcRenderer.invoke('devtools-panel-open', panelId),
});
exposeInternal('downloads', {
    getAll: () => ipcRenderer.invoke('downloads-get'),
    togglePanel: (anchor) => ipcRenderer.invoke('downloads-panel-toggle', anchor),
    closePanel: () => ipcRenderer.invoke('downloads-panel-close'),
    onChanged: (fn) => ipcRenderer.on('downloads-changed', (_e, item) => fn(item)),
    onPanelClosed: (fn) => ipcRenderer.on('downloads-panel-closed', () => fn()),
});
// ── Password autofill + save detection (runs in web-page tabs) ────────────────
// The preload shares the page DOM, so we read/fill fields here and talk to the
// main process for stored credentials. The origin is derived from the sender in
// main, so a page can only ever touch its own credentials.
(function passwordManager() {
    if (location.protocol !== 'http:' && location.protocol !== 'https:')
        return;
    const setVal = (el, v) => {
        try {
            const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
            if (desc && desc.set)
                desc.set.call(el, v);
            else
                el.value = v;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        catch {
            try {
                el.value = v;
            }
            catch { }
        }
    };
    const findUser = (scope) => scope && scope.querySelector('input[autocomplete="username"],input[type="email"],input[name*="user" i],' +
        'input[name*="email" i],input[id*="user" i],input[id*="email" i],input[type="text"]');
    function autofill() {
        ipcRenderer.invoke('passwords-get-for-origin').then((creds) => {
            if (!Array.isArray(creds) || creds.length !== 1)
                return; // skip when ambiguous
            const pw = document.querySelector('input[type="password"]:not([disabled])');
            if (!pw)
                return;
            const cred = creds[0];
            const user = pw.form ? findUser(pw.form) : findUser(document);
            if (user && cred.username && !user.value)
                setVal(user, cred.username);
            if (!pw.value)
                setVal(pw, cred.password);
        }).catch(() => { });
    }
    function capture(form) {
        const pw = form && form.querySelector && form.querySelector('input[type="password"]');
        if (!pw || !pw.value)
            return;
        const user = findUser(form);
        ipcRenderer.invoke('passwords-offer', { username: user ? user.value : '', password: pw.value }).catch(() => { });
    }
    document.addEventListener('submit', (e) => { try {
        capture(e.target);
    }
    catch { } }, true);
    // SPA logins that never fire 'submit': capture on click of a likely submit control.
    document.addEventListener('click', (e) => {
        try {
            const btn = e.target?.closest?.('button,[type="submit"],[role="button"]');
            const form = btn && btn.closest('form');
            if (form && form.querySelector('input[type="password"]'))
                setTimeout(() => capture(form), 0);
        }
        catch { }
    }, true);
    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', autofill);
    else
        autofill();
    setTimeout(autofill, 1200); // catch late-rendered login forms
})();
exposeInternal('urlUtils', {
    getDomain: (url) => {
        try {
            return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
        }
        catch {
            return '';
        }
    },
    // OS path for a dropped File (webUtils replaces the removed File.path).
    getPathForFile: (file) => {
        try { return webUtils.getPathForFile(file) || ''; }
        catch { return ''; }
    },
});
// ── Hover preconnect ──────────────────────────────────────────────────────────
// Warm DNS + TCP + TLS to a link's origin the moment the user hovers it
// (instant.page / Chrome-predictor style) so the eventual click starts on a hot
// connection. Origin-level only, deduped, capped per page — no request bodies,
// no prefetching of content.
(() => {
    if (location.protocol !== 'http:' && location.protocol !== 'https:' &&
        location.protocol !== 'file:')
        return;
    const seen = new Set();
    let lastSent = 0;
    document.addEventListener('mouseover', (e) => {
        const t = e.target;
        const a = t && t.closest ? t.closest('a[href]') : null;
        if (!a)
            return;
        let origin;
        try {
            const u = new URL(a.href, location.href);
            if (u.protocol !== 'http:' && u.protocol !== 'https:')
                return;
            origin = u.origin;
        }
        catch {
            return;
        }
        if (origin === location.origin && location.protocol !== 'file:')
            return; // already connected
        if (seen.has(origin) || seen.size >= 40)
            return;
        const now = Date.now();
        if (now - lastSent < 100)
            return; // rate-limit sweep-over bursts
        lastSent = now;
        seen.add(origin);
        try {
            ipcRenderer.send('link-preconnect', origin);
        }
        catch { }
    }, { passive: true, capture: true });
})();
