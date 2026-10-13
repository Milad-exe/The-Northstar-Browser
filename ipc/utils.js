/**
 * Shared helpers used across multiple IPC modules.
 * Import only what you need — keep deps lightweight.
 */
/** Remove and destroy the hamburger menu WebContentsView for a window. */
const log = require('../features/log');
function closeWindowMenu(windowData) {
    if (!windowData || !windowData.menu)
        return;
    try {
        windowData.window.contentView.removeChildView(windowData.menu);
    }
    catch (e) { log.debug('utils', 'closeWindowMenu', e); }
    windowData.menu = null;
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
/** Remove and destroy the folder-dropdown WebContentsView for a window. */
function closeFolderDropdown(windowData) {
    if (!windowData || !windowData.folderDropdown)
        return;
    try {
        windowData.window.contentView.removeChildView(windowData.folderDropdown);
    }
    catch (e) { log.debug('utils', 'closeFolderDropdown', e); }
    windowData.folderDropdown = null;
    windowData.folderDropdownId = null;
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

module.exports = { closeWindowMenu, closeFolderDropdown, broadcastBookmarksChanged };