const BinarySearchTree = require('./binary-search-tree');
class NavigationHistory {
    tabHistories; // tabIndex → { entries, currentIndex }
    constructor() {
        this.tabHistories = new Map();
    }
    initializeTab(tabIndex, initialUrl = 'newtab') {
        const bst = new BinarySearchTree();
        bst.insert(initialUrl, 0);
        this.tabHistories.set(tabIndex, {
            tree: bst,
            currentIndex: 0,
            maxIndex: 0,
            titles: new Map(), // history-entry index → page title
        });
    }
    /**
     * Rebuild a tab's tree from a saved session: `entries` oldest-first, with
     * `currentIndex` pointing at the one being shown. Back/forward run off this
     * tree (goBack loads the entry itself), so without it a restored tab has
     * nowhere to go back to.
     */
    restoreTab(tabIndex, entries, currentIndex = 0) {
        const list = (entries || []).filter(e => e && (typeof e === 'string' || e.url));
        if (!list.length)
            return;
        const bst = new BinarySearchTree();
        const titles = new Map();
        list.forEach((entry, i) => {
            const url = typeof entry === 'string' ? entry : entry.url;
            bst.insert(url, i);
            const title = typeof entry === 'string' ? null : entry.title;
            if (title)
                titles.set(i, title);
        });
        const pos = Math.max(0, Math.min(list.length - 1, Number(currentIndex) || 0));
        this.tabHistories.set(tabIndex, {
            tree: bst,
            currentIndex: pos,
            maxIndex: list.length - 1,
            titles,
        });
    }
    // Record the page title for the entry the tab is currently viewing.
    setCurrentTitle(tabIndex, title) {
        const tabHistory = this.tabHistories.get(tabIndex);
        if (!tabHistory || !title)
            return;
        tabHistory.titles.set(tabHistory.currentIndex, title);
    }
    /* `exact`: the page itself pushed this entry (pushState / a #fragment
       link), so record it as its own step even when it looks like the current
       address — the "similar URL" folding exists for redirects, and folding a
       web app's pushed pages made Back skip every one of them. */
    addEntry(tabIndex, url, { exact = false } = {}) {
        if (!this.tabHistories.has(tabIndex)) {
            this.initializeTab(tabIndex, url);
            return;
        }
        const tabHistory = this.tabHistories.get(tabIndex);
        const currentNode = tabHistory.tree.find(tabHistory.currentIndex);
        if (currentNode && currentNode.data === url) {
            return;
        }
        if (!exact && currentNode && this.isSimilarUrl(currentNode.data, url)) {
            this.replaceCurrentEntry(tabIndex, url);
            return;
        }
        if (tabHistory.currentIndex < tabHistory.maxIndex) {
            tabHistory.tree.deleteGreaterThan(tabHistory.currentIndex);
            tabHistory.maxIndex = tabHistory.currentIndex;
        }
        const newIndex = tabHistory.currentIndex + 1;
        tabHistory.tree.insert(url, newIndex);
        tabHistory.currentIndex = newIndex;
        tabHistory.maxIndex = newIndex;
    }
    isSimilarUrl(url1, url2) {
        if (!url1 || !url2 || url1 === url2) {
            return url1 === url2;
        }
        try {
            const u1 = new URL(url1);
            const u2 = new URL(url2);
            const host1 = u1.hostname.replace(/^www\./, '');
            const host2 = u2.hostname.replace(/^www\./, '');
            if (host1 === host2) {
                const path1 = u1.pathname;
                const path2 = u2.pathname;
                const search1 = u1.search;
                const search2 = u2.search;
                if ((search1 && search1.includes('q=')) || (search2 && search2.includes('q='))) {
                    return false;
                }
                if (path1 !== path2) {
                    const isBasicRootRedirect = ((path1 === '/' && path2 === '') ||
                        (path1 === '' && path2 === '/') ||
                        (path1 === '/' && path2 === '/index.html') ||
                        (path1 === '/index.html' && path2 === '/'));
                    return isBasicRootRedirect;
                }
                if (path1 === path2) {
                    if (!search1 && !search2)
                        return true;
                    if (search1 !== search2) {
                        const trackingOnlyPattern = /^[?&](utm_|fbclid|gclid|ref=|source=)/;
                        const isTracking1 = search1 && trackingOnlyPattern.test(search1);
                        const isTracking2 = search2 && trackingOnlyPattern.test(search2);
                        return (!search1 && isTracking2) || (!search2 && isTracking1);
                    }
                    return true;
                }
            }
            return false;
        }
        catch {
            return false;
        }
    }
    canGoBack(tabIndex) {
        if (!this.tabHistories.has(tabIndex)) {
            return false;
        }
        const tabHistory = this.tabHistories.get(tabIndex);
        const currentNode = tabHistory.tree.find(tabHistory.currentIndex);
        if (!currentNode) {
            return false;
        }
        const predecessor = tabHistory.tree.findPredecessor(currentNode);
        if (!predecessor)
            return false;
        // The new-tab page is the tree's root placeholder, not a real place — there
        // is nothing meaningful to go "back" to, so don't offer it.
        if (predecessor.data === 'newtab')
            return false;
        return true;
    }
    canGoForward(tabIndex) {
        if (!this.tabHistories.has(tabIndex)) {
            return false;
        }
        const tabHistory = this.tabHistories.get(tabIndex);
        const currentNode = tabHistory.tree.find(tabHistory.currentIndex);
        if (!currentNode)
            return false;
        const successor = tabHistory.tree.findSuccessor(currentNode);
        return successor !== null;
    }
    goBack(tabIndex) {
        if (!this.canGoBack(tabIndex)) {
            return null;
        }
        const tabHistory = this.tabHistories.get(tabIndex);
        const currentNode = tabHistory.tree.find(tabHistory.currentIndex);
        const predecessor = tabHistory.tree.findPredecessor(currentNode);
        if (predecessor) {
            tabHistory.currentIndex = predecessor.index;
            return predecessor.data;
        }
        return null;
    }
    goForward(tabIndex) {
        if (!this.canGoForward(tabIndex)) {
            return null;
        }
        const tabHistory = this.tabHistories.get(tabIndex);
        const currentNode = tabHistory.tree.find(tabHistory.currentIndex);
        const successor = tabHistory.tree.findSuccessor(currentNode);
        if (successor) {
            tabHistory.currentIndex = successor.index;
            return successor.data;
        }
        return null;
    }
    // Jump directly to an arbitrary entry (used by the back/forward long-press list)
    goToIndex(tabIndex, targetIndex) {
        const tabHistory = this.tabHistories.get(tabIndex);
        if (!tabHistory)
            return null;
        const node = tabHistory.tree.find(targetIndex);
        if (!node)
            return null;
        tabHistory.currentIndex = targetIndex;
        return node.data;
    }
    getCurrentUrl(tabIndex) {
        if (!this.tabHistories.has(tabIndex)) {
            return null;
        }
        const tabHistory = this.tabHistories.get(tabIndex);
        const currentNode = tabHistory.tree.find(tabHistory.currentIndex);
        return currentNode ? currentNode.data : null;
    }
    getHistory(tabIndex) {
        if (!this.tabHistories.has(tabIndex)) {
            return null;
        }
        const tabHistory = this.tabHistories.get(tabIndex);
        const titles = tabHistory.titles || new Map();
        return {
            currentIndex: tabHistory.currentIndex,
            maxIndex: tabHistory.maxIndex,
            entries: tabHistory.tree.toArray().map(e => ({ ...e, title: titles.get(e.index) || null })),
            size: tabHistory.tree.getSize()
        };
    }
    removeTab(tabIndex) {
        this.tabHistories.delete(tabIndex);
    }
    clearHistory(tabIndex) {
        if (this.tabHistories.has(tabIndex)) {
            this.tabHistories.delete(tabIndex);
        }
    }
    getHistoryLength(tabIndex) {
        if (!this.tabHistories.has(tabIndex)) {
            return 0;
        }
        const tabHistory = this.tabHistories.get(tabIndex);
        return tabHistory.tree.getSize();
    }
    replaceCurrentEntry(tabIndex, url) {
        if (!this.tabHistories.has(tabIndex)) {
            this.initializeTab(tabIndex, url);
            return;
        }
        const tabHistory = this.tabHistories.get(tabIndex);
        const currentIndex = tabHistory.currentIndex;
        tabHistory.tree.delete(currentIndex);
        tabHistory.tree.insert(url, currentIndex);
    }
}

module.exports = NavigationHistory;