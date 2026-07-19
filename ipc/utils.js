/**
 * Shared helpers used across multiple IPC modules.
 * Import only what you need — keep deps lightweight.
 */
/** Remove and destroy the hamburger menu WebContentsView for a window. */
function closeWindowMenu(windowData) {
    if (!windowData || !windowData.menu)
        return;
    try {
        windowData.window.contentView.removeChildView(windowData.menu);
    }
    catch { }
    windowData.menu = null;
    try {
        windowData.window.webContents.send('menu-closed');
    }
    catch { }
    if (windowData.menuCleanups) {
        for (const fn of windowData.menuCleanups) {
            try {
                fn();
            }
            catch { }
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
    catch { }
    windowData.folderDropdown = null;
    windowData.folderDropdownId = null;
}
/** Send 'bookmarks-changed' to every open WebContents. */
function broadcastBookmarksChanged(webContents) {
    webContents.getAllWebContents().forEach(wc => { try {
        wc.send('bookmarks-changed');
    }
    catch { } });
}

module.exports = { closeWindowMenu, closeFolderDropdown, broadcastBookmarksChanged };