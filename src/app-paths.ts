import { app } from 'electron';
import path from 'path';

/**
 * Resolve a path like 'renderer/Browser/index.html' to the built copy inside
 * app/ — the compiled output tree. Source lives in src/, but everything the
 * app loads at runtime (compiled JS, HTML, CSS) is emitted to app/, so
 * app-root-relative paths must be resolved through here rather than passed
 * straight to loadFile(). Works both in dev (project root) and packaged
 * (asar root), since app.getAppPath() points at the directory holding
 * package.json in both cases.
 */
export function resolveAppFile(rel: string): string {
    return path.join(app.getAppPath(), 'app', rel);
}
