const { app } = require('electron');
const path = require('path');
/**
 * Resolve an app-root-relative path like 'renderer/Browser/index.html' to an
 * absolute path. app.getAppPath() points at the directory holding package.json
 * in both dev (project root) and packaged (asar root), and the app's files live
 * directly under it, so this just anchors the relative path there.
 */
function resolveAppFile(rel) {
    return path.join(app.getAppPath(), rel);
}

module.exports = { resolveAppFile };
