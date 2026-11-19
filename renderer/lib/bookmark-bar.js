/**
 * Browser chrome — the bookmark bar.
 *
 * Split out of renderer/renderer.js, which had grown to 4.4k lines in one
 * closure. Classic script, no bundler: it registers a factory on `window.Northstar`
 * that renderer.js calls with the handful of things it needs from the chrome's
 * shared state. Everything else — the bar's own DOM, its overflow dropdown, the
 * folder sub-panels and all the drag-and-drop — lives here.
 *
 * `ctx` (from renderer.js):
 *   bar, items, button the bookmark bar, its item row, and the ★ toolbar button
 *   currentUrl()       the address of the tab in view (read at call time)
 *   currentTitle()     its title
 *   activeTabIndex()   for "open in this tab"
 *   paintCachedFavicon, makeFolderIcon   shared chrome helpers
 *   onVisibilityChange(visible)          so the page view can be re-measured
 */
(function (root) {
    'use strict';
    root.Northstar = root.Northstar || {};
    root.Northstar.createBookmarkBar = function createBookmarkBar(ctx) {
        const bookmarkBar = ctx.bar;
        const bookmarkBarItems = ctx.items;
        const bookmarkBtn = ctx.button;
        const paintCachedFavicon = ctx.paintCachedFavicon;
        const makeFolderIcon = ctx.makeFolderIcon;
        // State that used to sit in renderer.js's shared block — it is only ever
        // touched from in here.
        let bookmarkBarVisible = !!ctx.initiallyVisible;
        let hasBookmarks = false;
        let renamingFolderId = null;
        let refreshSeq = 0;
        let openDropdownId = null; // id of the anchor button whose dropdown is open
        let dropdownCleanup = null;
        // Bookmark bar
        // ─────────────────────────────────────────────────────────────────────────
        // ── Dropdown (overflow + folder sub-panels) ──────────────────────────────
        function closeDropdown() {
            document.getElementById('bm-dropdown')?.remove();
            document.getElementById('bm-subdropdown')?.remove();
            if (dropdownCleanup) {
                dropdownCleanup();
                dropdownCleanup = null;
            }
            openDropdownId = null;
        }
        function openDropdown(anchorBtn, anchorId, buildFn) {
            if (openDropdownId === anchorId) {
                closeDropdown();
                return;
            }
            closeDropdown();
            openDropdownId = anchorId;
            const panel = document.createElement('div');
            panel.id = 'bm-dropdown';
            panel.className = 'bookmark-overflow-dropdown';
            buildFn(panel);
            document.body.appendChild(panel);
            const rect = anchorBtn.getBoundingClientRect();
            const panelW = 200;
            panel.style.left = Math.min(rect.left, window.innerWidth - panelW - 4) + 'px';
            panel.style.top = rect.bottom + 'px';
            const handler = (e) => {
                if (!panel.contains(e.target) && e.target !== anchorBtn) {
                    closeDropdown();
                    document.removeEventListener('mousedown', handler, true);
                }
            };
            document.addEventListener('mousedown', handler, true);
            // A press on a page (its own native view) or in another app never
            // reaches this document; the chrome losing focus is the signal.
            const onBlur = () => closeDropdown();
            window.addEventListener('blur', onBlur);
            dropdownCleanup = () => {
                document.removeEventListener('mousedown', handler, true);
                window.removeEventListener('blur', onBlur);
            };
        }
        // ── Dropdown item builder ─────────────────────────────────────────────────
        function makeDropdownItem(entry, parentFolderId) {
            if (entry.type === 'divider') {
                const sep = document.createElement('div');
                sep.className = 'bookmark-overflow-sep';
                return sep;
            }
            const item = document.createElement('button');
            item.className = 'bookmark-overflow-item';
            item.dataset.id = entry.id;
            item.dataset.parentFolderId = parentFolderId || '';
            if (parentFolderId) {
                item.draggable = true;
                item.addEventListener('dragstart', (e) => {
                    dragSrcId = entry.id;
                    dragSrcFolderId = parentFolderId;
                    bmDragActive = true;
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', entry.id);
                    closeDropdown();
                });
                item.addEventListener('dragend', () => {
                    dragSrcId = null;
                    dragSrcFolderId = null;
                    bmDragActive = false;
                    clearDragClasses();
                    clearSpring(true);
                });
            }
            if (entry.type === 'folder') {
                item.classList.add('bookmark-overflow-folder-item');
                item.appendChild(makeFolderIcon('bookmark-overflow-folder-icon'));
                const lbl = document.createElement('span');
                lbl.textContent = entry.title || 'Folder';
                item.appendChild(lbl);
                const arrow = document.createElement('span');
                arrow.className = 'bookmark-overflow-submenu-arrow';
                arrow.textContent = '▶';
                item.appendChild(arrow);
                // Hover to open
                item.addEventListener('mouseenter', () => {
                    clearTimeout(overflowCloseTimer);
                    clearTimeout(overflowHoverTimer);
                    overflowHoverTimer = setTimeout(() => openFolderSubPanel(item, entry), 220);
                });
                item.addEventListener('mouseleave', (e) => {
                    clearTimeout(overflowHoverTimer);
                    const sub = document.getElementById('bm-subdropdown');
                    if (sub && (e.relatedTarget === sub || sub.contains(e.relatedTarget)))
                        return;
                    overflowCloseTimer = setTimeout(() => {
                        document.getElementById('bm-subdropdown')?.remove();
                        document.querySelectorAll('#bm-dropdown .has-submenu-open')
                            .forEach(el => el.classList.remove('has-submenu-open'));
                    }, 220);
                });
                // Click also opens (fallback)
                item.addEventListener('click', (e) => {
                    e.stopPropagation();
                    clearTimeout(overflowHoverTimer);
                    const existing = document.getElementById('bm-subdropdown');
                    if (existing && existing.dataset.forId === entry.id) {
                        existing.remove();
                        item.classList.remove('has-submenu-open');
                    }
                    else {
                        openFolderSubPanel(item, entry);
                    }
                });
            }
            else {
                const img = document.createElement('img');
                img.className = 'bookmark-bar-favicon';
                item.appendChild(img);
                paintCachedFavicon(img, entry.url);
                const lbl = document.createElement('span');
                try {
                    lbl.textContent = entry.title || new URL(entry.url).hostname;
                }
                catch {
                    lbl.textContent = entry.url;
                }
                item.appendChild(lbl);
                item.addEventListener('click', () => { closeDropdown(); window.tab.loadUrl(ctx.activeTabIndex(), entry.url); });
                item.addEventListener('auxclick', (e) => {
                    if (e.button !== 1)
                        return;
                    e.preventDefault();
                    closeDropdown();
                    window.browserBookmarks.openInNewTab(entry.url, false);
                });
            }
            item.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                window.browserBookmarks.showBarContextMenu({ type: entry.type, id: entry.id, url: entry.url, title: entry.title });
            });
            return item;
        }
        // ── Folder bar click → floating folder WebContentsView ───────────────────
        async function openFolderPanel(btn, entry) {
            const rect = btn.getBoundingClientRect();
            closeDropdown();
            try {
                await window.electronAPI.openFolderDropdown({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }, entry);
            }
            catch (e) { window.northstarLog?.debug('bookmark-bar', 'openFolderPanel: ' + e); }
        }
        /**
         * Fill a panel div with the items of a folder entry.
         * Each folder item shows a ▶ arrow; hovering over it for 300ms opens a
         * side-panel (same pattern as the overflow subfolder).
         * Drag from any item sets dragSrcId/FolderId and closes the panel.
         */
        function buildFolderPanelItems(panel, folderEntry) {
            const folderId = folderEntry.id;
            const children = folderEntry.children || [];
            if (!children.length) {
                const empty = document.createElement('div');
                empty.className = 'bookmark-overflow-empty';
                empty.textContent = '(empty)';
                panel.appendChild(empty);
                return;
            }
            // Local spring state for subfolders within this panel
            let panelSpringTimer = null;
            let panelSpringRow = null;
            function clearPanelSpring() {
                if (panelSpringTimer) {
                    clearTimeout(panelSpringTimer);
                    panelSpringTimer = null;
                }
                panelSpringRow = null;
            }
            children.forEach(child => {
                if (child.type === 'divider') {
                    const sep = document.createElement('div');
                    sep.className = 'bookmark-overflow-sep';
                    panel.appendChild(sep);
                    return;
                }
                const row = document.createElement('button');
                row.className = 'bookmark-overflow-item';
                row.dataset.id = child.id;
                row.dataset.parentFolderId = folderId;
                if (child.type === 'folder') {
                    row.classList.add('bookmark-overflow-folder-item');
                    row.appendChild(makeFolderIcon('bookmark-overflow-folder-icon'));
                    const lbl = document.createElement('span');
                    lbl.textContent = child.title || 'Folder';
                    row.appendChild(lbl);
                    const arr = document.createElement('span');
                    arr.className = 'bookmark-overflow-submenu-arrow';
                    arr.textContent = '▶';
                    row.appendChild(arr);
                    // Click drills in: rebuild the panel contents for the subfolder
                    row.addEventListener('click', (e) => {
                        e.stopPropagation();
                        // Clear current contents down to the header+sep then refill
                        const panelEl = document.getElementById('bm-dropdown');
                        if (!panelEl)
                            return;
                        // Remove everything after the separator
                        while (panelEl.children.length > 2)
                            panelEl.removeChild(panelEl.lastChild);
                        // Update header text
                        const hdr = panelEl.querySelector('.bookmark-folder-panel-header');
                        if (hdr)
                            hdr.textContent = child.title || 'Folder';
                        buildFolderPanelItems(panelEl, child);
                    });
                }
                else {
                    const img = document.createElement('img');
                    img.className = 'bookmark-bar-favicon';
                    row.appendChild(img);
                    paintCachedFavicon(img, child.url);
                    const lbl = document.createElement('span');
                    try {
                        lbl.textContent = child.title || new URL(child.url).hostname;
                    }
                    catch {
                        lbl.textContent = child.url;
                    }
                    row.appendChild(lbl);
                    row.addEventListener('click', () => {
                        closeDropdown();
                        window.tab.loadUrl(ctx.activeTabIndex(), child.url);
                    });
                    row.addEventListener('auxclick', (e) => {
                        if (e.button !== 1)
                            return;
                        e.preventDefault();
                        closeDropdown();
                        window.browserBookmarks.openInNewTab(child.url, false);
                    });
                }
                // Drag — same pattern as makeDropdownItem
                row.draggable = true;
                row.addEventListener('dragstart', (e) => {
                    dragSrcId = child.id;
                    dragSrcFolderId = folderId;
                    bmDragActive = true;
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', child.id);
                    closeDropdown();
                });
                row.addEventListener('dragend', () => {
                    dragSrcId = null;
                    dragSrcFolderId = null;
                    bmDragActive = false;
                    clearDragClasses();
                    clearSpring(true);
                });
                // Drag-over target: spring into subfolder, or show drop-before line
                row.addEventListener('dragenter', (e) => {
                    if (!bmDragActive || dragSrcId === child.id)
                        return;
                    e.preventDefault();
                    if (panelSpringRow === row)
                        return;
                    clearDragClasses();
                    clearPanelSpring();
                    if (child.type === 'folder') {
                        row.classList.add('drag-into');
                        panelSpringRow = row;
                        panelSpringTimer = setTimeout(() => {
                            if (panelSpringRow !== row)
                                return;
                            panelSpringRow = null;
                            panelSpringTimer = null;
                            const panelEl = document.getElementById('bm-dropdown');
                            if (!panelEl)
                                return;
                            while (panelEl.children.length > 2)
                                panelEl.removeChild(panelEl.lastChild);
                            const hdr = panelEl.querySelector('.bookmark-folder-panel-header');
                            if (hdr)
                                hdr.textContent = child.title || 'Folder';
                            buildFolderPanelItems(panelEl, child);
                        }, 500);
                    }
                    else {
                        row.classList.add('drop-before');
                    }
                });
                row.addEventListener('dragover', (e) => {
                    if (!bmDragActive || dragSrcId === child.id)
                        return;
                    e.preventDefault();
                    e.stopPropagation();
                    e.dataTransfer.dropEffect = 'move';
                });
                row.addEventListener('dragleave', (e) => {
                    if (row.contains(e.relatedTarget))
                        return;
                    const moved = e.relatedTarget?.closest?.('.bookmark-overflow-item');
                    if (moved && moved !== row) {
                        if (panelSpringRow === row)
                            clearPanelSpring();
                        row.classList.remove('drop-before', 'drag-into');
                    }
                });
                row.addEventListener('drop', async (e) => {
                    if (!dragSrcId || dragSrcId === child.id)
                        return;
                    e.preventDefault();
                    e.stopPropagation();
                    row.classList.remove('drop-before', 'drag-into');
                    clearSpring(true);
                    clearPanelSpring();
                    if (child.type === 'folder') {
                        await window.browserBookmarks.moveIntoFolder(dragSrcId, child.id, null);
                    }
                    else {
                        await window.browserBookmarks.moveIntoFolder(dragSrcId, folderId, child.id);
                    }
                });
                row.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    window.browserBookmarks.showBarContextMenu({
                        type: child.type, id: child.id, url: child.url, title: child.title,
                    });
                });
                panel.appendChild(row);
            });
            // Drop on empty space within the panel → append to folder end
            panel.addEventListener('dragover', (e) => {
                if (!bmDragActive || e.target.closest('.bookmark-overflow-item, .bookmark-overflow-sep'))
                    return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
            });
            panel.addEventListener('drop', async (e) => {
                if (!dragSrcId || e.target.closest('.bookmark-overflow-item, .bookmark-overflow-sep'))
                    return;
                e.preventDefault();
                clearSpring(true);
                await window.browserBookmarks.moveIntoFolder(dragSrcId, folderId, null);
            });
        }
        function openFolderSubPanel(anchorItem, entry) {
            document.querySelectorAll('#bm-dropdown .has-submenu-open')
                .forEach(el => el.classList.remove('has-submenu-open'));
            document.getElementById('bm-subdropdown')?.remove();
            const sub = document.createElement('div');
            sub.id = 'bm-subdropdown';
            sub.className = 'bookmark-overflow-dropdown';
            sub.dataset.forId = entry.id;
            if (!entry.children?.length) {
                const empty = document.createElement('div');
                empty.className = 'bookmark-overflow-empty';
                empty.textContent = '(empty)';
                sub.appendChild(empty);
            }
            else {
                entry.children.forEach(child => sub.appendChild(makeDropdownItem(child, entry.id)));
            }
            document.body.appendChild(sub);
            const r = anchorItem.getBoundingClientRect();
            // Flip left if sub would overflow the right edge
            const subW = 200;
            const spaceRight = window.innerWidth - r.right;
            sub.style.left = (spaceRight >= subW ? r.right : r.left - subW) + 'px';
            sub.style.top = r.top + 'px';
            anchorItem.classList.add('has-submenu-open');
            // Keep sub open while cursor is inside it
            sub.addEventListener('mouseenter', () => clearTimeout(overflowCloseTimer));
            sub.addEventListener('mouseleave', (e) => {
                if (e.relatedTarget === anchorItem || anchorItem.contains(e.relatedTarget))
                    return;
                overflowCloseTimer = setTimeout(() => {
                    sub.remove();
                    anchorItem.classList.remove('has-submenu-open');
                }, 220);
            });
        }
        // ── Drag and drop ─────────────────────────────────────────────────────────
        let dragSrcId = null;
        let dragSrcFolderId = null;
        let bmDragActive = false;
        let externDragId = null;
        let externLastTarget = null;
        // Spring-load state — folder opens after a hover delay during drag
        let springTimer = null;
        let springFolderId = null;
        let springOpen = false;
        // Overflow dropdown subfolder hover-open state
        let overflowHoverTimer = null;
        let overflowCloseTimer = null;
        function clearDragClasses() {
            document.querySelectorAll('.drag-into, .drop-before')
                .forEach(el => el.classList.remove('drag-into', 'drop-before'));
        }
        function clearSpring(closePanel = false) {
            if (springTimer) {
                clearTimeout(springTimer);
                springTimer = null;
            }
            springFolderId = null;
            if (closePanel && springOpen) {
                closeDropdown();
                window.electronAPI.closeFolderDropdown();
                springOpen = false;
            }
        }
        // Prevent bookmark drags from bubbling to the tab bar's own dragover handler
        document.addEventListener('dragover', (e) => {
            if (!bmDragActive)
                return;
            const inBar = !!e.target.closest('#bookmark-bar');
            const inDropdown = !!e.target.closest('#bm-dropdown');
            if (!inBar && !inDropdown)
                e.stopPropagation();
        }, true);
        function makeDraggable(el, item, getAllFn) {
            el.draggable = true;
            el.addEventListener('dragstart', (e) => {
                dragSrcId = item.id;
                dragSrcFolderId = null;
                bmDragActive = true;
                el.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', item.id);
            });
            el.addEventListener('dragend', () => {
                dragSrcId = null;
                dragSrcFolderId = null;
                bmDragActive = false;
                el.classList.remove('dragging');
                clearDragClasses();
                clearSpring(true);
            });
            el.addEventListener('dragover', (e) => {
                if (!bmDragActive)
                    return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                clearDragClasses();
                if (item.type === 'folder') {
                    if (springOpen && springFolderId === item.id) {
                        el.classList.add('drag-into');
                    }
                    else {
                        el.classList.add('drop-before');
                        if (springFolderId !== item.id) {
                            clearSpring(false);
                            springFolderId = item.id;
                            springTimer = setTimeout(async () => {
                                springOpen = true;
                                el.classList.remove('drop-before');
                                el.classList.add('drag-into');
                                const rect = el.getBoundingClientRect();
                                closeDropdown();
                                try {
                                    await window.electronAPI.openFolderDropdown({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }, item);
                                }
                                catch (e) { window.northstarLog?.debug('bookmark-bar', 'makeDraggable: ' + e); }
                            }, 500);
                        }
                    }
                }
                else {
                    el.classList.add('drop-before');
                }
            });
            el.addEventListener('dragleave', (e) => {
                clearDragClasses();
                if (item.type === 'folder' && springFolderId === item.id) {
                    const dropdown = document.getElementById('bm-dropdown');
                    if (dropdown?.contains(e.relatedTarget))
                        return;
                    clearSpring(false);
                }
            });
            el.addEventListener('drop', async (e) => {
                e.preventDefault();
                clearDragClasses();
                const wasSpringOpen = springOpen;
                clearSpring(true);
                if (!dragSrcId || dragSrcId === item.id)
                    return;
                if (dragSrcFolderId) {
                    await window.browserBookmarks.moveOutOfFolder(dragSrcId, dragSrcFolderId, item.id);
                }
                else if (item.type === 'folder' && wasSpringOpen) {
                    await window.browserBookmarks.moveIntoFolder(dragSrcId, item.id);
                }
                else {
                    const all = getAllFn();
                    const ids = all.map(b => b.id);
                    const from = ids.indexOf(dragSrcId);
                    const to = ids.indexOf(item.id);
                    if (from === -1 || to === -1)
                        return;
                    ids.splice(from, 1);
                    ids.splice(to, 0, dragSrcId);
                    await window.browserBookmarks.reorder(ids);
                }
            });
        }
        /** Build a spring-loaded folder panel where every row is a drop target. */
        function buildSpringPanel(panel, folderEntry) {
            const children = folderEntry.children || [];
            function makeDropRow(child) {
                const row = makeDropdownItem(child, folderEntry.id);
                row.addEventListener('dragenter', (e) => {
                    if (!bmDragActive || dragSrcId === child.id)
                        return;
                    e.preventDefault();
                    clearDragClasses();
                    // Show drop target. Folders get drag-into (drop inside), bookmarks get drop-before.
                    // No sub-spring: rebuilding the panel DOM during a live drag causes macOS to
                    // fire spurious dragleave/dragend. Drop onto a folder moves into it directly.
                    row.classList.add(child.type === 'folder' ? 'drag-into' : 'drop-before');
                });
                row.addEventListener('dragover', (e) => {
                    if (!bmDragActive || dragSrcId === child.id)
                        return;
                    e.preventDefault();
                    e.stopPropagation();
                    e.dataTransfer.dropEffect = 'move';
                });
                row.addEventListener('dragleave', (e) => {
                    if (row.contains(e.relatedTarget))
                        return;
                    row.classList.remove('drop-before', 'drag-into');
                });
                row.addEventListener('drop', async (e) => {
                    if (!dragSrcId || dragSrcId === child.id)
                        return;
                    e.preventDefault();
                    e.stopPropagation();
                    row.classList.remove('drop-before', 'drag-into');
                    clearSpring(true);
                    if (child.type === 'folder') {
                        await window.browserBookmarks.moveIntoFolder(dragSrcId, child.id, null);
                    }
                    else {
                        await window.browserBookmarks.moveIntoFolder(dragSrcId, folderEntry.id, child.id);
                    }
                });
                return row;
            }
            if (!children.length) {
                const empty = document.createElement('div');
                empty.className = 'bookmark-overflow-empty';
                empty.textContent = '(empty)';
                panel.appendChild(empty);
            }
            else {
                children.forEach(child => panel.appendChild(makeDropRow(child)));
            }
            panel.addEventListener('dragover', (e) => {
                if (!bmDragActive || e.target.closest('.bookmark-overflow-item, .bookmark-overflow-sep'))
                    return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
            });
            panel.addEventListener('drop', async (e) => {
                if (!dragSrcId || e.target.closest('.bookmark-overflow-item, .bookmark-overflow-sep'))
                    return;
                e.preventDefault();
                clearSpring(true);
                await window.browserBookmarks.moveIntoFolder(dragSrcId, folderEntry.id, null);
            });
        }
        // ── Extern drag (from folder dropdown to bookmark bar) ────────────────────
        window.electronAPI.onExternBookmarkDragStart((id, folderId) => {
            dragSrcId = id;
            dragSrcFolderId = folderId;
            bmDragActive = true;
            externDragId = id;
            externLastTarget = null;
        });
        window.electronAPI.onExternBookmarkDragPosition((x, y) => {
            if (!externDragId)
                return;
            clearDragClasses();
            const el = document.elementFromPoint(x, y);
            const barItem = el?.closest('.bookmark-bar-item, .bookmark-bar-divider');
            const overflowItem = el?.closest('.bookmark-overflow-item');
            if (barItem) {
                externLastTarget = barItem;
                barItem.classList.add(barItem.classList.contains('bookmark-bar-folder') ? 'drag-into' : 'drop-before');
            }
            else if (overflowItem && overflowItem.dataset.id && overflowItem.dataset.id !== externDragId) {
                externLastTarget = overflowItem;
                overflowItem.classList.add(overflowItem.classList.contains('bookmark-overflow-folder-item') ? 'drag-into' : 'drop-before');
            }
            else {
                externLastTarget = null;
            }
        });
        window.electronAPI.onExternBookmarkDragEnd(async () => {
            if (!externDragId)
                return;
            const srcId = dragSrcId, srcFolder = dragSrcFolderId, target = externLastTarget;
            dragSrcId = null;
            dragSrcFolderId = null;
            bmDragActive = false;
            externDragId = null;
            externLastTarget = null;
            clearDragClasses();
            clearSpring(true);
            if (!target || !srcId)
                return;
            const targetId = target.dataset.id;
            if (!targetId || targetId === srcId)
                return;
            // Target is inside a spring-opened overflow panel (subfolder)
            if (target.classList.contains('bookmark-overflow-item')) {
                const parentFolderId = target.dataset.parentFolderId;
                if (target.classList.contains('bookmark-overflow-folder-item')) {
                    // Drop onto a folder → append to its end
                    await window.browserBookmarks.moveIntoFolder(srcId, targetId, null);
                }
                else if (parentFolderId) {
                    // Drop before a bookmark inside the spring folder
                    await window.browserBookmarks.moveIntoFolder(srcId, parentFolderId, targetId);
                }
                return;
            }
            // Target is a bar item
            if (target.classList.contains('bookmark-bar-folder')) {
                await window.browserBookmarks.moveIntoFolder(srcId, targetId);
            }
            else if (srcFolder) {
                await window.browserBookmarks.moveOutOfFolder(srcId, srcFolder, targetId);
            }
            else {
                const all = await window.browserBookmarks.getAll();
                const ids = all.map(b => b.id);
                const from = ids.indexOf(srcId), to = ids.indexOf(targetId);
                if (from !== -1 && to !== -1) {
                    ids.splice(from, 1);
                    ids.splice(to, 0, srcId);
                    await window.browserBookmarks.reorder(ids);
                }
            }
        });
        // ── Bar item builder ──────────────────────────────────────────────────────
        function makeBarElement(entry, bookmarks) {
            if (entry.type === 'divider') {
                const el = document.createElement('div');
                el.className = 'bookmark-bar-divider';
                el.dataset.id = entry.id;
                makeDraggable(el, entry, () => bookmarks);
                el.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    window.browserBookmarks.showBarContextMenu({ type: 'divider', id: entry.id });
                });
                return el;
            }
            const btn = document.createElement('button');
            btn.dataset.id = entry.id;
            if (entry.type === 'folder') {
                btn.className = 'bookmark-bar-item bookmark-bar-folder';
                btn.title = entry.title || 'Folder';
                btn.appendChild(makeFolderIcon('bookmark-folder-icon'));
                const lbl = document.createElement('span');
                lbl.className = 'bookmark-bar-label';
                lbl.textContent = entry.title || 'Folder';
                btn.appendChild(lbl);
                btn.addEventListener('click', () => openFolderPanel(btn, entry));
            }
            else {
                btn.className = 'bookmark-bar-item';
                btn.title = entry.title || entry.url;
                const img = document.createElement('img');
                img.className = 'bookmark-bar-favicon';
                btn.appendChild(img);
                paintCachedFavicon(img, entry.url);
                const lbl = document.createElement('span');
                lbl.className = 'bookmark-bar-label';
                try {
                    lbl.textContent = entry.title || new URL(entry.url).hostname;
                }
                catch {
                    lbl.textContent = entry.url;
                }
                btn.appendChild(lbl);
                // NOTE: this listener used to sit behind a dangling `if
                // (entry.profile)` (the statement it guarded was deleted years
                // ago), so clicking an ordinary bookmark in the bar did nothing
                // at all — only container-tagged ones worked.
                btn.addEventListener('click', () => {
                    if (entry.profile)
                        window.tab.openInContainer(entry.profile, entry.url);
                    else
                        window.tab.loadUrl(ctx.activeTabIndex(), entry.url);
                });
                btn.addEventListener('auxclick', (e) => {
                    if (e.button !== 1)
                        return;
                    e.preventDefault();
                    window.browserBookmarks.openInNewTab(entry.url, false);
                });
            }
            btn.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                window.browserBookmarks.showBarContextMenu({ type: entry.type, id: entry.id, url: entry.url, title: entry.title });
            });
            makeDraggable(btn, entry, () => bookmarks);
            return btn;
        }
        // ── Bar render ────────────────────────────────────────────────────────────
        function reportChromeHeight() {
            const showBar = bookmarkBarVisible && hasBookmarks;
            bookmarkBar.classList.toggle('hidden', !showBar);
            // Measured, not hardcoded: this number offsets the page view, so a
            // constant that drifted from .bookmark-bar's height (30 here, 34 in
            // CSS, 28 in the docs) left the page sitting above its own card.
            let h = showBar ? Math.round(bookmarkBar.getBoundingClientRect().height) : 0;
            /* The notice bar shares this strip, so it shares the measurement.
               Reported from here because there is exactly ONE number the main
               process offsets the page by — a second reporter would race this
               one and whichever spoke last would win. renderer.js calls
               reportHeight() when a notice appears or goes. */
            const notice = document.getElementById('notice-bar');
            if (notice && !notice.classList.contains('hidden'))
                h += Math.round(notice.getBoundingClientRect().height);
            /* The Alt menu bar shares this top strip too (frameless Windows). Like
               the notice bar it reports through this one number, so the page card
               moves down by its height instead of being covered — menu-bar.js in
               renderer.js calls reportHeight() when the bar shows or hides. */
            const menuBar = document.getElementById('menu-bar');
            if (menuBar && !menuBar.classList.contains('hidden'))
                h += Math.round(menuBar.getBoundingClientRect().height);
            window.electronAPI.reportChromeHeight(h);
        }
        reportChromeHeight();
        async function refreshBookmarkBar() {
            if (renamingFolderId)
                return;
            closeDropdown();
            bookmarkBarItems.innerHTML = '';
            if (!bookmarkBarVisible) {
                hasBookmarks = false;
                reportChromeHeight();
                return;
            }
            const seq = ++refreshSeq;
            let bookmarks = [];
            try {
                bookmarks = await window.browserBookmarks.getAll();
            }
            catch (e) { window.northstarLog?.debug('bookmark-bar', 'refreshBookmarkBar: ' + e); }
            if (seq !== refreshSeq)
                return; // stale — a newer refresh started
            hasBookmarks = bookmarks.length > 0;
            reportChromeHeight();
            if (!hasBookmarks)
                return;
            const rendered = [];
            bookmarks.forEach(entry => {
                const el = makeBarElement(entry, bookmarks);
                bookmarkBarItems.appendChild(el);
                rendered.push({ el, entry });
            });
            // Overflow detection: hide items that don't fit and add a "» N" button
            requestAnimationFrame(() => {
                const barRight = bookmarkBarItems.getBoundingClientRect().right;
                const OVERFLOW_W = 40;
                const anyOverflow = rendered.some(r => r.el.getBoundingClientRect().right > barRight);
                if (!anyOverflow)
                    return;
                let overflowStart = -1;
                for (let i = 0; i < rendered.length; i++) {
                    if (rendered[i].el.getBoundingClientRect().right > barRight - OVERFLOW_W) {
                        overflowStart = i;
                        break;
                    }
                }
                if (overflowStart !== -1) {
                    for (let i = overflowStart; i < rendered.length; i++)
                        rendered[i].el.style.display = 'none';
                    const hidden = rendered.slice(overflowStart).map(r => r.entry);
                    const count = hidden.filter(e => e.type !== 'divider').length;
                    const more = document.createElement('button');
                    more.className = 'bookmark-bar-item bookmark-bar-more';
                    more.textContent = `» ${count}`;
                    more.title = `${count} more`;
                    more.addEventListener('click', (e) => {
                        e.stopPropagation();
                        openDropdown(more, '__overflow__', (panel) => {
                            // Pass '__root__' as parentFolderId so drag handlers are attached
                            hidden.forEach(entry => panel.appendChild(makeDropdownItem(entry, '__root__')));
                        });
                    });
                    bookmarkBarItems.appendChild(more);
                }
            });
        }
        // ── Bar context menu events ───────────────────────────────────────────────
        bookmarkBar.addEventListener('contextmenu', (e) => {
            if (e.target.closest('.bookmark-bar-item, .bookmark-bar-divider'))
                return;
            e.preventDefault();
            window.browserBookmarks.showBarContextMenu({ type: 'bar-bg', bookmarkBarVisible });
        });
        bookmarkBar.addEventListener('dragover', (e) => {
            if (!bmDragActive || !dragSrcFolderId)
                return;
            if (e.target.closest('.bookmark-bar-item, .bookmark-bar-divider'))
                return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
        });
        bookmarkBar.addEventListener('drop', async (e) => {
            if (!dragSrcId || !dragSrcFolderId)
                return;
            if (e.target.closest('.bookmark-bar-item, .bookmark-bar-divider'))
                return;
            e.preventDefault();
            await window.browserBookmarks.moveOutOfFolder(dragSrcId, dragSrcFolderId, null);
        });
        new ResizeObserver(() => { if (bookmarkBarVisible && hasBookmarks)
            refreshBookmarkBar(); })
            .observe(bookmarkBarItems);
        // ── Bookmark ★ button ─────────────────────────────────────────────────────
        async function updateBookmarkBtn(url) {
            if (!url || url === 'newtab' || url.startsWith('file://')) {
                bookmarkBtn.classList.remove('bookmarked');
                return;
            }
            try {
                const has = await window.browserBookmarks.has(url);
                bookmarkBtn.classList.toggle('bookmarked', has);
            }
            catch (e) { window.northstarLog?.debug('bookmark-bar', 'updateBookmarkBtn: ' + e); }
        }
        bookmarkBtn.addEventListener('click', async () => {
            if (!ctx.currentUrl() || ctx.currentUrl() === 'newtab' || ctx.currentUrl().startsWith('file://'))
                return;
            const rect = bookmarkBtn.getBoundingClientRect();
            let hasObj = false, bkmkTitle = ctx.currentTitle() || ctx.currentUrl(), bkmkId = null;
            try {
                const all = await window.browserBookmarks.getAll();
                const existing = all.find(b => b.type === 'bookmark' && b.url === ctx.currentUrl());
                if (existing) {
                    hasObj = true;
                    bkmkTitle = existing.title || existing.url;
                    bkmkId = existing.id;
                }
            }
            catch (e) { window.northstarLog?.debug('bookmark-bar', 'updateBookmarkBtn: ' + e); }
            await window.electronAPI.openBookmarkPrompt({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }, ctx.currentUrl(), bkmkTitle, hasObj, bkmkId);
        });
        // ── Bookmark bar event wiring ─────────────────────────────────────────────
        function initBookmarkBar() {
            window.electronAPI.onBookmarkAddPrompt(() => {
                if (!ctx.currentUrl() || ctx.currentUrl() === 'newtab' || ctx.currentUrl().startsWith('file://'))
                    return;
                const rect = bookmarkBtn.getBoundingClientRect();
                window.electronAPI.openBookmarkPrompt({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }, ctx.currentUrl(), ctx.currentTitle(), false, null);
            });
            window.electronAPI.onBookmarkEditPrompt(({ id, url, title }) => {
                const rect = bookmarkBtn.getBoundingClientRect();
                window.electronAPI.openBookmarkPrompt({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }, url, title, true, id);
            });
            window.electronAPI.onBookmarkFolderRename(({ id, title }) => {
                const rect = bookmarkBtn.getBoundingClientRect();
                window.electronAPI.openBookmarkPrompt({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }, null, title, true, id, 'folder-rename');
            });
            window.electronAPI.onBookmarkNewFolderPrompt(async () => {
                window.electronAPI.closeFolderDropdown();
                const id = await window.browserBookmarks.addFolder('New Folder');
                await refreshBookmarkBar();
                startInlineBarRename(id, 'New Folder');
            });
            window.electronAPI.onToggleBookmarkBar(() => {
                bookmarkBarVisible = !bookmarkBarVisible;
                window.northstarSettings.set('bookmarkBarVisible', bookmarkBarVisible);
                refreshBookmarkBar();
            });
            window.browserBookmarks.onChanged(() => { refreshBookmarkBar(); updateBookmarkBtn(ctx.currentUrl()); });
            window.electronAPI.onBookmarkPromptClosed(() => updateBookmarkBtn(ctx.currentUrl()));
            refreshBookmarkBar();
        }
        /** Inline rename for a folder label directly in the bookmark bar. */
        function startInlineBarRename(folderId, defaultName) {
            const btn = bookmarkBarItems.querySelector(`[data-id="${folderId}"]`);
            if (!btn)
                return;
            const lbl = btn.querySelector('.bookmark-bar-label');
            if (!lbl)
                return;
            renamingFolderId = folderId;
            lbl.style.display = 'none';
            const input = document.createElement('input');
            input.className = 'bookmark-bar-rename-input';
            input.value = defaultName || '';
            input.size = Math.max((defaultName || '').length, 8);
            btn.appendChild(input);
            btn.addEventListener('click', (e) => e.stopPropagation(), { capture: true, once: true });
            requestAnimationFrame(() => { input.focus(); input.select(); });
            let done = false;
            async function commit() {
                if (done)
                    return;
                done = true;
                const name = input.value.trim() || 'New Folder';
                renamingFolderId = null;
                await window.browserBookmarks.updateById(folderId, { title: name });
            }
            function cancel() {
                if (done)
                    return;
                done = true;
                renamingFolderId = null;
                input.removeEventListener('blur', commit);
                refreshBookmarkBar();
            }
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    commit();
                }
                if (e.key === 'Escape') {
                    e.preventDefault();
                    cancel();
                }
            });
            input.addEventListener('blur', commit, { once: true });
        }
        return { init: initBookmarkBar, updateButton: updateBookmarkBtn, isVisible: () => bookmarkBarVisible, reportHeight: reportChromeHeight };
    };
})(typeof window !== 'undefined' ? window : globalThis);
