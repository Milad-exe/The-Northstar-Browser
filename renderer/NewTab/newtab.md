# renderer/NewTab/newtab.js

## Purpose

Renderer script for the home / new-tab page. Displays a live clock, a
time-of-day greeting, today's date, and a search box. The clock and greeting
update once per minute (aligned to the top of the minute).

The page makes **no network requests of its own** — no weather, no
geolocation, no external fonts. It relies on the theme's system-font fallback
and never phones home.

---

## Module-level Constants

| Constant | Type | Purpose |
|---|---|---|
| `DAYS` | `string[]` | Uppercase weekday names, indexed by `Date.getDay()` |
| `MONTHS` | `string[]` | Uppercase month names, indexed by `Date.getMonth()` |

---

## Functions

### `greetingForHour(hour)`
Returns the greeting for the given hour: `Good night` (0–4, 22–23),
`Good morning` (5–11), `Good afternoon` (12–17), `Good evening` (18–21).
- **`hour`** — `number` — current hour (0–23)
- **Returns** `string`

### `pad(n)`
Zero-pads a number to two digits.

### `tick()`
Reads the current time and updates `#time-display` (`HH:MM`),
`#greeting-text`, and `#date-display` (`DAY, MONTH DATE`).

### `resolveQuery(raw)`
Turns the search box value into a destination URL, mirroring the omnibox:
- starts with `http(s)://` → used as-is
- contains `.` and no spaces → prepended with `https://`
- otherwise → `https://www.google.com/search?q=...`
- **Returns** `string | null` (null for empty input)

---

## Initialization (`DOMContentLoaded`)

1. Calls `tick()` immediately, then schedules it aligned to the next minute
   boundary and every 60 s thereafter.
2. Wires the `#search-form` submit handler → `resolveQuery()` →
   `window.location.href`.
3. Registers a `window.electronAPI.windowClick` forwarder so clicks on the
   page dismiss any open chrome overlay (menu, prompts).
