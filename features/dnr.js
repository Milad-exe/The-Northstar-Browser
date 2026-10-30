/**
 * chrome.declarativeNetRequest — the API every MV3 content blocker is built on.
 *
 * WHY THIS EXISTS: MV3 removed blocking webRequest, so uBlock Origin Lite,
 * AdGuard, Ghostery and friends express every filter as a DNR rule. Neither
 * Electron nor electron-chrome-extensions implements DNR, so those extensions
 * install, run, report no errors — and block nothing at all.
 *
 * WHERE IT PLUGS IN: Electron allows exactly ONE listener per webRequest event
 * per session, and those slots are already owned (privacy.js for the default
 * session, ad-blocker.js + private-session.js for space/container sessions).
 * So this module exposes pure match functions that the existing owners call
 * from inside their handlers, rather than registering listeners of its own.
 *
 * SCOPE: rules are keyed by extension id and apply across every session, which
 * matches how extensions themselves are loaded (one install, every space).
 */
'use strict';
const log = require('./log');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Chrome's own ceilings, so an extension that respects the documented limits
// never trips ours.
const MAX_DYNAMIC_RULES = 30000;
const MAX_SESSION_RULES = 5000;
const MAX_STATIC_RULES = 330000;
const MATCHED_LOG_MAX = 500; // ring buffer for getMatchedRules()

// Electron's resourceType vocabulary is not Chrome's. A rule asking for
// "xmlhttprequest" must match what Electron calls "xhr".
const RESOURCE_TYPE = {
    mainFrame: 'main_frame',
    subFrame: 'sub_frame',
    stylesheet: 'stylesheet',
    script: 'script',
    image: 'image',
    font: 'font',
    object: 'object',
    xhr: 'xmlhttprequest',
    ping: 'ping',
    cspReport: 'csp_report',
    media: 'media',
    webSocket: 'websocket',
    other: 'other',
};

// At equal priority Chrome breaks ties by action type, in this order.
const ACTION_RANK = {
    allow: 0,
    allowAllRequests: 1,
    block: 2,
    upgradeScheme: 3,
    redirect: 4,
};

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/* Keyword index (the trick every real blocker uses). A urlFilter can only
   match a URL that contains each of its BOUNDED literal words as a whole
   word — bounded meaning the characters either side in the filter are
   separators, ^ or an anchor, never * or the open start/end of the filter.
   So "/adserver/" only needs testing against URLs with the word "adserver".
   Words are runs of [a-z0-9%], as in ABP and uBlock. */
const WORD = /[a-z0-9%]/;
// Words so common they would put a rule in a huge bucket; skipped as keys.
const COMMON = new Set(['http', 'https', 'www', 'com', 'net', 'org', 'js', 'css', 'html', 'php', 'png', 'jpg', 'gif', 'static', 'cdn', 'api', 'assets', 'img', 'images']);
function filterKeyword(filter) {
    if (typeof filter !== 'string' || !filter)
        return null;
    let f = filter.toLowerCase();
    let i = 0, end = f.length;
    let startAnchored = false, endAnchored = false;
    if (f.startsWith('||')) { i = 2; startAnchored = true; }
    else if (f.startsWith('|')) { i = 1; startAnchored = true; }
    if (end > i && f.endsWith('|')) { end -= 1; endAnchored = true; }
    let best = null, bestLen = 0;
    let j = i;
    while (j < end) {
        if (!WORD.test(f[j])) { j++; continue; }
        let k = j;
        while (k < end && WORD.test(f[k])) k++;
        const before = j === i ? (startAnchored ? '|' : null) : f[j - 1];
        const after = k === end ? (endAnchored ? '|' : null) : f[k];
        const bounded = before !== null && before !== '*' && after !== null && after !== '*';
        const word = f.slice(j, k);
        if (bounded && word.length >= 3 && !COMMON.has(word) && word.length > bestLen) {
            best = word; bestLen = word.length;
        }
        j = k;
    }
    return best;
}
/** The whole words of a URL, for the keyword index. */
function urlWords(url) {
    return new Set(url.toLowerCase().split(/[^a-z0-9%]+/).filter(w => w.length >= 3));
}

/**
 * Compile an ABP-style urlFilter into a RegExp.
 *   ||host   anchor to the start of a domain (subdomains included)
 *   |        anchor to the start / end of the URL
 *   ^        separator: anything but a letter, digit, _ - . % — or end of URL
 *   *        wildcard
 */
function compileUrlFilter(filter, caseSensitive) {
    let src = '';
    let i = 0;
    let end = filter.length;
    let anchorEnd = false;
    if (filter.startsWith('||')) {
        // Optional subdomain chain, so ||example.com matches sub.example.com
        // but never notexample.com.
        src += '^[a-z][a-z0-9+.-]*://(?:[^/?#]*@)?(?:[^/?#]*\\.)?';
        i = 2;
    }
    else if (filter.startsWith('|')) {
        src += '^';
        i = 1;
    }
    if (end > i && filter.endsWith('|')) {
        end -= 1;
        anchorEnd = true;
    }
    for (; i < end; i++) {
        const c = filter[i];
        if (c === '*')
            src += '.*';
        else if (c === '^')
            src += '(?:[^a-zA-Z0-9_\\-.%]|$)';
        else
            src += escapeRe(c);
    }
    if (anchorEnd)
        src += '$';
    return new RegExp(src, caseSensitive ? '' : 'i');
}

// Host matching for the *Domains conditions: exact host or a subdomain of it.
function hostMatches(host, domain) {
    if (!host || !domain)
        return false;
    const d = domain.toLowerCase().replace(/^\./, '');
    return host === d || host.endsWith('.' + d);
}
function anyHostMatches(host, domains) {
    for (const d of domains)
        if (hostMatches(host, d))
            return true;
    return false;
}

function hostOf(url) {
    try { return new URL(url).hostname.toLowerCase(); }
    catch { return ''; }
}

/**
 * Reject regexes that could blow up on us.
 *
 * A regexFilter is extension-supplied and gets tested against EVERY url on the
 * main process, so a pattern with nested unbounded quantifiers — the classic
 * (a+)+ shape — turns one page load into an unresponsive browser. Chrome caps
 * regex complexity centrally; since we cannot, patterns that look catastrophic
 * are refused at compile time and the rule is dropped with a log line.
 */
const REGEX_MAX_LENGTH = 1000;
// A quantified group that itself ends in a quantifier: (x+)+, (x*)*, (x+){2,}…
const NESTED_QUANTIFIER = /\([^)]*[+*]\s*\)\s*[+*{]/;
function regexIsSafe(source) {
    if (typeof source !== 'string' || !source || source.length > REGEX_MAX_LENGTH)
        return false;
    if (NESTED_QUANTIFIER.test(source))
        return false;
    // Backreferences plus quantifiers are the other common blow-up.
    if (/\\[1-9]/.test(source) && /[+*]/.test(source))
        return false;
    return true;
}
/**
 * Run a compiled regex under a wall-clock budget. Node cannot interrupt a
 * running regex, so this cannot stop a hang mid-flight — it detects one that
 * already happened and disables the rule so it costs us once, not once per
 * request for the rest of the session.
 */
const REGEX_TIME_BUDGET_MS = 20;
function testWithBudget(rule, url) {
    const t0 = Date.now();
    const hit = rule.regex.test(url);
    const spent = Date.now() - t0;
    if (spent > REGEX_TIME_BUDGET_MS) {
        rule.invalid = true;
        console.warn(`[dnr] disabled rule ${rule.id} from ${rule.extensionId}: regex took ${spent}ms`);
    }
    return hit;
}

/**
 * Chrome match patterns, for host-permission gating.
 *
 * Which actions need host access is not uniform, and getting it wrong is a
 * privilege bug either way:
 *   - `declarativeNetRequest`: block/allow/allowAllRequests/upgradeScheme apply
 *     everywhere, but redirect and modifyHeaders need access to BOTH the
 *     request URL and its initiator — otherwise an extension with no host
 *     permissions could silently reroute traffic or strip security headers.
 *   - `declarativeNetRequestWithHostAccess`: every action needs that access.
 *
 * Runtime-granted optional_host_permissions are not modelled: Electron has no
 * host-permission grant flow, so what the manifest declares is what is held.
 */
const ALL_URLS_SCHEMES = new Set(['http', 'https', 'file', 'ftp', 'ws', 'wss']);
function compilePattern(pattern) {
    if (!pattern || typeof pattern !== 'string')
        return null;
    if (pattern === '<all_urls>')
        return { all: true };
    const m = /^(\*|[a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/i.exec(pattern);
    if (!m)
        return null;
    const scheme = m[1].toLowerCase();
    const host = m[2];
    const pathGlob = m[3] || '/*';
    let hostRe;
    if (host === '*')
        hostRe = /^.*$/;
    else if (host.startsWith('*.'))
        hostRe = new RegExp(`^(?:.*\\.)?${escapeRe(host.slice(2))}$`, 'i');
    else
        hostRe = new RegExp(`^${escapeRe(host)}$`, 'i');
    const pathRe = new RegExp('^' + pathGlob.split('*').map(escapeRe).join('.*') + '$');
    return { scheme, hostRe, pathRe };
}
function patternMatches(c, url) {
    if (!c)
        return false;
    try {
        const u = new URL(url);
        const proto = u.protocol.replace(/:$/, '');
        if (c.all)
            return ALL_URLS_SCHEMES.has(proto);
        // '*' as a scheme means http or https only — never file: or ws:.
        if (c.scheme === '*') {
            if (proto !== 'http' && proto !== 'https')
                return false;
        }
        else if (c.scheme !== proto) {
            return false;
        }
        if (!c.hostRe.test(u.hostname))
            return false;
        return c.pathRe.test(u.pathname + u.search);
    }
    catch { return false; }
}

// eTLD+1 comparison for domainType firstParty/thirdParty.
let _parseTld = null;
function etld1(host) {
    if (!host)
        return '';
    if (!_parseTld) {
        try { _parseTld = require('tldts').parse; }
        catch { _parseTld = () => ({}); }
    }
    try { return _parseTld(host, { allowPrivateDomains: true }).domain || host; }
    catch { return host; }
}

/** One compiled rule, ready to test against a request. */
class CompiledRule {
    constructor(rule, extensionId, source) {
        this.id = rule.id;
        this.extensionId = extensionId;
        this.source = source; // 'static' | 'dynamic' | 'session'
        this.priority = Number.isFinite(rule.priority) ? rule.priority : 1;
        this.action = rule.action || { type: 'block' };
        this.rank = ACTION_RANK[this.action.type] ?? 9;
        const c = rule.condition || {};
        this.condition = c;
        this.regex = null;
        this.isRegex = false;
        try {
            if (c.regexFilter) {
                if (!regexIsSafe(c.regexFilter)) {
                    console.warn(`[dnr] ${extensionId} rule ${rule.id}: refusing unsafe regexFilter`);
                    this.invalid = true;
                    return;
                }
                this.regex = new RegExp(c.regexFilter, c.isUrlFilterCaseSensitive ? '' : 'i');
                this.isRegex = true;
            }
            else if (c.urlFilter) {
                this.regex = compileUrlFilter(c.urlFilter, !!c.isUrlFilterCaseSensitive);
            }
        }
        catch {
            this.regex = null;
            this.invalid = true;
        }
        // Index key for the domain-bucketed lookup (see Dnr._candidates).
        // A ||domain^ rule can only ever match requests to that domain or a
        // subdomain of it, so it never needs testing against anything else —
        // and blocklists are overwhelmingly made of those.
        this.hostKey = null;
        if (!this.isRegex && typeof c.urlFilter === 'string') {
            const m = /^\|\|([a-z0-9][a-z0-9.-]*[a-z0-9])(?=[/^:?|]|$)/i.exec(c.urlFilter);
            if (m && !m[1].includes('*'))
                this.hostKey = m[1].toLowerCase();
        }
        // A rule that can't be bucketed by host can often be by a word.
        this.keyword = (!this.hostKey && !this.isRegex && typeof c.urlFilter === 'string')
            ? filterKeyword(c.urlFilter) : null;
        // Normalise the two generations of domain conditions into one shape.
        this.initiatorDomains = c.initiatorDomains || c.domains || null;
        this.excludedInitiatorDomains = c.excludedInitiatorDomains || c.excludedDomains || null;
        this.resourceTypes = c.resourceTypes ? new Set(c.resourceTypes) : null;
        this.excludedResourceTypes = c.excludedResourceTypes ? new Set(c.excludedResourceTypes) : null;
        this.requestMethods = c.requestMethods ? new Set(c.requestMethods.map(m => m.toLowerCase())) : null;
        this.excludedRequestMethods = c.excludedRequestMethods ? new Set(c.excludedRequestMethods.map(m => m.toLowerCase())) : null;
    }

    matches(req) {
        if (this.invalid)
            return false;
        // Only user-supplied regexFilter needs the budget; compiled urlFilter
        // patterns are ours and linear by construction.
        if (this.regex) {
            const hit = this.isRegex ? testWithBudget(this, req.url) : this.regex.test(req.url);
            if (!hit)
                return false;
        }
        if (this.resourceTypes && !this.resourceTypes.has(req.type))
            return false;
        if (this.excludedResourceTypes && this.excludedResourceTypes.has(req.type))
            return false;
        // Chrome's documented default: an unspecified resourceTypes matches
        // everything EXCEPT main_frame, so a bare ||ads.example^ block rule
        // cannot take out the top-level navigation.
        if (!this.resourceTypes && req.type === 'main_frame')
            return false;
        if (this.requestMethods && !this.requestMethods.has(req.method))
            return false;
        if (this.excludedRequestMethods && this.excludedRequestMethods.has(req.method))
            return false;
        const c = this.condition;
        if (c.requestDomains && !anyHostMatches(req.host, c.requestDomains))
            return false;
        if (c.excludedRequestDomains && anyHostMatches(req.host, c.excludedRequestDomains))
            return false;
        if (this.initiatorDomains && !anyHostMatches(req.initiatorHost, this.initiatorDomains))
            return false;
        if (this.excludedInitiatorDomains && anyHostMatches(req.initiatorHost, this.excludedInitiatorDomains))
            return false;
        if (c.domainType) {
            const third = req.initiatorHost && etld1(req.initiatorHost) !== etld1(req.host);
            if (c.domainType === 'thirdParty' && !third)
                return false;
            if (c.domainType === 'firstParty' && third)
                return false;
        }
        if (c.tabIds && !c.tabIds.includes(req.tabId))
            return false;
        if (c.excludedTabIds && c.excludedTabIds.includes(req.tabId))
            return false;
        return true;
    }
}

class Dnr {
    constructor() {
        // extension id → { staticSets: Map(rulesetId → {enabled, rules:[CompiledRule]}),
        //                  dynamic: [CompiledRule], session: [CompiledRule], manifest }
        this.exts = new Map();
        this._flat = null; // flattened active rule list, rebuilt lazily
        this._hasHeaderRules = false;
        this.blockedCount = 0;
        this.matched = []; // ring buffer for getMatchedRules()
        this._dir = null;
        // allowAllRequests on a document allowlists everything inside it. Keyed
        // by "tabId:frameUrl" since Electron gives us no frame tree here.
        this._frameAllow = new Set();
    }

    _dataDir() {
        if (this._dir)
            return this._dir;
        try { this._dir = path.join(app.getPath('userData'), 'northstar', 'dnr'); }
        catch { this._dir = path.join(process.cwd(), 'dnr'); }
        try { fs.mkdirSync(this._dir, { recursive: true }); }
        catch (e) { log.debug('dnr', '_dataDir', e); }
        return this._dir;
    }

    _rec(extensionId) {
        let rec = this.exts.get(extensionId);
        if (!rec) {
            rec = {
                staticSets: new Map(), dynamic: [], session: [], manifest: null,
                hostPatterns: [], strictHostAccess: false,
            };
            this.exts.set(extensionId, rec);
        }
        return rec;
    }

    /** Does this extension hold host access to `url`? */
    _canAccess(extensionId, url) {
        const rec = this.exts.get(extensionId);
        if (!rec || !url)
            return false;
        for (const p of rec.hostPatterns)
            if (patternMatches(p, url))
                return true;
        return false;
    }

    /**
     * Whether a matching rule is actually permitted to act on this request.
     * A refused rule is SKIPPED, not treated as a miss — the next matching rule
     * still gets its turn, which is what Chrome does.
     */
    _mayApply(rule, req) {
        const rec = this.exts.get(rule.extensionId);
        if (!rec)
            return true;
        const t = rule.action.type;
        const needsAccess = t === 'redirect' || t === 'modifyHeaders' || rec.strictHostAccess;
        if (!needsAccess)
            return true;
        if (!this._canAccess(rule.extensionId, req.url))
            return false;
        // Access to the initiating document is required too, or an extension
        // permitted on one site could rewrite its requests to another.
        if (req.initiatorUrl && req.initiatorUrl !== req.url &&
            !this._canAccess(rule.extensionId, req.initiatorUrl))
            return false;
        return true;
    }

    _invalidate() { this._flat = null; }

    /** Active rules across every extension, highest priority first. */
    _rules() {
        if (this._flat)
            return this._flat;
        const out = [];
        for (const rec of this.exts.values()) {
            for (const set of rec.staticSets.values())
                if (set.enabled)
                    out.push(...this._loadSet(set));
            out.push(...rec.dynamic, ...rec.session);
        }
        // Sort once here so matching never has to.
        out.sort((a, b) => (b.priority - a.priority) || (a.rank - b.rank));
        this._hasHeaderRules = out.some(r => r.action.type === 'modifyHeaders');
        // Bucket by domain. Without this every request scanned every rule, and
        // a real blocklist is large — uBlock Origin Lite alone loads ~18k rules,
        // so a page of 50 requests meant ~900k regex tests on the main process,
        // which is exactly the sort of thing that makes a browser feel sluggish.
        // Requests that match nothing (the common case) paid the full scan.
        const byHost = new Map();
        const byWord = new Map();
        const generic = [];
        const push = (map, key, rule) => {
            let bucket = map.get(key);
            if (!bucket)
                map.set(key, bucket = []);
            bucket.push(rule);
        };
        out.forEach((rule, i) => {
            rule.seq = i; // global priority order: the earliest match wins
            if (rule.hostKey)
                push(byHost, rule.hostKey, rule);
            else if (rule.keyword)
                push(byWord, rule.keyword, rule);
            else
                generic.push(rule);
        });
        this._byHost = byHost;
        this._byWord = byWord;
        this._generic = generic;
        this._flat = out;
        return out;
    }

    /**
     * Rules that could possibly match this request, in global priority order.
     * Everything bucketed under an unrelated domain is skipped outright.
     */
    _candidateLists(req) {
        this._rules(); // ensures the index is built
        const lists = [this._generic];
        // Words of the URL: rules keyed on a word it doesn't contain can't match.
        if (this._byWord.size)
            for (const w of urlWords(req.url)) {
                const bucket = this._byWord.get(w);
                if (bucket)
                    lists.push(bucket);
            }
        // Walk the domain and its parents: a rule keyed on example.com must be
        // considered for a.b.example.com.
        const host = req.host;
        if (host) {
            let from = 0;
            for (;;) {
                const bucket = this._byHost.get(host.slice(from));
                if (bucket)
                    lists.push(bucket);
                const dot = host.indexOf('.', from);
                if (dot === -1)
                    break;
                from = dot + 1;
            }
        }
        return lists;
    }
    /* The highest-priority rule passing `ok` across the candidate lists. Each
       list is already in priority order, so its first passing rule is its
       best; the winner is the earliest of those. No list is copied or sorted. */
    _firstMatch(lists, ok) {
        let winner = null;
        for (const list of lists) {
            for (const rule of list) {
                if (winner && rule.seq >= winner.seq)
                    break; // nothing later in this list can beat it
                if (ok(rule)) {
                    winner = rule;
                    break;
                }
            }
        }
        return winner;
    }
    /** Every candidate, in priority order (for the rare callers that need all). */
    _candidates(req) {
        const out = [].concat(...this._candidateLists(req));
        out.sort((a, b) => a.seq - b.seq);
        return out;
    }

    // INK_DNR_DISABLE short-circuits the engine, so its behaviour can be
    // compared against Chromium's own DNR without rebuilding.
    get active() { return !process.env.INK_DNR_DISABLE && this._rules().length > 0; }

    // ── Registration ─────────────────────────────────────────────────────────
    /**
     * Read an extension's manifest rulesets off disk. Called when an extension
     * loads; safe to call again for the same id (it replaces the static sets).
     */
    registerExtension(ext) {
        try {
            const manifest = ext.manifest || {};
            const decl = manifest.declarative_net_request;
            const rec = this._rec(ext.id);
            rec.manifest = manifest;
            rec.staticSets.clear();
            // Host access, for gating redirect/modifyHeaders below.
            const perms = manifest.permissions || [];
            rec.hostPatterns = [];
            for (const p of manifest.host_permissions || []) {
                const c = compilePattern(p);
                if (c)
                    rec.hostPatterns.push(c);
            }
            // MV2 declares host permissions in `permissions` alongside API names.
            for (const p of perms) {
                if (typeof p === 'string' && (p === '<all_urls>' || p.includes('://'))) {
                    const c = compilePattern(p);
                    if (c)
                        rec.hostPatterns.push(c);
                }
            }
            // The WithHostAccess variant gates EVERY action, not just the two.
            rec.strictHostAccess = perms.includes('declarativeNetRequestWithHostAccess') &&
                !perms.includes('declarativeNetRequest');
            /* A ruleset is read and compiled only while it is ENABLED. Blockers
               ship dozens of regional lists and switch on two or three: AdBlock
               carries 37 (1.7 million rules) and enables 3 — compiling all of
               them froze the main process for ~5 s and kept every RegExp alive. */
            for (const res of decl?.rule_resources || []) {
                const file = path.join(ext.path, String(res.path || '').replace(/^\/+/, ''));
                const set = { enabled: res.enabled !== false, file, rules: null, id: String(res.id), ext: ext.id };
                rec.staticSets.set(String(res.id), set);
                if (set.enabled)
                    this._loadSet(set);
            }
            // Dynamic rules survive restarts; session rules deliberately do not.
            rec.dynamic = this._readDynamic(ext.id).map(r => new CompiledRule(r, ext.id, 'dynamic'));
            rec.session = [];
            this._invalidate();
            const count = this._rules().filter(r => r.extensionId === ext.id).length;
            if (count)
                log.debug('dnr', `${ext.name || ext.id}: ${count} rules active`);
        }
        catch (e) {
            console.error('[dnr] registerExtension:', e.message);
        }
    }

    /** Read and compile one static ruleset (once, while it is enabled). */
    _loadSet(set) {
        if (set.rules)
            return set.rules;
        try {
            const parsed = JSON.parse(fs.readFileSync(set.file, 'utf-8'));
            set.rules = Array.isArray(parsed)
                ? parsed.slice(0, MAX_STATIC_RULES).map(r => new CompiledRule(r, set.ext, 'static'))
                : [];
        }
        catch (e) {
            log.warn('dnr', `${set.ext} ruleset ${set.id} could not be read`, e);
            set.rules = [];
        }
        return set.rules;
    }

    unregisterExtension(extensionId) {
        this.exts.delete(extensionId);
        this._invalidate();
    }

    // ── Rule storage ─────────────────────────────────────────────────────────
    _dynamicFile(id) { return path.join(this._dataDir(), `${id}.json`); }
    _readDynamic(id) {
        try {
            const a = JSON.parse(fs.readFileSync(this._dynamicFile(id), 'utf-8'));
            return Array.isArray(a) ? a : [];
        }
        catch { return []; }
    }
    _writeDynamic(id, rules) {
        try { fs.writeFileSync(this._dynamicFile(id), JSON.stringify(rules)); }
        catch (e) { console.error('[dnr] persist:', e.message); }
    }

    /** updateDynamicRules / updateSessionRules share one implementation. */
    updateRules(extensionId, { removeRuleIds, addRules }, kind) {
        const rec = this._rec(extensionId);
        const raw = kind === 'dynamic' ? this._readDynamic(extensionId) : (rec._sessionRaw || []);
        const drop = new Set((removeRuleIds || []).map(Number));
        // Chrome removes FIRST, then adds — so passing the same id in both is
        // the documented upsert idiom, not a conflict. Skipping those adds
        // silently dropped every rule an extension tried to update in place.
        const next = raw.filter(r => !drop.has(Number(r.id)));
        for (const r of addRules || []) {
            if (next.some(e => Number(e.id) === Number(r.id)))
                throw new Error(`Rule with id ${r.id} already exists`);
            // Reject at update time the way Chrome does, rather than storing a
            // rule that would be silently dropped at compile time.
            const rf = r?.condition?.regexFilter;
            if (rf && !regexIsSafe(rf))
                throw new Error(`Rule with id ${r.id} specified a more complex regex than allowed`);
            next.push(r);
        }
        const cap = kind === 'dynamic' ? MAX_DYNAMIC_RULES : MAX_SESSION_RULES;
        if (next.length > cap)
            throw new Error(`Rule count exceeds the ${kind} limit of ${cap}`);
        const compiled = next.map(r => new CompiledRule(r, extensionId, kind));
        if (kind === 'dynamic') {
            rec.dynamic = compiled;
            this._writeDynamic(extensionId, next);
        }
        else {
            rec.session = compiled;
            rec._sessionRaw = next;
        }
        this._invalidate();
        return true;
    }

    getRules(extensionId, kind) {
        const rec = this._rec(extensionId);
        return kind === 'dynamic' ? this._readDynamic(extensionId) : (rec._sessionRaw || []);
    }

    updateEnabledRulesets(extensionId, { enableRulesetIds, disableRulesetIds }) {
        const rec = this._rec(extensionId);
        for (const id of disableRulesetIds || []) {
            const set = rec.staticSets.get(String(id));
            if (set) {
                set.enabled = false;
                set.rules = null; // its compiled rules go with it
            }
        }
        for (const id of enableRulesetIds || []) {
            const set = rec.staticSets.get(String(id));
            if (set) {
                set.enabled = true;
                this._loadSet(set);
            }
        }
        this._invalidate();
        return true;
    }

    getEnabledRulesets(extensionId) {
        const rec = this._rec(extensionId);
        return [...rec.staticSets.entries()].filter(([, s]) => s.enabled).map(([id]) => id);
    }

    getAvailableStaticRuleCount(extensionId) {
        const rec = this._rec(extensionId);
        let used = 0;
        // Chrome counts the ENABLED rulesets against the limit.
        for (const s of rec.staticSets.values())
            if (s.enabled)
                used += this._loadSet(s).length;
        return Math.max(0, MAX_STATIC_RULES - used);
    }

    // ── Matching ─────────────────────────────────────────────────────────────
    /** Normalise an Electron webRequest details object into a match subject. */
    _subject(details) {
        const url = details.url;
        const type = RESOURCE_TYPE[details.resourceType] || 'other';
        let initiator = details.referrer || '';
        if (!initiator && details.webContents) {
            try { initiator = details.webContents.getURL() || ''; }
            catch (e) { log.debug('dnr', '_subject', e); }
        }
        return {
            url,
            type,
            host: hostOf(url),
            initiatorUrl: initiator || '',
            initiatorHost: hostOf(initiator || url),
            method: (details.method || 'GET').toLowerCase(),
            tabId: details.webContentsId ?? -1,
        };
    }

    _record(rule, req) {
        this.matched.push({
            rule: { ruleId: rule.id, rulesetId: rule.source, extensionId: rule.extensionId },
            request: { url: req.url, type: req.type, tabId: req.tabId },
            timeStamp: Date.now(),
        });
        if (this.matched.length > MATCHED_LOG_MAX)
            this.matched.shift();
    }

    /**
     * onBeforeRequest decision. Returns an Electron response object to apply,
     * or null to let the rest of the pipeline run.
     */
    onBeforeRequest(details) {
        if (!this.active)
            return null;
        const req = this._subject(details);
        // Inside a document an allowAllRequests rule matched, nothing is blocked.
        if (req.type !== 'main_frame' && this._frameAllow.has(`${req.tabId}:${req.initiatorHost}`))
            return null;
        // The first (highest-priority) rule that matches and may apply; one
        // without host access is skipped so the next matching rule still can.
        const winner = this._firstMatch(this._candidateLists(req), (rule) =>
            rule.action.type !== 'modifyHeaders' && rule.matches(req) && this._mayApply(rule, req));
        if (!winner)
            return null;
        const t = winner.action.type;
        if (t === 'allow')
            return null;
        if (t === 'allowAllRequests') {
            if (req.type === 'main_frame' || req.type === 'sub_frame') {
                this._frameAllow.add(`${req.tabId}:${req.host}`);
                if (this._frameAllow.size > 500)
                    this._frameAllow.clear();
            }
            return null;
        }
        this._record(winner, req);
        if (t === 'block') {
            this.blockedCount++;
            return { cancel: true };
        }
        if (t === 'upgradeScheme') {
            if (req.url.startsWith('http://'))
                return { redirectURL: 'https://' + req.url.slice(7) };
            return null;
        }
        if (t === 'redirect') {
            const to = this._redirectUrl(winner, req);
            return to && to !== req.url ? { redirectURL: to } : null;
        }
        return null;
    }

    _redirectUrl(rule, req) {
        const r = rule.action.redirect || {};
        try {
            if (r.url)
                return r.url;
            if (r.extensionPath)
                return `chrome-extension://${rule.extensionId}${r.extensionPath.startsWith('/') ? '' : '/'}${r.extensionPath}`;
            if (r.regexSubstitution && rule.isRegex) {
                const m = rule.regex.exec(req.url);
                if (!m)
                    return null;
                return r.regexSubstitution.replace(/\\(\d)/g, (_, d) => m[Number(d)] ?? '');
            }
            if (r.transform) {
                const u = new URL(req.url);
                const t = r.transform;
                if (t.scheme)
                    u.protocol = t.scheme + ':';
                if (t.host)
                    u.hostname = t.host;
                if (t.port !== undefined)
                    u.port = t.port;
                if (t.path !== undefined)
                    u.pathname = t.path;
                if (t.fragment !== undefined)
                    u.hash = t.fragment;
                if (t.username !== undefined)
                    u.username = t.username;
                if (t.password !== undefined)
                    u.password = t.password;
                if (t.query !== undefined)
                    u.search = t.query;
                if (t.queryTransform) {
                    const qt = t.queryTransform;
                    for (const k of qt.removeParams || [])
                        u.searchParams.delete(k);
                    for (const kv of qt.addOrReplaceParams || [])
                        u.searchParams.set(kv.key, kv.value);
                }
                return u.toString();
            }
        }
        catch (e) { log.debug('dnr', '_redirectUrl', e); }
        return null;
    }

    /**
     * Header rewriting. `which` is 'request' or 'response'; headers is the
     * mutable object from the corresponding Electron handler. Returns true if
     * anything changed.
     */
    modifyHeaders(details, headers, which) {
        if (!this.active || !this._hasHeaderRules)
            return false;
        const req = this._subject(details);
        const lists = this._candidateLists(req);
        // A matching allow rule outranks header rules of lower priority.
        const allow = this._firstMatch(lists, (rule) =>
            (rule.action.type === 'allow' || rule.action.type === 'allowAllRequests') && rule.matches(req) && this._mayApply(rule, req));
        const allowPriority = allow ? allow.priority : -Infinity;
        // Header rules only, in priority order — a handful, not the whole list.
        const candidates = [].concat(...lists.map(l => l.filter(r => r.action.type === 'modifyHeaders')))
            .sort((a, b) => a.seq - b.seq);
        const key = which === 'request' ? 'requestHeaders' : 'responseHeaders';
        let changed = false;
        for (const rule of candidates) {
            if (rule.action.type !== 'modifyHeaders')
                continue;
            if (rule.priority <= allowPriority)
                continue;
            const ops = rule.action[key];
            if (!ops || !ops.length)
                continue;
            if (!rule.matches(req))
                continue;
            if (!this._mayApply(rule, req))
                continue;
            for (const op of ops) {
                const name = String(op.header || '');
                if (!name)
                    continue;
                const existing = Object.keys(headers).find(h => h.toLowerCase() === name.toLowerCase());
                if (op.operation === 'remove') {
                    if (existing) {
                        delete headers[existing];
                        changed = true;
                    }
                }
                else if (op.operation === 'set') {
                    if (existing)
                        delete headers[existing];
                    headers[name] = which === 'response' ? [String(op.value)] : String(op.value);
                    changed = true;
                }
                else if (op.operation === 'append') {
                    if (which === 'response') {
                        const cur = existing ? headers[existing] : null;
                        const list = Array.isArray(cur) ? cur.slice() : (cur ? [cur] : []);
                        list.push(String(op.value));
                        if (existing)
                            delete headers[existing];
                        headers[name] = list;
                    }
                    else {
                        const cur = existing ? headers[existing] : '';
                        headers[existing || name] = cur ? `${cur}, ${op.value}` : String(op.value);
                    }
                    changed = true;
                }
            }
            if (changed)
                this._record(rule, req);
        }
        return changed;
    }

    getMatchedRules(extensionId, filter) {
        let rows = this.matched.filter(m => m.rule.extensionId === extensionId);
        if (filter?.tabId !== undefined && filter.tabId >= 0)
            rows = rows.filter(m => m.request.tabId === filter.tabId);
        if (filter?.minTimeStamp)
            rows = rows.filter(m => m.timeStamp >= filter.minTimeStamp);
        return { rulesMatchedInfo: rows };
    }

    /** testMatchOutcome — lets an extension self-check without a live request. */
    testMatchOutcome(extensionId, request) {
        const req = {
            url: request.url,
            type: request.type || 'other',
            host: hostOf(request.url),
            initiatorUrl: request.initiator || '',
            initiatorHost: hostOf(request.initiator || request.url),
            method: (request.method || 'get').toLowerCase(),
            tabId: request.tabId ?? -1,
        };
        const hits = [];
        for (const rule of this._rules()) {
            if (rule.extensionId !== extensionId)
                continue;
            // Report what would really happen, host permissions included.
            if (rule.matches(req) && this._mayApply(rule, req))
                hits.push({ ruleId: rule.id, rulesetId: rule.source, extensionId });
        }
        return { matchedRules: hits };
    }

    /** chrome.declarativeNetRequest.isRegexSupported — same rules the compiler applies. */
    isRegexSupported(regex, caseSensitive) {
        if (!regexIsSafe(regex))
            return { isSupported: false, reason: 'patternTooComplex' };
        try {
            new RegExp(regex, caseSensitive ? '' : 'i');
            return { isSupported: true };
        }
        catch {
            return { isSupported: false, reason: 'syntaxError' };
        }
    }

    getStats() {
        return {
            extensions: this.exts.size,
            rules: this._rules().length,
            blocked: this.blockedCount,
        };
    }
}

module.exports = new Dnr();
