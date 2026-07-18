// IIFE: compiled as a classic <script>; the wrapper keeps this page's
// top-level names out of the shared global scope.
//
// Firefox-style panel: clicking a row RUNS the extension (opens its popup /
// fires its onClicked, anchored to the toolbar), the pin button moves it in or
// out of the toolbar strip, and the footer links to the Chrome Web Store.
(() => {
    const listEl = document.getElementById('list');

    const PIN_SVG = `<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M9.5 1.5l5 5-1.5 1.5-.75-.25L9.5 10.5l.25 2.75L8.5 14.5 5 11 2 14l-1-1 3-3-3.5-3.5 1.25-1.25 2.75.25 2.75-2.75-.25-.75L9.5 1.5z"/></svg>`;

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
            row.className = 'group flex cursor-pointer items-center gap-2.5 border-b border-subtle px-3.5 py-2.5 hover:bg-hover';
            row.title = ext.description || ext.name;

            // Row body click activates the extension — like Firefox's panel.
            row.addEventListener('click', () => {
                if (ext.enabled) window.extPanel.activate(ext.id);
            });

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

            // Controls stop propagation so they don't activate the extension.
            const control = (el, handler) => {
                el.addEventListener('click', (e) => { e.stopPropagation(); handler(); });
                return el;
            };

            // Pin / unpin (Firefox: "Pin to Toolbar")
            const pin = document.createElement('button');
            pin.tabIndex = -1;
            pin.className = 'ext-pin cursor-pointer border-0 bg-transparent p-0.5'
                + (ext.pinned ? ' pinned text-accent' : ' text-tertiary hover:text-primary');
            pin.title = ext.pinned ? 'Unpin from toolbar' : 'Pin to toolbar';
            pin.innerHTML = PIN_SVG;
            control(pin, () => window.extPanel.setPinned(ext.id, !ext.pinned));
            row.appendChild(pin);

            if (ext.optionsUrl && ext.enabled) {
                const opts = document.createElement('button');
                opts.tabIndex = -1;
                opts.className = 'cursor-pointer border-0 bg-transparent p-0 text-[12px] text-tertiary hover:text-primary';
                opts.title = 'Extension options';
                opts.textContent = '⚙';
                control(opts, () => window.extPanel.openOptions(ext.id));
                row.appendChild(opts);
            }

            const toggle = document.createElement('div');
            toggle.className = 'ext-toggle' + (ext.enabled ? ' on' : '');
            toggle.title = ext.enabled ? 'Disable' : 'Enable';
            control(toggle, async () => { await window.extPanel.setEnabled(ext.id, !ext.enabled); refresh(); });
            row.appendChild(toggle);

            const rm = document.createElement('button');
            rm.tabIndex = -1;
            rm.className = 'cursor-pointer border-0 bg-transparent p-0 text-[13px] leading-none text-tertiary hover:text-danger';
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
