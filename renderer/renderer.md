# renderer/renderer.js

## Purpose

This is the main browser-chrome renderer process script. It owns the entire UI shell of the ink browser window: the tab bar, address/search bar, bookmark bar, navigation buttons, window controls, focus mode, and the Pomodoro timer. All shared state (open tabs, active tab index, current URL, etc.) lives inside a single `DOMContentLoaded` callback. Module-level pure utilities are defined above that callback and hoisted. Each major UI subsystem is initialised by a named `init*` function called in sequence at startup.

---

## Functions / Methods

### Module-level utilities

#### `debounce(fn, delay = 150)`
Returns a debounced wrapper of `fn` that delays execution until `delay` ms have passed without another call. The returned function also exposes a `.cancel()` method that clears any pending timer.
- **Parameters:** `fn` — the function to debounce; `delay` — quiet period in milliseconds (default 150).
- **Returns:** A debounced function with a `.cancel()` method.

#### `faviconFor(url)`
Builds a Google Favicon Service URL for the given page URL.
- **Parameters:** `url` — the full page URL string.
- **Returns:** A Google favicon URL string, or `''` if `url` cannot be parsed.

#### `makeFolderIcon(cls)`
Creates a `<span>` element whose inner HTML is the Material Design folder SVG constant `FOLDER_SVG`.
- **Parameters:** `cls` — CSS class name to assign to the span (defaults to `'bookmark-folder-icon'`).
- **Returns:** A `<span>` DOM element containing the folder SVG.

---

### Inside `DOMContentLoaded`

#### `initWindowControls()`
Detects the platform via `window.windowControls.platform`. On macOS, reserves space for native traffic lights. On Windows/Linux, injects Close / Minimize / Maximize buttons and wires them to `window.windowControls` IPC calls. Also subscribes to `onMaximizeChanged` to swap the maximize-button icon between the maximised and restored states.
- **Parameters:** none
- **Returns:** void

#### `initNavButtons()`
Attaches click handlers to the Back, Forward, Reload, and new-tab Add buttons, forwarding each to the corresponding `window.tab` IPC call. Also registers a global click listener that forwards the event coordinates to the main process when the hamburger menu is open, and subscribes to `window.menu.onClosed` to track `menuOpen` state.
- **Parameters:** none
- **Returns:** void

#### `updateNavigationButtons(canGoBack, canGoForward)`
Updates the disabled state, opacity, and cursor style of the Back and Forward buttons.
- **Parameters:** `canGoBack` — boolean; `canGoForward` — boolean.
- **Returns:** void

#### `initAddressBar()`
Attaches `input`, `focus`, `blur`, and `keydown` listeners to the search bar, wires `window.suggestions` IPC events (`onCreated`, `onSelected`, `onPointerDown`), subscribes to content-area click events via `window.contentInteraction`, and registers resize/scroll listeners to reposition the suggestion overlay.
- **Parameters:** none
- **Returns:** void

#### `getSuggestionsBounds()`
Reads the search bar's bounding rectangle and returns an object describing where the suggestion overlay should appear.
- **Parameters:** none
- **Returns:** `{ left, top, width }` — pixel coordinates for the overlay window.

#### `positionSuggestions()`
If there are active suggestions, calls `window.suggestions.update` with the current bounds to reposition the overlay. Called on resize and scroll.
- **Parameters:** none
- **Returns:** void

#### `hideSuggestions()`
Clears the `_userTyping` flag, cancels the debounced update, closes the suggestion overlay via `window.suggestions.close()`, and resets `currentSuggestions` and `activeSuggestionIndex`.
- **Parameters:** none
- **Returns:** void

#### `renderSuggestions(list)`
Stores the new suggestion list, resets `activeSuggestionIndex` to 0, and calls `window.suggestions.open` with the overlay bounds and the list. Does nothing if `_userTyping` is false.
- **Parameters:** `list` — array of suggestion objects.
- **Returns:** void

#### `setActiveSuggestion(newIndex)`
Moves keyboard focus within the suggestion list, wrapping around at boundaries. Writes the selected item's URL or query into the search bar and calls `window.suggestions.update` to highlight the new active row.
- **Parameters:** `newIndex` — the desired list index (may be out of range; wrapping is applied).
- **Returns:** void

#### `handleSuggestionSelect(index)`
Handles selection of a suggestion by index. If the item is a `switch-tab` type, switches the active tab. If it is a `history` or `bookmark` type, loads the URL. Otherwise treats the item's `query` as a URL/search term.
- **Parameters:** `index` — index into `currentSuggestions`.
- **Returns:** void

#### `onSuggestionSelected(item)`
IPC callback fired when the user clicks a suggestion row in the overlay WebContentsView. Navigates or switches tabs, then hides the overlay.
- **Parameters:** `item` — a suggestion object with `type`, `url`, and/or `query` fields.
- **Returns:** void

#### `onSearchKeyDown(e)`
Keyboard handler for the search bar. ArrowDown/Up navigate the suggestion list; Escape hides it; Enter with an active suggestion selects it; Enter with no suggestions loads the raw input.
- **Parameters:** `e` — `KeyboardEvent`.
- **Returns:** void

#### `getOpenTabSuggestions(q)`
Synchronously searches all open tabs (except the active one) for tabs whose URL or title matches the query string `q`.
- **Parameters:** `q` — the search query string.
- **Returns:** Array of `{ type: 'switch-tab', tabIndex, title, url, favicon }` objects.

#### `getBookmarkSuggestions(q, limit = 3)`
Async. Fetches all bookmarks via `window.browserBookmarks.getAll()` and filters them by `q`.
- **Parameters:** `q` — query string; `limit` — maximum results (default 3).
- **Returns:** Promise resolving to an array of `{ type: 'bookmark', title, url, favicon }` objects.

#### `getHistorySuggestions(q, limit = 5)`
Async. Fetches history via `window.browserHistory.search` (or `.get()` as a fallback) and filters for `q`, deduplicating by normalised URL.
- **Parameters:** `q` — query string; `limit` — maximum results (default 5).
- **Returns:** Promise resolving to an array of `{ type: 'history', title, url, favicon }` objects.

#### `getSearchSuggestions(q, limit = 6)`
Async. Fetches autocomplete suggestions from the configured search engine's suggestion API.
- **Parameters:** `q` — query string; `limit` — maximum results (default 6).
- **Returns:** Promise resolving to an array of `{ type: <engine>, query }` objects.

#### `updateSuggestions` (debounced async function)
Orchestrates all suggestion sources. Immediately renders a single `action` entry, then concurrently fetches open-tab, bookmark, history, and search suggestions, merges them in priority order (open tabs → bookmarks → action → history → search), and re-renders.
- **Parameters:** none (reads `searchBar.value`)
- **Returns:** void (debounced, 120 ms delay)

#### `_normalizeUrl(u)`
Strips the scheme, trailing slash, and lowercases a URL for deduplication comparisons.
- **Parameters:** `u` — URL string.
- **Returns:** Normalised string.

#### `loadUrlInActiveTab(url)`
Formats a raw user input as a fully-qualified URL: passes through if it already starts with `http(s)://`; prepends `https://` if it looks like a domain; otherwise constructs a search engine query URL. Calls `window.tab.loadUrl(activeTabIndex, formatted)`.
- **Parameters:** `url` — raw user input string.
- **Returns:** void

#### `updateSearchBarUrl(url)`
Sets the search bar value to `url` and hides the suggestion overlay.
- **Parameters:** `url` — URL string to display.
- **Returns:** void

#### `closeDropdown()`
Removes the `#bm-dropdown` and `#bm-subdropdown` panels from the DOM, runs any registered cleanup handler, and resets `_openDropdownId`.
- **Parameters:** none
- **Returns:** void

#### `openDropdown(anchorBtn, anchorId, buildFn)`
Toggles the bookmark overflow dropdown. If the dropdown for `anchorId` is already open, closes it. Otherwise creates a `#bm-dropdown` div, calls `buildFn(panel)` to populate it, positions it below `anchorBtn`, appends it to `document.body`, and registers a mousedown-outside handler to auto-close it.
- **Parameters:** `anchorBtn` — the DOM button that was clicked; `anchorId` — a unique identifier string for the anchor; `buildFn(panel)` — callback that populates the panel element.
- **Returns:** void

#### `makeDropdownItem(entry, parentFolderId)`
Builds and returns a single item for the overflow dropdown. Handles `divider`, `folder`, and bookmark entry types. Folder items get a submenu arrow and click-to-open behaviour; bookmark items get a favicon and navigation on click. Supports drag-and-drop when `parentFolderId` is provided. All items have a context-menu handler.
- **Parameters:** `entry` — bookmark/folder/divider data object; `parentFolderId` — id of the enclosing folder (or null for top-level items).
- **Returns:** A `<button>` or `<div>` DOM element.

#### `openFolderSubPanel(anchorItem, entry)`
Closes any existing sub-panel, creates `#bm-subdropdown`, populates it with the folder's children using `makeDropdownItem`, positions it to the right of `anchorItem`, and adds `has-submenu-open` to `anchorItem`.
- **Parameters:** `anchorItem` — the folder button DOM element; `entry` — folder data object including `children`.
- **Returns:** void

#### `makeDraggable(el, item, getAllFn)`
Attaches `dragstart`, `dragend`, `dragover`, `dragleave`, and `drop` listeners to a bookmark-bar element `el`. Handles bookmark reordering, spring-loading folder targets, and moving items into folders.
- **Parameters:** `el` — the draggable DOM element; `item` — the bookmark/folder data object; `getAllFn` — a function that returns the current flat list of all bar items (used for reorder index calculation).
- **Returns:** void

#### `buildSpringPanel(panel, folderEntry)`
Populates a spring-loaded overflow panel with drop-target rows. Each row can accept a dragged item, either reordering within the folder or moving it into a nested sub-folder.
- **Parameters:** `panel` — the `<div>` element to populate; `folderEntry` — folder data object with `children`.
- **Returns:** void

#### `makeBarElement(entry, bookmarks)`
Creates and returns the DOM element for a single top-level bookmark bar entry: a `.bookmark-bar-divider` for dividers, a `.bookmark-bar-folder` button for folders, or a `.bookmark-bar-item` button for bookmarks. Each element is made draggable and gets a context-menu handler.
- **Parameters:** `entry` — the bookmark/folder/divider data object; `bookmarks` — the full array of bar items (passed through to `makeDraggable`).
- **Returns:** A `<div>` or `<button>` DOM element.

#### `reportChromeHeight()`
Computes whether the bookmark bar is visible and has items, shows or hides the bar accordingly, then calls `window.electronAPI.reportChromeHeight` with either 28 (bar visible) or 0 (bar hidden) so the main process can resize the web content area.
- **Parameters:** none
- **Returns:** void

#### `refreshBookmarkBar()`
Async. Clears the bar, fetches all bookmarks, renders each as a bar element, then uses `requestAnimationFrame` to detect overflow and append a `» N` button that opens an overflow dropdown for hidden items. Guards against stale concurrent calls via a sequence counter.
- **Parameters:** none
- **Returns:** Promise\<void\>

#### `updateBookmarkBtn(url)`
Queries `window.browserBookmarks.has(url)` and toggles the `.bookmarked` class on `bookmarkBtn` accordingly. Clears the class for the new-tab page and file:// URLs.
- **Parameters:** `url` — the current tab's URL.
- **Returns:** Promise\<void\>

#### `initBookmarkBar()`
Wires all bookmark-bar IPC events: `onBookmarkAddPrompt`, `onBookmarkEditPrompt`, `onBookmarkFolderRename`, `onBookmarkNewFolderPrompt`, `onToggleBookmarkBar`, `onBookmarkPromptClosed`, and `browserBookmarks.onChanged`. Triggers the initial `refreshBookmarkBar()` call.
- **Parameters:** none
- **Returns:** void

#### `startInlineBarRename(folderId, defaultName)`
Hides the folder label in the bookmark bar and replaces it with a text `<input>` for inline renaming. Enter or blur commits the new name via `window.browserBookmarks.updateById`; Escape cancels and refreshes the bar.
- **Parameters:** `folderId` — id of the folder to rename; `defaultName` — the pre-filled string.
- **Returns:** void

#### `initTabBar()`
Wires all tab-related IPC events (`onTabCreated`, `onTabRemoved`, `onTabSwitched`, `onUrlUpdated`, `onNavigationUpdated`, `onPinTab`) and sets up the drag-to-reorder handler on `tabsContainer`, the scroll arrow buttons, wheel scrolling, and a ResizeObserver to update tab widths on layout changes.
- **Parameters:** none
- **Returns:** void

#### `createTabButton(index, title)`
Creates and appends a `.tab-button` div for a new tab. Includes a title span, close button, keyboard navigation, and drag handlers for in-window reorder and cross-window detach/move.
- **Parameters:** `index` — the tab's integer index; `title` — the initial tab title string.
- **Returns:** void

#### `removeTabButton(index)`
Removes the tab button at `index` from the DOM and from the `tabs` map.
- **Parameters:** `index` — integer tab index.
- **Returns:** void

#### `setActiveTab(index)`
Removes the `.active` class from all tab buttons and adds it to the tab at `index`. Updates `activeTabIndex`.
- **Parameters:** `index` — integer tab index.
- **Returns:** void

#### `updateTabTitle(index, title, faviconUrl)`
Updates the title text of the tab at `index`. If `faviconUrl` is provided, inserts or updates a `.tab-favicon` `<img>` element with a fallback to `setFaviconFallback`.
- **Parameters:** `index` — integer tab index; `title` — new title string; `faviconUrl` — favicon URL or falsy.
- **Returns:** void

#### `setFaviconFallback(el, url)`
Replaces an `<img>` favicon element with a `.tab-favicon.default` `<div>` showing the first letter of the hostname in uppercase, or `◉` if the URL cannot be parsed.
- **Parameters:** `el` — the existing `<img>` element; `url` — the page URL to extract the first letter from.
- **Returns:** void

#### `updateTabWidths()`
Calculates the ideal tab width by dividing available bar space among unpinned tabs, clamped to 80–240 px. Pinned tabs are fixed at 36 px. Enables horizontal scrolling if unpinned tabs would be narrower than the minimum.
- **Parameters:** none (reads `tabs.size` and live DOM metrics)
- **Returns:** void

#### `updateScrollShadows()`
Adds or removes the `.scrollable-left` and `.scrollable-right` CSS classes on `tabBar` to indicate whether the tabs strip can be scrolled in either direction.
- **Parameters:** none
- **Returns:** void

#### `getDragAfterElement(container, x)`
Finds the tab button that a dragged tab should be inserted before, based on the horizontal cursor position `x`.
- **Parameters:** `container` — the `tabsContainer` DOM element; `x` — cursor x position in client coordinates.
- **Returns:** The DOM element to insert before, or `undefined` if the dragged tab should go at the end.

#### `initFocusModeAndPomodoro()`
Sets up the entire Focus Mode and Pomodoro timer subsystem. Reads Pomodoro durations from `_settings`, manages a `pom` state object, drives the countdown with `setInterval`, updates the pill and overlay UIs, handles phase transitions (focus → break → focus), and wires all button click events.
- **Parameters:** none
- **Returns:** void

(Internal Pomodoro helpers defined inside `initFocusModeAndPomodoro`:)

- **`pomShowPill()`** — Makes the Pomodoro pill visible and adds `pomodoro-active` to the utility bar.
- **`pomHidePill()`** — Hides the pill and removes `pomodoro-active`.
- **`pomUpdateUI()`** — Redraws the pill timer ring, phase label, start/pause button text, and session dots.
- **`pomSetFocusActive(active)`** — Async. Syncs focus mode state with `window.focusMode.toggle()` if needed and updates `focusBtn` styling.
- **`pomAdvancePhase()`** — Async. Increments the session counter, switches phase between focus and break, sets the next phase duration, and re-activates or de-activates focus mode.
- **`pomTick()`** — Called every second. Increments `pom.elapsed`; when the phase time is exhausted, calls `pomAdvancePhase`.
- **`pomOpenOverlay()`** / **`pomCloseOverlay()`** — Shows or hides the Pomodoro detail overlay and notifies `window.focusMode`.

#### `initBrunoAndMenu()`
Wires the Bruno toggle button (`#bruno-btn`) to `window.bruno.open()` / `window.bruno.close()` and the hamburger menu button to `window.menu.open()`, tracking state in a local `brunoOpen` boolean and the shared `menuOpen` variable.
- **Parameters:** none
- **Returns:** void

---

## Key Variables

| Name | Type | Purpose |
|---|---|---|
| `_settings` | `object` | Loaded at startup from `window.northstarSettings.get()`; holds all persisted user preferences used by the renderer. |
| `tabs` | `Map<number, HTMLElement>` | Maps tab index → the `.tab-button` div element for that tab. |
| `tabUrls` | `Map<number, string>` | Maps tab index → the current URL of that tab. |
| `activeTabIndex` | `number` | The index of the currently visible/active tab. |
| `menuOpen` | `boolean` | Tracks whether the hamburger menu WebContentsView is currently open; used to forward global click coordinates. |
| `currentTabUrl` | `string` | The URL of the active tab; used by the bookmark button and address bar. |
| `currentTabTitle` | `string` | The title of the active tab; pre-fills the bookmark prompt. |
| `searchBar` | `HTMLInputElement` | The address/search bar input element (`#searchBar`). |
| `backBtn` / `forwardBtn` / `reloadBtn` | `HTMLButtonElement` | Navigation control buttons. |
| `menuBtn` / `addBtn` | `HTMLButtonElement` | The hamburger menu and new-tab + buttons. |
| `tabBar` / `tabsContainer` | `HTMLElement` | The tab bar wrapper and the scrollable tabs inner container. |
| `bookmarkBtn` / `bookmarkBar` / `bookmarkBarItems` | `HTMLElement` | The ★ button, the bookmark bar strip, and the container for rendered bar items. |
| `bookmarkBarVisible` | `boolean` | Whether the bookmark bar is currently shown; persisted to `northstarSettings`. |
| `hasBookmarks` | `boolean` | True when the bookmark list is non-empty; determines whether the bar renders at all. |
| `_renamingFolderId` | `string\|null` | The id of the folder currently being renamed inline in the bar; blocks `refreshBookmarkBar` during a rename. |
| `_refreshSeq` | `number` | Monotonically-increasing counter; used to discard stale `refreshBookmarkBar` responses. |
| `_openDropdownId` | `string\|null` | The id of the anchor whose overflow dropdown is currently open. |
| `_dropdownCleanup` | `function\|null` | Removes the global mousedown listener registered when a dropdown opens. |
| `_dragSrcId` / `_dragSrcFolderId` | `string\|null` | The id of the item/folder being dragged on the bookmark bar. |
| `_bmDragActive` | `boolean` | True while a bookmark drag is in progress; used to suppress unrelated dragover events. |
| `_externDragId` / `_externLastTarget` | `string\|null, HTMLElement\|null` | State for cross-WebContentsView drags originating in the FolderDropdown view. |
| `_springTimer` / `_springFolderId` / `_springOpen` | `number\|null, string\|null, boolean` | Spring-load state: timer handle, which folder is pending open, and whether it has already opened. |
| `currentSuggestions` | `Array` | The last rendered suggestion list, used for keyboard navigation. |
| `activeSuggestionIndex` | `number` | Currently highlighted row index in `currentSuggestions` (-1 = none). |
| `overlayPointerDown` | `boolean` | Brief flag set when the user presses down inside the suggestion overlay, preventing blur from dismissing it. |
| `_userTyping` | `boolean` | True after the user edits the address bar; prevents suggestion re-renders triggered by programmatic value changes. |
| `FOLDER_SVG` | `string` | Inline SVG markup for the Material Design folder icon, shared by bar and dropdown item builders. |
| `pom` | `object` | Pomodoro timer state: `phase`, `running`, `elapsed`, `total`, `sessionsDone`, `timer`, `shown`. |
