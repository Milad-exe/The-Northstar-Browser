"use strict";
// IIFE: compiled as a classic <script>; the wrapper keeps this page's
// top-level names out of the shared global scope.
//
// Management panel: each row pins/unpins the extension to the toolbar,
// toggles it, opens options, or removes it. Extensions are RUN by clicking
// their pinned toolbar icon — the row itself never activates, so aiming for a
// control can't accidentally open a popup. The footer links to the Web Store.
(() => {
    const T = (key, fallback) => {
        try { const v = window.Northstar?.i18n?.t(key); return (v && v !== key) ? v : fallback; }
        catch (e) { return fallback; }
    };
    try {
        window.Northstar.i18n.init(window.northstarI18n?.getSync() || (window.northstarSettings?.getSync() || {}).i18n || {});
        window.Northstar.i18n.apply(document);
    }
    catch (e) { window.northstarLog?.debug('extpanel', 'i18n: ' + e); }
    const listEl = document.getElementById('list');
    const PIN_SVG = `<svg width="13" height="13" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M238.15,78.54,177.46,17.86a20,20,0,0,0-28.3,0L97.2,70c-12.43-3.33-36.68-5.72-61.74,14.5a20,20,0,0,0-1.6,29.73l45.46,45.47-39.8,39.8a12,12,0,0,0,17,17l39.8-39.81,45.47,45.46A20,20,0,0,0,155.91,228c.46,0,.93,0,1.4-.05A20,20,0,0,0,171.87,220c4.69-6.23,11-16.13,14.44-28s3.45-22.88.16-33.4l51.7-51.87A20,20,0,0,0,238.15,78.54Zm-74.26,68.79a12,12,0,0,0-2.23,13.84c3.43,6.86,6.9,21-6.28,40.65L54.08,100.53c21.09-14.59,39.53-6.64,41-6a11.67,11.67,0,0,0,13.81-2.29l54.43-54.61,55,55Z"/></svg>`;
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            window.extPanel.close();
        }
    });
    function render(items) {
        listEl.textContent = '';
        if (!items || items.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'surface-empty';
            const t = document.createElement('div');
            t.className = 'empty-title';
            t.textContent = T('ext.empty', 'No extensions yet');
            const h = document.createElement('div');
            h.className = 'empty-hint';
            h.textContent = T('ext.emptyHint', 'Installed extensions are managed here.');
            empty.append(t, h);
            listEl.appendChild(empty);
            return;
        }
        for (const ext of items) {
            const row = document.createElement('div');
            row.className = 'surface-row ext-row';
            row.title = ext.description || ext.name;
            const icon = document.createElement('div');
            icon.className = 'ext-icon';
            if (ext.icon) {
                const img = document.createElement('img');
                img.src = ext.icon;
                img.className = 'ext-icon-img';
                if (!ext.enabled)
                    img.style.filter = 'grayscale(1) opacity(0.5)';
                icon.appendChild(img);
            }
            else {
                icon.classList.add('ext-icon-blank');
            }
            row.appendChild(icon);
            const meta = document.createElement('div');
            meta.className = 'ext-meta';
            const name = document.createElement('div');
            name.className = 'ext-name' + (ext.enabled ? '' : ' is-off');
            name.textContent = ext.name;
            const ver = document.createElement('div');
            ver.className = 'ext-sub';
            ver.textContent = 'v' + (ext.version || '?')
                + (ext.enabled ? '' : ' · off')
                + (ext.pinned ? '' : ' · unpinned');
            meta.appendChild(name);
            meta.appendChild(ver);
            row.appendChild(meta);
            const control = (el, handler) => {
                el.addEventListener('click', (e) => { e.stopPropagation(); handler(); });
                return el;
            };
            // Pin / unpin — a real 26px button so it's an easy, unambiguous target.
            const pin = document.createElement('button');
            pin.className = 'surface-icon-btn ext-pin' + (ext.pinned ? ' is-pinned' : '');
            pin.title = ext.pinned ? T('ext.unpin', 'Pinned to the toolbar — click to unpin') : T('ext.pin', 'Pin to the toolbar');
            pin.innerHTML = PIN_SVG;
            control(pin, () => window.extPanel.setPinned(ext.id, !ext.pinned));
            row.appendChild(pin);
            if (ext.optionsUrl && ext.enabled) {
                const opts = document.createElement('button');
                opts.className = 'surface-icon-btn';
                opts.title = T('ext.options', 'Extension options');
                opts.innerHTML = '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M128,76a52,52,0,1,0,52,52A52.06,52.06,0,0,0,128,76Zm0,80a28,28,0,1,1,28-28A28,28,0,0,1,128,156Zm92-27.21v-1.58l14-17.51a12,12,0,0,0,2.23-10.59A111.75,111.75,0,0,0,225,71.89,12,12,0,0,0,215.89,66L193.61,63.5l-1.11-1.11L190,40.1A12,12,0,0,0,184.11,31a111.67,111.67,0,0,0-27.23-11.27A12,12,0,0,0,146.3,22L128.79,36h-1.58L109.7,22a12,12,0,0,0-10.59-2.23A111.75,111.75,0,0,0,71.89,31.05,12,12,0,0,0,66,40.11L63.5,62.39,62.39,63.5,40.1,66A12,12,0,0,0,31,71.89,111.67,111.67,0,0,0,19.77,99.12,12,12,0,0,0,22,109.7l14,17.51v1.58L22,146.3a12,12,0,0,0-2.23,10.59,111.75,111.75,0,0,0,11.29,27.22A12,12,0,0,0,40.11,190l22.28,2.48,1.11,1.11L66,215.9A12,12,0,0,0,71.89,225a111.67,111.67,0,0,0,27.23,11.27A12,12,0,0,0,109.7,234l17.51-14h1.58l17.51,14a12,12,0,0,0,10.59,2.23A111.75,111.75,0,0,0,184.11,225a12,12,0,0,0,5.91-9.06l2.48-22.28,1.11-1.11L215.9,190a12,12,0,0,0,9.06-5.91,111.67,111.67,0,0,0,11.27-27.23A12,12,0,0,0,234,146.3Zm-24.12-4.89a70.1,70.1,0,0,1,0,8.2,12,12,0,0,0,2.61,8.22l12.84,16.05A86.47,86.47,0,0,1,207,166.86l-20.43,2.27a12,12,0,0,0-7.65,4,69,69,0,0,1-5.8,5.8,12,12,0,0,0-4,7.65L166.86,207a86.47,86.47,0,0,1-10.49,4.35l-16.05-12.85a12,12,0,0,0-7.5-2.62c-.24,0-.48,0-.72,0a70.1,70.1,0,0,1-8.2,0,12.06,12.06,0,0,0-8.22,2.6L99.63,211.33A86.47,86.47,0,0,1,89.14,207l-2.27-20.43a12,12,0,0,0-4-7.65,69,69,0,0,1-5.8-5.8,12,12,0,0,0-7.65-4L49,166.86a86.47,86.47,0,0,1-4.35-10.49l12.84-16.05a12,12,0,0,0,2.61-8.22,70.1,70.1,0,0,1,0-8.2,12,12,0,0,0-2.61-8.22L44.67,99.63A86.47,86.47,0,0,1,49,89.14l20.43-2.27a12,12,0,0,0,7.65-4,69,69,0,0,1,5.8-5.8,12,12,0,0,0,4-7.65L89.14,49a86.47,86.47,0,0,1,10.49-4.35l16.05,12.85a12.06,12.06,0,0,0,8.22,2.6,70.1,70.1,0,0,1,8.2,0,12,12,0,0,0,8.22-2.6l16.05-12.85A86.47,86.47,0,0,1,166.86,49l2.27,20.43a12,12,0,0,0,4,7.65,69,69,0,0,1,5.8,5.8,12,12,0,0,0,7.65,4L207,89.14a86.47,86.47,0,0,1,4.35,10.49l-12.84,16.05A12,12,0,0,0,195.88,123.9Z"/></svg>';
                control(opts, () => window.extPanel.openOptions(ext.id));
                row.appendChild(opts);
            }
            // The shared switch (ui.css), so an extension's on/off looks and
            // behaves like every other switch in the browser — and unlike the
            // <div> it replaces, the keyboard can reach and announce it.
            const toggle = document.createElement('label');
            toggle.className = 'toggle';
            toggle.title = ext.enabled ? T('ext.disable', 'Disable') : T('ext.enable', 'Enable');
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.checked = !!ext.enabled;
            box.setAttribute('aria-label', ext.name);
            const track = document.createElement('span');
            track.className = 'switch-track';
            toggle.append(box, track);
            box.addEventListener('change', async () => {
                await window.extPanel.setEnabled(ext.id, box.checked);
                refresh();
            });
            row.appendChild(toggle);
            const rm = document.createElement('button');
            rm.className = 'surface-icon-btn ext-remove';
            rm.title = T('ext.remove', 'Remove extension');
            rm.innerHTML = '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M208.49,191.51a12,12,0,0,1-17,17L128,145,64.49,208.49a12,12,0,0,1-17-17L111,128,47.51,64.49a12,12,0,0,1,17-17L128,111l63.51-63.52a12,12,0,0,1,17,17L145,128Z"/></svg>';
            control(rm, async () => { await window.extPanel.remove(ext.id); refresh(); });
            row.appendChild(rm);
            listEl.appendChild(row);
        }
    }
    // DevTools-panel extensions have no DevTools frontend to live in, so their
    // panels are listed here and open in the side panel instead.
    function renderDevtools(panels) {
        if (!panels || !panels.length)
            return;
        const head = document.createElement('div');
        head.className = 'surface-label';
        head.textContent = T('ext.devtoolsPanels', 'DevTools panels');
        listEl.appendChild(head);
        for (const p of panels) {
            const row = document.createElement('button');
            row.className = 'surface-row dt-row';
            row.title = `Open “${p.title}” from ${p.extensionName || p.extensionId}`;
            const meta = document.createElement('div');
            meta.className = 'ext-meta';
            const name = document.createElement('div');
            name.className = 'ext-name';
            name.textContent = p.title;
            const sub = document.createElement('div');
            sub.className = 'ext-sub';
            sub.textContent = p.extensionName || p.extensionId;
            meta.appendChild(name);
            meta.appendChild(sub);
            row.appendChild(meta);
            const arrow = document.createElement('span');
            arrow.className = 'ext-arrow';
            arrow.textContent = '→';
            row.appendChild(arrow);
            row.addEventListener('click', () => {
                window.extPanel.openDevtoolsPanel(p.id);
                window.extPanel.close();
            });
            listEl.appendChild(row);
        }
    }
    // The panel's height is decided by main BEFORE this content exists, from a
    // fixed per-row estimate — which clipped the last row as soon as rows of
    // different heights (the DevTools section) appeared. Measure what actually
    // rendered and let main resize to fit.
    function syncHeight() {
        try {
            const panel = document.getElementById('panel');
            const list = document.getElementById('list');
            if (!panel || !list || !window.extPanel.setHeight)
                return;
            // #panel is h-screen + overflow-hidden, so its own scrollHeight can
            // never exceed the current view height — measuring it just reports
            // back the size we already have. #list is the scrolling element, so
            // the height we want is the chrome around it plus its full content.
            const chromeH = panel.clientHeight - list.clientHeight;
            window.extPanel.setHeight(Math.ceil(chromeH + list.scrollHeight));
        }
        catch (e) { window.northstarLog?.debug('panel', 'syncHeight: ' + e); }
    }
    // render() clears the list, so the devtools section is always appended after
    // it — never on its own.
    async function appendDevtools() {
        try {
            renderDevtools(await window.extPanel.devtoolsPanels());
        }
        catch (e) { window.northstarLog?.debug('panel', 'appendDevtools: ' + e); }
        syncHeight();
    }
    async function refresh() {
        try {
            render(await window.extPanel.list());
        }
        catch (e) { window.northstarLog?.debug('panel', 'refresh: ' + e); }
        await appendDevtools();
    }
    window.extPanel.onData((items) => { render(items); appendDevtools(); });
    document.getElementById('close-btn').addEventListener('click', () => window.extPanel.close());
    document.getElementById('store-link').addEventListener('click', (e) => {
        e.preventDefault();
        window.extPanel.openStore();
        window.extPanel.close();
    });
    // Rows here are not activatable — the controls inside them are — so Tab
    // walks the controls and only Escape is wired at the panel level.
    window.Northstar?.keys?.rows(document, { selector: '.dt-row, #store-link', typeahead: false });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape')
        window.extPanel.close(); });
    refresh();
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
