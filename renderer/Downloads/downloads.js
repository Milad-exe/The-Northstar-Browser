"use strict";
// IIFE: compiled as a classic <script>; the wrapper keeps this page's
// top-level names out of the shared global scope.
(() => {
    (function () {
        'use strict';
        const T = (key, fallback) => {
            try { const v = window.Northstar?.i18n?.t(key); return (v && v !== key) ? v : fallback; }
            catch (e) { return fallback; }
        };
        try {
            window.Northstar.i18n.init(window.northstarI18n?.getSync() || (window.northstarSettings?.getSync() || {}).i18n || {});
            window.Northstar.i18n.apply(document);
        }
        catch (e) { window.northstarLog?.debug('downloads', 'i18n: ' + e); }
        const listEl = document.getElementById('list');
        const clearBtn = document.getElementById('clear-btn');
        // Base document outline shared by the file-type icons; `inner` draws the
        // glyph that identifies the type (folded corner + type mark).
        const fileIcon = (inner) => '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M11 2H5.5A1.5 1.5 0 0 0 4 3.5v13A1.5 1.5 0 0 0 5.5 18h9a1.5 1.5 0 0 0 1.5-1.5V7l-5-5z"/><path d="M11 2v5h5"/>' +
            (inner || '') + '</svg>';
        const ICONS = {
            image: fileIcon('<circle cx="7.5" cy="11" r="1"/><path d="M6 15l2.2-2.2 1.4 1.4L12 12l2 3z"/>'),
            video: fileIcon('<path d="M7.5 11.5l4 2.2-4 2.2z" fill="currentColor" stroke="none"/>'),
            audio: fileIcon('<path d="M8 15.5v-4l3-.8v3.3"/><circle cx="7" cy="15.5" r="1"/><circle cx="11" cy="14.7" r="1"/>'),
            archive: fileIcon('<path d="M9 10v1M9 12v1M9 14v1.5"/>'),
            pdf: fileIcon('<path d="M6.5 15v-3.5h1a1 1 0 0 1 0 2h-1M11 15v-3.5h1.5M11 13.3h1.2" stroke-width="1.2"/>'),
            doc: fileIcon('<path d="M6.5 11.5h5M6.5 13.5h5M6.5 15.5h3"/>'),
            code: fileIcon('<path d="M8 11.5L6 13.5l2 2M11 11.5l2 2-2 2"/>'),
            app: fileIcon('<rect x="6.5" y="11.5" width="4" height="4" rx="0.6"/>'),
            file: fileIcon(''),
        };
        const EXT_MAP = {
            // images
            png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', bmp: 'image', ico: 'image', heic: 'image', avif: 'image', tiff: 'image',
            // video
            mp4: 'video', mkv: 'video', mov: 'video', avi: 'video', webm: 'video', flv: 'video', wmv: 'video', m4v: 'video',
            // audio
            mp3: 'audio', wav: 'audio', flac: 'audio', aac: 'audio', ogg: 'audio', m4a: 'audio', wma: 'audio',
            // archives
            zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive', bz2: 'archive', xz: 'archive', tgz: 'archive',
            // documents
            pdf: 'pdf',
            doc: 'doc', docx: 'doc', txt: 'doc', rtf: 'doc', odt: 'doc', md: 'doc', pages: 'doc',
            xls: 'doc', xlsx: 'doc', csv: 'doc', ppt: 'doc', pptx: 'doc',
            // code
            js: 'code', ts: 'code', jsx: 'code', tsx: 'code', json: 'code', html: 'code', css: 'code', py: 'code', java: 'code', c: 'code', cpp: 'code', h: 'code', rs: 'code', go: 'code', rb: 'code', php: 'code', sh: 'code', xml: 'code', yml: 'code', yaml: 'code',
            // executables / installers
            dmg: 'app', pkg: 'app', exe: 'app', msi: 'app', apk: 'app', deb: 'app', rpm: 'app', appimage: 'app',
        };
        function iconForFilename(name) {
            const dot = (name || '').lastIndexOf('.');
            const ext = dot > -1 ? name.slice(dot + 1).toLowerCase() : '';
            return ICONS[EXT_MAP[ext]] || ICONS.file;
        }
        const SVG_FOLDER = '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M216,68H133.39l-26-29.29a20,20,0,0,0-15-6.71H40A20,20,0,0,0,20,52V200.62A19.41,19.41,0,0,0,39.38,220H216.89A19.13,19.13,0,0,0,236,200.89V88A20,20,0,0,0,216,68ZM44,56H90.61l10.67,12H44ZM212,196H44V92H212Z"/></svg>';
        const SVG_CANCEL = '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M208.49,191.51a12,12,0,0,1-17,17L128,145,64.49,208.49a12,12,0,0,1-17-17L111,128,47.51,64.49a12,12,0,0,1,17-17L128,111l63.51-63.52a12,12,0,0,1,17,17L145,128Z"/></svg>';
        const SVG_PAUSE = '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M200,28H160a20,20,0,0,0-20,20V208a20,20,0,0,0,20,20h40a20,20,0,0,0,20-20V48A20,20,0,0,0,200,28Zm-4,176H164V52h32ZM96,28H56A20,20,0,0,0,36,48V208a20,20,0,0,0,20,20H96a20,20,0,0,0,20-20V48A20,20,0,0,0,96,28ZM92,204H60V52H92Z"/></svg>';
        const SVG_RESUME = '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M234.49,111.07,90.41,22.94A20,20,0,0,0,60,39.87V216.13a20,20,0,0,0,30.41,16.93l144.08-88.13a19.82,19.82,0,0,0,0-33.86ZM84,208.85V47.15L216.16,128Z"/></svg>';
        const SVG_RETRY = '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M244,56v48a12,12,0,0,1-12,12H184a12,12,0,1,1,0-24H201.1l-19-17.38c-.13-.12-.26-.24-.38-.37A76,76,0,1,0,127,204h1a75.53,75.53,0,0,0,52.15-20.72,12,12,0,0,1,16.49,17.45A99.45,99.45,0,0,1,128,228h-1.37A100,100,0,1,1,198.51,57.06L220,76.72V56a12,12,0,0,1,24,0Z"/></svg>';
        // Sizes follow the user's locale (1,5 MB vs 1.5 MB) — see
        // renderer/lib/i18n.js. Falls back to the plain format if the shared
        // module is not loaded on this page.
        function fmtBytes(n) {
            if (!n || n < 0)
                return '0 B';
            if (window.Northstar?.i18n)
                return window.Northstar.i18n.bytes(n);
            const units = ['B', 'KB', 'MB', 'GB', 'TB'];
            let i = 0;
            while (n >= 1024 && i < units.length - 1) {
                n /= 1024;
                i++;
            }
            return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
        }
        function statusText(item) {
            switch (item.state) {
                case 'progressing':
                    if (item.paused)
                        return `Paused — ${fmtBytes(item.receivedBytes)} of ${fmtBytes(item.totalBytes)}`;
                    return item.totalBytes > 0
                        ? `${fmtBytes(item.receivedBytes)} of ${fmtBytes(item.totalBytes)}`
                        : `${fmtBytes(item.receivedBytes)}`;
                case 'completed': return fmtBytes(item.totalBytes || item.receivedBytes);
                case 'cancelled': return 'Cancelled';
                case 'interrupted': return 'Failed';
                default: return '';
            }
        }
        function makeBtn(title, svg, onClick) {
            const b = document.createElement('button');
            b.className = 'surface-icon-btn dl-btn';
            b.title = title;
            b.innerHTML = svg;
            b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
            return b;
        }
        function render(items) {
            listEl.innerHTML = '';
            if (!items.length) {
                const empty = document.createElement('div');
                empty.className = 'surface-empty';
                const t = document.createElement('div');
                t.className = 'empty-title';
                t.textContent = T('downloads.empty', 'No downloads yet');
                const h = document.createElement('div');
                h.className = 'empty-hint';
                h.textContent = T('downloads.emptyHint', 'Files you download appear here.');
                empty.append(t, h);
                listEl.appendChild(empty);
                return;
            }
            items.forEach((item) => {
                const row = document.createElement('div');
                row.className = 'surface-row dl-item' + (item.state === 'completed' ? ' completed' : '');
                row.setAttribute('role', 'listitem');
                row.title = item.url || '';
                const icon = document.createElement('span');
                icon.className = 'dl-icon';
                icon.innerHTML = iconForFilename(item.filename);
                row.appendChild(icon);
                const info = document.createElement('div');
                info.className = 'dl-info';
                const name = document.createElement('span');
                name.className = 'dl-name';
                name.textContent = item.filename;
                info.appendChild(name);
                if (item.state === 'progressing' && item.totalBytes > 0) {
                    const bar = document.createElement('div');
                    bar.className = 'dl-progress';
                    const fill = document.createElement('div');
                    fill.className = 'dl-progress-fill';
                    fill.style.width = `${Math.min(100, (item.receivedBytes / item.totalBytes) * 100)}%`;
                    bar.appendChild(fill);
                    info.appendChild(bar);
                }
                const status = document.createElement('span');
                status.className = 'dl-status' + (item.state === 'interrupted' ? ' error' : '');
                status.textContent = statusText(item);
                info.appendChild(status);
                row.appendChild(info);
                const actions = document.createElement('div');
                actions.className = 'dl-actions';
                if (item.state === 'progressing') {
                    actions.appendChild(item.paused
                        ? makeBtn(T('downloads.resume', 'Resume'), SVG_RESUME, () => window.overlayDownloads.action('resume', item.id))
                        : makeBtn(T('downloads.pause', 'Pause'), SVG_PAUSE, () => window.overlayDownloads.action('pause', item.id)));
                    actions.appendChild(makeBtn(T('downloads.cancel', 'Cancel'), SVG_CANCEL, () => window.overlayDownloads.action('cancel', item.id)));
                }
                else {
                    actions.appendChild(makeBtn(T('downloads.showInFolder', 'Show in folder'), SVG_FOLDER, () => window.overlayDownloads.action('show-in-folder', item.id)));
                    actions.appendChild(makeBtn(T('downloads.removeFromList', 'Remove from list'), SVG_CANCEL, () => window.overlayDownloads.action('remove', item.id)));
                }
                row.appendChild(actions);
                if (item.state === 'completed') {
                    if (item.dangerous) {
                        // Executable/script (P1-5): a warning row that takes two
                        // deliberate clicks. The first arms "Keep and open?"; only
                        // the second sends the confirmed open. Opening is refused
                        // in main without that flag, so this is belt-and-braces.
                        row.classList.add('dangerous');
                        row.title = T('downloads.dangerousHint', 'This type of file can harm your device. Only open it if you trust the source.');
                        row.addEventListener('click', () => {
                            if (row.dataset.armed === '1') {
                                window.overlayDownloads.action('open-file', item.id, true);
                            }
                            else {
                                row.dataset.armed = '1';
                                status.textContent = T('downloads.keepAndOpen', 'Keep and open?');
                                status.classList.add('warn');
                            }
                        });
                    }
                    else {
                        row.addEventListener('click', () => window.overlayDownloads.action('open-file', item.id));
                    }
                }
                listEl.appendChild(row);
            });
        }
        clearBtn.addEventListener('click', () => window.overlayDownloads.action('clear-finished'));
        document.getElementById('show-all')
            ?.addEventListener('click', () => window.overlayDownloads.action('show-all'));
        window.Northstar?.keys?.rows(document, { selector: '.dl-item, #show-all', typeahead: false });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape')
                window.overlayDownloads.close();
        });
        window.overlayDownloads.onData(render);
        window.overlayDownloads.getAll().then(render).catch(() => { });
    })();
})();
// Overlay enter/exit motion (P1-6): fade the card in on show, play the close
// fade on hide then let main hide the view. No-ops cleanly if the bits are
// missing (card stays visible), and collapses under reduced motion.
(function () {
    try {
        var card = document.getElementById('panel');
        var SA = window.Northstar && window.Northstar.surfaceAnim;
        if (card && SA && window.overlayAnim) {
            window.overlayAnim.onEnter(function () { SA.enterCard(card); });
            window.overlayAnim.onLeave(function () { SA.exitCard(card, function () { window.overlayAnim.leaveDone(); }); });
        }
    }
    catch (e) { /* animation is non-essential */ }
})();
