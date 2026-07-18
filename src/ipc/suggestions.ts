/**
 * IPC handlers — URL / search suggestion overlay.
 *
 * The overlay is a transparent WebContentsView positioned below the address bar.
 * It is created ONCE per window (pre-warmed at startup via 'suggestions-warm')
 * and then only shown/hidden. Recreating it on each open ran loadFile while the
 * user was typing, which stole Electron-level focus from the address bar and
 * swallowed the next key press.
 */

import path from 'path';
import { resolveAppFile } from '../app-paths';
import { WebContentsView } from 'electron';
const ITEM_HEIGHT = 44;   // roomier Firefox-style rows (min-height 40 + margin)
const LIST_CHROME = 20;   // body padding (8) + card padding (10) + border (2)
// Fits the full capped list (≤8 rows: base + ≤4 links + ≤3 search) without
// scrolling. 8 * 44 + 20 = 372; the caps live in renderer.js updateSuggestions.
const MAX_HEIGHT  = 380;

/** Create (once) and load the overlay view for a window. Resolves when loaded. */
async function ensureView(wd) {
    if (wd.suggestions) {
        if (wd.suggestionsReady) await wd.suggestionsReady;
        return wd.suggestions;
    }

    const view = new WebContentsView({
        webPreferences: {
            preload: path.join(__dirname, '../preload/suggestions-preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    view.setBackgroundColor('#00000000');
    view.setVisible(false);
    wd.suggestions = view;
    wd.window.contentView.addChildView(view);

    // Notify chrome renderer so it can restore focus to the address bar
    try { wd.window.webContents.send('suggestions-created'); } catch {}

    view.webContents.loadFile(resolveAppFile('renderer/Suggestions/index.html'));
    wd.suggestionsReady = new Promise<void>(res => view.webContents.once('did-finish-load', () => res()));
    await wd.suggestionsReady;

    // loadFile steals Electron-level focus; restore it to keep typing in the URL bar
    try { wd.window.webContents.focus(); } catch {}
    return view;
}

function hideView(wd) {
    if (!wd.suggestions) return false;
    try {
        wd.suggestions.setVisible(false);
        return true;
    } catch {
        return false;
    }
}

function register(ipcMain, { wm }) {

    // Pre-create the overlay while the window is idle so the first typing
    // session never pays the loadFile focus-steal.
    ipcMain.handle('suggestions-warm', async (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd) return false;
        try { await ensureView(wd); return true; }
        catch (err) { console.error('suggestions-warm:', err); return false; }
    });

    ipcMain.handle('suggestions-open', async (_e, payload) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd) return false;

        const { bounds, items = [], activeIndex = -1, query = '', engine = '' } = payload || {};
        try {
            const view = await ensureView(wd);
            view.setBounds(itemBounds(bounds, items.length));
            // Raise above the active tab's WebContentsView — the overlay is
            // created once and can otherwise sit behind a tab that was added
            // after it, making the suggestions invisible.
            try {
                wd.window.contentView.removeChildView(view);
                wd.window.contentView.addChildView(view);
            } catch {}
            view.setVisible(true);
            view.webContents.send('suggestions-data', { items, activeIndex, query, engine });
            return true;
        } catch (err) {
            console.error('suggestions-open:', err);
            return false;
        }
    });

    ipcMain.handle('suggestions-update', async (_e, payload) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd || !wd.suggestions) return false;

        const { bounds, items = [], activeIndex = -1, query = '', engine = '' } = payload || {};
        try {
            if (bounds && typeof bounds.left === 'number') {
                wd.suggestions.setBounds(itemBounds(bounds, items.length));
            }
            wd.suggestions.webContents.send('suggestions-data', { items, activeIndex, query, engine });
            return true;
        } catch (err) {
            console.error('suggestions-update:', err);
            return false;
        }
    });

    ipcMain.handle('suggestions-close', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd) return false;
        return hideView(wd);
    });

    ipcMain.handle('suggestions-select', (_e, item) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (!wd) return false;
        try {
            wd.window.webContents.send('suggestion-selected', item);
            hideView(wd);
            return true;
        } catch (err) {
            console.error('suggestions-select:', err);
            return false;
        }
    });

    // Pointer-down from the overlay: notify the owning chrome renderer so it
    // can suppress the hide-on-blur briefly while the click is processed.
    ipcMain.handle('suggestions-pointer-down', (_e) => {
        for (const w of wm.getAllWindows()) {
            if (w.suggestions?.webContents === _e.sender) {
                try { w.window.webContents.send('suggestions-pointer-down'); } catch {}
                break;
            }
        }
        return true;
    });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function itemBounds(bounds, count) {
    return {
        x:      Math.max(0, Math.floor(bounds.left)),
        y:      Math.max(0, Math.floor(bounds.top)),
        width:  Math.floor(bounds.width),
        height: Math.min(MAX_HEIGHT, Math.max(1, count) * ITEM_HEIGHT + LIST_CHROME),
    };
}

export { register };