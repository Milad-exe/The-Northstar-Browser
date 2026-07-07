# Northstar

A productivity-focused web browser built with Electron. Northstar wraps Chromium via Electron's `WebContentsView` API to give you multi-tab browsing, a hierarchical bookmark bar, built-in focus mode, an API client (Bruno), and encrypted local storage — all in a single native window.

---

## Quick start

```bash
npm install
npm start          # run in development (no --dev flag needed)
npm run dev        # run with --dev flag (Electron passes it to app)
npm run build      # package with electron-builder
```

---

## Architecture overview

```
main.js                 — Electron main process entry point
  Features/             — all main-process business logic (no Electron UI)
    window-manager.js   — BrowserWindow factory + global state
    tabs.js             — WebContentsView tab lifecycle per window
    bookmarks.js        — bookmark data store (encrypted JSON)
    history.js          — browsing history (encrypted JSON)
    persistence.js      — settings + tab session state (encrypted JSON)
    navigation-history.js — per-tab back/forward stack (BST-backed)
    shortcuts.js        — keyboard shortcut registration
    focus-mode/         — focus mode core + injections + grayscale helpers
    find-dialog.js      — in-page find floating window
    user-agent.js       — Firefox UA spoofing
    encryption.js       — AES-256-GCM at-rest encryption
    binary-search-tree.js — BST used by navigation-history
    google-auth.js      — Google OAuth helper
    tab-context-menu.js — right-click menu template for web tabs
    window-context-menu.js — right-click menu template for chrome UI
  preload/              — contextBridge scripts (one per view type)
    preload.js          — main browser chrome (tabs, bookmarks, shortcuts…)
    menu-preload.js     — hamburger menu overlay
    bookmark-prompt-preload.js — add/edit bookmark popup
    folder-dropdown-preload.js — bookmark folder cascade panel
    find-preload.js     — in-page find dialog
    settings-preload.js — settings page
    bruno-preload.js    — Bruno API client panel
    suggestions-preload.js — URL/search suggestion overlay
    chrome-spoof.js     — injected into web pages to spoof chrome APIs
  renderer/             — HTML/CSS/JS for every UI surface
    Browser/            — main chrome shell (tab bar, address bar, bookmarks)
    Menu/               — hamburger / app menu overlay
    BookmarkPrompt/     — add / edit bookmark popup
    FolderDropdown/     — cascading folder panel (see FolderDropdown/README.md)
    FindDialog/         — in-page find bar
    History/            — browsing history page (opens as a tab)
    NewTab/             — new-tab page
    Settings/           — settings page (opens as a tab)
    Suggestions/        — URL/search autocomplete dropdown
    Bruno/              — Bruno API client panel
    DragPreview/        — drag ghost image helper
    Error/              — error page for failed navigation
    Bookmarks/          — bookmarks management page (opens as a tab)
    assets/             — shared icons and images
    themes.css          — CSS custom-property theme definitions
    renderer.js         — main chrome renderer (most of the UI logic)
```

---

## Main process (`main.js`)

The entry point. Responsibilities:

- Initialises `WindowManager` and creates the first window on `app.whenReady`.
- Registers all `ipcMain` handlers for every feature (tabs, bookmarks, history, settings, focus mode, Bruno, suggestions, bookmark-prompt, folder-dropdown, extern-bookmark drag).
- Handles `app` lifecycle (`before-quit`, `window-all-closed`, `activate`).
- Manages the cursor-polling loop used when a bookmark is dragged from the folder dropdown onto the bookmark bar across `WebContentsView` boundaries.

### Window data object

Every `BrowserWindow` is tracked in `WindowManager.windows` as a `windowData` object:

```js
{
  id:               number,
  window:           BrowserWindow,
  tabs:             Tabs,
  shortcuts:        Shortcuts,
  menu:             WebContentsView | null,   // hamburger menu
  suggestions:      WebContentsView | null,   // URL autocomplete
  bookmarkPrompt:   WebContentsView | null,   // add/edit popup
  folderDropdown:   WebContentsView | null,   // folder cascade
  folderDropdownId: string | null,            // id of the open folder
  brunoWidth:       number,                   // pixels reserved for Bruno panel
}
```

---

## Features

### `window-manager.js`

Singleton. Creates and tracks all `BrowserWindow` instances. Provides:

| Method | Purpose |
|---|---|
| `createWindow(w, h)` | Create a new browser window with its own `Tabs`, `Shortcuts`, context menus, and session-restore logic |
| `getWindowByWebContents(wc)` | Reverse-lookup a `windowData` from any `WebContents` (window, tab, or any floating view) |
| `getPrimaryWindow()` | Most-recently-focused window; used for session persistence |
| `savePrimaryState()` | Sync-save tab state from the primary window |
| `closeAllWindows()` | Graceful shutdown of all windows |

Shared singletons (`history`, `bookmarks`, `persistence`) are lazy-initialised as getters so they're created only once across all windows.

---

### `tabs.js`

One `Tabs` instance per `BrowserWindow`. Each tab is a `WebContentsView` added as a child of the window's `contentView`.

**Tab creation variants:**

| Method | Use case |
|---|---|
| `CreateTab()` | New empty tab (loads new-tab page, becomes active) |
| `CreateLazyTab(url, title, pinned)` | Restore a tab from session — stays hidden until `showTab()` is called |
| `CreateTabWithPage(path, type, title)` | Open an internal page (Settings, History, etc.) as a tab |

**Tab layout geometry (`getTabBounds`):**

Tabs are positioned below the chrome. The top offset accounts for:
- Utility bar: 50 px
- Tab bar: 38 px
- Optional bookmark bar: `bookmarkBarHeight` (0 or 28 px)

Bruno panel occupies the right side when open (`brunoWidth` pixels are subtracted from width).

**State persistence:**

`_saveStateDebounced()` fires 200 ms after any tab change. In "persist all" mode, every tab is saved; otherwise only pinned tabs are included.

**Closed-tab history:** The last 20 closed non-internal tabs are kept in `_closedTabHistory` for "Reopen Closed Tab".

---

### `bookmarks.js`

Manages a flat-then-nested JSON tree of bookmark items stored in `userData/bookmarks.json` (AES-256-GCM encrypted).

**Item schema:**

```js
{ type: 'bookmark', id, url, title, addedAt }
{ type: 'folder',   id, title, children: [...] }
{ type: 'divider',  id }
```

**Key methods:**

| Method | Notes |
|---|---|
| `add(url, title)` | Append to root; deduplicates by URL |
| `removeById(id)` | Recursive search via `_findNodeAndParentArray` |
| `updateById(id, updates)` | Recursive patch |
| `addFolder(title)` | Append folder to root |
| `addFolderInto(title, parentFolderId)` | Create sub-folder inside a folder |
| `addDividerInto(parentFolderId)` | Create divider inside a folder |
| `moveIntoFolder(itemId, folderId, insertBeforeId?)` | Move item into a folder with cycle guard |
| `moveOutOfFolder(itemId, folderId, insertBeforeId?)` | Move item to root |
| `reorder(ids)` | Reorder root items |
| `reorderInFolder(folderId, orderedIds)` | Reorder items inside a specific folder |

`_findNodeAndParentArray(id)` is used by most mutating methods — it recurses into `children` arrays so operations work correctly on nested items.

---

### `history.js`

Browsing history stored in `userData/browsing-history.json` (encrypted). Capped at 1000 entries. Search-result URLs (Google, Bing, DuckDuckGo) are filtered out automatically.

---

### `persistence.js`

Manages two encrypted JSON files:

| File | Contents |
|---|---|
| `northstar/settings.json` | Theme, search engine, bookmark bar visibility, Pomodoro timers, persist mode |
| `northstar/tabs-state.json` | Serialized tab list `{ tabs: [{url, title, pinned}], activeIndex }` |

Settings defaults are defined in `DEFAULTS` and merged on load, so new settings keys are backward-compatible.

---

### `navigation-history.js`

Per-tab back/forward history using a **binary search tree** (keyed by integer position index). Each tab gets its own `BinarySearchTree` instance.

Navigating forward after going back truncates future entries (`deleteGreaterThan`). Similar-URL deduplication (`isSimilarUrl`) collapses redirects, tracking parameters, and root-path variations.

---

### `shortcuts.js`

Keyboard shortcuts registered via `before-input-event` on every `WebContents` (main window + all tabs). Uses its own accelerator parser instead of `globalShortcut` so shortcuts work regardless of which view has focus.

**Registered shortcuts:**

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl+T` | New tab |
| `Cmd/Ctrl+W` | Close active tab |
| `Cmd/Ctrl+Tab` / `+Shift+Tab` | Cycle tabs |
| `Cmd/Ctrl+1–9` | Switch to tab by position |
| `Cmd/Ctrl+Left/Right` | Back / Forward |
| `Cmd/Ctrl+R` / `+Shift+R` | Reload / Hard reload |
| `Cmd/Ctrl+F` | Open find dialog |
| `Cmd/Ctrl+Plus/Minus/0` | Zoom in/out/reset |
| `F11` | Toggle fullscreen |
| `F12` / `Cmd/Ctrl+Shift+I` | Dev tools |
| `Cmd/Ctrl+Q` | Quit app |
| `Cmd/Ctrl+N` | New window |

---

### `focus-mode/`

Singleton. Per-window state (keyed by `windowData.id`).

When enabled:
- Injects `html { filter: grayscale(100%) }` CSS into every tab via `insertCSS`.
- Injects site-specific JS blockers into YouTube (removes recommendations and Shorts feed), TikTok, and Instagram (hides feeds).
- Pauses all media elements.

When disabled:
- Removes grayscale CSS.
- Reloads tabs that received distraction injection (active tab immediately; others deferred until shown via `_needsReloadForFocusMode`).

Additional setting:
- A `blockShortform` setting blocks short-form video feeds (Shorts, TikTok, Reels) without hiding recommendations. Focus mode overrides it and the state is restored afterward.

---

### `find-dialog.js`

Floating `BrowserWindow` (frameless, transparent, `alwaysOnTop`) positioned at the top-right of the parent window. Communicates with `findInPage` / `stopFindInPage` on the active tab's `WebContents`. One dialog per `BrowserWindow`, managed by the `FindDialogManager` singleton.

---

### `encryption.js`

AES-256-GCM at-rest encryption for all user data files.

- Master key: 32 random bytes, generated once, stored at `userData/northstar/.key` (mode 0600).
- Each encrypted value is a JSON object: `{ v: 1, iv: <base64>, tag: <base64>, data: <base64> }`.
- The GCM auth tag provides tamper detection.
- `isEncrypted(str)` detects legacy plaintext files for seamless migration.

---

### `user-agent.js`

Spoofs Firefox 124.0 user-agent on every tab and at the session level. Also strips `Sec-CH-UA` client-hint headers and adds `DNT: 1` on main-frame navigations.

---

## Renderer views

### `renderer/Browser/` — Main chrome

The main `BrowserWindow` loads `renderer/Browser/index.html`. Its logic lives in `renderer/renderer.js` (the largest renderer file), exposed via `preload/preload.js`.

Key UI regions:

| Region | Description |
|---|---|
| Utility bar (50 px) | Traffic lights (mac), window controls (win/linux), hamburger menu, Bruno toggle |
| Tab bar (38 px) | Scrollable tab strip, new-tab button, drag-to-reorder, pinned tabs |
| Address bar | URL input, back/forward/reload, bookmark star |
| Bookmark bar (28 px, optional) | Draggable bookmark items; folder items open `FolderDropdown` |
| Content area | Houses all tab `WebContentsView`s |

**Bookmark bar drag and drop:**

- Items reorder via HTML5 drag. Drop indicator is a 2 px left-edge `box-shadow` (`.drop-before` class) rather than a border, to avoid layout shifts.
- Dragging a bookmark from the folder dropdown to the bar uses cursor-position polling because HTML5 drag events don't cross `WebContentsView` boundaries. The protocol: `dragStart` IPC starts polling → `close()` hides the dropdown → `dragEnd` IPC stops polling and executes the move.

---

### `renderer/FolderDropdown/`

Cascading folder panel. See [renderer/FolderDropdown/README.md](renderer/FolderDropdown/README.md) for full documentation.

---

### `renderer/Menu/`

Hamburger / app menu. A transparent `WebContentsView` that slides in from the right. Provides shortcuts to: new tab, new window, history, bookmarks, settings, bookmark bar toggle, persistence mode toggle.

---

### `renderer/BookmarkPrompt/`

Small floating `WebContentsView` for adding or editing a bookmark. Appears anchored to the bookmark star in the address bar. Supports "add", "edit", and "new-folder" modes.

---

### `renderer/Suggestions/`

URL/search autocomplete dropdown. A `WebContentsView` positioned below the address bar. Items come from browsing history (searched by the main process) and are filtered as the user types. Keyboard navigation (↑↓ Enter) is handled across the `WebContentsView` boundary via IPC.

---

### `renderer/FindDialog/`

Floating frameless window rendered by `Features/find-dialog.js`. Shows match count (`n of m`), next/previous buttons. Escape closes it.

---

### `renderer/History/`

Full-page browsing history viewer (opens as a tab). Groups entries by date, supports search and per-entry deletion.

---

### `renderer/Settings/`

Full-page settings (opens as a tab). Covers: theme selection, search engine, bookmark bar toggle, persistence mode, Pomodoro timer configuration, history clear, Google login.

---

### `renderer/NewTab/`

New-tab page shown when a blank tab opens. Contains a search bar and quick-access shortcuts.

---

### `renderer/Bruno/`

Bruno API client panel — a `WebContentsView` pinned to the right side of the window. Supports collections, requests, environments, Git integration. Width is user-resizable via a drag divider; the tab area shrinks accordingly.

---

### `renderer/Error/`

Error page loaded when a tab navigation fails (`did-fail-load`). Receives `url`, `code`, and `desc` via query-string parameters.

---

## Preload scripts

Each `WebContentsView` / `BrowserWindow` loads a dedicated preload that exposes only the IPC surface that view needs.

| Preload | View | Key exposed APIs |
|---|---|---|
| `preload.js` | Browser chrome + all tabs | `tab`, `browserBookmarks`, `electronAPI`, `focusMode`, `suggestions`, `bruno`, `inkSettings`, `windowControls`, `dragdrop` |
| `menu-preload.js` | Menu overlay | `electronAPI` (menu actions), `persist` |
| `bookmark-prompt-preload.js` | Bookmark add/edit popup | `bookmarkPrompt` (save, cancel, folder list) |
| `folder-dropdown-preload.js` | Folder cascade panel | `folderDropdown` (navigate, drag, rename, CRUD) |
| `find-preload.js` | Find dialog | `findDialog` (search, next, prev, close) |
| `settings-preload.js` | Settings page | `inkSettings`, `persist`, `browserBookmarks` |
| `bruno-preload.js` | Bruno panel | `bruno` (all request/environment/collection ops) |
| `suggestions-preload.js` | Suggestions overlay | `suggestionsUI` (item list, keyboard selection) |
| `chrome-spoof.js` | Injected into web pages | Spoofs `window.chrome` so sites that check for it work correctly |

All preloads apply the current theme synchronously on load (`settings-get-sync`) and listen for `theme-changed` IPC to update the `data-theme` attribute without a reload.

---

## Data storage

All user data is stored under `app.getPath('userData')/ink/`:

| File | Format | Contents |
|---|---|---|
| `.key` | 32 raw bytes | AES-256-GCM master key (mode 0600) |
| `settings.json` | Encrypted JSON | App settings |
| `tabs-state.json` | Encrypted JSON | Tab session state |
| `../bookmarks.json` | Encrypted JSON | Bookmark tree |
| `../browsing-history.json` | Encrypted JSON | Browsing history (max 1000 entries) |

Legacy plaintext files are read correctly and re-encrypted on the next write (seamless migration).

---

## Theming

`renderer/themes.css` defines CSS custom properties for every theme under `[data-theme="name"]` selectors. The default theme uses no attribute. All views `@import` this file. The active theme name is stored in settings and applied at startup by every preload.

---

## main.js

### Purpose

`main.js` is the Electron main-process entry point for the Northstar browser. It bootstraps the application by applying pre-ready Chromium flags (disabling `AutomationControlled` to avoid Google's unsupported-browser block), setting a spoofed Firefox user-agent fallback, and then wiring everything together inside the `Northstar` class. On startup it creates a `WindowManager` instance, registers every IPC feature module, and — once Electron is ready — configures the default session (user-agent headers, permission handler, chrome spoof preload script), sets the dock icon on macOS, creates the first browser window, and instantiates the Bruno panel. It also handles app lifecycle events: `activate` (re-open on macOS dock click), `before-quit` (persist primary window state and unlock tab close guards), and `window-all-closed` (quit on non-macOS).

### Functions / Methods

#### `Northstar` (class)

##### `constructor()`
Creates the single application object. Instantiates `WindowManager`, calls `registerIpc()` to attach all IPC handlers, then calls `initApp()` to hook Electron lifecycle events.

##### `registerIpc()`
Builds the shared `deps` object (containing `wm`, `webContents`, `BrowserWindow`, `screen`, `nativeTheme`, `app`, and `focusMode`) and passes it along with `ipcMain` to each IPC feature module's `register()` function.

##### `initApp()`
Hooks `app.whenReady()` to perform all post-ready initialisation: restores the persisted colour theme, sets the macOS dock icon, applies the Firefox UA session setup, clears the native application menu, registers the `chrome-spoof` preload script, permits all permission requests, creates the `Bruno` instance, and opens the first window. Also registers `app.on('activate')`, `app.on('before-quit')`, and `app.on('window-all-closed')` handlers.

### Key Variables

| Name | Type | Purpose |
|---|---|---|
| `northstarInstance` | `Northstar` | The single application instance. Assigned to `global.northstarInstance` so the Bruno feature can reach it from anywhere in the main process. |
| `deps` | `Object` | Dependency bundle assembled in `registerIpc()` and forwarded to every IPC module's `register()` call. Contains `wm`, `webContents`, `BrowserWindow`, `screen`, `nativeTheme`, `app`, and `focusMode`. |
