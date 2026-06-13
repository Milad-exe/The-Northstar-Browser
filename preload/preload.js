const { contextBridge, ipcRenderer } = require('electron');

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
        remove: (index) => ipcRenderer.invoke("removeTab", index),
        switch: (index) => ipcRenderer.invoke("switchTab", index),
        loadUrl: (index, url) => ipcRenderer.invoke("loadUrl", index, url),
        goBack: (index) => ipcRenderer.invoke("goBack", index),
        goForward: (index) => ipcRenderer.invoke("goForward", index),
        reload: (index) => ipcRenderer.invoke("reload", index),
        getTabUrl: (index) => ipcRenderer.invoke("getTabUrl", index),
        getButton: (index) => ipcRenderer.invoke("getTabButton", index),
        pin: (index) => ipcRenderer.invoke("pinTab", index),
    reorder: (order) => ipcRenderer.invoke('reorderTabs', order),
    onTabCreated: (callback) => ipcRenderer.on('tab-created', callback),
        onTabRemoved: (callback) => ipcRenderer.on('tab-removed', callback),
        onTabSwitched: (callback) => ipcRenderer.on('tab-switched', callback),
        onUrlUpdated: (callback) => ipcRenderer.on('url-updated', callback),
        onNavigationUpdated: (callback) => ipcRenderer.on('navigation-updated', callback)
    }
);

// Bridge for UI events emitted from main (via Tabs.pinTab -> 'pin-tab')
contextBridge.exposeInMainWorld('tabsUI', {
    onPinTab: (handler) => ipcRenderer.on('pin-tab', (_e, { index }) => handler(index)),
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
        detachToNewWindow: (tabIndex, screenX, screenY, url) => ipcRenderer.invoke('detach-to-new-window', tabIndex, screenX, screenY, url)
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
    open: (bounds, items, activeIndex) => ipcRenderer.invoke('suggestions-open', { bounds, items, activeIndex }),
    update: (bounds, items, activeIndex) => ipcRenderer.invoke('suggestions-update', { bounds, items, activeIndex }),
    close: () => ipcRenderer.invoke('suggestions-close'),
    onSelected:   (handler) => ipcRenderer.on('suggestion-selected',   (_e, item) => handler(item)),
    onPointerDown:(handler) => ipcRenderer.on('suggestions-pointer-down', () => handler()),
    onCreated:    (handler) => ipcRenderer.on('suggestions-created',    () => handler())
});

contextBridge.exposeInMainWorld("electronAPI", {
  windowClick: (pos) => ipcRenderer.send("window-click", pos),
  onShowFindInPage: (callback) => ipcRenderer.on('show-find-in-page', callback),
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

contextBridge.exposeInMainWorld('windowControls', {
  platform:         process.platform,
  minimize:         ()  => ipcRenderer.invoke('window-minimize'),
  maximize:         ()  => ipcRenderer.invoke('window-maximize'),
  close:            ()  => ipcRenderer.invoke('window-close'),
  isMaximized:      ()  => ipcRenderer.invoke('window-is-maximized'),
  onMaximizeChanged:(fn) => ipcRenderer.on('window-maximize-changed', (_e, v) => fn(v)),
});

contextBridge.exposeInMainWorld('inkExtensions', {
    install:     (id) => ipcRenderer.invoke('extension-install', id),
    uninstall:   (id) => ipcRenderer.invoke('extension-uninstall', id),
    isInstalled: (id) => ipcRenderer.invoke('extension-is-installed', id),
    getAll:      ()   => ipcRenderer.invoke('extension-list'),
});

contextBridge.exposeInMainWorld('inkSettings', {
  get:               ()         => ipcRenderer.invoke('settings-get'),
  set:               (key, val) => ipcRenderer.invoke('settings-set', key, val),
  clearHistory:      ()         => ipcRenderer.invoke('settings-clear-history'),
  toggleBookmarkBar: ()         => ipcRenderer.send('toggle-bookmark-bar'),
  loginGoogle:       (clientId, clientSecret) => ipcRenderer.invoke('google-login', clientId, clientSecret),
});

contextBridge.exposeInMainWorld("bruno", {
    open: () => ipcRenderer.invoke('bruno-open'),
    close: () => ipcRenderer.invoke('bruno-close'),
    selectDirectory: () => ipcRenderer.invoke('bruno-select-directory'),
    // Resize divider
    resizeStart: (x) => ipcRenderer.invoke('bruno-resize-start', x),
    resizeMove:  (x) => ipcRenderer.invoke('bruno-resize-move', x),
    resizeEnd:   ()  => ipcRenderer.invoke('bruno-resize-end'),
    // Request operations
    listRequests:  (path)                 => ipcRenderer.invoke('bruno-list-requests', path),
    createRequest: (path, name)           => ipcRenderer.invoke('bruno-create-request', path, name),
    saveRequest:   (path, filename, data) => ipcRenderer.invoke('bruno-save-request', path, filename, data),
    loadRequest:   (path)                 => ipcRenderer.invoke('bruno-load-request', path),
    deleteRequest: (path, filename)       => ipcRenderer.invoke('bruno-delete-request', path, filename),
    // Environment operations
    createEnvironment:    (path, name) => ipcRenderer.invoke('bruno-create-environment', path, name),
    listEnvironments:     (path)       => ipcRenderer.invoke('bruno-list-environments', path),
    loadEnvironment:      (path)       => ipcRenderer.invoke('bruno-load-environment', path),
    loadEnvironmentFull:  (path)       => ipcRenderer.invoke('bruno-load-environment-full', path),
    saveEnvironment:      (path, vars) => ipcRenderer.invoke('bruno-save-environment', path, vars),
    deleteEnvironment:    (path)       => ipcRenderer.invoke('bruno-delete-environment', path),
    // Collection
    openCollection:        ()         => ipcRenderer.invoke('bruno-list-collections'),
    createCollection:      ()         => ipcRenderer.invoke('bruno-create-collection'),
    initCollection:        (path)     => ipcRenderer.invoke('bruno-init-collection', path),
    getActiveEnvironment:  (path)     => ipcRenderer.invoke('bruno-get-active-environment', path),
    setActiveEnvironment:  (path, n)  => ipcRenderer.invoke('bruno-set-active-environment', path, n),
    // State persistence
    saveState: (state) => ipcRenderer.invoke('bruno-save-state', state),
    loadState: ()      => ipcRenderer.invoke('bruno-load-state'),
    // File ops (legacy / export-import)
    exportCollection:    (path)       => ipcRenderer.invoke('bruno-export-collection', path),
    importCollection:    (path)       => ipcRenderer.invoke('bruno-import-collection', path),
    deleteCollectionFile:(path)       => ipcRenderer.invoke('bruno-delete-collection-file', path),
    loadCollectionFile:  (path)       => ipcRenderer.invoke('bruno-load-collection-file', path),
    saveCollectionFile:  (path, data) => ipcRenderer.invoke('bruno-save-collection-file', path, data),
    gitInit:        (path) => ipcRenderer.invoke('bruno-git-init', path),
    isGitRepo:      (path) => ipcRenderer.invoke('bruno-is-git-repo', path),
    gitStatus:      (path) => ipcRenderer.invoke('bruno-git-status', path),
    createGitignore:(path) => ipcRenderer.invoke('bruno-create-gitignore', path)
});
