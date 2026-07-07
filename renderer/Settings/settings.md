# renderer/Settings/settings.js

## Purpose

Renderer script for the Settings page tab. Loads current settings from the main process on page load and provides UI controls for all configurable options: startup behaviour, search engine, theme, bookmark bar, Pomodoro timer durations, history management, and Google account integration. Each setting is persisted immediately on change via `window.northstarSettings.set`.

---

## Key Variables

| Variable | Type | Purpose |
|---|---|---|
| `settings` | `object` | Loaded settings snapshot from `window.northstarSettings.get()` |
| `toastTimer` | `number\|null` | Timeout ID for auto-dismissing the toast notification |

---

## Functions

### `showToast(msg)` *(local)*
Displays a brief toast notification by adding the `show` class to `#toast` for 2.2 seconds.
- **`msg`** — `string` — message to display

### `save(key, value)` *(local, async)*
Calls `window.northstarSettings.set(key, value)` and catches errors silently.

---

## Settings Sections

### Sidebar navigation
Each `.nav-item` shows/hides the matching `.section` on click. Managed via `data-section` attribute.

### General — On startup
Radio buttons (`input[name="startup"]`). Maps `'restore'` → `persistAllTabs: true`, `'new-tab'` → `persistAllTabs: false`.

### General — Search engine
`#search-engine` select. Saves `searchEngine` setting on change.

### Appearance — Theme
`#theme-select` select. Saves `theme` on change. The main process broadcasts `theme-changed` to all views.

### Bookmark bar
Toggle control for `bookmarkBarVisible`.

### Pomodoro timer
Numeric inputs for `pomWork`, `pomShortBreak`, `pomLongBreak`, `pomSessions`.

### History
"Clear History" button calls `window.northstarSettings.clearHistory()` and shows a confirmation toast.

### Google account
"Sign in with Google" button calls `window.northstarSettings.loginGoogle(clientId, clientSecret)` with user-supplied credentials and shows the result.
