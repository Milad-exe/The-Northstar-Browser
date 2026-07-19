# src/renderer/FindDialog/find.ts

## Purpose

Renderer script for the floating find-in-page dialog. Handles user input (text, keyboard shortcuts, button clicks) and relays commands to the main process via the `window.findAPI` bridge exposed by `find-preload.ts`. Displays a match counter updated by the main process.

---

## Key Variables

| Variable | Type | Purpose |
|---|---|---|
| `findInput` | `HTMLElement` | `#find-input` — the search text input |
| `prevBtn` | `HTMLElement` | `#prev-btn` — navigate to previous match |
| `nextBtn` | `HTMLElement` | `#next-btn` — navigate to next match |
| `closeBtn` | `HTMLElement` | `#close-btn` — close the dialog |
| `matchCounter` | `HTMLElement` | `#match-counter` — shows "N of M" or "No matches" |
| `currentMatchIndex` | `number` | Current match ordinal (1-based) |
| `totalMatches` | `number` | Total number of matches |
| `searchTimeout` | `number\|null` | Debounce timer ID — delays search by 300 ms after last keystroke |

---

## Functions

### `findNext()`
Calls `window.findAPI.findNext()` if the input is non-empty.

### `findPrevious()`
Calls `window.findAPI.findPrevious()` if the input is non-empty.

### `closeDialog()`
Cancels any pending search timeout and calls `window.findAPI.close()`.

### `updateMatchCounter(current, total)`
Updates `matchCounter` text and enables/disables the prev/next buttons.
- **`current`** — `number` — active match index
- **`total`** — `number` — total match count

---

## Event Handlers

| Event | Element | Behaviour |
|---|---|---|
| `input` | `findInput` | Debounced 300 ms call to `window.findAPI.search(term)`; clears counter if empty |
| `keydown` (Enter) | `findInput` | Flushes debounce, calls `search`, then `findNext` or `findPrevious` (if Shift+Enter) after 50 ms |
| `keydown` (Escape) | `findInput` | Calls `closeDialog()` |
| `click` | `prevBtn` | Calls `findPrevious()` |
| `click` | `nextBtn` | Calls `findNext()` |
| `click` | `closeBtn` | Calls `closeDialog()` |
| `find-matches-updated` | IPC | Calls `updateMatchCounter(current, total)` |
