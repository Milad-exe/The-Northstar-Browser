'use strict';
/**
 * Profiles — separate browsing selves.
 *
 * A profile is WHO you are: its own cookies/logins, its own history, its own
 * bookmarks + Essentials, its own containers, and its own THEME — a window
 * belongs to one profile, so it wears that profile's colours (null follows the
 * global setting). Settings and extensions stay shared across profiles
 * (per-profile extensions is heavy and rarely wanted). Each window belongs to one profile; the toolbar switcher opens (or
 * focuses) a window per profile.
 *
 * Layering: a profile (features/containers.js) is WHICH ACCOUNT on one site,
 * *inside* a profile. Profile 1 ("Personal") maps to the app's original default
 * session and legacy store files, so existing users keep logins/history with no
 * migration; every other profile gets its own persist: partition hardened
 * exactly like a profile session, plus its own store files.
 */
const log = require('./log');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { setup } = require('./private-session');
const adBlocker = require('./ad-blocker');
const downloadManager = require('./download-manager');

const COLORS = ['#e0894a', '#4a9eff', '#3fbf7f', '#c86fe0', '#e05a7a', '#e0c341', '#5ad0d0', '#9a7bff'];
// Default per-profile emoji avatars; a profile can clear its emoji (→ coloured dot).
const EMOJIS = ['🏠', '💼', '🎨', '🚀', '🌙', '🎧', '🐙', '🔥'];
const sessions = new Map(); // profile id → Electron Session (non-default only)

let _reg = null; // { nextId, list: [{id,name,color,essentials:[{url,title,profile}]}] }
function file() { return path.join(app.getPath('userData'), 'northstar', 'profiles.json'); }

function load() {
    if (_reg)
        return _reg;
    try {
        const raw = JSON.parse(fs.readFileSync(file(), 'utf-8'));
        if (raw && Array.isArray(raw.list) && raw.list.length) {
            // Carry the global essentials through — rebuilding from nextId+list
            // alone would drop them on every launch.
            _reg = { nextId: Number(raw.nextId) || (raw.list.length + 1), list: raw.list };
            if (Array.isArray(raw.essentials)) {
                _reg.essentials = raw.essentials;
                // Essentials written before the rename use `container`.
                for (const e of _reg.essentials)
                    if (e && e.container !== undefined && e.profile === undefined) { e.profile = e.container; delete e.container; }
            }
            // After the essentials are back on _reg — this may save.
            _adoptOwnJars(_reg.list);
            return _reg;
        }
    }
    catch (e) { log.debug('profiles', 'load', e); }
    _reg = { nextId: 2, list: [{ id: '1', name: 'Personal', color: COLORS[0], emoji: EMOJIS[0], essentials: [], container: 'default' }] };
    save();
    return _reg;
}

/* Every space has a Profile (the cookie jar its tabs sign in with); a new one
   starts on the shared Default. Spaces from before Profiles existed may have
   no binding and their own jar: the first space's own jar IS Default, and any
   other space's jar that holds data becomes a Profile named after the space,
   over the same partition — nobody is signed out. An unused jar is dropped
   in favour of Default. Runs once: afterwards every space is bound. */
function _adoptOwnJars(list) {
    let changed = false;
    for (const p of list) {
        if (p.container)
            continue;
        changed = true;
        if (p.id === '1') { p.container = 'default'; continue; }
        const partition = `persist:profile-${p.id}`;
        let used = false;
        try { used = fs.existsSync(path.join(app.getPath('userData'), 'Partitions', `profile-${p.id}`)); }
        catch (e) { log.debug('profiles', 'adopt: check jar', e); }
        if (!used) { p.container = 'default'; continue; }
        try { p.container = require('./containers').adoptNamed(p.name, partition).id; }
        catch (e) { log.warn('profiles', 'could not keep a space’s own logins as a profile', e); }
    }
    if (changed) save();
}

function save() {
    try {
        fs.mkdirSync(path.dirname(file()), { recursive: true });
        fs.writeFileSync(file(), JSON.stringify(_reg, null, 2));
    }
    catch (e) { log.debug('profiles', 'save', e); }
}

function _find(id) { return load().list.find(p => p.id === String(id)) || null; }

/* `theme` is the space's own theme id, or null to follow the global setting.
   A window belongs to one space, so this is what that window wears — see
   features/theme-runtime.js. */
const _pub = (p) => ({ id: p.id, name: p.name, color: p.color, emoji: p.emoji || null, container: p.container || null, theme: p.theme || null });
function list() { return load().list.map(_pub); }
function meta(id) { const p = _find(id); return p ? _pub(p) : null; }

function create(name) {
    const reg = load();
    const id = String(reg.nextId++);
    const p = {
        id,
        name: (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 24) : `Profile ${id}`,
        color: COLORS[reg.list.length % COLORS.length],
        emoji: EMOJIS[reg.list.length % EMOJIS.length],
        essentials: [],
        // Signs in with the shared Default profile until told otherwise.
        container: 'default',
    };
    reg.list.push(p);
    save();
    return _pub(p);
}

// Update a profile's name and/or emoji. Pass emoji '' to clear it (→ dot).
function update(id, patch) {
    const p = _find(id);
    if (!p)
        return null;
    if (patch && typeof patch.name === 'string' && patch.name.trim())
        p.name = patch.name.trim().slice(0, 24);
    if (patch && 'emoji' in patch)
        p.emoji = (patch.emoji || '').trim().slice(0, 8) || null;
    // container: a named container id whose cookie jar this space uses, 'default'
    // for the shared session, or null to keep the space's own jar. Changing it
    // repoints where logins live, so it only takes effect on the next session
    // lookup (callers re-open/switch the space).
    // theme: a theme id this space wears, or null to follow the global setting.
    if (patch && 'theme' in patch)
        p.theme = patch.theme ? String(patch.theme) : null;
    if (patch && 'container' in patch) {
        const v = patch.container;
        p.container = (v === null || v === undefined || v === '') ? null : String(v);
        sessions.delete(String(id)); // drop the memoised session for this space
    }
    save();
    return _pub(p);
}

// Set the order spaces appear in (the foot row, and the switcher shortcuts).
function reorder(ids) {
    const reg = load();
    const wanted = (ids || []).map(String);
    const byId = new Map(reg.list.map(p => [p.id, p]));
    const ordered = wanted.map(id => byId.get(id)).filter(Boolean);
    if (ordered.length !== reg.list.length)
        return false; // stale list — ignore rather than drop a space
    reg.list = ordered;
    save();
    return true;
}

function rename(id, name) {
    const p = _find(id);
    if (!p)
        return null;
    if (typeof name === 'string' && name.trim())
        p.name = name.trim().slice(0, 24);
    save();
    return _pub(p);
}

/**
 * The browsing session for a profile. Profile 1 IS the default session (so
 * existing cookies survive); others get a persist: partition with the profile
 * hardening stack (UA + headers + ad blocking + downloads + spoof preloads).
 */
function sessionFor(id) {
    const key = String(id);
    const { session } = require('electron');
    // A space bound to a Profile takes that container's jar instead of its own,
    // so two spaces on the same container share one login set. Spaces created
    // before this existed have no binding and keep their own jar.
    const bound = _find(key)?.container;
    if (bound) {
        if (bound === 'default')
            return session.defaultSession;
        const containers = require('./containers');
        // A profile deleted from under a space: Default, never a fresh empty jar.
        if (!containers.meta(bound))
            return session.defaultSession;
        return containers.get(bound);
    }
    if (key === '1')
        return session.defaultSession;
    if (sessions.has(key))
        return sessions.get(key);
    const sess = session.fromPartition(`persist:profile-${key}`);
    setup(sess, { persist: true });
    try { adBlocker.enableBlockingInSession(sess); }
    catch (e) { log.debug('profiles', 'if', e); }
    try { downloadManager.attach(sess); }
    catch (e) { log.debug('profiles', 'if', e); }
    for (const [pid, f] of [
        [`chrome-spoof-prof-${key}`, 'chrome-spoof.js'],
        [`adblock-cosmetic-prof-${key}`, 'ad-block-cosmetic.js'],
    ]) {
        try {
            sess.registerPreloadScript({ type: 'frame', id: pid, filePath: path.join(__dirname, '../preload', f) });
        }
        catch (e) { log.debug('profiles', 'for', e); }
    }
    sessions.set(key, sess);
    return sess;
}

/**
 * Delete a space and wipe its cookie jar. Refuses the last remaining space, and
 * refuses profile 1 outright — it IS the default session, so removing it would
 * take the browser's main storage with it.
 *
 * A space bound to a container shares that container's jar with other spaces, so
 * only an unbound space's own persist:profile-<id> partition is cleared.
 */
function remove(id) {
    const key = String(id);
    const reg = load();
    if (key === '1' || reg.list.length <= 1)
        return false;
    const i = reg.list.findIndex(p => p.id === key);
    if (i === -1)
        return false;
    const [gone] = reg.list.splice(i, 1);
    sessions.delete(key);
    save();
    if (!gone.container) {
        try {
            const { session } = require('electron');
            session.fromPartition(`persist:profile-${key}`).clearStorageData();
        }
        catch (e) { log.debug('profiles', 'if', e); }
    }
    return true;
}

/* ── Essentials (per COOKIE JAR; the big favicon tiles) ──────────────────────
 *
 * An Essential is a logged-in destination, so it belongs to the jar it is
 * logged in to — not to one space, and not to the whole browser. Spaces bound
 * to the same container share their Essentials (same account, same tiles); a
 * space with its own jar gets its own set. Both of the browsers this design
 * follows land here: one scopes them to the Profile that owns the Spaces, the
 * other to the container.
 *
 * They used to be one list shown in EVERY space, which made the tile lie: the
 * same favicon in a work space and a personal space opened the same site as two
 * different people. (Before that they were per-space, which was the opposite
 * error — two spaces sharing one login still had to add the tile twice.)
 */
const ESSENTIALS_MAX = 12;
/* A space's jar, as a stable string. A bound space shares its container's jar;
   an unbound one has its own — except space '1', which IS the default session
   (see sessionFor), so it must name the same jar as an explicit 'default'
   binding or the two would not see each other's tiles. */
function jarOf(id) {
    const key = String(id || '1');
    const bound = _find(key)?.container;
    if (bound)
        return 'c:' + bound;
    return key === '1' ? 'c:default' : 's:' + key;
}
function _essentials() {
    const reg = load();
    if (!Array.isArray(reg.essentials)) {
        const seen = new Set();
        reg.essentials = [];
        for (const p of reg.list) {
            for (const e of (p.essentials || [])) {
                const key = `${e.url}|${e.profile || ''}`;
                if (seen.has(key))
                    continue;
                seen.add(key);
                reg.essentials.push({ ...e });
            }
            delete p.essentials;
        }
        save();
    }
    /* Entries written before Essentials were scoped go to EVERY jar that exists
       now. They were showing in every space by definition, so keeping only the
       ones that belonged to whichever space happened to be active would read as
       tiles vanishing. From here the sets diverge per jar. */
    if (reg.essentials.some(e => !e.jar)) {
        const jars = [...new Set(reg.list.map(p => jarOf(p.id)))];
        const legacy = reg.essentials.filter(e => !e.jar);
        reg.essentials = reg.essentials.filter(e => e.jar);
        for (const e of legacy)
            for (const jar of jars)
                reg.essentials.push({ ...e, jar });
        save();
    }
    return reg.essentials;
}
// Essentials are GLOBAL: one set shown in every space, whatever the space's
// cookie jar. Matched by identity (url + profile); the stored `jar` field is
// kept for back-compat but ignored on read, so tiles the old per-jar scoping
// duplicated collapse to one.
const _identity = (a, url, profile) =>
    a.url === url && (a.profile || null) === (profile || null);
function _uniqueCount() {
    return new Set(_essentials().map(e => `${e.url}|${e.profile || ''}`)).size;
}
function essentials(/* id */) {
    const seen = new Set();
    const out = [];
    for (const e of _essentials()) {
        const key = `${e.url}|${e.profile || ''}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        // `home` unset means the Essential's own url — old entries keep working.
        out.push({ ...e, home: e.home || e.url });
    }
    return out;
}
function addEssential(_id, e) {
    if (!e || !e.url)
        return false;
    const list = _essentials();
    if (list.some(x => _identity(x, e.url, e.profile)))
        return false;
    if (_uniqueCount() >= ESSENTIALS_MAX)
        return false;
    list.push({ url: e.url, title: e.title || e.url, profile: e.profile || null, jar: 'global' });
    save();
    return true;
}
/**
 * The page an Essential goes back to.
 *
 * An Essential IS a tab: you click it, you land in its tab, and you can browse
 * away inside it. `home` is where "go back to its page" returns you, and it is
 * editable — an Essential added from a deep link can be pointed at the site's
 * front page instead, or vice versa. It defaults to the url the Essential was
 * created from, which stays its identity key.
 */
function setEssentialHome(_id, url, profile, home) {
    const matches = _essentials().filter(x => _identity(x, url, profile));
    if (!matches.length)
        return false;
    const next = String(home || '').trim();
    if (next && !/^https?:\/\//i.test(next))
        return false;
    for (const e of matches)
        e.home = next || null;   // null → falls back to the Essential's own url
    save();
    return true;
}
/**
 * An Essential's label. The url stays its identity key, so renaming is purely
 * cosmetic and never re-points the tile or orphans its tab — which is the whole
 * reason a tile can be called "Mail" rather than the title the site happens to
 * be serving today.
 */
function renameEssential(_id, url, profile, title) {
    const matches = _essentials().filter(x => _identity(x, url, profile));
    if (!matches.length)
        return false;
    // Empty falls back to the url, the same default addEssential uses — a tile
    // with no label at all is unclickable-looking.
    const next = String(title || '').trim().slice(0, 60) || url;
    for (const e of matches)
        e.title = next;
    save();
    return true;
}
// A static icon pinned to an Essential, overriding the live favicon (upstream
// behaviour: an Essential's icon does not change when the site's does).
function setEssentialIcon(_id, url, profile, icon) {
    const matches = _essentials().filter(x => _identity(x, url, profile));
    if (!matches.length)
        return false;
    const val = (icon || '').trim().slice(0, 8) || null;
    for (const e of matches)
        e.icon = val;
    save();
    return true;
}
function removeEssential(_id, url, profile = null) {
    const list = _essentials();
    const keep = list.filter(x => !_identity(x, url, profile));
    if (keep.length === list.length)
        return false;
    load().essentials = keep;
    save();
    return true;
}

module.exports = { list, meta, create, remove, reorder, rename, update, sessionFor, jarOf, essentials, addEssential, removeEssential, setEssentialIcon, setEssentialHome, renameEssential, COLORS, EMOJIS };
