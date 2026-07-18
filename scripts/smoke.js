/**
 * Smoke test — `npm run smoke`.
 *
 * Boots the built app with a CDP port, then verifies over the DevTools
 * protocol that the browser actually came up healthy:
 *   1. the chrome window loads
 *   2. its init sequence completed (omnibox + tab strip present, no aborts)
 *   3. no uncaught errors were logged in any renderer
 *   4. a new-tab page exists
 *   5. the extensions system registered its toolbar element
 *
 * Requires Node >= 22 (uses the global WebSocket). Exit code 0 = healthy.
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9444;
const uncaught = [];

function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let body = '';
            res.on('data', (c) => body += c);
            res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
        }).on('error', reject);
    });
}

function evalIn(target, expression) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        const id = Math.floor(Math.random() * 1e6);
        const timer = setTimeout(() => { ws.close(); reject(new Error('eval timeout')); }, 10000);
        ws.onopen = () => ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
        ws.onmessage = (m) => {
            const msg = JSON.parse(m.data);
            if (msg.id === id) {
                clearTimeout(timer);
                ws.close();
                resolve(msg.result?.result?.value);
            }
        };
        ws.onerror = (e) => { clearTimeout(timer); reject(e); };
    });
}

async function main() {
    const app = spawn('npx', ['electron', '.', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*', '--enable-logging'],
        { cwd: ROOT, shell: process.platform === 'win32' });
    app.stderr.on('data', (d) => {
        const s = d.toString();
        if (/Uncaught/i.test(s)) uncaught.push(s.trim().split('\n')[0]);
    });

    const fail = (msg) => { console.error(`✗ ${msg}`); app.kill(); process.exit(1); };
    const pass = (msg) => console.log(`✓ ${msg}`);

    // Wait for the chrome window target
    let targets = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
        try {
            targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
            if (targets.some(t => t.url.includes('Browser/index.html'))) break;
        } catch {}
        await new Promise(r => setTimeout(r, 200));
    }
    const chrome = targets.find(t => t.url.includes('Browser/index.html'));
    if (!chrome) fail('chrome window never appeared');
    pass(`chrome window up in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    // Give the renderer a moment to finish init + restore tabs
    await new Promise(r => setTimeout(r, 4000));

    const ui = await evalIn(chrome, `({
        omnibox: !!document.getElementById('searchBar') || !!document.querySelector('.omnibox input'),
        tabstrip: !!document.getElementById('tabs-container'),
        tabs: document.querySelectorAll('.tab-button').length,
        extBtn: !!document.getElementById('extensions-btn'),
        actionList: !!document.querySelector('browser-action-list')?.shadowRoot,
    })`);
    if (!ui || !ui.omnibox || !ui.tabstrip) fail(`chrome UI incomplete: ${JSON.stringify(ui)}`);
    pass(`chrome UI intact (${ui.tabs} tab button(s))`);
    if (!ui.extBtn || !ui.actionList) fail('extensions toolbar element missing');
    pass('extensions toolbar registered');

    targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
    const pages = targets.filter(t => t.type === 'page');
    if (pages.length < 2) fail('no tab page loaded');
    pass(`${pages.length} page target(s) alive`);

    if (uncaught.length) fail(`uncaught renderer errors:\n  ${uncaught.slice(0, 5).join('\n  ')}`);
    pass('no uncaught renderer errors');

    console.log('\nSMOKE OK');
    app.kill();
    process.exit(0);
}

main().catch((e) => { console.error('smoke failed:', e); process.exit(1); });
