'use strict';
/**
 * Integration harness for ink's permission system.
 * Runs the REAL Features/permission-prompt.js attached to real Chromium
 * sessions; only the doorhanger UI (permission-ui) is stubbed with an
 * auto-responder so tests can script Allow/Block/remember decisions.
 *
 * Run: npm run test:permissions
 */
const path = require('path');
const http = require('http');

const INK = path.join(__dirname, '..');

// ── Stub the doorhanger UI before permission-prompt requires it ─────────────
const uiPath = require.resolve(path.join(INK, 'features/permission-ui.js'));
const promptLog = [];            // every prompt shown: {origin, action, checkbox}
let responderQueue = [];         // scripted answers, FIFO
const uiStub = {
    init() {}, register() {},
    request(_wc, data) {
        promptLog.push({ origin: data.origin, action: data.action, checkbox: data.checkbox });
        const ans = responderQueue.length ? responderQueue.shift() : { allowed: false, remember: false };
        return Promise.resolve(ans);
    },
};
require.cache[uiPath] = { id: uiPath, filename: uiPath, loaded: true, exports: uiStub };

const { app, session, BrowserWindow, systemPreferences } = require('electron');

// Isolated userData so we never touch the real profile.
const USERDATA = path.join(require('os').tmpdir(), 'ink-perm-test-' + Date.now());
app.setPath('userData', USERDATA);
// Fake camera/mic so getUserMedia works headless without TCC.
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
// Don't let macOS TCC prompts hang the run.
if (process.platform === 'darwin' && systemPreferences) {
    systemPreferences.getMediaAccessStatus = () => 'granted';
    systemPreferences.askForMediaAccess = async () => true;
}

const permissionPrompt = require(path.join(INK, 'features/permission-prompt.js'));
const sitePermissions  = require(path.join(INK, 'features/site-permissions.js'));

// ── Tiny test framework ──────────────────────────────────────────────────────
const results = [];
function check(name, cond, detail = '') {
    results.push({ name, pass: !!cond, detail });
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
function note(name, detail) { console.log(`INFO  ${name} — ${detail}`); }
const promptCount = () => promptLog.length;

// Run js in the page with a scripted responder; returns the page result.
async function inPage(win, js, answers = []) {
    responderQueue = answers.slice();
    return win.webContents.executeJavaScript(`(async () => { try { ${js} } catch (e) { return { err: (e && (e.name + ': ' + e.message)) || String(e) }; } })()`, true);
}

const GUM_VIDEO = `
    const s = await navigator.mediaDevices.getUserMedia({ video: true });
    const kinds = s.getTracks().map(t => t.kind); s.getTracks().forEach(t => t.stop());
    return { ok: true, kinds };`;
const GUM_BOTH = `
    const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    const kinds = s.getTracks().map(t => t.kind); s.getTracks().forEach(t => t.stop());
    return { ok: true, kinds };`;

async function loadPage(win, url) {
    await win.loadURL(url);
}

async function main() {
    await app.whenReady();
    if (app.dock) app.dock.hide();

    // Local server; localhost + 127.0.0.1 give two distinct secure origins.
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><title>perm test</title><h1>perm test</h1>');
    });
    await new Promise(res => server.listen(0, '127.0.0.1', res));
    const port = server.address().port;
    const ORIGIN = `http://localhost:${port}`;
    const URL1 = ORIGIN + '/page';

    // Attach the real handlers to the default session (as main.js does).
    permissionPrompt.attach(session.defaultSession);

    const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    await loadPage(win, URL1);

    // ── T1: default deny + prompt shown ─────────────────────────────────────
    let n = promptCount();
    let r = await inPage(win, GUM_VIDEO, [{ allowed: false, remember: false }]);
    check('T1 camera denied when user blocks', r.err && /NotAllowed/.test(r.err), JSON.stringify(r));
    check('T1 prompt was shown once', promptCount() === n + 1, `prompts=${promptCount() - n}`);
    check('T1 prompt has remember checkbox', promptLog[promptLog.length - 1].checkbox === true);

    // ── T2: temp deny cached (no re-prompt same page) ────────────────────────
    n = promptCount();
    r = await inPage(win, GUM_VIDEO, []);
    check('T2 temp deny reused w/o prompt', r.err && /NotAllowed/.test(r.err) && promptCount() === n, JSON.stringify(r));

    // ── T3: navigation clears temp; allow (no remember) works ───────────────
    await loadPage(win, URL1);
    n = promptCount();
    r = await inPage(win, GUM_VIDEO, [{ allowed: true, remember: false }]);
    check('T3 allow (no remember) grants', r.ok === true, JSON.stringify(r));
    check('T3 prompted after navigation', promptCount() === n + 1);
    check('T3 nothing persisted', sitePermissions.state(ORIGIN, 'camera') === 'ask', `state=${sitePermissions.state(ORIGIN, 'camera')}`);

    // ── T4: temp allow cached ────────────────────────────────────────────────
    n = promptCount();
    r = await inPage(win, GUM_VIDEO, []);
    check('T4 temp allow reused w/o prompt', r.ok === true && promptCount() === n, JSON.stringify(r));

    // ── T5: panel Block overrides temp allow (single permission) ────────────
    sitePermissions.set(ORIGIN, 'camera', 'block');
    n = promptCount();
    r = await inPage(win, GUM_VIDEO, []);
    check('T5 stored block beats temp allow', r.err && /NotAllowed/.test(r.err) && promptCount() === n, JSON.stringify(r));

    // ── T5b: panel reset to Ask must clear the old temp grant → re-prompt ───
    sitePermissions.set(ORIGIN, 'camera', 'ask');
    n = promptCount();
    r = await inPage(win, GUM_VIDEO, [{ allowed: false, remember: false }]);
    check('T5b reset-to-Ask re-prompts (temp cleared)', promptCount() === n + 1 && r.err && /NotAllowed/.test(r.err),
        `prompts=${promptCount() - n} result=${JSON.stringify(r)}`);

    // ── T6: combined cam+mic temp allow must NOT survive a camera block ─────
    await loadPage(win, URL1); // clear temp
    r = await inPage(win, GUM_BOTH, [{ allowed: true, remember: false }]);
    check('T6 combined allow works', r.ok === true && r.kinds.sort().join() === 'audio,video', JSON.stringify(r));
    sitePermissions.set(ORIGIN, 'camera', 'block');
    n = promptCount();
    r = await inPage(win, GUM_BOTH, []);
    check('T6 camera block kills combined request', r.err && /NotAllowed/.test(r.err), JSON.stringify(r) + ` prompts=${promptCount() - n}`);
    sitePermissions.set(ORIGIN, 'camera', 'ask');

    // ── T7: remember=true persists; no prompt on next visit ─────────────────
    await loadPage(win, URL1);
    r = await inPage(win, GUM_BOTH, [{ allowed: true, remember: true }]);
    check('T7 allow+remember grants', r.ok === true, JSON.stringify(r));
    check('T7 camera persisted', sitePermissions.state(ORIGIN, 'camera') === 'allow');
    check('T7 microphone persisted', sitePermissions.state(ORIGIN, 'microphone') === 'allow');
    await loadPage(win, URL1);
    n = promptCount();
    r = await inPage(win, GUM_BOTH, []);
    check('T7 persisted allow → no prompt next visit', r.ok === true && promptCount() === n, JSON.stringify(r));
    // persisted to disk?
    const fs = require('fs');
    check('T7 store file written to disk', fs.existsSync(path.join(USERDATA, 'site-permissions.dat')));
    // fresh reader sees it (simulated restart)
    delete require.cache[require.resolve(path.join(INK, 'features/site-permissions.js'))];
    const fresh = require(path.join(INK, 'features/site-permissions.js'));
    check('T7 fresh process reads persisted allow', fresh.state(ORIGIN, 'camera') === 'allow', `state=${fresh.state(ORIGIN, 'camera')}`);

    // ── T8: block-after-allow via panel (stored) ─────────────────────────────
    sitePermissions.set(ORIGIN, 'camera', 'block');
    sitePermissions.set(ORIGIN, 'microphone', 'block');
    n = promptCount();
    r = await inPage(win, GUM_BOTH, []);
    check('T8 stored block denies without prompt', r.err && /NotAllowed/.test(r.err) && promptCount() === n, JSON.stringify(r));
    r = await inPage(win, `return { state: (await navigator.permissions.query({ name: 'camera' })).state };`, []);
    check('T8 permissions.query reports denied', r.state === 'denied', JSON.stringify(r));
    sitePermissions.set(ORIGIN, 'camera', 'ask');
    sitePermissions.set(ORIGIN, 'microphone', 'ask');

    // ── T9: notifications must not be allow-by-default ──────────────────────
    await loadPage(win, URL1);
    r = await inPage(win, `return { perm: Notification.permission };`, []);
    note('T9 Notification.permission when undecided', r.perm);
    n = promptCount();
    r = await inPage(win, `
        const done = new Promise((res) => {
            try {
                const nt = new Notification('ink-perm-test');
                nt.onshow  = () => res({ shown: true });
                nt.onerror = () => res({ shown: false });
                setTimeout(() => res({ shown: 'timeout' }), 1500);
            } catch (e) { res({ shown: false, err: String(e) }); }
        });
        return await done;`, []);
    check('T9 new Notification() w/o grant must NOT show', r.shown !== true,
        `shown=${JSON.stringify(r)} promptsFired=${promptCount() - n}`);
    check('T9 display without grant asks the user', promptCount() === n + 1, `prompts=${promptCount() - n}`);

    // ── T10: Notification.requestPermission prompt flow ─────────────────────
    await loadPage(win, URL1); // clear T9's temp deny
    n = promptCount();
    r = await inPage(win, `return { res: await Notification.requestPermission() };`, [{ allowed: true, remember: true }]);
    check('T10 requestPermission fires doorhanger', promptCount() === n + 1, `prompts=${promptCount() - n}`);
    check('T10 grant returns granted', r.res === 'granted', JSON.stringify(r));
    check('T10 grant persisted', sitePermissions.state(ORIGIN, 'notifications') === 'allow');
    r = await inPage(win, `return { perm: Notification.permission };`, []);
    check('T10 permission now reads granted', r.perm === 'granted', JSON.stringify(r));
    // panel block afterwards must stick
    sitePermissions.set(ORIGIN, 'notifications', 'block');
    r = await inPage(win, `
        const done = new Promise((res) => {
            try {
                const nt = new Notification('ink-perm-test-2');
                nt.onshow  = () => res({ shown: true });
                nt.onerror = () => res({ shown: false });
                setTimeout(() => res({ shown: 'timeout' }), 1500);
            } catch (e) { res({ shown: false, err: String(e) }); }
        });
        return await done;`, []);
    check('T10 blocked-after-grant notification suppressed', r.shown !== true, JSON.stringify(r));
    sitePermissions.set(ORIGIN, 'notifications', 'ask');
    // requestPermission when undecided-but-check-says-denied must still prompt
    await loadPage(win, URL1);
    n = promptCount();
    r = await inPage(win, `return { res: await Notification.requestPermission() };`, [{ allowed: false, remember: false }]);
    note('T10b requestPermission (undecided) prompts?', `prompts=${promptCount() - n} res=${JSON.stringify(r)}`);

    // ── T11: geolocation ─────────────────────────────────────────────────────
    await loadPage(win, URL1);
    n = promptCount();
    r = await inPage(win, `
        return await new Promise((res) => {
            navigator.geolocation.getCurrentPosition(
                () => res({ ok: true }),
                (e) => res({ code: e.code, msg: e.message }),
                { timeout: 3000 });
            setTimeout(() => res({ code: 'timeout' }), 4000);
        });`, [{ allowed: false, remember: false }]);
    check('T11 geolocation deny → PERMISSION_DENIED', r.code === 1, JSON.stringify(r));
    check('T11 geolocation prompted', promptCount() === n + 1 && /location/.test(promptLog[promptLog.length - 1].action));

    // ── T12: private session — nothing persisted, stored decisions ignored ──
    const priv = session.fromPartition('perm-test-private', { cache: false });
    permissionPrompt.attach(priv, { persist: false });
    const pwin = new BrowserWindow({ show: false, webPreferences: { session: priv, contextIsolation: true } });
    await loadPage(pwin, URL1);
    n = promptCount();
    r = await inPage(pwin, GUM_VIDEO, [{ allowed: true, remember: true }]);
    check('T12 private allow works', r.ok === true, JSON.stringify(r));
    check('T12 private decision NOT persisted', sitePermissions.state(ORIGIN, 'camera') === 'ask', `state=${sitePermissions.state(ORIGIN, 'camera')}`);
    sitePermissions.set(ORIGIN, 'camera', 'allow'); // stored allow must be ignored by private
    await loadPage(pwin, URL1);
    n = promptCount();
    r = await inPage(pwin, GUM_VIDEO, [{ allowed: false, remember: false }]);
    check('T12 private ignores stored allow (still prompts)', promptCount() === n + 1 && r.err, `prompts=${promptCount() - n} r=${JSON.stringify(r)}`);
    sitePermissions.set(ORIGIN, 'camera', 'ask');

    // ── T13: screen share / display-capture ─────────────────────────────────
    const GDM = `
        try {
            const s = await navigator.mediaDevices.getDisplayMedia({ video: true });
            const kinds = s.getTracks().map(t => t.kind); s.getTracks().forEach(t => t.stop());
            return { ok: true, kinds };
        } catch (e) { return { err: e.name + ': ' + e.message }; }`;
    n = promptCount();
    r = await inPage(win, GDM, [{ allowed: true, remember: false }]);
    check('T13 screen share prompts', promptCount() === n + 1 && /share your screen/.test(promptLog[promptLog.length - 1].action),
        `prompts=${promptCount() - n}`);
    // Grant works when the OS allows capture; on a CI/mac without the
    // Screen-Recording TCC grant the attempt may fail — but never NotSupported.
    check('T13 screen share no longer NotSupported', !(r.err && /NotSupported/.test(r.err)), JSON.stringify(r));
    n = promptCount();
    r = await inPage(win, GDM, [{ allowed: false, remember: false }]);
    check('T13 screen share deny rejects cleanly', !!r.err && promptCount() === n + 1, JSON.stringify(r));

    // ── T15: dismissal (click-away/Esc) records nothing → site may re-ask ───
    await loadPage(win, URL1);
    n = promptCount();
    r = await inPage(win, GUM_VIDEO, [{ allowed: false, remember: false, dismissed: true }]);
    check('T15 dismiss denies the request', r.err && /NotAllowed/.test(r.err), JSON.stringify(r));
    r = await inPage(win, GUM_VIDEO, [{ allowed: true, remember: false }]);
    check('T15 site can re-ask after dismissal', r.ok === true && promptCount() === n + 2,
        `prompts=${promptCount() - n} r=${JSON.stringify(r)}`);

    // ── T16: private-tab panel overrides (session-scoped, never persisted) ──
    permissionPrompt.setOverride(priv, ORIGIN, 'camera', 'block');
    await loadPage(pwin, URL1);
    n = promptCount();
    r = await inPage(pwin, GUM_VIDEO, []);
    check('T16 private override block denies w/o prompt', r.err && /NotAllowed/.test(r.err) && promptCount() === n, JSON.stringify(r));
    r = await inPage(pwin, `return { state: (await navigator.permissions.query({ name: 'camera' })).state };`, []);
    check('T16 private query reports denied', r.state === 'denied', JSON.stringify(r));
    permissionPrompt.setOverride(priv, ORIGIN, 'camera', 'allow');
    n = promptCount();
    r = await inPage(pwin, GUM_VIDEO, []);
    check('T16 private override allow grants w/o prompt', r.ok === true && promptCount() === n, JSON.stringify(r));
    check('T16 overrides never persisted', sitePermissions.state(ORIGIN, 'camera') === 'ask', `state=${sitePermissions.state(ORIGIN, 'camera')}`);
    permissionPrompt.setOverride(priv, ORIGIN, 'camera', 'ask');
    n = promptCount();
    r = await inPage(pwin, GUM_VIDEO, [{ allowed: false, remember: false }]);
    check('T16 reset-to-Ask prompts again', promptCount() === n + 1 && r.err, `prompts=${promptCount() - n}`);

    // ── T17: hasTempAllow tracks live doorhanger grants ──────────────────────
    await loadPage(win, URL1);
    await inPage(win, GUM_VIDEO, [{ allowed: true, remember: false }]);
    check('T17 hasTempAllow sees live temp grant', permissionPrompt.hasTempAllow(ORIGIN, 'camera') === true);
    sitePermissions.set(ORIGIN, 'camera', 'block'); // panel change → temp cleared
    check('T17 store change clears temp grant', permissionPrompt.hasTempAllow(ORIGIN, 'camera') === false);
    sitePermissions.set(ORIGIN, 'camera', 'ask');

    // ── T14: tier-2b MIDI prompts every time; tier-3 denied outright ─────────
    n = promptCount();
    r = await inPage(win, `
        try { await navigator.requestMIDIAccess({ sysex: false }); return { ok: true }; }
        catch (e) { return { err: e.name + ': ' + e.message }; }`, [{ allowed: false, remember: false }]);
    check('T14 MIDI deny rejects', !!r.err, JSON.stringify(r) + ` prompts=${promptCount() - n}`);
    r = await inPage(win, `
        try { const st = await navigator.permissions.query({ name: 'idle-detection' }); return { state: st.state }; }
        catch (e) { return { err: e.name }; }`, []);
    note('T14 tier-3 idle-detection query', JSON.stringify(r));

    // ── Summary ──────────────────────────────────────────────────────────────
    const failed = results.filter(x => !x.pass);
    console.log(`\n${results.length - failed.length}/${results.length} passed, ${failed.length} failed`);
    server.close();
    try { require('fs').rmSync(USERDATA, { recursive: true, force: true }); } catch {}
    app.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('HARNESS ERROR', e); app.exit(2); });
setTimeout(() => { console.error('HARNESS TIMEOUT'); app.exit(3); }, 120000);
