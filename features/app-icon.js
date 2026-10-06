/**
 * The dock/taskbar icon.
 *
 * ONE mark, ONE palette, everywhere. An app icon is how the app is recognised
 * in a dock, a switcher and a search result, so it never follows the theme.
 *
 * The mark is "Aurora": the Earth tipped toward its north pole, northern lights
 * circling the pole, a white polar cap. Its source is renderer/assets/logo.svg;
 * the binaries (logo.png, logo-win.png, icons/icon.{png,ico,icns},
 * renderer/assets/icon.png) are rendered from that design, the small .ico
 * sizes from a simplified globe without continents. This module only hands
 * the right file to the right platform API.
 */
const { app, nativeImage } = require('electron');
const { resolveAppFile } = require('../app-paths');
const log = require('./log');

/* The mark's two anchor colours (ocean, polar cap), kept for anything that
   wants to match the icon. Nothing reads them to draw the icon itself. */
const FIELD = '#162c76';
const MARK = '#f4fbff';

let cached = null;

// Windows ships its own mark (logo-win.png — padded for the taskbar's square
// slot); macOS/Linux use logo.png. window-manager creates the window with the
// same per-platform file, so both entry points agree and editing the Windows
// logo actually changes the Windows icon.
const ICON_FILE = process.platform === 'win32' ? 'logo-win.png' : 'logo.png';

/** The one icon, loaded once. */
function icon() {
    if (cached === null) {
        const img = nativeImage.createFromPath(resolveAppFile(ICON_FILE));
        cached = img.isEmpty() ? false : img;
    }
    return cached || null;
}

function setEverywhere(img, wm) {
    if (!img)
        return;
    try {
        if (process.platform === 'darwin') {
            app.dock?.setIcon(img);
            return;
        }
        wm?.getAllWindows?.().forEach(wd => {
            try { wd.window.setIcon(img); }
            catch (e) { log.debug('app-icon', 'setIcon', e); }
        });
    }
    catch (e) {
        log.warn('app-icon', 'apply', e);
    }
}

/**
 * Point the dock (macOS) or every window (Windows/Linux) at the icon.
 * `theme` is accepted and ignored — callers still pass it, and keeping the
 * signature means the theme plumbing did not have to learn that the icon
 * stopped caring.
 */
function apply(_theme, wm) {
    const img = icon();
    if (!img) {
        log.warn('app-icon', `${ICON_FILE} missing or unreadable`);
        return false;
    }
    setEverywhere(img, wm);
    return true;
}

/** A window created later starts on the bundle icon; give it ours. */
function applyToWindow(win) {
    if (process.platform === 'darwin')
        return;
    const img = icon();
    if (!img)
        return;
    try { win.setIcon(img); }
    catch (e) { log.debug('app-icon', 'applyToWindow', e); }
}

module.exports = { apply, applyToWindow, FIELD, MARK };
