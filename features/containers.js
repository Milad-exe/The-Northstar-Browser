'use strict';
/**
 * Isolated instances — on-demand, auto-named, isolated sessions.
 *
 * The need is concrete: run several separate copies of the same web app (e.g.
 * multiple SuccessFactors logins) without their sessions bleeding into each
 * other. So an "instance" is created on the spot from a single action ("open an
 * isolated instance"), NOT pre-declared: it gets a fresh persistent session, a
 * name auto-derived from the site, and a colour. It persists (you stay signed
 * in) and can be reopened later; you can rename or close it, but you never have
 * to set anything up first.
 *
 * Each instance is backed by its own Electron session on a persist: partition
 * (so cookies/storage survive), hardened exactly like a private session (UA +
 * client-hints + privacy headers + ad blocking + downloads + chrome-spoof) but
 * with PERSISTENT permission decisions. The identity list is persisted to
 * userData/northstar/containers.json. (Internally these are still called
 * "containers" — the session partition scheme — but the user sees "instances".)
 */
const log = require('./log');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { parse: parseTld } = require('tldts');
const { setup } = require('./private-session');
const adBlocker = require('./ad-blocker');
const downloadManager = require('./download-manager');

const sessions = new Map(); // instance id (string) → Electron Session

// Colours new instances cycle through, so two copies of a site look distinct.
const COLORS = ['#e0894a', '#4a9eff', '#3fbf7f', '#c86fe0', '#e05a7a', '#e0c341', '#5ad0d0', '#9a7bff'];

// ── Registry (persisted identities) ───────────────────────────────────────────
let _registry = null; // { nextId, list: [{id,name,color,site}] }
function file() { return path.join(app.getPath('userData'), 'northstar', 'containers.json'); }

function load() {
    if (_registry)
        return _registry;
    try {
        const raw = JSON.parse(fs.readFileSync(file(), 'utf-8'));
        if (raw && Array.isArray(raw.list)) {
            _registry = { nextId: Number(raw.nextId) || (raw.list.length + 1), list: raw.list };
            // Records written before the rename call this `profile`, which now
            // means something else entirely (an entry's profile names a
            // CONTAINER; this field names the SPACE that owns the container).
            for (const c of _registry.list)
                if (c && c.profile !== undefined && c.space === undefined) { c.space = c.profile; delete c.profile; }
            return _registry;
        }
    }
    catch (e) { log.debug('containers', 'load', e); }
    _registry = { nextId: 1, list: [] }; // start empty — instances are made on demand
    return _registry;
}

function save() {
    try {
        fs.mkdirSync(path.dirname(file()), { recursive: true });
        fs.writeFileSync(file(), JSON.stringify(_registry, null, 2));
    }
    catch (e) { log.debug('containers', 'save', e); }
}

/** All instances (safe copies), newest last. */
function list() {
    return load().list.map(c => ({ ...c }));
}

/** Identity for an id, or null. */
function meta(id) {
    if (id == null)
        return null;
    const c = load().list.find(x => x.id === String(id));
    return c ? { ...c } : null;
}

function _sanitizeColor(color) {
    return (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) ? color : null;
}

// Human label for a url: the site's own name, Title-cased ("SuccessFactors"
// from perf.successfactors.com). Falls back to "Instance" for blanks/IPs.
function labelForUrl(url) {
    try {
        const base = parseTld(url, { allowPrivateDomains: true }).domainWithoutSuffix;
        if (base && /[a-z]/i.test(base))
            return base.charAt(0).toUpperCase() + base.slice(1);
    }
    catch (e) { log.debug('containers', 'labelForUrl', e); }
    return 'Instance';
}

// Dedupe a base label within one space: "Site", then "Site · 2", "Site · 3"…
function _uniqueName(base, space = '1') {
    const reg = load();
    const family = reg.list.filter(c => ((c.space || '1') === String(space)) &&
        (c.name === base || c.name.startsWith(base + ' · ')));
    return family.length === 0 ? base : `${base} · ${family.length + 1}`;
}

/**
 * Create a fresh container auto-named from (url), scoped to (space). Used by the
 * MANUAL new-container action — every call mints a new one (so you can
 * hold two separate logins to the same site on purpose).
 */
function createForUrl(url, space = '1') {
    return _create(_uniqueName(labelForUrl(url), space), url, space);
}

// The distinguishing subdomain of a host ("acme" from acme.successfactors.com),
// ignoring a leading www. Empty when there's no tenant subdomain.
function subdomainOf(host) {
    try {
        const sub = (parseTld(host, { allowPrivateDomains: true }).subdomain || '').replace(/^www\.?/, '');
        return sub;
    }
    catch {
        return '';
    }
}

/**
 * Get (reuse or create) the AUTONOMOUS instance for a url's tenant — keyed by the
 * full hostname, so acme.successfactors.com always maps to one instance ("stay
 * signed in") while globex.successfactors.com gets its own. Named by tenant:
 * "SuccessFactors — acme", falling back to the site label + "· N".
 */
function instanceForHost(url, space = '1') {
    let host = null;
    try { host = new URL(url).hostname; }
    catch (e) { log.debug('containers', 'instanceForHost', e); }
    if (!host)
        return createForUrl(url, space);
    const reg = load();
    // Tenant-keyed WITHIN the space — Work's acme.foo.com container is separate
    // from Personal's acme.foo.com container.
    const existing = reg.list.find(x => x.tenantHost === host && (x.space || '1') === String(space));
    if (existing)
        return { ...existing };
    const label = labelForUrl(url);
    const sub = subdomainOf(host);
    const c = _create(_uniqueName(sub ? `${label} — ${sub}` : label, space), url, space);
    // Tag it tenant-keyed so a later open of the same host reuses it.
    const rec = load().list.find(x => x.id === c.id);
    if (rec) {
        rec.tenantHost = host;
        save();
        return { ...rec };
    }
    return c;
}

function _create(name, site, space = '1') {
    const reg = load();
    const id = String(reg.nextId++);
    const c = {
        id,
        name: (name || 'Instance').slice(0, 32),
        color: COLORS[reg.list.length % COLORS.length],
        site: (typeof site === 'string' && /^https?:/i.test(site)) ? (() => { try { return new URL(site).hostname; } catch { return null; } })() : null,
        // Which SPACE owns this container (absent = the default space).
        ...(String(space) !== '1' ? { space: String(space) } : {}),
    };
    reg.list.push(c);
    save();
    return { ...c };
}

/**
 * Create a user-named container ("Work", "Banking") not derived from a URL.
 * Tagged `named` so the UI can offer these as Space Profiles while leaving the
 * auto-minted per-site containers out of that list.
 */
function createNamed(name) {
    // Deliberately NOT space-scoped: the point of a Space Profile is that two
    // Spaces can share one, so these live above the per-space registry.
    const c = _create(_uniqueName((name || 'Container').trim().slice(0, 32), '1'), null, '1');
    const rec = load().list.find(x => x.id === c.id);
    if (rec) { rec.named = true; save(); }
    return { ...c, named: true };
}
/** Just the user-named containers (Space Profile candidates), across all spaces. */
function listNamed() {
    return load().list.filter(c => c.named).map(c => ({ ...c }));
}
/**
 * Adopt an existing cookie jar as a named Profile: a space that kept its own
 * logins before Profiles existed becomes a Profile of the same name over the
 * SAME partition, so nobody is signed out by the change (profiles.js load()).
 */
function adoptNamed(name, partition) {
    const c = _create(_uniqueName((name || 'Profile').trim().slice(0, 32), '1'), null, '1');
    const rec = load().list.find(x => x.id === c.id);
    if (rec) { rec.named = true; rec.partition = String(partition); save(); }
    return { ...rec };
}
/** The partition a container's jar lives on (an adopted one keeps its own). */
function partitionOf(id) {
    return load().list.find(x => x.id === String(id))?.partition || `persist:container-${id}`;
}
/** Rename / recolor an instance. Returns updated meta or null. */
function update(id, patch = {}) {
    const reg = load();
    const c = reg.list.find(x => x.id === String(id));
    if (!c)
        return null;
    if (typeof patch.name === 'string' && patch.name.trim())
        c.name = patch.name.trim().slice(0, 32);
    const col = _sanitizeColor(patch.color);
    if (col)
        c.color = col;
    save();
    return { ...c };
}

/** Delete an instance and wipe its stored data (full sign-out). */
function remove(id) {
    const reg = load();
    const key = String(id);
    const i = reg.list.findIndex(x => x.id === key);
    if (i === -1)
        return false;
    const partition = partitionOf(key);
    reg.list.splice(i, 1);
    save();
    try {
        const sess = sessions.get(key) || require('electron').session.fromPartition(partition);
        sess.clearStorageData();
        sess.clearCache();
    }
    catch (e) { log.debug('containers', 'remove', e); }
    sessions.delete(key);
    return true;
}

// ── Sessions ──────────────────────────────────────────────────────────────────
/** Get (creating once) the persistent session for an instance id. */
function get(id) {
    const key = String(id);
    if (sessions.has(key))
        return sessions.get(key);
    const { session } = require('electron');
    const sess = session.fromPartition(partitionOf(key));
    setup(sess, { persist: true });
    try { adBlocker.enableBlockingInSession(sess); }
    catch (e) { log.debug('containers', 'get', e); }
    try { downloadManager.attach(sess); }
    catch (e) { log.debug('containers', 'get', e); }
    for (const [pid, f] of [
        [`chrome-spoof-ctr-${key}`, 'chrome-spoof.js'],
        [`adblock-cosmetic-ctr-${key}`, 'ad-block-cosmetic.js'],
    ]) {
        try {
            sess.registerPreloadScript({ type: 'frame', id: pid, filePath: path.join(__dirname, '../preload', f) });
        }
        catch (e) { log.debug('containers', 'for', e); }
    }
    sessions.set(key, sess);
    return sess;
}

/**
 * Housekeeping: drop instances that are dormant — no open tabs (activeIds) AND no
 * stored cookies (a session cookie-less jar means nothing is signed in there).
 * Keeps the registry + disk from accumulating dead isolated sessions over time.
 * Best-effort and silent; call on startup once tabs are restored.
 */
async function gc(activeIds) {
    const { session } = require('electron');
    const active = new Set([...(activeIds || [])].map(String));
    for (const c of [...load().list]) {
        // User-named containers are addressable (a Space can be bound to one), so
        // they outlive having no tabs — only auto-minted containers are reaped.
        if (c.named || active.has(c.id))
            continue;
        try {
            const sess = session.fromPartition(`persist:container-${c.id}`);
            const cookies = await sess.cookies.get({});
            if (!cookies || cookies.length === 0)
                remove(c.id);
        }
        catch (e) { log.debug('containers', 'gc', e); }
    }
}

/** The colour for an instance id (from its identity, else palette fallback). */
function colorFor(id) {
    const m = meta(id);
    if (m)
        return m.color;
    const n = parseInt(String(id).replace(/\D/g, ''), 10) || 0;
    return COLORS[n % COLORS.length];
}

module.exports = { get, colorFor, list, meta, createForUrl, createNamed, adoptNamed, partitionOf, listNamed, instanceForHost, labelForUrl, update, remove, gc, COLORS };
