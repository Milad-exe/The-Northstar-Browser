/**
 * Manifest-permission checks for the chrome.* APIs this browser adds itself
 * (the gap layer in ipc/extensions.js, the event fan-out in ext-events.js,
 * declarativeNetRequest in dnr.js).
 *
 * electron-chrome-extensions enforces permissions for the APIs IT implements;
 * the ones we bolt on had none, so any installed extension — a theme included
 * — could read history, set a proxy or capture a tab. Every added API now asks
 * here first, against the manifest of the extension as it is loaded.
 *
 * Only REQUIRED permissions count. Optional ones would be granted through
 * chrome.permissions.request, and nothing in this browser grants them yet, so
 * treating them as held would hand them out without the prompt.
 *
 * Also home to the action-click grant: Chrome lets tabCapture capture a tab
 * only after the user invoked the extension on it (clicked its toolbar
 * button), not merely because the extension asked.
 */
'use strict';
const log = require('./log');

// A permission that implies another. DNR's host-access variant can do
// everything plain DNR can (dnr.js gates it on host access separately).
const IMPLIED_BY = {
    declarativeNetRequest: ['declarativeNetRequestWithHostAccess'],
};

/** Pure: does this manifest declare `perm` as a required permission? */
function manifestHasPermission(manifest, perm) {
    const perms = Array.isArray(manifest?.permissions) ? manifest.permissions : [];
    if (perms.includes(perm))
        return true;
    return (IMPLIED_BY[perm] || []).some(p => perms.includes(p));
}

/**
 * The loaded extension, from the caller's own session when known (that is the
 * copy whose process made the call), else from any session hosting it — every
 * space loads the same installed set.
 */
function findExtension(extensionId, session) {
    if (!extensionId)
        return null;
    const lookup = (s) => {
        try { return (s?.extensions || s)?.getExtension?.(extensionId) || null; }
        catch { return null; }
    };
    const own = lookup(session);
    if (own)
        return own;
    try {
        const exts = require('./extensions');
        for (const s of [exts.session, ...(exts.hosts?.keys?.() || [])]) {
            const hit = lookup(s);
            if (hit)
                return hit;
        }
    }
    catch (e) { log.debug('ext-permissions', 'findExtension', e); }
    return null;
}

function hasPermission(extensionId, perm, session) {
    return manifestHasPermission(findExtension(extensionId, session)?.manifest, perm);
}

/** Throw Chrome's style of error when the caller lacks `perm`. */
function requirePermission(extensionId, perm, session) {
    if (!hasPermission(extensionId, perm, session))
        throw new Error(`'${perm}' permission is required to use this API`);
}

// ── Action-click grant ───────────────────────────────────────────────────────
// extension id → Set of tab ids (webContents ids) the user invoked it on.
const grants = new Map();

function grantActionClick(extensionId, tabWc) {
    if (!extensionId || !tabWc || tabWc.isDestroyed?.())
        return;
    const tabId = tabWc.id;
    let set = grants.get(extensionId);
    if (!set)
        grants.set(extensionId, (set = new Set()));
    if (set.has(tabId))
        return;
    set.add(tabId);
    // Like activeTab, the grant ends when the tab leaves the page it was
    // given on, or closes.
    const revoke = () => {
        grants.get(extensionId)?.delete(tabId);
        try {
            tabWc.removeListener('did-navigate', revoke);
            tabWc.removeListener('destroyed', revoke);
        }
        catch (e) { log.debug('ext-permissions', 'revoke', e); }
    };
    try {
        tabWc.once('did-navigate', revoke);
        tabWc.once('destroyed', revoke);
    }
    catch (e) { log.debug('ext-permissions', 'grantActionClick', e); }
}

function hasActionGrant(extensionId, tabId) {
    return !!grants.get(extensionId)?.has(Number(tabId));
}

function revokeAll(extensionId) {
    grants.delete(extensionId);
}

module.exports = {
    manifestHasPermission, findExtension, hasPermission, requirePermission,
    grantActionClick, hasActionGrant, revokeAll,
};
