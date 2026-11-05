/**
 * Third-party notices — `node scripts/notices.js` (also run by scripts/dist.js).
 *
 * MIT, ISC, BSD, Apache and the rest are permissive on one condition: their
 * copyright and licence text travel with every copy, binaries included. A user
 * never sees node_modules inside app.asar, so this collects every PRODUCTION
 * dependency's licence (from package-lock.json, dev tools excluded) plus what
 * npm can't see — the fonts, the Phosphor icon paths and the engine — into one
 * THIRD_PARTY_NOTICES.txt that ships in the app and opens from Settings › About.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'THIRD_PARTY_NOTICES.txt');
const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i;
const RULE = '-'.repeat(78);

// Assets that aren't npm packages. Their licence texts live beside them.
const MANUAL = [
    {
        name: 'Onest and Geist Mono fonts',
        license: 'OFL-1.1',
        text: () => fs.readFileSync(path.join(ROOT, 'renderer/assets/fonts/OFL.txt'), 'utf8'),
    },
    {
        name: 'Phosphor Icons (icon paths in renderer/lib/menu-glyphs.js and renderer/assets)',
        license: 'MIT',
        text: () => mit('Copyright (c) 2023 Phosphor Icons'),
    },
    {
        name: 'Electron, Chromium and FFmpeg',
        license: 'MIT / BSD-3-Clause / LGPL-2.1 and others',
        text: () => 'Electron (castlabs ECS build) is MIT-licensed; its licence ships as\n' +
            'LICENSE.electron.txt beside Northstar.exe. Chromium and every library it\n' +
            'bundles — including FFmpeg (ffmpeg.dll, LGPL-2.1, dynamically linked and\n' +
            'replaceable) — are listed with their licences in LICENSES.chromium.html,\n' +
            'also beside Northstar.exe. FFmpeg source: https://ffmpeg.org/download.html\n' +
            'The Widevine CDM is proprietary Google software, downloaded at runtime and\n' +
            'not covered by any licence in this file.',
    },
];

function mit(copyright) {
    return `MIT License\n\n${copyright}\n\n` +
        'Permission is hereby granted, free of charge, to any person obtaining a copy\n' +
        'of this software and associated documentation files (the "Software"), to deal\n' +
        'in the Software without restriction, including without limitation the rights\n' +
        'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell\n' +
        'copies of the Software, and to permit persons to whom the Software is\n' +
        'furnished to do so, subject to the following conditions:\n\n' +
        'The above copyright notice and this permission notice shall be included in all\n' +
        'copies or substantial portions of the Software.\n\n' +
        'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\n' +
        'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\n' +
        'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\n' +
        'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\n' +
        'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\n' +
        'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\n' +
        'SOFTWARE.\n';
}

/** Production packages from the lockfile: path → { name, version }. */
function productionPackages() {
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
    const out = [];
    for (const [rel, meta] of Object.entries(lock.packages || {})) {
        if (!rel || meta.dev || meta.devOptional || meta.optional && meta.dev)
            continue;
        const dir = path.join(ROOT, rel);
        if (!fs.existsSync(path.join(dir, 'package.json')))
            continue; // not installed on this platform
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        out.push({ dir, name: pkg.name || rel.replace(/^.*node_modules\//, ''), version: pkg.version, pkg });
    }
    // One entry per name@version (hoisting can leave duplicates).
    const seen = new Set();
    return out.filter(p => { const k = `${p.name}@${p.version}`; if (seen.has(k)) return false; seen.add(k); return true; })
        .sort((a, b) => a.name.localeCompare(b.name));
}

function licenseOf(pkg) {
    if (typeof pkg.license === 'string') return pkg.license;
    if (pkg.license?.type) return pkg.license.type;
    if (Array.isArray(pkg.licenses)) return pkg.licenses.map(l => l.type || l).join(' OR ');
    return 'UNKNOWN';
}

function licenseText(p) {
    const files = fs.readdirSync(p.dir).filter(f => LICENSE_FILE.test(f)).sort();
    const texts = files.map(f => fs.readFileSync(path.join(p.dir, f), 'utf8').trim());
    if (texts.length)
        return texts.join(`\n\n`);
    // A package that ships no licence file still carries its terms: rebuild
    // the MIT text from its declared author — the condition is the same.
    if (/^MIT$/i.test(licenseOf(p.pkg))) {
        const author = typeof p.pkg.author === 'string' ? p.pkg.author : p.pkg.author?.name;
        return mit(`Copyright (c) ${author || `the ${p.name} authors`}`).trim();
    }
    return `Licensed under ${licenseOf(p.pkg)}. No licence file is included in the package.`;
}

function build() {
    const parts = [
        'THIRD-PARTY SOFTWARE NOTICES',
        '',
        'Northstar includes the third-party software listed below. Each component is',
        'distributed under its own licence, reproduced in full.',
        '',
    ];
    for (const m of MANUAL)
        parts.push(RULE, `${m.name}`, `Licence: ${m.license}`, '', m.text().trim(), '');
    for (const p of productionPackages())
        parts.push(RULE, `${p.name} ${p.version}`, `Licence: ${licenseOf(p.pkg)}`, '', licenseText(p), '');
    return parts.join('\n').replace(/\r\n/g, '\n');
}

function write() {
    fs.writeFileSync(OUT, build());
    return OUT;
}

module.exports = { write, build };

if (require.main === module)
    console.log(`wrote ${path.relative(ROOT, write())}`);
