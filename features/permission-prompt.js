'use strict';
/**
 * Permission prompts — Firefox-style ask-before-use for device/resource access.
 *
 * Every session (default + each private tab session) routes permission requests
 * through attach(). High-risk resources are NEVER auto-granted; only genuinely
 * low-risk engine features are. Three tiers:
 *
 *   TIER 1 — ALLOWED (auto, low-risk): fullscreen, pointer/keyboard lock,
 *     Widevine DRM playback, sanitized clipboard *writes*, speaker selection.
 *     These are needed for normal browsing and expose no user data/hardware.
 *
 *   TIER 2 — PROMPT (block-by-default, ask the user):
 *     • camera / microphone / location / notifications — a "Remember this
 *       decision" checkbox persists the choice per-origin via
 *       Features/site-permissions.js (shown in the lock-icon panel).
 *     • screen share / clipboard *read* / MIDI — asked every time, never
 *       remembered (higher risk, rarely wanted twice).
 *     • external-app launches (mailto:, zoom:, …) — always ask.
 *     All default to DENY: nothing is enabled unless the user clicks Allow.
 *
 *   TIER 3 — DENY (everything else): USB / serial / HID / Bluetooth,
 *     storage-access, idle detection, window management, … blocked outright.
 *
 * Decision precedence (highest first):
 *   1. Session override — set from the lock-icon panel on a PRIVATE tab.
 *      In-memory only, dies with the tab's session; lets private tabs manage
 *      permissions without ever touching disk.
 *   2. Stored per-origin decision (site-permissions.js) — persistent sessions
 *      only. Any explicit 'block' vetoes the whole request, even a combined
 *      camera+microphone one (Firefox/Chrome behave the same way).
 *   3. Temporary decision — a doorhanger Allow/Block without "Remember".
 *      Scoped to the requesting page, cleared on navigation / tab close AND
 *      whenever the user changes that origin's permission in the panel, so a
 *      stale temp grant can never shadow a newer explicit choice.
 *   4. Prompt the user.
 *
 * Dismissing the doorhanger (click-away / Esc) denies the request but records
 * NOTHING — the site may re-ask, exactly like dismissing Firefox's doorhanger.
 * Only the explicit Block button records a (temp or remembered) deny.
 */
const { systemPreferences, webContents, desktopCapturer } = require('electron');
const sitePermissions = require('./site-permissions');
const permissionUI = require('./permission-ui');
/**
 * macOS gates camera/microphone at the OS level (TCC), separately from the
 * browser's own permission. Granting camera/mic in-app does nothing until the
 * OS has also granted the app access. On a first request the status is
 * "not-determined" — askForMediaAccess() triggers the native OS prompt. If the
 * user previously denied it ("denied"), macOS won't re-prompt; they must enable
 * it in System Settings › Privacy & Security. Best-effort: never blocks the
 * grant, so whatever the OS *does* allow (e.g. camera) still works.
 */
async function ensureOsMediaAccess(names) {
    if (process.platform !== 'darwin')
        return;
    for (const n of names) {
        const type = n === 'camera' ? 'camera' : (n === 'microphone' ? 'microphone' : null);
        if (!type)
            continue;
        try {
            if (systemPreferences.getMediaAccessStatus(type) === 'not-determined') {
                await systemPreferences.askForMediaAccess(type);
            }
        }
        catch { }
    }
}
// TIER 1 — allowed without asking. Strictly low-risk: no camera/mic/location,
// no filesystem/hardware, no clipboard *reads*. Just engine features a page
// needs to render normally (video fullscreen, games, DRM, copy buttons).
const ALLOWED = new Set([
    'fullscreen',
    'pointerLock',
    'keyboardLock',
    'mediaKeySystem', // Widevine — Netflix / Spotify DRM playback
    'clipboard-sanitized-write', // writing to the clipboard (not reading it)
    'speaker-selection',
]);
// TIER 2b — high-risk permissions that prompt EVERY time (never persisted).
// Silently denying these would leave the user unable to ever enable a
// legitimate screen share / MIDI device, so we ask instead of hard-blocking.
// (Screen share itself is granted via the display-media handler below; this
// entry covers engines/paths that still raise a 'display-capture' request.)
const PROMPT_ONCE = {
    'clipboard-read': 'read your clipboard contents',
    'display-capture': 'share your screen',
    'midi': 'use your MIDI devices',
    'midiSysex': 'use your MIDI devices',
};
const LABEL = {
    location: 'see your location',
    camera: 'use your camera',
    microphone: 'use your microphone',
    notifications: 'send you notifications',
};
// Permissions whose live use survives a grant (an open camera/mic stream, a
// geolocation watch). Revoking one needs the page reloaded to actually stop.
const LIVE_USE = new Set(['camera', 'microphone', 'location']);
function originOf(url) { try {
    return new URL(url).origin;
}
catch {
    return null;
} }
/**
 * Electron permission (+details) → managed site-permission names.
 * null  = not managed here (falls through to ALLOWED / deny)
 * []    = media without camera/mic (playback, speakers) — no gate needed
 */
function managedNames(permission, details) {
    if (permission === 'geolocation')
        return ['location'];
    if (permission === 'notifications')
        return ['notifications'];
    if (permission === 'media') {
        const types = (details && (details.mediaTypes || (details.mediaType ? [details.mediaType] : []))) || [];
        const names = [];
        if (types.includes('video'))
            names.push('camera');
        if (types.includes('audio'))
            names.push('microphone');
        return names;
    }
    return null;
}
function labelFor(names) {
    if (names.includes('camera') && names.includes('microphone'))
        return 'use your camera and microphone';
    return LABEL[names[0]] || 'access this device';
}
// Doorhanger icon key for a set of managed names / a raw permission string.
function iconForNames(names) {
    if (names.includes('camera'))
        return 'camera';
    if (names.includes('microphone'))
        return 'microphone';
    if (names.includes('location'))
        return 'location';
    if (names.includes('notifications'))
        return 'notifications';
    return 'generic';
}
const ICON_FOR_PERM = {
    'clipboard-read': 'clipboard',
    'display-capture': 'screen',
    'midi': 'midi',
    'midiSysex': 'midi',
    'openExternal': 'external',
};
// Coalesce concurrent identical prompts (a page hammering getUserMedia) so they
// share one doorhanger instead of stacking. The doorhanger (Features/
// permission-ui.js) is anchored under the lock icon and never blocks the page.
const pending = new Map();
function prompt(wc, origin, action, { checkbox = false, iconType = 'generic' } = {}) {
    const key = `${wc && !wc.isDestroyed() ? wc.id : 0}|${origin}|${action}`;
    if (pending.has(key))
        return pending.get(key);
    const p = permissionUI.request(wc, { origin, action, checkbox, iconType });
    p.finally(() => pending.delete(key));
    pending.set(key, p);
    return p;
}
// ── Per-session state registry ────────────────────────────────────────────────
// One record per attached session:
//   temp     — `${wcId}|${origin}|${names}` → boolean  (non-remembered decisions)
//   override — `${origin}|${name}` → 'allow'|'block'   (private-tab panel choices)
const sessions = new Map();
function record(sess) { return sessions.get(sess) || null; }
// Effective stored state for one permission name (override > store > 'ask').
function stateOf(rec, origin, name) {
    const o = rec.override.get(`${origin}|${name}`);
    if (o)
        return o;
    return rec.persist ? sitePermissions.state(origin, name) : 'ask';
}
function clearTempOrigin(rec, origin) {
    for (const k of [...rec.temp.keys()])
        if (k.split('|')[1] === origin)
            rec.temp.delete(k);
}
// A stored decision changed (lock-icon panel or elsewhere): stale temporary
// grants for that origin must not shadow the new explicit choice.
sitePermissions.on('change', (origin) => {
    for (const rec of sessions.values())
        if (rec.persist)
            clearTempOrigin(rec, origin);
});
// ── Panel API (ipc/site-info.js) ─────────────────────────────────────────────
// Set a permission from the panel for a PRIVATE tab: in-memory only, scoped to
// that tab's session — nothing is written to disk.
function setOverride(sess, origin, name, value) {
    const rec = record(sess);
    if (!rec || !origin)
        return;
    if (value === 'allow' || value === 'block')
        rec.override.set(`${origin}|${name}`, value);
    else
        rec.override.delete(`${origin}|${name}`);
    clearTempOrigin(rec, origin);
}
// Effective state as the request handler will see it (panel display).
function effectiveState(sess, origin, name) {
    const rec = record(sess);
    return rec ? stateOf(rec, origin, name) : sitePermissions.state(origin, name);
}
function listStates(sess, origin) {
    return sitePermissions.MANAGED.map(p => ({ name: p.name, label: p.label, state: effectiveState(sess, origin, p.name) }));
}
// Is there a live-usable grant for origin+name anywhere (temp doorhanger allow
// in any session, or a private-tab override)? Used by the panel to decide
// whether revoking needs a page reload to actually stop an active stream.
function hasTempAllow(origin, name) {
    for (const rec of sessions.values()) {
        for (const [k, allowed] of rec.temp) {
            if (!allowed)
                continue;
            const parts = k.split('|');
            if (parts[1] === origin && parts[2].split(',').includes(name))
                return true;
        }
    }
    return false;
}
function liveUse(name) { return LIVE_USE.has(name); }
// Private tab closed → its session record is dead weight; drop it.
function detach(sess) { sessions.delete(sess); }
/**
 * Install block-by-default, prompt-to-allow permission handling on a session.
 * persist:false (private sessions) never reads or writes stored decisions.
 */
function attach(sess, { persist = true } = {}) {
    const rec = { persist, temp: new Map(), override: new Map() };
    sessions.set(sess, rec);
    const temp = rec.temp;
    const trackWc = (wc) => {
        if (!wc || wc._permPromptTracked)
            return;
        wc._permPromptTracked = true;
        const clear = () => { for (const k of [...temp.keys()])
            if (k.startsWith(wc.id + '|'))
                temp.delete(k); };
        wc.on('did-navigate', clear);
        wc.once('destroyed', clear);
    };
    sess.setPermissionRequestHandler(async (wc, permission, callback, details) => {
        try {
            const origin = originOf((details && details.requestingUrl) || wc?.getURL?.() || '');
            // TIER 1 — benign engine features: allowed without asking.
            if (ALLOWED.has(permission))
                return callback(true);
            if (permission === 'openExternal') {
                const target = String((details && details.externalURL) || '').slice(0, 100);
                const { allowed } = await prompt(wc, origin, `open "${target}"`, { iconType: 'external' });
                return callback(allowed);
            }
            // TIER 2a — persistable resource permissions (camera/mic/location/
            // notifications). Prompt, default DENY, optionally remember.
            const names = managedNames(permission, details);
            if (names && names.length === 0)
                return callback(true); // media playback / speaker pick — not a capture gate
            if (names && names.length) {
                if (!origin)
                    return callback(false);
                // Grant path: on macOS make sure the OS has also granted access
                // (camera/mic) before we hand back "allowed".
                const grant = async (allowed) => {
                    if (allowed) {
                        await ensureOsMediaAccess(names);
                        // Custom signal for the tab strip's recording indicator
                        // (Chromium exposes no capture-started event; a granted
                        // getUserMedia is the moment capture begins).
                        if (names.includes('camera') || names.includes('microphone')) {
                            try {
                                wc?.emit('media-capture-started', names);
                            }
                            catch { }
                        }
                    }
                    callback(allowed);
                };
                // Explicit decisions (panel override / stored) come FIRST — before
                // any temporary grant. One blocked part vetoes a combined request
                // (camera+mic when camera is blocked fails, as in Firefox/Chrome).
                const states = names.map(n => stateOf(rec, origin, n));
                if (states.some(s => s === 'block'))
                    return callback(false);
                if (states.every(s => s === 'allow'))
                    return grant(true);
                trackWc(wc);
                const tempKey = `${wc?.id ?? 0}|${origin}|${names.join()}`;
                if (temp.has(tempKey))
                    return grant(temp.get(tempKey));
                const { allowed, remember, dismissed } = await prompt(wc, origin, labelFor(names), { checkbox: persist, iconType: iconForNames(names) });
                if (remember && persist) {
                    for (const n of names)
                        sitePermissions.set(origin, n, allowed ? 'allow' : 'block');
                }
                else if (!dismissed) {
                    // Click-away/Esc denies this request only — no record, the
                    // site may ask again. Explicit Allow/Block sticks for the page.
                    temp.set(tempKey, allowed);
                }
                return grant(allowed);
            }
            // TIER 2b — high-risk, prompt every time, never remembered.
            if (PROMPT_ONCE[permission]) {
                if (!origin)
                    return callback(false);
                trackWc(wc);
                const tempKey = `${wc?.id ?? 0}|${origin}|${permission}`;
                if (temp.has(tempKey))
                    return callback(temp.get(tempKey));
                const { allowed, dismissed } = await prompt(wc, origin, PROMPT_ONCE[permission], { iconType: ICON_FOR_PERM[permission] || 'generic' });
                if (!dismissed)
                    temp.set(tempKey, allowed);
                return callback(allowed);
            }
            // TIER 3 — USB / serial / HID / Bluetooth / storage-access / idle /
            // window management / anything unrecognised: denied outright.
            callback(false);
        }
        catch {
            try {
                callback(false);
            }
            catch { }
        }
    });
    // Synchronous status checks (navigator.permissions.query, Notification
    // .permission, device enumeration): the synchronous check runs for
    // navigator.permissions.query and for the pre-flight some sites (e.g.
    // Google Meet) do BEFORE calling getUserMedia: if it reports "denied" here,
    // the site never attempts the request, so the interactive prompt never runs
    // and the user just sees the site's own "blocked" screen. So we only report
    // denied for EXPLICITLY blocked permissions — an undecided ("ask")
    // camera/mic/location/notification reports available, which lets the site
    // make the request that then triggers the prompt. The request handler is
    // the real gate: it still defaults to block + prompt, and Chromium routes
    // actual use (getUserMedia, geolocation, showing a notification) through it.
    sess.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
        if (ALLOWED.has(permission))
            return true;
        const names = managedNames(permission, details);
        if (names && names.length === 0)
            return true;
        if (names && names.length) {
            const origin = originOf(requestingOrigin || '');
            if (!origin)
                return true;
            // Denied only if explicitly blocked (stored or private-tab override).
            return !names.some(n => stateOf(rec, origin, n) === 'block');
        }
        return false; // PROMPT_ONCE + TIER 3: never pre-granted
    });
    // Screen sharing. getDisplayMedia REQUIRES a display-media handler (without
    // one Chromium fails with NotSupportedError no matter what the permission
    // handler says). Same doorhanger flow: ask every time, share the primary
    // screen on Allow. Note macOS additionally gates this behind the OS
    // Screen-Recording permission (System Settings › Privacy & Security).
    sess.setDisplayMediaRequestHandler(async (req, callback) => {
        const respond = (streams) => { try {
            callback(streams);
        }
        catch { } };
        try {
            const wc = req.frame ? webContents.fromFrame(req.frame) : null;
            const origin = originOf(req.securityOrigin || (req.frame && req.frame.url) || '');
            const { allowed } = await prompt(wc, origin, 'share your screen', { iconType: 'screen' });
            if (!allowed)
                return respond(null);
            const sources = await desktopCapturer.getSources({ types: ['screen'] });
            if (!sources.length)
                return respond(null);
            respond({ video: sources[0] });
        }
        catch {
            respond(null);
        }
    });
}

module.exports = { attach, detach, setOverride, effectiveState, listStates, hasTempAllow, liveUse };