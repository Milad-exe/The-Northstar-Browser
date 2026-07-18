// IIFE: compiled as a classic <script>; the wrapper keeps this page's
// top-level names out of the shared global scope.
(() => {
/**
 * FolderDropdown — single-panel drill-down renderer
 *
 * Drag reliability invariant (macOS/Chromium):
 *   Chromium fires spurious `dragend` when the drag source element is moved or
 *   removed from the DOM mid-drag. To prevent this, springInto() NEVER touches
 *   the drag source element — it stays hidden in-place inside the list. Only
 *   its sibling nodes are removed/added, which does not affect the drag source's
 *   ancestry and does not trigger spurious dragend.
 *
 *   List-level event handlers are attached ONCE at build time and read folderId
 *   from list.dataset.folderId so they don't need re-attaching on spring nav.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const FOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="12"
  viewBox="0 0 24 20" fill="currentColor">
  <path d="M10,4H4C2.89,4 2,4.89 2,6V18A2,2 0 0,0 4,20H20A2,2 0 0,0
           22,18V8C22,6.89 21.1,6 20,6H12L10,4Z"/>
</svg>`;

const BACK_ARROW_SVG = `<svg width="6" height="10" viewBox="0 0 6 10" fill="none"
  stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
  <path d="M5 1L1 5l4 4"/>
</svg>`;

const CHEVRON_RIGHT_SVG = `<svg width="5" height="9" viewBox="0 0 5 9" fill="none"
  stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
  <path d="M1 1l3 3.5L1 8"/>
</svg>`;

const DRAG_SPRING_DELAY = 500;
const MAX_HEIGHT        = 480;
const PANEL_WIDTH       = 240;
const PANEL_PADDING     = 16;


// ─────────────────────────────────────────────────────────────────────────────
// Tree state
// ─────────────────────────────────────────────────────────────────────────────

let rootData    = null;   // { folderId, title, children[] }
let currentNode = null;   // null = rootData, else a folder entry reference
let backStack   = [];     // stack for click-based back navigation

function currentFolder() {
    return currentNode || rootData;
}


// ─────────────────────────────────────────────────────────────────────────────
// Drag state
// ─────────────────────────────────────────────────────────────────────────────

let dragId          = null;
let dragFolderId    = null;
let dragSpringTimer = null;
let dragSpringBtn   = null;
let insidePanel     = false;
let leftDropdown    = false;
let pendingResize   = false;
let renamingId      = null;
let lastRaiseAt     = 0;
let backHoverTimer  = null;

// True once we've received at least one dragover after the most recent
// springInto call. A real mouse release always produces dragover events
// before dragend (Chromium fires dragover continuously while mouse is
// held). A spurious dragend from a DOM mutation fires with NO preceding
// dragover — we use that to tell them apart.
let gotDragoverAfterSpring = true;

function getDragIdFromEvent(e) {
    if (dragId) return dragId;
    const id = e?.dataTransfer?.getData?.('text/plain');
    if (typeof id !== 'string') return null;
    const trimmed = id.trim();
    return trimmed || null;
}

function isBookmarkDragEvent(e) {
    if (dragId) return true;
    const dt = e?.dataTransfer;
    if (!dt) return false;
    if (Array.from(dt.types || []).includes('text/plain')) return true;
    return !!getDragIdFromEvent(e);
}

function ensureRaised() {
    const now = Date.now();
    if (now - lastRaiseAt < 120) return;
    lastRaiseAt = now;
    window.folderDropdown.raise();
}

function canGoBackOneLevel() {
    return !!currentNode || backStack.length > 0;
}

function clearBackHoverTimer() {
    if (backHoverTimer !== null) {
        clearTimeout(backHoverTimer);
        backHoverTimer = null;
    }
}

function armBackHoverTimer(isDragBack) {
    clearBackHoverTimer();
    backHoverTimer = setTimeout(() => {
        backHoverTimer = null;
        if (isDragBack) {
            springBack();
            return;
        }
        if (!dragId && canGoBackOneLevel()) clickBack();
    }, DRAG_SPRING_DELAY);
}


// ─────────────────────────────────────────────────────────────────────────────
// IPC handlers
// ─────────────────────────────────────────────────────────────────────────────

window.folderDropdown.onInit(({ children, folderId, title }) => {
    rootData    = { folderId, title: title || 'Folder', children: children || [] };
    currentNode = null;
    backStack   = [];
    dragId = null; dragFolderId = null;
    dragSpringTimer = null; dragSpringBtn = null;
    insidePanel = false; leftDropdown = false;
    pendingResize = false; renamingId = null;
    lastRaiseAt = 0;
    clearBackHoverTimer();
    gotDragoverAfterSpring = true;
    renderPanel();
});

window.folderDropdown.onRefreshPanel(({ folderId, children, renameId }) => {
    if (rootData && rootData.folderId === folderId) {
        rootData = { ...rootData, children };
    }
    for (let i = 0; i < backStack.length; i++) {
        if (backStack[i]?.id === folderId) backStack[i] = { ...backStack[i], children };
    }
    if (currentNode && currentNode.id === folderId) {
        currentNode = { ...currentNode, children };
    }
    if (!dragId && currentNode) {
        currentNode = null;
        backStack   = [];
    }
    renderPanel();
    if (renameId) requestAnimationFrame(() => startInlineRename(renameId, ''));
});

window.folderDropdown.onStartRename(({ id, title }) => {
    startInlineRename(id, title || '');
});


// ─────────────────────────────────────────────────────────────────────────────
// Click navigation
// ─────────────────────────────────────────────────────────────────────────────

function clickInto(entry) {
    if (currentNode) backStack.push(currentNode);
    else             backStack.push(null);
    currentNode = entry;
    renderPanel();
}

function clickBack() {
    if (!canGoBackOneLevel()) return;
    if (!backStack.length) currentNode = null;
    else currentNode = backStack.pop();
    renderPanel();
}

function findFolderPathById(targetId) {
    if (!rootData || !targetId) return null;

    function walk(node, trail) {
        const nodeId = node.folderId || node.id;
        const nextTrail = trail.concat(node);
        if (nodeId === targetId) return nextTrail;

        const children = node.children || [];
        for (const child of children) {
            if (child.type !== 'folder') continue;
            const found = walk(child, nextTrail);
            if (found) return found;
        }
        return null;
    }

    return walk(rootData, []);
}

function getParentContextForNode(node) {
    if (!node) {
        return {
            parentNode: null,
            parentTitle: rootData?.title || 'Folder',
            parentFolderId: rootData?.folderId || null,
        };
    }

    const nodeId = node.id || node.folderId;
    const path = findFolderPathById(nodeId);
    if (!path || path.length < 2) {
        return {
            parentNode: null,
            parentTitle: rootData?.title || 'Folder',
            parentFolderId: rootData?.folderId || null,
        };
    }

    const parentRaw = path[path.length - 2];
    const grandRaw = path[path.length - 3] || null;
    return {
        parentNode: (parentRaw?.folderId === rootData?.folderId) ? null : parentRaw,
        parentTitle: grandRaw?.title || rootData?.title || 'Folder',
        parentFolderId: parentRaw?.folderId || parentRaw?.id || rootData?.folderId || null,
    };
}

function applyDragFolderView(nextNode, parentTitle) {
    currentNode = nextNode;

    const folder = currentFolder();
    if (!folder) return;
    const folderId = folder.folderId || folder.id;

    const container = document.getElementById('container');
    if (!container) return;

    const backBtn = container.querySelector('.back-btn');
    const hdr = container.querySelector('.folder-header');

    if (backBtn) {
        if (nextNode) {
            backBtn.querySelector('.back-label').textContent = parentTitle || rootData?.title || 'Folder';
            backBtn.classList.remove('hidden');
        } else {
            backBtn.classList.add('hidden');
        }
    }

    const list = container.querySelector('.items-list');
    if (!list) return;

    list.dataset.folderId = folderId;

    const srcEl = dragId ? list.querySelector(`.item[data-id="${dragId}"]`) : null;
    if (srcEl) {
        srcEl.style.cssText =
            'visibility:hidden;height:0;padding:0;overflow:hidden;pointer-events:none;';
    }

    Array.from(list.children).forEach(child => {
        if (child !== srcEl) list.removeChild(child);
    });

    const children = folder.children || [];
    if (!children.length) {
        const empty = document.createElement('div');
        empty.className   = 'empty';
        empty.textContent = '(empty)';
        list.appendChild(empty);
    } else {
        children.forEach(c => {
            if (c.id === dragId) return;
            list.appendChild(buildItem(c, folderId, list));
        });
    }

    updateSize();
    ensureRaised();
}


// ─────────────────────────────────────────────────────────────────────────────
// Spring navigation (drag)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Navigate into a subfolder during a live drag.
 *
 * CRITICAL: the drag source element must NEVER be moved or removed from the DOM.
 * If it is, Chromium fires a spurious `dragend` and the dropdown closes.
 *
 * Strategy:
 *   1. Hide the drag source in-place (CSS only — no DOM move).
 *   2. Remove every OTHER child from the list (siblings only).
 *   3. Append the new folder's items after the hidden source.
 *   4. Update back-btn and header text/visibility (textContent + classList only).
 */
function springInto(entry) {
    ensureRaised();

    // Any dragend that arrives before our next dragover is spurious (fired
    // because the DOM mutations below disturbed Chromium's hit-test tree).
    gotDragoverAfterSpring = false;

    const parentCtx = getParentContextForNode(entry);
    applyDragFolderView(entry, parentCtx.parentTitle);
}

function springBack() {
    if (!currentNode) return;

    ensureRaised();
    gotDragoverAfterSpring = false;

    const parentCtx = getParentContextForNode(currentNode);
    applyDragFolderView(parentCtx.parentNode, parentCtx.parentTitle);
}


// ─────────────────────────────────────────────────────────────────────────────
// Render (full rebuild — only called when not mid-drag)
// ─────────────────────────────────────────────────────────────────────────────

function renderPanel() {
    const container = document.getElementById('container');
    container.innerHTML = '';

    const folder = currentFolder();
    const depth  = backStack.length + (currentNode ? 1 : 0);

    // Always create back-btn so springInto can find it.
    // folder-header is kept in DOM (hidden) for spring-nav compatibility.
    const backBtn = buildBackButton('');
    container.appendChild(backBtn);

    const hdr = document.createElement('div');
    hdr.className = 'folder-header hidden';
    container.appendChild(hdr);

    if (depth > 0) {
        const parentTitle = backStack.length
            ? (backStack[backStack.length - 1]?.title || rootData.title)
            : rootData.title;
        backBtn.querySelector('.back-label').textContent = parentTitle;
    } else {
        backBtn.classList.add('hidden');
    }

    container.appendChild(buildList(folder));
    updateSize();
}


// ─────────────────────────────────────────────────────────────────────────────
// List
// ─────────────────────────────────────────────────────────────────────────────

function buildList(folder) {
    const folderId = folder.folderId || folder.id;
    const list = document.createElement('div');
    list.className        = 'items-list';
    list.dataset.folderId = folderId;

    const children = folder.children || [];
    if (!children.length) {
        const empty = document.createElement('div');
        empty.className   = 'empty';
        empty.textContent = '(empty)';
        list.appendChild(empty);
    } else {
        children.forEach(entry => {
            if (entry.id === dragId) return;
            list.appendChild(buildItem(entry, folderId, list));
        });
    }

    // Attach list-level handlers ONCE. They read folderId from list.dataset
    // so they stay correct across spring navigations without re-attaching.
    list.addEventListener('dragenter', (e) => {
        if (!isBookmarkDragEvent(e)) return;
        clearBackHoverTimer();
        insidePanel = true;
        ensureRaised();
    });

    list.addEventListener('dragover', (e) => {
        if (e.target.closest('.item[data-id]')) return;
        if (!isBookmarkDragEvent(e)) return;
        clearBackHoverTimer();
        ensureRaised();
        gotDragoverAfterSpring = true;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
    });

    list.addEventListener('drop', async (e) => {
        if (e.target.closest('.item[data-id]')) return;
        const srcId = getDragIdFromEvent(e);
        if (!srcId) return;
        e.preventDefault();
        clearDragSpringTimer();
        clearDragVisuals();
        const targetId = list.dataset.folderId;
        if (!targetId || srcId === targetId) return;
        resetDragState();
        await window.folderDropdown.moveIntoFolder(srcId, targetId, null);
        window.folderDropdown.close();
    });

    list.addEventListener('contextmenu', (e) => {
        if (e.target.closest('.item[data-id]')) return;
        e.preventDefault();
        const f = currentFolder();
        window.folderDropdown.showCtxMenu({
            type: 'folder-bg',
            id: f.folderId || f.id,
            title: f.title,
            parentFolderId: f.folderId || f.id,
        });
    });

    return list;
}


// ─────────────────────────────────────────────────────────────────────────────
// Back button
// ─────────────────────────────────────────────────────────────────────────────

function buildBackButton(parentTitle) {
    const btn = document.createElement('button');
    btn.className = 'back-btn';

    const arrow = document.createElement('span');
    arrow.className = 'back-arrow';
    arrow.innerHTML = BACK_ARROW_SVG;

    const lbl = document.createElement('span');
    lbl.className   = 'back-label';
    lbl.textContent = parentTitle;

    btn.append(arrow, lbl);
    btn.addEventListener('click', () => { if (!dragId) clickBack(); });

    btn.addEventListener('dragenter', (e) => {
        if (!isBookmarkDragEvent(e)) return;
        if (!canGoBackOneLevel()) return;
        e.preventDefault();
        clearDragSpringTimer();
        btn.classList.add('drag-over');
        ensureRaised();
        armBackHoverTimer(true);
    });
    btn.addEventListener('dragover', (e) => {
        if (!isBookmarkDragEvent(e)) return;
        ensureRaised();
        gotDragoverAfterSpring = true;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';

        // Cross-view drags can miss dragenter on macOS.
        if (backHoverTimer === null && canGoBackOneLevel()) {
            armBackHoverTimer(true);
        }
    });
    btn.addEventListener('dragleave', (e) => {
        clearBackHoverTimer();
        if (!btn.contains(e.relatedTarget)) btn.classList.remove('drag-over');
    });
    btn.addEventListener('drop', async (e) => {
        e.preventDefault();
        btn.classList.remove('drag-over');
        clearBackHoverTimer();
        clearDragSpringTimer();
        clearDragVisuals();
        const srcId = getDragIdFromEvent(e);
        if (!srcId) return;
        const parentFolderId = getParentContextForNode(currentNode).parentFolderId;
        if (!parentFolderId || srcId === parentFolderId) return;
        resetDragState();
        await window.folderDropdown.moveIntoFolder(srcId, parentFolderId, null);
        window.folderDropdown.close();
    });

    return btn;
}


// ─────────────────────────────────────────────────────────────────────────────
// updateSize
// ─────────────────────────────────────────────────────────────────────────────

function updateSize() {
    if (dragId) { pendingResize = true; return; }
    pendingResize = false;
    const container = document.getElementById('container');
    if (!container) return;
    const h = Math.min(container.scrollHeight + 8, MAX_HEIGHT);
    window.folderDropdown.updateBounds(PANEL_WIDTH + PANEL_PADDING, h);
}


// ─────────────────────────────────────────────────────────────────────────────
// Item builders
// ─────────────────────────────────────────────────────────────────────────────

function buildItem(entry, folderId, list) {
    if (entry.type === 'divider') {
        const sep = document.createElement('div');
        sep.className = 'sep';
        return sep;
    }

    const btn = document.createElement('button');
    btn.className  = 'item';
    btn.dataset.id = entry.id;
    btn.draggable  = true;

    if (entry.type === 'folder') {
        buildFolderItem(btn, entry);
    } else {
        buildBookmarkItem(btn, entry);
    }

    attachItemContextMenu(btn, entry, folderId);
    attachItemDragHandlers(btn, entry, folderId, list);
    return btn;
}

function buildFolderItem(btn, entry) {
    const icon = document.createElement('span');
    icon.className = 'folder-icon-left';
    icon.innerHTML = FOLDER_SVG;

    const lbl = document.createElement('span');
    lbl.className   = 'item-label';
    lbl.textContent = entry.title || 'Folder';

    const arrow = document.createElement('span');
    arrow.className = 'submenu-arrow';
    arrow.innerHTML = CHEVRON_RIGHT_SVG;

    btn.append(icon, lbl, arrow);
    btn.addEventListener('click', () => { if (!dragId && !renamingId) clickInto(entry); });
}

function buildBookmarkItem(btn, entry) {
    try {
        const img   = document.createElement('img');
        img.src     = `https://www.google.com/s2/favicons?domain=${new URL(entry.url).hostname}`;
        img.onerror = () => img.remove();
        btn.appendChild(img);
    } catch {}

    const lbl = document.createElement('span');
    lbl.className = 'item-label';
    try { lbl.textContent = entry.title || new URL(entry.url).hostname; }
    catch { lbl.textContent = entry.url; }
    btn.appendChild(lbl);

    btn.addEventListener('mouseup', (e) => {
        if (dragId || renamingId || e.button === 2) return;
        if (e.metaKey || e.ctrlKey || e.button === 1) {
            window.folderDropdown.openNewTab(entry.url);
        } else {
            window.folderDropdown.navigate(entry.url);
        }
        window.folderDropdown.close();
    });

    btn.addEventListener('auxclick', (e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        window.folderDropdown.openNewTab(entry.url);
        window.folderDropdown.close();
    });
}

function attachItemContextMenu(btn, entry, folderId) {
    btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.folderDropdown.showCtxMenu({
            type: entry.type, id: entry.id,
            url: entry.url, title: entry.title,
            parentFolderId: folderId,
        });
    });
}


// ─────────────────────────────────────────────────────────────────────────────
// Drag helpers
// ─────────────────────────────────────────────────────────────────────────────

function clearDragVisuals() {
    document.querySelectorAll('.drag-into, .drop-before, .drag-over')
        .forEach(el => el.classList.remove('drag-into', 'drop-before', 'drag-over'));
}

function clearDragSpringTimer() {
    if (dragSpringTimer !== null) { clearTimeout(dragSpringTimer); dragSpringTimer = null; }
    dragSpringBtn = null;
}

function resetDragState() {
    const id = dragId;
    clearBackHoverTimer();
    dragId = null; dragFolderId = null;
    insidePanel = false; leftDropdown = false;
    // Remove the (hidden) drag source element now that the drag is over
    if (id) document.querySelector(`.item[data-id="${id}"]`)?.remove();
    if (pendingResize) updateSize();
}


// ─────────────────────────────────────────────────────────────────────────────
// Item drag handlers
// ─────────────────────────────────────────────────────────────────────────────

function attachItemDragHandlers(btn, entry, folderId, list) {
    function armHoverTarget() {
        if (dragSpringBtn === btn) return;

        clearBackHoverTimer();
        clearDragVisuals();
        clearDragSpringTimer();

        if (entry.type === 'folder') {
            btn.classList.add('drag-into');
            dragSpringBtn   = btn;
            dragSpringTimer = setTimeout(() => {
                dragSpringTimer = null;
                if (dragSpringBtn !== btn) return;
                dragSpringBtn = null;
                springInto(entry);
            }, DRAG_SPRING_DELAY);
        } else {
            btn.classList.add('drop-before');
        }
    }

    btn.addEventListener('dragstart', (e) => {
        if (renamingId) { e.preventDefault(); return; }
        clearBackHoverTimer();
        dragId       = entry.id;
        dragFolderId = folderId;
        insidePanel  = false;
        leftDropdown = false;
        btn.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', entry.id);
        ensureRaised();
    });

    btn.addEventListener('dragend', () => {
        btn.classList.remove('dragging');
        clearDragSpringTimer();
        clearDragVisuals();
        if (!dragId) return;
        // Spurious dragend: fires immediately after springInto's DOM mutations,
        // before Chromium has dispatched any dragover on the new elements.
        // A real mouse release always has dragover events preceding it.
        if (!gotDragoverAfterSpring) return;
        const left = leftDropdown;
        resetDragState();
        if (left) window.folderDropdown.dragEnd();
        else      window.folderDropdown.close();
    });

    btn.addEventListener('dragenter', (e) => {
        const srcId = getDragIdFromEvent(e);
        if (!isBookmarkDragEvent(e) || srcId === entry.id) return;
        e.preventDefault();
        ensureRaised();
        armHoverTarget();
    });

    btn.addEventListener('dragover', (e) => {
        const srcId = getDragIdFromEvent(e);
        if (!isBookmarkDragEvent(e) || srcId === entry.id) return;
        ensureRaised();
        gotDragoverAfterSpring = true;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';

        // Cross-view drags can occasionally miss dragenter on macOS.
        // Arm spring-open from dragover as a fallback.
        if (!btn.classList.contains('drag-into') && !btn.classList.contains('drop-before')) {
            armHoverTarget();
        }
    });

    btn.addEventListener('dragleave', (e) => {
        if (btn.contains(e.relatedTarget)) return;
        const movedToItem = e.relatedTarget?.closest?.('.item[data-id]');
        if (movedToItem && movedToItem !== btn) {
            if (dragSpringBtn === btn) clearDragSpringTimer();
            btn.classList.remove('drag-into', 'drop-before');
        }
    });

    btn.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        btn.classList.remove('drag-into', 'drop-before');
        clearDragSpringTimer();
        clearDragVisuals();
        const srcId = getDragIdFromEvent(e);
        if (!srcId || srcId === entry.id) return;

        const curFolderId = list.dataset.folderId || folderId;
        resetDragState();

        if (entry.type === 'folder') {
            await window.folderDropdown.moveIntoFolder(srcId, entry.id, null);
        } else {
            // Reorder within current folder: collect visible item ids, insert src before target
            const ids = Array.from(
                document.querySelector('.items-list')?.querySelectorAll('.item[data-id]') || []
            ).map(el => el.dataset.id).filter(id => id !== srcId);
            const to = ids.indexOf(entry.id);
            if (to !== -1) {
                ids.splice(to, 0, srcId);
                await window.folderDropdown.reorderInFolder(curFolderId, ids);
            } else {
                await window.folderDropdown.moveIntoFolder(srcId, curFolderId, entry.id);
            }
        }
        window.folderDropdown.close();
    });
}


// ─────────────────────────────────────────────────────────────────────────────
// Inline rename
// ─────────────────────────────────────────────────────────────────────────────

function startInlineRename(itemId, currentTitle) {
    const btn = document.querySelector(`.item[data-id="${itemId}"]`);
    if (!btn || renamingId === itemId) return;

    renamingId = itemId;
    const lbl  = btn.querySelector('.item-label');
    if (!lbl) return;

    const input = document.createElement('input');
    input.className   = 'inline-rename-input';
    input.value       = currentTitle || lbl.textContent || '';
    lbl.style.display = 'none';
    btn.appendChild(input);

    const block = (e) => e.stopPropagation();
    btn.addEventListener('mouseup', block, true);
    btn.addEventListener('click',   block, true);
    requestAnimationFrame(() => { input.focus(); input.select(); });

    let done = false;

    async function commit() {
        if (done) return; done = true;
        renamingId = null;
        btn.removeEventListener('mouseup', block, true);
        btn.removeEventListener('click',   block, true);
        const newTitle = input.value.trim() || currentTitle || 'New Folder';
        input.remove(); lbl.style.display = '';
        if (newTitle !== (currentTitle || lbl.textContent)) {
            lbl.textContent = newTitle;
            await window.folderDropdown.updateById(itemId, { title: newTitle });
        }
    }

    function cancel() {
        if (done) return; done = true;
        renamingId = null;
        btn.removeEventListener('mouseup', block, true);
        btn.removeEventListener('click',   block, true);
        input.remove(); lbl.style.display = '';
    }

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter')  { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        e.stopPropagation();
    });
    input.addEventListener('blur', commit, { once: true });
}


// ─────────────────────────────────────────────────────────────────────────────
// Global: cursor exits the WebContentsView during drag
// ─────────────────────────────────────────────────────────────────────────────

document.addEventListener('dragleave', (e) => {
    if (!dragId || !insidePanel) return;
    const exited = e.clientX <= 2 || e.clientY <= 2
        || e.clientX >= window.innerWidth  - 3
        || e.clientY >= window.innerHeight - 3;
    if (exited) {
        clearBackHoverTimer();
        leftDropdown = true;
        window.folderDropdown.dragStart(dragId, dragFolderId);
        window.folderDropdown.close();
    }
});
})();
