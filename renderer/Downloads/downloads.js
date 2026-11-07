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
        // A file-type icon: one Phosphor path (constant data, never user input).
        const fileIcon = (d) => '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="' + d + '"/></svg>';
        // Phosphor's own file icons (regular weight), the set and stroke every
        // other icon in the browser is drawn with.
        const ICONS = {
            image: fileIcon('M110.66,147.56a8,8,0,0,0-13.32,0L76.49,178.85l-9.76-15.18a8,8,0,0,0-13.46,0l-36,56A8,8,0,0,0,24,232H152a8,8,0,0,0,6.66-12.44ZM38.65,216,60,182.79l9.63,15a8,8,0,0,0,13.39.11l21-31.47L137.05,216Zm175-133.66-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40v88a8,8,0,0,0,16,0V40h88V88a8,8,0,0,0,8,8h48V216h-8a8,8,0,0,0,0,16h8a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34ZM160,51.31,188.69,80H160Z'),
            video: fileIcon('M213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40v72a8,8,0,0,0,16,0V40h88V88a8,8,0,0,0,8,8h48V216h-8a8,8,0,0,0,0,16h8a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34ZM160,51.31,188.69,80H160ZM155.88,145a8,8,0,0,0-8.12.22l-19.95,12.46A16,16,0,0,0,112,144H48a16,16,0,0,0-16,16v48a16,16,0,0,0,16,16h64a16,16,0,0,0,15.81-13.68l19.95,12.46A8,8,0,0,0,160,216V152A8,8,0,0,0,155.88,145ZM112,208H48V160h64v48Zm32-6.43-16-10V176.43l16-10Z'),
            audio: fileIcon('M99.06,128.61a8,8,0,0,0-8.72,1.73L68.69,152H48a8,8,0,0,0-8,8v40a8,8,0,0,0,8,8H68.69l21.65,21.66A8,8,0,0,0,104,224V136A8,8,0,0,0,99.06,128.61ZM88,204.69,77.66,194.34A8,8,0,0,0,72,192H56V168H72a8,8,0,0,0,5.66-2.34L88,155.31ZM152,180a40.55,40.55,0,0,1-20,34.91A8,8,0,0,1,124,201.09a24.49,24.49,0,0,0,0-42.18A8,8,0,0,1,132,145.09,40.55,40.55,0,0,1,152,180Zm61.66-97.66-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40v80a8,8,0,0,0,16,0V40h88V88a8,8,0,0,0,8,8h48V216H168a8,8,0,0,0,0,16h32a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34ZM160,51.31,188.69,80H160Z'),
            archive: fileIcon('M184,144H168a8,8,0,0,0-8,8v56a8,8,0,0,0,16,0v-8h8a28,28,0,0,0,0-56Zm0,40h-8V160h8a12,12,0,0,1,0,24Zm-48-32v56a8,8,0,0,1-16,0V152a8,8,0,0,1,16,0ZM96,208a8,8,0,0,1-8,8H56a8,8,0,0,1-7-12l25.16-44H56a8,8,0,0,1,0-16H88a8,8,0,0,1,7,12L69.79,200H88A8,8,0,0,1,96,208ZM213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40v72a8,8,0,0,0,16,0V40h88V88a8,8,0,0,0,8,8h48v16a8,8,0,0,0,16,0V88A8,8,0,0,0,213.66,82.34ZM160,80V51.31L188.69,80Z'),
            pdf: fileIcon('M224,152a8,8,0,0,1-8,8H192v16h16a8,8,0,0,1,0,16H192v16a8,8,0,0,1-16,0V152a8,8,0,0,1,8-8h32A8,8,0,0,1,224,152ZM92,172a28,28,0,0,1-28,28H56v8a8,8,0,0,1-16,0V152a8,8,0,0,1,8-8H64A28,28,0,0,1,92,172Zm-16,0a12,12,0,0,0-12-12H56v24h8A12,12,0,0,0,76,172Zm88,8a36,36,0,0,1-36,36H112a8,8,0,0,1-8-8V152a8,8,0,0,1,8-8h16A36,36,0,0,1,164,180Zm-16,0a20,20,0,0,0-20-20h-8v40h8A20,20,0,0,0,148,180ZM40,112V40A16,16,0,0,1,56,24h96a8,8,0,0,1,5.66,2.34l56,56A8,8,0,0,1,216,88v24a8,8,0,0,1-16,0V96H152a8,8,0,0,1-8-8V40H56v72a8,8,0,0,1-16,0ZM160,80h28.69L160,51.31Z'),
            doc: fileIcon('M213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34ZM160,51.31,188.69,80H160ZM200,216H56V40h88V88a8,8,0,0,0,8,8h48V216Zm-32-80a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,136Zm0,32a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,168Z'),
            code: fileIcon('M181.66,146.34a8,8,0,0,1,0,11.32l-24,24a8,8,0,0,1-11.32-11.32L164.69,152l-18.35-18.34a8,8,0,0,1,11.32-11.32Zm-72-24a8,8,0,0,0-11.32,0l-24,24a8,8,0,0,0,0,11.32l24,24a8,8,0,0,0,11.32-11.32L91.31,152l18.35-18.34A8,8,0,0,0,109.66,122.34ZM216,88V216a16,16,0,0,1-16,16H56a16,16,0,0,1-16-16V40A16,16,0,0,1,56,24h96a8,8,0,0,1,5.66,2.34l56,56A8,8,0,0,1,216,88Zm-56-8h28.69L160,51.31Zm40,136V96H152a8,8,0,0,1-8-8V40H56V216H200Z'),
            app: fileIcon('M223.68,66.15,135.68,18a15.88,15.88,0,0,0-15.36,0l-88,48.17a16,16,0,0,0-8.32,14v95.64a16,16,0,0,0,8.32,14l88,48.17a15.88,15.88,0,0,0,15.36,0l88-48.17a16,16,0,0,0,8.32-14V80.18A16,16,0,0,0,223.68,66.15ZM128,32l80.34,44-29.77,16.3-80.35-44ZM128,120,47.66,76l33.9-18.56,80.34,44ZM40,90l80,43.78v85.79L40,175.82Zm176,85.78h0l-80,43.79V133.82l32-17.51V152a8,8,0,0,0,16,0V107.55L216,90v85.77Z'),
            file: fileIcon('M213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34ZM160,51.31,188.69,80H160ZM200,216H56V40h88V88a8,8,0,0,0,8,8h48V216Z'),
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
        const SVG_FOLDER = '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M216,72H131.31L104,44.69A15.86,15.86,0,0,0,92.69,40H40A16,16,0,0,0,24,56V200.62A15.4,15.4,0,0,0,39.38,216H216.89A15.13,15.13,0,0,0,232,200.89V88A16,16,0,0,0,216,72ZM40,56H92.69l16,16H40ZM216,200H40V88H216Z"/></svg>';
        const SVG_CANCEL = '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z"/></svg>';
        const SVG_PAUSE = '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M200,32H160a16,16,0,0,0-16,16V208a16,16,0,0,0,16,16h40a16,16,0,0,0,16-16V48A16,16,0,0,0,200,32Zm0,176H160V48h40ZM96,32H56A16,16,0,0,0,40,48V208a16,16,0,0,0,16,16H96a16,16,0,0,0,16-16V48A16,16,0,0,0,96,32Zm0,176H56V48H96Z"/></svg>';
        const SVG_RESUME = '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M232.4,114.49,88.32,26.35a16,16,0,0,0-16.2-.3A15.86,15.86,0,0,0,64,39.87V216.13A15.94,15.94,0,0,0,80,232a16.07,16.07,0,0,0,8.36-2.35L232.4,141.51a15.81,15.81,0,0,0,0-27ZM80,215.94V40l143.83,88Z"/></svg>';
        const SVG_RETRY = '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M240,56v48a8,8,0,0,1-8,8H184a8,8,0,0,1,0-16H211.4L184.81,71.64l-.25-.24a80,80,0,1,0-1.67,114.78,8,8,0,0,1,11,11.63A95.44,95.44,0,0,1,128,224h-1.32A96,96,0,1,1,195.75,60L224,85.8V56a8,8,0,1,1,16,0Z"/></svg>';
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
