"use strict";
// Context-menu overlay. Runs in its own WebContentsView so menus paint ABOVE the
// page (chrome DOM cannot: the page view is composited over it). The whole chain
// lives in this one view, so submenus need no extra views.
//
// Rows arrive as plain data — functions can't cross IPC — and a pick is reported
// back as a path of indices ([2] or [4, 1]) that the chrome maps to its handler.
(() => {
    const surface = document.getElementById('surface');
    // Shortcut hints are formatted per platform (renderer/lib/keys.js).
    const IS_MAC = /Mac/i.test(navigator.platform || navigator.userAgent || '');
    let chain = []; // menu elements, root first
    // The in-chrome menu bar opens its dropdowns with mnemonics on: each row gets
    // an underlined access-key letter and the keyboard drives the whole chain
    // (see features/menu-bar.js). Right-click menus leave this off and keep the
    // plain roving-focus keys. Set per open().
    let useMnemonics = false;

    const clear = () => { chain.forEach(m => m.remove()); chain = []; };

    // Give each row in ONE menu level a unique access key: its first letter/digit
    // not already claimed by a row above it. Mutates the rows with __ki (index of
    // the character in the label) and __key (that character, lowercased).
    const assignRowKeys = (rows) => {
        const used = new Set();
        for (const r of rows) {
            r.__ki = -1;
            r.__key = null;
            if (r.sep || r.disabled || !r.label)
                continue;
            for (let i = 0; i < r.label.length; i++) {
                const c = r.label[i].toLowerCase();
                if (/[a-z0-9]/.test(c) && !used.has(c)) { used.add(c); r.__ki = i; r.__key = c; break; }
            }
        }
    };

    const clampInto = (menu, x, y, parentRect) => {
        const w = menu.offsetWidth, h = menu.offsetHeight;
        let left = x;
        // Submenus flip to the parent's left edge when they'd leave the window.
        if (parentRect && left + w > window.innerWidth - 6) left = parentRect.left - w + 2;
        const vw = window.innerWidth, vh = window.innerHeight;
        // A degenerate viewport must not clamp, or every bound collapses to the
        // margin and the menu lands in the corner instead of under the cursor.
        menu.style.left = (vw > w ? Math.max(6, Math.min(left, vw - w - 6)) : Math.max(6, left)) + 'px';
        menu.style.top = (vh > h ? Math.max(6, Math.min(y, vh - h - 6)) : Math.max(6, y)) + 'px';
    };

    const place = (menu, x, y, parentRect) => {
        surface.appendChild(menu);
        clampInto(menu, x, y, parentRect);
        /* The first menu of a session is measured before the web font has
           loaded, so it is shorter than it will be — and a clamp computed from
           that height let it hang off the bottom of the window with its last
           row cut off. Re-run once layout has settled. */
        const again = () => { if (menu.isConnected) clampInto(menu, x, y, parentRect); };
        requestAnimationFrame(again);
        /* The overlay view is resized to the window as it opens, and the page
           can still report the OLD (even zero) viewport at this point — a zero
           viewport skips the clamp, so a wide menu opened near the right edge
           ran off the window. Re-clamp when the viewport catches up; don't rely
           on the frame above alone (a just-shown view's frames can lag). */
        window.addEventListener('resize', again, { once: true });
        try { document.fonts?.ready.then(again); }
        catch (e) { /* re-clamp is best effort; the first pass already placed it */ }
    };

    const closeFrom = (depth) => { while (chain.length > depth) chain.pop().remove(); };

    const build = (rows, depth, path) => {
        const menu = document.createElement('div');
        menu.className = 'ctx-menu';
        if (useMnemonics)
            assignRowKeys(rows);
        rows.forEach((r, i) => {
            if (r.sep) {
                const s = document.createElement('div');
                s.className = 'ctx-menu-sep';
                menu.appendChild(s);
                return;
            }
            const here = path.concat(i);
            const b = document.createElement('button');
            /* One row anatomy for every menu (ui-polish U1-1), shared with the
               app menu via .surface-row.menu-row:
                 [ icon column, always reserved ][ label ][ ONE trailing item ]
               The trailing item is a check, a submenu chevron or a shortcut hint
               — never more than one. `disabled` and `checked` come from Electron
               templates routed through features/overlay-menu.js — a page or
               bookmark menu can have a greyed row or a tick, and dropping them
               would have made those menus lie. */
            b.className = 'surface-row menu-row ctx-menu-item' + (r.cls ? ' ' + r.cls : '')
                + (r.sub ? ' has-sub' : '') + (r.checked ? ' is-checked' : '');
            if (r.disabled)
                b.disabled = true;
            // Icon column: reserved even when empty, so every label shares one
            // left edge. `icon` is TEXT (an emoji), never markup.
            const ic = document.createElement('span');
            ic.className = 'ctx-icon';
            ic.setAttribute('aria-hidden', 'true');
            if (r.iconUrl && /^data:image\//.test(r.iconUrl)) {
                // A site's favicon (recently closed): data: images only.
                const img = document.createElement('img');
                img.className = 'ctx-icon-img';
                img.alt = '';
                img.src = r.iconUrl;
                ic.appendChild(img);
            }
            else if (r.icon) ic.textContent = r.icon;
            b.appendChild(ic);
            const lbl = document.createElement('span');
            lbl.className = 'row-title ctx-label';
            if (useMnemonics && r.__ki >= 0) {
                // Underline the access-key letter, built from text nodes so the
                // label is never treated as markup.
                b.dataset.key = r.__key;
                if (r.__ki > 0) lbl.appendChild(document.createTextNode(r.label.slice(0, r.__ki)));
                const u = document.createElement('u');
                u.textContent = r.label[r.__ki];
                lbl.appendChild(u);
                lbl.appendChild(document.createTextNode(r.label.slice(r.__ki + 1)));
            }
            else {
                lbl.textContent = r.label;
            }
            b.appendChild(lbl);
            const trail = document.createElement('span');
            trail.className = 'ctx-trail';
            trail.setAttribute('aria-hidden', 'true');
            if (r.checked) {
                // Phosphor `check`, 14px — an icon, never a text glyph.
                trail.classList.add('ctx-check');
                trail.innerHTML = '<svg viewBox="0 0 256 256" width="14" height="14" fill="currentColor"><path d="M232.49,80.49l-128,128a12,12,0,0,1-17,0l-56-56a12,12,0,1,1,17-17L96,183,215.51,63.51a12,12,0,0,1,17,17Z"/></svg>';
                b.setAttribute('aria-checked', 'true');
            }
            else if (r.sub) {
                // Phosphor `caret-right`, 12px.
                trail.classList.add('ctx-sub-arrow');
                trail.innerHTML = '<svg viewBox="0 0 256 256" width="12" height="12" fill="currentColor"><path d="M184.49,136.49l-80,80a12,12,0,0,1-17-17L159,128,87.51,56.49a12,12,0,1,1,17-17l80,80A12,12,0,0,1,184.49,136.49Z"/></svg>';
            }
            else if (r.accelerator && window.Northstar?.keys?.formatAccelerator) {
                trail.classList.add('surface-kbd');
                trail.textContent = window.Northstar.keys.formatAccelerator(r.accelerator, IS_MAC ? 'darwin' : 'win32');
            }
            if (trail.className !== 'ctx-trail') b.appendChild(trail);
            b.addEventListener('mouseenter', () => {
                closeFrom(depth + 1);
                if (!r.sub || !r.sub.length) return;
                const rc = b.getBoundingClientRect();
                const child = build(r.sub, depth + 1, here);
                chain.push(child);
                place(child, rc.right - 2, rc.top - 5, rc);
            });
            b.addEventListener('click', (e) => {
                if (r.sub) { e.stopPropagation(); return; }
                clear();
                window.overlayMenu.pick(here);
            });
            menu.appendChild(b);
        });
        return menu;
    };

    // Emoji picker shares the overlay so it also paints above the page.
    const buildEmoji = (data) => {
        const menu = document.createElement('div');
        menu.className = 'ctx-menu emoji-pop';
        const search = document.createElement('input');
        search.className = 'emoji-search';
        search.type = 'text';
        search.placeholder = 'Search emojis';
        const grid = document.createElement('div');
        grid.className = 'emoji-pop-grid';
        const paint = (q) => {
            grid.innerHTML = '';
            const needle = (q || '').trim().toLowerCase();
            if (data.allowNone && !needle) {
                const none = document.createElement('button');
                none.className = 'emoji-opt emoji-none';
                none.title = 'No emoji (dot)';
                none.addEventListener('click', () => { clear(); window.overlayMenu.pick({ emoji: '' }); });
                grid.appendChild(none);
            }
            for (const [e, kw] of data.emojis) {
                if (needle && !kw.includes(needle)) continue;
                const b = document.createElement('button');
                b.className = 'emoji-opt';
                b.textContent = e;
                b.title = kw.split(' ')[0];
                b.addEventListener('click', () => { clear(); window.overlayMenu.pick({ emoji: e }); });
                grid.appendChild(b);
            }
        };
        paint('');
        search.addEventListener('input', () => paint(search.value));
        search.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { clear(); window.overlayMenu.dismiss(); }
            if (e.key === 'Enter') grid.querySelector('.emoji-opt')?.click();
        });
        menu.appendChild(search);
        menu.appendChild(grid);
        setTimeout(() => search.focus(), 0);
        return menu;
    };

    let shownAt = 0;   // when the current menu went up, for the blur guard
    let shownSeq = 0;  // which open it was, so push and pull don't both build it

    const open = (data) => {
        if (!data)
            return;
        // The push and the pull below can both deliver the FIRST menu. Building
        // it twice is not just wasted work: the rebuild moves keyboard focus
        // back to the first row under a user who has already pressed Down.
        if (data.seq && data.seq === shownSeq)
            return;
        shownSeq = data.seq || 0;
        useMnemonics = !!data.mnemonics && data.kind !== 'emoji';
        clear();
        const root = data.kind === 'emoji' ? buildEmoji(data) : build(data.rows, 0, []);
        chain.push(root);
        place(root, data.x, data.y);
        shownAt = Date.now();
        armKeys();
        // No pre-selection — opening a dropdown should not highlight a row. The
        // arrows start from an end (ArrowDown → first) and mnemonics activate a
        // row directly, neither of which needs an initial selection.
    };

    window.overlayMenu.onOpen(open);
    /* …and ask what is already pending. This view is created BY the first
       right-click, so that click's data can be sent before this script is
       listening — which is why the first right-click of a session opened an
       empty menu and the second one worked. */
    try { window.overlayMenu.ready?.().then(open); }
    catch (e) { /* the push above is the normal path */ }

    // Clear the chain as well as telling main to hide us, so the view never
    // holds a stale menu that could flash on the next open.
    const dismiss = () => { clear(); window.overlayMenu.dismiss(); };
    // A press anywhere outside the open menu chain closes it. Listen on the
    // document in CAPTURE so it fires whichever element takes the event — the
    // bare surface, a submenu gutter, the search field — rather than relying on
    // the press landing on #surface specifically (a left-click just outside a
    // menu was landing on nothing the surface listener saw, so it never closed).
    // pointerdown covers mouse, pen and touch in one.
    document.addEventListener('pointerdown', (e) => {
        if (!chain.some(m => m.contains(e.target))) dismiss();
    }, true);
    // A context menu you can only click is half a menu: arrows move, Enter
    // activates, Escape closes, and typing jumps by first letter. Re-armed on
    // every open because the rows are rebuilt each time.
    const armKeys = () => {
        // Menu-bar dropdowns drive their own keyboard (mnemonics + full chain nav,
        // below), so the generic roving-focus/type-ahead helper would fight it.
        if (useMnemonics)
            return;
        const top = chain[chain.length - 1];
        // No focusFirst: opening a menu with the mouse should not pre-select a
        // row (right-clicking the sidebar highlighting the first item read as a
        // stray selection). Arrow keys still start from the top/bottom.
        window.Northstar?.keys?.rows(top || document, { selector: '.ctx-menu-item', onEscape: dismiss });
    };

    // ── Mnemonic / keyboard navigation for menu-bar dropdowns ────────────────
    const itemsOf = (menu) => menu ? [...menu.querySelectorAll('.ctx-menu-item')].filter(b => !b.disabled) : [];
    function selectIn(menu, i) {
        const its = itemsOf(menu);
        if (!its.length)
            return;
        const idx = (i + its.length) % its.length;
        // Class-only selection — no .focus(). The overlay view already holds the
        // keyboard, and focusing individual rows left stray focus rings around.
        its.forEach(b => b.classList.remove('kbd-sel'));
        its[idx].classList.add('kbd-sel');
    }
    /** Open the submenu of `button` (reusing the same builder the mouse uses) and
     *  select its first row. */
    function openSubOf(button, menu) {
        button.dispatchEvent(new MouseEvent('mouseenter'));
        const deep = chain[chain.length - 1];
        if (deep && deep !== menu)
            selectIn(deep, 0);
    }
    document.addEventListener('keydown', (e) => {
        if (!useMnemonics || !chain.length)
            return;
        const menu = chain[chain.length - 1];
        const its = itemsOf(menu);
        const cur = its.findIndex(b => b.classList.contains('kbd-sel'));
        const sel = cur >= 0 ? its[cur] : null;
        const k = e.key;
        if (k === 'ArrowDown') { e.preventDefault(); selectIn(menu, cur === -1 ? 0 : cur + 1); return; }
        if (k === 'ArrowUp') { e.preventDefault(); selectIn(menu, cur === -1 ? its.length - 1 : cur - 1); return; }
        if (k === 'ArrowRight') {
            if (sel && sel.classList.contains('has-sub')) { e.preventDefault(); openSubOf(sel, menu); }
            return;
        }
        if (k === 'ArrowLeft') {
            // Step back out of a submenu; at the root there is nowhere to go.
            if (chain.length > 1) { e.preventDefault(); closeFrom(chain.length - 1); }
            return;
        }
        if (k === 'Enter' || k === ' ') {
            if (sel) { e.preventDefault(); sel.classList.contains('has-sub') ? openSubOf(sel, menu) : sel.click(); }
            return;
        }
        // The access key: open a submenu row, or activate a leaf.
        if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            const hit = its.find(b => b.dataset.key === k.toLowerCase());
            if (hit) {
                e.preventDefault();
                hit.classList.contains('has-sub') ? openSubOf(hit, menu) : hit.click();
            }
        }
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') dismiss();
    });
    /* The window losing focus should not leave a menu stranded on screen, but
       two kinds of blur are not the user leaving, and acting on either told main
       to hide the menu that had since taken this one's place — which is why
       every other right-click drew nothing. One: opening focuses this view, and
       raising it churns focus for a frame. Two: main hands focus back to the
       chrome when it hides us, so every dismissal echoes back here. A click on
       the surface is different — that one always dismisses, or a full-window
       overlay would be left eating clicks. */
    window.addEventListener('blur', () => {
        if (!chain.length || Date.now() - shownAt < 250)
            return;
        dismiss();
    });
})();
