/**
 * Download manager — Firefox-style behavior.
 *
 * Files save straight into the OS Downloads folder with a collision-free name
 * (no save dialog), progress is tracked per item, and the UI (toolbar button +
 * panel overlay, see ipc/downloads.js) is fed through the onChanged callback.
 *
 * Items live in memory for the session; attach() is called once per session
 * (default + private) from main.js.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { app, shell } = require('electron');
class DownloadManager {
    items; // id → plain record (safe to send over IPC)
    handles; // id → live Electron DownloadItem
    listeners; // subscribers to download-list changes
    nextId;
    constructor() {
        this.items = new Map(); // id → plain record (safe to send over IPC)
        this.handles = new Map(); // id → live Electron DownloadItem
        this.listeners = new Set();
        this.nextId = 1;
        this._promptNext = false; // one-shot: next download shows a Save-As dialog
    }
    /**
     * Download a URL and let the user choose where to save it via the native
     * "Save As" dialog, instead of the silent auto-save to Downloads. Used by
     * the "Save … As…" context-menu items.
     */
    saveAs(webContents, url) {
        if (!webContents || webContents.isDestroyed() || !url) return;
        this._promptNext = true;
        try { webContents.downloadURL(url); }
        catch { this._promptNext = false; }
    }
    /** Subscribe to item changes. fn(record|null) — null means "list changed, refetch". */
    onChanged(fn) { this.listeners.add(fn); }
    _emit(record) {
        for (const fn of this.listeners) {
            try {
                fn(record ? { ...record } : null);
            }
            catch { }
        }
    }
    /** Hook a session's downloads. Call once per session. */
    attach(session, { private: isPrivate = false } = {}) {
        session.on('will-download', (_event, item) => {
            const id = this.nextId++;
            const dir = app.getPath('downloads');
            const filename = item.getFilename() || 'download';
            const promptForPath = this._promptNext;
            this._promptNext = false;
            let savePath;
            if (promptForPath) {
                // "Save As…" — show the native save dialog. The real path isn't
                // known until the user confirms, so we refresh it from
                // item.getSavePath() on the first update / done event below.
                item.setSaveDialogOptions({ defaultPath: path.join(dir, filename) });
                savePath = path.join(dir, filename); // placeholder until confirmed
            }
            else {
                savePath = uniquePath(dir, filename);
                item.setSavePath(savePath);
            }
            const rec = {
                id,
                filename: path.basename(savePath),
                savePath,
                url: item.getURL(),
                totalBytes: item.getTotalBytes(),
                receivedBytes: 0,
                state: 'progressing', // progressing | completed | cancelled | interrupted
                paused: false,
                private: isPrivate,
                startTime: Date.now(),
            };
            this.items.set(id, rec);
            this.handles.set(id, item);
            this._emit(rec);
            const refreshPath = () => {
                const actual = item.getSavePath();
                if (actual && actual !== rec.savePath) {
                    rec.savePath = actual;
                    rec.filename = path.basename(actual);
                }
            };
            item.on('updated', (_e, state) => {
                refreshPath();
                rec.receivedBytes = item.getReceivedBytes();
                rec.totalBytes = item.getTotalBytes();
                rec.paused = item.isPaused();
                rec.state = state === 'interrupted' ? 'interrupted' : 'progressing';
                this._emit(rec);
            });
            item.once('done', (_e, state) => {
                refreshPath();
                rec.state = state; // completed | cancelled | interrupted
                rec.receivedBytes = item.getReceivedBytes();
                rec.paused = false;
                this.handles.delete(id);
                this._emit(rec);
            });
        });
    }
    getAll() {
        return Array.from(this.items.values())
            .sort((a, b) => b.startTime - a.startTime)
            .map(r => ({ ...r }));
    }
    hasActive() {
        for (const r of this.items.values()) {
            if (r.state === 'progressing')
                return true;
        }
        return false;
    }
    cancel(id) { try {
        this.handles.get(id)?.cancel();
    }
    catch { } }
    pause(id) { try {
        this.handles.get(id)?.pause();
    }
    catch { } }
    resume(id) { try {
        this.handles.get(id)?.resume();
    }
    catch { } }
    openFile(id) {
        const r = this.items.get(id);
        if (r?.state === 'completed') {
            try {
                shell.openPath(r.savePath);
            }
            catch { }
        }
    }
    showInFolder(id) {
        const r = this.items.get(id);
        if (r) {
            try {
                shell.showItemInFolder(r.savePath);
            }
            catch { }
        }
    }
    remove(id) {
        const r = this.items.get(id);
        if (!r || r.state === 'progressing')
            return;
        this.items.delete(id);
        this._emit(null);
    }
    clearFinished() {
        let changed = false;
        for (const [id, r] of this.items) {
            if (r.state !== 'progressing') {
                this.items.delete(id);
                changed = true;
            }
        }
        if (changed)
            this._emit(null);
    }
}
// ── Helpers ──────────────────────────────────────────────────────────────────
/** "report.pdf" → "report (1).pdf" until the name is free (Firefox behavior). */
function uniquePath(dir, filename) {
    const ext = path.extname(filename);
    const base = path.basename(filename, ext);
    let candidate = path.join(dir, filename);
    for (let n = 1; n < 1000; n++) {
        try {
            if (!fs.existsSync(candidate))
                break;
        }
        catch {
            break;
        }
        candidate = path.join(dir, `${base} (${n})${ext}`);
    }
    return candidate;
}

module.exports = new DownloadManager();