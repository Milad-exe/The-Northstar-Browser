# src/renderer/Menu/menu.ts

## Purpose

This is the renderer script for the hamburger menu popup WebContentsView. It runs inside a small overlay window that appears when the user clicks the menu button in the browser chrome. On load it reads the current settings to reflect the bookmark-bar toggle state, then wires click handlers for each menu item so they invoke the appropriate IPC call back to the main process. After each action the menu closes itself by calling `window.electronAPI.closeMenu()`.

---

## Functions / Methods

This file contains no named standalone functions. All logic is expressed as event handlers registered inside a single `DOMContentLoaded` callback.

### `close()` (inner async helper)
Called after every menu-item click to dismiss the popup.
- **Parameters:** none
- **Returns:** Promise\<void\> (errors are silently swallowed)

### Event handlers

| Element ID | Event | Behaviour |
|---|---|---|
| *(DOMContentLoaded)* | load | Calls `window.electronAPI.getSettings()`; if `settings.bookmarkBarVisible` is true, adds class `visible` to `#bookmark-bar-check` to show the checkmark indicator. |
| `#btn-new-tab` | click | Calls `window.electronAPI.addTab()`, then closes the menu. |
| `#btn-new-window` | click | Calls `window.electronAPI.newWindow()`, then closes the menu. |
| `#btn-history` | click | Calls `window.electronAPI.openHistoryTab()`, then closes the menu. |
| `#btn-bookmarks` | click | Calls `window.electronAPI.openBookmarksTab()`, then closes the menu. |
| `#btn-bookmark-bar` | click | Calls `window.electronAPI.toggleBookmarkBar()` (fire-and-forget), then closes the menu. |
| `#btn-settings` | click | Calls `window.electronAPI.openSettingsTab()`, then closes the menu. |

---

## Key Variables

| Name | Type | Purpose |
|---|---|---|
| `settings` | `object` | The persisted app settings object loaded from `window.electronAPI.getSettings()` at startup. Used only to initialise the bookmark-bar check indicator. |
