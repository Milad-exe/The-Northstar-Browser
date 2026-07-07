# preload

---

## bookmark-prompt-preload.js

### Purpose

Preload script for the bookmark add/edit prompt overlay. The prompt is a floating `WebContentsView` that appears when the user adds or edits a bookmark. Bridges the prompt renderer to the main process, providing access to bookmark CRUD operations and folder creation, as well as a listener for the initialisation payload that main sends when the prompt first opens.

### Module-level behaviour

#### Theme bootstrap
Synchronously fetches settings via `settings-get-sync`. If the stored `theme` is not `'default'`, sets `data-theme` on `document.documentElement`.

#### `ipcRenderer.on('theme-changed', handler)`
Listens for live theme-change events from the main process.

### `window.electronAPI`

| Method | Purpose | Inputs | Output |
|---|---|---|---|
| `onInitPrompt(callback)` | Registers a listener for the initialisation event sent by main when the prompt is opened | `callback` — standard IPC callback receiving prompt's initial data (URL, title, existing bookmark info, mode) | void |
| `addBookmark(url, title)` | Creates a new bookmark | `url`, `title` — strings | Promise |
| `updateTitle(url, title)` | Updates the title of an existing bookmark identified by URL | `url`, `title` — strings | Promise |
| `removeBookmark(url)` | Removes a bookmark by URL | `url` — string | Promise |
| `removeById(id)` | Removes a bookmark by its ID | `id` — string or number | Promise |
| `updateById(id, updates)` | Updates one or more fields on a bookmark or folder | `id`, `updates` — object | Promise |
| `addFolder(title)` | Creates a new bookmark folder | `title` — string | Promise |
| `closePrompt()` | Closes the bookmark prompt overlay | — | Promise |

---

## bruno-preload.js

### Purpose

Legacy stub — no longer loaded by any window or `WebContentsView`. The Bruno panel uses `preload/preload.js`, which exposes the full `window.bruno` bridge. This file is kept for reference only.

---

## chrome-spoof.js

### Purpose

A session-level preload script injected into every web page by `session.defaultSession.registerPreloadScript`. Its sole purpose is to remove `navigator.webdriver = true`, which would otherwise expose Northstar as an automated browser and trigger Google's "unsupported browser" redirect.

Note: This script intentionally does **not** inject `window.chrome` or other Chrome-specific navigator properties. Since Northstar spoofs a Firefox user-agent globally, injecting Chrome objects would create a detectable mismatch.

### How It Works

1. Runs in the preload context (isolated from the main world)
2. Creates a `<script>` element whose text content is a self-executing function
3. Appends and immediately removes that `<script>` to execute it in the **main world** (bypassing context isolation)
4. The main-world function calls `Object.defineProperty(navigator, 'webdriver', { get: () => undefined })` to hide the flag

No exported functions or variables — this file is self-contained and side-effect only.

---

## find-preload.js

### Purpose

Preload script for the find-in-page overlay. Exposes a small IPC-backed API that allows the find UI to drive text search within the currently active browser tab. Follows the same theme-bootstrap pattern as all other ink preload scripts.

### `window.findAPI`

| Method | Purpose | Inputs | Output |
|---|---|---|---|
| `search(searchTerm)` | Starts or updates a search in the active tab | `searchTerm` — string | Promise |
| `findNext()` | Advances to the next search match | — | Promise |
| `findPrevious()` | Moves back to the previous search match | — | Promise |
| `clearSearch()` | Clears the current search and removes all highlights | — | Promise |
| `close()` | Closes the find bar overlay | — | Promise |
| `onMatchesUpdated(callback)` | Registers a listener for match-count updates pushed by the main process | `callback` — function receiving `(current, total)` | void |

---

## folder-dropdown-preload.js

### Purpose

Preload script for the bookmark folder dropdown overlay. The folder dropdown is a floating `WebContentsView` that opens when the user clicks a bookmark folder on the bookmark bar, displaying the folder's contents. Bridges the dropdown renderer to the main process, exposing listeners for initialisation and state-refresh events, actions for navigating to a bookmark URL, opening URLs in new tabs, and managing drag-and-drop of bookmark items both within the dropdown and into the parent bar.

### `window.folderDropdown`

| Method | Purpose | Inputs | Output |
|---|---|---|---|
| `onInit(cb)` | Registers a listener for the initial data payload sent when the dropdown opens | `cb` — function receiving `(data)` | void |
| `onRefreshPanel(cb)` | Registers a listener for data-refresh events | `cb` — function receiving `(data)` | void |
| `onStartRename(cb)` | Registers a listener for rename-start events | `cb` — function receiving `(data)` | void |
| `navigate(url)` | Navigates the active browser tab to a URL and closes the dropdown | `url` — string | void |
| `openNewTab(url)` | Opens a URL in a new tab | `url` — string | void |
| `close()` | Closes the folder dropdown overlay | — | void |
| `showCtxMenu(item)` | Opens the native context menu for a bookmark item | `item` — bookmark/folder object | void |
| `updateBounds(w, h)` | Reports the dropdown's current rendered size to main | `w`, `h` — numbers | void |
| `raise()` | Brings the dropdown overlay to the front of the window stack | — | void |
| `dragStart(id, folderId)` | Notifies main that a bookmark drag has started from within the dropdown | `id`, `folderId` | void |
| `dragEnd()` | Notifies main that a bookmark drag from the dropdown has ended | — | void |
| `updateById(id, updates)` | Updates fields on a bookmark or folder | `id`, `updates` | Promise |
| `reorderInFolder(folderId, ids)` | Reorders items within the open folder | `folderId`, `ids` | Promise |
| `moveIntoFolder(itemId, folderId, beforeId)` | Moves an item into a folder | `itemId`, `folderId`, `beforeId` | Promise |
| `moveOutOfFolder(itemId, folderId)` | Moves an item out of a folder to the top-level bookmark bar | `itemId`, `folderId` | Promise |

---

## menu-preload.js

### Purpose

Preload script for the app menu overlay window. Exposes APIs to the menu UI via `contextBridge`. The APIs allow the menu UI to open new tabs, open a new window, navigate to special built-in tabs (history, bookmarks, settings), close the menu, toggle the bookmark bar, read settings, and query or set session persistence mode.

### `window.electronAPI`

| Method | Purpose | Inputs | Output |
|---|---|---|---|
| `windowClick(pos)` | Notifies the main process of a click position | `pos` — object with screen coordinates | void |
| `addTab()` | Opens a new browser tab | — | Promise |
| `newWindow()` | Opens a new browser window | — | Promise |
| `openHistoryTab()` | Navigates to the history built-in tab | — | Promise |
| `openBookmarksTab()` | Navigates to the bookmarks built-in tab | — | Promise |
| `openSettingsTab()` | Navigates to the settings built-in tab | — | Promise |
| `closeMenu()` | Closes the menu overlay | — | Promise |
| `toggleBookmarkBar()` | Toggles the bookmark bar visibility | — | void |
| `getSettings()` | Returns the current application settings object | — | Promise |

### `window.persist`

| Method | Purpose | Inputs | Output |
|---|---|---|---|
| `getMode()` | Returns the current persist mode | — | Promise — boolean |
| `setMode(enabled)` | Enables or disables persist mode | `enabled` — boolean | Promise |

---

## preload.js

### Purpose

The primary preload script for the main browser renderer window in ink. Runs in a privileged Electron context before the renderer page loads, and uses `contextBridge` to safely expose IPC-backed APIs to the renderer under well-defined `window.*` namespaces. It covers every major subsystem of the browser UI: tab management, drag-and-drop, the menu overlay, browsing history, URL suggestions, find-in-page, bookmark management, window controls, focus mode, settings, and the Bruno API client panel.

### Module-level behaviour

#### Theme bootstrap
Synchronously fetches settings via `settings-get-sync`. If the stored `theme` is not `'default'`, sets `data-theme` on `document.documentElement`.

#### `ipcRenderer.on('theme-changed', handler)`
Listens for live theme-change events from the main process.

#### `mousedown` listener (capture phase)
Fires on every left-button mousedown in the renderer. Sends `'content-view-click'` to the main process (used to close the settings menu).

### `window.tab`

| Method | Purpose | Inputs | Output |
|---|---|---|---|
| `add()` | Opens a new tab | — | Promise |
| `remove(index)` | Closes a tab | `index` — number | Promise |
| `switch(index)` | Makes a tab active | `index` — number | Promise |
| `loadUrl(index, url)` | Navigates a tab to a URL | `index`, `url` | Promise |
| `goBack(index)` | Navigates back | `index` — number | Promise |
| `goForward(index)` | Navigates forward | `index` — number | Promise |
| `reload(index)` | Reloads a tab | `index` — number | Promise |
| `getTabUrl(index)` | Returns the current URL of a tab | `index` — number | Promise — string |
| `pin(index)` | Pins or unpins a tab | `index` — number | Promise |
| `reorder(order)` | Reorders tabs | `order` — array of indices | Promise |
| `onTabCreated(callback)` | Registers a listener for tab creation events | `callback` | void |
| `onTabRemoved(callback)` | Registers a listener for tab removal events | `callback` | void |
| `onTabSwitched(callback)` | Registers a listener for tab switch events | `callback` | void |
| `onUrlUpdated(callback)` | Registers a listener for URL change events | `callback` | void |
| `onNavigationUpdated(callback)` | Registers a listener for navigation state changes | `callback` | void |

### `window.tabsUI`

| Method | Purpose | Inputs | Output |
|---|---|---|---|
| `onPinTab(handler)` | Registers a handler called when the main process requests a pin-tab UI update | `handler` — function receiving `(index)` | void |

### `window.persist`

| Method | Purpose | Inputs | Output |
|---|---|---|---|
| `getMode()` | Returns the current persist mode | — | Promise — boolean |
| `setMode(enabled)` | Sets persist mode on or off | `enabled` — boolean | Promise |

### `window.dragdrop`

| Method | Purpose | Inputs | Output |
|---|---|---|---|
| `getWindowAtPoint(screenX, screenY)` | Returns the window ID under given screen coordinates | `screenX`, `screenY` — numbers | Promise |
| `getThisWindowId()` | Returns the ID of the current window | — | Promise — number |
| `moveTabToWindow(fromWindowId, tabIndex, targetWindowId, url)` | Moves a tab from one window to another | all numbers + url string | Promise |
| `detachToNewWindow(tabIndex, screenX, screenY, url)` | Detaches a tab into a new window | `tabIndex`, `screenX`, `screenY`, `url` | Promise |

### `window.menu`

| Method | Purpose | Inputs | Output |
|---|---|---|---|
| `open()` | Opens the menu | — | Promise |
| `close()` | Closes the menu | — | Promise |
| `onClosed(callback)` | Registers a listener for when the menu closes | `callback` | void |

### `window.browserHistory`

| Method | Purpose | Inputs | Output |
|---|---|---|---|
| `get()` | Returns all history entries | — | Promise — array |
| `search(query, limit)` | Searches history | `query` — string; `limit` — number | Promise — array |
| `remove(url, timestamp)` | Deletes a specific history entry | `url`, `timestamp` | Promise |

### `window.suggestions`

| Method | Purpose | Inputs | Output |
|---|---|---|---|
| `open(bounds, items, activeIndex)` | Opens the suggestions overlay | `bounds`, `items`, `activeIndex` | Promise |
| `update(bounds, items, activeIndex)` | Updates an open overlay | same as `open` | Promise |
| `close()` | Closes the suggestions overlay | — | Promise |
| `onSelected(handler)` | Registers a handler called when the user selects a suggestion | `handler` — function receiving `(item)` | void |
| `onPointerDown(handler)` | Registers a handler for pointer-down events on the overlay | `handler` | void |
| `onCreated(handler)` | Registers a handler called once the overlay is created | `handler` | void |

### `window.electronAPI`

| Method | Purpose | Inputs | Output |
|---|---|---|---|
| `windowClick(pos)` | Notifies main of a click position | `pos` — object with coordinates | void |
| `onShowFindInPage(callback)` | Listens for the main process to show the find bar | `callback` | void |
| `openHistoryTab()` | Opens the history tab | — | Promise |
| `openBookmarksTab()` | Opens the bookmarks tab | — | Promise |
| `navigateActiveTab(url)` | Navigates the active tab to a URL | `url` — string | Promise |
| `activeTabGoBack()` | Navigates back in the active tab | — | Promise |
| `onToggleBookmarkBar(handler)` | Listens for bookmark bar toggle requests | `handler` | void |
| `onBookmarkPromptClosed(handler)` | Listens for the bookmark prompt closing | `handler` | void |
| `onBookmarkAddPrompt(handler)` | Listens for a prompt to add a bookmark from the bar | `handler` | void |
| `onBookmarkEditPrompt(handler)` | Listens for a prompt to edit an existing bookmark | `handler` | void |
| `onBookmarkFolderRename(handler)` | Listens for a folder rename prompt | `handler` | void |
| `onBookmarkNewFolderPrompt(handler)` | Listens for a new-folder creation prompt | `handler` | void |
| `reportChromeHeight(height)` | Sends the current chrome height to main | `height` — number | void |
| `openBookmarkPrompt(bounds, url, title, hasObj, id, mode)` | Opens the bookmark add/edit prompt overlay | various | Promise |
| `openFolderDropdown(anchorRect, folderData)` | Opens the folder dropdown overlay | `anchorRect`, `folderData` | Promise |
| `closeFolderDropdown()` | Closes the folder dropdown | — | void |
| `onExternBookmarkDragStart(cb)` | Listens for an external drag-start event for a bookmark | `cb` — function receiving `(id, folderId)` | void |
| `onExternBookmarkDragEnd(cb)` | Listens for an external drag-end event | `cb` | void |
| `onExternBookmarkDragPosition(cb)` | Listens for drag position updates from another view | `cb` — function receiving `(x, y)` | void |
| `externBookmarkDrop(x, y)` | Reports a cross-view bookmark drop | `x`, `y` — numbers | void |

### `window.focusMode`

| Method | Purpose | Inputs | Output |
|---|---|---|---|
| `toggle()` | Toggles focus mode on/off | — | Promise |
| `getState()` | Returns whether focus mode is currently active | — | Promise — boolean |
| `onChanged(handler)` | Listens for focus mode state changes | `handler` — function receiving `(active)` | void |
| `overlayOpen()` | Signals that the focus overlay is open | — | void |
| `overlayClose()` | Signals that the focus overlay is closed | — | void |

### `window.browserBookmarks`

| Method | Purpose | Inputs | Output |
|---|---|---|---|
| `getAll()` | Returns all bookmarks and folders | — | Promise — array |
| `add(url, title)` | Adds a bookmark | `url`, `title` — strings | Promise |
| `remove(url)` | Removes a bookmark by URL | `url` — string | Promise |
| `removeById(id)` | Removes a bookmark by ID | `id` | Promise |
| `has(url)` | Checks whether a bookmark exists for the URL | `url` — string | Promise — boolean |
| `reorder(ids)` | Reorders top-level items | `ids` — array | Promise |
| `reorderInFolder(folderId, ids)` | Reorders items within a folder | `folderId`, `ids` | Promise |
| `addFolder(title)` | Creates a new bookmark folder | `title` — string | Promise |
| `addDivider()` | Adds a divider item | — | Promise |
| `moveIntoFolder(itemId, folderId, beforeId)` | Moves an item into a folder | `itemId`, `folderId`, `beforeId` | Promise |
| `moveOutOfFolder(itemId, folderId, beforeId)` | Moves an item out of a folder | `itemId`, `folderId`, `beforeId` | Promise |
| `updateById(id, updates)` | Updates fields on a bookmark or folder | `id`, `updates` — object | Promise |
| `onChanged(handler)` | Listens for any bookmark data change | `handler` | void |
| `showContextMenu(url)` | Opens the native context menu for a bookmark | `url` — string | void |
| `showBarContextMenu(item)` | Opens the context menu for a bookmark bar item | `item` | void |
| `openInNewTab(url, switchToTab)` | Opens a URL in a new tab | `url`, `switchToTab` | Promise |

### `window.contentInteraction`

| Method | Purpose | Inputs | Output |
|---|---|---|---|
| `onClicked(fn)` | Listens for a `'content-clicked'` event pushed by main | `fn` — function | void |

### `window.windowControls`

| Property/Method | Purpose | Inputs | Output |
|---|---|---|---|
| `platform` | The current OS platform string | — | string |
| `minimize()` | Minimises the window | — | Promise |
| `maximize()` | Maximises or restores the window | — | Promise |
| `close()` | Closes the window | — | Promise |
| `isMaximized()` | Returns whether the window is currently maximised | — | Promise — boolean |
| `onMaximizeChanged(fn)` | Listens for maximise state changes | `fn` — function receiving `(v)` | void |

### `window.northstarSettings`

| Method | Purpose | Inputs | Output |
|---|---|---|---|
| `get()` | Returns all settings | — | Promise |
| `set(key, val)` | Persists a setting value | `key` — string; `val` — any | Promise |
| `clearHistory()` | Clears all browsing history | — | Promise |
| `toggleBookmarkBar()` | Toggles the bookmark bar visibility | — | void |
| `loginGoogle(clientId, clientSecret)` | Initiates Google OAuth login | `clientId`, `clientSecret` — strings | Promise |

### `window.bruno`

| Method | Purpose | Inputs | Output |
|---|---|---|---|
| `open()` | Opens the Bruno panel | — | Promise |
| `close()` | Closes the Bruno panel | — | Promise |
| `selectDirectory()` | Opens a native directory picker | — | Promise — string or null |
| `resizeStart(x)` / `resizeMove(x)` / `resizeEnd()` | Panel resize drag | `x` — number | Promise |
| `listRequests(path)` | Lists request files in a collection | `path` — string | Promise |
| `createRequest(path, name)` | Creates a new request file | `path`, `name` — strings | Promise |
| `saveRequest(path, filename, data)` | Saves request data to a file | `path`, `filename`, `data` | Promise |
| `loadRequest(path)` | Loads a request file | `path` — string | Promise |
| `deleteRequest(path, filename)` | Deletes a request file | `path`, `filename` | Promise |
| `createEnvironment(path, name)` | Creates a new environment file | `path`, `name` | Promise |
| `listEnvironments(path)` | Lists environment files in a collection | `path` — string | Promise |
| `loadEnvironment(path)` | Loads an environment's public variables | `path` — string | Promise |
| `loadEnvironmentFull(path)` | Loads all environment variables including secrets | `path` — string | Promise |
| `saveEnvironment(path, vars)` | Saves environment variables | `path`, `vars` | Promise |
| `deleteEnvironment(path)` | Deletes an environment file | `path` — string | Promise |
| `openCollection()` | Lists known collections | — | Promise |
| `createCollection()` | Creates a new collection via a directory picker | — | Promise |
| `initCollection(path)` | Initialises a Bruno collection at a path | `path` — string | Promise |
| `getActiveEnvironment(path)` | Returns the active environment name | `path` — string | Promise — string |
| `setActiveEnvironment(path, n)` | Sets the active environment | `path`, `n` — strings | Promise |
| `saveState(state)` / `loadState()` | Persists/restores Bruno UI state | `state` — object | Promise |
| `exportCollection(path)` / `importCollection(path)` | Export/import a collection | `path` — string | Promise |
| `deleteCollectionFile(path)` / `loadCollectionFile(path)` / `saveCollectionFile(path, data)` | Low-level file ops | `path`, `data` | Promise |
| `gitInit(path)` / `isGitRepo(path)` / `gitStatus(path)` / `createGitignore(path)` | Git operations | `path` — string | Promise |

---

## settings-preload.js

### Purpose

Preload script for the settings page. Exposes a focused set of IPC-backed APIs for reading and writing application settings, clearing history, toggling the bookmark bar, and navigating to special built-in tabs. Also sends a `'content-view-click'` notification to the main process on every primary mousedown.

### `window.northstarSettings`

| Method | Purpose | Inputs | Output |
|---|---|---|---|
| `get()` | Returns the full settings object | — | Promise |
| `set(key, val)` | Persists a single setting | `key` — string; `val` — any | Promise |
| `clearHistory()` | Deletes all browsing history | — | Promise |
| `toggleBookmarkBar()` | Toggles the bookmark bar visibility | — | void |
| `openHistoryTab()` | Opens the history built-in tab | — | Promise |
| `openBookmarksTab()` | Opens the bookmarks built-in tab | — | Promise |

---

## suggestions-preload.js

### Purpose

Preload script for the URL suggestions overlay `WebContentsView`. The suggestions overlay is a separate, floating renderer that displays autocomplete results below the address bar. This preload bridges the overlay renderer to the main process, allowing it to receive suggestion data pushed from main, notify main when the user selects a suggestion or presses the pointer down, and request that the overlay be closed.

### `window.overlaySuggestions`

| Method | Purpose | Inputs | Output |
|---|---|---|---|
| `onData(callback)` | Registers a listener for suggestion data pushed from the main process | `callback` — function receiving `(payload)` | void |
| `close()` | Requests the main process to close the suggestions overlay | — | Promise |
| `select(item)` | Notifies the main process that the user has selected a suggestion | `item` — suggestion object | Promise |
| `pointerDown()` | Notifies the main process that a pointer-down event occurred inside the overlay | — | Promise |
