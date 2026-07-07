# Features

---

## binary-search-tree.js

### Purpose

`binary-search-tree.js` implements a generic, index-keyed binary search tree (BST) used by `NavigationHistory` to store per-tab browser navigation entries. Each node holds a `data` value (a URL string) and a numeric `index` key. The BST is ordered by `index`, which allows efficient predecessor/successor lookups for back/forward navigation, as well as range deletion (`deleteGreaterThan`) to truncate forward history when a new URL is visited mid-history. Nodes maintain parent pointers to enable the standard iterative predecessor/successor algorithms without recursion.

### Classes

#### `BSTNode`

Represents a single node in the tree.

##### `constructor(data, index)`

| Parameter | Description |
|---|---|
| `data` | The URL string stored at this node |
| `index` | The integer navigation position key (ordering criterion) |

**Properties set:** `data`, `index`, `left` (`null`), `right` (`null`), `parent` (`null`).

#### `BinarySearchTree`

The tree container class.

##### `constructor()`

Initialises `root` to `null` and `size` to `0`.

### Methods of `BinarySearchTree`

#### `insert(data, index)`

Inserts a new node with the given `data` and `index`. If a node with the same `index` already exists its `data` is overwritten in place.

**Returns:** `BSTNode` — the inserted or updated node.

#### `find(index)`

Searches for a node by its integer `index`.

**Returns:** `BSTNode|null` — the matching node, or `null` if not found.

#### `findMin(node)`

Traverses left children to find the node with the smallest `index` in the subtree rooted at `node`.

**Returns:** `BSTNode|null` — the minimum-index node, or `null` if the subtree is empty.

#### `findMax(node)`

Traverses right children to find the node with the largest `index` in the subtree rooted at `node`.

**Returns:** `BSTNode|null` — the maximum-index node, or `null` if the subtree is empty.

#### `findPredecessor(node)`

Returns the node with the largest `index` that is strictly less than `node.index`. Uses the left-subtree maximum if present; otherwise walks up the parent chain.

**Returns:** `BSTNode|null` — the in-order predecessor, or `null` if `node` has the minimum index.

#### `findSuccessor(node)`

Returns the node with the smallest `index` that is strictly greater than `node.index`. Uses the right-subtree minimum if present; otherwise walks up the parent chain.

**Returns:** `BSTNode|null` — the in-order successor, or `null` if `node` has the maximum index.

#### `delete(index)`

Removes the node with the given `index` using the standard three-case BST deletion algorithm (leaf, one child, two children). When the node has two children the successor's `data` and `index` are copied into the node and the successor is deleted instead.

**Returns:** `boolean` — `true` if the node was found and deleted, `false` if not found.

#### `deleteGreaterThan(index)`

Collects the indices of all nodes whose `index` is greater than the given value via an in-order traversal, then deletes each of them. Used to truncate forward history.

**Returns:** nothing.

#### `inOrderTraversal(callback, node)`

Performs a recursive in-order (left → node → right) traversal of the subtree rooted at `node`, invoking `callback` with each `BSTNode`.

**Returns:** nothing.

#### `toArray()`

Collects all nodes via `inOrderTraversal` into an array of plain objects.

**Returns:** `Array<{data: string, index: number}>` — all entries sorted by ascending `index`.

#### `getSize()`

**Returns:** `number` — the current number of nodes in the tree.

#### `clear()`

Resets the tree to an empty state (`root = null`, `size = 0`).

#### `isEmpty()`

**Returns:** `boolean` — `true` if the tree contains no nodes.

#### `getHeight(node)`

Recursively computes the height of the subtree rooted at `node`.

**Returns:** `number` — height of the subtree (`-1` for an empty/null subtree).

### Key Variables

| Name | Type | Purpose |
|---|---|---|
| `root` | `BSTNode\|null` | Root node of the tree |
| `size` | `number` | Count of nodes currently in the tree; kept in sync by `insert` and `delete` |

---

## bookmarks.js

### Purpose

Manages the user's bookmark collection, stored as an AES-256-GCM encrypted JSON file at `userData/bookmarks.json`. Supports flat bookmarks, folders (with nested children), and dividers. Provides full CRUD plus drag-and-drop reordering and folder membership operations.

### Class: `Bookmarks`

#### Key Variables

| Property | Type | Purpose |
|---|---|---|
| `file` | `string` | Absolute path to `bookmarks.json` in Electron's userData directory |
| `cache` | `Array\|null` | In-memory copy of the bookmarks array; avoids repeated disk reads |

### Methods

#### `genId()`
Generates a unique ID string using `Date.now` + `Math.random` in base-36.
- **Returns** `string`

#### `normalize(item)`
Ensures an item has an `id` and `type` field. Used during migration of old bookmark data.
- **Returns** bookmark object with `id` and `type` guaranteed

#### `load()`
Reads and decrypts the bookmarks file (with plaintext fallback for legacy files). Caches result in `cache`.
- **Returns** `Promise<Array>`

#### `save()`
Encrypts and writes `cache` to disk.
- **Returns** `Promise<void>`

#### `getAll()`
Returns the full bookmarks array.
- **Returns** `Promise<Array>`

#### `add(url, title)`
Adds a bookmark if the URL is not already bookmarked.
- **Returns** `Promise<boolean>` — `true` if added, `false` if duplicate

#### `remove(url)`
Removes the first bookmark with the given URL.
- **Returns** `Promise<boolean>` — `true` if found and removed

#### `removeById(id)`
Removes any item (bookmark, folder, divider) by its ID, searching recursively through folder children.
- **Returns** `Promise<boolean>`

#### `has(url)`
Returns `true` if any bookmark has this URL.
- **Returns** `Promise<boolean>`

#### `updateTitle(url, title)`
Updates the title of the bookmark matching `url`.
- **Returns** `Promise<void>`

#### `updateById(id, updates)`
Merges `updates` (partial object) into the item with the given `id`.
- **Returns** `Promise<boolean>`

#### `addFolder(title)`
Appends a new top-level folder with an empty `children` array.
- **Returns** `Promise<string>` — the new folder's ID

#### `addDivider()`
Appends a new top-level divider item.
- **Returns** `Promise<string>` — the new divider's ID

#### `addFolderInto(title, parentFolderId)`
Appends a new sub-folder inside an existing folder.
- **Returns** `Promise<string|null>` — new folder ID, or `null` if parent not found

#### `addDividerInto(parentFolderId)`
Appends a divider inside an existing folder.
- **Returns** `Promise<string|null>`

#### `moveOutOfFolder(itemId, folderId, insertBeforeId?)`
Removes `itemId` from its current parent and inserts it at the top level, optionally before `insertBeforeId`.
- **Returns** `Promise<boolean>`

#### `moveIntoFolder(itemId, folderId, insertBeforeId?)`
Moves `itemId` into `folderId`. Prevents cycles (can't move a folder into its own descendant). Optionally inserts before a sibling.
- **Returns** `Promise<boolean>`

#### `reorder(ids)`
Reorders the top-level bookmark array to match the given ID order. Items not in `ids` are appended at the end.
- **Returns** `Promise<void>`

#### `reorderInFolder(folderId, orderedIds)`
Reorders the children of `folderId` to match `orderedIds`.
- **Returns** `Promise<boolean>`

#### `findNodeAndParentArray(id, array?)`
Recursively finds an item by ID in the bookmark tree, returning `{ node, parentArray, index }`.
- **Returns** `{ node, parentArray, index }|null`

---

## encryption.js

### Purpose

Provides AES-256-GCM symmetric encryption for all persistent user data. A 256-bit master key is generated once with a CSPRNG and stored at `userData/northstar/.key` (mode 0600 on Unix). Every encrypted value is a JSON blob containing a 96-bit IV, a 128-bit GCM authentication tag, and the ciphertext — all base64-encoded. The auth tag provides tamper detection equivalent to an HMAC.

### Module-level Variables

| Variable | Type | Purpose |
|---|---|---|
| `ALGO` | `string` | Cipher algorithm — `'aes-256-gcm'` |
| `KEY_BYTES` | `number` | Key length in bytes — `32` (256-bit) |
| `IV_BYTES` | `number` | IV length in bytes — `12` (96-bit, optimal for GCM) |
| `TAG_BYTES` | `number` | Auth tag length — `16` (128-bit) |
| `cachedKey` | `Buffer\|null` | In-memory cache of the loaded key; avoids repeated disk reads |
| `cachedKeyPath` | `string\|null` | Resolved absolute path to the key file; cached after first resolution |

### Functions

#### `encrypt(plaintext)`
Encrypts a UTF-8 string. Generates a fresh random IV for every call.
- **Returns** `string` — a JSON string of the form `{ v: 1, iv, tag, data }` safe to write to a file

#### `decrypt(ciphertext)`
Decrypts a value produced by `encrypt()`. Throws if the GCM authentication tag does not match (data tampered).
- **Returns** `string` — the original plaintext (UTF-8)

#### `isEncrypted(str)`
Checks whether a string looks like an encrypted blob written by this module. Used for transparent migration from legacy plaintext files.
- **Returns** `boolean` — `true` if it is a valid `{ v: 1, iv, tag, data }` JSON object

### Internal Functions

#### `resolveKeyPath()`
Determines the absolute path for the key file. Uses `app.getPath('userData')` if Electron is available, otherwise falls back to the current working directory.
- **Returns** `string`

#### `getKey()`
Loads the key from disk on first call; returns the cached key on subsequent calls. Generates and saves a new key if the file is missing or corrupt.
- **Returns** `Buffer` — 32-byte key

---

## find-dialog.js

### Purpose

Implements in-page text search via a floating frameless `BrowserWindow` ("find bar") that overlays the top-right corner of the parent window. Uses a singleton `FindDialogManager` to manage one `FindDialog` per parent window. IPC handlers are registered once globally so they work regardless of which `WebContentsView` sends the event.

### Class: `FindDialogManager` (singleton)

Accessed via `FindDialogManager.getInstance()`.

#### Key Variables

| Property | Type | Purpose |
|---|---|---|
| `dialogs` | `Map<number, FindDialog>` | Maps parent window `webContents.id` → its `FindDialog` instance |

#### Methods

##### `static getInstance()`
Returns the singleton instance, creating it on first call.
- **Returns** `FindDialogManager`

##### `createDialog(parentWindow)`
Creates a `FindDialog` for `parentWindow` if one does not already exist, then returns it.
- **Returns** `FindDialog`

##### `removeDialog(windowId)`
Deletes the dialog entry for the given `windowId`. Called when the parent window closes.

##### `setupGlobalIPC()`
Registers IPC handlers for `find-search`, `find-next`, `find-previous`, `find-clear`, `find-close`. Each routes to the `FindDialog` whose `findWindow.webContents` matches the event sender.

##### `getDialogForEvent(event)`
Finds the `FindDialog` whose `findWindow` sent the IPC event.
- **Returns** `FindDialog|null`

### Class: `FindDialog`

One instance per parent window.

#### Key Variables

| Property | Type | Purpose |
|---|---|---|
| `parentWindow` | `BrowserWindow` | The browser window this dialog belongs to |
| `manager` | `FindDialogManager` | Back-reference to the manager for cleanup |
| `findWindow` | `BrowserWindow\|null` | The floating find-bar window; `null` when closed |
| `activeTab` | `WebContentsView\|null` | The tab being searched |
| `currentSearchTerm` | `string` | The last search term sent to `findInPage` |
| `parentWindowId` | `number` | `webContents.id` of the parent window |
| `isDestroyed` | `boolean` | Set to `true` when the parent window closes |

#### Methods

##### `show(activeTab)`
Opens (or focuses) the find-bar window and sets it as the target for `activeTab`. Positions the window in the top-right corner of the parent.

##### `close()`
Closes the find-bar window if it is open.

##### `cleanup()`
Closes the find-bar window and clears `findWindow`, `activeTab`, and `parentWindow` references.

##### `handleSearch(searchTerm)`
Calls `findInPage(searchTerm)` on the active tab's webContents.

##### `handleNext()`
Advances to the next match using `findInPage` with `findNext: true`.

##### `handlePrevious()`
Goes to the previous match using `findInPage` with `forward: false`.

##### `handleClear()`
Stops the find session and clears the highlight via `stopFindInPage('clearSelection')`.

##### `handleFindResult(result)`
Receives a `found-in-page` event result and forwards `activeMatchOrdinal` and `matches` to the find-bar renderer via IPC.

---

## focus-mode/

### Purpose

Singleton that tracks and applies "focus mode" per browser window. The feature is split into helper modules:

- `index.js` — state + orchestration (focus mode plus shortform setting)
- `injections.js` — site-specific JS blockers
- `grayscale.js` — grayscale CSS helpers
- `media.js` — media pause helper

When focus mode is enabled, it applies grayscale and full distraction blockers (including YouTube recommendations). When disabled, it removes grayscale and reloads tabs that received injections (active tab immediately; background tabs deferred).

The `blockShortform` setting applies shortform-only blocking (Shorts, TikTok, Reels) without hiding recommendations. Focus mode overrides it and the shortform state is restored when focus mode ends.

---

## google-auth.js

### Purpose

Implements the Google OAuth 2.0 desktop flow using PKCE (Proof Key for Code Exchange). Opens the Google sign-in page in the user's default external browser, spins up a short-lived local HTTP server on a random port to receive the redirect, exchanges the auth code for tokens, then shuts down the server. Used by the settings page to authenticate the user with Google.

### Functions

#### `loginWithGoogle(clientId, clientSecret, scope?)`
Main entry point. Runs the full OAuth 2.0 PKCE flow.

- **Returns** `Promise<object>` — Resolves with the token response `{ access_token, refresh_token, id_token, ... }` on success. Rejects on error or after a 5-minute timeout.

Flow:
1. Generates a PKCE code verifier and challenge
2. Starts a local HTTP server on a random port (`127.0.0.1:0`)
3. Opens the Google auth URL in the external browser via `shell.openExternal`
4. Waits for Google to redirect to `http://127.0.0.1:<port>/?code=...`
5. Exchanges the code for tokens via `exchangeCodeForToken`
6. Closes the server and resolves the promise

#### `exchangeCodeForToken(authCode, redirectUri, clientId, clientSecret, codeVerifier)`
POSTs to Google's token endpoint to exchange the authorization code for tokens.
- **Returns** `Promise<object>` — Token response JSON

### Internal Functions

#### `createCodeVerifier()`
Generates a 64-character hex string using `crypto.randomBytes(32)`.
- **Returns** `string`

#### `createCodeChallenge(verifier)`
Produces a base64url-encoded SHA-256 hash of `verifier` (the PKCE code challenge).
- **Returns** `string`

---

## history.js

### Purpose

Manages the user's browsing history, stored as an AES-256-GCM encrypted JSON file at `userData/browsing-history.json`. Entries are kept in reverse-chronological order (newest first), capped at 1000 items. Search-result URLs (Google, Bing, DuckDuckGo) are never stored.

### Class: `History`

#### Key Variables

| Property | Type | Purpose |
|---|---|---|
| `file` | `string\|null` | Absolute path to `browsing-history.json` |
| `initialized` | `boolean` | Whether `ensureFile()` has already run; prevents redundant `stat` calls |

### Methods

#### `initPath()`
Resolves the history file path using `app.getPath('userData')`, falling back to `process.cwd()` if Electron is not available. Called from the constructor.

#### `ensureFile()`
Creates an empty encrypted history file if none exists. Sets `initialized = true` after the first successful run.
- **Returns** `Promise<boolean>`

#### `read()`
Reads and decrypts the history file. Returns an empty array on any error or if the file is missing. Handles legacy plaintext files transparently.
- **Returns** `Promise<Array<{url, title, timestamp}>>`

#### `write(data)`
Encrypts and writes the history array to disk.
- **Returns** `Promise<void>`

#### `loadHistory()`
Returns the full history array.
- **Returns** `Promise<Array<{url, title, timestamp}>>`

#### `addToHistory(url, title)`
Adds a history entry for `url`. Silently ignores search-result URLs. De-duplicates by URL (removes any existing entry for the same URL before prepending the new one). Trims to 1000 entries.
- **Returns** `Promise<void>`

#### `removeFromHistory(url, timestamp)`
Removes the entry matching both `url` and `timestamp`.
- **Returns** `Promise<boolean>` — `true` on success

#### `clearHistory()`
Replaces the history file with an empty array.
- **Returns** `Promise<boolean>` — `true` on success

### Internal Functions

#### `isSearchResultUrl(rawUrl)`
Returns `true` if `rawUrl` is a search result page from Google, Bing, or DuckDuckGo. Prevents cluttering history with transient search queries.
- **Returns** `boolean`

---

## navigation-history.js

### Purpose

`navigation-history.js` defines the `NavigationHistory` class, which manages per-tab back/forward navigation history for the ink browser. Each tab gets its own `BinarySearchTree` instance where nodes are keyed by a monotonically increasing integer index. This design allows the classic browser pattern of truncating "forward" history when a new URL is visited mid-history. The class also implements URL similarity detection to avoid creating duplicate history entries for redirects, tracking-parameter additions, and root-path normalisation.

### Functions / Methods

#### `constructor()`
Creates an empty `tabHistories` map.

#### `initializeTab(tabIndex, initialUrl)`
Creates a new history record for a tab, inserting the initial URL at index `0`.

#### `addEntry(tabIndex, url)`
Adds a new URL to a tab's history. If the URL is identical to the current entry it is ignored. If it is similar (per `isSimilarUrl`) the current entry is replaced instead. If the current position is behind the max index (i.e. the user previously went back), forward history is truncated before inserting. Auto-initialises history for unknown tab indices.

#### `isSimilarUrl(url1, url2)`
Determines whether two URLs are "similar enough" to be treated as the same history entry. Two URLs are similar when they share the same hostname (ignoring `www.`) and:
- have identical paths with no query string, or
- differ only in tracking parameters (`utm_*`, `fbclid`, `gclid`, `ref=`, `source=`), or
- differ only by a root-path redirect (`/` vs `''` vs `/index.html`).

URLs with a `q=` search parameter are never considered similar.
- **Returns** `boolean`

#### `canGoBack(tabIndex)`
**Returns:** `boolean` — `true` if there is a history entry with a lower index than the current one.

#### `canGoForward(tabIndex)`
**Returns:** `boolean` — `true` if there is a history entry with a higher index than the current one.

#### `goBack(tabIndex)`
Moves the current position to the predecessor node in the BST and returns its URL.
- **Returns** `string|null`

#### `goForward(tabIndex)`
Moves the current position to the successor node in the BST and returns its URL.
- **Returns** `string|null`

#### `getCurrentUrl(tabIndex)`
**Returns:** `string|null` — the URL at the current history position, or `null` if the tab is unknown.

#### `getHistory(tabIndex)`
Returns a complete snapshot of a tab's history state.
- **Returns** `{currentIndex: number, maxIndex: number, entries: Array<{data, index}>, size: number}|null`

#### `removeTab(tabIndex)`
Deletes the history record for a tab, freeing memory when the tab is closed.

#### `clearHistory(tabIndex)`
Alias for `removeTab`; deletes the history record for the given tab.

#### `getHistoryLength(tabIndex)`
**Returns:** `number` — the number of history entries for the tab, or `0` if unknown.

#### `replaceCurrentEntry(tabIndex, url)`
Replaces the URL stored at the current history position without changing the position pointer. Used when a navigation is "similar" to the current entry.

### Key Variables

| Name | Type | Purpose |
|---|---|---|
| `tabHistories` | `Map<number, {tree: BinarySearchTree, currentIndex: number, maxIndex: number}>` | Maps each tab index to its navigation state: a BST of URL entries plus current and maximum position pointers |

---

## persistence.js

### Purpose

Manages two categories of persistent data in the `userData/northstar/` directory: **settings** (theme, search engine, bookmark bar visibility, Pomodoro times, tab persistence mode) and **tab state** (the list of open tabs and the active tab index, saved on close and restored on next launch). Both are stored as AES-256-GCM encrypted JSON files.

### Module-level Variables

| Variable | Type | Purpose |
|---|---|---|
| `DEFAULTS` | `object` | Default values for every setting key. Acts as the authoritative list of valid setting keys. |

Default settings:

| Key | Default | Purpose |
|---|---|---|
| `theme` | `'default'` | UI theme name |
| `persistAllTabs` | `false` | Whether to restore all tabs on launch (vs. only pinned tabs) |
| `searchEngine` | `'google'` | Default search engine (`'google'`, `'duckduckgo'`, `'bing'`) |
| `bookmarkBarVisible` | `false` | Whether the bookmark bar is shown |
| `pomWork` | `25` | Pomodoro work interval in minutes |
| `pomShortBreak` | `5` | Pomodoro short break in minutes |
| `pomLongBreak` | `15` | Pomodoro long break in minutes |
| `pomSessions` | `4` | Work sessions before a long break |

### Class: `Persistence`

#### Key Variables

| Property | Type | Purpose |
|---|---|---|
| `dir` | `string` | Path to `userData/northstar/` — the storage directory |
| `statePath` | `string` | Path to `userData/northstar/tabs-state.json` |
| `settingsPath` | `string` | Path to `userData/northstar/settings.json` |
| `settings` | `object` | In-memory settings merged from file + `DEFAULTS` |

### Methods

#### `ensureDir()`
Creates the `userData/northstar/` directory synchronously if it does not exist.

#### `readEncrypted(filePath)`
Reads and decrypts a file synchronously. Falls back to returning the raw string for legacy plaintext files.
- **Returns** `string` — plaintext content

#### `writeEncrypted(filePath, data)`
JSON-stringifies `data`, encrypts it, and writes synchronously to `filePath`.

#### `loadSettings()`
Reads and parses the settings file, merging with `DEFAULTS`. Returns `DEFAULTS` on any error.
- **Returns** `object`

#### `save()`
Writes the current `this.settings` object to `settingsPath` (encrypted).

#### `getAll()`
Returns a shallow copy of all settings.
- **Returns** `object`

#### `get(key)`
Returns the value of a single setting. Falls back to `DEFAULTS[key]` if not set.
- **Returns** any

#### `set(key, value)`
Sets a single setting and persists. Silently ignores unknown keys (not in `DEFAULTS`).

#### `getPersistMode()`
Returns `true` if `persistAllTabs` is enabled. Legacy convenience method.
- **Returns** `boolean`

#### `setPersistMode(enabled)`
Sets `persistAllTabs`. Legacy convenience method.

#### `hasState()`
Returns `true` if the tab state file exists.
- **Returns** `boolean`

#### `loadState()`
Reads, decrypts, and parses the tab state file.
- **Returns** `{ tabs: Array, activeIndex: number }|null`

#### `saveState(state)`
Encrypts and writes the tab state object to disk synchronously.

---

## shortcuts.js

### Purpose

`shortcuts.js` defines the `Shortcuts` class, which manages all keyboard shortcut handling for a single browser window in the ink application. Rather than using Electron's global `globalShortcut` API (which would conflict across windows), it listens to `before-input-event` on every `WebContents` that belongs to the window — including the browser chrome, every tab, and any additional registered overlay views.

### Functions / Methods

#### `constructor(mainWindow, tabManager, windowManager)`

Initialises the shortcut handler, stores references to its dependencies, creates an empty `shortcuts` `Map`, and calls `setupEventListeners()`.

#### `setupEventListeners()`
Attaches a `before-input-event` listener to the main window's `webContents` and calls `setupAllTabListeners()` for any tabs that already exist.

#### `setupAllTabListeners()`
Iterates over `tabManager.tabMap` and calls `setupTabListener` for each existing tab.

#### `setupTabListener(tab)`
Attaches a `before-input-event` listener to a single tab's `webContents`, guarded by a `shortcutListenerSetup` flag to prevent double-registration.

#### `onTabCreated(tab)`
Called by `Tabs` whenever a new tab is created; delegates to `setupTabListener` so the new tab participates in shortcut handling immediately.

#### `registerWebContents(wc)`
Registers an arbitrary `WebContents` (e.g. an overlay panel) into the shortcut system by attaching a `before-input-event` handler. Stores the handler on `wc.inkShortcutHandler` to allow later removal. Idempotent.

#### `unregisterWebContents(wc)`
Removes the `before-input-event` handler previously installed by `registerWebContents`.

#### `handleInput(event, input)`
Core dispatcher. Ignores non-`keyDown` events. Iterates `shortcuts` in insertion order; when an accelerator matches, calls `event.preventDefault()`, invokes the callback, and stops.

#### `registerAllShortcuts()`
Convenience method that calls all four registration groups in order.

#### `registerTabShortcuts()`

| Accelerator | Action |
|---|---|
| `CmdOrCtrl+T` | Create new tab |
| `CmdOrCtrl+N` | Create new window |
| `CmdOrCtrl+Shift+N` | Create new window |
| `CmdOrCtrl+W` | Close active tab |
| `CmdOrCtrl+Tab` | Switch to next tab |
| `CmdOrCtrl+Shift+Tab` | Switch to previous tab |
| `CmdOrCtrl+1` … `CmdOrCtrl+9` | Switch to tab by 1-based position |

#### `registerNavigationShortcuts()`

| Accelerator | Action |
|---|---|
| `CmdOrCtrl+Left` | Go back in active tab |
| `CmdOrCtrl+Right` | Go forward in active tab |
| `CmdOrCtrl+R` | Reload active tab |
| `CmdOrCtrl+Shift+R` | Hard reload (ignore cache) active tab |

#### `registerPageShortcuts()`

| Accelerator | Action |
|---|---|
| `CmdOrCtrl+F` | Open find-in-page dialog |
| `CmdOrCtrl+Z` | Undo in focused webContents |
| `CmdOrCtrl+Shift+Z` / `CmdOrCtrl+Y` | Redo in focused webContents |
| `CmdOrCtrl+Plus` | Zoom in |
| `CmdOrCtrl+-` | Zoom out |
| `CmdOrCtrl+0` | Reset zoom |
| `F11` | Toggle fullscreen |

#### `registerDeveloperShortcuts()`

| Accelerator | Action |
|---|---|
| `F12` | Toggle DevTools for active tab |
| `CmdOrCtrl+Shift+I` | Toggle DevTools for active tab |

#### `registerApplicationShortcuts()`

| Accelerator | Action |
|---|---|
| `CmdOrCtrl+Q` | Mark all tabs `allowClose`, then call `app.quit()` |
| `CmdOrCtrl+Shift+Q` | Mark all tabs `allowClose`, then close all windows without quitting |

#### `registerShortcut(accelerator, callback)`
Stores an accelerator string / callback pair in the `shortcuts` map.

#### `matchesAccelerator(input, accelerator)`
Parses an accelerator string and checks whether a `before-input-event` input descriptor matches it.
- **Returns** `boolean`

#### `switchToNextTab()` / `switchToPreviousTab()` / `switchToTabByNumber(number)`
Tab navigation helpers.

#### `zoomIn()` / `zoomOut()` / `resetZoom()`
Zoom control helpers.

#### `toggleFullScreen()`
Toggles the OS fullscreen state of `mainWindow`.

#### `unregisterAllShortcuts()`
Clears the `shortcuts` map. Called when the window closes.

#### `isShortcutRegistered(accelerator)` / `getRegisteredShortcuts()`
Inspection helpers.

### Key Variables

| Name | Type | Purpose |
|---|---|---|
| `mainWindow` | `BrowserWindow` | The window this `Shortcuts` instance manages |
| `tabManager` | `Tabs` | Used to act on tabs in response to shortcuts |
| `windowManager` | `WindowManager\|null` | Used for window-level actions (new window, quit) |
| `shortcuts` | `Map<string, Function>` | Registry mapping accelerator strings to their handler callbacks |

---

## tab-context-menu.js

### Purpose

Builds the native context menu that appears when right-clicking inside a browser tab's web page. Provides context-aware items for the page, selected text, editable fields, links, images, and media. All "open in new tab" actions use `tabManager.createTab()` and `tabManager.loadUrl()`.

### Class: `TabContextMenu`

#### Constructor: `new TabContextMenu(tab, params, tabManager)`

The constructor immediately calls all `add*` methods to build `contextTemplate`.

#### Key Variables

| Property | Type | Purpose |
|---|---|---|
| `tab` | `WebContentsView` | The tab that received the right-click |
| `tabManager` | `Tabs` | Used to create new tabs for "open in new tab" actions |
| `contextTemplate` | `Array` | Electron menu template array built by the `add*` methods |

### Methods

#### `getTemplate()`
Returns the completed menu template array.
- **Returns** `Array`

#### `sep()`
Appends a separator to `contextTemplate` only if the last item is not already a separator.

#### `openInNewTab(url)`
Creates a new tab and loads `url` in it.

#### `addPageItems(params)`
Always present. Adds Back, Forward, Reload. If the page is a real URL (not `file://`): also adds Save Page, Print, View Source, Copy URL, Inspect Element.

#### `addSelectionItems(params)`
Added when `params.selectionText` is non-empty. Adds Copy and "Search Google for …".

#### `addEditableItems(params)`
Added when `params.isEditable` is true. Adds Undo, Redo, Cut, Copy, Paste, Select All.

#### `addLinkItems(params)`
Added when `params.linkURL` is non-empty. Adds Open in New Tab, Open in New Window, Copy Link, Save Link.

#### `addImageItems(params)`
Added when `params.mediaType === 'image'`. Adds Open Image, Save Image, Copy Image Address, Search Google for Image.

#### `addMediaItems(params)`
Added when `params.mediaType` is `'video'` or `'audio'`. Adds Open Media, Save Media, Copy Media Address.

---

## tabs.js

### Purpose

`tabs.js` defines the `Tabs` class, which is the central manager for all browser tab lifecycle operations within a single `BrowserWindow`. It creates, shows, hides, removes, and navigates tabs implemented as Electron `WebContentsView` instances. It also handles pinned tabs, lazy (deferred) tab loading, per-tab navigation history, the find-in-page dialog, HTML5 fullscreen, tab audio muting, closed-tab history for "Reopen Closed Tab", and debounced persistence of tab state.

### Functions / Methods

#### `constructor(mainWindow, History, Persistence)`

| Parameter | Description |
|---|---|
| `mainWindow` | The Electron `BrowserWindow` that owns these tabs |
| `History` | An instance of the `History` class used to record browsing history |
| `Persistence` | An instance of the `Persistence` class used to save and restore tab state; may be `null` |

#### `createLazyTab(url, title, isPinned)`
Creates a tab whose content is not loaded until the tab is first shown (`showTab`). Used during session restore.
- **Returns** `number` — the new tab's integer index.

#### `computeDisplayTitleFor(index, fallbackTitle)`
Derives the human-readable title for a tab, handling lazy-loaded, internal, and live tabs.
- **Returns** `string`

#### `updateWindowTitle(index, explicitTitle)`
Sets the OS-level `BrowserWindow` title to match the active tab.

#### `setWindowManager(windowManager)` / `setShortcuts(shortcuts)`
Dependency injection methods.

#### `getWindowData()`
Retrieves the window data object for this instance from the `WindowManager`.
- **Returns** `object|null`

#### `createTab()`
Creates a new tab loading the New Tab page. Makes the tab active.
- **Returns** `number`

#### `createTabWithPage(pagePath, pageType, pageTitle)`
Creates a new tab loading a specific internal HTML file.
- **Returns** `number`

#### `getTabBounds()`
Calculates the pixel bounds for a `WebContentsView`, accounting for utility bar (50 px), tab bar (38 px), optional bookmark bar, fullscreen state, and Bruno sidebar width.
- **Returns** `{x, y, width, height}`

#### `setupTabListeners(tabIndex, tab)`
Attaches all `webContents` event listeners for a tab.

#### `sendTabUpdate(tabIndex, tab, url, title, favicon)`
Sends a `'url-updated'` IPC message to the renderer.

#### `sendNavigationUpdate(tabIndex)`
Sends a `'navigation-updated'` IPC message with `canGoBack` / `canGoForward` flags.

#### `addToHistory(url, title)`
Adds a URL to persistent browsing history, skipping `file://` URLs.

#### `showTab(index)`
Makes a tab visible, hides all other tabs, triggers lazy loading if needed.

#### `loadUrl(index, url)`
Loads a URL into an existing tab.

#### `destroyTab(tab)`
Mutes audio, removes the `WebContentsView` from the window's content view, and destroys the underlying `webContents`.

#### `recordClosed(index)`
Pushes the tab's URL and title onto `closedTabHistory` (capped at 20 entries). Skips `newtab` and internal pages.

#### `removeTab(index)` / `removeTabWithTargetFocus(index, targetTabIndex)`
Closes and destroys a tab.

#### `getTotalTabs()`
**Returns:** `number`

#### `goBack(index)` / `goForward(index)` / `reload(index)`
Navigation methods.

#### `canGoBack(index)` / `canGoForward(index)`
**Returns:** `boolean`

#### `resizeAllTabs()` / `collapseAllTabs()` / `restoreAllTabs()`
Layout management methods.

#### `muteTab(index)` / `pinTab(index)` / `reorderTabs(newOrder)`
Tab state management.

#### `buildSerializableState()`
Constructs a plain-object snapshot of current tab state suitable for JSON serialisation.
- **Returns** `{tabs: Array, activeIndex: number, persistAllTabs: boolean}`

#### `saveStateDebounced()`
Schedules a debounced call to `persistence.saveState(buildSerializableState())` 200 ms after the last call.

### Key Variables

| Name | Type | Purpose |
|---|---|---|
| `mainWindow` | `BrowserWindow` | The Electron window that owns this `Tabs` instance |
| `history` | `History` | Persistent browsing history service |
| `persistence` | `Persistence\|null` | Session state and settings storage |
| `navigationHistory` | `NavigationHistory` | Per-tab back/forward navigation history using a BST |
| `findDialog` | `FindDialog` | The find-in-page overlay for this window |
| `tabMap` | `Map<number, WebContentsView>` | Maps integer tab index to its `WebContentsView` |
| `tabUrls` | `Map<number, string>` | Maps integer tab index to its current URL |
| `activeTabIndex` | `number` | Index of the currently visible tab |
| `allowClose` | `boolean` | When `true`, the close-prevention guard lets `mainWindow.close()` proceed |
| `isHtmlFullScreen` | `boolean` | Whether an HTML5 fullscreen request is currently active |
| `pinnedTabs` | `Set<number>` | Set of tab indices that are pinned |
| `tabOrder` | `Array<number>` | Display order of tab indices |
| `closedTabHistory` | `Array<{url, title}>` | Stack (max 20) of recently closed tab URLs for "Reopen Closed Tab" |
| `bookmarkBarHeight` | `number` | Height in pixels of the bookmark bar (0 when hidden) |
| `brunoWidth` | `number` | Width in pixels of the Bruno sidebar |
| `windowManager` | `WindowManager\|undefined` | Reference set by `setWindowManager` |
| `saveTimer` | `Timeout` | Debounce timer for `saveStateDebounced` |

---

## user-agent.js

### Purpose

Sets a Firefox 124 user-agent on every tab and on the Electron session to avoid Google's "unsupported browser" detection. Also strips `Sec-CH-UA` client hints (which would reveal Chromium) and adds `DNT: 1` and `Accept-Language` headers on main-frame navigations.

### Class: `UserAgent` (static methods only)

#### `UserAgent.generate()`
Returns a Firefox 124 user-agent string appropriate for the current OS platform.
- **Returns** `string`

#### `UserAgent.setupTab(tab)`
Sets the Firefox user-agent on a single `WebContentsView`. Called during tab creation.

#### `UserAgent.setupSession(session)`
Applies the Firefox user-agent to the Electron session and registers a `webRequest.onBeforeSendHeaders` hook that strips all `Sec-CH-UA-*` request headers and adds `DNT: 1` and `Accept-Language`.

#### `UserAgent.getPlatformInfo()`
Returns basic OS information.
- **Returns** `{ platform, arch, release, type }`

### Internal Functions

#### `platformString()`
Maps the current `os.platform()` to the platform string used inside the user-agent.
- **Returns** `string`

---

## window-context-menu.js

### Purpose

Builds the native context menu for right-clicks on the browser chrome, specifically targeting the tab bar. Provides tab management actions when right-clicking a tab button, and a simplified menu when right-clicking empty tab bar space.

### Class: `WindowContextMenu`

#### Constructor: `new WindowContextMenu(window, params, windowManager)`

#### Key Variables

| Property | Type | Purpose |
|---|---|---|
| `window` | `BrowserWindow` | The browser window |
| `windowManager` | `WindowManager` | Used to call `getWindowByWebContents` |
| `contextTemplate` | `Array` | Electron menu template built by the `add*` methods |

### Methods

#### `getTemplate()`
Returns the completed menu template.
- **Returns** `Array`

#### `sep()`
Appends a separator if the last item is not already a separator.

#### `getWindowData()`
Resolves `windowData` from `windowManager` for the current window.
- **Returns** `windowData|null`

#### `addSelectionItems(params)`
Added when `params.selectionText` is non-empty. Adds Copy and "Search Google for …".

#### `addEditableItems(params)`
Added when `params.isEditable`. Adds Undo, Redo, Cut, Copy, Paste, Select All.

#### `addTabItems(params)`
Added when `params.isTabButton` is `true`. Adds New Tab, Reload Tab, Duplicate Tab, Pin/Unpin Tab, Mute/Unmute Tab, Close Tab, Close Other Tabs, Reopen Closed Tab.

#### `addTabBarItems(params)`
Added when right-clicking empty tab bar space. Adds New Tab and Reopen Closed Tab.

---

## window-manager.js

### Purpose

`window-manager.js` defines the `WindowManager` class, which is the top-level coordinator for all browser windows in the ink application. It is responsible for creating new `BrowserWindow` instances, attaching a `Tabs` manager and a `Shortcuts` manager to each window, restoring persisted tab state on first launch, handling window focus tracking, routing context-menu events on the browser chrome, and cleanly closing all windows when the app quits.

### Functions / Methods

#### `constructor()`
Initialises the `WindowManager` with an empty window registry, lazily-initialised singletons for `History`, `Persistence`, and `Bookmarks`, a window-id counter, and a focus-order tracker.

#### `get history`
Lazy getter. Creates and caches a `History` instance on first access.
- **Returns** `History`

#### `get persistence`
Lazy getter. Creates and caches a `Persistence` instance on first access.
- **Returns** `Persistence`

#### `get bookmarks`
Lazy getter. Creates and caches a `Bookmarks` instance on first access.
- **Returns** `Bookmarks`

#### `createWindow(width, height)`
Creates a new Electron `BrowserWindow`, configures its appearance and preload, attaches `Tabs` and `Shortcuts`, registers focus tracking, sets up chrome-level context-menu handling, restores persisted tab state (once, into the first window), and wires up the `closed` event for clean-up.
- **Returns** `object` — a `windowData` object with shape `{ id, window, tabs, shortcuts, menu: null }`

#### `getWindowByWebContents(webContents)`
Searches all open windows and their child views to find which window data object owns a given `webContents`.
- **Returns** `object|null`

#### `getAllWindows()`
**Returns:** `Array<object>`

#### `getWindowById(id)`
**Returns:** `object|null`

#### `getWindowCount()`
**Returns:** `number`

#### `getMostRecentlyFocusedWindow()`
**Returns:** `object|null`

#### `getPrimaryWindow()`
Returns the most recently focused window if available; falls back to the window with the lowest ID.
- **Returns** `object|null`

#### `savePrimaryState()`
Synchronously serialises and saves the tab state from the primary window into `Persistence`.
- **Returns** `boolean`

#### `closeAllWindows()`
Unregisters shortcuts and calls `close()` on every open `BrowserWindow`, then clears the internal registry.

### Key Variables

| Name | Type | Purpose |
|---|---|---|
| `windows` | `Map<number, object>` | Registry mapping integer window IDs to their `windowData` objects |
| `cachedHistory` | `History\|null` | Lazily-initialised shared `History` service |
| `cachedBookmarks` | `Bookmarks\|null` | Lazily-initialised shared `Bookmarks` service |
| `nextWindowId` | `number` | Auto-incrementing counter used to assign IDs to new windows |
| `cachedPersistence` | `Persistence\|null` | Lazily-initialised shared `Persistence` service |
| `restored` | `boolean` | Flag that ensures tab state is restored into the first window only |
| `lastFocusedWindowId` | `number\|null` | ID of the most recently focused window |
