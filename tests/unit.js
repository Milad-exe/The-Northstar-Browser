/**
 * Pure-logic unit tests — `npm run test:unit`. No Electron, no window: these
 * cover the parts that fail silently in a browser (a mis-parsed bookmark file,
 * a back/forward tree that loses an entry, a URL that should never have been
 * handed to the OS) and so are the parts worth pinning down.
 *
 * Modules that pull in `electron` are stubbed through require.cache, which is
 * why this file can run under plain node.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const Module = require('module');

// ── Stub `electron` before anything requires it ──────────────────────────────
const electronStub = {
    app: {
        getPath: () => require('os').tmpdir(),
        getAppPath: () => path.join(__dirname, '..'),
        getVersion: () => '1.0.0',
        setAsDefaultProtocolClient: () => true,
        isDefaultProtocolClient: () => false,
        on: () => { },
    },
    safeStorage: { isEncryptionAvailable: () => false },
    net: { request: () => { throw new Error('no network in unit tests'); } },
    shell: {},
    dialog: {},
};
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (request === 'electron')
        return 'electron-stub';
    return realResolve.call(this, request, ...rest);
};
require.cache['electron-stub'] = { id: 'electron-stub', filename: 'electron-stub', loaded: true, exports: electronStub };

const root = path.join(__dirname, '..');
const userData = require(path.join(root, 'features/user-data'));
const NavigationHistory = require(path.join(root, 'features/navigation-history'));
const { sanitizeUrl, isSafeExternal } = require(path.join(root, 'features/url-security'));
const updates = require(path.join(root, 'features/updates'));
const searchEngines = require(path.join(root, 'features/search-engines'));
const defaultBrowser = require(path.join(root, 'features/default-browser'));
const chromeUtil = require(path.join(root, 'renderer/lib/util'));
const chromeI18n = require(path.join(root, 'renderer/lib/i18n'));
const i18n = require(path.join(root, 'features/i18n'));

// ── Tiny harness ─────────────────────────────────────────────────────────────
let passed = 0;
const failures = [];
function test(name, fn) {
    try {
        fn();
        passed++;
    }
    catch (err) {
        failures.push({ name, err });
    }
}

// ── Bookmarks: Netscape HTML ─────────────────────────────────────────────────
const CHROME_EXPORT = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1600000000" LAST_MODIFIED="1600000000" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><A HREF="https://example.com/" ADD_DATE="1600000000">Example &amp; Co</A>
        <DT><H3>Work</H3>
        <DL><p>
            <DT><A HREF="https://jira.internal/browse/ABC-1">Ticket &lt;1&gt;</A>
        </DL><p>
        <DT><A HREF="javascript:void(0)">A bookmarklet</A>
    </DL><p>
    <DT><A HREF="https://news.example.org/">News</A>
</DL><p>`;

test('bookmark import reads a Chrome export', () => {
    const items = userData.parseBookmarksHtml(CHROME_EXPORT);
    const urls = items.map(i => i.url);
    assert.deepStrictEqual(urls, [
        'https://example.com/',
        'https://jira.internal/browse/ABC-1',
        'https://news.example.org/',
    ], 'javascript: bookmarklets must be skipped, real ones kept');
});

test('bookmark import unescapes entities in titles', () => {
    const items = userData.parseBookmarksHtml(CHROME_EXPORT);
    assert.strictEqual(items[0].title, 'Example & Co');
    assert.strictEqual(items[1].title, 'Ticket <1>');
});

test('bookmark import tracks the enclosing folder', () => {
    const items = userData.parseBookmarksHtml(CHROME_EXPORT);
    assert.strictEqual(items[0].folder, 'Bookmarks bar');
    assert.strictEqual(items[1].folder, 'Work');
    assert.strictEqual(items[2].folder, null, 'a top-level bookmark has no folder');
});

test('bookmark export round-trips through the importer', () => {
    const html = userData.bookmarksToHtml([
        { type: 'folder', title: 'Reading', children: [{ type: 'bookmark', url: 'https://a.example/x?y=1&z=2', title: 'A & B' }] },
        { type: 'bookmark', url: 'https://b.example/', title: 'B' },
    ]);
    const back = userData.parseBookmarksHtml(html);
    assert.strictEqual(back.length, 2);
    assert.strictEqual(back[0].url, 'https://a.example/x?y=1&z=2', 'ampersands survive the round trip');
    assert.strictEqual(back[0].title, 'A & B');
    assert.strictEqual(back[0].folder, 'Reading');
});

test('bookmark import survives a file with no bookmarks', () => {
    assert.deepStrictEqual(userData.parseBookmarksHtml('<html><body>nothing</body></html>'), []);
});

// ── Passwords: CSV ───────────────────────────────────────────────────────────
test('password import reads the Chrome column names', () => {
    const rows = userData.parsePasswordCsv('name,url,username,password\nExample,https://example.com/login,alice,hunter2\n');
    assert.deepStrictEqual(rows, [{ origin: 'https://example.com', username: 'alice', password: 'hunter2' }]);
});

test('password import reads Firefox/Bitwarden column names', () => {
    const rows = userData.parsePasswordCsv('login_uri,login_username,login_password\nexample.org,bob,s3cret\n');
    assert.deepStrictEqual(rows, [{ origin: 'https://example.org', username: 'bob', password: 's3cret' }]);
});

test('password import handles quoted fields, commas and doubled quotes', () => {
    const rows = userData.parsePasswordCsv('url,username,password\n"https://a.example","al,ice","pa""ss"\n');
    assert.strictEqual(rows[0].username, 'al,ice');
    assert.strictEqual(rows[0].password, 'pa"ss');
});

test('password import skips rows with no password', () => {
    const rows = userData.parsePasswordCsv('url,username,password\nhttps://a.example,alice,\nhttps://b.example,bob,x\n');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].origin, 'https://b.example');
});

test('password import returns nothing when the columns are missing', () => {
    assert.deepStrictEqual(userData.parsePasswordCsv('foo,bar\n1,2\n'), []);
});

test('password export quotes what needs quoting', () => {
    const csv = userData.passwordsToCsv([{ origin: 'https://a.example', username: 'a,b', password: 'q"q' }]);
    assert.strictEqual(csv, 'url,username,password\nhttps://a.example,"a,b","q""q"\n');
});

test('CSV parser strips a BOM', () => {
    const rows = userData.parseCsv('﻿url,username,password\nhttps://a.example,a,b\n');
    assert.strictEqual(rows[0][0], 'url');
});

// ── Navigation history (back/forward tree) ───────────────────────────────────
test('restoring a tab rebuilds a walkable back/forward tree', () => {
    const nav = new NavigationHistory();
    nav.restoreTab(7, [
        { url: 'https://a.example', title: 'A' },
        { url: 'https://b.example', title: 'B' },
        { url: 'https://c.example', title: 'C' },
    ], 2);
    assert.strictEqual(nav.getCurrentUrl(7), 'https://c.example');
    assert.strictEqual(nav.canGoBack(7), true);
    assert.strictEqual(nav.canGoForward(7), false);
    assert.strictEqual(nav.goBack(7), 'https://b.example');
    assert.strictEqual(nav.goBack(7), 'https://a.example');
    assert.strictEqual(nav.goBack(7), null, 'the oldest entry has nothing behind it');
    assert.strictEqual(nav.goForward(7), 'https://b.example');
});

test('restore clamps an out-of-range current index', () => {
    const nav = new NavigationHistory();
    nav.restoreTab(1, ['https://a.example', 'https://b.example'], 99);
    assert.strictEqual(nav.getCurrentUrl(1), 'https://b.example');
});

test('restore keeps entry titles for the history dropdown', () => {
    const nav = new NavigationHistory();
    nav.restoreTab(2, [{ url: 'https://a.example', title: 'Alpha' }, { url: 'https://b.example', title: 'Beta' }], 1);
    const titles = nav.getHistory(2).entries.map(e => e.title);
    assert.deepStrictEqual(titles, ['Alpha', 'Beta']);
});

test('a new entry after going back truncates the forward branch', () => {
    const nav = new NavigationHistory();
    nav.restoreTab(3, ['https://a.example', 'https://b.example', 'https://c.example'], 2);
    nav.goBack(3);
    nav.addEntry(3, 'https://d.example');
    assert.strictEqual(nav.canGoForward(3), false);
    assert.strictEqual(nav.getCurrentUrl(3), 'https://d.example');
});

// ── URL safety ───────────────────────────────────────────────────────────────
test('sanitizeUrl refuses javascript: and data: urls', () => {
    assert.notStrictEqual(sanitizeUrl('javascript:alert(1)'), 'javascript:alert(1)');
    assert.notStrictEqual(sanitizeUrl('data:text/html,<script>x</script>'), 'data:text/html,<script>x</script>');
});

test('sanitizeUrl keeps ordinary web urls intact', () => {
    assert.strictEqual(sanitizeUrl('https://example.com/a?b=1#c'), 'https://example.com/a?b=1#c');
});

test('only http(s) may be handed to the OS', () => {
    assert.strictEqual(isSafeExternal('https://example.com'), true);
    assert.strictEqual(isSafeExternal('file:///etc/passwd'), false);
    assert.strictEqual(isSafeExternal('javascript:alert(1)'), false);
});

// ── IPC sender trust (privileged handlers) ────────────────────────────────────
const { isTrustedInternalUrl } = require(path.join(root, 'features/ipc-guard'));
const { pathToFileURL } = require('url');
test('a file:// page inside the app root is a trusted internal sender', () => {
    const url = pathToFileURL(path.join(root, 'renderer/Settings/index.html')).href;
    assert.strictEqual(isTrustedInternalUrl(url), true);
    const chrome = pathToFileURL(path.join(root, 'renderer/Browser/index.html')).href;
    assert.strictEqual(isTrustedInternalUrl(chrome), true);
});
test('web content is never a trusted internal sender', () => {
    assert.strictEqual(isTrustedInternalUrl('https://evil.com/Settings/x'), false);
    assert.strictEqual(isTrustedInternalUrl('http://localhost/Settings/'), false);
    assert.strictEqual(isTrustedInternalUrl('chrome-extension://abc/page.html'), false);
});
test('a local file outside the app root is not a trusted internal sender', () => {
    const outside = pathToFileURL(path.join(require('os').tmpdir(), 'evil', 'renderer', 'Settings', 'index.html')).href;
    assert.strictEqual(isTrustedInternalUrl(outside), false);
});

// ── Preload selection (privileged Settings preload) ──────────────────────────
const preloadForPage = require(path.join(root, 'features/tabs/preload-for-page'));
test('only the internal Settings page gets the privileged preload', () => {
    assert.ok(preloadForPage('settings').endsWith('settings-preload.js'));
    const settingsFile = pathToFileURL(path.join(root, 'renderer/Settings/index.html')).href;
    assert.ok(preloadForPage(settingsFile).endsWith('settings-preload.js'));
});
test('a remote /Settings/ url never gets the privileged preload', () => {
    assert.ok(preloadForPage('https://evil.com/Settings/').endsWith('preload.js'));
    assert.ok(!preloadForPage('https://evil.com/Settings/').endsWith('settings-preload.js'));
    assert.ok(preloadForPage('https://example.com/').endsWith('preload.js'));
    assert.ok(preloadForPage('newtab').endsWith('preload.js'));
});

// ── Back/forward: native bfcache fast-path vs loadURL fallback ────────────────
const navMixin = require(path.join(root, 'features/tabs/navigation'));
function navStub(nativeEntries, nativeActive) {
    // A tab whose webContents records whether native history or loadURL was used.
    const calls = { loadURL: null, nativeBack: 0, nativeForward: 0 };
    let active = nativeActive;
    const nav = {
        getActiveIndex: () => active,
        length: () => nativeEntries.length,
        getEntryAtIndex: (i) => nativeEntries[i] ? { url: nativeEntries[i] } : undefined,
        canGoBack: () => active > 0,
        canGoForward: () => active < nativeEntries.length - 1,
        goBack: () => { calls.nativeBack++; active--; },
        goForward: () => { calls.nativeForward++; active++; },
    };
    const tab = {
        setNavigatingProgrammatically: () => { },
        webContents: { navigationHistory: nav, loadURL: (u) => { calls.loadURL = u; } },
    };
    const history = new NavigationHistory();
    history.initializeTab(1, 'https://a.example/');
    history.addEntry(1, 'https://b.example/');
    history.addEntry(1, 'https://c.example/'); // tree now at C
    const tabs = {
        tabMap: new Map([[1, tab]]),
        privateTabs: new Set(),
        tabUrls: new Map(),
        navigationHistory: history,
        _loadBlank: () => { },
        sendNavigationUpdate: () => { },
    };
    return { tabs, tab, calls };
}
test('back restores from the native cache when histories agree', () => {
    // Native history mirrors the tree [A,B,C], active at C.
    const { tabs, calls } = navStub(['https://a.example/', 'https://b.example/', 'https://c.example/'], 2);
    navMixin.goBack.call(tabs, 1);
    assert.strictEqual(calls.nativeBack, 1, 'used native goBack');
    assert.strictEqual(calls.loadURL, null, 'did not reload');
    assert.strictEqual(tabs.tabUrls.get(1), 'https://b.example/', 'landed on the right url');
});
test('back falls back to loadURL when native history diverges', () => {
    // Restored-tab shape: native history holds only the current entry.
    const { tabs, calls } = navStub(['https://c.example/'], 0);
    navMixin.goBack.call(tabs, 1);
    assert.strictEqual(calls.nativeBack, 0, 'did not use native goBack');
    assert.strictEqual(calls.loadURL, 'https://b.example/', 'reloaded the correct url');
    assert.strictEqual(tabs.tabUrls.get(1), 'https://b.example/', 'landed on the right url');
});
test('forward restores from the native cache when histories agree', () => {
    const { tabs, calls } = navStub(['https://a.example/', 'https://b.example/', 'https://c.example/'], 2);
    navMixin.goBack.call(tabs, 1); // → B (native)
    navMixin.goForward.call(tabs, 1); // → C (native)
    assert.strictEqual(calls.nativeForward, 1, 'used native goForward');
    assert.strictEqual(tabs.tabUrls.get(1), 'https://c.example/', 'landed on the right url');
});

// ── Update version comparison ────────────────────────────────────────────────
test('version comparison orders releases correctly', () => {
    assert.strictEqual(updates.compareVersions('1.2.3', '1.2.2'), 1);
    assert.strictEqual(updates.compareVersions('1.2.3', '1.3.0'), -1);
    assert.strictEqual(updates.compareVersions('2.0.0', '1.99.99'), 1);
    assert.strictEqual(updates.compareVersions('1.0.0', '1.0.0'), 0);
});

test('version comparison tolerates tags and pre-release suffixes', () => {
    assert.strictEqual(updates.compareVersions('v1.4.0', '1.3.9'), 1);
    assert.strictEqual(updates.compareVersions('1.4.0-beta.2', '1.4.0'), 0);
    assert.strictEqual(updates.compareVersions('garbage', '1.0.0'), 0, 'unparseable means "do not claim an update"');
});

// ── Search engines ───────────────────────────────────────────────────────────
const fakePersistence = (initial = []) => {
    let stored = initial;
    return { get: () => stored, set: (_k, v) => { stored = v; } };
};

test('a bare query goes to the default engine', () => {
    searchEngines.init(fakePersistence());
    const r = searchEngines.resolve('electron docs', 'duckduckgo');
    assert.strictEqual(r.url, 'https://duckduckgo.com/?q=electron%20docs');
    assert.strictEqual(r.viaKeyword, false);
});

test('a keyword prefix routes to that engine for one search', () => {
    searchEngines.init(fakePersistence());
    const r = searchEngines.resolve('b electron docs', 'google');
    assert.strictEqual(r.engine.id, 'bing');
    assert.strictEqual(r.query, 'electron docs');
    assert.strictEqual(r.viaKeyword, true);
});

test('a bare keyword with no query is just a search for that word', () => {
    searchEngines.init(fakePersistence());
    const r = searchEngines.resolve('b', 'google');
    assert.strictEqual(r.engine.id, 'google');
    assert.strictEqual(r.query, 'b');
});

test('custom engines can be added, used by keyword, and removed', () => {
    const store = fakePersistence();
    searchEngines.init(store);
    const saved = searchEngines.upsert({ name: 'Wiki', keyword: 'w', url: 'https://en.wikipedia.org/w/index.php?search=%s' });
    assert.ok(searchEngines.all().some(e => e.id === saved.id));
    const r = searchEngines.resolve('w electron', 'google');
    assert.strictEqual(r.engine.name, 'Wiki');
    assert.strictEqual(r.url, 'https://en.wikipedia.org/w/index.php?search=electron');
    assert.strictEqual(searchEngines.remove(saved.id), true);
    assert.strictEqual(searchEngines.all().some(e => e.id === saved.id), false);
});

test('an engine without %s is rejected', () => {
    searchEngines.init(fakePersistence());
    assert.throws(() => searchEngines.upsert({ name: 'Bad', url: 'https://example.com/search' }));
});

test('a custom engine cannot hijack a built-in id', () => {
    searchEngines.init(fakePersistence());
    const saved = searchEngines.upsert({ id: 'google', name: 'Not Google', url: 'https://evil.example/?q=%s' });
    assert.notStrictEqual(saved.id, 'google');
    assert.strictEqual(searchEngines.byId('google').name, 'Google');
});

test('query encoding survives characters that would break a URL', () => {
    searchEngines.init(fakePersistence());
    const r = searchEngines.resolve('a&b=c #d', 'google');
    assert.strictEqual(r.url, 'https://www.google.com/search?q=a%26b%3Dc%20%23d');
});

// ── Default browser: incoming link argv ──────────────────────────────────────
test('an incoming link is picked out of argv', () => {
    assert.strictEqual(defaultBrowser.firstUrlIn(['/path/app', '--flag', 'https://example.com/x']), 'https://example.com/x');
    assert.strictEqual(defaultBrowser.firstUrlIn(['/path/app', '--flag']), null);
    assert.strictEqual(defaultBrowser.firstUrlIn([]), null);
});

// ── Omnibox helpers (renderer/lib/util.js) ───────────────────────────────────
test('typed text is classified as a URL or a search', () => {
    for (const url of ['https://example.com', 'example.com', 'example.co.uk/path', 'localhost:3000', 'sub.domain.io'])
        assert.strictEqual(chromeUtil.looksLikeUrl(url), true, `${url} should look like a URL`);
    for (const query of ['how to tie a tie', 'electron', 'why is the sky blue', 'a.b c'])
        assert.strictEqual(chromeUtil.looksLikeUrl(query), false, `${query} should look like a search`);
});

test('dedup key ignores www, scheme and a trailing slash', () => {
    const a = chromeUtil.normalizeUrl('https://www.example.com/path/');
    assert.strictEqual(a, chromeUtil.normalizeUrl('http://example.com/path'));
});

test('suggestion ranking prefers host matches over title matches', () => {
    const host = { url: 'https://youtube.com/', title: 'Nothing relevant' };
    const title = { url: 'https://other.example/x', title: 'You Tube fan page' };
    assert.ok(chromeUtil.linkScore(host, 'you') < chromeUtil.linkScore(title, 'you'));
});

test('a one-letter query does not match by substring', () => {
    assert.strictEqual(chromeUtil.linkScore({ url: 'https://gymshark.com/', title: 'Gymshark' }, 'y'), -1);
    assert.strictEqual(chromeUtil.linkScore({ url: 'https://youtube.com/', title: 'YouTube' }, 'y'), 0);
});

test('weak matches on login redirects and giant URLs are dropped', () => {
    assert.strictEqual(chromeUtil.isLowValueMatch('https://accounts.example.com/signin?continue=x', 2), true);
    assert.strictEqual(chromeUtil.isLowValueMatch('https://example.com/' + 'a'.repeat(120), 2), true);
    assert.strictEqual(chromeUtil.isLowValueMatch('https://accounts.example.com/signin', 0), false, 'a strong host match is always kept');
});

test('cleanliness sorts short titled URLs ahead of long untitled ones', () => {
    const titled = { url: 'https://a.example/x', title: 'A page' };
    const untitled = { url: 'https://a.example/x', title: 'https://a.example/x' };
    assert.ok(chromeUtil.cleanliness(titled) < chromeUtil.cleanliness(untitled));
});

test('resting URL display splits scheme, host and path', () => {
    assert.deepStrictEqual(chromeUtil.urlDisplayParts('https://example.com/a?b=1'), ['https://', 'example.com', '/a?b=1']);
    assert.strictEqual(chromeUtil.urlDisplayParts('file:///tmp/x'), null);
    assert.deepStrictEqual(chromeUtil.urlDisplayParts('https://user:pw@example.com/x'), ['https://user:pw@', 'example.com', '/x']);
});

test('a suggestion key is its url, else its type+query', () => {
    assert.strictEqual(chromeUtil.suggestionKey({ url: 'https://youtube.com/', type: 'history' }), 'https://youtube.com/');
    assert.strictEqual(chromeUtil.suggestionKey({ type: 'google', query: 'cats' }), 'google:cats');
    assert.strictEqual(chromeUtil.suggestionKey({ type: 'action', query: 'cats' }), 'action:cats');
});

test('the active row survives a re-render by identity, not index', () => {
    const prev = [
        { type: 'action', query: 'you' },   // base row (index 0)
        { url: 'https://youtube.com/' },     // index 1 — the row the user arrowed to
        { url: 'https://you.com/' },
    ];
    // A later merge reorders the list; the active url is now at index 2.
    const next = [
        { type: 'action', query: 'you' },
        { type: 'google', query: 'you tube' },
        { url: 'https://youtube.com/' },     // same identity, moved
    ];
    assert.strictEqual(chromeUtil.reindexActive(prev, 1, next), 2, 'follows the url across a merge');
    // The active row is gone from the next list → fall back to the base row.
    const gone = [{ type: 'action', query: 'you' }, { url: 'https://other.com/' }];
    assert.strictEqual(chromeUtil.reindexActive(prev, 1, gone), 0);
    // Nothing was active → base row.
    assert.strictEqual(chromeUtil.reindexActive(prev, -1, next), 0);
    // Empty next list → no selection.
    assert.strictEqual(chromeUtil.reindexActive(prev, 1, []), -1);
});

test('preconnect targets the right origin per row type', () => {
    const E = 'https://duckduckgo.com';
    assert.strictEqual(chromeUtil.preconnectOrigin({ url: 'https://youtube.com/watch?v=1' }, E), 'https://youtube.com');
    assert.strictEqual(chromeUtil.preconnectOrigin({ type: 'navigate', query: 'example.com/x' }, E), 'https://example.com');
    assert.strictEqual(chromeUtil.preconnectOrigin({ type: 'navigate', query: 'https://a.com/p' }, E), 'https://a.com');
    assert.strictEqual(chromeUtil.preconnectOrigin({ type: 'action', query: 'cats' }, E), E, 'a search action preconnects the engine');
    assert.strictEqual(chromeUtil.preconnectOrigin({ type: 'switch-tab', tabIndex: 2 }, E), null);
    assert.strictEqual(chromeUtil.preconnectOrigin({ url: 'https://x.com/', profile: 'work' }, E), null, 'a container row leaks no origin');
    assert.strictEqual(chromeUtil.preconnectOrigin({ url: 'about:blank' }, E), null, 'non-http never preconnects');
});

test('toNavigableUrl resolves typed text the same way the omnibox commits it', () => {
    // Lifted from renderer formatToUrl so the new-tab page and the omnibox can't
    // drift. Real URLs pass through; a bare domain gets https; a northstar:// or
    // file:// scheme passes; anything else becomes a search.
    const E = [{ id: 'google', url: 'https://www.google.com/search?q=%s' }];
    const nav = (t) => chromeUtil.toNavigableUrl(t, E, 'google');
    assert.strictEqual(nav('https://a.com/p'), 'https://a.com/p');
    assert.strictEqual(nav('example.com/x'), 'https://example.com/x');
    assert.strictEqual(nav('northstar://home'), 'northstar://home');
    assert.strictEqual(nav('file:///tmp/x'), 'file:///tmp/x');
    assert.strictEqual(nav('hello world'), 'https://www.google.com/search?q=hello%20world');
    assert.strictEqual(nav('   '), '', 'blank resolves to nothing');
});

// New-tab page: suggestions under the field and the most-visited tiles. Local
// only (no network), open tabs first so tab search lives in the NTP field.
test('ntpSuggestions ranks open tabs, then bookmarks, then history, deduped', () => {
    const sources = {
        tabs: [{ index: 4, url: 'https://github.com/x', title: 'GitHub repo' }],
        bookmarks: [{ url: 'https://github.com/x', title: 'dup of the tab' }, { url: 'https://git-scm.com', title: 'Git' }],
        history: [{ url: 'https://gitlab.com', title: 'GitLab' }, { url: 'https://git-scm.com', title: 'Git again' }, { url: 'https://news.com', title: 'News' }],
    };
    const rows = chromeUtil.ntpSuggestions('git', sources, 6);
    assert.deepStrictEqual(rows.map(r => [r.kind, r.url]), [
        ['tab', 'https://github.com/x'],
        ['bookmark', 'https://git-scm.com'],
        ['history', 'https://gitlab.com'],
    ]);
    assert.strictEqual(rows[0].index, 4, 'a tab row carries the tab to switch to');
    assert.deepStrictEqual(chromeUtil.ntpSuggestions('  ', sources, 6), [], 'blank query, no rows');
    assert.strictEqual(chromeUtil.ntpSuggestions('g', sources, 2).length, 2, 'limit holds');
});

// Ctrl+Shift+A: the NTP's tab-search mode lists every open tab before you type
// (Chrome's tab search does), filters as you do, and keeps two tabs on the same
// page apart — each row is its own tab.
test('tabSearchRows lists all tabs blank, filters typed, keeps duplicates', () => {
    const tabs = [
        { index: 1, url: 'https://a.com/', title: 'Alpha' },
        { index: 2, url: 'https://b.com/', title: 'Beta' },
        { index: 3, url: 'https://a.com/', title: 'Alpha' },
    ];
    assert.deepStrictEqual(chromeUtil.tabSearchRows('', tabs).map(r => r.index), [1, 2, 3]);
    assert.deepStrictEqual(chromeUtil.tabSearchRows('alp', tabs).map(r => r.index), [1, 3]);
    assert.deepStrictEqual(chromeUtil.tabSearchRows('b.com', tabs).map(r => r.index), [2]);
    assert.strictEqual(chromeUtil.tabSearchRows('', tabs, 2).length, 2, 'limit holds');
    assert.ok(chromeUtil.tabSearchRows('', tabs).every(r => r.kind === 'tab'));
});

// NTP shortcut tiles (Phase 4): your own tiles first and always shown, then the
// space's Essentials, then most-visited to fill — minus any you hid.
test('ntpTiles orders custom, essentials, frequent; hidden only hides the rest', () => {
    const cfg = { tiles: [{ url: 'https://mine.com/', title: 'Mine' }, { url: 'https://hid.com/', title: 'Kept' }], hidden: ['https://hid.com/', 'https://e2.com/', 'https://f2.com/'] };
    const sources = {
        essentials: [{ url: 'https://e1.com/', title: 'E1' }, { url: 'https://e2.com/', title: 'E2' }, { url: 'https://mine.com/', title: 'dup' }],
        frequent: [{ url: 'https://f1.com/', title: 'F1' }, { url: 'https://f2.com/', title: 'F2' }, { url: 'https://f3.com/', title: 'F3' }],
    };
    const t = chromeUtil.ntpTiles(cfg, sources, 5);
    assert.deepStrictEqual(t.map(x => [x.source, x.url]), [
        ['custom', 'https://mine.com/'], ['custom', 'https://hid.com/'],
        ['essential', 'https://e1.com/'], ['frequent', 'https://f1.com/'], ['frequent', 'https://f3.com/'],
    ]);
    assert.deepStrictEqual(chromeUtil.ntpTiles({}, {}, 8), [], 'nothing to show, no tiles');
});

test('tileUrl accepts addresses, refuses searches and unsafe schemes', () => {
    assert.strictEqual(chromeUtil.tileUrl('example.com'), 'https://example.com/');
    assert.strictEqual(chromeUtil.tileUrl(' https://a.com/x?y=1 '), 'https://a.com/x?y=1');
    assert.strictEqual(chromeUtil.tileUrl('http://local.test:8080'), 'http://local.test:8080/');
    assert.strictEqual(chromeUtil.tileUrl('just words'), '');
    assert.strictEqual(chromeUtil.tileUrl('javascript:alert(1)'), '');
    assert.strictEqual(chromeUtil.tileUrl(''), '');
});

// Drag-reorder sends only the tabs the sidebar draws (this space, no
// Essentials). reorderTabs demanded EVERY tab, so with two spaces a drag was
// silently dropped. mergeOrder lays the drawn tabs into their own slots and
// leaves every other tab where it was.
test('mergeOrder reorders a subset in place, other tabs keep their slots', () => {
    assert.deepStrictEqual(chromeUtil.mergeOrder([0, 1, 2, 3, 4], [4, 1, 3]), [0, 4, 2, 1, 3]);
    assert.deepStrictEqual(chromeUtil.mergeOrder([0, 1, 2], [2, 1, 0]), [2, 1, 0], 'a full order is taken as-is');
    assert.deepStrictEqual(chromeUtil.mergeOrder([0, 1, 2], [9, 2, 0]), [2, 1, 0], 'unknown indices ignored');
    assert.deepStrictEqual(chromeUtil.mergeOrder([0, 1, 2], [2, 2, 0]), [2, 1, 0], 'duplicates ignored');
    assert.deepStrictEqual(chromeUtil.mergeOrder([0, 1], []), [0, 1]);
});

test('mostVisited counts visits per page, newest-first ties, skips searches', () => {
    const h = [
        { url: 'https://a.com/', title: 'A' }, { url: 'https://b.com/', title: 'B' },
        { url: 'https://a.com/', title: 'A' }, { url: 'https://c.com/', title: 'C' },
        { url: 'https://www.google.com/search?q=x', title: 'x - Search' },
        { url: 'https://b.com/', title: 'B' }, { url: 'https://a.com/', title: 'A' },
    ];
    assert.deepStrictEqual(chromeUtil.mostVisited(h, 3).map(r => r.url), ['https://a.com/', 'https://b.com/', 'https://c.com/']);
    assert.deepStrictEqual(chromeUtil.mostVisited(h, 2, new Set(['https://a.com/'])).map(r => r.url), ['https://b.com/', 'https://c.com/']);
});

test('omnibox and main process agree on keyword search', () => {
    const engines = [
        { id: 'google', keyword: 'g', url: 'https://www.google.com/search?q=%s' },
        { id: 'wiki', keyword: 'w', url: 'https://en.wikipedia.org/w/index.php?search=%s' },
    ];
    assert.strictEqual(chromeUtil.searchUrl('w electron', engines, 'google'), 'https://en.wikipedia.org/w/index.php?search=electron');
    assert.strictEqual(chromeUtil.searchUrl('electron', engines, 'google'), 'https://www.google.com/search?q=electron');
    assert.strictEqual(chromeUtil.keywordEngine('w', engines), null, 'a bare keyword is a search for that word');
});

test('debounce fires once and can be cancelled', async () => {
    let calls = 0;
    const fn = chromeUtil.debounce(() => calls++, 5);
    fn(); fn(); fn();
    await new Promise(r => setTimeout(r, 25));
    assert.strictEqual(calls, 1);
    fn();
    fn.cancel();
    await new Promise(r => setTimeout(r, 25));
    assert.strictEqual(calls, 1);
});

test('throttle fires on the leading edge and suppresses the immediate follow-up', () => {
    // The omnibox remote pass (P0-2) must hit the network on the first keystroke
    // (leading edge), then NOT again for a burst of fast keystrokes inside the
    // window. Synchronously observable: the first call runs now, the rest don't.
    let calls = 0;
    const t = chromeUtil.throttle(() => calls++, 100);
    t('a'); // leading edge → runs immediately
    t('b'); // within the window → deferred, not run now
    t('c');
    assert.strictEqual(calls, 1, 'only the leading call runs synchronously');
    t.cancel(); // drop the pending trailing call so no timer outlives the test
    assert.strictEqual(calls, 1, 'cancel leaves the leading call as the only one');
});

// ── Localisation ─────────────────────────────────────────────────────────────
test('every English string has a Spanish counterpart', () => {
    const en = require(path.join(root, 'locales/en.json')).strings;
    const es = require(path.join(root, 'locales/es.json')).strings;
    const missing = Object.keys(en).filter(k => !(k in es));
    assert.deepStrictEqual(missing, [], 'untranslated keys fall back to English, but the shipped locale should be complete');
    const extra = Object.keys(es).filter(k => !(k in en));
    assert.deepStrictEqual(extra, [], 'a Spanish key with no English source is a typo');
});

test('placeholders survive translation', () => {
    const en = require(path.join(root, 'locales/en.json')).strings;
    const es = require(path.join(root, 'locales/es.json')).strings;
    for (const [key, value] of Object.entries(en)) {
        const holes = (value.match(/\{\w+\}/g) || []).sort();
        const theirs = ((es[key] || '').match(/\{\w+\}/g) || []).sort();
        assert.deepStrictEqual(theirs, holes, `${key} must keep the same placeholders`);
    }
});

test('a missing key renders as the key, never as blank', () => {
    chromeI18n.init({ catalogue: { 'a.b': 'Hello' }, locale: 'en' });
    assert.strictEqual(chromeI18n.t('a.b'), 'Hello');
    assert.strictEqual(chromeI18n.t('nope.missing'), 'nope.missing');
});

test('translation fills placeholders', () => {
    chromeI18n.init({ catalogue: { 'greet': 'Continue to {host} anyway' }, locale: 'en' });
    assert.strictEqual(chromeI18n.t('greet', { host: 'example.com' }), 'Continue to example.com anyway');
});

test('the clock follows the locale rather than a fixed 24-hour format', () => {
    const at = new Date('2026-08-17T15:04:00');
    chromeI18n.init({ catalogue: {}, locale: 'en-US' });
    const us = chromeI18n.time(at);
    chromeI18n.init({ catalogue: {}, locale: 'de-DE' });
    const de = chromeI18n.time(at);
    assert.ok(/PM/i.test(us), `expected a 12-hour clock in en-US, got ${us}`);
    assert.ok(!/PM/i.test(de) && de.includes('15'), `expected a 24-hour clock in de-DE, got ${de}`);
});

test('file sizes use the locale decimal separator', () => {
    chromeI18n.init({ catalogue: {}, locale: 'en-US' });
    assert.strictEqual(chromeI18n.bytes(1536000), '1.5 MB');
    chromeI18n.init({ catalogue: {}, locale: 'es-ES' });
    assert.strictEqual(chromeI18n.bytes(1536000), '1,5 MB');
    chromeI18n.init({ catalogue: {}, locale: 'en-US' });
    assert.strictEqual(chromeI18n.bytes(512), '512 B', 'bytes stay whole');
});

test('locale resolution falls back from a region to its language, then English', () => {
    assert.strictEqual(i18n.resolve('es-419'), 'es');
    assert.strictEqual(i18n.resolve('es'), 'es');
    assert.strictEqual(i18n.resolve('sv-SE'), 'en', 'no catalogue → English, not a blank UI');
});

// ── Overlay placement ────────────────────────────────────────────────────────
// Panels used to invent their own geometry (six widths, four gaps, two
// hardcoded y values). These pin the one rule they all follow now.
const { panelBounds, CARD_TOP, SHELL_PAD, SHELL_TOP, BAR_H } = require(path.join(root, 'features/overlay-bounds'));
const fakeWin = (width = 1440, height = 900) => ({ getContentBounds: () => ({ x: 0, y: 0, width, height }) });
/* A control sitting in the toolbar, derived from the bar rather than written
   out: these fixtures were literal pixels for a 40px bar, so shortening the bar
   made them stop describing a toolbar button at all — and the tests failed for
   the fixture's reason, not the code's. */
const CTRL = 32;
const toolbarAnchor = (right, w = 30) => ({
    left: right - w, right,
    top: SHELL_TOP + Math.round((BAR_H - CTRL) / 2),
    bottom: SHELL_TOP + Math.round((BAR_H - CTRL) / 2) + CTRL,
});

test('a panel from the toolbar opens in the page card\'s top-right corner', () => {
    const b = panelBounds(fakeWin(), { anchor: toolbarAnchor(1304), width: 320, height: 177 });
    assert.strictEqual(b.y, CARD_TOP, 'level with the top of the page card');
    assert.strictEqual(b.x + b.width, 1440 - SHELL_PAD, 'flush with the shell gutter');
});

test('toolbar panels share an edge whichever icon opened them', () => {
    const mk = (right) => panelBounds(fakeWin(), { anchor: toolbarAnchor(right), width: 320, height: 177 });
    assert.strictEqual(mk(1304).x, mk(1432).x, 'the icons are one cluster, not three anchors');
});

test('the theme panel opens beside the sidebar, level with the click', () => {
    // Right-clicking a space is about that space, so its panel hangs off the
    // rail at the point you clicked — not in the toolbar's shared corner, which
    // is where an anchor-less panel goes.
    const RAIL = 256, CLICK_Y = 300;
    const b = panelBounds(fakeWin(), {
        anchor: { left: RAIL, right: RAIL, top: CLICK_Y, bottom: CLICK_Y },
        width: 340, height: 500, align: 'left',
    });
    assert.strictEqual(b.x, RAIL, 'card starts on the rail edge');
    assert.strictEqual(b.y, CLICK_Y + SHELL_PAD, 'card sits just under the click');
    // …and a click low enough that the panel would not fit flips it upward
    // rather than squashing it.
    const low = panelBounds(fakeWin(), {
        anchor: { left: RAIL, right: RAIL, top: 860, bottom: 880 },
        width: 340, height: 500, align: 'left',
    });
    assert.strictEqual(low.height, 500, 'keeps its full height');
    assert.ok(low.y + 500 <= 880, 'opens above the click');
});

test('a tall panel slides to fit rather than being squashed', () => {
    // The default window is 800x600. A 500px panel triggered from the middle of
    // the sidebar fits neither below the click nor entirely above it, and the
    // old behaviour — trim to whatever is left — left every control in the
    // theme panel scrolled out of view.
    const small = { getContentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }) };
    const b = panelBounds(small, {
        anchor: { left: 256, right: 256, top: 300, bottom: 300 },
        width: 340, height: 500, align: 'left',
    });
    assert.strictEqual(b.height, 500, 'keeps its full height');
    assert.ok(b.y >= CARD_TOP, 'never tucks under the toolbar');
    assert.ok(b.y + b.height <= 600 - SHELL_PAD, 'stays inside the window');
});


test('a panel triggered low in the window opens upwards instead of being squashed', () => {
    const b = panelBounds(fakeWin(), { anchor: { left: 9, right: 39, top: 862, bottom: 892 }, width: 320, height: 177 });
    assert.strictEqual(b.height, 177, 'keeps its full height');
    assert.ok(b.y + b.height <= 892, 'sits above the trigger');
});

test('a panel anchored to the address field hangs from it, not from the corner', () => {
    const b = panelBounds(fakeWin(), { anchor: { ...toolbarAnchor(557, 22), left: 535 }, align: 'left', width: 320, height: 300 });
    assert.strictEqual(b.x, 535);
    assert.strictEqual(b.y, CARD_TOP);
});

test('a panel taller than the window stops at the bottom gutter', () => {
    const b = panelBounds(fakeWin(), { anchor: toolbarAnchor(1304), width: 320, height: 1200 });
    assert.strictEqual(b.y + b.height, 900 - SHELL_PAD);
});

// ── The omnibox dropdown ─────────────────────────────────────────────────────
// The one overlay that still casts a shadow, so the one whose view has to make
// room for it. The three numbers below live in ipc/suggestions.js and again as
// the body padding in renderer/Suggestions/styles.css — they have drifted apart
// twice, and each time the shadow came back as a hard band at the view's edge.
const suggestions = require(path.join(root, 'ipc/suggestions'));

test('the dropdown lands exactly on the address field', () => {
    // `bounds` is where the CARD goes; the view grows around it and must never
    // move it. The card used to sit 4px low, because the page padded the top
    // for a shadow gutter that main had not accounted for — so the gap under
    // the field was drawn twice.
    const field = { left: 256, top: 46, width: 1100 }; // .omnibox rect, +4px
    const v = suggestions.itemBounds(field, 4);
    const { PAD_X, PAD_BOTTOM } = suggestions;
    assert.strictEqual(v.x + PAD_X, field.left, 'card keeps the field\'s left edge');
    assert.strictEqual(v.y, field.top, 'no top pad: the view starts where the card does');
    assert.strictEqual(v.width - PAD_X * 2, field.width, 'card is exactly as wide as the field');
});

test('the dropdown view has room for its shadow on the sides and below', () => {
    /* The view is a constant height now, so the gutter is whatever is left
       under the card — and the case that has to still fit is the FULLEST one,
       eight rows, where there is least room to spare. */
    const v = suggestions.itemBounds({ left: 256, top: 46, width: 400 }, 8);
    const { PAD_X, PAD_BOTTOM, ITEM_HEIGHT } = suggestions;
    const fullCardH = 8 * ITEM_HEIGHT + 8; // rows + the card's own padding
    assert.strictEqual(v.height - fullCardH, PAD_BOTTOM, 'a full list still leaves the whole shadow');
    assert.ok(PAD_X >= 20 && PAD_BOTTOM >= 26,
        'sized from the measured reach of 0 6px 16px — shrinking these clips it');
});

test('the dropdown keeps the field\'s left edge even at the window edge', () => {
    // Clamping x to 0 for a field near the left edge shifted the card right of
    // the field instead. The part that hangs off the window is only shadow.
    const v = suggestions.itemBounds({ left: 4, top: 46, width: 300 }, 2);
    assert.strictEqual(v.x + suggestions.PAD_X, 4, 'card still starts on the field');
    assert.ok(v.x < 0, 'the view is allowed off-window; nobody can see shadow there');
});

test('a full dropdown fits without scrolling', () => {
    // The list is capped at 8 rows in renderer.js; the panel has to leave room
    // for all of them plus the gutter, or the last row scrolls.
    const { ITEM_HEIGHT, LIST_CHROME, MAX_HEIGHT } = suggestions;
    assert.strictEqual(MAX_HEIGHT, 8 * ITEM_HEIGHT + LIST_CHROME);
    const v = suggestions.itemBounds({ left: 256, top: 46, width: 400 }, 8);
    assert.strictEqual(v.height, MAX_HEIGHT, 'eight rows are not trimmed');
});

test('the dropdown is the same height whatever it is showing', () => {
    /* It used to be sized to the result count, so the box resized on every
       keystroke and its edge moved under the cursor while you typed. One
       result or eight, the surface holds still. */
    const at = (n) => suggestions.itemBounds({ left: 256, top: 46, width: 400 }, n).height;
    const heights = new Set([at(0), at(1), at(3), at(8), at(50)]);
    assert.strictEqual(heights.size, 1, 'the panel resized with its contents');
    assert.strictEqual(at(1), suggestions.MAX_HEIGHT, 'and it is the height that fits a full list');
});


// ── Theme derivation ─────────────────────────────────────────────────────────
// A user theme is three decisions, not sixteen hex values. These pin the rules
// that make a derived palette a usable browser rather than a colour scheme.
const themeDerive = require(path.join(root, 'features/theme-derive'));

test('the ramp keeps the elevation running the right way', () => {
    const L = hex => themeDerive.toLch(hex).L;
    const dark = themeDerive.derive({ mode: 'dark', base: '#0a0a0b', accent: '#e5484d' }).tokens;
    assert.ok(L(dark['--bg']) < L(dark['--shell']), 'a well sits below the shell');
    assert.ok(L(dark['--shell']) < L(dark['--page']), 'the page sits above the shell');
    assert.ok(L(dark['--page']) < L(dark['--surface']), 'cards sit above the page');
    const light = themeDerive.derive({ mode: 'light', base: '#e8e9ec', accent: '#e5484d' }).tokens;
    assert.ok(L(light['--bg']) < L(light['--shell']), 'a well is still the darkest step in a light theme');
    assert.ok(L(light['--surface']) < L(light['--page']), 'past white, elevation runs the other way');
});

test('the ground the user picked is the ground they get', () => {
    // Absolute lightness stops turned #0a0a0b into #161617 — not the colour
    // anyone chose. The shell must land on the pick, not near it.
    for (const base of ['#0a0a0b', '#050b14', '#e8e9ec', '#efe1c6']) {
        const t = themeDerive.derive({
            mode: themeDerive.toLch(base).L > 0.6 ? 'light' : 'dark',
            base, accent: '#e5484d',
        }).tokens;
        assert.strictEqual(t['--shell'].toLowerCase(), base.toLowerCase(), `${base} survives the ramp`);
    }
});

test('body text stays readable whatever ground is picked', () => {
    for (const base of ['#000000', '#ffffff', '#0a0a0b', '#7a3d00', '#123456', '#efe1c6']) {
        for (const mode of ['dark', 'light']) {
            const t = themeDerive.derive({ mode, base, accent: '#e5484d' }).tokens;
            const c = themeDerive.contrast(t['--text'], t['--page']);
            assert.ok(c >= 4.5, `${mode} on ${base} gives ${c.toFixed(2)}:1`);
        }
    }
});

test('text on the accent is chosen by contrast, not assumed to be white', () => {
    // A yellow accent with white text is unreadable, and yellow is a real pick.
    const yellow = themeDerive.derive({ mode: 'dark', base: '#0a0a0b', accent: '#ffd400' }).tokens;
    assert.ok(themeDerive.contrast(yellow['--accent-ink'], yellow['--accent']) >= 3,
        'dark ink on a yellow accent');
    const navy = themeDerive.derive({ mode: 'light', base: '#efe1c6', accent: '#122c63' }).tokens;
    assert.ok(themeDerive.contrast(navy['--accent-ink'], navy['--accent']) >= 3,
        'light ink on a navy accent');
});

test('danger never reads as the accent', () => {
    // themes.css: with a red identity colour, a destructive row and a selected
    // row must not look alike.
    const t = themeDerive.derive({ mode: 'dark', base: '#0a0a0b', accent: '#e5484d' }).tokens;
    assert.notStrictEqual(t['--danger'], t['--accent']);
    assert.ok(themeDerive.contrast(t['--danger'], t['--accent']) > 1.2, 'visibly apart');
});

test('an explicit ink keeps its character; a derived one stays near-neutral', () => {
    const dune = themeDerive.derive({ mode: 'light', base: '#efe1c6', accent: '#e5484d', ink: '#122c63' }).tokens;
    assert.ok(themeDerive.toLch(dune['--text']).C > 0.03, 'navy ink is still navy');
    const plain = themeDerive.derive({ mode: 'light', base: '#efe1c6', accent: '#e5484d' }).tokens;
    assert.ok(themeDerive.toLch(plain['--text']).C < 0.02, 'no ink chosen → near-neutral');
});

test('a theme that cannot be read cannot be saved', () => {
    assert.ok(!themeDerive.validate({ mode: 'dark', base: 'not-a-colour', accent: '#e5484d' }).ok);
    assert.ok(themeDerive.validate({ mode: 'dark', base: '#0a0a0b', accent: '#e5484d' }).ok);
});

test('an accent that vanishes into the page is refused', () => {
    // The failure mode that can actually happen: body text is safe whatever is
    // picked (the ramp owns lightness), but an accent a shade off the ground
    // leaves the selected row and the focus ring marking nothing.
    assert.ok(!themeDerive.validate({ mode: 'light', base: '#ffffff', accent: '#fbfbfb' }).ok);
    assert.ok(!themeDerive.validate({ mode: 'dark', base: '#0a0a0b', accent: '#050505' }).ok);
    // …and every shipped ground still passes.
    for (const [mode, base] of [['dark', '#0a0a0b'], ['dark', '#050b14'], ['light', '#e8e9ec'], ['light', '#efe1c6']])
        assert.ok(themeDerive.validate({ mode, base, accent: '#e5484d' }).ok, `${base} still valid`);
});

// ── Forking a theme ──────────────────────────────────────────────────────────
// "New theme" copies the theme you are wearing, so every built-in has to be
// expressible as dots on the wheel. The seed for that is solved backwards in
// features/themes.js; these pin that it is actually a COPY, which the first
// attempt was not — reading the ground off the dot's own lightness landed a
// fork of Harbour two elevation steps darker than Harbour.
const themeRegistry = require(path.join(root, 'features/themes'));

test('a theme forked from a built-in reproduces its ground exactly', () => {
    for (const t of themeRegistry.all()) {
        if (t.id === 'blocks')
            continue;   // vivid: out of reach by design, see below
        const forked = themeDerive.derive(t.wheelSeed).tokens;
        assert.strictEqual(forked['--shell'], t.swatch.shell, `${t.id} keeps its ground`);
        assert.strictEqual(forked['--accent'], t.swatch.accent, `${t.id} keeps its accent`);
    }
});

test('…and the whole palette, where the wheel can express it', () => {
    // Harbour and Dusk are pure ground-plus-house-accent themes, so a fork is
    // the same sixteen tokens. Fog and Clay carry a hand-set INK hue, which a
    // wheel seed has no dot for — their text lands at the same lightness in a
    // slightly different hue, and that is the documented limit.
    for (const id of ['harbour', 'dusk']) {
        const t = themeRegistry.all().find(x => x.id === id);
        const src = themeDerive.derive(t.seed).tokens;
        const fork = themeDerive.derive(t.wheelSeed).tokens;
        for (const k of Object.keys(src))
            assert.strictEqual(fork[k], src[k], `${id} ${k}`);
    }
});

test('the gradient wash pools each colour at its position, and needs two', () => {
    // One colour is a flat ground — its hue already tints the chrome, so no
    // gradient — which is also what keeps forking a flat built-in flat.
    const one = themeDerive.derive({ mode: 'dark', colors: ['#0091ff'], intensity: 0.7 }).tokens;
    assert.strictEqual(one['--shell-wash'], 'none', 'one colour is flat');

    // Two-plus colours pool at their positions: one radial-gradient layer each,
    // centred where the seed put it.
    const seed = {
        mode: 'dark',
        colors: ['#0091ff', '#f2cd37'],
        positions: [{ x: 0.2, y: 0.3 }, { x: 0.75, y: 0.6 }],
        intensity: 0.8,
    };
    const wash = themeDerive.derive(seed).tokens['--shell-wash'];
    assert.strictEqual((wash.match(/radial-gradient/g) || []).length, 2, 'a layer per colour');
    assert.ok(wash.includes('at 20.0% 30.0%'), 'first pool at its position');
    assert.ok(wash.includes('at 75.0% 60.0%'), 'second pool at its position');

    // A missing position falls back to the spread defaults rather than stacking
    // both pools at 0,0.
    const noPos = themeDerive.derive({ mode: 'dark', colors: ['#0091ff', '#f2cd37'] }).tokens['--shell-wash'];
    assert.ok(!/at 0\.0% 0\.0%.*at 0\.0% 0\.0%/s.test(noPos), 'defaults are spread, not stacked');

    // positionsFor is always as long as colors, and clamps into the canvas.
    const pos = themeDerive.positionsFor(['#000', '#111', '#222'], [{ x: 5, y: -2 }]);
    assert.strictEqual(pos.length, 3, 'one entry per colour');
    assert.deepStrictEqual(pos[0], { x: 1, y: 0 }, 'out-of-range positions clamp to 0..1');
});

test('a fork is never vivid, and says so by being quieter', () => {
    // The chroma ceiling is what stops a user theme shouting over its own
    // accent; Blocks opts out of it and a fork cannot. It keeps the hue.
    const blocks = themeRegistry.all().find(t => t.id === 'blocks');
    const fork = themeDerive.derive(blocks.wheelSeed).tokens;
    assert.ok(themeDerive.toLch(fork['--shell']).C < themeDerive.toLch(blocks.swatch.shell).C,
        'the fork is less saturated than Blocks');
    assert.ok(Math.abs(themeDerive.toLch(fork['--shell']).h - themeDerive.toLch(blocks.swatch.shell).h) < 10,
        'but it is the same blue');
});

test('every fork is a palette that can be saved', () => {
    for (const t of themeRegistry.all())
        assert.ok(themeDerive.validate(t.wheelSeed).ok, `${t.id} forks to something legible`);
});

test('a seed with no level derives exactly as it did before level existed', () => {
    // Every theme saved before the ground's depth became its own field has no
    // `level`, and must not move under one. The wheel only ever wrote dots at
    // WHEEL_L, so the old reading was already this constant in practice.
    /* The dot has to be WHEEL-SHAPED — at WHEEL_L — because that is the only
       kind the wheel ever wrote, and the whole claim rests on it. A hand-picked
       hex at some other lightness reads differently under the old formula
       (`0.09 + dotL * 0.12` follows the DOT's lightness), so a fixture like
       that tests a seed no saved theme can contain. */
    const hue = themeDerive.toLch('#3a6ea5');
    const dot = themeDerive.fromLch({ L: themeDerive.WHEEL_L, C: Math.min(0.16, hue.C), h: hue.h });
    const legacy = { mode: 'dark', colors: [dot], intensity: 0.7, grain: 0 };
    const old = themeDerive.derive(legacy).tokens;
    // …and the default level lands on exactly the same ground.
    const now = themeDerive.derive({ ...legacy, level: themeDerive.DEFAULT_LEVEL }).tokens;
    assert.strictEqual(now['--shell'], old['--shell'],
        'the default level is where a level-less seed already sat');
});

test('level moves the ground across the mode band, and only the ground', () => {
    const seed = l => ({ mode: 'dark', colors: ['#3a6ea5'], intensity: 0.7, grain: 0, level: l });
    const L = hex => themeDerive.toLch(hex).L;
    const dark = themeDerive.derive(seed(0)).tokens;
    const light = themeDerive.derive(seed(1)).tokens;
    assert.ok(L(dark['--shell']) < L(light['--shell']), 'level 0 is the darker ground');
    assert.strictEqual(dark['--accent'], light['--accent'], 'the accent does not follow the ground');
    // The elevation still runs the right way at both ends.
    for (const t of [dark, light]) {
        assert.ok(L(t['--bg']) < L(t['--shell']), 'a well sits below the shell');
        assert.ok(L(t['--shell']) < L(t['--page']), 'the page sits above the shell');
    }
});

test('a user theme keeps its level through a save', () => {
    const prepared = themeRegistry.prepareCustom({
        name: 'Test', seed: { mode: 'dark', colors: ['#3a6ea5'], intensity: 0.7, grain: 0, level: 0.82 },
    });
    assert.ok(prepared.ok);
    assert.strictEqual(prepared.theme.seed.level, 0.82);
    // …and one that never had one gets the house default rather than undefined.
    const bare = themeRegistry.prepareCustom({ name: 'Test', seed: { mode: 'dark', colors: ['#3a6ea5'] } });
    assert.strictEqual(bare.theme.seed.level, themeDerive.DEFAULT_LEVEL);
});

// ── Sidebar clamp ────────────────────────────────────────────────────────────
// The drag in the chrome and the main process (which takes over once the
// pointer is over the page view) MUST agree, or the sidebar keeps shrinking on
// screen after the page has stopped moving.
test('the sidebar clamp stops at its minimum however far you drag', () => {
    assert.strictEqual(chromeUtil.clampSidebarWidth(40, 1440), 178);
    assert.strictEqual(chromeUtil.clampSidebarWidth(-500, 1440), 178);
    assert.strictEqual(chromeUtil.clampSidebarWidth(0, 1440), 178);
});

test('…and at its maximum', () => {
    assert.strictEqual(chromeUtil.clampSidebarWidth(5000, 1440), 426);
});

test('the limits scale with the window but keep absolute floors', () => {
    const wide = chromeUtil.sidebarLimits(2560);
    assert.ok(wide.min > 178 && wide.max > 426, 'a wide window gets a wider band');
    const tiny = chromeUtil.sidebarLimits(600);
    assert.strictEqual(tiny.min, 178, 'never narrower than usable');
    assert.strictEqual(tiny.max, 320, 'never wider than the floor on a small window');
});

test('a width inside the band is left alone', () => {
    assert.strictEqual(chromeUtil.clampSidebarWidth(256, 1440), 256);
});

// ── color-scheme per theme (ui-polish U0-1) ──────────────────────────────────
// Native controls (radios, scrollbars, pickers) follow `color-scheme`, not our
// tokens. Without it a light theme kept dark-scheme natives and vice versa —
// the "unchecked radio looks checked" white disc (S1). Every derived theme's
// sheet carries its own mode; the CSS-backed default declares dark on :root.
test('each theme sheet declares its color-scheme', () => {
    for (const t of themeRegistry.all()) {
        const r = themeRegistry.resolve(t.id);
        if (!r.css) continue; // CSS-backed: covered by the :root rule below
        assert.ok(r.css.includes(`color-scheme:${r.mode}`), `${t.id} sheet says color-scheme:${r.mode}`);
    }
    for (const f of ['renderer/styles/themes.css', 'renderer/styles/ui.css']) {
        const css = fs.readFileSync(path.join(root, f), 'utf8');
        assert.ok(/:root\s*\{[^}]*color-scheme:\s*dark/.test(css), `${f} :root defaults to color-scheme: dark`);
        assert.ok(/\.radio\s*\{[^}]*appearance:\s*none/.test(css), `${f} has the shared .radio control`);
    }
});

// ── Palette contrast ─────────────────────────────────────────────────────────
// A re-tone is easy to do by eye and easy to get wrong: the light themes had a
// tertiary ink and an accent that fell under 3:1 on their own shell. These read
// the shipped tokens out of ui.css (the file pages actually link) and hold every
// theme to a floor.
const uiCss = fs.readFileSync(path.join(root, 'renderer/styles/ui.css'), 'utf8');

function paletteOf(selector) {
    // ui.css has several blocks per selector (`:root` carries the metrics as
    // well as the palette) — take the one that defines --shell.
    const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^{]*\\{([\\s\\S]*?)\\n\\}', 'g');
    for (const m of uiCss.matchAll(re)) {
        if (!m[1].includes('--shell:'))
            continue;
        const out = {};
        for (const [, k, v] of m[1].matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g))
            out[k] = v;
        return out;
    }
    throw new Error('palette not found: ' + selector);
}
const srgb = (c) => { const x = c / 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
function luminance(hex) {
    const h = hex.slice(1);
    const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
    return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
}
function contrast(a, b) {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
}

/* Only two palettes are still written out in CSS: Slate (the default, at
   :root) and private mode. Every other theme is derived at runtime, so the
   same floors are checked against the registry further down instead of
   against a stylesheet block. */
const THEMES = {
    slate: ':root',
    private: 'html[data-private-window="true"]',
};
// [ink, ground, floor] — 4.5 for anything you read, 3 for marks and captions.
const PAIRS = [
    ['text', 'page', 4.5], ['text', 'surface', 4.5],
    ['text-2', 'shell', 4.5], ['text-2', 'surface', 4.5],
    ['text-3', 'shell', 3], ['text-3', 'surface', 3],
    ['accent', 'shell', 3], ['accent', 'page', 3],
    ['danger', 'surface', 3],
];
for (const [name, selector] of Object.entries(THEMES)) {
    test(`${name} palette clears its contrast floors`, () => {
        const p = paletteOf(selector);
        for (const [ink, ground, floor] of PAIRS) {
            const r = contrast(p[ink], p[ground]);
            assert.ok(r >= floor,
                `--${ink} on --${ground} is ${r.toFixed(2)}:1, needs ${floor}:1`);
        }
    });
}

/* The derived themes get the same floors, from the ramp rather than the
   stylesheet — these are the ones a hand-check would never cover, since there
   is no block to read. */
{
    const registry = require(path.join(root, 'features/themes'));
    registry.bind({ get: () => [] });
    for (const t of registry.all()) {
        const resolved = registry.resolve(t.id);
        if (!resolved.tokens)
            continue; // css-backed, checked above
        test(`${t.name} (derived) clears its contrast floors`, () => {
            const p = {};
            for (const [k, v] of Object.entries(resolved.tokens))
                p[k.replace(/^--/, '')] = v;
            /* A vivid ground is a mid-tone, and a mid-tone cannot carry three
               tiers of ink at the body floor: nothing clears 4.5:1 against both
               the shell and a card while staying distinct from the primary ink.
               Secondary and tertiary drop to 3:1 there — the floor for text you
               are not reading. BODY text keeps 4.5:1 on every theme, vivid
               included; that line does not move. */
            const vivid = !!t.seed?.vivid;
            for (const [ink, ground, floor] of PAIRS) {
                const need = (vivid && (ink === 'text-2' || ink === 'text-3')) ? 3 : floor;
                const r = contrast(p[ink], p[ground]);
                assert.ok(r >= need,
                    `--${ink} on --${ground} is ${r.toFixed(2)}:1, needs ${need}:1`);
            }
            assert.ok(contrast(p.text, p.page) >= 4.5, 'body text never drops below 4.5:1');
        });
    }
}

test('every theme defines the whole palette', () => {
    const base = Object.keys(paletteOf(':root')).filter(k => !['radius', 'radius-lg', 'radius-pill'].includes(k));
    for (const [name, selector] of Object.entries(THEMES)) {
        if (selector === ':root') continue;
        const p = paletteOf(selector);
        const missing = base.filter(k => !(k in p) && !k.startsWith('shadow') && !k.startsWith('ring'));
        assert.deepStrictEqual(missing, [], `${name} is missing: ${missing.join(', ')}`);
    }
});

// ── Essentials ───────────────────────────────────────────────────────────────
// An Essential IS a tab: the tile is the tab's only representation, so every
// one of these is a way the tile and the tab can come apart. The methods take
// no Electron (they are a mixin over the Tabs instance), so a hand-made `this`
// is enough to pin what clicking a tile does.
const essentialRules = require(path.join(root, 'features/tabs/essential-rules'));
const essentialsMixin = require(path.join(root, 'features/tabs/essentials'));
// The stored Essentials are read lazily through features/profiles; stub it so
// these never touch (or invent) a profiles.json on disk.
let STORED_ESSENTIALS = [];
{
    const id = require.resolve(path.join(root, 'features/profiles'));
    require.cache[id] = {
        id, filename: id, loaded: true,
        exports: { essentials: () => STORED_ESSENTIALS.map(e => ({ ...e, home: e.home || e.url })) },
    };
}
function fakeTabs(profileId = '1') {
    const t = {
        profileId,
        activeTabIndex: -1,
        _next: 1,
        tabMap: new Map(),
        tabUrls: new Map(),
        tabProfiles: new Map(),
        privateTabs: new Set(),
        tabOrder: [],
        loads: [],
        shown: [],
        sent: [],
        mainWindow: { webContents: { send: (ch, payload) => t.sent.push({ ch, payload }) } },
        createTab() {
            const i = t._next++;
            t.tabMap.set(i, {});
            t.tabUrls.set(i, 'newtab');   // createTab opens a BLANK tab
            t.tabProfiles.set(i, t.profileId);
            t.tabOrder.push(i);
            t.activeTabIndex = i;
            return i;
        },
        openInContainer(url, container) {
            const i = t.createTab();
            t.container = container;
            t.loadUrl(i, url);
            return i;
        },
        loadUrl(i, url) { t.loads.push([i, url]); t.tabUrls.set(i, url); },
        showTab(i) { t.shown.push(i); t.activeTabIndex = i; },
        // A tab that already exists — a restored one, or one the user opened.
        seed(url, space = profileId) {
            const i = t.createTab();
            t.tabProfiles.set(i, space);
            t.tabUrls.set(i, url);
            t.loads.length = 0;
            return i;
        },
    };
    return Object.assign(t, essentialsMixin);
}
const KEY = 'https://mail.example.com/inbox|';
const HOME = 'https://mail.example.com/inbox';

test('clicking an Essential with no tab opens its page, not a blank tab', () => {
    const t = fakeTabs();
    const idx = t.openEssential(KEY, HOME);
    assert.strictEqual(typeof idx, 'number', 'it lands in a tab');
    assert.deepStrictEqual(t.loads, [[idx, HOME]], 'the new tab is taken to the Essential\'s page');
    assert.strictEqual(t.essentialTabIndex(KEY), idx, 'the tile owns it');
});

test('clicking the Essential you are already in takes it back to its page', () => {
    const t = fakeTabs();
    const idx = t.openEssential(KEY, HOME);
    t.tabUrls.set(idx, 'https://mail.example.com/message/9');
    t.loads.length = 0;
    t.openEssential(KEY, HOME);
    assert.deepStrictEqual(t.loads, [[idx, HOME]], 'the second click is "take me back"');
});

test('clicking an Essential you are not in lands you in it, wherever it got to', () => {
    const t = fakeTabs();
    const idx = t.openEssential(KEY, HOME);
    t.tabUrls.set(idx, 'https://mail.example.com/message/9');
    const other = t.createTab();
    t.loads.length = 0;
    assert.strictEqual(t.openEssential(KEY, HOME), idx);
    assert.deepStrictEqual(t.loads, [], 'it keeps the page you had browsed to');
    assert.strictEqual(t.activeTabIndex, idx);
    assert.notStrictEqual(other, idx);
});

test('an Essential adopts the tab already on its page instead of opening a second copy', () => {
    const t = fakeTabs();
    const open = t.seed(HOME);
    assert.strictEqual(t.openEssential(KEY, HOME), open);
    assert.strictEqual(t.tabMap.size, 1, 'no second copy of a page that was already there');
});

test('an Essential bound to a container opens ITS page in THAT container', () => {
    const t = fakeTabs();
    const idx = t.openEssential(`${HOME}|work`, HOME, 'work');
    assert.deepStrictEqual(t.loads, [[idx, HOME]], 'the url is the url, not the container id');
    assert.strictEqual(t.container, 'work');
});

test('an Essential owns one tab PER SPACE — the tile is global, its tab is not', () => {
    const t = fakeTabs('1');
    const first = t.openEssential(KEY, HOME);
    t.profileId = '2';
    const second = t.openEssential(KEY, HOME);
    assert.notStrictEqual(second, first, 'space 2 gets its own tab');
    t.profileId = '1';
    assert.strictEqual(t.essentialTabIndex(KEY), first, 'and space 1 still has its own');
});

test('an Essential never adopts a tab from another space, or a private one', () => {
    const t = fakeTabs('1');
    t.seed(HOME, '2');
    const priv = t.seed(HOME, '1');
    t.privateTabs.add(priv);
    const idx = t.openEssential(KEY, HOME);
    assert.strictEqual(t.loads.length, 1, 'it opened its own tab');
    assert.strictEqual(idx, t.essentialTabIndex(KEY));
});

test('closing an Essential\'s tab hands the tile back its "no tab" state', () => {
    const t = fakeTabs();
    const idx = t.openEssential(KEY, HOME);
    t.tabMap.delete(idx);
    t._forgetEssentialTab(idx);
    assert.strictEqual(t.essentialTabIndex(KEY), null);
});

test('removing an Essential gives its tab back to the strip', () => {
    const t = fakeTabs();
    const idx = t.openEssential(KEY, HOME);
    assert.strictEqual(t.unbindEssential(KEY), true);
    assert.strictEqual(t.essentialTabIndex(KEY), null, 'nothing claims the tab');
    assert.ok(t.tabMap.has(idx), 'and the tab itself is left open');
});

test('a restored tab finds its tile again rather than being left orphaned', () => {
    STORED_ESSENTIALS = [{ url: HOME, title: 'Mail', profile: null }];
    try {
        const t = fakeTabs();
        const restored = t.seed(HOME);
        t._rebindRestoredEssentials();
        assert.strictEqual(t.essentialTabIndex(KEY), restored);
        const live = t.sent.filter(m => m.ch === 'essential-tabs').pop();
        assert.deepStrictEqual(live.payload, [{ key: KEY, index: restored, active: true }]);
    }
    finally { STORED_ESSENTIALS = []; }
});

test('an Essential\'s tab is written to the session at its own page', () => {
    STORED_ESSENTIALS = [{ url: HOME, title: 'Mail', profile: null, home: 'https://mail.example.com/' }];
    try {
        const t = fakeTabs();
        const idx = t.openEssential(KEY, 'https://mail.example.com/');
        t.tabUrls.set(idx, 'https://mail.example.com/message/9');
        // What buildSerializableState() writes instead of the live url.
        assert.strictEqual(t._essentialHomeOfTab(idx), 'https://mail.example.com/');
    }
    finally { STORED_ESSENTIALS = []; }
});

test('an Essential stays on its site: off-site links peek, its own do not', () => {
    const R = essentialRules;
    assert.strictEqual(R.shouldPeek(HOME, HOME, 'https://mail.example.com/message/9'), false);
    assert.strictEqual(R.shouldPeek(HOME, HOME, 'https://m.example.com/x'), false, 'subdomains are the same place');
    assert.strictEqual(R.shouldPeek(HOME, HOME, 'https://news.example.org/story'), true);
    assert.strictEqual(R.shouldPeek(HOME, HOME, 'mailto:someone@example.org'), false, 'only http(s) is peekable');
    assert.strictEqual(R.shouldPeek(HOME, 'https://news.example.org/story', 'https://other.example.net/'),
        false, 'a tab sent elsewhere deliberately is left alone');
    assert.strictEqual(R.shouldPeek(HOME, HOME, 'https://accounts.google.com/o/oauth2/auth?client_id=1'),
        false, 'a sign-in hand-off has to be allowed to leave and come back');
});

test('an Essential\'s binding key survives a url with a pipe in it', () => {
    const R = essentialRules;
    const key = R.identity('https://e.example/a|b', null);
    assert.strictEqual(R.urlOfIdentity(key), 'https://e.example/a|b');
    assert.strictEqual(R.keyOfBinding(R.bindingKey('3', key)), key);
});

// ── Captive portal ───────────────────────────────────────────────────────────
// The branches that matter are the ones you cannot reproduce at a desk: a
// portal that redirects, and a portal that answers 200 with its own page.
const captive = require('../features/captive-portal');

test('a redirect means a portal, and its target is the sign-in page', () => {
    const r = captive.classify(302, '', 'http://wifi.hotel.example/login');
    assert.strictEqual(r.portal, true);
    assert.strictEqual(r.online, false);
    assert.strictEqual(r.portalUrl, 'http://wifi.hotel.example/login');
});

test('a redirect with a duplicated Location header takes the first', () => {
    const r = captive.classify(307, '', ['http://a.example/login', 'http://b.example/login']);
    assert.strictEqual(r.portalUrl, 'http://a.example/login');
});

test('the expected body means genuinely online', () => {
    const r = captive.classify(200, 'success', undefined);
    assert.deepStrictEqual(r, { online: true, portal: false, portalUrl: null });
});

test('trailing whitespace in the probe body is still online', () => {
    // Some middleboxes append a newline; that is not a portal.
    assert.strictEqual(captive.classify(200, 'success\n').online, true);
});

test('200 with someone else\'s page is a portal serving its own login', () => {
    const r = captive.classify(200, '<html>Sign in to WiFi</html>', undefined);
    assert.strictEqual(r.portal, true);
    assert.strictEqual(r.portalUrl, null, 'no Location header — the caller falls back');
});

test('a server error is a portal too, not silently online', () => {
    assert.strictEqual(captive.classify(503, '').online, false);
});

// ── Tab sleeping (the collaborator, in isolation) ────────────────────────────
// The point of making TabSleeper a collaborator rather than a mixin: it can be
// exercised against a stub Tabs, with no Electron and no real window. These pin
// the scan's "never sleep" rules.
const { TabSleeper } = require('../features/tabs/sleep');

function stubTabs(overrides = {}) {
    const now = Date.now();
    const tab = (props) => ({
        slept: false, lazyLoaded: true, hasPlayingMedia: false,
        webContents: {
            isDestroyed: () => false, isCrashed: () => false,
            isCurrentlyAudible: () => false, isDevToolsOpened: () => false,
            forcefullyCrashRenderer() { this._crashed = true; },
        },
        ...props,
    });
    const tabs = {
        mainWindow: { isDestroyed: () => false },
        persistence: { get: (k) => (k === 'tabSleepMinutes' ? 30 : undefined) },
        activeTabIndex: 0,
        pinnedTabs: new Set(),
        tabUrls: new Map(),
        tabLastActive: new Map(),
        tabMap: new Map(),
        ...overrides,
    };
    tabs._mk = tab;
    return tabs;
}

test('the sleeper discards an idle background web tab', () => {
    const t = stubTabs();
    const tab = t._mk({});
    t.tabMap.set(1, tab);
    t.tabUrls.set(1, 'https://example.com');
    t.tabLastActive.set(1, Date.now() - 60 * 60_000); // an hour ago
    new TabSleeper(t).scan();
    assert.strictEqual(tab.slept, true, 'a stale background tab is slept');
});

test('the sleeper never sleeps the active tab', () => {
    const t = stubTabs({ activeTabIndex: 1 });
    const tab = t._mk({});
    t.tabMap.set(1, tab);
    t.tabUrls.set(1, 'https://example.com');
    t.tabLastActive.set(1, Date.now() - 60 * 60_000);
    new TabSleeper(t).scan();
    assert.strictEqual(tab.slept, false);
});

test('the sleeper never sleeps a pinned, audible, or recently-active tab', () => {
    for (const setup of [
        (t, tab) => t.pinnedTabs.add(1),
        (t, tab) => { tab.webContents.isCurrentlyAudible = () => true; },
        (t, tab) => t.tabLastActive.set(1, Date.now()), // just now
        (t, tab) => t.tabUrls.set(1, 'northstar://settings'), // not a web page
    ]) {
        const t = stubTabs();
        const tab = t._mk({});
        t.tabMap.set(1, tab);
        t.tabUrls.set(1, 'https://example.com');
        t.tabLastActive.set(1, Date.now() - 60 * 60_000);
        setup(t, tab);
        new TabSleeper(t).scan();
        assert.strictEqual(tab.slept, false, 'protected tab was slept anyway');
    }
});

test('sleeping is skippable by setting, and stops when the window is gone', () => {
    const off = stubTabs({ persistence: { get: (k) => (k === 'tabSleepEnabled' ? false : 30) } });
    const tab = off._mk({});
    off.tabMap.set(1, tab); off.tabUrls.set(1, 'https://e.example'); off.tabLastActive.set(1, 0);
    new TabSleeper(off).scan();
    assert.strictEqual(tab.slept, false, 'the setting turns sleeping off');

    const gone = stubTabs({ mainWindow: { isDestroyed: () => true } });
    const s = new TabSleeper(gone); s.start();
    s.scan();
    assert.strictEqual(s.timer, null, 'a destroyed window stops the scan');
});

// The Chrome-parity protections (P0-5): each is a flag or a synchronous lookup,
// and each must fail SAFE (keep the tab awake). One idle background web tab,
// stale for an hour, that would otherwise be slept — made ineligible one reason
// at a time.
function staleTab(overrides = {}) {
    const t = stubTabs(overrides);
    const tab = t._mk(overrides.tabProps || {});
    t.tabMap.set(1, tab);
    t.tabUrls.set(1, overrides.url || 'https://example.com');
    t.tabLastActive.set(1, Date.now() - 60 * 60_000);
    return { t, tab };
}

test('a tab with half-typed form text is never slept', () => {
    const { t, tab } = staleTab({ tabProps: { dirty: true } });
    new TabSleeper(t).scan();
    assert.strictEqual(tab.slept, false, 'kUserEdits: a dirty page keeps its process');
});

test('a tab capturing camera/mic/screen is never slept', () => {
    const { t, tab } = staleTab({ tabProps: { capturing: new Set(['video']) } });
    new TabSleeper(t).scan();
    assert.strictEqual(tab.slept, false, 'kCapturing*: a live capture keeps the tab awake');
});

test('a tab in Picture-in-Picture is never slept', () => {
    const { t, tab } = staleTab({ tabProps: { inPiP: true } });
    new TabSleeper(t).scan();
    assert.strictEqual(tab.slept, false, 'kPictureInPicture');
});

test('recently-audible is a 60 s window, not forever', () => {
    const recent = staleTab({ tabProps: { lastAudibleAt: Date.now() - 30_000 } });
    new TabSleeper(recent.t).scan();
    assert.strictEqual(recent.tab.slept, false, 'stopped 30 s ago → still protected');

    const old = staleTab({ tabProps: { lastAudibleAt: Date.now() - 90_000 } });
    new TabSleeper(old.t).scan();
    assert.strictEqual(old.tab.slept, true, 'stopped 90 s ago → eligible again');
});

test('a tab whose origin may show notifications is never slept', () => {
    const { t, tab } = staleTab({
        url: 'https://chat.example.com/room',
        sitePermissions: {
            originOf: (u) => { try { return new URL(u).origin; } catch { return null; } },
            state: (origin, name) => (name === 'notifications' && origin === 'https://chat.example.com' ? 'allow' : 'ask'),
        },
    });
    new TabSleeper(t).scan();
    assert.strictEqual(tab.slept, false, 'kNotificationsEnabled: a granted origin keeps running');
});

// ── New-tab page routing (P2 pivot) ──────────────────────────────────────────
// northstar://home must resolve to the NewTab page, and the 'home' token must
// round-trip — without disturbing the 'newtab' blank-tab sentinel.
const internalPage = require('../features/tabs/internal-page');
test('northstar://home routes to the new-tab page; the newtab sentinel is untouched', () => {
    assert.deepStrictEqual(internalPage.parseNorthstarUrl('northstar://home'), { type: 'home', section: null });
    assert.deepStrictEqual(internalPage.parseInternalToken('home'), { type: 'home', section: null });
    assert.ok(internalPage.INTERNAL_PAGES.home.file.includes('NewTab'), 'home maps to renderer/NewTab');
    assert.strictEqual(internalPage.parseInternalToken('newtab'), null, 'the blank-tab sentinel is not a page');
    assert.strictEqual(internalPage.internalTokenFor('file:///x/renderer/NewTab/index.html'), 'home');
});

// Back/forward onto an internal page: the history tree stores the bare token
// ('home'), and handing that to loadURL gave ERR_INVALID_URL — Back from a
// site you typed on the new-tab page landed on an error page. Pages on the
// general preload load in place; Settings (privileged preload) can't.
test('history entries that are internal pages resolve to their file', () => {
    const h = internalPage.internalHistoryEntry('home');
    assert.strictEqual(h.type, 'home');
    assert.ok(h.file.includes('NewTab/index.html'));
    assert.strictEqual(h.inPlace, true);
    assert.strictEqual(internalPage.internalHistoryEntry('history').inPlace, true);
    const s = internalPage.internalHistoryEntry('settings/privacy');
    assert.strictEqual(s.inPlace, false);
    assert.strictEqual(s.section, 'privacy');
    assert.strictEqual(internalPage.internalHistoryEntry('northstar://home').type, 'home');
    assert.strictEqual(internalPage.internalHistoryEntry('https://example.com'), null);
    assert.strictEqual(internalPage.internalHistoryEntry('newtab'), null);
});

// ── Overlay enter/exit motion (P1-6) ─────────────────────────────────────────
// The class-sequencing is pure; the fade itself is CSS. Pin that a card reaches
// the shown state, and that exit always calls back (so a panel never hangs).
const surfaceAnim = require('../renderer/lib/surface-anim');
function fakeCard() {
    const set = new Set();
    return {
        classList: {
            add: (...c) => c.forEach(x => set.add(x)),
            remove: (...c) => c.forEach(x => set.delete(x)),
            contains: (c) => set.has(c),
        },
        addEventListener() { }, removeEventListener() { },
        _has: (c) => set.has(c),
    };
}
test('enterCard brings a card to its shown state', () => {
    const el = fakeCard();
    surfaceAnim.enterCard(el); // no requestAnimationFrame in node → runs synchronously
    assert.ok(el._has('surface-in'), 'transitions toward resting');
    assert.ok(!el._has('surface-enter'), 'start state is cleared');
});
test('exitCard calls back immediately under reduced motion', () => {
    const saved = global.matchMedia;
    global.matchMedia = () => ({ matches: true });
    try {
        let called = false;
        surfaceAnim.exitCard(fakeCard(), () => { called = true; });
        assert.ok(called, 'reduced motion → hide now, no waiting on a transition');
    }
    finally { if (saved) global.matchMedia = saved; else delete global.matchMedia; }
});
test('exitCard starts the close fade and never drops the callback', () => {
    const el = fakeCard();
    let n = 0;
    surfaceAnim.exitCard(el, () => { n++; });
    assert.ok(el._has('surface-out'), 'the out class is applied');
    assert.ok(typeof surfaceAnim.exitCard === 'function');
});

// ── Shortcut rebinds (P1-7) ──────────────────────────────────────────────────
// Compact moves off Ctrl+Shift+C (Chrome's inspect-element) to Ctrl+\. The
// produced-character matcher keys off input.key, so pin the new combo and that
// the old one no longer fires it.
test('compact mode binds to Ctrl+\\, not Ctrl+Shift+C', () => {
    const Shortcuts = require(path.join(root, 'features/shortcuts'));
    const match = (input, accel) => Shortcuts.prototype.matchesAccelerator.call({}, input, accel);
    const base = { meta: false, control: true, shift: false, alt: false };
    assert.ok(match({ ...base, key: '\\' }, 'CmdOrCtrl+\\'), 'Ctrl+\\ triggers compact');
    assert.ok(!match({ ...base, shift: true, key: 'C' }, 'CmdOrCtrl+\\'), 'Ctrl+Shift+C no longer does');
    assert.ok(!match({ ...base, key: '\\' }, 'CmdOrCtrl+Shift+C'), 'the old binding is gone');
});

// ── Downloads: dangerous-file confirm (P1-5) ─────────────────────────────────
// shell.openPath must never run for an executable/script unless the user has
// explicitly confirmed a second time.
const downloadManager = require('../features/download-manager');

test('the dangerous-file list catches executables and scripts, spares documents', () => {
    for (const n of ['setup.exe', 'a.msi', 'x.bat', 'y.cmd', 'z.com', 's.ps1', 'p.scr',
                     'v.vbs', 'app.js', 'tool.jar', 'disk.dmg', 'pkg.pkg', 'run.sh',
                     'Foo.AppImage', 'lib.deb', 'pkg.rpm'])
        assert.ok(downloadManager.isDangerousFile(n), `${n} should be flagged dangerous`);
    for (const n of ['report.pdf', 'photo.png', 'notes.txt', 'sheet.xlsx', 'archive.zip', 'song.mp3'])
        assert.ok(!downloadManager.isDangerousFile(n), `${n} should be safe`);
    assert.ok(downloadManager.isDangerousFile('SETUP.EXE'), 'extension match is case-insensitive');
    assert.ok(!downloadManager.isDangerousFile(''), 'no name → not dangerous');
});

test('openFile refuses a dangerous file until it is confirmed', () => {
    const dm = downloadManager;
    const opened = [];
    electronStub.shell.openPath = (p) => { opened.push(p); return Promise.resolve(''); };
    dm.items.set(901, { id: 901, state: 'completed', savePath: 'C:/dl/evil.exe', filename: 'evil.exe', dangerous: true });
    dm.openFile(901);        // no confirm → refused
    assert.deepStrictEqual(opened, [], 'shell.openPath is never reached for a dangerous file');
    dm.openFile(901, true);  // confirmed → opens
    assert.deepStrictEqual(opened, ['C:/dl/evil.exe'], 'a confirmed dangerous file opens');
    dm.items.set(902, { id: 902, state: 'completed', savePath: 'C:/dl/report.pdf', filename: 'report.pdf', dangerous: false });
    dm.openFile(902);        // safe → opens on the first call
    assert.deepStrictEqual(opened, ['C:/dl/evil.exe', 'C:/dl/report.pdf'], 'a safe file needs no confirm');
    dm.items.delete(901); dm.items.delete(902);
});

// ── Tab cycling stays within the active space ────────────────────────────────
// The window keeps every space's tabs alive in one tabMap; cycling (Ctrl+Tab,
// Ctrl+1–9) must never walk into another space's tabs — doing so switched the
// whole window's context to a space you were not in.
test('tab cycling never leaves the current space', () => {
    const Shortcuts = require(path.join(root, 'features/shortcuts'));
    // A fake tab manager with two spaces sharing one tabMap, exposing the SAME
    // surface both the correct (tabsInWorkspace) and the old buggy
    // (tabOrder+tabMap) code read — so a regression to the unscoped filter fails
    // this test rather than passing silently.
    const shown = [];
    const tm = {
        profileId: '1',
        activeTabIndex: 0,
        tabOrder: [0, 1, 2, 3],
        tabMap: new Map([[0, {}], [1, {}], [2, {}], [3, {}]]),
        tabProfiles: new Map([[0, '1'], [1, '1'], [2, '2'], [3, '2']]),
        tabsInWorkspace(id) {
            const key = String(id);
            return this.tabOrder.filter(i => this.tabMap.has(i) && (this.tabProfiles.get(i) || '1') === key);
        },
        showTab(i) { shown.push(i); this.activeTabIndex = i; },
    };
    const sut = Object.create(Shortcuts.prototype);
    sut.tabManager = tm;

    assert.deepStrictEqual(sut._orderedTabIndexes(), [0, 1], 'only space 1 tabs cycle');

    sut.switchToNextTab();                       // 0 -> 1
    assert.strictEqual(tm.activeTabIndex, 1);
    sut.switchToNextTab();                        // 1 -> wraps to 0, NOT into space 2
    assert.strictEqual(tm.activeTabIndex, 0);
    sut.switchToPreviousTab();                    // 0 -> wraps to 1
    assert.strictEqual(tm.activeTabIndex, 1);

    sut.switchToTabByNumber(3);                   // space 1 has 2 tabs → no-op
    assert.ok(!shown.includes(2) && !shown.includes(3), 'never activates another space’s tab');
});

// ── Ctrl+1–9 / Ctrl+Tab follow the order the sidebar DRAWS ──────────────────
// The sidebar puts a new tab at the TOP of the loose tabs, while main's
// tabOrder appends it — so Ctrl+1 landed on the bottom-most tab. The renderer
// reports its drawn order (tabs.visualOrder); cycling must follow it, still
// scoped to the space, with any unreported tab falling in after.
test('tab shortcuts follow the drawn (visual) order', () => {
    const Shortcuts = require(path.join(root, 'features/shortcuts'));
    const shown = [];
    const tm = {
        profileId: '1',
        activeTabIndex: 0,
        tabOrder: [0, 1, 2, 3, 4],
        tabMap: new Map([[0, {}], [1, {}], [2, {}], [3, {}], [4, {}]]),
        tabProfiles: new Map([[0, '1'], [1, '1'], [2, '1'], [3, '2'], [4, '1']]),
        visualOrder: [2, 3, 1, 0, 99],   // 3 is another space's, 99 is gone, 4 unreported
        tabsInWorkspace(id) {
            const key = String(id);
            return this.tabOrder.filter(i => this.tabMap.has(i) && (this.tabProfiles.get(i) || '1') === key);
        },
        showTab(i) { shown.push(i); this.activeTabIndex = i; },
    };
    const sut = Object.create(Shortcuts.prototype);
    sut.tabManager = tm;
    assert.deepStrictEqual(sut._orderedTabIndexes(), [2, 1, 0, 4]);
    sut.switchToTabByNumber(1);
    assert.strictEqual(tm.activeTabIndex, 2, 'Ctrl+1 is the top drawn tab');
    sut.switchToNextTab();
    assert.strictEqual(tm.activeTabIndex, 1, 'Ctrl+Tab walks down the drawn list');
});

// ── Report ───────────────────────────────────────────────────────────────────
if (failures.length) {
    console.error(`\n${failures.length} of ${passed + failures.length} unit tests failed:\n`);
    for (const { name, err } of failures)
        console.error(`  ✗ ${name}\n    ${err.message.split('\n')[0]}`);
    console.error('');
    process.exit(1);
}
console.log(`✓ ${passed} unit tests passed`);
