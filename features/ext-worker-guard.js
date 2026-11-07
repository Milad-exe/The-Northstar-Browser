'use strict';
/**
 * Guard around how extension events wake an extension's service worker.
 *
 * electron-chrome-extensions delivers EVERY chrome.* event (tabs.onUpdated,
 * tabs.onRemoved, cookies.onChanged, …) to a worker by calling
 * session.serviceWorkers.startWorkerForScope() — once per event, per listener.
 * Crash dumps of the browser process (Nov 2026) show two failures on that path,
 * both inside Electron's C++ while a worker process is being allocated:
 *
 *  - at QUIT: closing the windows fires tabs.onRemoved, which starts a worker
 *    after shutdown has begun. Chromium's CHECK in
 *    RenderProcessHostImpl::GetProcessHostForSiteInstance then kills the app
 *    with a breakpoint (0x80000003) — the "exception Breakpoint" box Windows
 *    shows when the PC shuts down with Northstar open.
 *  - in normal use: an access violation in
 *    ElectronBrowserClient::AppendExtraCommandLineSwitches during
 *    ServiceWorkerProcessManager::AllocateWorkerProcess — the browser closes
 *    "for no reason".
 *
 * Neither is fixable from JS, so this cuts how often that path runs:
 *  1. Once the app is quitting (or Windows is ending the session) no worker is
 *     started or messaged. Nothing an extension could do with the event would
 *     survive the quit anyway.
 *  2. A worker that is already RUNNING is messaged directly instead of going
 *     through startWorkerForScope again.
 *  3. Starts are coalesced per scope: events that arrive while a worker is
 *     starting wait for that one start rather than each requesting their own.
 */
const log = require('./log');

let quitting = false;
let watching = false;

function watchQuit() {
    if (watching)
        return;
    watching = true;
    const { app } = require('electron');
    const stop = () => { quitting = true; };
    app.on('before-quit', stop);
    app.on('will-quit', stop);
    // Windows shutdown/log-off: WM_ENDSESSION reaches each window, and the
    // app's own 'before-quit' can come too late (the windows close first).
    app.on('browser-window-created', (_e, win) => {
        try { win.on('session-end', stop); }
        catch (e) { log.debug('ext-worker-guard', 'session-end', e); }
    });
    try {
        for (const win of require('electron').BrowserWindow.getAllWindows())
            win.on('session-end', stop);
    }
    catch (e) { log.debug('ext-worker-guard', 'existing windows', e); }
}

/** The running worker for `scope` in `session`, or null. */
function runningWorker(session, scope) {
    try {
        const running = session.serviceWorkers.getAllRunning();
        for (const [versionId, info] of Object.entries(running || {})) {
            if (info && info.scope === scope)
                return session.serviceWorkers.getWorkerFromVersionID(Number(versionId)) || null;
        }
    }
    catch (e) { log.debug('ext-worker-guard', 'running lookup', e); }
    return null;
}

/**
 * Wrap `host`'s router so its event delivery follows the rules above. Safe to
 * call more than once; a host without the expected shape is left alone.
 */
function guard(host) {
    const router = host?.ctx?.router;
    if (!router || typeof router.sendEvent !== 'function' || router.__nsGuarded)
        return;
    watchQuit();
    router.__nsGuarded = true;
    const starting = new Map(); // scope → Promise<ServiceWorkerMain>
    const original = router.sendEvent.bind(router);
    router.sendEvent = function (targetExtensionId, eventName, ...args) {
        if (quitting)
            return;
        const all = router.listeners?.get(eventName);
        if (!all || !all.length)
            return;
        const ipcName = `crx-${eventName}`;
        const session = router.session;
        let others = false;
        for (const listener of all) {
            const { type, extensionId } = listener;
            if (targetExtensionId && targetExtensionId !== extensionId)
                continue;
            if (type !== 'service-worker') {
                others = true;
                continue;
            }
            const scope = `chrome-extension://${extensionId}/`;
            const live = runningWorker(session, scope);
            if (live) {
                try { live.send(ipcName, ...args); }
                catch (e) { log.debug('ext-worker-guard', `send ${eventName}`, e); }
                continue;
            }
            let start = starting.get(scope);
            if (!start) {
                start = session.serviceWorkers.startWorkerForScope(scope)
                    .finally(() => starting.delete(scope));
                starting.set(scope, start);
            }
            start.then((sw) => {
                if (!quitting)
                    sw.send(ipcName, ...args);
            }).catch((e) => log.debug('ext-worker-guard', `wake ${extensionId} for ${eventName}`, e));
        }
        // Frame listeners (extension pages) keep the library's own delivery,
        // which never starts a worker. Hand it only those listeners.
        if (others) {
            const frames = all.filter(l => l.type !== 'service-worker');
            const saved = router.listeners.get(eventName);
            router.listeners.set(eventName, frames);
            try { original(targetExtensionId, eventName, ...args); }
            finally { router.listeners.set(eventName, saved); }
        }
    };
}

module.exports = { guard, _isQuitting: () => quitting };
