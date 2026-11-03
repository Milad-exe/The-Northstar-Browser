/**
 * chrome.proxy — maps the extension proxy API onto Electron's session.setProxy.
 *
 * Scope is per SESSION, which lines up with Chrome's per-profile proxy: setting
 * it from an extension in one space does not reroute the others.
 *
 * Chrome's ProxyConfig has four modes. Three map cleanly onto Electron:
 *   direct        → proxyRules 'direct://'
 *   auto_detect   → mode 'pac_script' with WPAD
 *   pac_script    → pacScript url/data
 *   fixed_servers → proxyRules built from the singleProxy/per-scheme rules
 * `system` hands control back to Electron's default (system settings).
 */
'use strict';
const log = require('./log');

// session → [{ extensionId, config }], oldest first. The newest entry is the
// one in force, like Chrome's "most recently installed extension wins"; when
// it goes, the next one down takes over, and with none left the session gets
// back the proxy it had before any extension touched it.
const stacks = new Map();

/**
 * The proxy the session runs with when no extension is setting one: whatever
 * the user launched the browser with (--proxy-server / --proxy-bypass-list),
 * else the system settings. Electron cannot read a session's current proxy
 * back, so this is rebuilt from the same inputs the session started from.
 */
function baselineConfig() {
    try {
        const { app } = require('electron');
        const server = app.commandLine.hasSwitch('proxy-server') ? app.commandLine.getSwitchValue('proxy-server') : '';
        if (server) {
            const bypass = app.commandLine.hasSwitch('proxy-bypass-list') ? app.commandLine.getSwitchValue('proxy-bypass-list') : '';
            return { proxyRules: server, ...(bypass ? { proxyBypassRules: bypass } : {}) };
        }
    }
    catch (e) { log.debug('ext-proxy', 'baselineConfig', e); }
    return { mode: 'system' };
}

/** Build Electron proxyRules from Chrome's fixed_servers shape. */
function rulesFromFixedServers(rules = {}) {
    const spec = (s) => {
        if (!s)
            return null;
        const scheme = s.scheme && s.scheme !== 'http' ? `${s.scheme}://` : '';
        return `${scheme}${s.host}${s.port ? ':' + s.port : ''}`;
    };
    if (rules.singleProxy)
        return spec(rules.singleProxy);
    const parts = [];
    for (const [key, prefix] of [['proxyForHttp', 'http'], ['proxyForHttps', 'https'], ['proxyForFtp', 'ftp']]) {
        const v = spec(rules[key]);
        if (v)
            parts.push(`${prefix}=${v}`);
    }
    const fallback = spec(rules.fallbackProxy);
    if (fallback)
        parts.push(fallback);
    return parts.join(';') || null;
}

function electronConfigFor(config = {}) {
    switch (config.mode) {
        case 'direct':
            return { proxyRules: 'direct://' };
        case 'auto_detect':
            return { mode: 'pac_script' };
        case 'pac_script': {
            const pac = config.pacScript || {};
            // Electron takes a URL; an inline PAC body is passed as a data: URL.
            if (pac.url)
                return { pacScript: pac.url };
            if (pac.data)
                return { pacScript: 'data:application/x-ns-proxy-autoconfig;base64,' + Buffer.from(pac.data).toString('base64') };
            return { mode: 'direct' };
        }
        case 'fixed_servers': {
            const proxyRules = rulesFromFixedServers(config.rules);
            if (!proxyRules)
                return { mode: 'direct' };
            const bypass = config.rules?.bypassList;
            return {
                proxyRules,
                ...(Array.isArray(bypass) && bypass.length ? { proxyBypassRules: bypass.join(',') } : {}),
            };
        }
        case 'system':
        default:
            return { mode: 'system' };
    }
}

async function set(extensionId, session, value = {}) {
    if (!session)
        throw new Error('no session for this extension');
    const config = value.value || value.config || value;
    const electronConfig = electronConfigFor(config);
    await session.setProxy(electronConfig);
    const stack = (stacks.get(session) || []).filter(r => r.extensionId !== extensionId);
    stack.push({ extensionId, config });
    stacks.set(session, stack);
    log.debug('ext-proxy', `${extensionId} set mode=${config.mode || 'system'}`);
    return true;
}

function get(extensionId, session) {
    const stack = (session && stacks.get(session)) || [];
    const top = stack[stack.length - 1];
    const mine = stack.find(r => r.extensionId === extensionId);
    let levelOfControl = 'controllable_by_this_extension';
    if (top && top.extensionId === extensionId)
        levelOfControl = 'controlled_by_this_extension';
    else if (top)
        levelOfControl = 'controlled_by_other_extensions';
    return { value: (top || mine)?.config || { mode: 'system' }, levelOfControl };
}

/**
 * Drop an extension's proxy — on chrome.proxy.settings.clear(), and when the
 * extension is disabled or removed (an uninstalled extension must not keep
 * routing the user's traffic). Without a session, clears it everywhere.
 */
async function clear(extensionId, session) {
    for (const [sess, stack] of [...stacks]) {
        if (session && sess !== session)
            continue;
        const idx = stack.findIndex(r => r.extensionId === extensionId);
        if (idx < 0)
            continue;
        const wasActive = idx === stack.length - 1;
        stack.splice(idx, 1);
        if (!stack.length)
            stacks.delete(sess);
        if (!wasActive)
            continue;
        const next = stack[stack.length - 1];
        try { await sess.setProxy(next ? electronConfigFor(next.config) : baselineConfig()); }
        catch (e) { log.debug('ext-proxy', 'clear', e); }
    }
    return true;
}

module.exports = { set, get, clear, baselineConfig, electronConfigFor, rulesFromFixedServers };
