/**
 * Tabs — workspaces, folders and per-tab metadata (mixed into Tabs.prototype).
 *
 * A workspace IS a profile: the window keeps every workspace's tabs alive in
 * tabMap and only the active one is shown, so switching swaps the visible set
 * rather than reloading anything. Folders are tab groups WITHIN a workspace.
 * User-set labels/icons override whatever the page reports, and keep doing so
 * as it navigates.
 */
'use strict';
const log = require('../log');

module.exports = {
    // ── Workspaces (a workspace IS a profile, switched in place) ───────────────
    // The window keeps tabs of every workspace alive in tabMap; only the active
    // workspace's tabs are shown/counted. Switching swaps the visible set.
    tabsInWorkspace(id) {
        const key = String(id);
        return this.tabOrder.filter(i => this.tabMap.has(i) && (this.tabProfiles.get(i) || '1') === key);
    },
    // ── Folders (tab groups within a workspace) ────────────────────────────────
    foldersForWorkspace(id) {
        const key = String(id);
        return this.folders.filter(f => String(f.workspace) === key);
    },
    broadcastFolders() {
        try {
            const ws = this.profileId;
            const folders = this.foldersForWorkspace(ws).map(f => ({ ...f }));
            const ids = new Set(folders.map(f => f.id));
            const assignments = [...this.tabFolders.entries()].filter(([idx, fid]) => this.tabMap.has(idx) && ids.has(fid));
            this.mainWindow.webContents.send('folders-changed', { folders, assignments });
        }
        catch (e) { log.debug('organize', 'broadcastFolders', e); }
    },
    // Folders nest up to MAX_FOLDER_DEPTH levels, matching the reference.
    _folderDepth(id) {
        let d = 0, cur = this.folders.find(f => f.id === id);
        while (cur?.parent && d < 10) { cur = this.folders.find(f => f.id === cur.parent); d++; }
        return d;
    },
    createFolder(name, workspace, parent) {
        const id = 'f' + (this._folderSeq++);
        let pid = parent ? String(parent) : null;
        // Refuse to nest past the cap — the folder is created at the root instead.
        if (pid && this._folderDepth(pid) >= 4)
            pid = null;
        this.folders.push({ id, name: (name || 'New Folder').slice(0, 40), collapsed: false, workspace: String(workspace || this.profileId), ...(pid ? { parent: pid } : {}) });
        this.broadcastFolders();
        this.saveStateDebounced?.();
        return id;
    },
    renameFolder(id, name) {
        const f = this.folders.find(x => x.id === id);
        if (f && typeof name === 'string' && name.trim()) { f.name = name.trim().slice(0, 40); this.broadcastFolders(); this.saveStateDebounced?.(); }
    },
    setFolderIcon(id, icon) {
        const f = this.folders.find(x => x.id === id);
        if (f) { f.icon = (icon || '').slice(0, 8) || null; this.broadcastFolders(); this.saveStateDebounced?.(); }
    },
    toggleFolder(id, collapsed) {
        const f = this.folders.find(x => x.id === id);
        if (f) { f.collapsed = (collapsed == null) ? !f.collapsed : !!collapsed; this.broadcastFolders(); this.saveStateDebounced?.(); }
    },
    // Reorder folders within the current workspace. `ids` is the new order for
    // this workspace only — folders in other workspaces keep their relative
    // positions, so a reorder here can't disturb them.
    // Rename a tab. Passing a blank label clears the override so the page title
    // takes over again (the reference's "reset" behaviour).
    setTabLabel(index, label) {
        const i = Number(index);
        const tab = this.tabMap.get(i);
        if (!tab)
            return;
        const clean = (label || '').trim().slice(0, 60);
        if (clean)
            this.tabLabels.set(i, clean);
        else
            this.tabLabels.delete(i);
        this.sendTabUpdate(i, tab, this.tabUrls.get(i) || '', clean || tab.lazyTitle);
        this.saveStateDebounced?.();
    },
    // A pinned icon replaces the favicon and survives navigation; blank resets.
    setTabIcon(index, icon) {
        const i = Number(index);
        if (!this.tabMap.has(i))
            return;
        const clean = (icon || '').trim().slice(0, 8);
        if (clean)
            this.tabIcons.set(i, clean);
        else
            this.tabIcons.delete(i);
        try { this.mainWindow.webContents.send('tab-icon-changed', { index: i, icon: clean || null }); }
        catch (e) { log.debug('organize', 'clean', e); }
        this.saveStateDebounced?.();
    },
    /**
     * Discard a tab's page while keeping its row. Rather than destroying the
     * view (which would disturb bounds/z-order bookkeeping), this reuses the
     * lazy-tab path: blank the contents and clear lazyLoaded, so showTab reloads
     * the stored URL when you come back to it. The active tab is never unloaded.
     */
    // The url a pinned tab returns to. Blank clears it back to the current page.
    setPinnedHome(index, url) {
        const i = Number(index);
        if (!this.pinnedTabs.has(i))
            return false;
        const clean = (url || '').trim();
        this.pinnedHome.set(i, clean || this.tabUrls.get(i) || 'newtab');
        this.saveStateDebounced?.();
        return true;
    },
    resetPinnedTab(index) {
        const i = Number(index);
        const home = this.pinnedHome.get(i);
        if (!home || !this.tabMap.has(i))
            return false;
        this.openUrlUserInitiated(i, home);
        return true;
    },
    /* ✕ on a pinned tab: close the PAGE, keep the PIN. The tab goes back to its
       home and unloads, so the row stays where you put it and opens fresh the
       next time you click it (Arc's model). Removing the pin is Unpin, in its
       menu. Closing the tab you are on first moves you to a neighbour, as
       closing any tab would. */
    closePinnedPage(index) {
        const i = Number(index);
        if (!this.pinnedTabs.has(i) || !this.tabMap.has(i))
            return false;
        if (i === this.activeTabIndex) {
            const next = this._neighborInWorkspace(i);
            if (next != null && next !== i && this.tabMap.has(next))
                this.showTab(next);
            else
                this.openNewTabPage();
        }
        const home = this.pinnedHome.get(i);
        if (home && /^https?:/i.test(home))
            this.tabUrls.set(i, home);
        return this.unloadTab(i);
    },
    unloadTab(index) {
        const i = Number(index);
        const tab = this.tabMap.get(i);
        const url = this.tabUrls.get(i);
        if (!tab || i === this.activeTabIndex || !url || url === 'newtab')
            return false;
        if (tab.lazyLoaded === false)
            return false; // already unloaded
        // Capture the title first — blanking the page would otherwise lose it.
        const keep = this.tabLabels.get(i) || this.computeDisplayTitleFor(i) || tab.lazyTitle || 'New Tab';
        // Blanking navigates, which would drive the normal title/url handlers and
        // leave the row reading "about:blank" with its stored url replaced — so
        // flag it, then put the real url and title back once the blank settles.
        tab._unloading = true;
        try {
            tab.webContents.stop();
            tab.webContents.loadURL('about:blank');
        }
        catch (e) { log.debug('organize', 'unloadTab', e); }
        tab.lazyLoaded = false;
        tab.lazyTitle = keep;
        let restored = false;
        const restore = () => {
            if (restored) return;
            restored = true;
            tab._unloading = false;
            this.tabUrls.set(i, url);
            tab.lazyTitle = keep;
            this.sendTabUpdate(i, tab, url, keep);
            // The row shows it is unloaded (dotted ring), like an automatically
            // slept tab (P1-8). After the blank load, which would clear it.
            try { this.mainWindow.webContents.send('tab-slept', { index: i }); }
            catch (e) { log.debug('organize', 'tab-slept', e); }
        };
        try { tab.webContents.once('did-finish-load', restore); }
        catch (e) { log.debug('organize', 'restore', e); }
        setTimeout(restore, 900); // in case the blank load reports nothing
        return true;
    },
    // Unload every tab in a workspace except the active one.
    unloadWorkspace(ws) {
        let n = 0;
        for (const idx of this.tabsInWorkspace(ws || this.profileId))
            if (this.unloadTab(idx)) n++;
        return n;
    },
    reorderFolders(ids) {
        const ws = String(this.profileId);
        const wanted = (ids || []).map(String);
        const mine = this.folders.filter(f => String(f.workspace) === ws);
        const byId = new Map(mine.map(f => [f.id, f]));
        const ordered = wanted.map(id => byId.get(id)).filter(Boolean);
        if (ordered.length !== mine.length) return; // stale list — ignore
        let i = 0;
        this.folders = this.folders.map(f => String(f.workspace) === ws ? ordered[i++] : f);
        this.broadcastFolders();
        this.saveStateDebounced?.();
    },
    // Nest one folder under another (drag-into-folder). `parent` null un-nests to
    // the root. Refuses to make a folder its own descendant (a cycle), to cross
    // workspaces, or to nest past the depth cap — in any of those cases the folder
    // is left where it was.
    reparentFolder(id, parent) {
        const f = this.folders.find(x => x.id === id);
        if (!f) return;
        const pid = parent ? String(parent) : null;
        if (pid === id) return;
        if (!pid) {
            if (f.parent) { delete f.parent; this.broadcastFolders(); this.saveStateDebounced?.(); }
            return;
        }
        const p = this.folders.find(x => x.id === pid);
        if (!p || String(p.workspace) !== String(f.workspace)) return;
        // Walk up from the intended parent: hitting `id` would make a loop.
        for (let cur = p, d = 0; cur && d < 20; d++) {
            if (cur.id === id) return;
            cur = cur.parent ? this.folders.find(x => x.id === cur.parent) : null;
        }
        if (this._folderDepth(pid) >= 4) return;
        f.parent = pid;
        this.broadcastFolders();
        this.saveStateDebounced?.();
    },
    // Move a folder to another workspace. Its tabs go with it, otherwise they'd
    // be stranded in a workspace whose folder list no longer names them.
    moveFolderToWorkspace(id, workspace) {
        const f = this.folders.find(x => x.id === id);
        if (!f) return;
        const ws = String(workspace);
        if (ws === String(f.workspace)) return;
        f.workspace = ws;
        const moved = [];
        for (const [idx, fid] of this.tabFolders.entries()) {
            if (fid !== id || !this.tabMap.has(idx)) continue;
            this.tabProfiles.set(idx, ws);
            moved.push(idx);
        }
        if (moved.length) {
            try { this.mainWindow.webContents.send('tabs-workspace-changed', { indices: moved, workspace: ws }); }
            catch (e) { log.debug('organize', 'moveFolderToWorkspace', e); }
            // A moved-away tab must not stay on screen in the old workspace.
            if (moved.includes(this.activeTabIndex)) {
                const stay = this.tabsInWorkspace(this.profileId)[0];
                if (stay !== undefined) this.showTab(stay);
            }
        }
        this.broadcastFolders();
        this.saveStateDebounced?.();
    },
    deleteFolder(id) {
        // "Unpack": tabs survive, just leave the folder.
        for (const [idx, fid] of [...this.tabFolders.entries()]) if (fid === id) this.tabFolders.delete(idx);
        // Children would otherwise point at a folder that no longer exists.
        const gone = this.folders.find(f => f.id === id);
        for (const f of this.folders)
            if (f.parent === id) {
                if (gone?.parent) f.parent = gone.parent;
                else delete f.parent;
            }
        this.folders = this.folders.filter(f => f.id !== id);
        this.broadcastFolders();
        this.saveStateDebounced?.();
    },
    reopenClosedTab() {
        const last = this.closedTabHistory.pop();
        // Nothing to reopen means nothing happens — a blank tab is not a
        // reopened one.
        if (last && last.url && last.url !== 'newtab') { const i = this.createTab(); this.loadUrl(i, last.url); }
    },
    toggleCompact() {
        this.sidebarCompact = !this.sidebarCompact;
        this.resizeAllTabs();
        try { this.mainWindow.webContents.send('sidebar-compact-changed', this.sidebarCompact); } catch (e) { log.debug('organize', 'toggleCompact', e); }
    },
    setTabFolder(index, folderId) {
        if (!this.tabMap.has(index)) return;
        if (folderId && this.folders.some(f => f.id === folderId)) this.tabFolders.set(index, folderId);
        else this.tabFolders.delete(index);
        this.broadcastFolders();
        this.saveStateDebounced?.();
    },
    // Focus the active workspace after a switch: show its most-recent tab, or
    // open a fresh one if it has none. (this.profileId already points at it.)
    applyWorkspace() {
        const mine = this.tabsInWorkspace(this.profileId);
        if (!mine.length) {
            /* An empty space shows an EMPTY space. Hide EVERY tab view first —
               otherwise the space you came from keeps its active tab painted over
               the empty one (the "new space brought my current tab with it" bug).
               A window with no tabs is a supported state (CLAUDE.md): empty rail,
               card in the theme's colour. */
            this.tabMap.forEach((tab) => { try { tab.setVisible(false); } catch (e) { log.debug('organize', 'applyWorkspace hide', e); } });
            this.activeTabIndex = -1;
            try { this.mainWindow.webContents.send('tab-switched', { index: -1 }); }
            catch (e) { log.debug('organize', 'applyWorkspace', e); }
            return;
        }
        let target = mine.includes(this.activeTabIndex) ? this.activeTabIndex : null;
        if (target == null)
            target = mine.reduce((a, b) => ((this.tabLastActive.get(b) || 0) > (this.tabLastActive.get(a) || 0) ? b : a), mine[0]);
        this.showTab(target);
        this.broadcastFolders();
    },
};
