/**
 * Shared helpers used across multiple IPC modules.
 * Import only what you need — keep deps lightweight.
 */
const log = require('../features/log');
/**
 * Take an overlay view out of its window AND end its renderer. Removing a
 * WebContentsView does not destroy its webContents — the renderer process lives
 * on, unreachable, so a view built per open leaked a process every time.
 */
function destroyOverlayView(win, view, where) {
    if (!view)
        return;
    try { win.contentView.removeChildView(view); }
    catch (e) { log.debug('utils', `${where} remove`, e); }
    try {
        if (!view.webContents.isDestroyed())
            view.webContents.close();
    }
    catch (e) { log.debug('utils', `${where} close`, e); }
}
/** Remove and destroy the hamburger menu WebContentsView for a window. */
function closeWindowMenu(windowData) {
    if (!windowData || !windowData.menu)
        return;
    const view = windowData.menu;
    windowData.menu = null;
    destroyOverlayView(windowData.window, view, 'closeWindowMenu');
    // When the close was the hamburger being clicked again, the same click then
    // fires 'open' — this timestamp lets that handler recognise a toggle-close
    // and NOT immediately reopen. (Harmless for every other close path.)
    windowData._menuClosedAt = Date.now();
    try {
        windowData.window.webContents.send('menu-closed');
        windowData.window.webContents.send('menu-capture', false);
    }
    catch (e) { log.debug('utils', 'closeWindowMenu', e); }
    if (windowData.menuCleanups) {
        for (const fn of windowData.menuCleanups) {
            try {
                fn();
            }
            catch (e) { log.debug('utils', 'if', e); }
        }
        windowData.menuCleanups = null;
    }
}
/**
 * Remove and destroy the folder-dropdown WebContentsView for a window.
 * `keepAlive` (a drag leaving the dropdown) only takes it off screen: the drag
 * began in its page, and that page must live to report the drag's end. The
 * caller destroys it later with destroyOverlayView.
 */
function closeFolderDropdown(windowData, { keepAlive = false } = {}) {
    if (!windowData || !windowData.folderDropdown)
        return null;
    const view = windowData.folderDropdown;
    windowData.folderDropdown = null;
    windowData.folderDropdownId = null;
    if (keepAlive) {
        try { windowData.window.contentView.removeChildView(view); }
        catch (e) { log.debug('utils', 'closeFolderDropdown', e); }
        return view;
    }
    destroyOverlayView(windowData.window, view, 'closeFolderDropdown');
    return null;
}
/** Remove and destroy the bookmark-star prompt for a window. */
function closeBookmarkPrompt(windowData) {
    if (!windowData || !windowData.bookmarkPrompt)
        return;
    const view = windowData.bookmarkPrompt;
    windowData.bookmarkPrompt = null;
    destroyOverlayView(windowData.window, view, 'closeBookmarkPrompt');
}
/** Send 'bookmarks-changed' to every open WebContents. */
function broadcastBookmarksChanged(webContents) {
    webContents.getAllWebContents().forEach(wc => { try {
        wc.send('bookmarks-changed');
    }
    catch (e) { log.debug('utils', 'broadcastBookmarksChanged', e); } });
    // Extensions get the precise chrome.bookmarks events, worked out by diffing
    // against the previous tree — this is the one place every mutation in the
    // app passes through, whoever made it.
    try { require('../features/ext-events').bookmarksChanged(); }
    catch (e) { log.debug('utils', 'broadcastBookmarksChanged', e); }
}

module.exports = { destroyOverlayView, closeWindowMenu, closeFolderDropdown, closeBookmarkPrompt, broadcastBookmarksChanged };