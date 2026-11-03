/**
 * Extension-facing event fan-out, plus the shared "browser data as Chrome sees
 * it" mappings.
 *
 * WHY THIS EXISTS SEPARATELY: chrome.history.onVisited and the chrome.bookmarks
 * events have to fire for REAL browsing and REAL user edits, not just for
 * changes an extension made itself. The code that performs those mutations
 * lives in features/ (Tabs.addToHistory) and ipc/ (the bookmark handlers), so
 * the fan-out cannot live inside the extension IPC module without features/
 * reaching up into ipc/.
 *
 * Bookmarks are diffed rather than instrumented: every mutation in the app
 * already funnels through broadcastBookmarksChanged(), and hooking a dozen
 * call sites individually would drift. Snapshot + diff produces correct
 * onCreated/onRemoved/onChanged/onMoved from one place.
 */
'use strict';
const log = require('./log');
const { hasPermission } = require('./ext-permissions');

// sw → profile id. A worker only hears about its own space's data.
const workers = new Map();
// Held here so the mutation sites (which have no wm in scope) can just say
// "bookmarks changed" without threading a reference through.
let _wm = null;
function setWindowManager(wm) { _wm = wm; }

function addWorker(sw, profileId) {
    workers.set(sw, String(profileId || '1'));
}
function dropWorker(sw) {
    workers.delete(sw);
}
/**
 * Spaces worth computing events for: those with a live service worker, plus
 * those with an extension page open. Pages alone are enough — a popup can hold
 * bookmark listeners while the extension's worker is suspended, which is the
 * normal MV3 state rather than an edge case.
 */
function activeProfiles() {
    const out = new Set(workers.values());
    try {
        const { webContents } = require('electron');
        for (const wc of webContents.getAllWebContents()) {
            let url = '';
            try { url = wc.getURL() || ''; }
            catch { continue; }
            if (!url.startsWith('chrome-extension://'))
                continue;
            out.add(_wm ? String(_wm.profileOf(wc)) : '1');
        }
    }
    catch (e) { log.debug('ext-events', 'activeProfiles', e); }
    return out;
}

/**
 * Push to every live worker AND every open extension page, optionally scoped to
 * one space. Pages matter: a popup that registered chrome.bookmarks.onCreated
 * listens on the same channel, and sending only to workers would leave those
 * listeners permanently silent.
 *
 * `perm`, when given, limits delivery to extensions whose manifest declares
 * it: a visited URL or a bookmark is the user's data, and an extension that
 * never asked for history/bookmarks must not hear about it.
 */
function broadcast(channel, data, profileId, perm) {
    const allowed = (extId, session) => !perm || hasPermission(extId, perm, session);
    for (const [sw, pid] of [...workers]) {
        if (profileId != null && pid !== String(profileId))
            continue;
        let extId = null;
        try { extId = new URL(sw.scope).hostname; }
        catch { continue; }
        if (!allowed(extId, sw.session))
            continue;
        try { sw.send(channel, data); }
        catch { workers.delete(sw); }
    }
    try {
        const { webContents } = require('electron');
        for (const wc of webContents.getAllWebContents()) {
            let url = '';
            try { url = wc.getURL() || ''; }
            catch { continue; }
            if (!url.startsWith('chrome-extension://'))
                continue;
            if (profileId != null && _wm && String(_wm.profileOf(wc)) !== String(profileId))
                continue;
            if (perm && !allowed(new URL(url).hostname, wc.session))
                continue;
            try { wc.send(channel, data); }
            catch (e) { log.debug('ext-events', 'for', e); }
        }
    }
    catch (e) { log.debug('ext-events', 'for', e); }
}

// ── chrome.history ───────────────────────────────────────────────────────────
function toHistoryItem(entry) {
    return {
        id: entry.url,
        url: entry.url,
        title: entry.title || '',
        lastVisitTime: Date.parse(entry.timestamp || 0) || Date.now(),
        visitCount: 1,
        typedCount: 0,
    };
}
function historyVisited(url, title, profileId) {
    if (!workers.size || !url)
        return;
    broadcast('ext:history.visited', toHistoryItem({ url, title, timestamp: new Date().toISOString() }), profileId, 'history');
}
function historyRemoved(info, profileId) {
    if (!workers.size)
        return;
    broadcast('ext:history.visitRemoved', info, profileId, 'history');
}

// ── chrome.bookmarks ─────────────────────────────────────────────────────────
const ROOT_ID = '0';
const BAR_ID = '1';

function toNode(item, parentId, index) {
    const node = {
        id: String(item.id),
        parentId,
        index,
        title: item.title || '',
        dateAdded: item.addedAt || 0,
    };
    if (item.type === 'folder') {
        node.children = (item.children || [])
            .filter(c => c.type !== 'divider')
            .map((c, i) => toNode(c, String(item.id), i));
        node.dateGroupModified = item.addedAt || 0;
    }
    else {
        node.url = item.url;
    }
    return node;
}

/** The bar node — Chrome's tree is rooted at '0'; ours is a flat top level. */
async function barNode(store) {
    const items = await store.getAll();
    return {
        id: BAR_ID,
        parentId: ROOT_ID,
        index: 0,
        title: 'Bookmarks Bar',
        children: items.filter(i => i.type !== 'divider').map((i, idx) => toNode(i, BAR_ID, idx)),
    };
}

function flatten(node, out = []) {
    out.push(node);
    for (const c of node.children || [])
        flatten(c, out);
    return out;
}

// profile id → Map(id → snapshot) from the previous broadcast.
const snapshots = new Map();

function snapshotOf(bar) {
    const m = new Map();
    for (const n of flatten(bar)) {
        if (n.id === BAR_ID)
            continue;
        m.set(n.id, { title: n.title, url: n.url, parentId: n.parentId, index: n.index, node: n });
    }
    return m;
}

/**
 * Re-read each active space's bookmarks and emit the precise Chrome events for
 * whatever changed since last time. Called after every mutation in the app.
 */
async function bookmarksChanged() {
    if (!_wm)
        return;
    for (const pid of activeProfiles()) {
        let bar;
        try { bar = await barNode(_wm.bookmarksFor(pid)); }
        catch { continue; }
        const next = snapshotOf(bar);
        const prev = snapshots.get(pid);
        snapshots.set(pid, next);
        if (!prev)
            continue; // first run establishes the baseline, it is not a change
        for (const [id, cur] of next) {
            const old = prev.get(id);
            if (!old) {
                broadcast('ext:bookmarks.created', { id, node: cur.node }, pid, 'bookmarks');
                continue;
            }
            if (old.title !== cur.title || old.url !== cur.url)
                broadcast('ext:bookmarks.changed', { id, info: { title: cur.title, url: cur.url } }, pid, 'bookmarks');
            if (old.parentId !== cur.parentId || old.index !== cur.index) {
                broadcast('ext:bookmarks.moved', {
                    id,
                    info: { parentId: cur.parentId, index: cur.index, oldParentId: old.parentId, oldIndex: old.index },
                }, pid, 'bookmarks');
            }
        }
        for (const [id, old] of prev) {
            if (!next.has(id))
                broadcast('ext:bookmarks.removed', { id, info: { parentId: old.parentId, index: old.index, node: old.node } }, pid, 'bookmarks');
        }
    }
}

/** Seed the baseline so the first real edit does not look like a mass create. */
async function primeBookmarks(profileId) {
    if (!_wm || snapshots.has(String(profileId)))
        return;
    try { snapshots.set(String(profileId), snapshotOf(await barNode(_wm.bookmarksFor(profileId)))); }
    catch (e) { log.debug('ext-events', 'primeBookmarks', e); }
}

module.exports = {
    setWindowManager, addWorker, dropWorker, broadcast, activeProfiles,
    toHistoryItem, historyVisited, historyRemoved,
    toNode, barNode, flatten, bookmarksChanged, primeBookmarks,
    ROOT_ID, BAR_ID,
};
