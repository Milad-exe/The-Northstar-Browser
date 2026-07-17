/**
 * IPC handlers — browsing history.
 *
 * History is stored by Features/history.js and accessed here read-only
 * (writes happen inside Features/tabs.js as pages load).
 */

function register(ipcMain, { wm }) {

    ipcMain.handle('history-get', async () => {
        try { return await wm.history.loadHistory(); }
        catch { return []; }
    });

    ipcMain.handle('history-search', async (_e, query, limit = 50) => {
        try {
            const items = await wm.history.loadHistory();
            if (!query?.trim()) return [];

            const q = query.trim().toLowerCase();
            // Score once per entry, THEN sort — scoring inside the comparator
            // recomputed both scores on every comparison (O(n log n) rescans).
            const scored = [];
            for (const e of items) {
                if (isSearchResultUrl(e.url)) continue;
                if (!(e.title || '').toLowerCase().includes(q) &&
                    !(e.url   || '').toLowerCase().includes(q)) continue;
                scored.push([relevanceScore(e, q), e]);
            }
            scored.sort((a, b) => b[0] - a[0]);
            return scored.slice(0, limit).map(s => s[1]);
        } catch (err) {
            console.error('history-search:', err);
            return [];
        }
    });

    ipcMain.handle('remove-history-entry', async (_e, url, timestamp) => {
        try { return await wm.history.removeFromHistory(url, timestamp); }
        catch { return false; }
    });

    ipcMain.handle('open-history-tab', (_e) => {
        const wd = wm.getWindowByWebContents(_e.sender);
        if (wd) wd.tabs.createTabWithPage('renderer/History/index.html', 'history', 'History');
    });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isSearchResultUrl(rawUrl) {
    if (!rawUrl) return false;
    try {
        const u    = new URL(rawUrl);
        const host = u.hostname.toLowerCase();
        const p    = u.pathname.toLowerCase();
        const ps   = u.searchParams;
        if (host.includes('google.')    && (p.startsWith('/search') || p.startsWith('/url') || ps.has('q'))) return true;
        if (host.includes('bing.com')   && (p.startsWith('/search') || ps.has('q')))                         return true;
        if (host.includes('duckduckgo.com') && ps.has('q'))                                                   return true;
        if (p.includes('/search') && ps.has('q'))                                                             return true;
    } catch {}
    return false;
}

function relevanceScore(entry, q) {
    const t   = (entry.title || '').toLowerCase();
    const u   = (entry.url   || '').toLowerCase();
    let score = 0;
    if (t === q || u === q)    score += 100;
    if (t.includes(q))         score += 50;
    if (u.includes(q))         score += 25;
    if (t.startsWith(q))       score += 25;
    if (u.startsWith(q))       score += 10;
    const ts = Date.parse(entry.timestamp || entry.date || 0);
    if (!isNaN(ts)) {
        const days = (Date.now() - ts) / (1000 * 60 * 60 * 24);
        if (days < 1) score += 10; else if (days < 7) score += 5;
    }
    return score;
}

module.exports = { register };
