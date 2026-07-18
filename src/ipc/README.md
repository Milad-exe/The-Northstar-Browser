# IPC modules (`src/ipc/`)

> `ipcMain` handler modules, one per feature area, registered by
> `src/main.ts` with a shared dependency bundle. Pages reach them through
> the preload bridges in `src/preload/` (declared in `src/types/api.d.ts`).
> See the [root README](../../README.md) for the overall architecture.

---

## bookmarks.ts

### Purpose

`ipc/bookmarks.ts` registers all Electron IPC handlers for bookmark management. It provides a complete CRUD surface: reading the bookmark list, checking whether a URL is already bookmarked, adding and removing individual bookmarks, updating titles and arbitrary fields by URL or by id, and managing structural elements (folders, dividers). It also handles drag-reorder operations — both at the top level and inside a folder — and moving items between folders.

Beyond data operations the module manages the **bookmark-prompt overlay**, a small `WebContentsView` popup (320 × 260 px) that floats below the address-bar star button and lets the user add or edit a bookmark without leaving the page. It also registers two native context-menu handlers: one for right-clicking an item on the bookmark *bar*, and one for right-clicking a bookmark on the *bookmarks page*.

Every mutating operation calls `broadcastBookmarksChanged()` from `ipc/utils.ts` so that all open WebContents stay in sync.

### Functions / Methods

#### `register(ipcMain, { wm, webContents })`

#### IPC channels handled

| Channel | Inputs (from renderer) | Return value |
|---|---|---|
| `bookmarks-get` | — | Array of all bookmark tree items |
| `bookmarks-has` | `url` | Boolean |
| `bookmarks-add` | `url`, `title` | The newly added bookmark object |
| `bookmarks-remove` | `url` | Boolean |
| `bookmarks-remove-by-id` | `id` | Boolean |
| `bookmarks-update-title` | `url`, `title` | `true` |
| `bookmarks-update-by-id` | `id`, `updates` (object) | Boolean |
| `bookmarks-add-folder` | `title` | The new folder's id |
| `bookmarks-add-divider` | — | The new divider's id |
| `bookmarks-reorder` | `ids` — ordered id array for the top-level list | `true` |
| `bookmarks-reorder-in-folder` | `folderId`, `orderedIds` | Boolean |
| `bookmarks-move-into-folder` | `itemId`, `folderId`, `insertBeforeId` | Boolean |
| `bookmarks-move-out-of-folder` | `itemId`, `folderId`, `insertBeforeId` | Boolean |
| `open-url-in-new-tab` | `url`, `switchToTab` (boolean, default `true`) | Boolean |
| `open-bookmarks-tab` | — | — |
| `bookmark-prompt-open` | `bounds`, `url`, `title`, `hasObj`, `id`, `mode` | Boolean |
| `bookmark-prompt-close` | — | Boolean |
| `show-bookmark-bar-context-menu` (send) | `item` | — |
| `show-bookmark-context-menu` (send) | `url` | — |

#### `showBookmarkBarContextMenu(wd, item, wm, webContents)`
Builds and displays a native context menu tailored to the type of element right-clicked on the bookmark bar.

### Key Variables

| Name | Type | Purpose |
|---|---|---|
| `PROMPT_W` | `number` (320) | Fixed pixel width of the bookmark-prompt `WebContentsView` |
| `PROMPT_H` | `number` (260) | Fixed pixel height of the bookmark-prompt `WebContentsView` |
| `broadcast` | `Function` | Closure that calls `broadcastBookmarksChanged(webContents)` |

---

## folder-dropdown.ts

### Purpose

IPC handlers for the folder-dropdown `WebContentsView` and extern bookmark drag. The folder dropdown is a transparent cascading panel that appears when the user clicks a folder in the bookmark bar. Because HTML5 drag events don't cross `WebContentsView` boundaries, dragging an item out of the dropdown uses a cursor-polling loop to forward position events to the bar renderer.

### Functions / Methods

#### `register(ipcMain, { wm, screen, webContents })`

#### IPC channels handled

| Channel | Type | Purpose |
|---|---|---|
| `folder-dropdown-open` | handle | Opens the dropdown for a folder; toggles closed if the same folder is clicked again |
| `folder-dropdown-close` | on | Destroys the dropdown and returns focus to the main window |
| `folder-dropdown-raise` | on | Re-inserts the dropdown as the last contentView child (topmost z-order) |
| `folder-dropdown-update-bounds` | on | Resizes the dropdown WebContentsView to fit content |
| `folder-dropdown-navigate` | on | Navigates the active tab to a URL and closes the dropdown |
| `folder-dropdown-new-tab` | on | Opens a URL in a new tab and closes the dropdown |
| `folder-dropdown-ctx-menu` | on | Shows an OS context menu for the right-clicked item |
| `folder-dropdown-drag-start` | on | Closes dropdown; starts cursor-polling loop for cross-view drag |
| `folder-dropdown-drag-end` | on | Stops polling; notifies bar renderer that drag ended |
| `extern-bookmark-drop` | on | Stops polling; notifies bar renderer that drop completed |

#### `showFolderDropdownContextMenu(wd, item, wm, webContents)`
Builds and shows a native context menu for bookmark, folder, folder-bg, and divider item types. After any mutation calls `refreshPanel(folderId)` to rebuild the affected panel without closing the dropdown.

### Key Variables

| Name | Type | Purpose |
|---|---|---|
| `EXTERN_DRAG_POLL_MS` | `number` (30) | Cursor-poll interval in ms during cross-view bookmark drag |
| `pollInterval` | `Timeout\|null` | The active `setInterval` handle for cursor polling |
| `pollWindowData` | `object\|null` | The window data object being polled |

### Helpers

#### `initialBounds(anchorRect, folderData, win)`
Computes initial pixel bounds for a newly opened dropdown.

#### `findFolderDeep(items, targetId)`
Recursively finds a folder node by id inside the bookmark tree.

---

## history.ts

### Purpose

IPC handlers for browsing history. History is stored by `Features/history.ts` and accessed here read-only (writes happen inside `Features/tabs.ts` as pages load).

### Functions / Methods

#### `register(ipcMain, { wm })`

#### IPC channels handled

| Channel | Inputs | Return value |
|---|---|---|
| `history-get` | — | Full history array |
| `history-search` | `query`, `limit` | Filtered and ranked history entries |
| `remove-history-entry` | `url`, `timestamp` | Boolean |
| `open-history-tab` | — | Opens history page in a new tab |

### Helpers

#### `isSearchResultUrl(rawUrl)`
Returns `true` if the URL is a Google, Bing, or DuckDuckGo search result page.

#### `relevanceScore(entry, q)`
Scores a history entry for relevance to a query. Considers exact match, substring match, prefix match, and recency (bonus for entries accessed within the last 7 days).

---

## menu.ts

### Purpose

IPC handlers for the hamburger menu overlay and click-outside dismissal. The menu is a transparent `WebContentsView` that slides in from the top-right. It must be dismissed when the user clicks anywhere outside it.

### Functions / Methods

#### `register(ipcMain, { wm })`

#### IPC channels handled

| Channel | Type | Purpose |
|---|---|---|
| `open` | handle | Creates the menu `WebContentsView` and attaches one-shot blur/focus listeners to close it |
| `close-menu` | handle | Programmatically closes the menu |
| `content-view-click` | on | Closes menu, bookmark prompt, and folder dropdown; forwards click to chrome renderer |
| `window-click` | on | Closes menu or bookmark prompt if the click landed outside their bounds |

### Key Variables

| Name | Type | Purpose |
|---|---|---|
| `MENU_WIDTH` | `number` (220) | Fixed pixel width of the menu `WebContentsView` |
| `MENU_HEIGHT` | `number` (224) | Fixed pixel height of the menu `WebContentsView` |

---

## settings.ts

### Purpose

`ipc/settings.ts` registers IPC handlers for user-facing settings, focus mode, overlay state, bookmark-bar chrome integration, and native window controls. Settings are stored and retrieved through `wm.persistence`. When the `theme` key is changed, the module updates `nativeTheme.themeSource` and broadcasts a `theme-changed` event to every open `WebContents`. It also exposes a Google OAuth login flow via `Features/google-auth.ts`.

### Functions / Methods

#### `register(ipcMain, { wm, webContents, nativeTheme, app, focusMode })`

#### IPC channels handled

| Channel | Type | Inputs | Return value / Behaviour |
|---|---|---|---|
| `settings-get` | handle | — | All persisted settings as a plain object, with `_version` set to the app version string |
| `settings-get-sync` | on (synchronous) | — | Sets `event.returnValue` to all persisted settings |
| `settings-set` | handle | `key`, `value` | `true`; applies theme and persist-mode side effects when relevant |
| `settings-clear-history` | handle | — | Boolean |
| `open-settings-tab` | handle | — | Opens the settings page in a new tab |
| `google-login` | handle | `clientId`, `clientSecret` | `{ success: true, data }` or `{ success: false, error }` |
| `focus-mode-toggle` | handle | — | Boolean — current focus-mode state |
| `focus-mode-get` | handle | — | Boolean — current focus-mode state for the calling window |
| `overlay-open` | on | — | Calls `wd.tabs.collapseAllTabs()` |
| `overlay-close` | on | — | Calls `wd.tabs.restoreAllTabs()` |
| `toggle-bookmark-bar` | on | — | Forwards event to the chrome renderer |
| `chrome-height-changed` | on | `height` | Updates `wd.tabs.bookmarkBarHeight` and resizes tabs |
| `focus-address-bar` | on | — | Forwards event to the chrome renderer |
| `window-minimize` | handle | — | Minimises the calling window |
| `window-maximize` | handle | — | Toggles maximise/restore |
| `window-close` | handle | — | Closes the calling window |
| `window-is-maximized` | handle | — | Boolean |

---

## suggestions.ts

### Purpose

IPC handlers for the URL/search suggestion overlay. The overlay is a transparent `WebContentsView` positioned below the address bar. It is created lazily on the first open request and removed on close.

### Functions / Methods

#### `register(ipcMain, { wm })`

#### IPC channels handled

| Channel | Type | Purpose |
|---|---|---|
| `suggestions-open` | handle | Creates the overlay (lazy) and sends initial items |
| `suggestions-update` | handle | Updates bounds and items of an already-open overlay |
| `suggestions-close` | handle | Removes and nulls the overlay |
| `suggestions-select` | handle | Sends the selected item to the chrome renderer and removes the overlay |
| `suggestions-pointer-down` | handle | Notifies the chrome renderer of a pointer-down event inside the overlay |

### Key Variables / Helpers

| Name | Type | Purpose |
|---|---|---|
| `ITEM_HEIGHT` | `number` (35) | Height in pixels of each suggestion row |
| `MAX_HEIGHT` | `number` (280) | Maximum overlay height in pixels |

#### `itemBounds(bounds, count)`
Computes pixel bounds for the overlay given a position rect and item count.

---

## tabs.ts

### Purpose

`ipc/tabs.ts` registers all Electron IPC handlers related to tab management and multi-window drag-and-drop. It covers the full tab lifecycle — creating, removing, switching, loading URLs, navigating back/forward, reloading, pinning, and reordering — as well as convenience helpers used by the history and bookmarks internal pages. It also handles the cross-window drag protocol: identifying which window is under the cursor, moving a tab from one window to another, and detaching a tab into a brand-new window.

### Functions / Methods

#### `register(ipcMain, { wm, BrowserWindow })`

#### IPC channels handled

| Channel | Inputs (from renderer) | Return value |
|---|---|---|
| `addTab` | — | — |
| `removeTab` | `index` | — |
| `switchTab` | `index` | — |
| `loadUrl` | `index`, `url` | — |
| `goBack` | `index` | — |
| `goForward` | `index` | — |
| `reload` | `index` | — |
| `newWindow` | — | — |
| `getTabUrl` | `index` | URL string or `''` |
| `pinTab` | `index` | `true` on success |
| `reorderTabs` | `order` | `true` on success |
| `navigate-active-tab` | `url` | Boolean |
| `active-tab-go-back` | — | Boolean |
| `getPersistMode` | — | Boolean |
| `setPersistMode` | `enabled` | `true`; triggers debounced state save |
| `get-this-window-id` | — | Numeric window id or `null` |
| `get-window-at-point` | `screenX`, `screenY` | `{ id }` of the top-most window or `null` |
| `move-tab-to-window` | `fromId`, `tabIndex`, `targetId`, `url` | Boolean |
| `detach-to-new-window` | `tabIndex`, `screenX`, `screenY`, `url` | Boolean |

### Key Variables

| Name | Type | Purpose |
|---|---|---|
| `wm` | `WindowManager` | Used in every handler to look up the window that owns the calling renderer |
| `BrowserWindow` | Electron class | Used in `get-window-at-point` to iterate all open windows |

---

## utils.ts

### Purpose

Shared helper functions used across multiple IPC modules. Centralises the three most common cross-module operations: closing the hamburger menu overlay, closing the folder dropdown overlay, and broadcasting a bookmark change to all open WebContents.

### Functions

#### `closeWindowMenu(windowData)`
Removes the hamburger menu `WebContentsView` from the window's content view, nulls `windowData.menu`, sends a `menu-closed` IPC event to the chrome renderer, and runs any registered cleanup callbacks.
- **Returns** `void`

#### `closeFolderDropdown(windowData)`
Removes the folder dropdown `WebContentsView` from the window's content view and clears `windowData.folderDropdown` and `windowData.folderDropdownId`.
- **Returns** `void`

#### `broadcastBookmarksChanged(webContents)`
Sends the `'bookmarks-changed'` IPC event to every open `WebContents` in the app.
- **Returns** `void`
