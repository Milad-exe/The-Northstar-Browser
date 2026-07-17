# src/renderer/History/history.ts

## Purpose

Renderer script for the History page tab. Loads the full browsing history from the main process on page load and renders each entry as a clickable row with title, URL, timestamp, and a remove button. Clicking an entry navigates the active tab to that URL.

---

## Key Variables

| Variable | Type | Purpose |
|---|---|---|
| `containerDiv` | `HTMLElement` | `#container` — scrollable list that holds all history entry elements |

---

## Functions

### `createHistoryEntry(container, entry)`
Creates and appends a history row to `container`.

- **`container`** — `HTMLElement` — the container to append to
- **`entry`** — `{ url, title, timestamp }` — a single history entry object

Each row contains:
- **`.history-content`** — clickable area with title and URL; calls `window.electronAPI.navigateActiveTab(entry.url)` on click
- **`.history-timestamp`** — formatted date and time (`toLocaleDateString` + `toLocaleTimeString`)
- **`.history-remove-btn`** — calls `window.browserHistory.remove(entry.url, entry.timestamp)` and removes the row on success

---

## Initialization

On `DOMContentLoaded`:
1. Registers a document-level click handler that calls `window.menu?.close()` (closes the hamburger menu if open)
2. Calls `window.browserHistory.get()` to load history
3. Calls `createHistoryEntry` for each entry, or shows "No browsing history found" if the list is empty
4. Shows an error message if the fetch fails
