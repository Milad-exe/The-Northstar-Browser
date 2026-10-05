'use strict';
/**
 * Recently closed — the tabs and windows you closed, newest first, so any of
 * them can be brought back (not just the last tab, which is all Ctrl+Shift+T
 * reaches).
 *
 * Tabs: each window already keeps its own stack (Tabs.closedTabHistory, last
 * 20, every entry stamped with closedAt). Windows: a window closed BY HAND
 * while others stay open is recorded here with its tabs, in order. Closing the
 * last window ends the session instead (session restore brings that back), and
 * private windows are never recorded — private means nothing to bring back.
 * In memory only: this is "since you started the browser", like the native
 * browsers' list.
 */
const i18n = require('./i18n');
const favicons = require('./favicon-store');
const log = require('./log');

const MAX_WINDOWS = 10;
const MAX_ROWS = 10;
const closedWindows = []; // oldest first: { tabs: [{url, title}], closedAt }

const isWeb = (u) => typeof u === 'string' && /^https?:/i.test(u);
const T = (key, fallback, vars) => {
    const v = i18n.t(key, vars);
    if (v && v !== key)
        return v;
    return vars ? String(fallback).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : fallback;
};
/** The cached favicon for a page's site ('' when none) — never a fetch. */
const iconFor = (url) => {
    try { return favicons.getForHost(new URL(url).host) || ''; } // host, as the store keys it
    catch (e) { return ''; }
};
/** A title short enough for a menu row. */
const clip = (s, n = 48) => {
    const t = String(s || '').trim();
    return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
};

/** Remember a window being closed (call while its tabs still exist). */
function recordWindow(tabs) {
    if (!tabs || tabs.isPrivateWindow)
        return;
    try {
        // CREATION order, not the drawn one: reopening creates the tabs again in
        // this order, and the layout then draws them exactly as they were (the
        // sidebar draws a new tab at the top, so a drawn order would come back
        // reversed).
        const order = (Array.isArray(tabs.tabOrder) && tabs.tabOrder.length)
            ? tabs.tabOrder.filter(i => tabs.tabMap.has(i)) : [...tabs.tabMap.keys()];
        const list = [];
        for (const i of order) {
            if (tabs.privateTabs?.has?.(i))
                continue;
            const url = tabs.tabUrls.get(i);
            if (!isWeb(url))
                continue;
            let title = url;
            try { title = tabs.tabMap.get(i)?.webContents?.getTitle() || url; }
            catch (e) { log.debug('recently-closed', 'title', e); }
            list.push({ url, title });
        }
        if (!list.length)
            return;
        closedWindows.push({ tabs: list, closedAt: Date.now() });
        while (closedWindows.length > MAX_WINDOWS)
            closedWindows.shift();
    }
    catch (e) { log.warn('recently-closed', 'could not record a closed window', e); }
}

/** Newest-first entries for `wd`: its closed tabs and every closed window. */
function entries(wd) {
    // A private window keeps nothing to bring back, and must not surface the
    // normal windows' history either.
    if (wd?.tabs?.isPrivateWindow)
        return [];
    const out = [];
    for (const t of (wd?.tabs?.closedTabHistory || []))
        if (t && isWeb(t.url))
            out.push({ kind: 'tab', item: t, at: t.closedAt || 0 });
    for (const w of closedWindows)
        out.push({ kind: 'window', item: w, at: w.closedAt || 0 });
    // Stable: equal timestamps keep their stack order (newest last → reversed).
    return out.map((e, i) => ({ ...e, i })).sort((a, b) => (b.at - a.at) || (b.i - a.i)).slice(0, MAX_ROWS);
}

function reopenTab(wd, entry) {
    const stack = wd?.tabs?.closedTabHistory;
    if (!stack)
        return;
    const at = stack.lastIndexOf(entry);
    if (at >= 0)
        stack.splice(at, 1);
    const idx = wd.tabs.createTab();
    wd.tabs.loadUrl(idx, entry.url);
}

function reopenWindow(wm, entry) {
    const at = closedWindows.indexOf(entry);
    if (at >= 0)
        closedWindows.splice(at, 1);
    try { wm.createWindow(1000, 700, { urls: entry.tabs.map(t => t.url) }); }
    catch (e) { log.warn('recently-closed', 'could not reopen the window', e); }
}

/**
 * The menu template: "Reopen closed tab", then the list. Each row reopens that
 * one entry; a window row reopens the whole window.
 */
function template(wd, wm) {
    const rows = entries(wd);
    const lastTab = (wd?.tabs?.closedTabHistory || []).slice().reverse().find(t => t && isWeb(t.url));
    const out = [{
        label: T('closed.reopenTab', 'Reopen closed tab'),
        accelerator: 'CmdOrCtrl+Shift+T',
        enabled: !!lastTab,
        click: () => lastTab && reopenTab(wd, lastTab),
    }];
    if (!rows.length) {
        out.push({ type: 'separator' }, { label: T('closed.empty', 'Nothing closed yet'), enabled: false });
        return out;
    }
    out.push({ type: 'separator' });
    for (const e of rows) {
        if (e.kind === 'tab') {
            out.push({ label: clip(e.item.title || e.item.url), iconUrl: iconFor(e.item.url), click: () => reopenTab(wd, e.item) });
        }
        else {
            const n = e.item.tabs.length;
            const label = n === 1
                ? T('closed.window1', 'Window: {title}', { title: clip(e.item.tabs[0].title, 44) })
                : T('closed.windowN', 'Window: {title} and {more} more', { title: clip(e.item.tabs[0].title, 36), more: n - 1 });
            out.push({ label, iconUrl: iconFor(e.item.tabs[0].url), click: () => reopenWindow(wm, e.item) });
        }
    }
    return out;
}

module.exports = { recordWindow, entries, template, reopenTab, reopenWindow, _closedWindows: closedWindows };
