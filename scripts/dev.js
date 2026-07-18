/**
 * Watch-mode development loop — `npm run dev`.
 *
 * Runs everything needed for a tight edit-see cycle, no extra dependencies:
 *   - tsc --watch for both TS projects (main + renderer)
 *   - tailwindcss --watch for the shared stylesheet
 *   - an fs.watch that mirrors static assets (html/css/fonts) into app/
 *   - Electron, auto-restarted when compiled MAIN-process code changes
 *
 * Renderer-only changes (page scripts, CSS, HTML) do NOT restart the app —
 * press Cmd/Ctrl+R in the window to reload the chrome.
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const APP = path.join(ROOT, 'app');

const log = (tag, msg) => console.log(`[dev:${tag}] ${msg}`);

// ── 1. Full build first so the app is runnable immediately ───────────────────
log('build', 'initial build…');
execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });

// ── 2. Watchers ──────────────────────────────────────────────────────────────
const children = [];
function bg(name, cmd, args) {
    const p = spawn(cmd, args, { cwd: ROOT, stdio: 'ignore', shell: process.platform === 'win32' });
    p.on('exit', (code) => log(name, `exited (${code})`));
    children.push(p);
    log(name, 'watching');
    return p;
}

bg('tsc-main',     'npx', ['tsc', '-p', 'tsconfig.main.json', '--watch', '--preserveWatchOutput']);
bg('tsc-renderer', 'npx', ['tsc', '-p', 'tsconfig.renderer.json', '--watch', '--preserveWatchOutput']);
bg('tailwind',     'npx', ['tailwindcss', '-i', 'src/renderer/styles/ui.css', '-o', 'app/renderer/styles/ui.css', '--watch']);

// Static assets: mirror any non-ts/md change into app/ (same rules as copy-assets).
const UI_ENTRY = path.join(SRC, 'renderer', 'styles', 'ui.css');
fs.watch(SRC, { recursive: true }, (_event, rel) => {
    if (!rel) return;
    const full = path.join(SRC, rel);
    const ext = path.extname(rel);
    if (ext === '.ts' || ext === '.md' || full === UI_ENTRY) return;
    try {
        if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return;
        const dest = path.join(APP, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(full, dest);
        log('assets', `copied ${rel}`);
    } catch {}
});

// ── 3. Electron with auto-restart on main-process changes ────────────────────
let electron = null;
let restarting = false;

function startElectron() {
    electron = spawn('npx', ['electron', '.', '--dev'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
    electron.on('exit', (code) => {
        if (restarting) { restarting = false; startElectron(); return; }
        log('electron', `exited (${code}) — shutting down watchers`);
        shutdown(code ?? 0);
    });
    log('electron', 'started');
}

let restartTimer = null;
function scheduleRestart(reason) {
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
        log('electron', `restarting (${reason})`);
        restarting = true;
        try { electron.kill(); } catch {}
    }, 400); // debounce: tsc emits many files per compile
}

// Main-process output only — renderer changes just need a Cmd+R in the window.
for (const dir of ['features', 'ipc', 'preload']) {
    fs.watch(path.join(APP, dir), { recursive: true }, (_e, rel) => rel && scheduleRestart(`${dir}/${rel}`));
}
fs.watch(APP, (_e, rel) => { if (rel === 'main.js' || rel === 'app-paths.js') scheduleRestart(rel); });

function shutdown(code) {
    for (const p of children) { try { p.kill(); } catch {} }
    process.exit(code);
}
process.on('SIGINT', () => { try { electron?.kill(); } catch {} shutdown(0); });

startElectron();
