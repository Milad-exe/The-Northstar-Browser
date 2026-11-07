const log = require('./log');
const { app } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const { encrypt, decrypt, isEncrypted } = require('./encryption');
class Bookmarks {
    file; // encrypted JSON store path (userData)
    cache; // decrypted bookmark tree once loaded
    // fileSuffix scopes the store per profile ('' = profile 1's legacy file).
    constructor(fileSuffix = '') {
        this.file = path.join(app.getPath('userData'), `bookmarks${fileSuffix}.json`);
        this.cache = null;
    }
    genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }
    normalize(item) {
        if (!item.id)
            item = { ...item, id: this.genId() };
        if (!item.type)
            item = { ...item, type: 'bookmark' };
        return item;
    }
    // ── Low-level read/write ─────────────────────────────────────────────────
    async load() {
        if (this.cache)
            return this.cache;
        try {
            const raw = await fs.readFile(this.file, 'utf8');
            let plaintext;
            if (isEncrypted(raw))
                plaintext = decrypt(raw);
            else
                plaintext = raw; // legacy plaintext — encrypted on next save()
            this.cache = JSON.parse(plaintext);
            // Entries written before the rename tag their container as `persona`.
            for (const b of (Array.isArray(this.cache) ? this.cache : (this.cache?.items || [])))
                if (b && b.persona !== undefined && b.profile === undefined) { b.profile = b.persona; delete b.persona; }
            if (!Array.isArray(this.cache))
                this.cache = [];
        }
        catch {
            this.cache = [];
        }
        // Migrate: ensure every top-level item has an id and type
        this.cache = this.cache.map(item => this.normalize(item));
        return this.cache;
    }
    async save() {
        try {
            await fs.writeFile(this.file, encrypt(JSON.stringify(this.cache, null, 2)), 'utf8');
        }
        catch (e) { log.debug('bookmarks', 'save', e); }
    }
    // ── Public API ───────────────────────────────────────────────────────────
    async getAll() {
        return this.load();
    }
    async add(url, title, profile = null) {
        const p = profile || null;
        const bookmarks = await this.load();
        // Keyed by URL *and profile* — a page bookmarked under a profile is a
        // distinct favourite that reopens in that profile.
        const exists = bookmarks.some(b => b.type === 'bookmark' && b.url === url && (b.profile || null) === p);
        if (!exists) {
            bookmarks.push({ type: 'bookmark', id: this.genId(), url, title: title || url, addedAt: Date.now(), ...(p ? { profile: p } : {}) });
            await this.save();
        }
        return !exists;
    }
    async remove(url, profile = null) {
        const p = profile || null;
        const bookmarks = await this.load();
        const idx = bookmarks.findIndex(b => b.url === url && (b.profile || null) === p);
        if (idx !== -1) {
            bookmarks.splice(idx, 1);
            await this.save();
            return true;
        }
        return false;
    }
    async removeById(id) {
        await this.load();
        const result = this.findNodeAndParentArray(id);
        if (result) {
            result.parentArray.splice(result.index, 1);
            await this.save();
            return true;
        }
        return false;
    }
    async has(url, profile = null) {
        const p = profile || null;
        const bookmarks = await this.load();
        return bookmarks.some(b => b.type === 'bookmark' && b.url === url && (b.profile || null) === p);
    }
    async updateTitle(url, title) {
        const bookmarks = await this.load();
        const entry = bookmarks.find(b => b.url === url);
        if (entry && title) {
            entry.title = title;
            await this.save();
        }
    }
    async updateById(id, updates) {
        await this.load();
        const result = this.findNodeAndParentArray(id);
        if (result) {
            Object.assign(result.node, updates);
            await this.save();
            return true;
        }
        return false;
    }
    /**
     * Bulk-insert an imported bookmark tree under one new top-level folder.
     * `tree` is [{ type:'bookmark'|'folder', title, url?, children? }]. Fresh ids
     * are assigned; urls already bookmarked anywhere are skipped. Returns the
     * number of bookmarks actually added.
     */
    async importTree(folderTitle, tree) {
        const bookmarks = await this.load();
        const existing = new Set();
        const collect = (arr) => {
            for (const b of arr || []) {
                if (b.type === 'bookmark' && b.url) existing.add(b.url);
                if (b.type === 'folder' && Array.isArray(b.children)) collect(b.children);
            }
        };
        collect(bookmarks);
        let count = 0;
        const build = (nodes) => {
            const out = [];
            for (const n of nodes || []) {
                if (n.type === 'folder') {
                    const kids = build(n.children || []);
                    if (kids.length)
                        out.push({ type: 'folder', id: this.genId(), title: String(n.title || 'Folder').slice(0, 200), children: kids });
                }
                else if (n.url && !existing.has(n.url)) {
                    existing.add(n.url);
                    out.push({ type: 'bookmark', id: this.genId(), url: n.url, title: String(n.title || n.url).slice(0, 300), addedAt: Date.now() });
                    count++;
                }
            }
            return out;
        };
        const built = build(tree);
        if (built.length) {
            bookmarks.push({ type: 'folder', id: this.genId(), title: folderTitle || 'Imported', children: built });
            await this.save();
        }
        return count;
    }
    async addFolder(title) {
        const bookmarks = await this.load();
        const id = this.genId();
        bookmarks.push({ type: 'folder', id, title: title || 'New Folder', children: [] });
        await this.save();
        return id;
    }
    /** A new top-level folder holding `items` ([{ url, title }]) — "Bookmark
     *  all tabs". Returns the folder id. */
    async addFolderOfLinks(title, items) {
        const bookmarks = await this.load();
        const id = this.genId();
        const children = (items || []).filter(i => i && i.url).map(i => ({
            type: 'bookmark', id: this.genId(), url: i.url, title: i.title || i.url, addedAt: Date.now(),
        }));
        bookmarks.push({ type: 'folder', id, title: title || 'Tabs', children });
        await this.save();
        return id;
    }
    async addDivider() {
        const bookmarks = await this.load();
        const id = this.genId();
        bookmarks.push({ type: 'divider', id });
        await this.save();
        return id;
    }
    // Add a sub-folder directly inside an existing folder
    async addFolderInto(title, parentFolderId) {
        await this.load();
        const result = this.findNodeAndParentArray(parentFolderId);
        if (!result || result.node.type !== 'folder')
            return null;
        const id = this.genId();
        if (!Array.isArray(result.node.children))
            result.node.children = [];
        result.node.children.push({ type: 'folder', id, title: title || 'New Folder', children: [] });
        await this.save();
        return id;
    }
    // Add a divider directly inside an existing folder
    async addDividerInto(parentFolderId) {
        await this.load();
        const result = this.findNodeAndParentArray(parentFolderId);
        if (!result || result.node.type !== 'folder')
            return null;
        const id = this.genId();
        if (!Array.isArray(result.node.children))
            result.node.children = [];
        result.node.children.push({ type: 'divider', id });
        await this.save();
        return id;
    }
    findNodeAndParentArray(id, array) {
        array = array || (this.cache || []);
        for (let i = 0; i < array.length; i++) {
            if (array[i].id === id)
                return { node: array[i], parentArray: array, index: i };
            if (array[i].type === 'folder' && Array.isArray(array[i].children)) {
                const result = this.findNodeAndParentArray(id, array[i].children);
                if (result)
                    return result;
            }
        }
        return null;
    }
    async moveOutOfFolder(itemId, folderId, insertBeforeId) {
        await this.load();
        const src = this.findNodeAndParentArray(itemId);
        if (!src)
            return false;
        // Remove from its current location
        const [item] = src.parentArray.splice(src.index, 1);
        if (insertBeforeId) {
            const target = this.findNodeAndParentArray(insertBeforeId);
            if (target) {
                target.parentArray.splice(target.index, 0, item);
            }
            else {
                this.cache.push(item);
            }
        }
        else {
            this.cache.push(item);
        }
        await this.save();
        return true;
    }
    async moveIntoFolder(itemId, folderId, insertBeforeId = null) {
        await this.load();
        const src = this.findNodeAndParentArray(itemId);
        if (!src)
            return false;
        if (itemId === folderId)
            return false;
        const folderTarget = this.findNodeAndParentArray(folderId);
        if (!folderTarget || folderTarget.node.type !== 'folder')
            return false;
        if (src.node.type === 'folder') {
            if (this.findNodeAndParentArray(folderId, src.node.children || [])) {
                return false; // prevent cycles
            }
        }
        // Extract
        const [item] = src.parentArray.splice(src.index, 1);
        if (!Array.isArray(folderTarget.node.children))
            folderTarget.node.children = [];
        if (insertBeforeId) {
            const beforeIdx = folderTarget.node.children.findIndex(c => c.id === insertBeforeId);
            if (beforeIdx !== -1) {
                folderTarget.node.children.splice(beforeIdx, 0, item);
            }
            else {
                folderTarget.node.children.push(item);
            }
        }
        else {
            folderTarget.node.children.push(item);
        }
        await this.save();
        return true;
    }
    async reorder(ids) {
        const bookmarks = await this.load();
        const map = new Map(bookmarks.map(b => [b.id, b]));
        const reordered = ids.map(id => map.get(id)).filter(Boolean);
        const inOrder = new Set(ids);
        bookmarks.forEach(b => { if (!inOrder.has(b.id))
            reordered.push(b); });
        this.cache = reordered;
        await this.save();
    }
    async reorderInFolder(folderId, orderedIds) {
        await this.load();
        const result = this.findNodeAndParentArray(folderId);
        if (!result || result.node.type !== 'folder')
            return false;
        const folder = result.node;
        const children = folder.children || [];
        const map = new Map(children.map(c => [c.id, c]));
        const reordered = orderedIds.map(id => map.get(id)).filter(Boolean);
        const inOrder = new Set(orderedIds);
        children.forEach(c => { if (!inOrder.has(c.id))
            reordered.push(c); });
        folder.children = reordered;
        await this.save();
        return true;
    }
}

module.exports = Bookmarks;