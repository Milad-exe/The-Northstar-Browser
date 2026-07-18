# FolderDropdown

A cascading folder panel that floats above the browser chrome when the user clicks a folder in the bookmark bar. Implemented as a transparent Electron `WebContentsView` positioned by the main process and populated by `dropdown.ts` via IPC.

---

## File structure

```
src/renderer/FolderDropdown/
  index.html          — shell page: one <div id="container"> + script tag
  dropdown.ts         — all UI logic (this document describes it)
  styles.css          — panel / item / drag-state styles

src/preload/
  folder-dropdown-preload.ts   — contextBridge API between main and renderer

src/features/
  bookmarks.ts        — bookmark data store, mutated by IPC handlers in main.ts
```

---

## How it opens

1. The user clicks a folder item in the bookmark bar (`renderer/renderer.ts`).
2. The bar renderer sends `folder-dropdown-open` IPC with `{ id, title, children, x, y }`.
3. `main.ts` creates (or reuses) a `WebContentsView`, loads `index.html`, positions it below the clicked button, and adds it as a child of the `BrowserWindow`.
4. Once loaded, main sends `folder-dropdown-init` with the same data → `onInit()` in `dropdown.ts` renders the first panel.

The view is **transparent** (`backgroundColor: '#00000000'`). The visual panel is a `<div class="list">` rendered inside it; the surrounding transparent area absorbs mouse events that close the dropdown (handled in main via a click-outside check).

---

## Cascading panels

```
#container  (display: flex, row)
  .list[0]  — root folder
  .list[1]  — sub-folder opened from level 0
  .list[2]  — sub-sub-folder opened from level 1
  …
```

Two parallel arrays track the cascade:

| Array | Contents |
|---|---|
| `_panels[]` | The live `.list` DOM element at each depth |
| `_panelData[]` | `{ folderId, title, children }` snapshot at each depth |

### Opening / closing panels

| Function | What it does |
|---|---|
| `appendPanel(level, …)` | Push a new panel onto the end of both arrays and the DOM |
| `collapseFrom(level)` | Pop and remove all panels at depth ≥ `level` |
| `openSubPanel(level, …)` | `collapseFrom(level + 1)` then `appendPanel(level + 1, …)` |
| `rebuildPanel(level)` | Rebuild one panel's DOM in-place using `replaceWith` — does **not** affect adjacent panels |

`rebuildPanel` is called after every in-panel mutation (reorder, delete, create) to keep the view current without closing it.

### Sizing the WebContentsView

After every panel change `updateSize()` fires (inside a `requestAnimationFrame`). It measures the tallest panel, caps at `MAX_HEIGHT = 480px`, and sends the new `(width, height)` to main via `folderDropdown.updateBounds(w, h)`. Width = `panels.length × (PANEL_WIDTH + 4) + PANEL_GAP_PADDING`.

---

## IPC data flow

### Main → Renderer (incoming)

| IPC channel | Handler | Purpose |
|---|---|---|
| `folder-dropdown-init` | `onInit()` | Cold-start: clear all state, render root panel |
| `folder-dropdown-refresh-panel` | `onRefreshPanel({ folderId, children, renameId? })` | Hot-reload one panel without closing the dropdown; optionally starts inline rename |
| `folder-dropdown-start-rename` | `onStartRename({ id, title })` | Trigger inline rename on a visible item (used after Rename in context menu) |
| `theme-changed` | preload | Apply/remove `data-theme` attribute |

### Renderer → Main (outgoing)

| `window.folderDropdown.*` | IPC | Purpose |
|---|---|---|
| `navigate(url)` | `folder-dropdown-navigate` | Load URL in the current tab |
| `openNewTab(url)` | `folder-dropdown-new-tab` | Open URL in a new background tab |
| `close()` | `folder-dropdown-close` | Destroy the WebContentsView |
| `showCtxMenu(item)` | `folder-dropdown-ctx-menu` | Show OS context menu scoped to this item / folder |
| `updateBounds(w, h)` | `folder-dropdown-update-bounds` | Resize the WebContentsView to fit content |
| `raise()` | `folder-dropdown-raise` | Re-insert view as last child (topmost z-order) |
| `dragStart(id, folderId)` | `folder-dropdown-drag-start` | Tell main a drag is in flight (starts cursor-polling) |
| `dragEnd()` | `folder-dropdown-drag-end` | Tell main drag finished (stop cursor-polling, execute move) |
| `updateById(id, updates)` | `bookmarks-update-by-id` (invoke) | Rename or update a single bookmark/folder |
| `reorderInFolder(folderId, ids)` | `bookmarks-reorder-in-folder` (invoke) | Persist a new item order inside a folder |
| `moveIntoFolder(itemId, folderId, beforeId)` | `bookmarks-move-into-folder` (invoke) | Move an item into a folder, optionally before a specific sibling |
| `moveOutOfFolder(itemId, folderId)` | `bookmarks-move-out-of-folder` (invoke) | Move an item out of a folder to the bar root |

---

## Item types

Each entry in a folder's `children` array has a `type` field:

| `type` | Rendered as | Behaviour |
|---|---|---|
| `bookmark` | Favicon + label | Left-click navigates; Cmd/Ctrl-click or middle-click opens new tab |
| `folder` | SVG folder icon + label + `▶` | Hover → spring-open sub-panel; drag-over → spring-open after 600 ms |
| `divider` | 1 px horizontal rule | Not interactive; not draggable |

---

## Hover navigation

Two timers control sub-panel lifecycle during normal mouse navigation:

| Timer | Constant | Triggered by | Effect |
|---|---|---|---|
| `_hoverOpenTimer` | `HOVER_OPEN_DELAY = 200 ms` | `mouseenter` on a folder item | Opens sub-panel at `level + 1` |
| `_hoverCloseTimer` | `HOVER_CLOSE_DELAY = 300 ms` | `mouseleave` from a panel or folder item | `collapseFrom(level + 1)` |

The close timer is cancelled if the cursor enters the next panel before it fires, allowing smooth lateral movement through a cascade.

---

## Inline rename

Triggered either by the context menu ("Rename") or immediately after creating a new item (`renameId` in `onRefreshPanel`).

`startInlineRename(itemId, currentTitle)`:

1. Finds the `<button data-id="…">` across all open panels.
2. Hides the `.item-label` span and injects an `<input class="inline-rename-input">` in its place.
3. Installs capture-phase `mouseup`/`click` blockers on the button to prevent navigation while editing.
4. **Enter** / **blur** → `commit()`: trims value, calls `folderDropdown.updateById`, updates label text optimistically.
5. **Escape** → `cancel()`: removes input, restores label without saving.

The dropdown stays open throughout — no IPC `close()` is called.

---

## Drag and drop

### Within the dropdown

Items inside a folder can be reordered or moved into sibling sub-folders.

```
dragstart → sets _dragId, _dragFolderId; calls raise()
dragover  → shows drop indicator (drop-before or drag-into)
dragleave → removes indicator; cancels spring timer
drop      → dropReorder() or dropIntoFolder()
dragend   → cleanup
```

**Drop indicators** use CSS `box-shadow` (no layout shift):

| Class | Style | Meaning |
|---|---|---|
| `.drop-before` | `inset 0 2px 0 0 var(--accent)` | Insert above this item |
| `.drag-into` | `background + dashed outline` | Move into this folder |

For folder targets, `drag-into` is shown immediately but the sub-panel only opens after **`DRAG_SPRING_DELAY = 600 ms`** (spring-load behaviour), driven by `_dragSpringTimer`.

**`dropReorder`**: reads the current item order from the DOM, splices `srcId` to just before `targetId`, calls `reorderInFolder`, then updates `_panelData` and calls `rebuildPanel`.

**`dropIntoFolder`**: calls `moveIntoFolder(srcId, folderEntry.id, null)`, removes `srcId` from the current panel's `_panelData`, rebuilds the panel.

### Drag out to the bookmark bar

When an item is dragged out of the dropdown to the bookmark bar (a different `WebContentsView`), HTML5 drag events no longer fire across the boundary. The bar renderer uses cursor-position polling instead.

The handshake:

1. `dragleave` fires on the `document` with `relatedTarget === null` (or cursor at a viewport edge) → `_leftDropdown = true`; `dragStart(id, folderId)` IPC starts polling; `close()` hides the view.
2. `dragend` fires on the button → sees `_leftDropdown === true` → calls `dragEnd()` IPC → main stops polling and tells the bar renderer to execute the move.

**Why `_dragId` is kept alive across `dragleave`**: `dragleave` only sets `_leftDropdown` and calls `close()`; it intentionally does **not** clear `_dragId`. The subsequent `dragend` needs `_dragId` to call `dragEnd()` IPC. Clearing it early would silently drop the operation.

### Z-order during drag

Electron's drag system can demote a `WebContentsView` behind the active tab view. On every `dragstart` `dropdown.ts` calls `raise()`, which sends `folder-dropdown-raise` IPC. Main responds with:

```js
win.contentView.removeChildView(view);
win.contentView.addChildView(view);   // re-inserts as last child = topmost
```

### `pointer-events: none` on child elements

All non-interactive children of `.item` (`.item-label`, `.folder-icon-left`, `.submenu-arrow`, `img`) have `pointer-events: none`. Without this, mouse events bubble up from child elements causing spurious `dragleave`/`dragenter` pairs that clear drag visuals prematurely.

---

## Context menu

Right-clicking sends `showCtxMenu(item)` IPC to main. The `item` payload varies:

| `type` | When | Key fields |
|---|---|---|
| `bookmark` | Right-click on a bookmark | `id`, `url`, `title`, `parentFolderId` |
| `folder` | Right-click on a folder item | `id`, `title`, `parentFolderId` |
| `divider` | Right-click on a divider | `id`, `parentFolderId` |
| `folder-bg` | Right-click on empty panel area | `id` (= the folder itself), `parentFolderId` |

`parentFolderId` lets `showFolderDropdownContextMenu` in `main.ts` scope all create/delete/rename operations to the correct folder without having to infer it.

After any mutation main calls `refreshPanel(folderId)` which sends `folder-dropdown-refresh-panel` — the dropdown stays open and only the affected panel rebuilds.

---

## State summary

| Variable | Type | Purpose |
|---|---|---|
| `_panels` | `Element[]` | Live `.list` DOM nodes indexed by depth |
| `_panelData` | `Object[]` | `{ folderId, title, children }` snapshots by depth |
| `_hoverOpenTimer` | `number\|null` | Pending sub-panel open on mouse hover |
| `_hoverCloseTimer` | `number\|null` | Pending cascade collapse on mouse leave |
| `_dragId` | `string\|null` | ID of the item being dragged |
| `_dragFolderId` | `string\|null` | Folder that owns the dragged item |
| `_dragSpringTimer` | `number\|null` | Pending spring-open during drag-over-folder |
| `_insideList` | `boolean` | True once drag has entered a `.list` panel |
| `_leftDropdown` | `boolean` | True once drag exited the WebContentsView boundary |
| `_renamingId` | `string\|null` | ID of the item currently in inline-rename mode |

---

## Constants

| Constant | Value | Role |
|---|---|---|
| `HOVER_OPEN_DELAY` | 200 ms | Hover-to-open latency for sub-panels |
| `HOVER_CLOSE_DELAY` | 300 ms | Grace period before collapsing sub-panels |
| `DRAG_SPRING_DELAY` | 600 ms | Time before a dragged item spring-opens a folder |
| `MAX_HEIGHT` | 480 px | Tallest a panel can grow before clipping |
| `PANEL_WIDTH` | 220 px | Width of one panel column |
| `PANEL_GAP_PADDING` | 28 px | Extra width reserved for panel gaps + shadow |

---

## dropdown.ts

### Purpose

Renderer script for the cascading folder dropdown `WebContentsView`. Displays a horizontally expanding series of panels — one per folder depth level — that appear when the user clicks a folder in the bookmark bar. Supports hover navigation between nested folders, drag-and-drop reordering within a panel, drag-and-drop into sub-folders, inline item renaming, and cross-view dragging (item dragged out of the dropdown back to the bookmark bar).

### Module-level Constants

| Constant | Type | Purpose |
|---|---|---|
| `FOLDER_SVG` | `string` | SVG markup for the folder icon used on folder items |
| `HOVER_OPEN_DELAY` | `number` | ms before hovering a folder opens its sub-panel (`200`) |
| `HOVER_CLOSE_DELAY` | `number` | ms before sub-panels collapse when the cursor leaves (`300`) |
| `DRAG_SPRING_DELAY` | `number` | ms a dragged item must hover over a folder to spring-open it (`600`) |
| `MAX_HEIGHT` | `number` | Max panel height in pixels before clipping (`480`) |
| `PANEL_WIDTH` | `number` | Width of each panel column in pixels (`220`) |
| `PANEL_GAP_PADDING` | `number` | Extra horizontal padding reserved in the view (`28`) |

### Module-level State Variables

| Variable | Type | Purpose |
|---|---|---|
| `panels` | `Array<HTMLElement>` | DOM elements for each open depth level |
| `panelData` | `Array<{folderId, title, children}>` | Data mirror of each open panel |
| `hoverOpenTimer` | `number\|null` | Timeout to open a sub-panel on hover |
| `hoverCloseTimer` | `number\|null` | Timeout to collapse sub-panels on leave |
| `dragId` | `string\|null` | ID of the item currently being dragged |
| `dragFolderId` | `string\|null` | ID of the folder that owns the dragged item |
| `dragSpringTimer` | `number\|null` | Timeout to spring-open a folder during a drag |
| `insideList` | `boolean` | `true` once a drag enters the list area |
| `leftDropdown` | `boolean` | `true` once a drag exits the WebContentsView boundary |
| `renamingId` | `string\|null` | ID of the item currently in inline-rename mode |

### IPC Handlers

#### `window.folderDropdown.onInit({ children, folderId, title })`
Resets all state and renders the root panel for the opened folder.

#### `window.folderDropdown.onRefreshPanel({ folderId, children, renameId? })`
Rebuilds a single panel in-place (after add/delete/reorder). Collapses deeper panels. If `renameId` is provided, starts inline rename on that item.

#### `window.folderDropdown.onStartRename({ id, title })`
Starts inline rename for the visible item with the given ID.

### Panel Management Functions

#### `collapseFrom(level)`
Removes all panels at depth ≥ `level` from the DOM and `panels`/`panelData`. Calls `updateSize()`.

#### `appendPanel(level, children, folderId, title)`
Appends a new panel at `level` (collapsing any panels deeper than `level` first).

#### `openSubPanel(level, children, folderId, title)`
Collapses from `level + 1` then appends a new panel at `level + 1`.

#### `rebuildPanel(level)`
Replaces the existing DOM panel at `level` in-place from `panelData[level]`. Does not touch adjacent levels.

#### `updateSize()`
Computes the required width and height for the view and sends them to the main process via `window.folderDropdown.updateBounds(w, h)`.

### Inline Rename

#### `startInlineRename(itemId, currentTitle)`
Finds the item's button across all open panels, replaces its label with a text input, and blocks click propagation while editing. On Enter or blur: commits the rename via `window.folderDropdown.updateById`. On Escape: restores the original label.

### Drag Helpers

#### `clearDragVisuals()`
Removes `drag-into` and `drop-before` CSS classes from all items.

#### `clearDragSpringTimer()`
Clears `dragSpringTimer` if set.

#### `resetDragState()`
Clears all drag state variables.

### List / Item Builders

#### `buildList(children, folderId, folderTitle, level)`
Creates a `.list` panel element, populates it with item elements, attaches panel-level event listeners, and returns it.

#### `attachListEvents(list, folderId, folderTitle, level)`
Attaches context-menu, hover enter/leave, and drag-over/drop handlers to a panel.

#### `buildItem(entry, folderId, level, list)`
Creates a single row element.

#### `buildFolderItem(btn, entry, level)`
Adds folder icon, label, and arrow to `btn`. Attaches mouseenter/leave handlers for the hover-open/close timers.

#### `buildBookmarkItem(btn, entry)`
Adds favicon, label to `btn`. Attaches mouseup and auxclick handlers.

#### `attachItemContextMenu(btn, entry, folderId)`
Attaches a `contextmenu` handler that calls `window.folderDropdown.showCtxMenu` with item metadata.

#### `attachItemDragHandlers(btn, entry, folderId, level, list)`
Attaches the full drag lifecycle: `dragstart`, `dragend`, `dragover`, `dragleave`, `drop`.

#### `dropIntoFolder(srcId, folderEntry, level)` *(async)*
Calls `window.folderDropdown.moveIntoFolder` and rebuilds the current panel.

#### `dropReorder(srcId, targetId, folderId, level, list)` *(async)*
Reorders `srcId` to before `targetId` within the panel using `window.folderDropdown.reorderInFolder`, then rebuilds the panel.

### Global Drag-Leave Detection

A `document.dragleave` listener detects when the cursor exits the WebContentsView boundary (by checking `relatedTarget === null` or edge coordinates). When this happens: sets `leftDropdown = true`, calls `window.folderDropdown.dragStart` (which starts the main-process cursor-polling loop for the bookmark bar), and closes the dropdown.
