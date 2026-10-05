'use strict';
/**
 * Spell check — one setting for every session the browser makes.
 *
 * It used to be switched on for the default session only, with its languages
 * fixed to the OS locale + English. Every space's profile session, every
 * container and every private tab is a session of its own, so none of them got
 * those languages, and there was no way to change any of it.
 *
 * Now `spellcheck` in persistence ({ enabled, languages }) is applied to the
 * default session at startup and to every session as it is created
 * (app 'session-created'), and re-applied to the live persistent ones when the
 * setting changes. An empty language list means "automatic": the OS locale
 * plus English. On macOS the system spell checker decides the language, so
 * only on/off applies there.
 *
 * The custom dictionary is per session in Electron. Settings shows the default
 * session's words; adding or removing a word applies to every live persistent
 * session so a word you taught the browser is known in all your spaces.
 */
const { app, session } = require('electron');
const log = require('./log');

let persistence = null;
const live = new Set(); // persistent sessions only — private ones are throwaway

const MAC = process.platform === 'darwin';

function config() {
    const c = (persistence && persistence.get('spellcheck')) || {};
    return {
        enabled: c.enabled !== false,
        languages: Array.isArray(c.languages) ? c.languages.filter(l => typeof l === 'string') : [],
    };
}

function automatic(sess) {
    const available = sess.availableSpellCheckerLanguages || [];
    const wanted = [...new Set([app.getLocale(), 'en-US'].filter(Boolean))];
    const langs = wanted.filter(l => !available.length || available.includes(l));
    return langs.length ? langs : ['en-US'];
}

function apply(sess) {
    if (!sess)
        return;
    try {
        if (sess.isPersistent())
            live.add(sess);
    }
    catch (e) { log.debug('spellcheck', 'isPersistent', e); }
    const c = config();
    // Languages FIRST: setting them switches the checker back on, so the
    // on/off choice has to be the last word.
    if (!MAC) {
        try {
            const available = sess.availableSpellCheckerLanguages || [];
            const chosen = c.languages.filter(l => !available.length || available.includes(l));
            sess.setSpellCheckerLanguages(chosen.length ? chosen : automatic(sess));
        }
        catch (e) { log.warn('spellcheck', 'could not set spell-check languages', e); }
    }
    try { sess.setSpellCheckerEnabled(c.enabled); }
    catch (e) { log.warn('spellcheck', 'could not switch spell check', e); }
}

function init(p) {
    persistence = p;
    apply(session.defaultSession);
    app.on('session-created', apply);
}

function state() {
    const c = config();
    const def = session.defaultSession;
    let active = [];
    try { active = MAC ? [] : def.getSpellCheckerLanguages(); }
    catch (e) { log.debug('spellcheck', 'getSpellCheckerLanguages', e); }
    return {
        enabled: c.enabled,
        automatic: !c.languages.length,
        languages: c.languages.length ? c.languages : active,
        available: MAC ? [] : (def.availableSpellCheckerLanguages || []),
        systemLanguages: MAC,
    };
}

/** Save `patch` ({ enabled?, languages? }) and apply it everywhere. */
function set(patch) {
    if (!persistence)
        return state();
    const c = { ...config(), ...(patch || {}) };
    persistence.set('spellcheck', {
        enabled: !!c.enabled,
        languages: [...new Set((c.languages || []).filter(l => typeof l === 'string'))],
    });
    apply(session.defaultSession);
    for (const s of live)
        apply(s);
    return state();
}

async function words() {
    try {
        const list = await session.defaultSession.listWordsInSpellCheckerDictionary();
        return [...new Set(list)].sort((a, b) => a.localeCompare(b));
    }
    catch (e) {
        log.warn('spellcheck', 'could not read the dictionary', e);
        return [];
    }
}

const each = (fn) => {
    const all = new Set([session.defaultSession, ...live]);
    for (const s of all) {
        try { fn(s); }
        catch (e) { log.debug('spellcheck', 'dictionary', e); }
    }
};
function addWord(word, extra) {
    const w = String(word || '').trim();
    if (!w || /\s/.test(w))
        return false;
    each(s => s.addWordToSpellCheckerDictionary(w));
    // The session the word came from (a private tab's, say) learns it too.
    if (extra) {
        try { extra.addWordToSpellCheckerDictionary(w); }
        catch (e) { log.debug('spellcheck', 'addWord extra', e); }
    }
    return true;
}
function removeWord(word) {
    const w = String(word || '').trim();
    if (!w)
        return false;
    each(s => s.removeWordFromSpellCheckerDictionary(w));
    return true;
}

module.exports = { init, apply, state, set, words, addWord, removeWord };
