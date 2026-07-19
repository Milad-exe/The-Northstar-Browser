/**
 * Watch-mode development loop — `npm run dev`.
 *
 * There's no build step anymore (plain JS runs directly), so this just:
 *   - launches Electron with --dev (main.js's --dev block hot-reloads the
 *     chrome/renderer when files under renderer/ change)
 *   - restarts Electron when MAIN-process code changes (features/ ipc/ preload/
 *     main.js app-paths.js), since those can't hot-reload.
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const log = (msg) => console.log(`[dev] ${msg}`);

let electron = null;
let restarting = false;

function start() {
    electron = spawn('npx', ['electron', '.', '--dev'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
    electron.on('exit', (code) => {
        if (restarting) { restarting = false; start(); return; }
        log(`electron exited (${code})`);
        process.exit(code ?? 0);
    });
    log('electron started');
}

let timer = null;
function scheduleRestart(reason) {
    clearTimeout(timer);
    timer = setTimeout(() => { log(`restarting (${reason})`); restarting = true; try { electron.kill(); } catch {} }, 300);
}

// Main-process code only — renderer changes hot-reload via --dev.
for (const dir of ['features', 'ipc', 'preload']) {
    try { fs.watch(path.join(ROOT, dir), { recursive: true }, (_e, rel) => rel && scheduleRestart(`${dir}/${rel}`)); } catch {}
}
try { fs.watch(ROOT, (_e, rel) => { if (rel === 'main.js' || rel === 'app-paths.js') scheduleRestart(rel); }); } catch {}

process.on('SIGINT', () => { try { electron?.kill(); } catch {} process.exit(0); });
start();
