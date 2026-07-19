# src/renderer/Suggestions/suggestions.ts

## Purpose

Renderer script for the URL/search autocomplete overlay (`WebContentsView`). Renders a list of suggestion items sent from the main process. Each item shows a favicon, a label (title + URL for navigable items, query text for search actions), and a type badge. Clicking an item sends a select event back to the main process.

---

## Key Variables

| Variable | Type | Purpose |
|---|---|---|
| `listEl` | `HTMLElement` | `#list` — the container element for rendered suggestion rows |
| `current` | `{ items, activeIndex }` | Tracks the last-rendered item list and active highlight index |

---

## Functions

### `render(payload)`
Clears and re-renders the suggestion list.

- **`payload`** — `{ items, activeIndex }` — items to render and which one is highlighted

Each rendered row:
- Shows a favicon (`<img>`) with smart fallback: explicit `item.favicon`, Google favicon API for `http/https` URLs, or an SVG icon based on type (`search`, `globe`, `bookmark`, `history`)
- Shows a `.main-label` span containing either `"Title — url"` (two-part) or just the query text
- Shows a `.secondary` badge with the item type (`Switch`, `Search`, `Google`, `DDG`, `Bing`, `History`, `Bookmark`)
- On `mousedown`: calls `window.overlaySuggestions.pointerDown()` then `window.overlaySuggestions.select(item)`

---

## IPC

### `window.overlaySuggestions.onData(payload)`
Registered once on load. Calls `render(payload)` whenever the main process sends updated suggestion data.
