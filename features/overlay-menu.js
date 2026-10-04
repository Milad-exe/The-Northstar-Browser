'use strict';
/**
 * Electron Menu templates, drawn as the app's own menu.
 *
 * The browser had TWO context-menu systems that looked nothing like each other.
 * Right-clicking the sidebar, a tab row or a space gave the themed overlay
 * (renderer/CtxMenu) — Onest, Phosphor icons, the app's radii and colours.
 * Right-clicking a WEB PAGE, a bookmark, the folder dropdown or a glance gave a
 * native OS menu in the system font. Same gesture, two different products.
 *
 * The overlay is driven from the chrome renderer, which owns its own callbacks
 * (handlers cannot cross IPC — the view is sent row LABELS and returns the path
 * of indices that was picked). Main-process code has Electron templates with
 * inline click() functions instead, so this adapts one to the other: flatten a
 * template to labels, show the overlay, walk the returned path back to the item
 * and call its click().
 *
 * Falls back to the native menu if the overlay cannot be shown, so a menu is
 * never simply missing.
 */
const log = require('./log');

let showFn = null;   // injected by ipc/ctxmenu at registration (features/ does
                     // not require ipc/ directly — ipc/ already requires features/)
let hideFn = null;   // ditto, to dismiss the overlay from feature-layer code

function provide(fn, hide) {
    showFn = typeof fn === 'function' ? fn : null;
    if (typeof hide === 'function')
        hideFn = hide;
}

/** Dismiss the overlay context menu if one is up. A no-op otherwise. */
function hide(wd) {
    try { if (hideFn && wd) hideFn(wd); }
    catch (e) { log.debug('overlay-menu', 'hide', e); }
}

/** Electron template -> the overlay's row shape. Keeps separators and submenus. */
function toRows(template) {
    const rows = [];
    for (const item of template || []) {
        if (!item || item.visible === false)
            continue;
        if (item.type === 'separator') {
            rows.push({ sep: true });
            continue;
        }
        const row = { label: String(item.label || '') };
        if (item.enabled === false)
            row.disabled = true;
        if (item.type === 'checkbox' || item.type === 'radio')
            row.checked = !!item.checked;
        // The shortcut hint (U1-1). The overlay formats it per platform with
        // renderer/lib/keys.js formatAccelerator; only a string crosses IPC.
        if (typeof item.accelerator === 'string' && item.accelerator)
            row.accelerator = item.accelerator;
        const sub = item.submenu && (Array.isArray(item.submenu) ? item.submenu : item.submenu.items);
        if (sub && sub.length)
            row.sub = toRows(sub);
        rows.push(row);
    }
    return rows;
}

/** Walk a picked index path back to the template item it names. */
function itemAt(template, path) {
    let list = (template || []).filter(i => i && i.visible !== false);
    let item = null;
    for (const idx of path) {
        item = list[idx];
        if (!item)
            return null;
        const sub = item.submenu && (Array.isArray(item.submenu) ? item.submenu : item.submenu.items);
        list = (sub || []).filter(i => i && i.visible !== false);
    }
    return item;
}

/**
 * Show `template` as the app's menu at (x, y) in `wd`'s window.
 * Returns true if the overlay took it; false means the caller should popup()
 * natively itself.
 *
 * `onClose(picked)` — if given — is called once when the menu session ends,
 * whether an item was picked (picked = true) or it was dismissed (false). The
 * menu bar uses it to clear the pressed top-level item and to hide the bar after
 * an action.
 *
 * `opts.mnemonics` — when true, the overlay underlines an access-key letter on
 * each row and lets a keypress activate it (opening submenus and following the
 * chain). Used by the in-chrome menu bar; right-click menus leave it off.
 */
function popup(wd, template, x, y, onClose, opts) {
    if (!showFn || !wd || !Array.isArray(template) || !template.length)
        return false;
    const rows = toRows(template);
    if (!rows.length)
        return false;
    try {
        showFn(wd, { rows, x: Math.round(x || 0), y: Math.round(y || 0), mnemonics: !!(opts && opts.mnemonics) }, (path) => {
            const picked = Array.isArray(path);
            try {
                if (picked) {
                    const item = itemAt(template, path);
                    if (item && typeof item.click === 'function')
                        item.click(item);
                }
            }
            catch (e) { log.warn('overlay-menu', 'menu item threw', e); }
            finally { try { if (typeof onClose === 'function') onClose(picked); } catch (e) { log.debug('overlay-menu', 'onClose', e); } }
        });
        return true;
    }
    catch (e) {
        log.debug('overlay-menu', 'popup', e);
        return false;
    }
}

module.exports = { popup, provide, hide, toRows, itemAt };
