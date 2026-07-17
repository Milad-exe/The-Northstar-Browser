'use strict';

/**
 * URL security helpers used by IPC handlers and the context menu.
 *
 * sanitizeUrl  — for tab navigation / lazy-tab creation.
 *                Allows http, https, file: (internal app pages), about:, view-source:.
 *                Returns 'about:blank' for anything that could execute code.
 *
 * isSafeExternal — for shell.openExternal.
 *                  Only http and https are safe to hand to the OS.
 */

const BLOCKED_PROTOCOLS = new Set(['javascript:', 'data:', 'vbscript:']);

function sanitizeUrl(url) {
    if (!url || typeof url !== 'string') return 'about:blank';
    const trimmed = url.trim();
    if (!trimmed || trimmed === 'newtab') return trimmed;

    try {
        const { protocol } = new URL(trimmed);
        if (BLOCKED_PROTOCOLS.has(protocol)) return 'about:blank';
    } catch {
        // Not a parseable URL (e.g. a search query) — let the nav handler deal with it.
    }

    return trimmed;
}

function isSafeExternal(url) {
    if (!url || typeof url !== 'string') return false;
    try {
        const { protocol } = new URL(url.trim());
        return protocol === 'http:' || protocol === 'https:';
    } catch {
        return false;
    }
}

export { sanitizeUrl, isSafeExternal };