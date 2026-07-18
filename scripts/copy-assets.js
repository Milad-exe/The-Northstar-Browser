/**
 * Copies everything the app needs at runtime that tsc doesn't emit:
 * HTML pages, CSS, fonts, images — from src/ into app/, preserving layout.
 * Also copies logo.png so paths like features/… → '../logo.png' resolve.
 *
 * Run via `npm run build:assets` (part of `npm run build`).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'app');

// Anything that isn't source code or docs gets copied verbatim.
const SKIP_EXT = new Set(['.ts', '.md']);

let copied = 0;
function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (SKIP_EXT.has(path.extname(entry.name))) continue;
        // ui.css is the Tailwind ENTRY — the built version is produced by
        // `npm run build:css`; copying the source would clobber it.
        if (full === path.join(SRC, 'renderer', 'styles', 'ui.css')) continue;
        const dest = path.join(OUT, path.relative(SRC, full));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(full, dest);
        copied++;
    }
}

walk(SRC);
fs.copyFileSync(path.join(ROOT, 'logo.png'), path.join(OUT, 'logo.png'));
fs.copyFileSync(path.join(ROOT, 'logo-win.png'), path.join(OUT, 'logo-win.png'));
console.log(`copy-assets: ${copied + 1} files → app/`);
