# Northstar

A productivity-focused web browser built with Electron. Northstar wraps Chromium
via Electron's `WebContentsView` API to provide multi-tab browsing, a
hierarchical bookmark bar, focus mode, reader mode, per-tab private sessions,
ad/tracker blocking, Chrome-extension support, and encrypted local storage — in
a single native window with a brutalist, deterministic UI.

The app is written in **TypeScript** (main process, preloads, and page scripts)
and styled with **Tailwind CSS v4** on top of a CSS-custom-property theme
system. Source lives in `src/`; the build emits a runnable mirror of it into
`app/`.

---

## Quick start

```bash
npm install
npm start            # build + run
npm run dev          # build + run with --dev
```

Day-to-day commands:

| Command | What it does |
|---|---|
| `npm run dev` | **Watch mode**: tsc + tailwind + asset watchers, Electron auto-restarts on main-process changes, and the UI live-reloads (internal pages reload, the chrome hot-swaps CSS) |
| `npm run build` | Full build: TypeScript → `app/`, static assets → `app/`, Tailwind → `app/renderer/styles/ui.css` |
| `npm run typecheck` | Type-check everything without emitting |
| `npm run smoke` | Build, boot the app, and health-check it over CDP (UI intact, extensions registered, zero uncaught errors) |
| `npm run dist` (`dist:mac` / `dist:win` / `dist:linux`) | Package with electron-builder |
| `npm run test:permissions` | Headless permission-system test harness |

Designing UI? Open `app/renderer/StyleGuide/index.html` in any browser — a live
style guide showing every theme token, type style, and component pattern, with
a theme switcher. Pair it with `npm run dev` for instant feedback.

---

## Project layout

```
src/                      ALL source code (TypeScript + HTML + CSS)
  main.ts                 Electron main-process entry point
  app-paths.ts            Resolves runtime files inside the built app/ tree
  features/               Main-process business logic (one module per feature)
  ipc/                    ipcMain handler modules, one per feature area
  preload/                contextBridge scripts (one per view type)
  renderer/               One folder per UI surface (chrome, overlays, pages)
    Browser/              Main chrome shell (tab bar, omnibox, bookmark bar)
    NewTab/, History/, Settings/, Bookmarks/, …
    styles/               Shared styling
      ui.css              Tailwind v4 entry — tokens + utilities (built)
      themes.css          The four palettes + private-mode palette (CSS vars)
      fonts.css           Self-hosted Manrope @font-face
    assets/               Fonts, images
  types/                  Ambient declarations (window.* bridges, DOM augments)

app/                      BUILD OUTPUT — never edit; mirrors src/ 1:1
tsconfig.main.json        TS project: main process + preloads (Node16/CommonJS)
tsconfig.renderer.json    TS project: page scripts (classic scripts + DOM lib)
scripts/copy-assets.js    Copies HTML/CSS/fonts/images from src/ → app/
```

**Why a mirrored `app/` tree?** Every `__dirname`-relative path in the code
(preload lookups, `../logo.png`, `../renderer/...`) keeps working unchanged
because the compiled layout is identical to the source layout. Files loaded by
app-root-relative path go through `resolveAppFile()` in `src/app-paths.ts`.

### Where things happen

| Layer | Runs in | Talks to |
|---|---|---|
| `src/features/` | Main process | Electron APIs, disk, sessions |
| `src/ipc/` | Main process | Receives `ipcRenderer` calls, delegates to features |
| `src/preload/` | Isolated preload context | Exposes typed `window.*` bridges to pages |
| `src/renderer/` | Chromium pages | Calls the bridges; renders the UI |

Deeper documentation lives next to the code:

- [`src/features/README.md`](src/features/README.md) — every feature module
- [`src/ipc/README.md`](src/ipc/README.md) — the IPC surface
- [`src/preload/README.md`](src/preload/README.md) — bridge scripts & security model
- [`src/renderer/renderer.md`](src/renderer/renderer.md) — the main chrome UI
- per-page notes: `src/renderer/<Page>/*.md`

---

## TypeScript setup

Two compiler projects share `tsconfig.base.json`:

- **`tsconfig.main.json`** — `main.ts`, `features/`, `ipc/`, `preload/`.
  Node16 module resolution, emits CommonJS into `app/`. The DOM lib is enabled
  because preloads and injected snippets execute in page context.
- **`tsconfig.renderer.json`** — `renderer/**/*.ts`. These compile as *classic
  scripts* (each page loads its script with a plain `<script src>` tag — no
  bundler), so every file is wrapped in an IIFE to keep its top-level names
  out of the shared global scope.

Shared ambient types in `src/types/`:

- `api.d.ts` — declares every `window.*` bridge exposed by the preloads
  (`window.electronAPI`, `window.tab`, `window.northstarSettings`, …). If you
  add or rename a bridge method in a preload, mirror it here.
- `dom-augment.d.ts` — pragmatic DOM augmentations from the JS→TS port; prefer
  concrete element types (`HTMLInputElement`) in new code.

The port kept `strict: false` to stay byte-for-byte faithful to the original
behavior. New code should still annotate deliberately — and tightening a
module's types is always a welcome refactor.

---

## Styling: Tailwind + the theme system

Styling has three levels, all flowing through
[`src/renderer/styles/ui.css`](src/renderer/styles/ui.css):

1. **Theme tokens** (`styles/themes.css`) — plain CSS custom properties
   (`--bg`, `--surface`, `--text-2`, …) defined per palette: Northstar (dark,
   default), Fathom (navy), Porcelain (light), Dune (cream), plus the lavender
   private-mode palette. Switching themes = setting `data-theme` on `<html>`;
   nothing rebuilds.

2. **Tailwind utilities** (built by `npm run build:css`) — the `@theme` block
   in `ui.css` maps the tokens into Tailwind, so markup can use theme-aware
   utilities: `bg-surface`, `text-secondary`, `border-subtle`, `hover:bg-hover`,
   `font-mono`, and friends. The stock Tailwind palette is disabled — you
   cannot drift off-palette with `bg-blue-500`. Preflight is also off; the
   pages carry their own resets. See `src/renderer/Error/index.html` for a
   page styled entirely with utilities.

3. **Component CSS** (`src/renderer/<Page>/styles.css`) — bespoke rules that
   utilities can't express (stateful classes toggled from TS, pseudo-elements,
   vibrancy `color-mix`). Each file is wrapped in `@layer components`, and
   `ui.css` declares the layer order, so **a utility class in the markup always
   overrides page CSS** — "add a class in HTML" behaves the way you expect.

Every page links two stylesheets, in this order:

```html
<link rel="stylesheet" href="../styles/ui.css">   <!-- tokens + utilities -->
<link rel="stylesheet" href="styles.css">          <!-- page components -->
```

---

## Main process in one paragraph

`src/main.ts` applies pre-ready Chromium flags, then on `app.whenReady()`
configures the default session (spell-check, ad blocking via
`features/ad-blocker.ts`, the privacy pipeline in `features/privacy.ts`,
download manager, permission prompts, Widevine), registers every `src/ipc/*`
module with a shared dependency bundle, and creates the first window through
`features/window-manager.ts`. Each window owns a `Tabs` instance
(`features/tabs.ts`) that manages one `WebContentsView` per tab, plus
`Shortcuts`, context menus, and a set of floating overlay views (menu,
suggestions, downloads panel, site info, …) tracked on the window's
`windowData` object.

### Window data object

Every `BrowserWindow` is tracked in `WindowManager.windows` as `windowData`:

```ts
{
  id:        number,
  window:    BrowserWindow,
  tabs:      Tabs,
  shortcuts: Shortcuts,
  // floating overlay views, created lazily:
  menu, suggestions, bookmarkPrompt, folderDropdown,
  downloadsPanel, passwordPrompt, siteInfoView, miniPlayer
}
```

---

## Data storage

All user data lives under `app.getPath('userData')` and is encrypted at rest
with AES-256-GCM (`src/features/encryption.ts`; master key in
`northstar/.key`, mode 0600):

| File | Contents |
|---|---|
| `northstar/settings.json` | App settings (theme, search engine, toggles…) |
| `northstar/tabs-state.json` | Serialized tab session |
| `bookmarks.json` | Bookmark tree |
| `browsing-history.json` | Browsing history (capped) |
| `passwords.dat` / `site-permissions.dat` | Credential store / per-origin permissions |

Legacy plaintext files are detected (`isEncrypted`) and re-encrypted on next
write.

---

## Conventions for contributors

- **Edit `src/`, never `app/`.** `app/` is disposable build output
  (git-ignored); `npm run build` regenerates it.
- **New page?** Create `src/renderer/MyPage/` with `index.html`, `mypage.ts`,
  and (only if needed) a `styles.css` wrapped in `@layer components`. Link
  `../styles/ui.css` first and prefer Tailwind utilities.
- **New IPC?** Handler in `src/ipc/<area>.ts`, exposed to the page through the
  narrowest preload bridge, and declared in `src/types/api.d.ts`.
- **Colors** come from the theme tokens — if a color isn't a token, it
  probably shouldn't exist. See `src/renderer/styles/themes.css`.
- Run `npm run typecheck` before committing; `npm start` to see it live.
