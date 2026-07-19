// IIFE: compiled as a classic <script>; the wrapper keeps this page's
// top-level names out of the shared global scope.
//
// Management panel: each row pins/unpins the extension to the toolbar,
// toggles it, opens options, or removes it. Extensions are RUN by clicking
// their pinned toolbar icon — the row itself never activates, so aiming for a
// control can't accidentally open a popup. The footer links to the Web Store.
(() => {
    const listEl = document.getElementById('list');

    const PIN_SVG = `<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path d="M9.5 1.5l5 5-1.5 1.5-.75-.25L9.5 10.5l.25 2.75L8.5 14.5 5 11 2 14l-1-1 3-3-3.5-3.5 1.25-1.25 2.75.25 2.75-2.75-.25-.75L9.5 1.5z"/></svg>`;

    function render(items) {
        listEl.textContent = '';

        if (!items || items.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'px-3.5 py-5 text-center text-[12px] italic text-tertiary';
            empty.textContent = 'No extensions installed';
            listEl.appendChild(empty);
            return;
        }

        for (const ext of items) {
            const row = document.createElement('div');
            row.className = 'flex items-center gap-2.5 border-b border-subtle px-3.5 py-2.5';
            row.title = ext.description || ext.name;

            const icon = document.createElement('div');
            icon.className = 'h-5 w-5 flex-shrink-0';
            if (ext.icon) {
                const img = document.createElement('img');
                img.src = ext.icon;
                img.className = 'h-5 w-5';
                if (!ext.enabled) img.style.filter = 'grayscale(1) opacity(0.5)';
                icon.appendChild(img);
            } else {
                icon.classList.add('border', 'border-strong', 'bg-surface-2');
            }
            row.appendChild(icon);

            const meta = document.createElement('div');
            meta.className = 'min-w-0 flex-1';
            const name = document.createElement('div');
            name.className = 'truncate text-[12.5px] font-medium' + (ext.enabled ? '' : ' text-tertiary');
            name.textContent = ext.name;
            const ver = document.createElement('div');
            ver.className = 'font-mono text-[10px] text-tertiary';
            ver.textContent = 'v' + (ext.version || '?')
                + (ext.enabled ? '' : ' · off')
                + (ext.pinned ? '' : ' · unpinned');
            meta.appendChild(name); meta.appendChild(ver);
            row.appendChild(meta);

            const control = (el, handler) => {
                el.addEventListener('click', (e) => { e.stopPropagation(); handler(); });
                return el;
            };

            // Pin / unpin — a real 26px button so it's an easy, unambiguous target.
            const pin = document.createElement('button');
            pin.tabIndex = -1;
            pin.className = 'ext-pin flex h-[26px] w-[26px] flex-shrink-0 cursor-pointer items-center justify-center border-0 hover:bg-hover'
                + (ext.pinned ? ' pinned text-accent' : ' text-tertiary');
            pin.style.background = ext.pinned ? 'var(--active-bg)' : 'transparent';
            pin.title = ext.pinned ? 'Pinned to toolbar — click to unpin' : 'Pin to toolbar';
            pin.innerHTML = PIN_SVG;
            control(pin, () => window.extPanel.setPinned(ext.id, !ext.pinned));
            row.appendChild(pin);

            if (ext.optionsUrl && ext.enabled) {
                const opts = document.createElement('button');
                opts.tabIndex = -1;
                opts.className = 'flex h-[26px] w-[22px] flex-shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent text-[13px] text-tertiary hover:text-primary';
                opts.title = 'Extension options';
                opts.textContent = '⚙';
                control(opts, () => window.extPanel.openOptions(ext.id));
                row.appendChild(opts);
            }

            const toggle = document.createElement('div');
            toggle.className = 'ext-toggle flex-shrink-0' + (ext.enabled ? ' on' : '');
            toggle.title = ext.enabled ? 'Disable' : 'Enable';
            control(toggle, async () => { await window.extPanel.setEnabled(ext.id, !ext.enabled); refresh(); });
            row.appendChild(toggle);

            const rm = document.createElement('button');
            rm.tabIndex = -1;
            rm.className = 'flex h-[26px] w-[22px] flex-shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent text-[13px] leading-none text-tertiary hover:text-danger';
            rm.title = 'Remove extension';
            rm.textContent = '✕';
            control(rm, async () => { await window.extPanel.remove(ext.id); refresh(); });
            row.appendChild(rm);

            listEl.appendChild(row);
        }
    }

    async function refresh() {
        try { render(await window.extPanel.list()); } catch {}
    }

    window.extPanel.onData((items) => render(items));

    document.getElementById('close-btn').addEventListener('click', () => window.extPanel.close());
    document.getElementById('store-link').addEventListener('click', (e) => {
        e.preventDefault();
        window.extPanel.openStore();
        window.extPanel.close();
    });

    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.extPanel.close(); });

    refresh();
})();
