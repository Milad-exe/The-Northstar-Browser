'use strict';
/**
 * The classic menu bar — File / Edit / View / History / Bookmarks / Profiles /
 * Tools / Help — as a Firefox-style bar: hidden on Windows/Linux until Alt is
 * pressed (window-manager.js sets autoHideMenuBar), and the system menu bar on
 * macOS.
 *
 * KEY RULE — the accelerators are DISPLAY ONLY on Windows/Linux
 * (`registerAccelerator: false`). Every keyboard shortcut in this browser is
 * handled by Shortcuts.handleInput on `before-input-event`, which acts on the
 * ACTIVE TAB rather than whichever webContents holds focus. If the menu also
 * bound these keys they would fire twice — the exact reason the app shipped with
 * no menu bar on those platforms. The menu still shows the shortcut next to each
 * item (so it is discoverable) and still runs the action when CLICKED; it just
 * does not own the key.
 *
 * macOS is the exception: the OS delivers standard shortcuts THROUGH the menu's
 * key-equivalents, so the appMenu/editMenu roles and the Cmd+1-9 tab items
 * register normally there — but the browser actions (Cmd+T/W/R/zoom) still stay
 * on before-input-event, so they carry `registerAccelerator: false` too and are
 * not double-bound.
 *
 * Every action runs against the MOST-RECENTLY-FOCUSED window, resolved fresh on
 * each click, so the menu drives whatever window you are looking at.
 */
const { Menu, app, webContents } = require('electron');
const log = require('./log');

let wmRef = null;
const mac = process.platform === 'darwin';

function focusedWd() {
    if (!wmRef)
        return null;
    try { return (wmRef.getMostRecentlyFocusedWindow?.() || wmRef.getPrimaryWindow?.()) || null; }
    catch { return null; }
}
/** Run `fn(wd, wd.tabs)` on the focused window, swallowing errors. */
const onTabs = (fn) => () => {
    const wd = focusedWd();
    if (wd?.tabs) { try { fn(wd, wd.tabs); } catch (e) { log.debug('app-menu', 'action', e); } }
};
const activeTabWc = () => {
    const wd = focusedWd();
    const t = wd?.tabs;
    const tab = t && t.tabMap.get(t.activeTabIndex);
    return (tab && tab.webContents && !tab.webContents.isDestroyed()) ? tab.webContents : null;
};
const newTab = () => { const wd = focusedWd(); if (wd?.tabs) { try { wd.tabs.openInternalPage('home'); } catch (e) { log.debug('app-menu', 'newtab', e); } } };
/** Whatever webContents currently holds focus — the right target for clipboard. */
const focusedWc = () => { try { return webContents.getFocusedWebContents(); } catch { return null; } };

/* Display an accelerator without binding it (see the KEY RULE above). On macOS
   the roles/tab items that legitimately register are built with plain
   `accelerator`; everything here is browser actions that before-input-event
   owns, so it is display-only on every platform. */
const acc = (accelerator, extra = {}) => ({ accelerator, registerAccelerator: false, ...extra });

function profilesSubmenu() {
    let list = [];
    let currentId = null;
    try {
        list = require('./profiles').list() || [];
        currentId = focusedWd()?.profileId ?? null;
    }
    catch (e) { log.debug('app-menu', 'profiles', e); }
    const items = list.map(p => ({
        label: String(p.name || ('Space ' + p.id)),
        type: 'radio',
        checked: String(p.id) === String(currentId),
        click: () => { const wd = focusedWd(); if (wd) { try { wmRef.switchWorkspace(wd, p.id); } catch (e) { log.debug('app-menu', 'switch', e); } } },
    }));
    items.push({ type: 'separator' });
    items.push({
        label: 'New Space',
        click: () => {
            const wd = focusedWd();
            try { const p = require('./profiles').create(); if (wd && p) wmRef.switchWorkspace(wd, p.id); refresh(); }
            catch (e) { log.debug('app-menu', 'new space', e); }
        },
    });
    return items;
}

function template() {
    const fileMenu = {
        label: 'File',
        submenu: [
            { label: 'New tab', ...acc('CmdOrCtrl+T'), click: newTab },
            { label: 'New Window', ...acc('CmdOrCtrl+N'), click: () => { try { wmRef.createWindow(); } catch (e) { log.debug('app-menu', 'new win', e); } } },
            { label: 'New Private Window', ...acc('CmdOrCtrl+Shift+N'), click: () => { try { wmRef.createWindow(800, 600, { private: true }); } catch (e) { log.debug('app-menu', 'new priv', e); } } },
            { type: 'separator' },
            { label: 'Reopen Closed Tab', ...acc('CmdOrCtrl+Shift+T'), click: () => { const wd = focusedWd(); try { wd?.shortcuts?.reopenClosedTab(); } catch (e) { log.debug('app-menu', 'reopen', e); } } },
            { label: 'Close Tab', ...acc('CmdOrCtrl+W'), click: onTabs((wd, t) => t.removeTab(t.activeTabIndex)) },
            { type: 'separator' },
            { label: 'Print…', ...acc('CmdOrCtrl+P'), click: () => activeTabWc()?.print() },
            ...(mac ? [] : [{ type: 'separator' }, { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }]),
        ],
    };
    // Edit: on macOS the editMenu role gives the clipboard its key-equivalents
    // (needed there). On Windows/Linux Chromium already handles clipboard keys in
    // fields, so these are click-only (display-only accelerators) and act on the
    // focused webContents.
    const editMenu = mac
        ? { role: 'editMenu' }
        : {
            label: 'Edit',
            submenu: [
                { label: 'Undo', ...acc('CmdOrCtrl+Z'), click: () => focusedWc()?.undo() },
                { label: 'Redo', ...acc('CmdOrCtrl+Y'), click: () => focusedWc()?.redo() },
                { type: 'separator' },
                { label: 'Cut', ...acc('CmdOrCtrl+X'), click: () => focusedWc()?.cut() },
                { label: 'Copy', ...acc('CmdOrCtrl+C'), click: () => focusedWc()?.copy() },
                { label: 'Paste', ...acc('CmdOrCtrl+V'), click: () => focusedWc()?.paste() },
                { label: 'Select All', ...acc('CmdOrCtrl+A'), click: () => focusedWc()?.selectAll() },
                { type: 'separator' },
                { label: 'Find in Page…', ...acc('CmdOrCtrl+F'), click: onTabs((wd, t) => { const tab = t.tabMap.get(t.activeTabIndex); if (tab && t.findDialog) t.findDialog.show(tab); }) },
            ],
        };
    const viewMenu = {
        label: 'View',
        submenu: [
            { label: 'Reload', ...acc('CmdOrCtrl+R'), click: onTabs((wd, t) => t.reload(t.activeTabIndex)) },
            { type: 'separator' },
            { label: 'Zoom In', ...acc('CmdOrCtrl+Plus'), click: () => { const wd = focusedWd(); try { wd?.shortcuts?.zoomIn(); } catch (e) { log.debug('app-menu', 'zoom', e); } } },
            { label: 'Zoom Out', ...acc('CmdOrCtrl+-'), click: () => { const wd = focusedWd(); try { wd?.shortcuts?.zoomOut(); } catch (e) { log.debug('app-menu', 'zoom', e); } } },
            { label: 'Actual Size', ...acc('CmdOrCtrl+0'), click: () => { const wd = focusedWd(); try { wd?.shortcuts?.resetZoom(); } catch (e) { log.debug('app-menu', 'zoom', e); } } },
            { type: 'separator' },
            { label: 'Toggle Full Screen', ...acc(mac ? 'Ctrl+Cmd+F' : 'F11'), click: () => { const wd = focusedWd(); try { wd?.shortcuts?.toggleFullScreen(); } catch (e) { log.debug('app-menu', 'fullscreen', e); } } },
        ],
    };
    const historyMenu = {
        label: 'History',
        submenu: [
            { label: 'Back', ...acc(mac ? 'Cmd+Left' : 'Alt+Left'), click: onTabs((wd, t) => t.goBack(t.activeTabIndex)) },
            { label: 'Forward', ...acc(mac ? 'Cmd+Right' : 'Alt+Right'), click: onTabs((wd, t) => t.goForward(t.activeTabIndex)) },
            { type: 'separator' },
            { label: 'Show Full History', ...acc(mac ? 'Cmd+Y' : 'CmdOrCtrl+H'), click: onTabs((wd, t) => t.openInternalPage('history')) },
        ],
    };
    const bookmarksMenu = {
        label: 'Bookmarks',
        submenu: [
            { label: 'Show All Bookmarks', ...acc('CmdOrCtrl+Shift+O'), click: onTabs((wd, t) => t.openInternalPage('bookmarks')) },
            { label: 'Show Bookmarks Bar', ...acc('CmdOrCtrl+Shift+B'), click: () => { const wd = focusedWd(); try { wd?.window?.webContents?.send('toggle-bookmark-bar'); } catch (e) { log.debug('app-menu', 'bmbar', e); } } },
        ],
    };
    const toolsMenu = {
        label: 'Tools',
        submenu: [
            { label: 'Settings', ...acc('CmdOrCtrl+,'), click: onTabs((wd, t) => t.openInternalPage('settings')) },
            { label: 'Passwords', click: onTabs((wd, t) => t.openInternalPage('settings', 'passwords')) },
            { label: 'Extensions', click: onTabs((wd, t) => t.openInternalPage('settings', 'extensions')) },
            { type: 'separator' },
            { label: 'Developer Tools', ...acc(mac ? 'Cmd+Alt+I' : 'CmdOrCtrl+Shift+I'), click: () => { const wc = activeTabWc(); try { wc?.toggleDevTools(); } catch (e) { log.debug('app-menu', 'devtools', e); } } },
        ],
    };
    const helpMenu = {
        role: 'help',
        submenu: [
            {
                label: 'About Northstar',
                click: () => {
                    try {
                        const { dialog } = require('electron');
                        dialog.showMessageBox({ type: 'info', title: 'Northstar', message: 'Northstar', detail: 'Version ' + app.getVersion() });
                    }
                    catch (e) { log.debug('app-menu', 'about', e); }
                },
            },
        ],
    };
    const profilesMenu = { label: 'Profiles', submenu: profilesSubmenu() };

    const browser = [fileMenu, editMenu, viewMenu, historyMenu, bookmarksMenu, profilesMenu, toolsMenu, helpMenu];
    if (mac) {
        // The tab-switching Cmd+1-9 items DO register here — before-input-event
        // does not reliably receive them on macOS (the same reason the old menu
        // existed). Everything else in `browser` is display-only.
        const tabItems = [1, 2, 3, 4, 5, 6, 7, 8].map(n => ({
            label: `Tab ${n}`, accelerator: `CmdOrCtrl+${n}`,
            click: () => { const wd = focusedWd(); try { wd?.shortcuts?.switchToTabByNumber(n); } catch (e) { log.debug('app-menu', 'tab', e); } },
        }));
        const tabsMenu = {
            label: 'Tabs',
            submenu: [
                ...tabItems,
                { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: () => { const wd = focusedWd(); try { wd?.shortcuts?.switchToNextTab(); } catch (e) { log.debug('app-menu', 'tab', e); } } },
                { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: () => { const wd = focusedWd(); try { wd?.shortcuts?.switchToPreviousTab(); } catch (e) { log.debug('app-menu', 'tab', e); } } },
            ],
        };
        return [{ role: 'appMenu' }, ...browser.slice(0, 6), tabsMenu, ...browser.slice(6)];
    }
    return browser;
}

/**
 * The eight menus — File … Help — for the in-chrome Alt menu bar
 * (features/menu-bar.js), used on the frameless Windows window where the OS
 * cannot draw a native bar. Same menus, same click handlers as the native bar;
 * only the presentation differs. Built fresh each call so the Profiles list and
 * its checkmark are current. Returns [{ label, submenu }] with every label
 * resolved — the Help menu is a role with no label of its own.
 */
function barMenus() {
    return template()
        .map(m => ({
            label: m.label || (m.role === 'help' ? 'Help' : (m.role || '')),
            submenu: Array.isArray(m.submenu) ? m.submenu : (m.submenu && m.submenu.items) || [],
        }))
        .filter(m => m.label && m.submenu.length);
}

/** Build and install the menu. On macOS this is the system menu bar; on Linux
 *  window-manager hides the (framed) bar until Alt (autoHideMenuBar). Windows is
 *  frameless — the OS cannot draw a menu bar there, and a set-but-invisible menu
 *  only lets Alt steal focus to nothing, so no native menu is installed; the Alt
 *  menu is the in-chrome bar (features/menu-bar.js), which reuses barMenus(). */
function install(wm) {
    wmRef = wm || wmRef;
    if (process.platform === 'win32') {
        try { Menu.setApplicationMenu(null); }
        catch (e) { log.debug('app-menu', 'install win', e); }
        return;
    }
    try { Menu.setApplicationMenu(Menu.buildFromTemplate(template())); }
    catch (e) { log.warn('app-menu', 'install', e); }
}

/** Rebuild — the Profiles list and its checkmark are a snapshot at build time,
 *  so call this after spaces change or the focused window switches space. */
function refresh() {
    if (wmRef)
        install(wmRef);
}

module.exports = { install, refresh, build: template, barMenus };
