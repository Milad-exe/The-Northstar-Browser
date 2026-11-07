"use strict";
// Bookmarks — folders as sections, bookmarks as rows, filterable.
//
// The old page rendered folders and bookmarks as identical rows, so a folder
// read as a bookmark with a missing URL, and there was no way to search.
(() => {
    document.addEventListener('DOMContentLoaded', async () => {
        const listEl = document.getElementById('list');
        const searchEl = document.getElementById('search');
        const countEl = document.getElementById('count');
        const i18n = window.Northstar?.i18n;
        try { i18n?.init((window.northstarSettings?.getSync() || {}).i18n || {}); i18n?.apply(document); }
        catch (e) { window.northstarLog?.debug('bookmarks', 'i18n: ' + e); }
        // t() falls through to the key when a string is missing, so a plain
        // `|| fallback` never fires. This one checks for that.
        const T = (key, fallback) => {
            const v = i18n?.t(key);
            return (!v || v === key) ? fallback : v;
        };

        const FOLDER_SVG = '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M216,72H131.31L104,44.69A15.86,15.86,0,0,0,92.69,40H40A16,16,0,0,0,24,56V200.62A15.4,15.4,0,0,0,39.38,216H216.89A15.13,15.13,0,0,0,232,200.89V88A16,16,0,0,0,216,72ZM40,56H92.69l16,16H40ZM216,200H40V88H216Z"/></svg>';

        let tree = [];
        const load = async () => {
            try { tree = await window.browserBookmarks.getAll() || []; }
            catch (e) { window.northstarLog?.debug('bookmarks', 'load: ' + e); tree = []; }
        };

        const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };

        function makeRow(entry) {
            const row = document.createElement('div');
            row.className = 'list-row';
            row.tabIndex = 0;
            row.setAttribute('role', 'link');

            const host = hostOf(entry.url);
            const fallback = document.createElement('span');
            fallback.className = 'icon-fallback';
            fallback.textContent = (host || '·').charAt(0).toUpperCase();
            row.appendChild(fallback);
            (async () => {
                try {
                    const data = await window.faviconCache?.get(host);
                    if (!data) return;
                    const img = document.createElement('img');
                    img.className = 'icon';
                    img.src = data;
                    img.alt = '';
                    fallback.replaceWith(img);
                }
                catch (e) { window.northstarLog?.debug('bookmarks', 'favicon: ' + e); }
            })();

            const text = document.createElement('div');
            text.className = 'text';
            const title = document.createElement('div');
            title.className = 'title';
            title.textContent = entry.title || host || entry.url;
            const sub = document.createElement('div');
            sub.className = 'sub';
            sub.textContent = entry.url;
            text.append(title, sub);
            row.appendChild(text);

            const remove = document.createElement('button');
            remove.className = 'row-action';
            remove.title = T('bookmarks.remove', 'Remove bookmark');
            remove.innerHTML = '<svg width="13" height="13" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z"/></svg>';
            remove.addEventListener('click', async (e) => {
                e.stopPropagation();
                try {
                    if (entry.id) await window.browserBookmarks.removeById(entry.id);
                    else await window.browserBookmarks.remove(entry.url);
                    await load();
                    render(searchEl.value);
                }
                catch (err) { window.northstarLog?.debug('bookmarks', 'remove: ' + err); }
            });
            row.appendChild(remove);

            const open = () => {
                if (!entry.url) return;
                if (entry.profile && window.tab?.openInContainer)
                    window.tab.openInContainer(entry.profile, entry.url);
                else
                    window.electronAPI.navigateActiveTab(entry.url);
            };
            row.addEventListener('click', open);
            row.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
            });
            return row;
        }

        function matches(entry, q) {
            if (!q) return true;
            return (entry.title || '').toLowerCase().includes(q) || (entry.url || '').toLowerCase().includes(q);
        }

        function section(labelText, items, isFolder) {
            const wrap = document.createElement('section');
            if (labelText) {
                const label = document.createElement('div');
                label.className = isFolder ? 'folder-label' : 'group-label';
                if (isFolder) {
                    const glyph = document.createElement('span');
                    glyph.innerHTML = FOLDER_SVG;
                    label.appendChild(glyph.firstChild);
                }
                label.append(labelText);
                const n = document.createElement('span');
                n.className = 'n';
                n.textContent = String(items.length);
                label.appendChild(n);
                wrap.appendChild(label);
            }
            const card = document.createElement('div');
            card.className = 'card';
            items.forEach(item => card.appendChild(makeRow(item)));
            wrap.appendChild(card);
            return wrap;
        }

        function render(query = '') {
            const q = query.trim().toLowerCase();
            listEl.textContent = '';
            const loose = tree.filter(e => e.type !== 'folder' && e.type !== 'divider' && matches(e, q));
            const folders = tree
                .filter(e => e.type === 'folder')
                .map(f => ({ ...f, children: (f.children || []).filter(c => c.type !== 'divider' && matches(c, q)) }))
                .filter(f => f.children.length || (!q && true));

            const total = loose.length + folders.reduce((n, f) => n + f.children.length, 0);
            countEl.textContent = total
                ? (total === 1
                    ? T('bookmarks.countOne', '1 bookmark')
                    : T('bookmarks.count', '{n} bookmarks').replace('{n}', i18n ? i18n.number(total) : total))
                : '';

            if (!total) {
                const empty = document.createElement('div');
                empty.className = 'page-empty';
                const strong = document.createElement('strong');
                strong.textContent = q
                    ? (T('bookmarks.noMatches', 'No matching bookmarks'))
                    : (T('bookmarks.empty', 'No bookmarks yet'));
                empty.append(strong, q
                    ? (T('bookmarks.noMatchesHint', 'Try a different word.'))
                    : (T('bookmarks.emptyHint', 'Press Ctrl+D, or the star in the address bar, to keep a page.')));
                listEl.appendChild(empty);
                return;
            }

            if (loose.length)
                listEl.appendChild(section(null, loose, false));
            for (const folder of folders) {
                if (!folder.children.length) continue;
                listEl.appendChild(section(folder.title || 'Folder', folder.children, true));
            }
        }

        searchEl.addEventListener('input', () => render(searchEl.value));
        window.browserBookmarks.onChanged?.(async () => { await load(); render(searchEl.value); });
        await load();
        render();
    });
})();
