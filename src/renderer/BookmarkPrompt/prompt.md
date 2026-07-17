# src/renderer/BookmarkPrompt/prompt.ts

## Purpose

Renderer script for the bookmark prompt overlay (`WebContentsView`). Handles three operating modes received via the `init-prompt` IPC event: adding a bookmark, editing an existing bookmark, creating a new folder, and renaming an existing folder. All mutations are performed via the `window.electronAPI` bridge exposed by `bookmark-prompt-preload.ts`.

---

## Event Handler

### `window.electronAPI.onInitPrompt(event, { url, title, hasObj, id, mode })`

The single entry point. Receives the overlay's initial data from the main process and configures the UI accordingly.

| Parameter | Type | Purpose |
|---|---|---|
| `url` | `string` | URL of the page being bookmarked |
| `title` | `string` | Current page title |
| `hasObj` | `boolean` | `true` if a bookmark already exists for this URL (edit mode) |
| `id` | `string\|null` | Bookmark or folder ID (for update/delete by ID) |
| `mode` | `string\|null` | `'new-folder'` or `'folder-rename'`; `null` for bookmark add/edit |

---

## DOM References

| Element ID | Purpose |
|---|---|
| `#prompt-heading` | Title text shown at the top of the prompt |
| `#bookmark-title` | Text input for the bookmark/folder title |
| `#prompt-actions` | Container where action buttons are dynamically rendered |
| `.field label` | Label text above the input |

---

## Modes

### `'new-folder'`
Renders a "Create" button. On confirm, calls `window.electronAPI.addFolder(name)` then closes.

### `'folder-rename'`
Renders a "Save" button. On confirm, calls `window.electronAPI.updateById(id, { title })` if the name changed.

### Bookmark add (default, `hasObj === false`)
Renders "Cancel" / "Save". On save, calls `window.electronAPI.addBookmark(url, title)`.

### Bookmark edit (`hasObj === true`)
Renders "Remove" / "Done". Remove calls `removeById(id)` or `removeBookmark(url)`. Done calls `updateById` or `updateTitle` if the title changed.

All modes support Enter to confirm and Escape to cancel.
