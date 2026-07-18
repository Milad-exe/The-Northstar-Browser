# src/renderer/Bookmarks/bookmarks.ts

## Purpose

Renderer script for the Bookmarks page tab. Loads all bookmarks from the main process, renders them as a flat list of clickable rows, and re-renders whenever bookmarks change. Each entry shows a favicon, title, URL, and a remove button. Right-clicking a row triggers the native bookmark context menu.

---

## Key Variables

| Variable | Type | Purpose |
|---|---|---|
| `container` | `HTMLElement` | `#container` — the scrollable list element |

---

## Functions

### `load()` *(async, local)*
Clears the container, fetches all bookmarks via `window.browserBookmarks.getAll()`, and renders them. If the list is empty, shows a "No bookmarks yet" message.
- **Returns** `Promise<void>`

---

## Event Handlers

### Row click
Calls `window.electronAPI.navigateActiveTab(entry.url)` to load the bookmarked URL in the active tab.

### Remove button click
Calls `window.browserBookmarks.remove(entry.url)`. If no rows remain, calls `load()` to show the empty state.

### Row contextmenu
Calls `window.browserBookmarks.showContextMenu(entry.url)` to trigger the native bookmark context menu from the main process.

### `window.browserBookmarks.onChanged`
Registered on load — re-calls `load()` whenever any bookmark is added, removed, or updated from any view.
