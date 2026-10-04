'use strict';
/**
 * The overlay views a window can have — in ONE place.
 *
 * Every menu, panel, prompt and floating control is its own WebContentsView
 * layered over the page (chrome DOM cannot paint on a native page view). Two
 * functions have to know the full set:
 *
 *   - Tabs.raiseFloatingViews() lifts them back above the tab views whenever a
 *     tab is created or shown, or they sink behind the page.
 *   - WindowManager.getWindowByWebContents() resolves which window a view
 *     belongs to, so its IPC and permission prompts land in the right place.
 *
 * These lists used to be maintained by hand in both functions, and drifted: an
 * overlay added to one but not the other either sank behind the page or could
 * not resolve its window — the single most common bug in this codebase
 * (CLAUDE.md invariant 4). Declaring the set once, here, makes that class of
 * bug impossible: a new overlay is added in this file and is automatically in
 * both.
 *
 * `wd` is a windowData record. Tab-owned transient overlays (split, glance) live
 * on wd.tabs; the persistent panels live on wd directly.
 */
function overlayViewsOf(wd) {
    if (!wd)
        return [];
    const t = wd.tabs || {};
    return [
        // Tab-owned, transient: split view furniture and the glance preview.
        t.splitDivider, ...(t.splitHandles || []), t.splitDrop,
        t.glanceBackdrop, t.glanceView, t.glanceBar,
        // Window-owned panels, created lazily and kept.
        wd.sidePanel, wd.sidePanelHeader, wd.menu, wd.suggestions,
        wd.bookmarkPrompt, wd.folderDropdown, wd.downloadsPanel,
        wd.extensionsPanel, wd.passwordPrompt, wd.ctxMenu,
        wd.themePanel, wd.pageActions, wd.permView, wd.miniPlayer,
        wd.siteInfoView, wd.hangPrompt,
    ].filter(Boolean);
}

/** Does `wc` belong to one of `wd`'s overlay views? */
function isOverlayOf(wd, wc) {
    return overlayViewsOf(wd).some(v => {
        try { return v.webContents === wc; }
        catch { return false; }
    });
}

module.exports = { overlayViewsOf, isOverlayOf };
