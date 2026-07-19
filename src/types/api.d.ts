// Auto-derived from the contextBridge.exposeInMainWorld calls in src/preload/.
// These declare the window.* bridges available to the chrome-UI pages, so
// renderer TypeScript gets name-level autocompletion. Signatures are loose
// (any) — tighten them as the IPC surface stabilizes. If you add or rename
// a bridge method in a preload, mirror it here.

// Values are typed any (methods and constants alike); tighten per-bridge as needed.

// exposed by bookmark-prompt-preload.ts, menu-preload.ts, preload.ts
interface Bridge_electronAPI {
    onInitPrompt: any;
    addBookmark: any;
    updateTitle: any;
    removeBookmark: any;
    removeById: any;
    updateById: any;
    addFolder: any;
    closePrompt: any;
    platform: any;
    windowClick: any;
    addTab: any;
    addPrivateTab: any;
    newWindow: any;
    newPrivateWindow: any;
    openHistoryTab: any;
    openBookmarksTab: any;
    openSettingsTab: any;
    closeMenu: any;
    toggleBookmarkBar: any;
    getSettings: any;
    find: any;
    print: any;
    zoom: any;
    onShowFindInPage: any;
    onFocusAddressBar: any;
    navigateActiveTab: any;
    activeTabGoBack: any;
    onToggleBookmarkBar: any;
    onBookmarkPromptClosed: any;
    onBookmarkAddPrompt: any;
    onBookmarkEditPrompt: any;
    onBookmarkFolderRename: any;
    onBookmarkNewFolderPrompt: any;
    reportChromeHeight: any;
    openBookmarkPrompt: any;
    openFolderDropdown: any;
    closeFolderDropdown: any;
    onExternBookmarkDragStart: any;
    onExternBookmarkDragEnd: any;
    onExternBookmarkDragPosition: any;
    externBookmarkDrop: any;
    [key: string]: any;   // methods the extractor missed
}

// exposed by downloads-preload.ts
interface Bridge_overlayDownloads {
    getAll: any;
    action: any;
    close: any;
    onData: any;
    [key: string]: any;   // methods the extractor missed
}

// exposed by find-preload.ts
interface Bridge_findAPI {
    search: any;
    findNext: any;
    findPrevious: any;
    clearSearch: any;
    close: any;
    onMatchesUpdated: any;
    [key: string]: any;   // methods the extractor missed
}

// exposed by folder-dropdown-preload.ts
interface Bridge_folderDropdown {
    onInit: any;
    onRefreshPanel: any;
    onStartRename: any;
    navigate: any;
    openNewTab: any;
    close: any;
    showCtxMenu: any;
    updateBounds: any;
    raise: any;
    dragStart: any;
    dragEnd: any;
    updateById: any;
    reorderInFolder: any;
    moveIntoFolder: any;
    moveOutOfFolder: any;
    [key: string]: any;   // methods the extractor missed
}

// exposed by menu-preload.ts, preload.ts
interface Bridge_persist {
    getMode: any;
    setMode: any;
    [key: string]: any;   // methods the extractor missed
}

// exposed by miniplayer-preload.ts
interface Bridge_miniPlayerApi {
    action: any;
    onState: any;
    [key: string]: any;   // methods the extractor missed
}

// exposed by password-prompt-preload.ts
interface Bridge_pwPrompt {
    onData: any;
    save: any;
    never: any;
    close: any;
    [key: string]: any;   // methods the extractor missed
}

// exposed by permission-prompt-preload.ts
interface Bridge_permissionUI {
    onData: any;
    decide: any;
    resize: any;
    [key: string]: any;   // methods the extractor missed
}

// exposed by preload.ts
interface Bridge_tab {
    add: any;
    addPrivate: any;
    addLazy: any;
    remove: any;
    switch: any;
    loadUrl: any;
    goBack: any;
    goForward: any;
    showNavHistoryMenu: any;
    reload: any;
    stop: any;
    getTabUrl: any;
    getButton: any;
    pin: any;
    toggleMute: any;
    fetchFavicon: any;
    reorder: any;
    onTabCreated: any;
    onTabRemoved: any;
    onTabSwitched: any;
    onUrlUpdated: any;
    onNavigationUpdated: any;
    onTabLoading: any;
    onMediaIndicator: any;
    [key: string]: any;   // methods the extractor missed
}

// exposed by preload.ts
interface Bridge_northstarPrivate {
    newPrivateWindow: any;
    isPrivateWindow: any;
    isPrivateWindowSync: any;
    onSetPrivateWindow: any;
    [key: string]: any;   // methods the extractor missed
}

// exposed by preload.ts
interface Bridge_tabsUI {
    onPinTab: any;
    [key: string]: any;   // methods the extractor missed
}

// exposed by preload.ts
interface Bridge_reader {
    toggle: any;
    onState: any;
    onFailed: any;
    [key: string]: any;   // methods the extractor missed
}

// exposed by preload.ts
interface Bridge_pip {
    toggle: any;
    onMediaState: any;
    [key: string]: any;   // methods the extractor missed
}

// exposed by preload.ts
interface Bridge_northstarReader {
    getArticle: any;
    exit: any;
    [key: string]: any;   // methods the extractor missed
}

// exposed by preload.ts
interface Bridge_dragdrop {
    getWindowAtPoint: any;
    getThisWindowId: any;
    moveTabToWindow: any;
    detachToNewWindow: any;
    dragTrack: any;
    drop: any;
    onMergeHover: any;
    [key: string]: any;   // methods the extractor missed
}

// exposed by preload.ts
interface Bridge_menu {
    open: any;
    close: any;
    onClosed: any;
    [key: string]: any;   // methods the extractor missed
}

// exposed by preload.ts
interface Bridge_browserHistory {
    get: any;
    search: any;
    remove: any;
    [key: string]: any;   // methods the extractor missed
}

// exposed by preload.ts
interface Bridge_suggestions {
    warm: any;
    open: any;
    update: any;
    close: any;
    onSelected: any;
    onPointerDown: any;
    onCreated: any;
    [key: string]: any;   // methods the extractor missed
}

// exposed by preload.ts
interface Bridge_focusMode {
    toggle: any;
    getState: any;
    onChanged: any;
    overlayOpen: any;
    overlayClose: any;
    [key: string]: any;   // methods the extractor missed
}

// exposed by preload.ts
interface Bridge_browserBookmarks {
    getAll: any;
    add: any;
    remove: any;
    removeById: any;
    has: any;
    reorder: any;
    reorderInFolder: any;
    addFolder: any;
    addDivider: any;
    moveIntoFolder: any;
    moveOutOfFolder: any;
    updateById: any;
    onChanged: any;
    showContextMenu: any;
    showBarContextMenu: any;
    openInNewTab: any;
    [key: string]: any;   // methods the extractor missed
}

// exposed by preload.ts
interface Bridge_contentInteraction {
    onClicked: any;
    [key: string]: any;   // methods the extractor missed
}

// exposed by preload.ts
interface Bridge_siteInfo {
    open: any;
    [key: string]: any;   // methods the extractor missed
}

// exposed by preload.ts
interface Bridge_windowControls {
    platform: any;
    minimize: any;
    maximize: any;
    close: any;
    isMaximized: any;
    onMaximizeChanged: any;
    [key: string]: any;   // methods the extractor missed
}

// exposed by preload.ts, settings-preload.ts
interface Bridge_northstarSettings {
    get: any;
    getSync: any;
    set: any;
    clearHistory: any;
    toggleBookmarkBar: any;
    loginGoogle: any;
    clearBrowsingData: any;
    privacyStats: any;
    openHistoryTab: any;
    openBookmarksTab: any;
    [key: string]: any;   // methods the extractor missed
}

// exposed by preload.ts
interface Bridge_downloads {
    getAll: any;
    togglePanel: any;
    closePanel: any;
    onChanged: any;
    onPanelClosed: any;
    [key: string]: any;   // methods the extractor missed
}

// exposed by preload.ts
interface Bridge_urlUtils {
    getDomain: any;
    [key: string]: any;   // methods the extractor missed
}

// exposed by settings-preload.ts
interface Bridge_northstarPasswords {
    list: any;
    reveal: any;
    remove: any;
    onChanged: any;
    [key: string]: any;   // methods the extractor missed
}

// exposed by settings-preload.ts
interface Bridge_northstarExtensions {
    list: any;
    add: any;
    installId: any;
    openStore: any;
    remove: any;
    setEnabled: any;
    openOptions: any;
    onChanged: any;
    [key: string]: any;   // methods the extractor missed
}

// exposed by siteinfo-preload.ts
interface Bridge_siteInfoApi {
    getInfo: any;
    setPermission: any;
    setProtection: any;
    clearData: any;
    resize: any;
    close: any;
    [key: string]: any;   // methods the extractor missed
}

// exposed by suggestions-preload.ts
interface Bridge_overlaySuggestions {
    onData: any;
    close: any;
    select: any;
    pointerDown: any;
    [key: string]: any;   // methods the extractor missed
}

// exposed by preload.ts (chrome window)
interface Bridge_extensionsUI {
    togglePanel: any;
    closePanel: any;
    onChanged: any;
    onPanelClosed: any;
    onPinnedChanged: any;
    onActivate: any;
    closeActionPopup: any;
}

// exposed by extensions-panel-preload.ts (extensions panel overlay)
interface Bridge_extPanel {
    setPinned: any;
    activate: any;
    list: any;
    setEnabled: any;
    remove: any;
    openOptions: any;
    openStore: any;
    close: any;
    onData: any;
}

interface Window {
    extensionsUI: Bridge_extensionsUI;
    extPanel: Bridge_extPanel;
    electronAPI: Bridge_electronAPI;
    overlayDownloads: Bridge_overlayDownloads;
    findAPI: Bridge_findAPI;
    folderDropdown: Bridge_folderDropdown;
    persist: Bridge_persist;
    miniPlayerApi: Bridge_miniPlayerApi;
    pwPrompt: Bridge_pwPrompt;
    permissionUI: Bridge_permissionUI;
    tab: Bridge_tab;
    northstarPrivate: Bridge_northstarPrivate;
    tabsUI: Bridge_tabsUI;
    reader: Bridge_reader;
    pip: Bridge_pip;
    northstarReader: Bridge_northstarReader;
    dragdrop: Bridge_dragdrop;
    menu: Bridge_menu;
    browserHistory: Bridge_browserHistory;
    suggestions: Bridge_suggestions;
    focusMode: Bridge_focusMode;
    browserBookmarks: Bridge_browserBookmarks;
    contentInteraction: Bridge_contentInteraction;
    siteInfo: Bridge_siteInfo;
    windowControls: Bridge_windowControls;
    northstarSettings: Bridge_northstarSettings;
    downloads: Bridge_downloads;
    urlUtils: Bridge_urlUtils;
    northstarPasswords: Bridge_northstarPasswords;
    northstarExtensions: Bridge_northstarExtensions;
    siteInfoApi: Bridge_siteInfoApi;
    overlaySuggestions: Bridge_overlaySuggestions;
}
