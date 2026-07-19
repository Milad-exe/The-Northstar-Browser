"use strict";
// IIFE: compiled as a classic <script>; the wrapper keeps this page's
// top-level names out of the shared global scope.
(() => {
    (function () {
        'use strict';
        const listEl = document.getElementById('list');
        const clearBtn = document.getElementById('clear-btn');
        // Base document outline shared by the file-type icons; `inner` draws the
        // glyph that identifies the type (folded corner + type mark).
        const fileIcon = (inner) => '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
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
        const SVG_FOLDER = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 5.5A1.5 1.5 0 0 1 3.5 4H8l2 2h6.5A1.5 1.5 0 0 1 18 7.5v7a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 2 14.5v-9z"/></svg>';
        const SVG_CANCEL = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M5 5l10 10M15 5L5 15"/></svg>';
        const SVG_PAUSE = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M7 4v12M13 4v12"/></svg>';
        const SVG_RESUME = '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M6 4l10 6-10 6V4z"/></svg>';
        const SVG_RETRY = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 10a6 6 0 1 1-1.76-4.24"/><path d="M16 2v4h-4"/></svg>';
        function fmtBytes(n) {
            if (!n || n < 0)
                return '0 B';
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
            b.className = 'dl-btn';
            b.title = title;
            b.innerHTML = svg;
            b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
            return b;
        }
        function render(items) {
            listEl.innerHTML = '';
            if (!items.length) {
                const empty = document.createElement('div');
                empty.className = 'empty';
                empty.textContent = 'No downloads yet';
                listEl.appendChild(empty);
                return;
            }
            items.forEach((item) => {
                const row = document.createElement('div');
                row.className = 'dl-item' + (item.state === 'completed' ? ' completed' : '');
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
                        ? makeBtn('Resume', SVG_RESUME, () => window.overlayDownloads.action('resume', item.id))
                        : makeBtn('Pause', SVG_PAUSE, () => window.overlayDownloads.action('pause', item.id)));
                    actions.appendChild(makeBtn('Cancel', SVG_CANCEL, () => window.overlayDownloads.action('cancel', item.id)));
                }
                else {
                    actions.appendChild(makeBtn('Show in folder', SVG_FOLDER, () => window.overlayDownloads.action('show-in-folder', item.id)));
                    actions.appendChild(makeBtn('Remove from list', SVG_CANCEL, () => window.overlayDownloads.action('remove', item.id)));
                }
                row.appendChild(actions);
                if (item.state === 'completed') {
                    row.addEventListener('click', () => window.overlayDownloads.action('open-file', item.id));
                }
                listEl.appendChild(row);
            });
        }
        clearBtn.addEventListener('click', () => window.overlayDownloads.action('clear-finished'));
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape')
                window.overlayDownloads.close();
        });
        window.overlayDownloads.onData(render);
        window.overlayDownloads.getAll().then(render).catch(() => { });
    })();
})();
