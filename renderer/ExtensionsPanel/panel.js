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
    const PIN_SVG = `<svg width="13" height="13" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M235.32,81.37,174.63,20.69a16,16,0,0,0-22.63,0L98.37,74.49c-10.66-3.34-35-7.37-60.4,13.14a16,16,0,0,0-1.29,23.78L85,159.71,42.34,202.34a8,8,0,0,0,11.32,11.32L96.29,171l48.29,48.29A16,16,0,0,0,155.9,224c.38,0,.75,0,1.13,0a15.93,15.93,0,0,0,11.64-6.33c19.64-26.1,17.75-47.32,13.19-60L235.33,104A16,16,0,0,0,235.32,81.37ZM224,92.69h0l-57.27,57.46a8,8,0,0,0-1.49,9.22c9.46,18.93-1.8,38.59-9.34,48.62L48,100.08c12.08-9.74,23.64-12.31,32.48-12.31A40.13,40.13,0,0,1,96.81,91a8,8,0,0,0,9.25-1.51L163.32,32,224,92.68Z"/></svg>`;
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
                opts.innerHTML = '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M128,80a48,48,0,1,0,48,48A48.05,48.05,0,0,0,128,80Zm0,80a32,32,0,1,1,32-32A32,32,0,0,1,128,160Zm88-29.84q.06-2.16,0-4.32l14.92-18.64a8,8,0,0,0,1.48-7.06,107.21,107.21,0,0,0-10.88-26.25,8,8,0,0,0-6-3.93l-23.72-2.64q-1.48-1.56-3-3L186,40.54a8,8,0,0,0-3.94-6,107.71,107.71,0,0,0-26.25-10.87,8,8,0,0,0-7.06,1.49L130.16,40Q128,40,125.84,40L107.2,25.11a8,8,0,0,0-7.06-1.48A107.6,107.6,0,0,0,73.89,34.51a8,8,0,0,0-3.93,6L67.32,64.27q-1.56,1.49-3,3L40.54,70a8,8,0,0,0-6,3.94,107.71,107.71,0,0,0-10.87,26.25,8,8,0,0,0,1.49,7.06L40,125.84Q40,128,40,130.16L25.11,148.8a8,8,0,0,0-1.48,7.06,107.21,107.21,0,0,0,10.88,26.25,8,8,0,0,0,6,3.93l23.72,2.64q1.49,1.56,3,3L70,215.46a8,8,0,0,0,3.94,6,107.71,107.71,0,0,0,26.25,10.87,8,8,0,0,0,7.06-1.49L125.84,216q2.16.06,4.32,0l18.64,14.92a8,8,0,0,0,7.06,1.48,107.21,107.21,0,0,0,26.25-10.88,8,8,0,0,0,3.93-6l2.64-23.72q1.56-1.48,3-3L215.46,186a8,8,0,0,0,6-3.94,107.71,107.71,0,0,0,10.87-26.25,8,8,0,0,0-1.49-7.06Zm-16.1-6.5a73.93,73.93,0,0,1,0,8.68,8,8,0,0,0,1.74,5.48l14.19,17.73a91.57,91.57,0,0,1-6.23,15L187,173.11a8,8,0,0,0-5.1,2.64,74.11,74.11,0,0,1-6.14,6.14,8,8,0,0,0-2.64,5.1l-2.51,22.58a91.32,91.32,0,0,1-15,6.23l-17.74-14.19a8,8,0,0,0-5-1.75h-.48a73.93,73.93,0,0,1-8.68,0,8,8,0,0,0-5.48,1.74L100.45,215.8a91.57,91.57,0,0,1-15-6.23L82.89,187a8,8,0,0,0-2.64-5.1,74.11,74.11,0,0,1-6.14-6.14,8,8,0,0,0-5.1-2.64L46.43,170.6a91.32,91.32,0,0,1-6.23-15l14.19-17.74a8,8,0,0,0,1.74-5.48,73.93,73.93,0,0,1,0-8.68,8,8,0,0,0-1.74-5.48L40.2,100.45a91.57,91.57,0,0,1,6.23-15L69,82.89a8,8,0,0,0,5.1-2.64,74.11,74.11,0,0,1,6.14-6.14A8,8,0,0,0,82.89,69L85.4,46.43a91.32,91.32,0,0,1,15-6.23l17.74,14.19a8,8,0,0,0,5.48,1.74,73.93,73.93,0,0,1,8.68,0,8,8,0,0,0,5.48-1.74L155.55,40.2a91.57,91.57,0,0,1,15,6.23L173.11,69a8,8,0,0,0,2.64,5.1,74.11,74.11,0,0,1,6.14,6.14,8,8,0,0,0,5.1,2.64l22.58,2.51a91.32,91.32,0,0,1,6.23,15l-14.19,17.74A8,8,0,0,0,199.87,123.66Z"/></svg>';
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
            rm.innerHTML = '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z"/></svg>';
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
